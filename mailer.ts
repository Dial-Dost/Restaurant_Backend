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
 *
 * ============================================================================
 * FOUR TRANSPORTS, ONE SWITCH (MAIL_TRANSPORT)
 * ============================================================================
 *   smtp    the path above, unchanged, with the SMTP_* names it always read.
 *           The default whenever those settings are complete.
 *   resend  an HTTPS API (api.resend.com) for the box whose provider blocks
 *           outbound 25/465/587 — a common VPS default, and not something the
 *           code can fix. RESEND_API_KEY plus a From. Same bound, same
 *           never-a-fake-success rule, and an Idempotency-Key per message so a
 *           retried request cannot mail twice.
 *   log     development only: records WHAT would have gone (subject length,
 *           attachment names and sizes, an address tag) and contacts nobody.
 *           REFUSED when NODE_ENV=production — a production box that "sent" a
 *           report into its own log would mark a delivery delivered for mail
 *           nobody received, which is the one outcome this file exists to stop.
 *   off     explicitly nothing; also what an incomplete or unknown setting
 *           resolves to, with the reason kept for the operator.
 *
 * ONE MESSAGE PER RECIPIENT. A report goes to an owner and an outside
 * accountant who have no business seeing each other's addresses, and a
 * refusal of one address must not look like a failure of the others. So the
 * report path sends each address its own message (sendReportMessage) and gets
 * back ACCEPTED, REFUSED (permanent — an SMTP 5xx at RCPT or DATA, a provider
 * 4xx), or a thrown error (transient, or this server's own sign-in or sender —
 * retry later). sendMail keeps its original multi-address shape for the
 * callers and tests that already use it.
 */

import { createHash } from "node:crypto";
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

/**
 * The mail server refused THIS SERVER (its sign-in, its sender), not the
 * recipient. Retryable — the fix is a setting, and the next attempt after it
 * delivers — and never recorded against an address.
 */
export class MailOperatorError extends Error {
	readonly code = "MAIL_OPERATOR";
	constructor(sentence: string, cause: unknown) {
		const said = String((cause as { message?: unknown } | null)?.message ?? cause ?? "").trim();
		super(said ? `${sentence} The mail server said: ${said}` : sentence);
		this.name = "MailOperatorError";
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

export type MailTransportKind = "smtp" | "resend" | "log" | "off";

export interface ResendConfig {
	apiKey: string;
	from: string;
	timeoutMs: number;
	/** Overridable for a test double; production never sets it. */
	endpoint: string;
}

export interface MailTransport {
	kind: MailTransportKind;
	/** Why this is `off` (or why the requested one was refused). Never a secret. */
	reason: string | null;
	smtp: MailerConfig | null;
	resend: ResendConfig | null;
	/** The From address (no display name) — for the Message-ID domain. */
	fromAddress: string | null;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** The bare address inside `Name <addr>`, or the string itself. */
export function addressOf(from: string): string {
	const m = /<([^>]+)>/.exec(from);
	return (m ? m[1] : from).trim();
}

/**
 * Which transport this deployment uses, decided from the environment.
 *
 * Unset MAIL_TRANSPORT keeps the behaviour every deployment already has: SMTP
 * when its settings are complete, nothing otherwise. An explicit choice that
 * cannot work (resend with no key, an unknown word, log in production) is OFF
 * with the reason stated — never a silent fallback to a different transport.
 */
export function readMailTransport(env: NodeJS.ProcessEnv = process.env): MailTransport {
	const requested = String(env.MAIL_TRANSPORT ?? "").trim().toLowerCase();
	const smtp = readMailerConfig(env);
	const off = (reason: string): MailTransport => ({ kind: "off", reason, smtp: null, resend: null, fromAddress: null });
	// MAIL_FROM is the one From for every transport when set; SMTP_FROM (then
	// SMTP_USER) is what an SMTP-only deployment has always used.
	const fromOverride = String(env.MAIL_FROM ?? "").trim();

	if (requested === "" || requested === "smtp") {
		if (!smtp) {
			return off(requested === "smtp"
				? "MAIL_TRANSPORT=smtp but the SMTP settings are incomplete (SMTP_URL, or SMTP_HOST with SMTP_FROM or SMTP_USER)."
				: "No mail transport is configured (set the SMTP settings, or MAIL_TRANSPORT=resend with RESEND_API_KEY).");
		}
		const from = fromOverride || smtp.from;
		return { kind: "smtp", reason: null, smtp: { ...smtp, from }, resend: null, fromAddress: addressOf(from) };
	}
	if (requested === "resend") {
		const apiKey = String(env.RESEND_API_KEY ?? "").trim();
		const from = fromOverride || String(env.SMTP_FROM ?? "").trim();
		if (!apiKey) {return off("MAIL_TRANSPORT=resend but RESEND_API_KEY is not set.");}
		if (!from || !addressOf(from).includes("@")) {return off("MAIL_TRANSPORT=resend but no From address is set (MAIL_FROM).");}
		return {
			kind: "resend",
			reason: null,
			smtp: null,
			resend: {
				apiKey,
				from,
				timeoutMs: envInt(env, "SMTP_TIMEOUT_MS", 20_000),
				endpoint: String(env.RESEND_API_URL ?? "").trim() || RESEND_ENDPOINT,
			},
			fromAddress: addressOf(from),
		};
	}
	if (requested === "log") {
		if (String(env.NODE_ENV ?? "").trim().toLowerCase() === "production") {
			return off("MAIL_TRANSPORT=log is refused in production: it would record reports as sent that nobody received.");
		}
		const from = fromOverride || smtp?.from || "reports@localhost.invalid";
		return { kind: "log", reason: null, smtp: null, resend: null, fromAddress: addressOf(from) };
	}
	if (requested === "off") {return off("MAIL_TRANSPORT=off.");}
	return off(`MAIL_TRANSPORT=${requested} is not a transport this server knows (smtp, resend, log or off).`);
}

/** Is this deployment able to send mail at all? */
export function mailerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	return readMailTransport(env).kind !== "off";
}

/**
 * What GET /reports/email/config may say about the transport: its NAME and
 * whether it works. Never the host, the user, the key or the From — those are
 * operator credentials and that endpoint is readable by the reports permission.
 * `reason` is the operator-facing sentence above, which names settings, never
 * their values.
 */
export function mailTransportStatus(env: NodeJS.ProcessEnv = process.env): { transport: MailTransportKind; available: boolean; reason: string | null } {
	const t = readMailTransport(env);
	return { transport: t.kind, available: t.kind !== "off", reason: t.reason };
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
	/** Optional HTML alternative; the text part is always sent too. */
	html?: string;
	attachments?: readonly MailAttachment[];
	/** A stable Message-ID, so a retried send is recognisably the same message. */
	messageId?: string;
	/** Sent as the HTTPS API's Idempotency-Key. SMTP has no such thing. */
	idempotencyKey?: string;
	/** A display name for the From header; the address stays the operator's. */
	fromName?: string;
	replyTo?: string;
}

/** Overridable for tests; see sendMail. */
export type TransportFactory = (config: MailerConfig) => Transporter;

/** A fetch the HTTPS transport can be handed in a test. */
export type FetchLike = (
	url: string,
	init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; ok: boolean; json: () => Promise<unknown>; text: () => Promise<string> }>;

export interface SendOptions {
	env?: NodeJS.ProcessEnv;
	factory?: TransportFactory;
	fetchImpl?: FetchLike;
}

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
	opts?: SendOptions,
): Promise<SendResult> {
	const transport = readMailTransport(opts?.env ?? process.env);
	if (transport.kind === "off") { throw new MailNotConfiguredError(transport.reason ?? undefined); }
	if (transport.kind !== "smtp") {
		// The HTTPS and log transports take one address per request, so a
		// multi-address message goes as one message each, and only the accepted
		// addresses come back — the contract the SMTP branch below keeps.
		const listed = normalizeRecipients(message.to);
		if (listed.length === 0) { throw new Error("No valid recipient address for this delivery."); }
		const accepted: string[] = [];
		let firstId: string | null = null;
		for (const addr of listed) {
			const one = await sendReportMessage({ ...message, to: [addr] }, opts);
			if (one.status === "accepted") { accepted.push(addr); firstId = firstId ?? one.messageId; }
		}
		return { accepted, messageId: firstId };
	}
	const config = transport.smtp as MailerConfig;

	const to = normalizeRecipients(message.to);
	if (to.length === 0) {
		// Not a transport problem, and it must not be retried for five days: a
		// schedule with no usable address is a configuration error the tenant
		// fixes, and migration 044's CHECK is what normally prevents it reaching
		// here at all.
		throw new Error("No valid recipient address for this delivery.");
	}

	const smtpTransport = (opts?.factory ?? defaultFactory)(config);
	let timer: NodeJS.Timeout | undefined;
	try {
		// THE HARD BOUND. See the header: the socket timeouts above cover the
		// socket, and the failure mode that actually bit this project lived a
		// layer above the socket, where no socket timeout can see it.
		const raced = await Promise.race([
			smtpTransport.sendMail({
				from: withDisplayName(config.from, message.fromName),
				to: to.join(", "),
				subject: message.subject,
				text: message.text,
				...(message.html ? { html: message.html } : {}),
				...(message.messageId ? { messageId: message.messageId } : {}),
				...(message.replyTo ? { replyTo: message.replyTo } : {}),
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
		try { smtpTransport.close?.(); } catch (err) { logger.debug({ err }, "smtp_close_failed"); }
	}
}

// ============================================================================
// THE REPORT PATH — one address, one message, one outcome
// ============================================================================

export interface OneSendResult {
	/** `refused` is permanent for this address; anything transient THROWS instead. */
	status: "accepted" | "refused";
	messageId: string | null;
	provider: MailTransportKind;
	/** Why it was refused (or, rarely, a note on an acceptance), with every address scrubbed out. */
	detail: string | null;
}

/** A display name made safe for a From header: no quotes, brackets, control characters or line breaks. */
export function safeDisplayName(raw: unknown, max = 80): string {
	let out = "";
	for (const ch of String(raw ?? "")) {
		const code = ch.codePointAt(0) ?? 0;
		out += code < 32 || code === 127 || ch === "\"" || ch === "<" || ch === ">" || ch === "\\" ? " " : ch;
	}
	return out.replace(/\s+/g, " ").trim().slice(0, max);
}

/** `"Name" <addr>` over whatever From the operator configured. */
export function withDisplayName(from: string, name?: string): string {
	const clean = safeDisplayName(name ?? "");
	if (!clean) { return from; }
	return `"${clean}" <${addressOf(from)}>`;
}

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * An error or provider message with every address taken out.
 *
 * A mail server's refusal nearly always quotes the address it refused, and the
 * logs and the bell are read by people who have no business seeing a list of
 * the restaurant's outside contacts. The delivery row keeps its own per-address
 * record behind the reports permission; nothing else needs the address.
 */
export function scrubAddresses(text: unknown): string {
	return String(text ?? "").replace(EMAIL_IN_TEXT, "<address>").slice(0, 600);
}

/** A short, stable tag for an address — what the logs carry instead of it. */
export function addressTag(email: string): string {
	return createHash("sha256").update(String(email).trim().toLowerCase()).digest("hex").slice(0, 10);
}

/**
 * The Message-ID a report message carries: the same on every retry of the same
 * delivery to the same address, so a resend after a crash is recognisably the
 * same message (mail systems de-duplicate on it) rather than a second report.
 * Keyed on the ADDRESS, not its position, so an edited list cannot reuse an id.
 */
export function stableMessageId(deliveryId: string, email: string, fromAddress: string | null): string {
	const domain = String(fromAddress ?? "").split("@")[1]?.trim().replace(/[^A-Za-z0-9.-]/g, "") || "reports.invalid";
	const safeId = String(deliveryId).replace(/[^A-Za-z0-9-]/g, "").slice(0, 64) || "delivery";
	return `<rd-${safeId}-${addressTag(email)}@${domain}>`;
}

interface SmtpFailure {
	code?: unknown;
	responseCode?: unknown;
	command?: unknown;
	response?: unknown;
	message?: unknown;
	rejected?: unknown;
}

/** Where in the session nodemailer says it failed: `err.command`. */
function smtpStage(e: SmtpFailure | null): "rcpt" | "data" | "sender" | "other" {
	const cmd = String(e?.command ?? "").trim().toUpperCase();
	if (cmd.startsWith("RCPT")) { return "rcpt"; }
	if (cmd === "DATA") { return "data"; }
	if (cmd.startsWith("MAIL")) { return "sender"; }
	return "other";
}

type OperatorSide = "sign-in" | "sender" | "relay";

/**
 * Which of THIS SERVER's settings a reply is about, whatever stage it came at —
 * or null when it names nothing of ours. Some providers only check the sign-in
 * or the From once a recipient (RCPT) or the message (DATA) arrives, so the
 * stage alone cannot say:
 *   sign-in  EAUTH; 530 (authentication or STARTTLS required); RFC 3463's
 *            5.7.8 / 5.7.9 / 5.7.11 / 5.7.14; "authentication required";
 *   sender   5.1.7 / 5.1.8 (bad sender address); an unverified sender (or, in
 *            a provider's sandbox, an unverified recipient — still a setting);
 *   relay    the server will not pass our mail on, which is what an
 *            unauthenticated or wrongly-authorised client is told.
 */
function operatorSide(e: SmtpFailure | null): OperatorSide | null {
	if (e?.code === "EAUTH") { return "sign-in"; }
	const text = `${String(e?.response ?? "")} ${String(e?.message ?? "")}`;
	if (Number(e?.responseCode) === 530 || /\b5\.7\.(?:8|9|11|14)\b/.test(text) || /\bauthentication (?:is )?required\b/i.test(text)) {
		return "sign-in";
	}
	if (/\b5\.1\.[78]\b/.test(text) || /\b(?:not verified|unverified)\b/i.test(text)) { return "sender"; }
	if (/\b(?:unable to relay|relay(?:ing)? (?:access )?(?:is )?(?:denied|not (?:permitted|allowed))|not (?:permitted|allowed) to relay)\b/i.test(text)) {
		return "relay";
	}
	return null;
}

/**
 * Is this SMTP failure the RECIPIENT's refusal — permanent, and about this one
 * address?
 *
 * ONLY a 5xx at the recipient or message stage (RCPT TO, DATA) that names
 * nothing of ours counts. Everything else is the OPERATOR's: 535 bad
 * credentials (EAUTH), 530 authentication or STARTTLS required, a 55x on MAIL
 * FROM for a sender the provider has not verified, "relaying denied", a 554
 * greeting for a blocked IP. Recording those against the address marked the
 * owner's own inbox "Refused" during the runbook's test email, failed the
 * delivery for good on its first try, and pushed the schedule toward
 * auto-disable — for a password somebody can fix in a minute. They THROW
 * instead, so the retry after the fix delivers. A 4xx at any stage (a
 * greylisted RCPT included, which nodemailer also reports with a `rejected`
 * list) is transient by definition.
 */
export function smtpRecipientRefusal(err: unknown, addr: string): boolean {
	const e = err as SmtpFailure | null;
	const stage = smtpStage(e);
	if (stage !== "rcpt" && stage !== "data") { return false; }
	if (operatorSide(e) !== null) { return false; }
	const code = Number(e?.responseCode);
	if (Number.isFinite(code) && code > 0) { return code >= 500 && code < 600; }
	// No reply code at all: only nodemailer's own "all recipients were
	// rejected", when it names this address, is a refusal.
	return stage === "rcpt" && Array.isArray(e?.rejected)
		&& e.rejected.some((a) => String(a).trim().toLowerCase() === addr.trim().toLowerCase());
}

/**
 * The owner-readable sentence for a failure that is the OPERATOR's to fix — this
 * server's sign-in, its sender, its relay permission, or its connection — or
 * null for anything else (a transient failure keeps its own words). The
 * delivery row keeps it (behind the reports permission), so the history says
 * what to fix instead of a bare "535 5.7.8".
 */
export function operatorMailProblem(err: unknown): string | null {
	const e = err as SmtpFailure | null;
	const side = operatorSide(e);
	const code = Number(e?.responseCode);
	const permanent = Number.isFinite(code) && code >= 500 && code < 600;
	// A sign-in failure is the operator's at any code: nodemailer raises EAUTH
	// for missing credentials with no reply at all.
	if (side === "sign-in" && (permanent || e?.code === "EAUTH")) {
		return "The mail server did not accept this server's sign-in. Ask your administrator to check the mail settings.";
	}
	if (!permanent) { return null; }
	const stage = smtpStage(e);
	if (side === "sender" || (side === null && stage === "sender")) {
		return "The mail server refused this server's sender address. Ask your administrator to check the From address and the sending domain.";
	}
	if (side === "relay") {
		return "The mail server would not pass this server's mail on (relaying denied). Ask your administrator to check the mail settings.";
	}
	if (stage === "other") {
		return "The mail server refused this server's connection. Ask your administrator to check the mail settings.";
	}
	return null;
}

/**
 * Send ONE message to ONE address.
 *
 * Resolves `accepted` or `refused`; THROWS for anything that may succeed on a
 * later attempt (a timeout, a 4xx greylist, a 429, a 5xx from an HTTPS API, a
 * network error) and for an unconfigured deployment. The caller records the two
 * outcomes per address and retries only what threw.
 */
export async function sendReportMessage(message: MailMessage, opts?: SendOptions): Promise<OneSendResult> {
	const env = opts?.env ?? process.env;
	const transport = readMailTransport(env);
	if (transport.kind === "off") { throw new MailNotConfiguredError(transport.reason ?? undefined); }
	const to = normalizeRecipients(message.to);
	if (to.length !== 1) { throw new Error("A report message goes to exactly one address."); }
	const addr = to[0];

	if (transport.kind === "log") {
		// Metadata only — never the body, never the address.
		logger.info({
			transport: "log",
			addr: addressTag(addr),
			subjectChars: message.subject.length,
			attachments: (message.attachments ?? []).map((a) => ({ filename: a.filename, bytes: Buffer.byteLength(a.content) })),
			messageId: message.messageId ?? null,
		}, "mail_logged_not_sent");
		return { status: "accepted", messageId: message.messageId ?? null, provider: "log", detail: null };
	}

	if (transport.kind === "resend") {
		return sendViaResend(transport.resend as ResendConfig, addr, message, opts?.fetchImpl);
	}

	try {
		const r = await sendMail({ ...message, to: [addr] }, { env, factory: opts?.factory });
		if (r.accepted.some((a) => a.toLowerCase() === addr.toLowerCase())) {
			return { status: "accepted", messageId: message.messageId ?? r.messageId ?? null, provider: "smtp", detail: null };
		}
		return { status: "refused", messageId: null, provider: "smtp", detail: "The mail server did not accept this address." };
	} catch (err) {
		if (smtpRecipientRefusal(err, addr)) {
			return { status: "refused", messageId: null, provider: "smtp", detail: scrubAddresses((err as Error | null)?.message ?? err) };
		}
		// Transient, or the operator's: THROWN either way, so the address keeps
		// its place for the retry. The operator's gets a sentence first.
		const problem = operatorMailProblem(err);
		if (problem) { throw new MailOperatorError(problem, err); }
		throw err;
	}
}

async function sendViaResend(cfg: ResendConfig, addr: string, message: MailMessage, fetchImpl?: FetchLike): Promise<OneSendResult> {
	const doFetch: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);
	const controller = new AbortController();
	let timer: NodeJS.Timeout | undefined;
	const body = {
		from: withDisplayName(cfg.from, message.fromName),
		to: [addr],
		subject: message.subject,
		text: message.text,
		...(message.html ? { html: message.html } : {}),
		...(message.replyTo ? { reply_to: message.replyTo } : {}),
		...(message.messageId ? { headers: { "Message-ID": message.messageId } } : {}),
		attachments: (message.attachments ?? []).map((a) => ({
			filename: a.filename,
			content: (typeof a.content === "string" ? Buffer.from(a.content, "utf8") : a.content).toString("base64"),
			...(a.contentType ? { content_type: a.contentType } : {}),
		})),
	};
	try {
		// THE SAME HARD BOUND as SMTP: the abort covers the socket, the race covers
		// everything above it (DNS, a proxy, a body that never finishes).
		const res = await Promise.race([
			doFetch(cfg.endpoint, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${cfg.apiKey}`,
					"Content-Type": "application/json",
					...(message.idempotencyKey ? { "Idempotency-Key": message.idempotencyKey.slice(0, 256) } : {}),
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			}),
			new Promise<never>((_resolve, reject) => {
				// Reject FIRST: aborting settles the fetch synchronously, and the race
				// must be won by the named timeout, not by the abort it causes.
				timer = setTimeout(() => { reject(new MailTimeoutError(cfg.timeoutMs)); controller.abort(); }, cfg.timeoutMs);
			}),
		]);
		if (res.ok) {
			const j = (await res.json().catch(() => null)) as { id?: unknown } | null;
			return { status: "accepted", messageId: message.messageId ?? (typeof j?.id === "string" ? j.id : null), provider: "resend", detail: null };
		}
		const raw = await res.text().catch(() => "");
		const detail = scrubAddresses(raw);
		// 409 IS THE IDEMPOTENCY KEY ANSWERING, never a refusal. The key is
		// `rd-<delivery>-<address>`, used for this one message and nothing else,
		// and a retry sends the same bytes under it (report_schedules.ts keeps
		// the body's inputs with the files):
		//   * concurrent_idempotent_requests — the first request with this key is
		//     still being processed: transient, try again later;
		//   * invalid_idempotent_request — a request with this key already
		//     reached the service with a body that differs (an operator changed
		//     the From name between attempts). That earlier request is the
		//     message. Recording the address as refused — as this once did after
		//     a timed-out upload the service had in fact accepted — failed a
		//     delivery whose email had arrived.
		if (res.status === 409) {
			if (/concurrent_idempotent_requests/i.test(raw)) {
				throw new Error(`The email service is still processing this message: ${detail || "409"}`);
			}
			logger.warn({ addr: addressTag(addr), detail }, "mail_resend_idempotent_replay");
			return { status: "accepted", messageId: message.messageId ?? null, provider: "resend", detail: "Already accepted under this message's idempotency key." };
		}
		// 429 and 5xx pass on their own; 401/403 is the OPERATOR's key and must not
		// be recorded as the recipient's fault. Every other 4xx is about this
		// message or this address, and retrying it is five identical refusals.
		if (res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403) {
			throw new Error(`The email service answered ${String(res.status)}: ${detail || "no detail"}`);
		}
		return { status: "refused", messageId: null, provider: "resend", detail: `The email service refused this message (${String(res.status)}). ${detail}`.trim() };
	} finally {
		if (timer) { clearTimeout(timer); }
	}
}
