/**
 * Leave requests and their approve/reject decisions.
 */
import type { Express, Request, Response } from "express";
import { Audit_log_category, CreateLeaveRequest, DecideLeaveRequest, ListEmployeeLeaves, normalizeLeaveStatus } from "../database_supabase.js";
import { logger } from "../observability.js";
import { PERM_ATTENDANCE, clampLimit, enforcePermission, extractEmployeeId, extractRestaurantId, log_audit, validate } from "./_shared.js";


// --- Employee leave ----------------------------------------------------------
// Gated on the EXISTING 'Review Attendance' (PERM_ATTENDANCE), the same
// permission that guards GET /attendance and the clock-in review. Whoever
// reviews a shift is who should review a day off, and reusing it means leave
// works for every role that can already do attendance instead of waiting on a
// fresh grant. No new gate is minted.
//
// AUDIT LABELS ONLY — never passed to validateAction. See migration 025 for why
// a leave needs its own title in the log and why that title must not become a
// permission.
const LEAVE_REQUESTED_ACTION = "4455a271-5610-49a3-be8e-3f2e9990170a";
const LEAVE_REVIEWED_ACTION = "6465027f-a3a1-4851-bd8a-cc3360b67993";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The leave layer throws Errors whose message IS the guest-facing explanation
// ("Rahul already has an approved leave covering …"). Anything else is a fault we
// did not anticipate, and its stringification must not leak to the caller.
function leaveErrorText(e: unknown, fallback: string): string {
	const msg = e instanceof Error ? e.message.trim() : "";
	return msg || fallback;
}

// Dates are the RESTAURANT's calendar days ("YYYY-MM-DD"); the resolver below
// hands them straight through and database_supabase defaults them from the
// tenant's own zone. Anything else is rejected rather than coerced, because a
// half-parsed date silently selects the wrong day.
function leaveDayParam(raw: unknown): string | undefined {
	const v: unknown = Array.isArray(raw) ? raw[0] : raw;
	if (typeof v !== "string") { return undefined; }
	const s = v.trim();
	return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
}

// EmployeeLeaves.emp_id is a uuid column and ListEmployeeLeaves compares it as
// `l.emp_id = $N::uuid`, so a non-uuid filter reaches Postgres and throws 22P02 —
// a 500 for what is plainly a bad request. Every other filter on this route is
// already shape-checked; this one was not.
function leaveEmpIdParam(raw: unknown): { ok: true; value?: string } | { ok: false } {
	const v: unknown = Array.isArray(raw) ? raw[0] : raw;
	if (v === undefined || v === null) { return { ok: true }; }
	if (typeof v !== "string") { return { ok: false }; }
	const s = v.trim();
	if (!s) { return { ok: true }; }
	return UUID_RE.test(s) ? { ok: true, value: s } : { ok: false };
}

async function handleLeaveDecision(req: Request, res: Response, approve: boolean): Promise<void> {
	const auth = await enforcePermission(req, res, PERM_ATTENDANCE);
	if (!auth) { return; }
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!id) { res.status(400).json({ error: "Missing id" }); return; }
	try {
		const { leave, changed } = await DecideLeaveRequest(auth.restaurantId, id, approve, extractEmployeeId(req) ?? undefined);
		// A repeat decision is a successful no-op, so it writes NO audit entry —
		// a retried request must not fill the log with decisions nobody made.
		if (changed) {
			try {
				await log_audit(req, LEAVE_REVIEWED_ACTION, `${approve ? "Approved" : "Rejected"} ${leave.leave_type} leave for ${leave.employee_name} (${leave.start_day} to ${leave.end_day})`, Audit_log_category.General, { leave_id: leave.id, emp_id: leave.emp_id, status: leave.status });
			} catch (err) { logger.warn({ err }, "log_audit leave-review failed"); }
		}
		res.json({ success: true, changed, leave });
	} catch (e) {
		res.status(400).json({ error: leaveErrorText(e, "Unable to review leave request") });
	}
}

export function registerLeaveRoutes(app: Express): void {

// Paged exactly like /audit-logs: a bare ARRAY stays the default body (that is
// what existing clients parse), the paging metadata always rides in headers, and
// ?meta=1 opts into the enveloped body.
app.get("/leaves", validate, async (req: Request, res: Response) => {
	const auth = await enforcePermission(req, res, PERM_ATTENDANCE);
	if (!auth) { return; }
	const limit = clampLimit(req.query.limit, 100, 500);
	const offset = Math.max(0, Math.min(Number(req.query.offset) || 0, 100000));
	const emp = leaveEmpIdParam(req.query.emp_id);
	if (!emp.ok) { res.status(400).json({ error: "emp_id must be an employee UUID" }); return; }
	const empId = emp.value;
	const status = normalizeLeaveStatus(req.query.status) ?? undefined;
	const wantMeta = req.query.meta === "1" || req.query.meta === "true";
	try {
		const page = await ListEmployeeLeaves(auth.restaurantId, {
			emp_id: empId,
			from: leaveDayParam(req.query.from),
			to: leaveDayParam(req.query.to),
			status,
			limit,
			offset,
		});
		res.setHeader("X-Total-Count", String(page.total));
		res.setHeader("X-Has-More", page.has_more ? "1" : "0");
		if (wantMeta) { res.json(page); return; }
		res.json(page.leaves);
	} catch (e) {
		logger.error({ err: e }, "list_leaves_failed");
		res.status(500).json({ error: "Unable to fetch leave requests" });
	}
});

// Filing a leave for YOURSELF needs no special permission — it is a request, not
// a decision, exactly like clocking in. Filing one for SOMEONE ELSE does, so an
// employee cannot book their colleague a week off.
app.post("/leaves", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	const me = extractEmployeeId(req);
	if (!restaurantId || !me) { res.status(400).json({ error: "Missing identity" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const target = typeof body.emp_id === "string" && body.emp_id.trim() ? body.emp_id.trim() : me;
	if (target !== me && !(await enforcePermission(req, res, PERM_ATTENDANCE))) { return; }
	try {
		const leave = await CreateLeaveRequest(restaurantId, {
			emp_id: target,
			leave_type: typeof body.leave_type === "string" ? body.leave_type : undefined,
			start_day: leaveDayParam(body.start_day),
			end_day: leaveDayParam(body.end_day),
			reason: typeof body.reason === "string" ? body.reason : undefined,
			// The actor's employee id. NOT the username DiscountRequests.requested_by
			// stores — decided_by on this table is written from extractEmployeeId too,
			// and a column holding a mix of ids and usernames is unjoinable.
			requested_by: me,
		});
		try {
			await log_audit(req, LEAVE_REQUESTED_ACTION, `Requested ${leave.leave_type} leave for ${leave.employee_name}: ${leave.start_day} to ${leave.end_day} (${String(leave.days)} day${leave.days === 1 ? "" : "s"})`, Audit_log_category.General, { leave_id: leave.id, emp_id: leave.emp_id, leave_type: leave.leave_type, start_day: leave.start_day, end_day: leave.end_day });
		} catch (err) { logger.warn({ err }, "log_audit leave-create failed"); }
		res.status(201).json(leave);
	} catch (e) {
		// A clashing leave is the caller's problem to resolve, not a server fault.
		res.status(400).json({ error: leaveErrorText(e, "Unable to create leave request") });
	}
});
app.post("/leaves/:id/approve", validate, (req: Request, res: Response) => void handleLeaveDecision(req, res, true));
app.post("/leaves/:id/reject", validate, (req: Request, res: Response) => void handleLeaveDecision(req, res, false));
}
