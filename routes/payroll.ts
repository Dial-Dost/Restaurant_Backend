/**
 * Payroll: staff pay profiles, runs and the CSV export.
 */
import type { Express, Request, Response } from "express";
import { Audit_log_category, GetPayroll, RecordPayrollPayment, SetPayrollProfile } from "../database_supabase.js";
import { logger } from "../observability.js";
import { toCsv } from "../report_render.js";
import { ACCOUNTING_PERM, extractEmployeeId, extractRestaurantId, log_audit, validateAction } from "./_shared.js";


export function registerPayrollRoutes(app: Express): void {

// --- Payroll (accounting) ---------------------------------------------------
app.get("/payroll", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const period = typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month)
		? req.query.month
		: new Date().toISOString().slice(0, 7);
	try { res.json(await GetPayroll(restaurantId, period)); }
	catch (e: any) { logger.error({ err: e }, "get_payroll_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to load payroll") }); }
});

app.put("/payroll/profile", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	const empId = typeof b.emp_id === "string" ? b.emp_id.trim() : "";
	if (!empId) { res.status(400).json({ error: "emp_id is required" }); return; }
	try {
		await SetPayrollProfile(restaurantId, empId, {
			pay_type: typeof b.pay_type === "string" ? b.pay_type : undefined,
			base_salary: Number(b.base_salary ?? 0) || 0,
			hourly_rate: Number(b.hourly_rate ?? 0) || 0,
			allowances: Number(b.allowances ?? 0) || 0,
			deductions: Number(b.deductions ?? 0) || 0,
			pf_pct: Number(b.pf_pct ?? 0) || 0,
			esi_pct: Number(b.esi_pct ?? 0) || 0,
		});
		try { await log_audit(req, ACCOUNTING_PERM, `Updated payroll profile`, Audit_log_category.General, { emp_id: empId }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (e: any) { res.status(400).json({ error: String(e?.message ?? "Unable to save payroll profile") }); }
});

app.post("/payroll/pay", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	try {
		const r = await RecordPayrollPayment(restaurantId, {
			emp_id: typeof b.emp_id === "string" ? b.emp_id : "",
			period: typeof b.period === "string" ? b.period : "",
			amount: Number(b.amount ?? 0) || 0,
			note: typeof b.note === "string" ? b.note : undefined,
			paidBy: extractEmployeeId(req) ?? undefined,
		});
		try { await log_audit(req, ACCOUNTING_PERM, `Recorded salary payment (${b.period})`, Audit_log_category.General, { emp_id: b.emp_id, amount: r.amount }); } catch {/* ignore */}
		res.status(201).json(r);
	} catch (e: any) { res.status(400).json({ error: String(e?.message ?? "Unable to record payment") }); }
});

// Payroll register CSV for the month — gross + statutory (PF/ESI) split per employee.
app.get("/payroll.csv", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const period = typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month)
		? req.query.month
		: new Date().toISOString().slice(0, 7);
	try {
		const p = await GetPayroll(restaurantId, period);
		const r2 = (n: number) => Math.round(n * 100) / 100;
		const rows: (string | number)[][] = p.rows.map((r) => {
			const prof = r.profile;
			const gross = prof ? r2(prof.pay_type === "hourly" ? r.hours_worked * prof.hourly_rate : prof.base_salary) : 0;
			return [
				r.name,
				r.role,
				prof ? prof.pay_type : "",
				gross,
				prof ? prof.allowances : 0,
				prof ? prof.deductions : 0,
				r.pf_amount ?? 0,
				r.esi_amount ?? 0,
				r.computed_pay ?? 0,
				r.paid ? "Yes" : "No",
			];
		});
		res.setHeader("Content-Type", "text/csv; charset=utf-8");
		res.setHeader("Content-Disposition", `attachment; filename="payroll_${period}.csv"`);
		res.send(toCsv(["Name", "Role", "Type", "Gross", "Allowances", "Deductions", "PF", "ESI", "Net", "Paid"], rows));
	} catch (e: any) { logger.error({ err: e }, "payroll_csv_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to export payroll") }); }
});
}
