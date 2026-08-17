/**
 * Kitchen display system: the expo view.
 */
import type { Express, Request, Response } from "express";
import { GetExpoView } from "../database_supabase.js";
import { logger } from "../observability.js";
import { extractRestaurantId, validateAction } from "./_shared.js";


export function registerKdsRoutes(app: Express): void {

// Expo/pass screen: per-table ready-vs-pending consolidation across all active
// orders (read-only; same permission as viewing orders).
app.get("/kds/expo", validateAction("b7f78d0f-323d-4622-8d05-aa2f82d54b2e"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { res.json(await GetExpoView(restaurantId)); }
	catch (err) { logger.error({ err }, "kds_expo_failed"); res.status(500).json({ error: "Unable to load expo view" }); }
});
}
