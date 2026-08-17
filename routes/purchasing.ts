/**
 * Purchase orders: raising, status transitions, goods receipt and cancellation.
 */
import type { Express, Request, Response } from "express";
import { Audit_log_category, CreatePurchaseOrder, DeletePurchaseOrder, GetPurchaseOrder, GetPurchaseOrders, ReceivePurchaseOrder, SetPurchaseOrderStatus } from "../database_supabase.js";
import { logger } from "../observability.js";
import { INV_MANAGE, INV_VIEW, extractEmployeeId, extractRestaurantId, log_audit, validateAction } from "./_shared.js";


export function registerPurchaseOrderRoutes(app: Express): void {

// --- Purchase orders ---
app.get("/purchase-orders", validateAction(INV_VIEW), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const status = typeof req.query.status === "string" ? req.query.status : undefined;
	const from = typeof req.query.from === "string" ? req.query.from : undefined;
	const to = typeof req.query.to === "string" ? req.query.to : undefined;
	try { res.json({ orders: await GetPurchaseOrders(restaurantId, { status, from, to }) }); }
	catch (e) { logger.error({ err: e }, "get_purchase_orders_failed"); res.status(500).json({ error: "Unable to fetch purchase orders" }); }
});

app.get("/purchase-orders/:id", validateAction(INV_VIEW), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const order = await GetPurchaseOrder(restaurantId, String(req.params.id));
		if (!order) { res.status(404).json({ error: "Purchase order not found" }); return; }
		res.json(order);
	} catch (e) { logger.error({ err: e }, "get_purchase_order_failed"); res.status(500).json({ error: "Unable to fetch purchase order" }); }
});

app.post("/purchase-orders", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	try {
		const created = await CreatePurchaseOrder(restaurantId, {
			vendor_id: typeof b.vendor_id === "string" ? b.vendor_id : undefined,
			vendor_name: typeof b.vendor_name === "string" ? b.vendor_name : undefined,
			items: b.items,
			notes: typeof b.notes === "string" ? b.notes : undefined,
			expected_date: typeof b.expected_date === "string" ? b.expected_date : undefined,
			status: typeof b.status === "string" ? b.status : undefined,
			createdBy: extractEmployeeId(req) ?? undefined,
		});
		try { await log_audit(req, INV_MANAGE, `Created purchase order ${created.id} (${created.items.length} items, ${created.total_cost})`, Audit_log_category.Inventory, { id: created.id }); } catch {/* ignore */}
		res.json(created);
	} catch (e: any) { logger.error({ err: e }, "create_purchase_order_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to create purchase order") }); }
});

app.post("/purchase-orders/:id/status", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	const status = typeof b.status === "string" ? b.status : "";
	try {
		const updated = await SetPurchaseOrderStatus(restaurantId, String(req.params.id), status);
		try { await log_audit(req, INV_MANAGE, `Purchase order ${updated.id} → ${updated.status}`, Audit_log_category.Inventory, { id: updated.id }); } catch {/* ignore */}
		res.json(updated);
	} catch (e: any) { logger.error({ err: e }, "set_po_status_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to update purchase order") }); }
});

app.post("/purchase-orders/:id/receive", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	const lines = Array.isArray(b.lines)
		? (b.lines).map((l) => ({ inventory_id: String(l?.inventory_id ?? ""), qty_received: Number(l?.qty_received ?? 0) || 0 }))
		: [];
	const qualityRating = typeof b.quality_rating === "number" && b.quality_rating >= 1 && b.quality_rating <= 5 ? b.quality_rating : null;
	try {
		const updated = await ReceivePurchaseOrder(restaurantId, String(req.params.id), lines, extractEmployeeId(req) ?? undefined, qualityRating);
		try { await log_audit(req, INV_MANAGE, `Received against purchase order ${updated.id} (now ${updated.status})`, Audit_log_category.Inventory, { id: updated.id }); } catch {/* ignore */}
		res.json(updated);
	} catch (e: any) { logger.error({ err: e }, "receive_po_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to receive purchase order") }); }
});

app.delete("/purchase-orders/:id", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		await DeletePurchaseOrder(restaurantId, String(req.params.id));
		try { await log_audit(req, INV_MANAGE, `Deleted purchase order ${req.params.id}`, Audit_log_category.Inventory, { id: req.params.id }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (e: any) { logger.error({ err: e }, "delete_po_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to delete purchase order") }); }
});
}
