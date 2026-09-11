/**
 * Customer loyalty balances and point redemption.
 *
 * ============================================================================
 * BOTH ROUTES IN THIS FILE WERE OPEN, IN TWO DIFFERENT WAYS
 * ============================================================================
 * POST /loyalty/redeem performs the SAME write as POST /bills/discount and
 * POST /bills/apply-coupon — `applyDiscountToOpenBill(…, "flat", …)` — on the
 * SAME 4ad474d4 "Add Orders" permission the core waiter role holds, and it was
 * the only one of the three with no write-off gate and no post-settle lock. Its
 * single clamp was `if (discount > subtotal) throw`, so a redemption EXACTLY
 * EQUAL to the subtotal took the bill to zero BY DESIGN. That is not a
 * theoretical default either: "Restaurant".loyalty_point_value DEFAULTS TO 1, so
 * redemption is ON for every tenant that has never opened the settings page.
 * Both fixes live in RedeemLoyaltyPoints, inside its transaction where the
 * subtotal is read; this file's job is to hand the gate the caller's identity
 * and to turn the two refusals into 403s WITH A BODY.
 *
 * GET /loyalty/:phone was gated on `validate`, which is the no-op `next()` in
 * _shared.ts — every authenticated session, including one with zero granted
 * actions, could read any phone number's balance and its 50-row history. A
 * points balance is customer data and a history is a customer profile, so it is
 * now gated on a REAL capability: see the note above the routes for which id,
 * and why that one rather than a stricter-sounding alternative.
 */
import type { Express, Request, Response } from "express";
import { Audit_log_category, GetLoyaltyAccount, LOYALTY_REDEEM_ACTION_ID, RedeemLoyaltyPoints, isLoyaltyAccountMismatchError } from "../database_supabase.js";
import { isDiscountAuthorityError } from "../discount_authority.js";
import { logger } from "../observability.js";
import { emitRestaurant } from "../realtime.js";
import { PERM_CLOSE_BILL, callerIsAdmin, extractRestaurantId, log_audit, validateAction } from "./_shared.js";

/**
 * "ADD ORDERS" (4ad474d4-5230-449c-874f-6a238b833bca) — THE PERMISSION BOTH
 * ROUTES BELOW ARE GATED ON. It is written out as a literal at each gate rather
 * than through a named constant, because the route manifest records the guard
 * chain AS WRITTEN, so a named constant would appear in the golden file as
 * validateAction(SOME_NAME) and hide WHICH permission gates the route from the
 * reviewer diffing it.
 *
 * WHY THIS ID FOR THE READ. The staff who legitimately look a balance up are the
 * staff who are about to spend it: the waiter at the table and the person at the
 * till, and this is the id all of waiter, captain, cashier and manager hold in
 * CORE_ROLES today (admin passes on "*"). Gating the read on the id that already
 * gates the WRITE it feeds means nobody who can redeem loses the lookup —
 * "you may see the balance you may spend" — while the session with no granted
 * actions at all, which is what `validate` was letting through, is refused.
 *
 * WHY NOT THE STRICTER-SOUNDING IDS. 3c530903 "Get Customers" is the CRM read
 * permission and looks like the obvious fit, but no core floor or till role
 * holds it — gating on it would 403 the cashier looking up a regular's points at
 * the counter, which is the one thing this endpoint exists for. 98b10bde "View
 * Bill" has the same defect from the other end: CORE_ROLES.cashier does not hold
 * it either (a pre-existing gap in that role). PERM_CLOSE_BILL would refuse the
 * waiter who has to answer "how many points do I have?" at the table.
 *
 * NO NEW ACTION ID IS MINTED for the read (migration 025's rule) — a fresh
 * "View Loyalty" uuid would be held by NOBODY on the day it deployed and would
 * take the feature away from every tenant until someone edited every role.
 */

export function registerLoyaltyRoutes(app: Express): void {

// --- Loyalty points (earn on settle, redeem at billing) ----------------------
// Balance + history for a customer phone. Gated on "Add Orders" (see above): it was
// `validate`, the no-op, and a 50-row customer history behind a no-op is an
// unauthenticated-in-all-but-name read of somebody's spending pattern.
app.get('/loyalty/:phone', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const phone = typeof req.params.phone === "string" ? req.params.phone.trim() : "";
	if (!phone) { res.status(400).json({ error: "phone is required" }); return; }
	try { res.json(await GetLoyaltyAccount(restaurantId, phone)); }
	catch (e: any) { logger.error({ err: e }, 'get_loyalty_failed'); res.status(400).json({ error: String(e?.message ?? "Unable to load loyalty account") }); }
});

// Redeem points against a table's open bill (points × point_value → flat
// discount through the standard bill-discount path). Same permission as the
// other bill operations (order action) — and, because it reaches the same write,
// the same WRITE-OFF GATE: a redemption that hands back most of the bill needs
// PERM_CLOSE_BILL, exactly as the manual discount and the coupon do.
app.post('/loyalty/redeem', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const phone = typeof body.phone === "string" ? body.phone.trim() : "";
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const points = Number(body.points ?? 0) || 0;
	if (!phone || !tableName) { res.status(400).json({ error: "phone and table_name are required" }); return; }
	try {
		const result = await RedeemLoyaltyPoints(restaurantId, {
			phone, points, table_name: tableName,
			// THE SAME GATE INPUTS AS /bills/discount AND /bills/apply-coupon. The
			// actions come from the VERIFIED session, never from the body, and
			// PERM_CLOSE_BILL is the id enforceSettleAuthority and the release gate
			// already check — never a new one.
			isAdmin: callerIsAdmin(req),
			actions: req.auth?.actions ?? [],
			closeBillPermission: PERM_CLOSE_BILL,
		});
		try { emitRestaurant(restaurantId, "bill:updated", { table: tableName }); } catch {/* ignore */}
		try { await log_audit(req, LOYALTY_REDEEM_ACTION_ID, `Redeemed ${result.points} loyalty points (₹${result.discount}) on table ${tableName}`, Audit_log_category.Bill, { table: tableName, phone, points: result.points, discount: result.discount }); } catch {/* ignore */}
		res.json(result);
	} catch (e: any) {
		// A REFUSED WRITE-OFF IS A 403 WITH A BODY AND AN AUDIT ROW — the same
		// shape /bills/discount and /bills/apply-coupon return, because a client
		// that has to handle three shapes of one refusal handles none of them.
		// `details` carries the rupee figures for the waiter standing at the table;
		// `requiredPermission` is the checkbox an owner ticks. The audit write is
		// best-effort so a failed log cannot turn a 403 into a 500.
		if (isDiscountAuthorityError(e)) {
			try {
				await log_audit(
					req, LOYALTY_REDEEM_ACTION_ID,
					`REFUSED redemption of ${points} loyalty points on table ${tableName} — would have written off ${e.discount_amount.toFixed(2)}, leaving ${e.remaining_value.toFixed(2)}, without Close Bill`,
					Audit_log_category.Bill,
					{ table: tableName, phone, points, refused: true, discount_amount: e.discount_amount, remaining_value: e.remaining_value },
				);
			} catch (err) { logger.warn({ err }, 'log_audit loyalty refusal failed'); }
			res.status(403).json({
				error: "Forbidden",
				details: e.details,
				requiredPermission: e.requiredPermission,
				discount_amount: e.discount_amount,
				remaining_value: e.remaining_value,
			});
			return;
		}
		// Spending one guest's points against another guest's table. Audited for
		// the same reason: the attempt is exactly what a manager wants to see.
		if (isLoyaltyAccountMismatchError(e)) {
			try {
				await log_audit(
					req, LOYALTY_REDEEM_ACTION_ID,
					`REFUSED redemption of ${points} points from ${phone} on table ${tableName} — the table's session is running under a different customer`,
					Audit_log_category.Bill,
					{ table: tableName, phone, points, refused: true, reason: "account_table_mismatch" },
				);
			} catch (err) { logger.warn({ err }, 'log_audit loyalty mismatch failed'); }
			res.status(403).json({ error: "Forbidden", details: e.details, requiredPermission: e.requiredPermission });
			return;
		}
		logger.error({ err: e }, 'loyalty_redeem_failed');
		res.status(400).json({ error: String(e?.message ?? "Unable to redeem points") });
	}
});
}
