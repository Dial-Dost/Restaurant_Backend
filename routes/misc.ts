/**
 * Unversioned service endpoints (root, version, health, Prometheus metrics) and the
 * public reception/realtime concierge surface.
 */
import type { Express, Request, Response } from "express";
import { AddBooking, AddNotification, AllocateBestTable, CheckDatabaseHealth, GetAvailableTablesForInterval, GetRestaurantSettings, getRestaurantIdFromUsername, parseWallClockInZone, withTenant } from "../database_supabase.js";
import { logger, metricsHandler } from "../observability.js";
import { OPENAI_REALTIME_MODEL, checkAvailabilityForRequest, getRestaurantKnowledgeSnapshot } from "../realtime_reception_agent.js";
import { emitRestaurant, realtimeAdapterReady } from "../realtime.js";
import { GetCustomerIdOrCreateCustomer, fetchWithTimeout, rateLimit, requireMobile10 } from "./_shared.js";


export function registerSystemRoutes(app: Express): void {

// Lightweight health endpoint for readiness/liveness checks
app.get("/", (_req: Request, res: Response) => {
	res.json({
		service: "restaurant-backend",
		status: "ok",
		docs: {
			health: "/health",
			bookings: "/get-bookings",
			tables: "/get-tables",
			customers: "/get-customers",
		},
	});
});

// Public app self-update manifest. Apps (Windows/Android/iOS) call this on
// launch, compare to their built-in version, and prompt/download when newer.
// Driven by env so you can roll a release without a code change.
app.get("/app/version", (_req: Request, res: Response) => {
	res.json({
		latest: process.env.APP_LATEST_VERSION ?? "1.0.0",
		// Apps older than this should be forced to update (hard gate).
		min_supported: process.env.APP_MIN_VERSION ?? "0.0.0",
		notes: process.env.APP_UPDATE_NOTES ?? "",
		downloads: {
			windows: process.env.APP_DOWNLOAD_WINDOWS ?? "",
			android: process.env.APP_DOWNLOAD_ANDROID ?? "",
			ios: process.env.APP_DOWNLOAD_IOS ?? "",
		},
	});
});

app.get("/health", async (_req: Request, res: Response) => {
	const result: any = { status: "ok", uptime: process.uptime(), time: new Date().toISOString() };
	let dbOk = false;
	try {
		dbOk = await CheckDatabaseHealth();
	} catch {
		dbOk = false;
	}
	// Do NOT echo the raw error on this anonymous endpoint (pg errors leak schema
	// details). Just the boolean — the real error is logged server-side by the pool.
	result.database = { ok: dbOk, provider: "supabase-postgres" };
	result.realtime = { adapter: realtimeAdapterReady() ? "redis" : "in-memory" };
	if (!dbOk) {
		// Return 503 so Railway/load balancers stop routing traffic to a broken
		// instance instead of seeing a 200 with a "degraded" body.
		result.status = "degraded";
		res.status(503).json(result);
		return;
	}
	res.json(result);
});

// Prometheus scrape endpoint (optionally bearer-gated via METRICS_TOKEN).
app.get("/metrics", metricsHandler);
}


export function registerReceptionRoutes(app: Express): void {

app.get("/reception/info", (_req: Request, res: Response) => {
	const snapshot = getRestaurantKnowledgeSnapshot();
	res.json(snapshot);
});

app.post("/reception/check-availability", rateLimit("reception", 10, 60_000), async (req: Request, res: Response) => {
	const { reservationDate, reservationTime, partySize } = req.body ?? {};
	if (!reservationDate || !reservationTime || typeof partySize !== "number") {
		res.status(400).json({ error: "reservationDate, reservationTime, and partySize are required" });
		return;
	}

	try {
		const result = await checkAvailabilityForRequest({
			reservationDate: String(reservationDate),
			reservationTime: String(reservationTime),
			partySize: Number(partySize),
		});
		res.json(result);
	} catch (error) {
		logger.error({ err: error }, "check_availability_failed");
		res.status(500).json({ error: "Unable to check availability" });
	}
});

app.post("/reception/create-reservation", rateLimit("reception_create", 6, 60_000), async (req: Request, res: Response) => {
	const payload = req.body ?? {};
	const required = ["guestName", "contactNumber", "partySize", "reservationDate", "reservationTime"] as const;
	const missing = required.filter((key) => !payload[key]);
	if (missing.length > 0) {
		res.status(400).json({ error: `Missing fields: ${missing.join(", ")}` });
		return;
	}

	// The reception agent (and any other caller) must supply a real 10-digit mobile
	// — this becomes the reservation's Customers row.
	const contactNumber = requireMobile10(res, payload.contactNumber);
	if (!contactNumber) {return;}

	// The booking is written IN-PROCESS (like /qr/:slug/reserve). This used to
	// round-trip back into the REST API over HTTP with no Authorization header,
	// against a base URL that isn't even this server's port, so /get-tables always
	// failed and the caller was told "no table available" — with HTTP 200 — while
	// nothing was ever created.
	// Tenant comes from the request (slug/header) so this works in a multi-tenant
	// deployment; RECEPTION_RESTAURANT_ID remains the single-tenant fallback for
	// the voice agent, which has no other way to say who it is answering for.
	const slug = String(
		payload.restaurantId ?? payload.slug ?? req.headers["x-restaurant-id"] ?? process.env.RECEPTION_RESTAURANT_ID ?? "",
	).trim();
	let resId: string | null = null;
	if (slug) {
		try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	}
	if (!resId) {
		res.status(404).json({ status: "failed", message: "I couldn't find that restaurant to book against." });
		return;
	}

	const partySize = Number.parseInt(String(payload.partySize), 10);
	if (!Number.isFinite(partySize) || partySize <= 0) {
		res.status(400).json({ status: "failed", message: "A valid party size is required." });
		return;
	}
	const duration = Number.parseInt(process.env.RECEPTION_BOOKING_DURATION ?? "120", 10) || 120;
	const source = process.env.RECEPTION_BOOKING_SOURCE ?? "Voice";
	const tablePreference = typeof payload.tablePreference === "string" ? payload.tablePreference.trim() : "";
	const notes = typeof payload.specialRequests === "string" && payload.specialRequests.trim()
		? payload.specialRequests.trim()
		: null;
	const guestName = String(payload.guestName).trim();

	try {
		const settings = await withTenant(
			{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
			() => GetRestaurantSettings(slug),
		).catch(() => null);
		// The caller states a wall-clock date + time; interpret it in the
		// restaurant's own timezone so a UTC server stores the right instant.
		const date = parseWallClockInZone(`${String(payload.reservationDate).trim()}T${String(payload.reservationTime).trim()}`, settings?.timezone ?? "Asia/Kolkata");
		if (Number.isNaN(date.getTime())) {
			res.status(400).json({ status: "failed", message: "I couldn't read that date and time." });
			return;
		}
		if (date.getTime() < Date.now() - 60_000) {
			res.status(400).json({ status: "failed", message: "That slot is in the past — could we pick a future time?" });
			return;
		}

		const result = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, async () => {
			// Allocate BEFORE touching Customers so a "no table" answer doesn't leave
			// an orphan customer row behind.
			let tableName: string | null = null;
			if (tablePreference) {
				const free = await GetAvailableTablesForInterval(slug, date, duration).catch(() => []);
				const match = free.find(
					(t) => t.table_name.toLowerCase() === tablePreference.toLowerCase() && (t.capacity ?? Number.MAX_SAFE_INTEGER) >= partySize,
				);
				tableName = match?.table_name ?? null;
			}
			if (!tableName) {
				tableName = await AllocateBestTable(slug, date, duration, partySize);
			}
			if (!tableName) {return null;}
			const custId = await GetCustomerIdOrCreateCustomer(slug, guestName, contactNumber);
			if (!custId) {throw new Error("Unable to record the guest");}
			const booking = await AddBooking(
				slug, custId, date, duration, partySize, tableName, source,
				"Confirmed", "reception", notes,
			);
			return { booking_id: String(booking._id), table_name: tableName };
		});

		if (!result) {
			// Honest failure status — a 200 here is what let callers record a
			// reservation that does not exist.
			res.status(409).json({
				status: "failed",
				message: "I couldn't find an open table that fits that group at that time. I'm happy to look at another slot if you'd like!",
			});
			return;
		}

		try { emitRestaurant(resId, "booking:created", { booking_id: result.booking_id, source: "reception" }); } catch {/* ignore */}
		try {
			await AddNotification(slug, {
				type: "reservation",
				title: "New reservation (reception)",
				body: `${guestName} · party ${partySize} · ${date.toLocaleString()} · ${result.table_name}`,
				meta: { booking_id: result.booking_id },
			});
		} catch {/* ignore */}

		res.json({
			status: "confirmed",
			message: `All set! I've booked ${result.table_name} for ${guestName} on ${payload.reservationDate} at ${payload.reservationTime}. Confirmation ID: ${result.booking_id}.`,
			tableName: result.table_name,
			referenceId: result.booking_id,
		});
	} catch (error) {
		logger.error({ err: error }, "create_reservation_failed");
		res.status(500).json({ status: "failed", error: "Unable to create reservation" });
	}
});

app.post("/realtime/session", rateLimit("realtime", 5, 60_000), async (_req: Request, res: Response) => {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		res.status(500).json({ error: "OPENAI_API_KEY is not configured on the server" });
		return;
	}

	try {
		const response = await fetchWithTimeout("https://api.openai.com/v1/realtime/sessions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: OPENAI_REALTIME_MODEL,
				voice: "alloy",
			}),
		});
		const dataUnknown = await response.json();
		const data = (dataUnknown ?? {}) as Record<string, unknown>;
		if (!response.ok) {
			res.status(response.status).json(data);
			return;
		}
		res.json(data);
	} catch (error) {
		logger.error({ err: error }, "realtime_session_failed");
		res.status(500).json({ error: "Unable to create realtime session" });
	}
});
}
