/**
 * Vendor master data used by purchasing and inventory receipts.
 */
import type { Express, Request, Response } from "express";
import { AddVendor, DeleteVendor, GetVendors, UpdateVendor } from "../database_supabase.js";
import { logger } from "../observability.js";
import { INV_MANAGE, INV_VIEW, extractRestaurantId, validateAction } from "./_shared.js";


export function registerVendorRoutes(app: Express): void {

app.get("/vendors", validateAction(INV_VIEW), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { res.json({ vendors: await GetVendors(restaurantId) }); }
	catch (e) { logger.error({ err: e }, "get_vendors_failed"); res.status(500).json({ error: "Unable to fetch vendors" }); }
});
app.post("/vendors", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	const name = typeof b.name === "string" ? b.name.trim() : "";
	if (!name) { res.status(400).json({ error: "Vendor name is required" }); return; }
	try { res.status(201).json(await AddVendor(restaurantId, { name, phone: typeof b.phone === "string" ? b.phone : undefined, email: typeof b.email === "string" ? b.email : undefined, notes: typeof b.notes === "string" ? b.notes : undefined })); }
	catch (e: any) { logger.error({ err: e }, "add_vendor_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to add vendor") }); }
});
app.put("/vendors/:id", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	const b = (req.body ?? {}) as Record<string, unknown>;
	try { await UpdateVendor(restaurantId, id, { name: typeof b.name === "string" ? b.name : undefined, phone: typeof b.phone === "string" ? b.phone : undefined, email: typeof b.email === "string" ? b.email : undefined, notes: typeof b.notes === "string" ? b.notes : undefined }); res.json({ success: true }); }
	catch (e: any) { logger.error({ err: e }, "update_vendor_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to update vendor") }); }
});
app.delete("/vendors/:id", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	try { await DeleteVendor(restaurantId, id); res.json({ success: true }); }
	catch (e) { logger.error({ err: e }, "delete_vendor_failed"); res.status(400).json({ error: "Unable to delete vendor" }); }
});
}
