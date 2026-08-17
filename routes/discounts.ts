/**
 * The discount approval queue (request, approve, reject).
 */
import type { Express, Request, Response } from "express";
import { Audit_log_category, DecideDiscountRequest, GetDiscountRequests } from "../database_supabase.js";
import { logger } from "../observability.js";
import { emitRestaurant } from "../realtime.js";
import { PERM_DISCOUNTS, enforcePermission, extractEmployeeId, extractRestaurantId, log_audit, validate } from "./_shared.js";


export function registerDiscountRequestRoutes(app: Express): void {

// --- Discount approval queue (admin) -----------------------------------------
app.get('/discount-requests', validate, async (req: Request, res: Response) => {
	if (!(await enforcePermission(req, res, PERM_DISCOUNTS))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const status = typeof req.query.status === "string" ? req.query.status : undefined;
	try { res.json({ requests: await GetDiscountRequests(restaurantId, status) }); }
	catch (e) { logger.error({ err: e }, 'get_discount_requests_failed'); res.status(500).json({ error: "Unable to fetch discount requests" }); }
});

// Approve applies the discount to the bill through the SAME path the direct
// discount uses; reject leaves the bill untouched. Both are audit-logged.
for (const decision of ["approve", "reject"] as const) {
	app.post(`/discount-requests/:id/${decision}`, validate, async (req: Request, res: Response) => {
		if (!(await enforcePermission(req, res, PERM_DISCOUNTS))) {return;}
		const restaurantId = extractRestaurantId(req);
		if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
		const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
		if (!id) { res.status(400).json({ error: "Request id is required" }); return; }
		try {
			const request = await DecideDiscountRequest(restaurantId, id, decision === "approve", extractEmployeeId(req));
			if (decision === "approve") {
				try { if (request.table_name) {emitRestaurant(restaurantId, "bill:updated", { table: request.table_name });} } catch {/* ignore */}
			}
			try {
				const label = `${request.discount_value}${request.discount_type === "percent" ? "%" : ""} (≈${request.amount})`;
				await log_audit(req, "c4d2e6f8-1a3b-4c5d-8e7f-2b4a6c8d0e1f", `${decision === "approve" ? "Approved" : "Rejected"} ${label} discount request for table ${request.table_name ?? "?"} (requested by ${request.requested_by ?? "unknown"})`, Audit_log_category.Bill, { request_id: request.id, bill_id: request.bill_id, decision });
			} catch {/* ignore */}
			res.json({ success: true, request });
		} catch (e: any) {
			logger.error({ err: e }, 'decide_discount_request_failed');
			res.status(400).json({ error: String(e?.message ?? 'Unable to update discount request') });
		}
	});
}
}
