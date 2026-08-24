/**
 * What-if simulator: a live 30-day baseline plus a slider-driven projection of
 * covers / APC / revenue / costs / TAT. All model arithmetic lives in the pure
 * simulation_math.ts; this module only authenticates, fetches the raw tenant
 * aggregates, and shapes the response.
 */
import type { Express, Request, Response } from "express";
import { GetSimulationRawStats } from "../database_supabase.js";
import { logger } from "../observability.js";
import { buildBaseline, runSimulation, type SimulationParams } from "../simulation_math.js";
import { extractRestaurantId, validateAction } from "./_shared.js";

// Same ANALYTICS action id as every /analytics/* route, so the existing RBAC
// roles that can see analytics can run simulations with no permission changes.
const ANALYTICS_ACTION = "df75119b-e5f1-4f38-aba5-78a1cf182f56";

export function registerSimulationRoutes(app: Express): void {

// Live baseline over the last 30 days. Every number is finite; fields the tenant
// has no data for carry sources.<field> === "default" so the UI can tag them
// "estimated". ₹ figures are PRE-TAX (bill subtotal basis, same as APC).
app.get("/simulation/baseline", validateAction(ANALYTICS_ACTION), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const baseline = buildBaseline(await GetSimulationRawStats(restaurantId));
		res.json(baseline);
	} catch (error) {
		logger.error({ err: error }, "get_simulation_baseline_failed");
		res.status(500).json({ error: "Unable to compute simulation baseline" });
	}
});

// Run one what-if projection against the live baseline. Out-of-range parameters
// are CLAMPED into their legal slider ranges (never 400): the sliders cannot
// send illegal values, and a curl caller gets the nearest legal simulation.
app.post("/simulation/run", validateAction(ANALYTICS_ACTION), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	// Non-object bodies (arrays, strings, null) are treated as "no sliders moved".
	const body = (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {}) as SimulationParams;
	try {
		const baseline = buildBaseline(await GetSimulationRawStats(restaurantId));
		res.json(runSimulation(baseline, body));
	} catch (error) {
		logger.error({ err: error }, "run_simulation_failed");
		res.status(500).json({ error: "Unable to run simulation" });
	}
});

}
