/**
 * Inventory items, stock movements (receive/wastage/issue/expiry), price history
 * and category renames.
 */
import type { Express, Request, Response } from "express";
import { Audit_log_category, DeleteInventoryItem, GetInventoryItems, GetRestaurantSettings, GetStockMovements, GetVendorPriceHistory, ISSUE_STOCK_ACTION_ID, IssueStock, ReceiveStock, RecordWastage, RenameInventoryCategory, SetInventoryExpiry, SetInventoryReorderLevel, SetRestaurantSettings, UpsertInventoryItem } from "../database_supabase.js";
import { logger } from "../observability.js";
import { INV_MANAGE, INV_VIEW, extractEmployeeId, extractRestaurantId, log_audit, validateAction } from "./_shared.js";


export function registerInventoryRoutes(app: Express): void {

// app.post("/audit-logs", validateAction("722e1023-99f8-4905-ab51-97404694eab6"), async (req: Request, res: Response) => {
// 	const restaurantId = extractRestaurantId(req);
// 	if (!restaurantId) {
// 		res.status(400).json({ error: "Missing restaurantId" });
// 		return;
// 	}

// 	const body = (req.body ?? {}) as Record<string, unknown>;
// 	const employeeFromHeader = extractEmployeeId(req)?.trim() ?? "";
// 	const employeeFromBody = typeof body.employee === "string" ? body.employee.trim() : "";
// 	const employeeIdFromBody = typeof body.employee_id === "string" ? body.employee_id.trim() : "";
// 	const employee = employeeFromHeader || employeeIdFromBody || employeeFromBody;
// 	const action = typeof body.action === "string" ? body.action.trim() : "";
// 	const details = typeof body.details === "string" ? body.details.trim() : "";

// 	if (!employee || !action) {
// 		res.status(400).json({ error: "Missing employee or action" });
// 		return;
// 	}

// 	try {
// 		await AddAuditLogEntryLegacy(restaurantId, {
// 			employee,
// 			employeeId: employeeFromHeader || employeeIdFromBody || null,
// 			action,
// 			details: details || null,
// 			category: Audit_log_category.General
// 		});
// 		try {
// 			await log_audit(req, "722e1023-99f8-4905-ab51-97404694eab6", `Recorded audit-log entry ${action}`, Audit_log_category.General, { employee });
// 		} catch (err) {
// 			console.warn('log_audit post-audit-logs failed', err);
// 		}
// 		res.status(201).json({ success: true });
// 	} catch (error) {
// 		console.error("add_audit_log_failed", error);
// 		res.status(500).json({ error: "Unable to record audit log" });
// 	}
// });

app.get("/inventory", validateAction("77e41c84-ebf4-4542-a75b-c9e72e03b570"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	try {
		const items = await GetInventoryItems(restaurantId);
		try {
			/* read action — not audited (avoids log clutter) */
		} catch (err) {
			logger.warn({ err }, 'log_audit get-inventory failed');
		}
		res.json(items);
	} catch (error) {
		logger.error({ err: error }, "get_inventory_failed");
		res.status(500).json({ error: "Unable to fetch inventory" });
	}
});

app.post("/inventory", validateAction("dfe2cde8-c159-4685-b015-ec7b0d4386eb"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = (req.body ?? {}) as Record<string, unknown>;
	const name = typeof body.name === "string" ? body.name.trim() : "";
	const stock = Number(body.stock ?? 0);
	if (!name || !Number.isFinite(stock)) {
		res.status(400).json({ error: "name and stock are required" });
		return;
	}

	// `reorder_level` is tri-state on purpose and must stay that way: ABSENT means
	// "leave whatever is stored alone" (every client built before this field
	// existed sends nothing, and must not wipe a level the owner set), null means
	// "clear it", a number means "set it". The data layer merges on the same
	// three cases.
	const hasReorder = Object.prototype.hasOwnProperty.call(body, "reorder_level");
	const rawReorder = body.reorder_level;
	const reorderLevel = !hasReorder
		? undefined
		: (rawReorder === null || rawReorder === "" ? null : Number(rawReorder));
	if (reorderLevel !== undefined && reorderLevel !== null && !(Number.isFinite(reorderLevel) && reorderLevel > 0)) {
		res.status(400).json({ error: "reorder_level must be a positive number or null" });
		return;
	}

	try {
		const result = await UpsertInventoryItem(restaurantId, {
			id: typeof body.id === "string" ? body.id : undefined,
			name,
			category: typeof body.category === "string" ? body.category : undefined,
			stock,
			unit: typeof body.unit === "string" ? body.unit : undefined,
			...(reorderLevel === undefined ? {} : { reorder_level: reorderLevel }),
			...(typeof body.reorder_unit === "string" ? { reorder_unit: body.reorder_unit } : {}),
		});
		await log_audit(req, "dfe2cde8-c159-4685-b015-ec7b0d4386eb", `Upserted inventory item ${name} with stock ${stock}`, Audit_log_category.Inventory);
		res.status(201).json(result);
	} catch (error) {
		logger.error({ err: error }, "upsert_inventory_failed");
		res.status(500).json({ error: "Unable to save inventory item" });
	}
});
}


export function registerInventoryMovementRoutes(app: Express): void {

app.post("/inventory/receive", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	const inventory_id = typeof b.inventory_id === "string" ? b.inventory_id.trim() : "";
	const qty = Number(b.qty ?? 0) || 0;
	if (!inventory_id || qty <= 0) { res.status(400).json({ error: "inventory_id and a positive qty are required" }); return; }
	try {
		const r = await ReceiveStock(restaurantId, { inventory_id, qty, vendor_id: typeof b.vendor_id === "string" ? b.vendor_id : undefined, unit_cost: typeof b.unit_cost === "number" ? b.unit_cost : undefined, note: typeof b.note === "string" ? b.note : undefined, createdBy: extractEmployeeId(req) ?? undefined });
		// Undo posts a COMPENSATING movement back to the prior quantity — the
		// original StockMovements row is never removed.
		try { await log_audit(req, INV_MANAGE, `Received ${qty} stock`, Audit_log_category.Inventory, {
			inventory_id,
			undo: { kind: "inventory_adjust", target_id: inventory_id, before: { quantity: r.quantity - qty }, after: { quantity: r.quantity } },
		}); } catch {/* ignore */}
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "receive_stock_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to receive stock") }); }
});
app.post("/inventory/wastage", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	const inventory_id = typeof b.inventory_id === "string" ? b.inventory_id.trim() : "";
	const qty = Number(b.qty ?? 0) || 0;
	if (!inventory_id || qty <= 0) { res.status(400).json({ error: "inventory_id and a positive qty are required" }); return; }
	try {
		const r = await RecordWastage(restaurantId, { inventory_id, qty, reason: typeof b.reason === "string" ? b.reason : undefined, createdBy: extractEmployeeId(req) ?? undefined });
		// Undo posts a COMPENSATING receipt back to the prior quantity — the
		// original StockMovements row is never removed.
		try { await log_audit(req, INV_MANAGE, `Wastage ${qty}`, Audit_log_category.Inventory, {
			inventory_id,
			undo: { kind: "inventory_adjust", target_id: inventory_id, before: { quantity: r.quantity + qty }, after: { quantity: r.quantity } },
		}); } catch {/* ignore */}
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "record_wastage_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to record wastage") }); }
});
// Issue stock from the store to the kitchen (feeds the food-cost % KPI).
app.post("/inventory/issue", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	const inventory_id = typeof b.inventory_id === "string" ? b.inventory_id.trim() : "";
	const qty = Number(b.qty ?? 0) || 0;
	if (!inventory_id || qty <= 0) { res.status(400).json({ error: "inventory_id and a positive qty are required" }); return; }
	try {
		const r = await IssueStock(restaurantId, { inventory_id, qty, note: typeof b.note === "string" ? b.note : undefined, createdBy: extractEmployeeId(req) ?? undefined });
		try { await log_audit(req, ISSUE_STOCK_ACTION_ID, `Issued ${qty} to kitchen`, Audit_log_category.Inventory, { inventory_id }); } catch {/* ignore */}
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "issue_stock_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to issue stock") }); }
});
// Vendor price history for one ingredient (costed purchases only).
app.get("/inventory/price-history", validateAction(INV_VIEW), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const inventoryId = typeof req.query.inventory_id === "string" ? req.query.inventory_id.trim() : "";
	if (!inventoryId) { res.status(400).json({ error: "inventory_id is required" }); return; }
	try { res.json(await GetVendorPriceHistory(restaurantId, inventoryId)); }
	catch (e) { logger.error({ err: e }, "get_price_history_failed"); res.status(500).json({ error: "Unable to fetch price history" }); }
});
// Set (or clear, with null) an inventory item's expiry date.
app.post("/inventory/expiry", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	const inventory_id = typeof b.inventory_id === "string" ? b.inventory_id.trim() : "";
	const expiry = typeof b.expiry_date === "string" && b.expiry_date.trim() ? b.expiry_date.trim() : null;
	if (!inventory_id) { res.status(400).json({ error: "inventory_id is required" }); return; }
	try {
		await SetInventoryExpiry(restaurantId, inventory_id, expiry);
		try { await log_audit(req, INV_MANAGE, expiry ? `Set expiry ${expiry}` : "Cleared expiry", Audit_log_category.Inventory, { inventory_id }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (e: any) { logger.error({ err: e }, "set_expiry_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to set expiry") }); }
});
// Set (or clear, with null) ONE item's reorder level. Separate from
// POST /inventory because that route writes "Quantity" from the form: routing a
// threshold edit through it would stamp a stale stock figure over any
// receive/wastage/issue that landed while the dialog was open. Mirrors
// /inventory/expiry, which is separate for exactly the same reason.
app.post("/inventory/reorder-level", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	const inventory_id = typeof b.inventory_id === "string" ? b.inventory_id.trim() : "";
	if (!inventory_id) { res.status(400).json({ error: "inventory_id is required" }); return; }
	const raw = b.reorder_level;
	const level = raw === null || raw === undefined || raw === "" ? null : Number(raw);
	if (level !== null && !(Number.isFinite(level) && level > 0)) {
		res.status(400).json({ error: "reorder_level must be a positive number or null" });
		return;
	}
	const unit = typeof b.reorder_unit === "string" ? b.reorder_unit : undefined;
	try {
		const r = await SetInventoryReorderLevel(restaurantId, inventory_id, level, unit);
		try {
			await log_audit(req, INV_MANAGE, level === null ? "Cleared reorder level" : `Set reorder level ${level} ${r.reorder_unit ?? ""}`.trim(), Audit_log_category.Inventory, { inventory_id });
		} catch {/* ignore */}
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "set_reorder_level_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to set reorder level") }); }
});
app.get("/inventory/movements", validateAction(INV_VIEW), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const from = typeof req.query.from === "string" ? req.query.from : undefined;
	const to = typeof req.query.to === "string" ? req.query.to : undefined;
	try { res.json({ movements: await GetStockMovements(restaurantId, from, to) }); }
	catch (e) { logger.error({ err: e }, "get_movements_failed"); res.status(500).json({ error: "Unable to fetch movements" }); }
});
}


export function registerInventoryDeleteRoute(app: Express): void {

app.delete("/inventory/:id", validateAction("add0a9ec-a563-4903-9a24-d2e0b46361a5"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const rawId = req.params.id;
	const inventoryId = typeof rawId === "string" ? rawId.trim() : "";
	if (!inventoryId) {
		res.status(400).json({ error: "Invalid inventory id" });
		return;
	}

	try {
		const removed = await DeleteInventoryItem(restaurantId, inventoryId);
		if (!removed) {
			res.status(404).json({ error: "Inventory item not found" });
			return;
		}
		res.status(204).send();
	} catch (error) {
		logger.error({ err: error }, "delete_inventory_failed");
		res.status(500).json({ error: "Unable to delete inventory item" });
	}
});
}


export function registerInventoryCategoryRenameRoute(app: Express): void {

// Rename an inventory category: updates the managed list in Restaurant settings
// AND cascades to every inventory item whose category matched the old name (one
// transaction over the items). Mirrors /kitchen-sections/rename.
app.post("/inventory-categories/rename", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const from = typeof req.body?.from === "string" ? req.body.from.trim() : "";
	const to = typeof req.body?.to === "string" ? req.body.to.trim().replace(/\s+/g, " ").slice(0, 40) : "";
	if (!from || !to) { res.status(400).json({ error: "from and to are required" }); return; }
	try {
		// Cascade to inventory items first (transactional), then swap the managed entry.
		const { updated } = await RenameInventoryCategory(restaurantId, from, to);
		const current = await GetRestaurantSettings(restaurantId);
		const had = current.inventory_categories.some((c) => c.toLowerCase() === from.toLowerCase());
		const nextCategories = had
			? current.inventory_categories.map((c) => (c.toLowerCase() === from.toLowerCase() ? to : c))
			: [...current.inventory_categories, to]; // renaming an unmanaged category adopts it
		const saved = await SetRestaurantSettings(restaurantId, { inventory_categories: nextCategories });
		try {
			await log_audit(req, INV_MANAGE, `Renamed inventory category ${from} -> ${to} (${updated} items)`, Audit_log_category.Inventory, {
				from, to, updated_items: updated,
				undo: { kind: "inventory_category_rename", target_id: null, before: { name: from }, after: { name: to } },
			});
		} catch (err) { logger.warn({ err }, "log_audit inventory-category-rename failed"); }
		res.json({ success: true, updated_items: updated, inventory_categories: saved.inventory_categories });
	} catch (error) {
		logger.error({ err: error }, "rename_inventory_category_failed");
		res.status(500).json({ error: "Unable to rename inventory category" });
	}
});
}
