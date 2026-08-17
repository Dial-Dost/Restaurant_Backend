/**
 * Staff attendance: clock in/out, the personal and manager views, and review.
 */
import type { Express, Request, Response } from "express";
import { Audit_log_category, ClockIn, ClockOut, GetAttendanceSummary, GetMyAttendance, SetAttendanceApproval } from "../database_supabase.js";
import { logger } from "../observability.js";
import { PERM_ATTENDANCE, enforcePermission, extractEmployeeId, extractRestaurantId, log_audit, validate } from "./_shared.js";


// --- Attendance / working hours ---------------------------------------------
// Admin reviews a pending clock-in. Approval/rejection stamps who + when; the
// shift's clock_in remains the employee's actual clock-in moment, never the
// approval time.
const ATTENDANCE_REVIEW_ACTION = "e7a41c3b-5a20-4f6e-9d38-6c2b9a51f0aa";
async function handleAttendanceReview(req: Request, res: Response, approve: boolean): Promise<void> {
	const admin = await enforcePermission(req, res, PERM_ATTENDANCE);
	if (!admin) {return;}
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!id) { res.status(400).json({ error: "Missing id" }); return; }
	try {
		const r = await SetAttendanceApproval(admin.restaurantId, id, approve, extractEmployeeId(req) ?? undefined);
		try {
			await log_audit(req, ATTENDANCE_REVIEW_ACTION, `${approve ? "Approved" : "Rejected"} clock-in of employee ${r.emp_id} (clocked in ${r.clock_in})`, Audit_log_category.General, { attendance_id: id, emp_id: r.emp_id, status: r.status });
		} catch (err) { logger.warn({ err }, "log_audit attendance-review failed"); }
		res.json({ success: true, status: r.status, clock_in: r.clock_in });
	} catch (e: any) { res.status(400).json({ error: String(e?.message ?? "Unable to review clock-in") }); }
}

export function registerAttendanceRoutes(app: Express): void {
app.post("/attendance/:id/approve", validate, (req: Request, res: Response) => void handleAttendanceReview(req, res, true));
app.post("/attendance/:id/reject", validate, (req: Request, res: Response) => void handleAttendanceReview(req, res, false));

app.post("/attendance/clock-in", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	const employeeId = extractEmployeeId(req);
	if (!restaurantId || !employeeId) { res.status(400).json({ error: "Missing identity" }); return; }
	try {
		const r = await ClockIn(restaurantId, employeeId);
		try { await log_audit(req, "b3f8d6a1-2c47-4e0b-8f5d-9e6a7c8b0d21", `Clocked in at ${r.since} (pending approval)`, Audit_log_category.General, { at: r.since }); } catch (err) { logger.warn({ err }, "log_audit clock-in failed"); }
		res.json(r);
	}
	catch (e: any) { logger.error({ err: e }, "clock_in_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to clock in") }); }
});

app.post("/attendance/clock-out", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	const employeeId = extractEmployeeId(req);
	if (!restaurantId || !employeeId) { res.status(400).json({ error: "Missing identity" }); return; }
	try {
		const r = await ClockOut(restaurantId, employeeId);
		try { await log_audit(req, "b3f8d6a1-2c47-4e0b-8f5d-9e6a7c8b0d21", `Clocked out after ${r.minutes} min`, Audit_log_category.General, { minutes: r.minutes }); } catch (err) { logger.warn({ err }, "log_audit clock-out failed"); }
		res.json(r);
	}
	catch (e: any) { logger.error({ err: e }, "clock_out_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to clock out") }); }
});

app.get("/attendance/me", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	const employeeId = extractEmployeeId(req);
	if (!restaurantId || !employeeId) { res.status(400).json({ error: "Missing identity" }); return; }
	try { res.json(await GetMyAttendance(restaurantId, employeeId)); }
	catch (e) { logger.error({ err: e }, "get_my_attendance_failed"); res.status(500).json({ error: "Unable to fetch attendance" }); }
});

app.get("/attendance", validate, async (req: Request, res: Response) => {
	const auth = await enforcePermission(req, res, PERM_ATTENDANCE);
	if (!auth) {return;}
	const from = typeof req.query.from === "string" ? req.query.from : undefined;
	const to = typeof req.query.to === "string" ? req.query.to : undefined;
	try { res.json(await GetAttendanceSummary(auth.restaurantId, from, to)); }
	catch (e) { logger.error({ err: e }, "attendance_summary_failed"); res.status(500).json({ error: "Unable to fetch attendance summary" }); }
});
}
