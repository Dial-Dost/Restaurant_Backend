/**
 * Menu items, categories, costing, images, bulk replace, price edits and kitchen
 * section renames.
 */
import type { Express, Request, Response } from "express";
import type { MenuModifierGroup, RecipeItem } from "../database_supabase.js";
import { Audit_log_category, DeleteMenuCategory, EnsureMenuCategory, GetMenuCategories, GetMenuCosting, GetMenuItemUndoState, GetMenuItems, GetRestaurantSettings, MenuBulkDeleteError, RenameMenuStation, SaveMenuItems, SetRestaurantSettings, UpdateMenuItemPrice, UpsertMenuItem } from "../database_supabase.js";
import { logger } from "../observability.js";
import { uploadMenuImage } from "../storage_bucket_supabase.js";
import { PERM_MENU_BULK_REPLACE, PERM_MENU_CAT_DELETE, extractRestaurantId, log_audit, validateAction } from "./_shared.js";


export function registerMenuRoutes(app: Express): void {

app.get("/menu", validateAction("f4177b38-77fa-4d8c-9fbd-c4f06bf28610"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	try {
		const items = await GetMenuItems(restaurantId);
		res.json(items);
	} catch (error) {
		logger.error({ err: error }, "get_menu_failed");
		res.status(500).json({ error: "Unable to fetch menu" });
	}
});

// Theoretical food cost + margin per dish, from Menu.description.recipe[] and
// the latest recorded purchase unit costs.
app.get("/menu/costing", validateAction("f4177b38-77fa-4d8c-9fbd-c4f06bf28610"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { res.json(await GetMenuCosting(restaurantId)); }
	catch (e) { logger.error({ err: e }, "get_menu_costing_failed"); res.status(500).json({ error: "Unable to compute menu costing" }); }
});

app.get("/menu/categories", validateAction("f4177b38-77fa-4d8c-9fbd-c4f06bf28610"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	try {
		const categories = await GetMenuCategories(restaurantId);
		res.json(categories);
	} catch (error) {
		logger.error({ err: error }, "get_menu_categories_failed");
		res.status(500).json({ error: "Unable to fetch menu categories" });
	}
});

app.post("/menu", validateAction("88a87943-8f0b-43e2-b85e-192fdc901ed2"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = (req.body ?? {}) as Record<string, unknown>;
	if (typeof body.name !== "string" || typeof body.category !== "string") {
		res.status(400).json({ error: "name and category are required" });
		return;
	}
	// Same rule PATCH /menu/:id/price enforces: a menu price must be a positive
	// finite number. This route always WRITES price (UpsertMenuItem has no
	// "preserve" path for it), so an omitted / zero / negative / non-numeric price
	// silently stored a ₹0 dish — free food that also poisons the order-path
	// re-pricing floor. Rejecting the write leaves the existing row untouched.
	const price = Number(body.price ?? NaN);
	if (!Number.isFinite(price) || price <= 0) {
		res.status(400).json({ error: "price must be a positive number" });
		return;
	}

	try {
		// Snapshot the item BEFORE the upsert so an availability-only toggle can be
		// recorded as undoable (see UNDO_REGISTRY.menu_availability).
		const priorItem = typeof body.id === "string" && body.id
			? await GetMenuItemUndoState(restaurantId, body.id).catch(() => null)
			: null;
		// Fields absent from the request stay `undefined` so UpsertMenuItem
		// preserves the stored value (partial saves must not wipe recipes etc.).
		const result = await UpsertMenuItem(restaurantId, {
			id: typeof body.id === "string" ? body.id : "",
			name: body.name,
			price,
			category: body.category,
			image_url: typeof body.image_url === "string" ? body.image_url : body.image_url === null ? null : undefined,
			available: typeof body.available === "boolean" ? body.available : undefined,
			modifiers: Array.isArray(body.modifiers) ? (body.modifiers as MenuModifierGroup[]) : undefined,
			recipe: Array.isArray(body.recipe) ? (body.recipe as RecipeItem[]) : undefined,
			station: typeof body.station === "string" ? body.station : body.station === null ? null : undefined,
			allergens: Array.isArray(body.allergens) ? (body.allergens as string[]) : undefined,
			// Guest-facing dish description (sanitized in encodeMenuDescription).
			// Absent = keep the stored text; "" / null = clear it.
			blurb: typeof body.blurb === "string" ? body.blurb : body.blurb === null ? null : undefined,
		});
		try {
			// Only an availability-ONLY change is undoable: this route is a general
			// upsert, and reversing just the flag after a broader edit would leave a
			// half-restored item. Anything else records no undo envelope (default deny).
			const nextItem = typeof body.available === "boolean" && priorItem
				? await GetMenuItemUndoState(restaurantId, result.id).catch(() => null)
				: null;
			const availabilityOnly = Boolean(
				priorItem && nextItem
				&& priorItem.available !== nextItem.available
				&& priorItem.name === nextItem.name
				&& priorItem.price === nextItem.price,
			);
			await log_audit(req, "88a87943-8f0b-43e2-b85e-192fdc901ed2", `Saved menu item ${body.name}`, Audit_log_category.Menu, {
				id: result.id,
				available: body.available,
				...(availabilityOnly
					? { undo: { kind: "menu_availability", target_id: result.id, before: { available: priorItem!.available }, after: { available: nextItem!.available } } }
					: {}),
			});
		} catch (err) { logger.warn({ err }, "log_audit menu-upsert failed"); }
		res.status(201).json(result);
	} catch (error) {
		logger.error({ err: error }, "upsert_menu_item_failed");
		res.status(500).json({ error: "Unable to save menu item" });
	}
});

app.post("/menu/upload-image", validateAction("88a87943-8f0b-43e2-b85e-192fdc901ed2"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const b64 = typeof body.image_base64 === "string" ? body.image_base64 : "";
	const ct = typeof body.content_type === "string" ? body.content_type : "image/jpeg";
	if (!b64) { res.status(400).json({ error: "image_base64 is required" }); return; }
	try {
		const url = await uploadMenuImage(b64, ct);
		if (!url) { res.status(502).json({ error: "Image upload failed (storage not configured)" }); return; }
		res.json({ image_url: url });
	} catch (err: any) {
		logger.error({ err }, "menu_upload_image_failed");
		res.status(500).json({ error: "Unable to upload image" });
	}
});
}


export function registerMenuAdminRoutes(app: Express): void {

app.put("/menu", validateAction(PERM_MENU_BULK_REPLACE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const items = Array.isArray(req.body?.items) ? req.body.items : null;
	if (!items) {
		res.status(400).json({ error: "items array is required" });
		return;
	}

	try {
		// Fields absent from the request stay `undefined` so UpsertMenuItem
		// preserves the stored value (bulk reorders must not wipe recipes etc.).
		// A full-menu save prunes anything missing from the payload — the exact
		// mechanism that once destroyed 56 items' images/recipes. SaveMenuItems now
		// refuses to prune more than a couple of items unless the caller explicitly
		// opts in here, so a stale or partially-loaded list can no longer wipe the menu.
		const allowBulkDelete = req.body?.allow_bulk_delete === true;
		await SaveMenuItems(
			restaurantId,
			items.map((item: any) => ({
				id: String(item.id ?? ""),
				name: String(item.name ?? ""),
				price: Number(item.price ?? 0),
				category: String(item.category ?? "General"),
				image_url: typeof item.image_url === "string" ? item.image_url : item.image_url === null ? null : undefined,
				available: typeof item.available === "boolean" ? item.available : undefined,
				modifiers: Array.isArray(item.modifiers) ? item.modifiers : undefined,
				recipe: Array.isArray(item.recipe) ? item.recipe : undefined,
				station: typeof item.station === "string" ? item.station : item.station === null ? null : undefined,
				allergens: Array.isArray(item.allergens) ? item.allergens : undefined,
				// Guest-facing dish description — absent keeps the stored text, so a
				// bulk save from a client that doesn't know the field can't wipe it.
				blurb: typeof item.blurb === "string" ? item.blurb : item.blurb === null ? null : undefined,
			})),
			{ allowBulkDelete },
		);
		try {
			await log_audit(req, "ed800655-b937-44ba-a7ca-7458295886c9", `Saved menu (${items.length} items)`, Audit_log_category.Menu, { count: items.length });
		} catch (err) { logger.warn({ err }, "log_audit menu-save failed"); }
		res.json({ success: true });
	} catch (error) {
		logger.error({ err: error }, "save_menu_failed");
		// The bulk-delete guard is a deliberate refusal, not a server fault.
		if (error instanceof MenuBulkDeleteError) {
			res.status(409).json({
				error: error.message,
				stored: error.stored,
				kept: error.kept,
				would_delete: error.wouldDelete,
			});
			return;
		}
		res.status(500).json({ error: "Unable to save menu" });
	}
});

// Update ONLY a menu item's price (the menu-insights "apply suggestion" flow).
// Same Edit Menu gate as PUT /menu, but never touches any other field of the
// item — clients applying a price suggestion MUST use this, not PUT /menu.
app.patch("/menu/:id/price", validateAction("ed800655-b937-44ba-a7ca-7458295886c9"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}
	const itemId = typeof req.params.id === "string" ? req.params.id.trim() : "";
	const price = Number((req.body ?? {}).price ?? NaN);
	if (!itemId) {
		res.status(400).json({ error: "Missing menu item id" });
		return;
	}
	if (!Number.isFinite(price) || price <= 0) {
		res.status(400).json({ error: "price must be a positive number" });
		return;
	}
	try {
		const result = await UpdateMenuItemPrice(restaurantId, itemId, price);
		try {
			// `undo` carries the prior price triple so the audit entry is reversible
			// (see UNDO_REGISTRY.menu_price). The human `reason` is unchanged.
			await log_audit(req, "ed800655-b937-44ba-a7ca-7458295886c9", `Updated price of ${result.name} to ${result.price}`, Audit_log_category.Menu, {
				id: result.id,
				price: result.price,
				undo: { kind: "menu_price", target_id: result.id, before: result.previous, after: { price: result.price } },
			});
		} catch (err) { logger.warn({ err }, "log_audit menu-price failed"); }
		res.json({ success: true, ...result });
	} catch (error: any) {
		logger.error({ err: error }, "update_menu_price_failed");
		const msg = String(error?.message ?? "Unable to update price");
		res.status(/not found/i.test(msg) ? 404 : 400).json({ error: msg });
	}
});

app.post("/menu/categories", validateAction("88a87943-8f0b-43e2-b85e-192fdc901ed2"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const category = typeof req.body?.category === "string" ? req.body.category.trim() : "";
	if (!category) {
		res.status(400).json({ error: "category is required" });
		return;
	}

	try {
		await EnsureMenuCategory(restaurantId, category);
		try { await log_audit(req, "88a87943-8f0b-43e2-b85e-192fdc901ed2", `Added menu category ${category}`, Audit_log_category.Menu, { category }); } catch (err) { logger.warn({ err }, "log_audit add-category failed"); }
		res.status(201).json({ success: true });
	} catch (error) {
		logger.error({ err: error }, "ensure_menu_category_failed");
		res.status(500).json({ error: "Unable to save category" });
	}
});

app.delete("/menu/categories", validateAction(PERM_MENU_CAT_DELETE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const categoryRaw = typeof req.query?.category === "string"
		? req.query.category
		: typeof req.body?.category === "string"
			? req.body.category
			: "";
	const category = categoryRaw.trim();
	if (!category) {
		res.status(400).json({ error: "category is required" });
		return;
	}

	try {
		const result = await DeleteMenuCategory(restaurantId, category);
		try { await log_audit(req, "ed800655-b937-44ba-a7ca-7458295886c9", `Deleted menu category ${category}`, Audit_log_category.Menu, { category, deletedItems: result.deletedItems }); } catch (err) { logger.warn({ err }, "log_audit delete-category failed"); }
		res.json({ success: true, deletedItems: result.deletedItems });
	} catch (error) {
		logger.error({ err: error }, "delete_menu_category_failed");
		res.status(500).json({ error: "Unable to delete category" });
	}
});

// Rename a kitchen section: updates the managed list in Restaurant settings AND
// cascades to every menu item whose station matched the old name (one
// transaction over the items), so tickets/KDS immediately reflect the new name.
app.post("/kitchen-sections/rename", validateAction("ed800655-b937-44ba-a7ca-7458295886c9"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const from = typeof req.body?.from === "string" ? req.body.from.trim() : "";
	const to = typeof req.body?.to === "string" ? req.body.to.trim().replace(/\s+/g, " ").slice(0, 32) : "";
	if (!from || !to) { res.status(400).json({ error: "from and to are required" }); return; }
	try {
		// Cascade to menu items first (transactional), then swap the managed entry.
		const { updated } = await RenameMenuStation(restaurantId, from, to);
		const current = await GetRestaurantSettings(restaurantId);
		const had = current.kitchen_sections.some((s) => s.toLowerCase() === from.toLowerCase());
		const nextSections = had
			? current.kitchen_sections.map((s) => (s.toLowerCase() === from.toLowerCase() ? to : s))
			: [...current.kitchen_sections, to]; // renaming an unmanaged station adopts it
		const saved = await SetRestaurantSettings(restaurantId, { kitchen_sections: nextSections });
		try {
			await log_audit(req, "ed800655-b937-44ba-a7ca-7458295886c9", `Renamed kitchen section ${from} -> ${to} (${updated} items)`, Audit_log_category.Menu, {
				from, to, updated_items: updated,
				undo: { kind: "kitchen_section_rename", target_id: null, before: { name: from }, after: { name: to } },
			});
		} catch (err) { logger.warn({ err }, "log_audit kitchen-section-rename failed"); }
		res.json({ success: true, updated_items: updated, kitchen_sections: saved.kitchen_sections });
	} catch (error) {
		logger.error({ err: error }, "rename_kitchen_section_failed");
		res.status(500).json({ error: "Unable to rename kitchen section" });
	}
});
}
