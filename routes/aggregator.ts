/**
 * Third-party aggregator integration: API key issuance and inbound orders.
 */
import type { Express, Request, Response } from "express";
import { AddAggregatorOrder, AddNotification, Audit_log_category, GenerateAggregatorKey, GetRestaurantIdByAggregatorKey, withTenant } from "../database_supabase.js";
import { logger } from "../observability.js";
import { emitRestaurant } from "../realtime.js";
import { enforceAdmin, extractRestaurantId, log_audit, rateLimit, safeClientError, validate } from "./_shared.js";


export function registerAggregatorRoutes(app: Express): void {

// --- Aggregator (Swiggy/Zomato) order intake ---------------------------------
// Mint/rotate the restaurant's intake API key. The key is returned ONCE here
// (stored plain server-side; generating again rotates it).
app.post('/aggregator/generate-key', validate, async (req: Request, res: Response) => {
	if (!(await enforceAdmin(req, res))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const key = await GenerateAggregatorKey(restaurantId);
		try { await log_audit(req, "60d14e9c-45cc-4dc2-b017-56058cc3ae33", `Generated aggregator intake API key`, Audit_log_category.General, {}); } catch {/* ignore */}
		res.json({ key, note: "Shown once — store it with your Swiggy/Zomato middleware. Generating again rotates (invalidates) this key." });
	} catch (e: any) { logger.error({ err: e }, 'aggregator_key_failed'); res.status(500).json({ error: "Unable to generate key" }); }
});

// Public order intake: the per-restaurant key in the body is the auth. Live
// Swiggy/Zomato webhooks require their partner-API onboarding — this endpoint
// is the integration point their middleware posts to.
app.post('/aggregator/order', rateLimit("aggregator", 120, 60_000), async (req: Request, res: Response) => {
	const body = (req.body ?? {}) as Record<string, unknown>;
	const key = typeof body.key === "string" ? body.key.trim() : "";
	if (!key) { res.status(401).json({ error: "Missing aggregator key" }); return; }
	let resId: string | null = null;
	try { resId = await GetRestaurantIdByAggregatorKey(key); } catch { resId = null; }
	if (!resId) { res.status(401).json({ error: "Invalid aggregator key" }); return; }
	const source = body.source === "zomato" ? "zomato" : body.source === "swiggy" ? "swiggy" : null;
	const externalId = typeof body.external_id === "string" || typeof body.external_id === "number" ? String(body.external_id).trim() : "";
	const items = Array.isArray(body.items) ? body.items : [];
	if (!source) { res.status(400).json({ error: "source must be 'swiggy' or 'zomato'" }); return; }
	if (!externalId) { res.status(400).json({ error: "external_id is required" }); return; }
	if (items.length === 0) { res.status(400).json({ error: "At least one item is required" }); return; }
	try {
		const result = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () =>
			AddAggregatorOrder(resId, {
				source,
				external_id: externalId,
				items: items as any,
				customer_name: typeof body.customer_name === "string" ? body.customer_name : undefined,
				customer_phone: typeof body.customer_phone === "string" ? body.customer_phone : undefined,
			}),
		);
		if (!result.deduped) {
			const label = source === "swiggy" ? "Swiggy" : "Zomato";
			try {
				await AddNotification(resId, {
					type: "order",
					title: `New ${label} order`,
					body: `#${externalId} · ${items.length} item${items.length > 1 ? "s" : ""} · ₹${result.total}`,
					meta: { table: result.table, order_id: result.order_id, source },
				});
			} catch {/* ignore */}
			try { emitRestaurant(resId, "order:updated", { table: result.table, source }); } catch {/* ignore */}
		}
		res.status(result.deduped ? 200 : 201).json({ success: true, ...result });
	} catch (e: any) {
		logger.error({ err: e }, 'aggregator_order_failed');
		res.status(400).json({ error: safeClientError(e, "Unable to place aggregator order") });
	}
});
}
