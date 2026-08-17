/**
 * Customer loyalty balances and point redemption.
 */
import type { Express, Request, Response } from "express";
import { Audit_log_category, GetLoyaltyAccount, LOYALTY_REDEEM_ACTION_ID, RedeemLoyaltyPoints } from "../database_supabase.js";
import { logger } from "../observability.js";
import { emitRestaurant } from "../realtime.js";
import { extractRestaurantId, log_audit, validate, validateAction } from "./_shared.js";


export function registerLoyaltyRoutes(app: Express): void {

// --- Loyalty points (earn on settle, redeem at billing) ----------------------
// Balance + history for a customer phone (any logged-in staff member).
app.get('/loyalty/:phone', validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const phone = typeof req.params.phone === "string" ? req.params.phone.trim() : "";
	if (!phone) { res.status(400).json({ error: "phone is required" }); return; }
	try { res.json(await GetLoyaltyAccount(restaurantId, phone)); }
	catch (e: any) { logger.error({ err: e }, 'get_loyalty_failed'); res.status(400).json({ error: String(e?.message ?? "Unable to load loyalty account") }); }
});

// Redeem points against a table's open bill (points × point_value → flat
// discount through the standard bill-discount path). Same permission as the
// other bill operations (order action).
app.post('/loyalty/redeem', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const phone = typeof body.phone === "string" ? body.phone.trim() : "";
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const points = Number(body.points ?? 0) || 0;
	if (!phone || !tableName) { res.status(400).json({ error: "phone and table_name are required" }); return; }
	try {
		const result = await RedeemLoyaltyPoints(restaurantId, { phone, points, table_name: tableName });
		try { emitRestaurant(restaurantId, "bill:updated", { table: tableName }); } catch {/* ignore */}
		try { await log_audit(req, LOYALTY_REDEEM_ACTION_ID, `Redeemed ${result.points} loyalty points (₹${result.discount}) on table ${tableName}`, Audit_log_category.Bill, { table: tableName, phone, points: result.points, discount: result.discount }); } catch {/* ignore */}
		res.json(result);
	} catch (e: any) { logger.error({ err: e }, 'loyalty_redeem_failed'); res.status(400).json({ error: String(e?.message ?? "Unable to redeem points") }); }
});
}
