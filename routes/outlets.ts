/**
 * Outlets within a restaurant: listing, CRUD, activation, rollup and default tax.
 */
import type { Express, Request, Response } from "express";
import { AddOutlet, Audit_log_category, DeleteOutlet, GetOutletDefaultTax, GetOutlets, GetOutletsRollup, SetOutletActive, UpdateOutlet, UpdateOutletDefaultTax } from "../database_supabase.js";
import { logger } from "../observability.js";
import { extractRestaurantId, log_audit, validate, validateAction } from "./_shared.js";


// --- Multi-outlet management -------------------------------------------------
const OUTLET_ADMIN_PERM = "60d14e9c-45cc-4dc2-b017-56058cc3ae33"; // restaurant-settings permission

export function registerOutletRoutes(app: Express): void {

// List a restaurant's outlets (any authed user — used by the outlet switcher).
app.get("/outlets", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	// Echo the aggregate-read mode + the concrete outlet the connection is bound to,
	// so the UI can confirm whether "all outlets" took effect for this request.
	const isAll = req.auth?.allOutlets === true;
	try { res.json({ outlets: await GetOutlets(restaurantId), is_all: isAll, current_outlet_id: req.auth?.outlet_id ?? null }); }
	catch (e) { logger.error({ err: e }, "get_outlets_failed"); res.status(500).json({ error: "Unable to fetch outlets" }); }
});

// Cross-outlet rollup (central owner view): revenue + orders per branch.
app.get("/outlets/rollup", validateAction(OUTLET_ADMIN_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const daysRaw = typeof req.query.days === "string" ? Number.parseInt(req.query.days, 10) : 30;
	try { res.json(await GetOutletsRollup(restaurantId, Number.isFinite(daysRaw) ? daysRaw : 30)); }
	catch (e) { logger.error({ err: e }, "outlets_rollup_failed"); res.status(500).json({ error: "Unable to build rollup" }); }
});

app.post("/outlets", validateAction(OUTLET_ADMIN_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	// Additive plan gate: only blocks adding outlets when the plan explicitly says so.
	if (req.auth?.features?.multi_outlet === false) { res.status(403).json({ error: "Your plan does not include multiple outlets.", feature: "multi_outlet" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (!name) { res.status(400).json({ error: "Outlet name is required" }); return; }
	// Enforce the subscribed plan's outlet limit, when it defines one (fail-open).
	const outletLimit = Number(req.auth?.limits?.outlets ?? 0);
	if (outletLimit > 0) {
		try {
			const existing = await GetOutlets(restaurantId);
			if ((existing?.length ?? 0) >= outletLimit) {
				res.status(403).json({ error: `Your plan allows up to ${outletLimit} outlet(s). Upgrade to add more.` });
				return;
			}
		} catch (e) { logger.warn({ err: e }, "outlet_limit_check_failed"); }
	}
	try {
		const created = await AddOutlet(restaurantId, {
			name,
			address: typeof body.address === "string" ? body.address : undefined,
			phone: typeof body.phone === "string" ? body.phone : undefined,
			hours: typeof body.hours === "string" ? body.hours : undefined,
		});
		try { await log_audit(req, OUTLET_ADMIN_PERM, `Added outlet ${name}`, Audit_log_category.Bill, { id: created.id }); } catch {/* ignore */}
		res.json(created);
	} catch (e: any) { logger.error({ err: e }, "add_outlet_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to add outlet") }); }
});

app.put("/outlets/:id", validateAction(OUTLET_ADMIN_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!id) { res.status(400).json({ error: "Missing id" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	try {
		await UpdateOutlet(restaurantId, id, {
			name: typeof body.name === "string" ? body.name : undefined,
			address: typeof body.address === "string" ? body.address : undefined,
			phone: typeof body.phone === "string" ? body.phone : undefined,
			hours: typeof body.hours === "string" ? body.hours : undefined,
		});
		res.json({ success: true });
	} catch (e: any) { logger.error({ err: e }, "update_outlet_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to update outlet") }); }
});

app.post("/outlets/:id/active", validateAction(OUTLET_ADMIN_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	const active = ((req.body ?? {}) as Record<string, unknown>).active !== false;
	try { await SetOutletActive(restaurantId, id, active); res.json({ success: true }); }
	catch (e: any) { logger.error({ err: e }, "set_outlet_active_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to update outlet") }); }
});

app.delete("/outlets/:id", validateAction(OUTLET_ADMIN_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	try {
		await DeleteOutlet(restaurantId, id);
		try { await log_audit(req, OUTLET_ADMIN_PERM, `Deleted outlet ${id}`, Audit_log_category.Bill, { id }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (e: any) { logger.error({ err: e }, "delete_outlet_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to delete outlet") }); }
});

app.get('/outlets/default-tax', validateAction("d9b3f882-d3cf-46bc-b9ce-4218e8a5c29d"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: 'Missing restaurantId' });
		return;
	}

	try {
		const tax = await GetOutletDefaultTax(restaurantId);
		res.json({ default_tax: tax ?? {} });
	} catch (err) {
		logger.error({ err }, 'get_default_tax_failed');
		res.status(500).json({ error: 'Unable to fetch default tax' });
	}
});

app.patch('/outlets/default-tax', validateAction("28fa21cc-0dba-4a0f-bf6f-387089f47bbf"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: 'Missing restaurantId' });
		return;
	}

	const body = req.body ?? {};
	const defaultTax = body.default_tax;
	if (!defaultTax || typeof defaultTax !== 'object') {
		res.status(400).json({ error: 'default_tax object is required' });
		return;
	}

	try {
		await UpdateOutletDefaultTax(restaurantId, defaultTax);
		res.json({ ok: true });
	} catch (err) {
		logger.error({ err }, 'update_default_tax_failed');
		res.status(500).json({ error: 'Unable to update default tax' });
	}
});
}
