/**
 * Promo codes and gift vouchers.
 */
import type { Express, Request, Response } from "express";
import { Audit_log_category, CreateGiftVoucher, DeleteCoupon, GetCoupons, UpsertCoupon } from "../database_supabase.js";
import { logger } from "../observability.js";
import { PERM_COUPONS, enforcePermission, extractRestaurantId, log_audit, validate } from "./_shared.js";


export function registerCouponRoutes(app: Express): void {

// --- Coupons (admin-managed promo codes) ------------------------------------
app.get('/coupons', validate, async (req: Request, res: Response) => {
	if (!(await enforcePermission(req, res, PERM_COUPONS))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { res.json({ coupons: await GetCoupons(restaurantId) }); }
	catch (e) { logger.error({ err: e }, 'get_coupons_failed'); res.status(500).json({ error: "Unable to fetch coupons" }); }
});

app.post('/coupons', validate, async (req: Request, res: Response) => {
	if (!(await enforcePermission(req, res, PERM_COUPONS))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	try {
		const coupon = await UpsertCoupon(restaurantId, b as any);
		try { await log_audit(req, "60d14e9c-45cc-4dc2-b017-56058cc3ae33", `Saved coupon ${coupon.code}`, Audit_log_category.General, { code: coupon.code }); } catch {/* ignore */}
		res.status(201).json({ coupon });
	} catch (e: any) { logger.error({ err: e }, 'upsert_coupon_failed'); res.status(400).json({ error: String(e?.message ?? "Unable to save coupon") }); }
});

app.delete('/coupons/:id', validate, async (req: Request, res: Response) => {
	if (!(await enforcePermission(req, res, PERM_COUPONS))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	try { await DeleteCoupon(restaurantId, id); res.json({ success: true }); }
	catch (e) { logger.error({ err: e }, 'delete_coupon_failed'); res.status(400).json({ error: "Unable to delete coupon" }); }
});

// Issue a gift voucher (admin). Redemption happens through the normal coupon
// paths (/bills/apply-coupon, /qr/:slug/coupon) — staff just enter the code.
app.post('/vouchers', validate, async (req: Request, res: Response) => {
	if (!(await enforcePermission(req, res, PERM_COUPONS))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const amount = Number(body.amount ?? 0) || 0;
	const code = typeof body.code === "string" ? body.code.trim() : "";
	try {
		const coupon = await CreateGiftVoucher(restaurantId, { code: code || null, amount });
		try { await log_audit(req, "60d14e9c-45cc-4dc2-b017-56058cc3ae33", `Issued gift voucher ${coupon.code} (₹${amount})`, Audit_log_category.General, { code: coupon.code, amount }); } catch {/* ignore */}
		res.status(201).json({ coupon });
	} catch (e: any) { logger.error({ err: e }, 'create_voucher_failed'); res.status(400).json({ error: String(e?.message ?? "Unable to issue voucher") }); }
});
}
