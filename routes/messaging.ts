/**
 * Guest messaging log and the manual booking-reminder trigger.
 */
import type { Express, Request, Response } from "express";
import { GetOutboundMessages } from "../database_supabase.js";
import { logger } from "../observability.js";
import { PERM_MESSAGING, clampLimit, enforcePermission, extractRestaurantId, sendDueBookingReminders, validate } from "./_shared.js";


export function registerMessagingRoutes(app: Express): void {

// --- Guest messaging: delivery visibility + manual reminder trigger ---------
// Last 50 outbound messages (confirmations, reminders, WhatsApp replies) with
// their sent/failed/skipped status — surfaced on the web bookings page so the
// owner can see whether guests are actually receiving messages.
app.get("/messages", validate, async (req: Request, res: Response) => {
	if (!(await enforcePermission(req, res, PERM_MESSAGING))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { res.json(await GetOutboundMessages(restaurantId, clampLimit(req.query.limit, 50, 200))); }
	catch (err) { logger.error({ err }, "get_messages_failed"); res.status(500).json({ error: "Unable to load messages" }); }
});

// Run the booking-reminder pass for this tenant now (the same function the
// 30-min timer calls) — lets an admin nudge reminders without waiting a tick.
app.post("/messages/run-reminders", validate, async (req: Request, res: Response) => {
	if (!(await enforcePermission(req, res, PERM_MESSAGING))) {return;}
	const resId = req.auth?.res_id;
	if (!resId) { res.status(400).json({ error: "Missing restaurant context" }); return; }
	try { res.json({ success: true, sent: await sendDueBookingReminders(resId) }); }
	catch (err) { logger.error({ err }, "run_reminders_failed"); res.status(500).json({ error: "Unable to run reminders" }); }
});
}
