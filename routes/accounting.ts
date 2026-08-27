/**
 * Accounting: expenses, cash sessions, reconciliation, the statutory/management
 * reports (sales, GST, P&L, discounts, balance sheet), their CSV/Tally exports and
 * scheduled report delivery.
 */
import type { Express, Request, Response } from "express";
import { AddExpense, ArchiveReportSchedule, Audit_log_category, BuildTallyXml, CloseCashSession, CreateReportSchedule, DeleteExpense, DeleteReconciliation, GetBalanceSheet, GetCashSessions, GetCurrentCashSession, GetDiscountsReport, GetExpenses, GetGstReport, GetProfitAndLoss, GetReconciliation, GetReportDeliveries, GetReportDeliveryArtifact, GetReportSchedule, GetSalesReport, GetTenantTimezone, ListReportSchedules, OpenCashSession, RECONCILE_ACTION_ID, SaveReconciliation, UpdateReportSchedule } from "../database_supabase.js";
import { logger } from "../observability.js";
import { renderGstCsv, renderSalesCsv, toCsv } from "../report_render.js";
import { queueReportScheduleRun } from "../report_schedules.js";
import { ACCOUNTING_PERM, extractEmployeeId, extractRestaurantId, log_audit, validateAction, windowQuery } from "./_shared.js";


// Audit LABEL for scheduled-report changes, minted by migration 026. NEVER a
// gate — the routes are gated on ACCOUNTING_PERM above, which already guards
// every /reports/* route, so the feature works for every role that can already
// read these reports. (Migration 025's rule.)
const REPORT_SCHEDULE_ACTION_ID = "9e2f47a1-05b3-4c8d-8f6a-71d40b9c2e58";

// The date window every /reports/* route already spoke, unchanged on the wire:
// `from`/`to` as INCLUSIVE YYYY-MM-DD days in the restaurant's timezone. What
// changed is underneath — both ends now resolve through report_window.ts, which
// is where the inclusivity of `to`, the reversed-range swap, the no-future rule
// and the two-year span cap are decided, for accounting and analytics alike.
//
// Missing values still mean "the last 30 days ending today", exactly as before.
function reportRange(req: Request): { from?: string; to?: string } {
	return {
		from: typeof req.query.from === "string" ? req.query.from : undefined,
		to: typeof req.query.to === "string" ? req.query.to : undefined,
	};
}

export function registerExpenseRoutes(app: Express): void {

app.get("/expenses", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const { from, to } = reportRange(req);
	try { res.json({ expenses: await GetExpenses(restaurantId, from, to) }); }
	catch (e) { logger.error({ err: e }, "get_expenses_failed"); res.status(500).json({ error: "Unable to fetch expenses" }); }
});

app.post("/expenses", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const amount = Number(body.amount ?? 0) || 0;
	if (amount <= 0) { res.status(400).json({ error: "A positive amount is required" }); return; }
	try {
		const created = await AddExpense(restaurantId, {
			amount,
			category: typeof body.category === "string" ? body.category : undefined,
			vendor: typeof body.vendor === "string" ? body.vendor : undefined,
			note: typeof body.note === "string" ? body.note : undefined,
			spent_on: typeof body.spent_on === "string" ? body.spent_on : undefined,
			createdBy: extractEmployeeId(req) ?? undefined,
		});
		try { await log_audit(req, ACCOUNTING_PERM, `Added expense ${created.category} ${created.amount}`, Audit_log_category.Bill, { id: created.id }); } catch {/* ignore */}
		res.json(created);
	} catch (e: any) { logger.error({ err: e }, "add_expense_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to add expense") }); }
});

app.delete("/expenses/:id", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!id) { res.status(400).json({ error: "Missing id" }); return; }
	try {
		await DeleteExpense(restaurantId, id);
		try { await log_audit(req, ACCOUNTING_PERM, `Deleted expense ${id}`, Audit_log_category.Bill, { id }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (e) { logger.error({ err: e }, "delete_expense_failed"); res.status(400).json({ error: "Unable to delete expense" }); }
});
}


export function registerAccountingRoutes(app: Express): void {

// --- Cash register / day-close ---
app.get("/cash/current", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { res.json({ session: await GetCurrentCashSession(restaurantId) }); }
	catch (e) { logger.error({ err: e }, "cash_current_failed"); res.status(500).json({ error: "Unable to fetch cash session" }); }
});

app.post("/cash/open", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	try {
		const session = await OpenCashSession(restaurantId, {
			opening_float: Number(body.opening_float ?? 0) || 0,
			openedBy: extractEmployeeId(req) ?? undefined,
		});
		try { await log_audit(req, ACCOUNTING_PERM, `Opened cash session (float ${session.opening_float})`, Audit_log_category.Bill, { id: session.id }); } catch {/* ignore */}
		res.json(session);
	} catch (e: any) { logger.error({ err: e }, "cash_open_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to open cash session") }); }
});

app.post("/cash/close", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const counted = Number(body.counted_cash ?? NaN);
	if (!Number.isFinite(counted) || counted < 0) { res.status(400).json({ error: "counted_cash is required" }); return; }
	try {
		const session = await CloseCashSession(restaurantId, {
			counted_cash: counted,
			cash_payouts: Number(body.cash_payouts ?? 0) || 0,
			notes: typeof body.notes === "string" ? body.notes : undefined,
			closedBy: extractEmployeeId(req) ?? undefined,
		});
		try { await log_audit(req, ACCOUNTING_PERM, `Closed cash session (variance ${session.variance})`, Audit_log_category.Bill, { id: session.id }); } catch {/* ignore */}
		res.json(session);
	} catch (e: any) { logger.error({ err: e }, "cash_close_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to close cash session") }); }
});

app.get("/cash/sessions", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const { from, to } = reportRange(req);
	try { res.json({ sessions: await GetCashSessions(restaurantId, from, to) }); }
	catch (e) { logger.error({ err: e }, "cash_sessions_failed"); res.status(500).json({ error: "Unable to fetch cash sessions" }); }
});

app.get("/reports/sales", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const { from, to } = reportRange(req);
	try { res.json(await GetSalesReport(restaurantId, from, to)); }
	catch (e) { logger.error({ err: e }, "sales_report_failed"); res.status(500).json({ error: "Unable to build sales report" }); }
});

app.get("/reports/gst", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const { from, to } = reportRange(req);
	try { res.json(await GetGstReport(restaurantId, from, to)); }
	catch (e) { logger.error({ err: e }, "gst_report_failed"); res.status(500).json({ error: "Unable to build GST report" }); }
});

app.get("/reports/pnl", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const { from, to } = reportRange(req);
	try { res.json(await GetProfitAndLoss(restaurantId, from, to)); }
	catch (e) { logger.error({ err: e }, "pnl_report_failed"); res.status(500).json({ error: "Unable to build P&L report" }); }
});

// Discounts & offers given away in the range (money basis). Bill totals are
// already net of these, so this is additive context — see the payload notes.
app.get("/reports/discounts", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const { from, to } = reportRange(req);
	try { res.json(await GetDiscountsReport(restaurantId, from, to)); }
	catch (e) { logger.error({ err: e }, "discounts_report_failed"); res.status(500).json({ error: "Unable to build discounts report" }); }
});

// Pragmatic balance sheet snapshot as of a date (assets / liabilities / equity
// derived from operational data — see the `notes` field for what's counted).
app.get("/reports/balance-sheet", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	// `as_of` is the shipped parameter and still wins. Failing that the shared
	// from/to window applies and the snapshot is taken at the END of it — so one
	// calendar picker drives this screen as well as the sales report, and a
	// one-day range means precisely what `as_of` always meant.
	const asOf = typeof req.query.as_of === "string" ? req.query.as_of : undefined;
	try { res.json(await GetBalanceSheet(restaurantId, asOf ?? windowQuery(req))); }
	catch (e) { logger.error({ err: e }, "balance_sheet_failed"); res.status(500).json({ error: "Unable to build balance sheet" }); }
});

// --- Bank / settlement reconciliation ---
// Per-payment-method expected takings for a day (same mode attribution as the
// sales report) merged with any saved actual-settlement entries.
app.get("/reconciliation", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	// `date` is the shipped parameter and still wins; otherwise the shared from/to
	// window applies. A one-day range is identical to `date`; a wider one sums the
	// expected takings and the saved entries across it (see GetReconciliation).
	// SAVING stays per-day — the POST/DELETE below still require a single `date`,
	// because a settlement entry is a fact about one day's till.
	const date = typeof req.query.date === "string" ? req.query.date : undefined;
	try { res.json(await GetReconciliation(restaurantId, date ?? windowQuery(req))); }
	catch (e) { logger.error({ err: e }, "reconciliation_get_failed"); res.status(500).json({ error: "Unable to build reconciliation" }); }
});

app.post("/reconciliation", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	try {
		const r = await SaveReconciliation(restaurantId, {
			date: typeof b.date === "string" ? b.date : "",
			method: typeof b.method === "string" ? b.method : "",
			actual: Number(b.actual ?? NaN),
			note: typeof b.note === "string" ? b.note : undefined,
			createdBy: extractEmployeeId(req) ?? undefined,
		});
		try { await log_audit(req, RECONCILE_ACTION_ID, `Reconciled ${r.method} for ${r.date}: expected ${r.expected}, actual ${r.actual} (${r.status})`, Audit_log_category.Bill, { date: r.date, method: r.method, expected: r.expected, actual: r.actual, status: r.status }); } catch {/* ignore */}
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "reconciliation_save_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to save reconciliation") }); }
});

// Undo a saved reconciliation entry for a day+method.
app.delete("/reconciliation", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const date = typeof req.query.date === "string" ? req.query.date : "";
	const method = typeof req.query.method === "string" ? req.query.method : "";
	try {
		const r = await DeleteReconciliation(restaurantId, date, method);
		try { await log_audit(req, RECONCILE_ACTION_ID, `Removed reconciliation entry ${method} for ${date}`, Audit_log_category.Bill, { date, method }); } catch {/* ignore */}
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "reconciliation_delete_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to delete reconciliation entry") }); }
});

// CSV exports (Excel-openable). Called by authenticated API clients.
app.get("/reports/sales.csv", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const { from, to } = reportRange(req);
	try {
		const r = await GetSalesReport(restaurantId, from, to);
		res.setHeader("Content-Type", "text/csv; charset=utf-8");
		res.setHeader("Content-Disposition", `attachment; filename="sales_${r.from}_to_${r.to}.csv"`);
		// Shared with the scheduled export (report_render.ts) so the two can never
		// disagree. This route previously dropped the Service Charge column that
		// by_day already carried — the sheet omitted the owner's own income.
		res.send(renderSalesCsv(r));
	} catch (e) { logger.error({ err: e }, "sales_csv_failed"); res.status(500).json({ error: "Unable to export sales" }); }
});

app.get("/reports/gst.csv", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const { from, to } = reportRange(req);
	try {
		const r = await GetGstReport(restaurantId, from, to);
		res.setHeader("Content-Type", "text/csv; charset=utf-8");
		res.setHeader("Content-Disposition", `attachment; filename="gst_${r.from}_to_${r.to}.csv"`);
		res.send(renderGstCsv(r));
	} catch (e) { logger.error({ err: e }, "gst_csv_failed"); res.status(500).json({ error: "Unable to export GST" }); }
});

// Tally-compatible voucher XML for import into Tally (ERP 9 / Prime).
app.get("/reports/tally.xml", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const { from, to } = reportRange(req);
	try {
		const xml = await BuildTallyXml(restaurantId, from, to);
		res.setHeader("Content-Type", "application/xml; charset=utf-8");
		res.setHeader("Content-Disposition", `attachment; filename="tally_vouchers.xml"`);
		res.send(xml);
	} catch (e) { logger.error({ err: e }, "tally_xml_failed"); res.status(500).json({ error: "Unable to build Tally export" }); }
});

app.get("/expenses.csv", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const { from, to } = reportRange(req);
	try {
		const ex = await GetExpenses(restaurantId, from, to);
		const rows: (string | number)[][] = ex.map((e) => [e.spent_on, e.category, e.vendor ?? "", e.amount, e.note ?? ""]);
		res.setHeader("Content-Type", "text/csv; charset=utf-8");
		res.setHeader("Content-Disposition", `attachment; filename="expenses.csv"`);
		res.send(toCsv(["Date", "Category", "Vendor", "Amount", "Note"], rows));
	} catch (e) { logger.error({ err: e }, "expenses_csv_failed"); res.status(500).json({ error: "Unable to export expenses" }); }
});

// --- Scheduled reports (migration 026) --------------------------------------
// Mounted under /reports/ on purpose: FEATURE_BY_PREFIX already maps that prefix
// to the "accounting" plan feature, so a tenant whose plan has it off gets a 403
// here with no new gating code. The permission is the SAME ACCOUNTING_PERM that
// guards every other /reports/* route — a schedule can only ever deliver what
// that permission already reads, and minting a new gate id would strip the
// feature from every custom role that exists today.
//
// PATCH rather than the settings routes' POST-merge convention because these are
// ROWS, not scalar settings: merge-on-omit exists for a single document.
app.get("/reports/schedules", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { res.json({ schedules: await ListReportSchedules(restaurantId) }); }
	catch (e) { logger.error({ err: e }, "list_report_schedules_failed"); res.status(500).json({ error: "Unable to fetch scheduled reports" }); }
});

app.post("/reports/schedules", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const created = await CreateReportSchedule(restaurantId, (req.body ?? {}) as Record<string, unknown>, extractEmployeeId(req) ?? undefined);
		try {
			await log_audit(req, REPORT_SCHEDULE_ACTION_ID,
				`Created scheduled report "${created.name}" — ${created.report_key} ${created.frequency} at ${String(created.hour_local).padStart(2, "0")}:${String(created.minute_local).padStart(2, "0")} via ${created.channel}`,
				Audit_log_category.General,
				{ schedule_id: created.id, report_key: created.report_key, frequency: created.frequency, hour_local: created.hour_local, minute_local: created.minute_local, channel: created.channel, enabled: created.enabled });
		} catch {/* ignore */}
		res.json(created);
	} catch (e: any) { logger.error({ err: e }, "create_report_schedule_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to create scheduled report") }); }
});

app.patch("/reports/schedules/:id", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const updated = await UpdateReportSchedule(restaurantId, req.params.id, (req.body ?? {}) as Record<string, unknown>, extractEmployeeId(req) ?? undefined);
		try {
			await log_audit(req, REPORT_SCHEDULE_ACTION_ID,
				`${updated.enabled ? "Updated" : "Disabled"} scheduled report "${updated.name}" — ${updated.report_key} ${updated.frequency} at ${String(updated.hour_local).padStart(2, "0")}:${String(updated.minute_local).padStart(2, "0")} via ${updated.channel}`,
				Audit_log_category.General,
				{ schedule_id: updated.id, report_key: updated.report_key, frequency: updated.frequency, hour_local: updated.hour_local, minute_local: updated.minute_local, channel: updated.channel, enabled: updated.enabled });
		} catch {/* ignore */}
		res.json(updated);
	} catch (e: any) { logger.error({ err: e }, "update_report_schedule_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to update scheduled report") }); }
});

// Archives rather than deletes: "ReportDeliveries" holds the at-most-once guard
// as well as the history, so those rows outlive the schedule (migration 026 backs
// this with a non-cascading FK, which refuses a hard delete outright).
app.delete("/reports/schedules/:id", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const schedule = await GetReportSchedule(restaurantId, req.params.id);
		if (!schedule) { res.status(404).json({ error: "Unknown scheduled report" }); return; }
		const archived = await ArchiveReportSchedule(restaurantId, req.params.id, extractEmployeeId(req) ?? undefined);
		if (!archived) { res.status(404).json({ error: "Unknown scheduled report" }); return; }
		try {
			await log_audit(req, REPORT_SCHEDULE_ACTION_ID, `Archived scheduled report "${schedule.name}"`,
				Audit_log_category.General, { schedule_id: schedule.id, report_key: schedule.report_key, frequency: schedule.frequency });
		} catch {/* ignore */}
		res.json({ archived: true });
	} catch (e: any) { logger.error({ err: e }, "archive_report_schedule_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to archive scheduled report") }); }
});

// Mirrors POST /messages/run-reminders: let an admin trigger the job now. It
// QUEUES an extra occurrence under a `manual:`-prefixed key bucketed to the
// tenant-local minute — so it neither collides with nor consumes the scheduled
// occurrence, and repeat clicks inside that minute collide with EACH OTHER and
// are refused below instead of each queueing another full report render. The
// sweep runs it under the schedule's own outlet; see queueReportScheduleRun for
// why it is not rendered inline.
app.post("/reports/schedules/:id/run-now", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const schedule = await GetReportSchedule(restaurantId, req.params.id);
		if (!schedule) { res.status(404).json({ error: "Unknown scheduled report" }); return; }
		const tz = await GetTenantTimezone(restaurantId);
		const deliveryId = await queueReportScheduleRun(restaurantId, schedule, tz);
		if (!deliveryId) { res.status(409).json({ error: "This report was just queued — try again in a minute" }); return; }
		try {
			await log_audit(req, REPORT_SCHEDULE_ACTION_ID, `Ran scheduled report "${schedule.name}" now — ${schedule.report_key} ${schedule.frequency}`,
				Audit_log_category.General,
				{ schedule_id: schedule.id, report_key: schedule.report_key, frequency: schedule.frequency, delivery_id: deliveryId });
		} catch {/* ignore */}
		res.json({ queued: true, delivery_id: deliveryId });
	} catch (e: any) { logger.error({ err: e }, "run_report_schedule_now_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to queue this report") }); }
});

app.get("/reports/deliveries", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const scheduleId = typeof req.query.schedule_id === "string" ? req.query.schedule_id : undefined;
	const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : NaN;
	try { res.json({ deliveries: await GetReportDeliveries(restaurantId, { schedule_id: scheduleId, limit: Number.isFinite(limitRaw) ? limitRaw : undefined }) }); }
	catch (e) { logger.error({ err: e }, "list_report_deliveries_failed"); res.status(500).json({ error: "Unable to fetch report deliveries" }); }
});

// The figures live HERE and nowhere else — the bell notification carries none,
// because GET /notifications is readable by every authenticated employee.
app.get("/reports/deliveries/:id/download", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const artifact = await GetReportDeliveryArtifact(restaurantId, req.params.id);
		if (!artifact) { res.status(404).json({ error: "No report file for this delivery" }); return; }
		res.setHeader("Content-Type", artifact.mime);
		res.setHeader("Content-Disposition", `attachment; filename="${artifact.filename}"`);
		res.send(artifact.body);
	} catch (e) { logger.error({ err: e }, "download_report_delivery_failed"); res.status(500).json({ error: "Unable to download this report" }); }
});
}
