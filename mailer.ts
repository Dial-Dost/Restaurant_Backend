/**
 * THE ONE PLACE THIS SYSTEM SENDS EMAIL.
 *
 * V3 asks for "Automated Email Reports". Everything needed to produce the report
 * already existed — migration 026's schedules, the occurrence sweep, the
 * at-most-once delivery ledger, the CSV renderer — and delivery landed in the
 * in-app bell for one reason: THERE WAS NO MAIL TRANSPORT ANYWHERE IN THE
 * CODEBASE. This is it, and migration 044 widens the channel CHECK at the same
 * time, keeping 026's rule that no state is storable before something implements
 * it.
 *
 * ============================================================================
 * THE BOUND IS THE WHOLE DESIGN, AND IT IS NOT A PRECAUTION
 * ============================================================================
 * This project has already shipped one unbounded network call and paid for it:
 * REDIS_URL pointing at nothing did not fail, because node-redis's default
 * reconnect strategy retries FOREVER — so `await connect()` never settled, the
 * catch written to degrade was unreachable, and CI hung for thirty-three
 * minutes. In production that would have been a backend that never finished
 * booting.
 *
 * SMTP is the same shape of hazard, worse placed. A wedged mail server, a
 * firewalled port 587, a provider silently blackholing the connection: any of
 * them makes send() hang. It hangs inside runReportScheduleSweep, holding a
 * claimed occurrence whose lease keeps other replicas off it, and the sweep
 * never reaches the rest of the tenants — so ONE misconfigured restaurant stops
 * every restaurant's reports.
 *
 * So every call here is bounded three ways and none of them is optional:
 *
 *   1. nodemailer's own connectionTimeout / greetingTimeout / socketTimeout, so
 *      a server that accepts the TCP connection and then says nothing still
 *      fails.
 *   2. A hard Promise.race around the whole send — because (1) bounds the
 *      SOCKET, and the failure this class of bug actually takes is in the layer
 *      ABOVE the socket (a retry loop, a DNS resolver, a pool). That is exactly
 *      the distinction the Redis fix turned on.
 *   3. pool: false. A pooled transport keeps sockets and timers alive between
 *      sends; there is nothing to gain here (a handful of messages a day) and a
 *      leaked handle keeps the process from exiting cleanly.
 *
 * ============================================================================
 * IT IS CONFIGURED BY THE OPERATOR, NOT BY THE TENANT
 * ============================================================================
 * One SMTP account belonging to whoever runs this platform, in the environment,
 * exactly like every other credential here. A per-tenant SMTP password would be
 * a plaintext third-party credential in the tenants table, which is a much
 * larger promise than "we email you your sales report". What IS per-tenant is
 * the recipient list, which is data, not a secret.
 *
 * WHEN IT IS NOT CONFIGURED, sendMail throws MailNotConfiguredError rather than
 * pretending. The sweep's retry ladder then records a real failure with a real
 * reason, and after five occurrences auto-disables the schedule — which is
 * visible in the UI and is the correct outcome. What must never happen is a
 * delivery marked 'delivered' for mail that was never sent; this project has
 * already shipped that bug once, for a print job that acked paper nobody
 * printed.
 *
 * NO RUNTIME IMPORTS FROM THE DATA LAYER, for the reason billing_math.ts and
 * role_scope.ts have none: it must be testable without a database, and the one
 * thing worth testing hardest — that a hung server fails in bounded time — needs
 * a test that can point it at a black hole.
 */

import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "./observability.js";

/** Raised when no SMTP transport is configured. Never a silent success. */
export class MailNotConfiguredError extends Error {
	readonly code = "MAIL_NOT_CONFIGURED";
	constructor(message = "No SMTP transport is configured on this deployment (set SMTP_URL or SMTP_HOST/SMTP_USER/SMTP_PASS).") {
		super(message);
		this.name = "MailNotConfiguredError";
	}
}

/** Raised when a send exceeded its bound. Retryable; see the header. */
export class MailTimeoutError extends Error {
	readonly code = "MAIL_TIMEOUT";
	constructor(ms: number) {
		super(`The mail server did not complete the send within ${ms}ms.`);
		this.name = "MailTimeoutError";
	}
}

export function isMailNotConfiguredError(e: unknown): e is MailNotConfiguredError {
	return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "MAIL_NOT_CONFIGURED";
}

export interface MailerConfig {
	host: string;
	port: number;
	secure: boolean;
	user?: string;
	pass?: string;
	/** The From header. Falls back to the SMTP user, which is what most providers require anyway. */
	from: string;
	/** The hard bound on one send, end to end. */
	timeoutMs: number;
}

/**
 * An integer from THE ENVIRONMENT THIS CALL WAS GIVEN, not from process.env.
 *
 * The obvious version reads `process.env[name]` and is wrong in a way that only
 * a test can see: readMailerConfig takes an `env` argument precisely so a caller
 * can ask "what would this deployment do", and a helper that ignores it silently
 * mixes the real environment into the answer. The first test written against it
 * passed SMTP_TIMEOUT_MS and got the 20-second default, which is how this was
 * found — and the same slip would have made SMTP_PORT unreadable in any context
 * where the environment is handed in rather than global.
 */
const envInt = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => {
	const n = Number(env[name]);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * smtp://user:pass@host:port or smtps://… broken into the fields the object
 * transport takes.
 *
 * Returns null rather than throwing on rubbish: a malformed SMTP_URL means this
 * deployment cannot send mail, which is exactly the state readMailerConfig
 * already has a representation for, and a boot that dies on a typo'd optional
 * env var is a worse outcome than one that reports the channel unavailable.
 */
function parseSmtpUrl(raw: string): { host: string; port: number; secure: boolean; user?: string; pass?: string } | null {
	let u: URL;
	try { u = new URL(raw); } catch { return null; }
	const protocol = u.protocol.replace(":", "").toLowerCase();
	if (protocol !== "smtp" && protocol !== "smtps") { return null; }
	const host = u.hostname;
	if (!host) { return null; }
	const secure = protocol === "smtps";
	const port = Number(u.port) || (secure ? 465 : 587);
	const user = u.username ? decodeURIComponent(u.username) : undefined;
	const pass = u.password ? decodeURIComponent(u.password) : undefined;
	return { host, port, secure, user, pass };
}

/**
 * Read the transport out of the environment, or null when none is configured.
 *
 * Exported so a route can answer "is email available on this deployment" without
 * attempting a send — the schedule form needs to say so BEFORE somebody saves a
 * daily schedule that will never deliver.
 */
export function readMailerConfig(env: NodeJS.ProcessEnv = process.env): MailerConfig | null {
	const url = String(env.SMTP_URL ?? "").trim();
	const host = String(env.SMTP_HOST ?? "").trim();
	const user = String(env.SMTP_USER ?? "").trim();
	const pass = String(env.SMTP_PASS ?? "").trim();
	const from = String(env.SMTP_FROM ?? "").trim() || user;
	// The bound defaults to 20s: long enough for a slow provider's TLS handshake
	// plus a multi-hundred-kilobyte attachment, short enough that a wedged server
	// costs one occurrence rather than the sweep.
	const timeoutMs = envInt(env, "SMTP_TIMEOUT_MS", 20_000);

	if (url) {
		// A URL IS PARSED INTO THE SAME FIELDS AS EVERYTHING ELSE rather than
		// handed to nodemailer whole. createTransport(urlString, defaults) treats
		// its second argument as message defaults, NOT transport options — so a
		// URL transport would silently receive none of the timeouts below, which
		// is the single thing this module exists to guarantee. One shape, one code
		// path, bounds that cannot be skipped.
		const parsed = parseSmtpUrl(url);
		if (!parsed) { return null; }
		const fromHeader = from || parsed.user || "";
		if (!fromHeader) { return null; }
		return { ...parsed, from: fromHeader, timeoutMs };
	}
	if (!host || !from) { return null; }
	const port = envInt(env, "SMTP_PORT", 587);
	// 465 is implicit TLS; 587 and 25 are STARTTLS, which nodemailer negotiates
	// on its own when `secure` is false. Deriving it from the port rather than
	// asking for another env var removes the single most common misconfiguration.
	const secure = String(env.SMTP_SECURE ?? "").trim().toLowerCase() === "true" || port === 465;
	return { host, port, secure, user: user || undefined, pass: pass || undefined, from, timeoutMs };
}

/** Is this deployment able to send mail at all? */
export function mailerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	return readMailerConfig(env) !== null;
}

/**
 * A syntactically plausible address.
 *
 * Deliberately permissive: the only thing worth rejecting at the form is a value
 * that CANNOT be an address, because whether a real mailbox exists behind it is
 * not knowable here and a bounce is the honest way to find out. Rejecting
 * anything more aggressive than this reliably refuses somebody's legitimate
 * address with a plus-tag or a long TLD.
 */
export function isPlausibleEmail(raw: unknown): boolean {
	const s = String(raw ?? "").trim();
	if (s.length === 0 || s.length > 254) { return false; }
	if (/\s/.test(s)) { return false; }
	const at = s.indexOf("@");
	if (at <= 0 || at !== s.lastIndexOf("@")) { return false; }
	const domain = s.slice(at + 1);
	if (domain.length < 3 || !domain.includes(".")) { return false; }
	if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) { return false; }
	return true;
}

/**
 * Clean a recipient list the way it will be stored: trimmed, de-duplicated
 * case-insensitively, implausible entries dropped, capped.
 *
 * The cap is not a performance limit. A report carrying a restaurant's takings
 * to forty addresses is a mistake somebody is about to make once, and ten is
 * more than any real owner/accountant list.
 */
export function normalizeRecipients(raw: unknown): string[] {
	const list = Array.isArray(raw)
		? raw
		: typeof raw === "string"
			? raw.split(/[,;\n]/)
			: [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of list) {
		const s = String(entry ?? "").trim();
		if (!isPlausibleEmail(s)) { continue; }
		const key = s.toLowerCase();
		if (seen.has(key)) { continue; }
		seen.add(key);
		out.push(s);
		if (out.length >= 10) { break; }
	}
	return out;
}

export interface MailAttachment {
	filename: string;
	content: string | Buffer;
	contentType?: string;
}

export interface MailMessage {
	to: readonly string[];
	subject: string;
	text: string;
	attachments?: readonly MailAttachment[];
}

/** Overridable for tests; see sendMail. */
export type TransportFactory = (config: MailerConfig) => Transporter;

const defaultFactory: TransportFactory = (config) => {
	// Every timeout is passed explicitly. nodemailer's own defaults are generous
	// enough (two minutes on the socket) that a wedged server would outlive the
	// sweep's lease, which is the failure this module exists to prevent.
	const bounds = {
		connectionTimeout: config.timeoutMs,
		greetingTimeout: config.timeoutMs,
		socketTimeout: config.timeoutMs,
		pool: false,
	};
	return nodemailer.createTransport({
		host: config.host,
		port: config.port,
		secure: config.secure,
		...(config.user ? { auth: { user: config.user, pass: config.pass ?? "" } } : {}),
		...bounds,
	});
};

export interface SendResult {
	/** The addresses the transport accepted. Stamped onto the delivery row. */
	accepted: string[];
	messageId: string | null;
}

/**
 * Send one message, or throw with a reason worth writing into a failure row.
 *
 * `factory` exists only so a test can hand in a transport that hangs — the one
 * behaviour that matters most here and that cannot be observed against a real
 * server. Production never passes it.
 */
export async function sendMail(
	message: MailMessage,
	opts?: { env?: NodeJS.ProcessEnv; factory?: TransportFactory },
): Promise<SendResult> {
	const config = readMailerConfig(opts?.env ?? process.env);
	if (!config) { throw new MailNotConfiguredError(); }

	const to = normalizeRecipients(message.to);
	if (to.length === 0) {
		// Not a transport problem, and it must not be retried for five days: a
		// schedule with no usable address is a configuration error the tenant
		// fixes, and migration 044's CHECK is what normally prevents it reaching
		// here at all.
		throw new Error("No valid recipient address for this delivery.");
	}

	const transport = (opts?.factory ?? defaultFactory)(config);
	let timer: NodeJS.Timeout | undefined;
	try {
		// THE HARD BOUND. See the header: the socket timeouts above cover the
		// socket, and the failure mode that actually bit this project lived a
		// layer above the socket, where no socket timeout can see it.
		const raced = await Promise.race([
			transport.sendMail({
				from: config.from,
				to: to.join(", "),
				subject: message.subject,
				text: message.text,
				attachments: message.attachments ? [...message.attachments] : undefined,
			}),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new MailTimeoutError(config.timeoutMs)), config.timeoutMs);
			}),
		]);
		const accepted = Array.isArray((raced as { accepted?: unknown }).accepted)
			? (raced as { accepted: unknown[] }).accepted.map((a) => String(a))
			: to;
		return { accepted, messageId: String((raced as { messageId?: unknown }).messageId ?? "") || null };
	} finally {
		if (timer) { clearTimeout(timer); }
		// Closed on EVERY path, including the timeout path — a transport abandoned
		// mid-send keeps its socket and its timers, and the process then will not
		// exit. `close` is synchronous and best-effort by design.
		try { transport.close?.(); } catch (err) { logger.debug({ err }, "smtp_close_failed"); }
	}
}
