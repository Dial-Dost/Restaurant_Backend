/**
 * REPORT EMAIL (client item 9) — the address book, Send now, the test email,
 * and the delivery log's detail and files.
 *
 * "In the reports section, all reports or any reports can be emailed to chosen
 * email IDs, automated so emails are sent at the end of each day at a specific
 * time to the chosen email IDs, with an option to choose/add both the email IDs
 * and the send time." The schedules themselves stay where migration 026 put
 * them (/reports/schedules, routes/accounting.ts); this file is everything
 * around them.
 *
 * MOUNTED UNDER /reports/ for the reason every sibling is: FEATURE_BY_PREFIX
 * maps that prefix to the "accounting" plan feature, so a plan without it gets a
 * 403 with no new gating code.
 *
 * WHO MAY DO WHAT
 *   ACCOUNTING_PERM  read the config, the book and the log; Send now to
 *                    addresses in the book. Waiters do not hold it.
 *   PERM_SETTINGS    add or remove an address, send a test email. The owner
 *                    (superadmin) is an admin and always holds it.
 *   admin / manager  the all-outlets scope.
 *
 * NOTHING HERE WAITS ON A MAIL SERVER. The request inserts a delivery row and
 * kicks the worker OUTSIDE its own tenant context (kickReportDelivery); the
 * client polls GET /reports/deliveries/:id. A request connection held across an
 * SMTP round trip is a standstill waiting to happen.
 *
 * NO ROUTE RETURNS A MAIL CREDENTIAL. The config says which transport and
 * whether it works; never the host, the user, the key or the From.
 *
 * Every path is a literal or sits under /reports/email/ or /reports/deliveries/
 * with no `:param` sibling that could shadow it; the route manifest proves the
 * order.
 */
import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import {
	AddReportEmailRecipient,
	Audit_log_category,
	CountRecentAdhocSends,
	CountRecentReportEmails,
	FindAdhocDelivery,
	GetReportDelivery,
	GetReportDeliveryFile,
	GetReportEmailRecipientsByIds,
	GetReportSweepStatus,
	InsertAdhocReportDelivery,
	ListReportEmailRecipients,
	RemoveReportEmailRecipient,
	ResolveReportEmailWindow,
	isReportEmailRequestError,
	isReportEmailSchemaPending,
	reportEmailSchemaReady,
} from "../database_supabase.js";
import { logger } from "../observability.js";
import { mailTransportStatus } from "../mailer.js";
import {
	MAX_ADDRESS_BOOK,
	MAX_EMAIL_SCHEDULES_PER_OUTLET,
	MAX_REPORT_RECIPIENTS,
	MAX_SEND_WINDOW_DAYS,
	REPORT_CATALOGUE,
	REPORT_EMAIL_FORMATS,
	reportListPhrase,
	validateReportFormats,
	validateReportSelection,
} from "../report_catalogue.js";
import { REPORT_EMAILED_ACTION_ID, REPORT_EMAIL_RECIPIENTS_ACTION_ID } from "../report_email_schema.js";
import { PLATFORM_DAILY_CAP, TENANT_DAILY_CAP, kickReportDelivery, reportSweepState, reportWorkerId, schedulerPermitted } from "../report_schedules.js";
import { parseDayClose } from "../report_window.js";
import {
	ACCOUNTING_PERM,
	PERM_SETTINGS,
	callerHasPermission,
	callerMayUseAllOutlets,
	extractEmployeeId,
	extractRestaurantId,
	log_audit,
	tenantRateLimited,
	validateAction,
} from "./_shared.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Send now: per employee per minute, per restaurant per hour. */
export const SEND_NOW_PER_MINUTE = 3;
export const SEND_NOW_PER_HOUR = 10;
/** Test emails per restaurant per hour. */
export const TEST_EMAILS_PER_HOUR = 3;
/** Address-book writes per restaurant per day. */
export const BOOK_WRITES_PER_DAY = 20;

/** The sentence every client shows when there is no transport. The same words on web and app. */
export const MAIL_OFF_SENTENCE = "Email is not set up on this server";

/** One refusal shape for every route here: `error` a sentence, `code` for the client to branch on. */
function refuse(res: Response, status: number, code: string, error: string): void {
	res.status(status).json({ error, code });
}

/** The answers every write shares before it may do anything. */
async function refuseUnlessReady(res: Response, opts: { needMail: boolean }): Promise<boolean> {
	if (!(await reportEmailSchemaReady())) {
		refuse(res, 503, "schema_pending", "Email reports need a database update (migrations 056-058) that has not been applied to this server yet. Ask your administrator to apply it.");
		return false;
	}
	if (opts.needMail && !mailTransportStatus().available) {
		refuse(res, 503, "mail_not_configured", `${MAIL_OFF_SENTENCE}. Ask your administrator to set up the mail settings.`);
		return false;
	}
	return true;
}

function mapError(res: Response, e: unknown, fallback: string, label: string): void {
	if (isReportEmailSchemaPending(e)) { refuse(res, 503, "schema_pending", e.message); return; }
	if (isReportEmailRequestError(e)) { refuse(res, e.status, e.reason, e.message); return; }
	logger.error({ err: e }, label);
	res.status(500).json({ error: fallback });
}

export function registerReportEmailRoutes(app: Express): void {

// What this server can do, for the Email reports area of both clients. Readable
// by the reports permission, so it says NAMES and yes/no, never a credential.
// `reason` (which names settings, never their values) goes only to someone who
// can act on the book — the operator's words are not a waiter's business, and
// the waiter cannot reach this route anyway.
app.get("/reports/email/config", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const mail = mailTransportStatus();
		const ready = await reportEmailSchemaReady();
		const permitted = schedulerPermitted();
		const state = reportSweepState();
		const lease = ready ? await GetReportSweepStatus(reportWorkerId()).catch(() => null) : null;
		const canEdit = callerHasPermission(req, PERM_SETTINGS);
		res.json({
			email_available: mail.available,
			transport: mail.transport,
			message: mail.available ? null : MAIL_OFF_SENTENCE,
			reason: canEdit ? mail.reason : null,
			schema_ready: ready,
			send_now_enabled: process.env.REPORT_SEND_NOW !== "false",
			scheduler: {
				enabled: permitted.ok,
				armed_here: state.armed_here,
				last_sweep_at: state.last_sweep_at,
				leader_seen_at: lease?.leader_seen_at ?? null,
				lease_until: lease?.lease_until ?? null,
				mail_ready: lease?.mail_ready ?? null,
			},
			limits: {
				recipients_per_send: MAX_REPORT_RECIPIENTS,
				address_book: MAX_ADDRESS_BOOK,
				email_schedules_per_outlet: MAX_EMAIL_SCHEDULES_PER_OUTLET,
				window_days: MAX_SEND_WINDOW_DAYS,
				restaurant_daily: TENANT_DAILY_CAP(),
				platform_daily: PLATFORM_DAILY_CAP(),
				send_now_per_hour: SEND_NOW_PER_HOUR,
				test_per_hour: TEST_EMAILS_PER_HOUR,
			},
			formats: [...REPORT_EMAIL_FORMATS],
			reports: REPORT_CATALOGUE.map((r) => ({ key: r.key, title: r.title, family: r.family, window_modes: [...r.windowModes] })),
			can_edit_recipients: canEdit,
			can_use_all_outlets: callerMayUseAllOutlets(req),
		});
	} catch (e) { mapError(res, e, "Unable to load the email settings", "report_email_config_failed"); }
});

// --- The address book --------------------------------------------------------

app.get("/reports/email/recipients", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		res.json({
			recipients: await ListReportEmailRecipients(restaurantId),
			can_edit: callerHasPermission(req, PERM_SETTINGS),
			max: MAX_ADDRESS_BOOK,
		});
	} catch (e) { mapError(res, e, "Unable to load the address book", "report_email_recipients_failed"); }
});

app.post("/reports/email/recipients", validateAction(PERM_SETTINGS), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId || !req.auth) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	if (!(await refuseUnlessReady(res, { needMail: false }))) { return; }
	if (await tenantRateLimited(`report-book:${req.auth.res_id}`, BOOK_WRITES_PER_DAY, 86_400)) {
		refuse(res, 429, "rate_limited", "Too many address book changes today. Try again tomorrow.");
		return;
	}
	const body = (req.body ?? {}) as { email?: unknown; label?: unknown };
	try {
		const added = await AddReportEmailRecipient(restaurantId, body, extractEmployeeId(req) ?? undefined);
		try {
			await log_audit(req, REPORT_EMAIL_RECIPIENTS_ACTION_ID, `Added ${added.email} to the report email address book`,
				Audit_log_category.General, { recipient_id: added.id, email: added.email, label: added.label, before: null, after: { email: added.email, label: added.label } });
		} catch (err) { logger.warn({ err }, "log_audit report recipient add failed"); }
		res.status(201).json({ recipient: added });
	} catch (e) { mapError(res, e, "Unable to add the address", "report_email_recipient_add_failed"); }
});

// SOFT delete: the row stays as history, and the sweep's send-time check stops
// every schedule's next email to it at once.
app.delete("/reports/email/recipients/:id", validateAction(PERM_SETTINGS), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId || !req.auth) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	if (!(await refuseUnlessReady(res, { needMail: false }))) { return; }
	if (await tenantRateLimited(`report-book:${req.auth.res_id}`, BOOK_WRITES_PER_DAY, 86_400)) {
		refuse(res, 429, "rate_limited", "Too many address book changes today. Try again tomorrow.");
		return;
	}
	try {
		const removed = await RemoveReportEmailRecipient(restaurantId, String(req.params.id ?? ""), extractEmployeeId(req) ?? undefined);
		if (!removed) { refuse(res, 404, "not_found", "That address is not in the address book."); return; }
		try {
			await log_audit(req, REPORT_EMAIL_RECIPIENTS_ACTION_ID, `Removed ${removed.email} from the report email address book`,
				Audit_log_category.General, { recipient_id: removed.id, email: removed.email, before: { email: removed.email, label: removed.label }, after: null });
		} catch (err) { logger.warn({ err }, "log_audit report recipient remove failed"); }
		res.json({ removed: true, recipient: removed });
	} catch (e) { mapError(res, e, "Unable to remove the address", "report_email_recipient_remove_failed"); }
});

// A message with no figures and no attachment, to one address in the book —
// how an owner proves the whole path (DNS, the provider, the spam folder)
// before the first real report depends on it. Queued like Send now; the client
// polls the delivery.
app.post("/reports/email/test", validateAction(PERM_SETTINGS), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId || !req.auth) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	if (!(await refuseUnlessReady(res, { needMail: true }))) { return; }
	const auth = req.auth;
	const body = (req.body ?? {}) as { recipient_id?: unknown; client_request_id?: unknown };
	const recipientId = String(body.recipient_id ?? "").trim();
	try {
		const [recipient] = await GetReportEmailRecipientsByIds(restaurantId, [recipientId]);
		if (!recipient) { refuse(res, 404, "not_found", "That address is not in the address book."); return; }
		if (recipient.status !== "active") { refuse(res, 403, "recipient_not_allowed", `${recipient.email} is paused in the address book.`); return; }
		if (await tenantRateLimited(`report-test:${auth.res_id}`, TEST_EMAILS_PER_HOUR, 3600)
			|| (await CountRecentAdhocSends(auth.res_id, 60, true)) >= TEST_EMAILS_PER_HOUR) {
			refuse(res, 429, "rate_limited", `At most ${String(TEST_EMAILS_PER_HOUR)} test emails an hour. Try again later.`);
			return;
		}
		const requestId = UUID_RE.test(String(body.client_request_id ?? "")) ? String(body.client_request_id) : randomUUID();
		const w = await ResolveReportEmailWindow(restaurantId, {}, 1);
		const { id, replayed } = await InsertAdhocReportDelivery(restaurantId, {
			client_request_id: requestId,
			report_keys: [],
			formats: ["csv"],
			outlet_scope: "outlet",
			period_from: w.from,
			period_to: w.to,
			day_close: null,
			window_start_at: w.window_start_at,
			window_end_at: w.window_end_at,
			timezone: w.timezone,
			recipients: [recipient.email],
			requested_by: extractEmployeeId(req),
		});
		if (!replayed) {
			try {
				await log_audit(req, REPORT_EMAIL_RECIPIENTS_ACTION_ID, `Sent a test report email to ${recipient.email}`,
					Audit_log_category.General, { recipient_id: recipient.id, email: recipient.email, delivery_id: id });
			} catch (err) { logger.warn({ err }, "log_audit report test email failed"); }
		}
		void kickReportDelivery(auth.res_id, id);
		res.status(replayed ? 200 : 202).json({ delivery_id: id, replayed });
	} catch (e) { mapError(res, e, "Unable to send the test email", "report_email_test_failed"); }
});

// --- Send now -----------------------------------------------------------------
//
// The reports on screen (or any of the eighteen), for a window, to addresses
// from the book. 202 with the delivery id; the same client_request_id again is
// a 200 with the SAME delivery — a request retried after a dropped response
// must not become a second email.
app.post("/reports/email/send", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId || !req.auth) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	if (process.env.REPORT_SEND_NOW === "false") {
		refuse(res, 503, "send_now_disabled", "Sending reports on demand is switched off on this server.");
		return;
	}
	if (!(await refuseUnlessReady(res, { needMail: true }))) { return; }
	const auth = req.auth;
	const body = (req.body ?? {}) as {
		client_request_id?: unknown; report_keys?: unknown; formats?: unknown;
		window?: { from?: unknown; to?: unknown; day_close?: unknown; slot?: unknown; time_from?: unknown; time_to?: unknown };
		outlet_scope?: unknown; recipient_ids?: unknown;
	};
	const requestId = String(body.client_request_id ?? "").trim();
	if (!UUID_RE.test(requestId)) { refuse(res, 400, "invalid", "client_request_id must be a UUID generated once per send."); return; }
	const window = body.window ?? {};
	if (window.slot !== undefined || window.time_from !== undefined || window.time_to !== undefined) {
		refuse(res, 400, "invalid", "Emailed reports always cover whole days. Clear the time slot, or send the file you exported instead.");
		return;
	}
	const closeRaw = window.day_close === undefined || window.day_close === null ? "" : String(window.day_close).trim();
	const close = closeRaw ? parseDayClose(closeRaw) : null;
	if (closeRaw && close === null) { refuse(res, 400, "invalid", "day_close must be a time written as HH:mm."); return; }
	const mode = close ? "trading_day" : "calendar";
	const selection = validateReportSelection(body.report_keys, mode);
	if (!selection.ok) { refuse(res, 400, "invalid", selection.error); return; }
	const formats = validateReportFormats(body.formats);
	if (!formats.ok) { refuse(res, 400, "invalid", formats.error); return; }
	const scopeRaw = String(body.outlet_scope ?? "outlet").trim().toLowerCase();
	if (scopeRaw !== "outlet" && scopeRaw !== "all") { refuse(res, 400, "invalid", "outlet_scope must be outlet or all."); return; }
	if (scopeRaw === "all" && !callerMayUseAllOutlets(req)) {
		refuse(res, 403, "all_outlets_not_allowed", "Only an admin or a manager can send reports for all outlets combined.");
		return;
	}
	const ids = Array.isArray(body.recipient_ids) ? [...new Set(body.recipient_ids.map((x) => String(x)))] : [];
	if (ids.length === 0 || ids.length > MAX_REPORT_RECIPIENTS) {
		refuse(res, 400, "invalid", `Choose 1 to ${String(MAX_REPORT_RECIPIENTS)} addresses from the address book.`);
		return;
	}
	try {
		// A REPLAY is answered before any limit: it asks for nothing new.
		const existing = await FindAdhocDelivery(restaurantId, requestId);
		if (existing) {
			void kickReportDelivery(auth.res_id, existing);
			res.status(200).json({ delivery_id: existing, replayed: true });
			return;
		}
		const found = await GetReportEmailRecipientsByIds(restaurantId, ids);
		if (found.length !== ids.length || found.some((r) => r.status !== "active")) {
			refuse(res, 403, "recipient_not_allowed", "Reports can only be sent to active addresses in this restaurant's address book. Reload and choose again.");
			return;
		}
		if (await tenantRateLimited(`report-send:emp:${auth.employeeId}`, SEND_NOW_PER_MINUTE, 60)
			|| await tenantRateLimited(`report-send:res:${auth.res_id}`, SEND_NOW_PER_HOUR, 3600)
			|| (await CountRecentAdhocSends(auth.res_id, 60, false)) >= SEND_NOW_PER_HOUR) {
			refuse(res, 429, "rate_limited", "Too many reports sent in a short time. Wait a few minutes and try again.");
			return;
		}
		if ((await CountRecentReportEmails(auth.res_id)) + found.length > TENANT_DAILY_CAP()) {
			refuse(res, 429, "daily_limit", `This restaurant has reached its limit of ${String(TENANT_DAILY_CAP())} report emails in 24 hours.`);
			return;
		}
		const w = await ResolveReportEmailWindow(restaurantId, { from: window.from, to: window.to, day_close: close === null ? undefined : closeRaw }, MAX_SEND_WINDOW_DAYS);
		const { id, replayed } = await InsertAdhocReportDelivery(restaurantId, {
			client_request_id: requestId,
			report_keys: selection.keys,
			formats: formats.formats,
			outlet_scope: scopeRaw,
			period_from: w.from,
			period_to: w.to,
			day_close: w.day_close,
			window_start_at: w.window_start_at,
			window_end_at: w.window_end_at,
			timezone: w.timezone,
			recipients: found.map((r) => r.email),
			requested_by: extractEmployeeId(req),
		});
		if (!replayed) {
			try {
				await log_audit(req, REPORT_EMAILED_ACTION_ID,
					`Emailed ${reportListPhrase(selection.keys)} for ${w.from === w.to ? w.from : `${w.from} to ${w.to}`}${w.day_close ? ` (trading day closing ${w.day_close})` : ""} to ${String(found.length)} address${found.length === 1 ? "" : "es"}`,
					Audit_log_category.General,
					{ delivery_id: id, report_keys: selection.keys, formats: formats.formats, outlet_scope: scopeRaw, window: { from: w.from, to: w.to, day_close: w.day_close, start: w.window_start_at, end: w.window_end_at }, recipient_ids: found.map((r) => r.id) });
			} catch (err) { logger.warn({ err }, "log_audit report send failed"); }
		}
		void kickReportDelivery(auth.res_id, id);
		res.status(replayed ? 200 : 202).json({ delivery_id: id, replayed, window: w });
	} catch (e) { mapError(res, e, "Unable to send these reports", "report_email_send_failed"); }
});

// --- The delivery log ----------------------------------------------------------

// One delivery, with its per-address outcome and its files — what Send now's
// caller polls. Registered after the literal GET /reports/deliveries in
// routes/accounting.ts, which it cannot shadow (it has one more segment).
app.get("/reports/deliveries/:id", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const delivery = await GetReportDelivery(restaurantId, String(req.params.id ?? ""));
		if (!delivery) { refuse(res, 404, "not_found", "No such delivery"); return; }
		res.json({ delivery });
	} catch (e) { mapError(res, e, "Unable to load this delivery", "report_delivery_read_failed"); }
});

// The figures live HERE, behind the reports permission — never in the bell.
app.get("/reports/deliveries/:id/files/:fileId", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const file = await GetReportDeliveryFile(restaurantId, String(req.params.id ?? ""), String(req.params.fileId ?? ""));
		if (!file) { refuse(res, 404, "not_found", "No file here — it may have been cleared after 90 days."); return; }
		res.setHeader("Content-Type", file.mime);
		res.setHeader("Content-Disposition", `attachment; filename="${file.filename.replace(/[^A-Za-z0-9._-]+/g, "-")}"`);
		res.setHeader("Content-Length", String(file.body.length));
		res.send(file.body);
	} catch (e) { mapError(res, e, "Unable to download this file", "report_delivery_file_failed"); }
});
}
