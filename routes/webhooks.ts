/**
 * Inbound WhatsApp Business webhooks (verification handshake + message delivery).
 * The POST handler verifies Meta's X-Hub-Signature-256 against the RAW request
 * body preserved by the express.json `verify` hook in index.ts.
 */
import type { Express, Request, Response } from "express";
import { createHmac } from "crypto";
import { AddBooking, AddNotification, AllocateBestTable, GetMessagingConfig, GetRestaurantProfile, GetRestaurantSettings, getRestaurantIdFromUsername, withTenant } from "../database_supabase.js";
import { logger } from "../observability.js";
import { emitRestaurant } from "../realtime.js";
import { DASHBOARD_BASE_URL, GetCustomerIdOrCreateCustomer, WA_USAGE_REPLY, parseWaBookingCommand, rateLimit, resolveRazorpayKeys, sendMessage, timingSafeStrEqual } from "./_shared.js";


export function registerWhatsAppWebhookRoutes(app: Express): void {

// Meta Cloud API webhook verification handshake: echo hub.challenge when the
// verify token matches the tenant's msg_webhook_secret (shown in Settings).
app.get("/webhooks/whatsapp/:slug", async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const token = String(req.query["hub.verify_token"] ?? "");
	const challenge = String(req.query["hub.challenge"] ?? "");
	const cfg = await withTenant(
		{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
		() => GetMessagingConfig(slug),
	).catch(() => null);
	if (cfg?.webhook_secret && token && timingSafeStrEqual(token, cfg.webhook_secret)) {
		res.status(200).type("text/plain").send(challenge);
		return;
	}
	res.status(403).json({ error: "Verification failed" });
});

// Inbound WhatsApp messages → chat-based booking. Accepts BOTH payload shapes:
//  - Meta Cloud API JSON (entry[].changes[].value.messages[]), verified against
//    X-Hub-Signature-256 with msg_webhook_secret when set;
//  - Twilio form-encoding (Body/From). Twilio's own X-Twilio-Signature scheme
//    needs the exact public URL we can't know behind proxies, so Twilio-shape
//    requests are accepted unsigned (same trust level as its shared webhook
//    convention; abuse is bounded by the rate limit + booking validation).
app.post("/webhooks/whatsapp/:slug", rateLimit("wa_webhook", 60, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const body = (req.body ?? {}) as Record<string, any>;
	const tenantCtx = { res_id: resId, outlet_id: "", employeeId: "", role: "" };

	// Detect the payload shape and pull out one inbound text message.
	let inbound: { from: string; text: string; name: string | null; shape: "meta" | "twilio" } | null = null;
	const isMetaShape = Array.isArray(body.entry);
	if (isMetaShape) {
		// Signature check BEFORE trusting anything in the payload.
		try {
			const cfg = await withTenant(tenantCtx, () => GetMessagingConfig(slug));
			if (cfg.webhook_secret) {
				const sig = String(req.headers["x-hub-signature-256"] ?? "");
				const raw = (req as any).rawBody as Buffer | undefined;
				const expected = raw ? "sha256=" + createHmac("sha256", cfg.webhook_secret).update(raw).digest("hex") : "";
				if (!sig || !expected || !timingSafeStrEqual(expected, sig)) {
					res.status(403).json({ error: "Invalid signature" });
					return;
				}
			}
		} catch (err) {
			logger.warn({ err }, "wa_webhook_config_failed");
			res.status(500).json({ error: "Webhook configuration unavailable" });
			return;
		}
		outer: for (const entry of body.entry) {
			for (const change of entry?.changes ?? []) {
				const value = change?.value ?? {};
				const msg = (value.messages ?? [])[0];
				const text = typeof msg?.text?.body === "string" ? msg.text.body : "";
				if (msg && typeof msg.from === "string" && text) {
					const profileName = value.contacts?.[0]?.profile?.name;
					inbound = { from: msg.from, text, name: typeof profileName === "string" ? profileName : null, shape: "meta" };
					break outer;
				}
			}
		}
	} else if (typeof body.Body === "string" && typeof body.From === "string") {
		inbound = {
			from: String(body.From).replace(/^whatsapp:/i, ""),
			text: body.Body,
			name: typeof body.ProfileName === "string" && body.ProfileName.trim() ? body.ProfileName.trim() : null,
			shape: "twilio",
		};
	}

	// Status callbacks / non-text events: acknowledge so the provider stops retrying.
	if (!inbound?.from || !inbound.text.trim()) {
		res.status(200).json({ ignored: true });
		return;
	}

	const guestPhone = inbound.from;
	const guestName = inbound.name || "WhatsApp Guest";
	const reply = (text: string, refId?: string | null) =>
		withTenant(tenantCtx, () =>
			sendMessage(slug, { to: guestPhone, body: text, channel: "whatsapp", kind: "wa_reply", refId: refId ?? null }),
		).catch((err) => { logger.warn({ err }, "wa_reply_failed"); });

	try {
		// Load settings up front for the restaurant timezone (so "today"/"tomorrow"
		// + the requested time resolve in the restaurant's local zone) and the
		// deposit rule below.
		const settings = await withTenant(tenantCtx, () => GetRestaurantSettings(slug)).catch(() => null);
		const cmd = parseWaBookingCommand(inbound.text, new Date(), settings?.timezone ?? "Asia/Kolkata");
		if (!cmd) {
			await reply(WA_USAGE_REPLY);
		} else if (cmd.date.getTime() < Date.now() - 60_000) {
			await reply("That time has already passed — please pick a future date and time.\n" + WA_USAGE_REPLY);
		} else {
			// Same rule as /qr/:slug/reserve: when a deposit applies AND the
			// restaurant's gateway is usable, chat can't collect it — send the guest
			// to the reserve page instead of holding an unpaid slot.
			const depositAmount = settings?.booking_deposit_amount ?? 0;
			const depositMinParty = settings?.booking_deposit_min_party ?? 0;
			const depositRuleTriggers = depositAmount > 0 && (depositMinParty <= 0 || cmd.party >= depositMinParty);
			if (depositRuleTriggers && (await resolveRazorpayKeys(slug, resId))) {
				await reply(
					`Bookings for ${cmd.party} need a ₹${depositAmount} online deposit, which I can't collect over chat. ` +
					`Please book (and pay) here: ${DASHBOARD_BASE_URL}/reserve/${encodeURIComponent(slug)}`,
				);
			} else {
				// Reuse the reserve path's internals: customer → table → booking → bell.
				const result = await withTenant(tenantCtx, async () => {
					const custId = await GetCustomerIdOrCreateCustomer(slug, guestName, guestPhone);
					if (!custId) {throw new Error("Unable to record the guest");}
					let tableName: string | null = null;
					try { tableName = await AllocateBestTable(slug, cmd.date, 90, cmd.party); } catch {/* assign later */}
					const booking = await AddBooking(
						slug, custId, cmd.date, 90, cmd.party, tableName, "WhatsApp", "Requested", "whatsapp", null,
						null, (settings?.booking_min_spend ?? 0) > 0 ? settings!.booking_min_spend : null,
					);
					try {
						await AddNotification(slug, {
							type: "reservation",
							title: "New WhatsApp reservation",
							body: `${guestName} · party ${cmd.party} · ${cmd.date.toLocaleString()}${tableName ? ` · ${tableName}` : ""}`,
							meta: { booking_id: String(booking._id) },
						});
					} catch {/* ignore */}
					return { booking_id: String(booking._id), table_name: tableName };
				});
				try { emitRestaurant(resId, "booking:created", { booking_id: result.booking_id, source: "whatsapp" }); } catch {/* ignore */}
				const profile = await withTenant(tenantCtx, () => GetRestaurantProfile(slug)).catch(() => null);
				const when = cmd.date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
				await reply(
					`${profile?.restaurant_name || slug}: Booked! Party of ${cmd.party} on ${when}` +
					`${result.table_name ? ` (table ${result.table_name})` : ""}. Reply here if your plans change.`,
					result.booking_id,
				);
			}
		}
	} catch (err) {
		logger.error({ err }, "wa_webhook_booking_failed");
		await reply("Sorry — I couldn't complete that booking (no table may be free at that time). Please try another slot or call us.");
	}

	// Twilio expects TwiML (empty <Response/> = no auto-reply); Meta just wants a 2xx.
	if (inbound.shape === "twilio") {res.status(200).type("text/xml").send("<Response/>");}
	else {res.status(200).json({ success: true });}
});
}
