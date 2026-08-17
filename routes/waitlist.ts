/**
 * Staff-side walk-in queue: calling, seating and the held pre-order decisions.
 */
import type { Express, Request, Response } from "express";
import { Audit_log_category, CallWaitlistEntry, CancelWaitlistEntry, ConfirmWaitlistPreorder, DeclineWaitlistPreorder, GetPendingPreorders, GetPushSubscriptionsForWaitlist, GetWaitlist, RecordPushResult, SeatWaitlistEntry } from "../database_supabase.js";
import { logger } from "../observability.js";
import { emitRestaurant } from "../realtime.js";
import { isPushConfigured, sendPush } from "../web_push.js";
import type { CreatedOrderInfo } from "./_shared.js";
import { emitOrderCreated, extractEmployeeId, extractRestaurantId, log_audit, notifyOrderCreated, validateAction } from "./_shared.js";


// --- Waitlist / queue (staff) ---
const WAITLIST_PERM = "090ea8d4-e348-4e1b-9723-11131a73a085"; // front-of-house (tables/occupy)

/**
 * Push the queue message to every browser the party subscribed from. Fire-and-
 * forget and fully swallowed: a push outage must never fail a call/seat, exactly
 * like AddNotification. Dead endpoints (404/410) are pruned as we go.
 */
async function pushWaitlistUpdate(
	restaurantId: string,
	waitlistId: string,
	payload: { title: string; body: string; url?: string; tag?: string; data?: Record<string, unknown> },
): Promise<void> {
	try {
		if (!isPushConfigured()) {return;}
		const subs = await GetPushSubscriptionsForWaitlist(restaurantId, waitlistId);
		for (const s of subs) {
			const outcome = await sendPush({ id: s.id, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, payload);
			if (outcome === "disabled") {continue;}
			try { await RecordPushResult(restaurantId, s.id, outcome); } catch {/* ignore */}
		}
	} catch (err) { logger.warn({ err }, "waitlist push failed"); }
}

export function registerWaitlistRoutes(app: Express): void {
app.get("/waitlist", validateAction(WAITLIST_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { res.json({ entries: await GetWaitlist(restaurantId) }); }
	catch (e) { logger.error({ err: e }, "waitlist_list_failed"); res.status(500).json({ error: "Unable to fetch waitlist" }); }
});

app.post("/waitlist/:id/call", validateAction(WAITLIST_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const entry = await CallWaitlistEntry(restaurantId, String(req.params.id));
		try { emitRestaurant(restaurantId, "waitlist:updated", { action: "call", id: entry.id }); } catch {/* ignore */}
		// Reach the guest even with the browser closed — this is the whole point of
		// the queue: they walked away and need to come back now.
		await pushWaitlistUpdate(restaurantId, entry.id, {
			title: "We're calling you",
			body: `${entry.name}, your table is being prepared — please come to the host desk.`,
			url: `/queue/${encodeURIComponent(entry.token)}`,
			tag: `queue-${entry.id}`,
			data: { kind: "waitlist_called", waitlist_id: entry.id, token: entry.token },
		});
		try { await log_audit(req, WAITLIST_PERM, `Called queue party ${entry.name}`, Audit_log_category.Tables, { id: entry.id }); } catch {/* ignore */}
		res.json(entry);
	} catch (e: any) { logger.error({ err: e }, "waitlist_call_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to call this party") }); }
});

app.post("/waitlist/:id/seat", validateAction(WAITLIST_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	if (!tableName) { res.status(400).json({ error: "table_name is required" }); return; }
	try {
		const r = await SeatWaitlistEntry(restaurantId, String(req.params.id), tableName, extractEmployeeId(req) ?? undefined);
		try { emitRestaurant(restaurantId, "waitlist:updated", { action: "seat" }); } catch {/* ignore */}
		// Seating no longer places the held pre-order — it comes back as
		// `pending_preorder` for the guest/staff to confirm (POST
		// /waitlist/:id/preorder/confirm), which is where the order-created
		// notification now fires. `placed_order_id` stays in the response (null) so
		// older clients keep parsing it.
		await pushWaitlistUpdate(restaurantId, String(req.params.id), {
			title: "Your table is ready",
			body: `You're seated at ${r.table_name}.${r.pending_preorder ? " Confirm the items you picked while waiting." : ""}`,
			url: `/queue/${encodeURIComponent(r.waitlist_token)}`,
			tag: `queue-${req.params.id}`,
			data: { kind: "waitlist_seated", waitlist_id: r.waitlist_id, token: r.waitlist_token, table: r.table_name, pre_order_status: r.pre_order_status },
		});
		try { await log_audit(req, WAITLIST_PERM, `Seated queue party at ${r.table_name}`, Audit_log_category.Tables, { table: r.table_name, pre_order_status: r.pre_order_status }); } catch {/* ignore */}
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "waitlist_seat_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to seat this party") }); }
});

// Seated parties whose held pre-order still needs a yes/no. GET /waitlist only
// lists waiting/called parties, so without this the un-confirmed pre-order would
// only ever be visible in the seat response. Poll this to render a durable
// "confirm the pre-order for T4" list.
app.get("/waitlist/pending-preorders", validateAction(WAITLIST_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { res.json({ entries: await GetPendingPreorders(restaurantId) }); }
	catch (e) { logger.error({ err: e }, "waitlist_pending_preorders_failed"); res.status(500).json({ error: "Unable to fetch pending pre-orders" }); }
});

// Staff-side twins of the guest pre-order actions. Same DB functions, same
// idempotency — a waiter standing at the table can confirm on the guest's behalf.
app.post("/waitlist/:id/preorder/confirm", validateAction(WAITLIST_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const r = await ConfirmWaitlistPreorder(restaurantId, { id: String(req.params.id) }, extractEmployeeId(req) ?? undefined);
		if ("error" in r) { res.status(400).json(r); return; }
		if (r.placed_order_id && !r.already) {
			const placed: CreatedOrderInfo = { orderId: r.placed_order_id, table: r.table_name };
			await notifyOrderCreated(restaurantId, placed);
			emitOrderCreated(restaurantId, placed);
		}
		try { emitRestaurant(restaurantId, "waitlist:updated", { action: "preorder_confirm" }); } catch {/* ignore */}
		try { await log_audit(req, WAITLIST_PERM, `Confirmed queue pre-order for table ${r.table_name}`, Audit_log_category.Orders, { table: r.table_name, order: r.placed_order_id }); } catch {/* ignore */}
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "waitlist_preorder_confirm_staff_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to confirm the pre-order") }); }
});

app.post("/waitlist/:id/preorder/decline", validateAction(WAITLIST_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const r = await DeclineWaitlistPreorder(restaurantId, { id: String(req.params.id) });
		if ("error" in r) { res.status(400).json(r); return; }
		try { emitRestaurant(restaurantId, "waitlist:updated", { action: "preorder_decline" }); } catch {/* ignore */}
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "waitlist_preorder_decline_staff_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to update the pre-order") }); }
});

app.post("/waitlist/:id/cancel", validateAction(WAITLIST_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const status = body.status === "no_show" ? "no_show" : "cancelled";
	try {
		await CancelWaitlistEntry(restaurantId, String(req.params.id), status);
		try { emitRestaurant(restaurantId, "waitlist:updated", { action: "cancel" }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (e: any) { logger.error({ err: e }, "waitlist_cancel_staff_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to update the queue") }); }
});
}
