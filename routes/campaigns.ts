/**
 * Marketing campaigns attached to customer segments.
 */
import type { Express, Request, Response } from "express";
import { Audit_log_category, CreateCampaign, DeleteCampaign } from "../database_supabase.js";
import { PERM_CAMPAIGNS, enforcePermission, log_audit } from "./_shared.js";


export function registerCampaignRoutes(app: Express): void {

// Marketing campaigns (admin): create/delete; ROI is computed by /analytics/advanced.
app.post("/campaigns", async (req: Request, res: Response) => {
	const auth = await enforcePermission(req, res, PERM_CAMPAIGNS);
	if (!auth) {return;}
	const b = (req.body ?? {}) as Record<string, unknown>;
	try {
		const campaign = await CreateCampaign(auth.restaurantId, {
			name: typeof b.name === "string" ? b.name : "",
			cost: Number(b.cost ?? 0) || 0,
			starts_at: typeof b.starts_at === "string" ? b.starts_at : "",
			ends_at: typeof b.ends_at === "string" ? b.ends_at : "",
			notes: typeof b.notes === "string" ? b.notes : undefined,
		});
		try { await log_audit(req, "df75119b-e5f1-4f38-aba5-78a1cf182f56", `Created campaign ${campaign.name}`, Audit_log_category.General, { id: campaign.id }); } catch {/* ignore */}
		res.status(201).json(campaign);
	} catch (e: any) { res.status(400).json({ error: String(e?.message ?? "Unable to create campaign") }); }
});

app.delete("/campaigns/:id", async (req: Request, res: Response) => {
	const auth = await enforcePermission(req, res, PERM_CAMPAIGNS);
	if (!auth) {return;}
	try {
		await DeleteCampaign(auth.restaurantId, String(req.params.id));
		try { await log_audit(req, "df75119b-e5f1-4f38-aba5-78a1cf182f56", `Deleted campaign ${req.params.id}`, Audit_log_category.General, { id: req.params.id }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (e: any) { res.status(400).json({ error: String(e?.message ?? "Unable to delete campaign") }); }
});
}
