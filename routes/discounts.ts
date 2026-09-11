/**
 * The discount approval queue (request, approve, reject).
 */
import type { Express, Request, Response } from "express";
import { Audit_log_category, DecideDiscountRequest, GetDiscountRequests, isDiscountDecisionError } from "../database_supabase.js";
import { logger } from "../observability.js";
import { emitRestaurant } from "../realtime.js";
import { PERM_CLOSE_BILL, PERM_DISCOUNTS, callerIsAdmin, enforcePermission, extractEmployeeId, extractRestaurantId, log_audit, validate } from "./_shared.js";
import { isDiscountAuthorityError } from "../discount_authority.js";


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
			// THE DECIDER'S OWN IDENTITY TRAVELS WITH THE DECISION.
			//
			// Holding "Approve Discounts" says this person may work the queue. It
			// does not say they may write a bill off, and it certainly does not say
			// they may approve their own request. Both of those are decided inside
			// the transaction, where the table is read - a check out here would
			// judge a number another order could change before the write. See
			// DecideDiscountRequest's header.
			const request = await DecideDiscountRequest(restaurantId, id, decision === "approve", extractEmployeeId(req), {
				isAdmin: callerIsAdmin(req),
				actions: req.auth?.actions ?? [],
				closeBillPermission: PERM_CLOSE_BILL,
			});
			if (decision === "approve") {
				try { if (request.table_name) {emitRestaurant(restaurantId, "bill:updated", { table: request.table_name });} } catch {/* ignore */}
			}
			try {
				const label = `${request.discount_value}${request.discount_type === "percent" ? "%" : ""} (≈${request.amount})`;
				await log_audit(req, "c4d2e6f8-1a3b-4c5d-8e7f-2b4a6c8d0e1f", `${decision === "approve" ? "Approved" : "Rejected"} ${label} discount request for table ${request.table_name ?? "?"} (requested by ${request.requested_by ?? "unknown"})`, Audit_log_category.Bill, { request_id: request.id, bill_id: request.bill_id, decision });
			} catch {/* ignore */}
			res.json({ success: true, request });
		} catch (e: any) {
			// A REFUSAL IS A 403 THAT SAYS WHY, never a bare 400. The person holding
			// the phone is the one who has to act on it, and "Unable to update
			// discount request" tells them nothing about which manager to fetch.
			if (isDiscountDecisionError(e) || isDiscountAuthorityError(e)) {
				const err = e as { details?: unknown; message?: unknown; code?: unknown; requiredPermission?: unknown };
				const message = String(err.details ?? err.message ?? 'Refused');
				try {
					await log_audit(req, "c4d2e6f8-1a3b-4c5d-8e7f-2b4a6c8d0e1f", `REFUSED to ${decision} discount request ${id}: ${message}`, Audit_log_category.Bill, { request_id: id, decision, refused: true });
				} catch {/* a failed audit write must never turn a 403 into a 500 */}
				res.status(403).json({ error: message, code: err.code, required_permission: err.requiredPermission });
				return;
			}
			logger.error({ err: e }, 'decide_discount_request_failed');
			res.status(400).json({ error: String(e?.message ?? 'Unable to update discount request') });
		}
	});
}
}
