/**
 * In-app notification bell: listing, targeting, read state and dismissal.
 */
import type { Express, Request, Response } from "express";
import { ClearNotifications, DeleteNotification, GetNotifications, MarkAllNotificationsRead, MarkNotificationRead, ResolveNotificationTarget } from "../database_supabase.js";
import { logger } from "../observability.js";
import { extractRestaurantId, validate } from "./_shared.js";


export function registerNotificationRoutes(app: Express): void {

// --- Staff notifications (bell) --------------------------------------------
app.get("/notifications", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		res.json(await GetNotifications(restaurantId));
	} catch (err) {
		logger.error({ err }, "get_notifications_failed");
		res.status(500).json({ error: "Unable to load notifications" });
	}
});

// Where a tapped notification should go, and whether the record is actually
// reachable from here. Registered BEFORE /notifications/:id/read so the more
// specific path is unambiguous.
//
// Returns 404 only when the NOTIFICATION itself is gone. A notification whose
// target record was deleted / lives on another outlet / has aged out of the live
// orders list still returns 200 with still_exists / visible_here / reason_gone /
// message so the client can say what happened instead of opening a blank screen.
app.get("/notifications/:id/target", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const target = await ResolveNotificationTarget(restaurantId, String(req.params.id));
		if (!target) { res.status(404).json({ error: "Notification not found" }); return; }
		res.json(target);
	} catch (err) {
		logger.error({ err }, "notif_target_failed");
		res.status(500).json({ error: "Unable to resolve notification target" });
	}
});

app.post("/notifications/read-all", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { await MarkAllNotificationsRead(restaurantId); res.json({ success: true }); }
	catch (err) { logger.error({ err }, "notif_read_all_failed"); res.status(500).json({ error: "Unable to update" }); }
});

app.post("/notifications/:id/read", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { await MarkNotificationRead(restaurantId, String(req.params.id)); res.json({ success: true }); }
	catch (err) { logger.error({ err }, "notif_read_failed"); res.status(500).json({ error: "Unable to update" }); }
});

app.delete("/notifications/:id", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { await DeleteNotification(restaurantId, String(req.params.id)); res.json({ success: true }); }
	catch (err) { logger.error({ err }, "notif_delete_failed"); res.status(500).json({ error: "Unable to delete" }); }
});

app.delete("/notifications", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { await ClearNotifications(restaurantId); res.json({ success: true }); }
	catch (err) { logger.error({ err }, "notif_clear_failed"); res.status(500).json({ error: "Unable to clear" }); }
});
}
