/**
 * PRINT ROUTING — the HTTP surface over migration 042.
 *
 * This is the screen an owner uses to say WHERE things print. The decision
 * engine (print_routing.ts), the rooms (realtime.ts) and every statement
 * (database_supabase.ts) were written before this file; what is left here is
 * authorisation, the shape of a request, the audit line, and the refusals.
 *
 * ============================================================================
 * THE PRIME CONSTRAINT: AN OUTLET WITH ZERO "PrintRoutes" ROWS IS UNCHANGED
 * ============================================================================
 * Every tenant is in that state on the day this ships, and for them nothing
 * about this feature may be observable — byte for byte on the wire and on the
 * paper. Nothing in this file changes that, because nothing in this file is
 * reachable from a print path: these routes are read and write operations on
 * configuration tables, and until a route row exists resolvePrintTarget answers
 * `no_route` and every docket takes the same emitOutlet it has taken since
 * migration 027.
 *
 * The one thing this file DOES arm is the reverse: the moment an owner saves a
 * rule here, that role starts routing. Routing arms PER ROLE, at the moment a
 * row is created — there is no global "server mode" toggle, which is deliberate
 * (a tenant who routes only `kot:BAR` has bills broadcasting exactly as today,
 * and enabling a mode before creating a `bill` route is how the losing designs
 * double-printed the money document).
 *
 * ============================================================================
 * NO NEW ACTION IDS. NOT ONE.
 * ============================================================================
 * Every route here is gated on 4ad474d4-5230-449c-874f-6a238b833bca — the
 * EXISTING print permission — and the writes additionally on PERM_SETTINGS.
 * Minting a new Action id would strip the capability from every role that holds
 * it today (migration 025's rule), and POST /print/ack already set this exact
 * precedent: whoever may print may confirm a print.
 *
 * WHY THE WRITES CARRY A SECOND GATE. Every waiter holds the print permission —
 * it is the same id that gates POST /print/bill — and deciding where a
 * restaurant's money documents print is not a waiter's decision. So reads
 * (which a till makes at app start, from the floor) are the print permission
 * alone, and writes (which an owner makes once, at a desk) are the print
 * permission AND "Manage Restaurant Settings".
 *
 * The one asymmetry: PUT /print/devices/me/targets is a WRITE on the print
 * permission alone, because it is the DEVICE writing its own address. Only the
 * machine that can reach a printer knows how to name it, the route refuses a
 * target the device did not itself report (see below), and requiring the owner's
 * permission for it would mean a till could not tell the server which spooler it
 * has — which is the one fact no owner can supply from the office.
 *
 * ============================================================================
 * REGISTRATION ORDER MATTERS AND IS PINNED
 * ============================================================================
 * `/print/devices/me` and `/print/devices/me/targets` are registered BEFORE
 * `/print/devices/:id`. They cannot actually be shadowed by it today (`:id` is a
 * single segment, and the one same-shape pair differs by method), but the order
 * is the pinned one because the next person to add `GET /print/devices/:id` must
 * land after `me`, not before it. scripts/route_manifest.ts freezes this.
 *
 * This whole family is registered immediately after registerBillPrintAndEditRoutes
 * so the `/print/*` routes stay contiguous — the existing three (`/print/bill`,
 * `/print/ack`, `/print/kot/order/:id`) are all literals, so nothing here can
 * shadow them and they cannot shadow anything here.
 *
 * ============================================================================
 * RUNNING AHEAD OF MIGRATION 042
 * ============================================================================
 * Deploy Gate B has twice swapped containers with migrations pending, so every
 * handler here assumes it may be running on a box where 042 has not landed:
 *
 *   READS degrade to empty. No destinations means no routes means broadcast,
 *   which is last week's printing — the editor opens empty instead of 500-ing.
 *   The exception is a lookup BY DEVICE KEY, whose empty is a 404 that means
 *   "register yourself again" — see refuseIfNoSchema.
 *
 *   WRITES REFUSE, with a 503 and a sentence naming the migration. They must:
 *   empty is ALSO a legal and meaningful save here (an empty PUT /print/routes is
 *   how an owner turns routing off), so a write that degraded to empty would hand
 *   the owner a success describing zero rules and let them conclude routing was
 *   configured off. database_supabase.ts's routingWrite throws
 *   PrintRoutingSchemaMissingError for exactly this, and every write below maps
 *   it to 503 rather than letting it surface as an unexplained 500.
 *
 * ============================================================================
 * EVERY CONFIG WRITE CALLS syncDeviceRooms — THE DEAD-CONTROL RULE
 * ============================================================================
 * The owner is at the office PC; the till is on the floor, connected to another
 * replica. Without syncDeviceRooms a binding written here would not reach that
 * till's live socket until it happened to reconnect, and the screen would show a
 * rule the router does not obey. Room membership is the binding state precisely
 * because it is the only thing that can be changed on a remote replica's socket.
 *
 * ============================================================================
 * NO idempotent() ON ANY ROUTE HERE
 * ============================================================================
 * so the Flutter outbox ALLOWLIST (restaurant_owner_app/lib/services/outbox.dart)
 * is UNCHANGED and still mirrors the server opt-in exactly. These are
 * configuration writes made once, at a desk — not the fifty-a-service floor
 * writes on a phone with no signal that migration 033 exists for — and each is
 * already safe to repeat by construction: every one is an upsert or a whole-set
 * replace, so replaying it lands the same rows.
 *
 * POST /print/test is the exception worth naming: replaying it prints a second
 * slip. That is correct — a test slip is a request for paper, and "I pressed it
 * twice and got two slips" is the behaviour anybody expects from a test button.
 *
 * ============================================================================
 * WHAT THIS FILE DELIBERATELY DOES NOT EXPOSE
 * ============================================================================
 *   * RENAMING A DEVICE. The data layer exposes no label write (RegisterPrintDevice
 *     deliberately coalesces the stored label so an app start cannot undo an
 *     owner's rename, and there is no other statement). PATCH /print/devices/:id
 *     therefore REFUSES a `label` with a sentence saying so, rather than
 *     accepting it and silently discarding it — a control that reports success
 *     and changes nothing is the bug class this codebase names by hand.
 *   * DELETING A DEVICE. Retire, or replace. PrintDeviceTargets.device_id
 *     cascades, so a DELETE silently drops every binding that machine served and
 *     each of those destinations falls back to broadcast: "I deleted a device and
 *     now everything prints on every printer again" is correct behaviour that
 *     reads as a regression. Retiring keeps the bindings and the receipt history.
 *   * BINDING AN ADDRESS THE DEVICE DID NOT REPORT. PUT /print/devices/me/targets
 *     refuses a target that is not in that device's own `capabilities`. Guessing
 *     which printer is "the bar one" is how a guest's bill ends up on the kitchen
 *     roll.
 *   * ANYTHING CROSS-OUTLET. A printer address is a fact about one LAN.
 */
import type { Express, Request, Response } from "express";
import {
	Audit_log_category,
	DeletePrintDestination,
	GetKotPrintStyle,
	GetKotTextSize,
	GetPrintDeviceTargets,
	GetRestaurantProfile,
	ListPrintDestinations,
	ListPrintDevices,
	ListPrintRoutes,
	RegisterPrintDevice,
	ReplacePrintDevice,
	RetirePrintDevice,
	SetPrintDeviceTargets,
	SetPrintRoutes,
	UpsertPrintDestination,
	canonicalPrintRole,
	isPrintRoutingSchemaMissingError,
	isPrintRoutingSchemaReady,
	type PrintDeviceBindingRow,
	type PrintDeviceRow,
} from "../database_supabase.js";
import { buildKotBase64 } from "../escpos.js";
import { logger } from "../observability.js";
import { dispatchPrintJob } from "../print_routing.js";
import { getIo, outletDeviceSockets, realtimeAdapterReady, syncDeviceRooms } from "../realtime.js";
import { PERM_SETTINGS, enforcePermission, extractOutletId, extractRestaurantId, log_audit, validate, validateAction } from "./_shared.js";


/** The EXISTING print permission. Spelled in full, like routes/bills.ts spells
 *  it on /print/bill and /print/ack, so the whole `/print` family reads the same
 *  way and a grep for the id finds every route it gates. */
const PERM_PRINT = "4ad474d4-5230-449c-874f-6a238b833bca";

/** The audit Action id routes/settings.ts already files configuration changes
 *  under. Reused rather than minted: "Audit_logs" has a foreign key to
 *  "Actions", so an unseeded id would make the audit write fail (silently, since
 *  every audit call here is best-effort) and the change would go unrecorded. */
const AUDIT_SETTINGS = "60d14e9c-45cc-4dc2-b017-56058cc3ae33";

/** The same shape database_supabase.ts's isUuid() guards with, spelled here so a
 *  malformed path parameter is refused at the edge instead of surfacing as a
 *  22P02 from the data layer dressed up as a 500. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** How many roles one "Test every printer" press may put on paper. A tenant with
 *  a dozen kitchen sections pressing this twice should not be able to empty a
 *  roll; past the cap the response says how many were skipped. */
const MAX_TEST_ROLES = 12;

/** Paper width for the test slip, in columns. Same two widths the bill path
 *  offers (58mm = 32, 80mm = 48). */
const TEST_SLIP_COLS = 48;

/** Same 750ms outletDeviceSockets races the adapter with. A health screen that
 *  hangs on a wedged Redis adapter is worse than one that says "unknown". */
const ROOM_FETCH_TIMEOUT_MS = 750;

/** A client cannot be allowed to make this route walk an unbounded array before
 *  the data layer's own cap applies. 64 is that cap (RegisterPrintDevice), and a
 *  machine with 64 reachable printers does not exist. */
const MAX_REPORTED_CAPABILITIES = 64;

/** Bindings one device may claim in a single PUT. Same reason, same order of
 *  magnitude as MAX_DESTINATIONS_PER_DEVICE in realtime.ts. */
const MAX_TARGETS_PER_DEVICE = 64;

/**
 * The tenant + outlet this request acts on, or null once the refusal has been
 * sent.
 *
 * OUTLET-SCOPED, ALWAYS, because a printer is a physical object in one branch.
 * extractOutletId returns the outlet requireAuth RESOLVED and bound the
 * connection to — never a raw header — so an admin using the X-Outlet-Id
 * override configures the branch they are actually looking at, and the "all"
 * sentinel has already been collapsed to a concrete outlet upstream.
 */
function scope(req: Request, res: Response): { restaurantId: string; outletId: string } | null {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return null; }
	const outletId = extractOutletId(req);
	if (!outletId) { res.status(400).json({ error: "Missing outletId" }); return null; }
	return { restaurantId, outletId };
}

/**
 * Map a failed routing WRITE onto a response.
 *
 * The 503 is the whole point of PrintRoutingSchemaMissingError: "this server has
 * no routing schema, and NOTHING WAS SAVED" is a different fact from "your save
 * was fine, you have zero rules", and on this screen the two are indistinguishable
 * from the outside. `code` is machine-readable so the client can say "this
 * server is older than this screen" rather than "try again".
 */
function failWrite(res: Response, err: unknown, where: string): void {
	if (isPrintRoutingSchemaMissingError(err)) {
		logger.warn({ err, where }, "print_routing_write_refused_schema_missing");
		res.status(503).json({
			error: (err as Error).message,
			code: "PRINT_ROUTING_UNAVAILABLE",
		});
		return;
	}
	logger.error({ err }, `${where}_failed`);
	res.status(500).json({ error: "Unable to save the print configuration" });
}

/**
 * Refuse, with the migration named, the two routes that look a device up BY KEY.
 *
 * WHY THESE TWO AND NOTHING ELSE. Every other read here degrades to an empty
 * list, and empty is an honest answer on a screen whose empty state is the
 * pre-routing world. A lookup by device key has no empty — its empty is 404, and
 * 404 on these two routes means something specific and actionable to the client:
 * "this machine has never registered", which makes it register again. Under a
 * pending 042 that is a lie that puts a till into a registration loop against a
 * server that has no table to register into. 503 + the code is the state the
 * client already knows how to sit out.
 *
 * The latch is the columns probe, not a table probe (both come from 042, so in
 * practice they move together). It is used only to REFUSE: when it is true but
 * the tables are still absent, the write below throws
 * PrintRoutingSchemaMissingError and failWrite says the same thing.
 */
function refuseIfNoSchema(res: Response): boolean {
	if (isPrintRoutingSchemaReady()) { return false; }
	res.status(503).json({
		error: "Print routing is not installed on this server (migration 042).",
		code: "PRINT_ROUTING_UNAVAILABLE",
	});
	return true;
}

/** `?include_inactive=true`. Default false on every read: the usual caller is a
 *  picker, and a deactivated destination is not a place any more. */
function wantsInactive(req: Request): boolean {
	return req.query.include_inactive === "true" || req.query.include_inactive === "1";
}

/**
 * The destination ids one device currently serves — what syncDeviceRooms needs.
 *
 * ACTIVE BINDINGS ONLY, and only for this outlet: an inactive binding is the
 * device saying "I cannot reach that printer any more", and leaving it in a
 * dest: room would keep it in the chain for four seconds of silence per docket.
 */
function servedDestinations(bindings: PrintDeviceBindingRow[]): string[] {
	return bindings.filter((b) => b.active).map((b) => b.destination_id);
}

/**
 * Move a device's live socket onto its current bindings.
 *
 * BEST EFFORT, ALWAYS, AND NEVER FATAL TO THE SAVE. The rows are the durable
 * truth; the rooms are an optimisation that saves the till a reconnect. If the
 * adapter is down the save still stands and the device picks its rooms up on its
 * next joinOutlet — reporting a 500 for it would tell an owner their
 * configuration failed when it is sitting in the table.
 */
async function syncRooms(resId: string, outletId: string, deviceId: string, destinationIds: string[]): Promise<void> {
	try {
		await syncDeviceRooms(resId, outletId, deviceId, destinationIds);
	} catch (err) {
		logger.warn({ err, resId, outletId, deviceId }, "print_sync_device_rooms_after_write_failed");
	}
}

/** Who is online and routable right now, or null when we could not ask (no io,
 *  a raced fetchSockets, or production without the Redis adapter). NULL AND
 *  EMPTY ARE DIFFERENT ANSWERS — empty is "nobody is there", null is "I cannot
 *  tell", and a screen that renders the second as the first accuses a working
 *  till of being offline. */
async function presence(resId: string, outletId: string): Promise<Map<string, Set<string>> | null> {
	try {
		const sockets = await outletDeviceSockets(resId, outletId);
		if (sockets === null) { return null; }
		const map = new Map<string, Set<string>>();
		for (const s of sockets) {
			if (!s.deviceId || !s.ready) { continue; }
			map.set(s.deviceId, new Set(s.destinations));
		}
		return map;
	} catch (err) {
		logger.warn({ err, resId, outletId }, "print_presence_lookup_failed");
		return null;
	}
}

/**
 * How many sockets are sitting in this outlet's room with NO print identity.
 *
 * SOCKETS, NOT ROWS, and that is the whole point of the number. The C# agent
 * (MainPage.xaml.cs sends joinOutlet with no device block and prints every
 * bill:print unconditionally) and every pre-routing Flutter build can NEVER
 * produce a "PrintDevices" row, so a screen that counts the registry is blind to
 * exactly the clients this warning exists for: the ones that will keep printing
 * everything the moment an owner starts routing, and that nothing here can
 * revoke, target or even ask.
 *
 * IT IS AN UPPER BOUND, NOT A CENSUS, and the response says so. Every other
 * connected client — a dashboard tab, a waiter's phone, a KDS screen — is also in
 * this room without a print identity, and the join payload carries nothing that
 * separates a browser from a printer agent (socket.data.print is written only
 * after a deviceId is VERIFIED, and the C# agent sends neither that nor an
 * agentVersion). So the honest reading is "up to N connected clients cannot be
 * given their own printers", and a UI must word it that way. Zero, on the other
 * hand, is exact and is the answer that matters: nothing in this outlet can
 * double-print a routed job.
 *
 * THE ROOM NAME IS DUPLICATED FROM realtime.ts:46 and that is the one fragility
 * here — realtime.ts exports no room helper and no such counter, and this lane
 * may not add one. The guard below is what stops a future rename from turning
 * into a silent, reassuring zero: a room we cannot even find the DEVICES in is
 * reported as unknown rather than as empty.
 */
async function legacyAgents(resId: string, outletId: string, identifiedDevices: number): Promise<number | null> {
	const server = getIo();
	if (!server) { return null; }
	// Mirrors outletDeviceSockets: without the Redis adapter in production this
	// replica can only see its own sockets, and a partial count reported as a
	// total would understate exactly the risk being reported.
	if (!realtimeAdapterReady() && process.env.NODE_ENV === "production") { return null; }
	try {
		const sockets = await Promise.race([
			server.in(`restaurant:${resId}:outlet:${outletId}`).fetchSockets(),
			new Promise<null>((resolve) => {
				const timer = setTimeout(() => { resolve(null); }, ROOM_FETCH_TIMEOUT_MS);
				timer.unref?.();
			}),
		]);
		if (sockets === null) { return null; }
		let identified = 0;
		let anonymous = 0;
		for (const s of sockets) {
			const print = s.data && typeof s.data === "object" ? (s.data as { print?: unknown }).print : null;
			if (print && typeof print === "object") { identified += 1; } else { anonymous += 1; }
		}
		// The drift guard. outletDeviceSockets read the SAME room a moment ago and
		// found `identifiedDevices` machines in it; if this fetch cannot see at
		// least that many sockets carrying an identity, we are looking at the wrong
		// room (or read it mid-flight) and every "legacy" socket we counted is
		// noise. Say nothing rather than something false.
		if (identified < identifiedDevices) { return null; }
		return anonymous;
	} catch (err) {
		logger.warn({ err, resId, outletId }, "print_legacy_agent_count_failed");
		return null;
	}
}

/** The JSON shape of one device, plus whether it is connected right now. */
function deviceJson(d: PrintDeviceRow, online: Map<string, Set<string>> | null): Record<string, unknown> {
	return {
		id: d.id,
		outlet_id: d.outlet_id,
		device_key: d.device_key,
		label: d.label,
		platform: d.platform,
		agent_version: d.agent_version,
		capabilities: d.capabilities,
		default_target: d.default_target,
		last_seen_at: d.last_seen_at,
		retired_at: d.retired_at,
		// null, not false: see presence(). A dot rendered grey for "unknown" is
		// honest; a dot rendered red is a lie about a till that is printing fine.
		online: online === null ? null : online.has(d.id),
	};
}


export function registerPrintRoutingRoutes(app: Express): void {

// --- DEVICES: the machine registry -------------------------------------------

/*
	Register (or re-register) THIS machine.

	POST /print/devices/register
	  body { device_key, label?, platform?, agent_version?, capabilities?, default_target? }
	  -> 200 { device, destinations, targets, routing_enabled }
	  -> 503 { error, code } when migration 042 is not applied here

	HTTP, AT APP START, UNCONDITIONALLY — not off joinOutlet, and that is the one
	design decision this route exists to carry. printer_service.dart returns
	BEFORE the socket is created when the device has no printer configured, so a
	printer-less phone can never register over the socket — and a printer-less
	phone is exactly the device an owner must SEE in the list, so they can walk
	over, add an address, and bind it from the office PC.

	IT IS THE DEVICE'S OWN ROUTE, so it is gated on the print permission alone.
	`device_key` is the client-minted ULID that identifies the MACHINE; the server
	uuid it maps to is what everything else here uses. Re-registering is normal
	and happens on every app start: it refreshes last_seen_at, the agent version
	and the reported capabilities, and it deliberately does NOT overwrite an
	owner-edited label or un-retire a retired machine.

	THE RESPONSE CARRIES THE DEVICE'S WHOLE WORLD — its own bindings and this
	outlet's destinations — so a till that has just started knows what the server
	expects of it in one round trip, without a second call it might not make.
*/
app.post("/print/devices/register", validateAction(PERM_PRINT), async (req: Request, res: Response) => {
	const ctx = scope(req, res);
	if (!ctx) { return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const deviceKey = String(body.device_key ?? "").trim();
	if (!deviceKey) { res.status(400).json({ error: "device_key is required" }); return; }
	try {
		const device = await RegisterPrintDevice(ctx.restaurantId, ctx.outletId, {
			device_key: deviceKey,
			label: typeof body.label === "string" ? body.label : null,
			platform: typeof body.platform === "string" ? body.platform : null,
			agent_version: typeof body.agent_version === "string" ? body.agent_version : null,
			// Sliced BEFORE the map, not after. The data layer caps at 64 too, but it
			// caps a list this route has already walked — and a synchronous walk of a
			// client-supplied array is the shape realtime.ts had to delete from
			// joinOutlet for blocking every other tenant on the replica.
			capabilities: Array.isArray(body.capabilities)
				? body.capabilities.slice(0, MAX_REPORTED_CAPABILITIES).map((c) => String(c))
				: [],
			default_target: typeof body.default_target === "string" ? body.default_target : null,
		});
		if (!device) { res.status(500).json({ error: "Unable to register this device" }); return; }
		const [destinations, targets] = await Promise.all([
			ListPrintDestinations(ctx.restaurantId, ctx.outletId),
			GetPrintDeviceTargets(ctx.restaurantId, ctx.outletId, device.id, { includeInactive: true }),
		]);
		// THE OWNER MAY HAVE BOUND THIS MACHINE WHILE IT WAS OFF. Registration is
		// the first thing the app does, before the socket exists, so this sync is
		// usually a no-op on a socket that is not there yet — but a re-register
		// from a running app (the client also calls this when a printer is added
		// or removed) is precisely when the rooms need to catch up without a
		// reconnect.
		// Retired machines stay out of the rooms — registration does not un-retire
		// (RegisterPrintDevice leaves retired_at alone), so re-registering must not
		// be a back door into the chain's presence check either.
		await syncRooms(ctx.restaurantId, ctx.outletId, device.id, device.retired_at ? [] : servedDestinations(targets));
		res.json({
			device: deviceJson(device, null),
			destinations,
			targets,
			// So a client can tell "this server has routing but you have configured
			// none" from "this server has no routing at all" — two states that both
			// produce an empty destination list and mean very different things.
			routing_enabled: isPrintRoutingSchemaReady(),
		});
	} catch (err) {
		failWrite(res, err, "print_device_register");
	}
});

/*
	Every machine the owner can bind.

	GET /print/devices?scope=outlet|restaurant&include_retired=false
	  -> 200 { devices: [...], presence: "ok" | "unknown" }

	`scope=restaurant` because a device is res_id-unique, not outlet-unique: the
	till that registered under the other branch this morning is still the same
	machine, and an owner looking from the office needs to see it. The DEFAULT is
	this outlet, because binding is outlet-scoped and a list that offers machines
	from another branch invites a binding that can never be served.

	`presence: "unknown"` is served rather than pretending everything is offline —
	see presence().
*/
app.get("/print/devices", validateAction(PERM_PRINT), async (req: Request, res: Response) => {
	const ctx = scope(req, res);
	if (!ctx) { return; }
	const wholeRestaurant = req.query.scope === "restaurant";
	try {
		const [devices, online] = await Promise.all([
			ListPrintDevices(ctx.restaurantId, wholeRestaurant ? null : ctx.outletId, {
				includeRetired: req.query.include_retired === "true",
			}),
			presence(ctx.restaurantId, ctx.outletId),
		]);
		res.json({
			devices: devices.map((d) => deviceJson(d, online)),
			presence: online === null ? "unknown" : "ok",
		});
	} catch (err) {
		logger.error({ err }, "list_print_devices_failed");
		res.status(500).json({ error: "Unable to fetch print devices" });
	}
});

/*
	THIS machine's own view of itself.

	GET /print/devices/me?device_key=<client-minted ULID>
	  -> 200 { device, destinations, targets, routing_enabled }
	  -> 404 when this key has never registered here
	  -> 503 when migration 042 is not applied here — NOT 404, which the client
	     reads as "register me", and which would loop it against a server that has
	     no table to register into

	The client calls it on `print:config-changed` to pick up a binding the owner
	made from the office. Keyed on the device's OWN key rather than on the session,
	because a session is an employee and an employee is not a machine — two
	waiters share a till, and one waiter's phone is not the till.

	Registered BEFORE PATCH /print/devices/:id. See the header.
*/
app.get("/print/devices/me", validateAction(PERM_PRINT), async (req: Request, res: Response) => {
	const ctx = scope(req, res);
	if (!ctx) { return; }
	if (refuseIfNoSchema(res)) { return; }
	const deviceKey = String(req.query.device_key ?? "").trim();
	if (!deviceKey) { res.status(400).json({ error: "device_key is required" }); return; }
	try {
		// Retired rows included on purpose: a machine that was retired and is still
		// switched on must be able to learn that it was, rather than reading a 404
		// as "I have never registered" and registering itself again.
		const devices = await ListPrintDevices(ctx.restaurantId, null, { includeRetired: true });
		const device = devices.find((d) => d.device_key === deviceKey) ?? null;
		if (!device) { res.status(404).json({ error: "This device is not registered" }); return; }
		const [destinations, targets] = await Promise.all([
			ListPrintDestinations(ctx.restaurantId, ctx.outletId),
			GetPrintDeviceTargets(ctx.restaurantId, ctx.outletId, device.id, { includeInactive: true }),
		]);
		res.json({
			device: deviceJson(device, null),
			destinations,
			targets,
			routing_enabled: isPrintRoutingSchemaReady(),
		});
	} catch (err) {
		logger.error({ err }, "get_print_device_me_failed");
		res.status(500).json({ error: "Unable to fetch this device" });
	}
});

/*
	THIS machine tells the server which printer it can reach for which destination.

	PUT /print/devices/me/targets
	  body { device_key, targets: [{ destination_id, target, priority?, active? }] }
	  -> 200 { device, targets }
	  -> 400 when a target is not one this device reported it can reach, is not a
	     destination in this outlet, or carries an empty address
	  -> 503 when migration 042 is not applied here

	THE ADDRESS LIVES IN THE BOTTOM LAYER AND ONLY THE DEVICE WRITES IT, because
	only the machine that can reach a printer knows how to name it: an owner in the
	office cannot know that the till calls it "EPSON TM-T82 Receipt".

	THE CAPABILITY CHECK IS THE REFUSAL THAT MATTERS. A target that is not in this
	device's own reported `capabilities` is rejected, not stored: a stored address
	nobody can reach makes that device a chain candidate that will fail three times
	and take about a minute to say so, for every docket, and the destination looks
	configured the whole time. The rejection names the offending target and returns
	the capability list, so a UI can say WHY instead of "save failed".

	AN EMPTY `targets` IS A LEGAL AND MEANINGFUL SAVE — it is exactly what "forget
	this printer" means on the device's own screen, and without it the server keeps
	picking a machine that no longer has the printer.

	Gated on the print permission alone (not PERM_SETTINGS): see the header.

	Registered BEFORE PATCH /print/devices/:id. See the header.
*/
app.put("/print/devices/me/targets", validateAction(PERM_PRINT), async (req: Request, res: Response) => {
	const ctx = scope(req, res);
	if (!ctx) { return; }
	// BEFORE the lookup, because both reads it makes degrade to empty under a
	// pending 042 and the refusals below would then blame the caller: a 404 saying
	// the device is not registered, or a 400 saying the destination is not in this
	// outlet, when the truth is that this server has no routing tables.
	if (refuseIfNoSchema(res)) { return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const deviceKey = String(body.device_key ?? "").trim();
	if (!deviceKey) { res.status(400).json({ error: "device_key is required" }); return; }
	if (!Array.isArray(body.targets)) { res.status(400).json({ error: "targets must be an array" }); return; }
	if (body.targets.length > MAX_TARGETS_PER_DEVICE) {
		res.status(400).json({ error: `A device may be bound to at most ${MAX_TARGETS_PER_DEVICE} destinations.` });
		return;
	}
	try {
		const [devices, destinations] = await Promise.all([
			ListPrintDevices(ctx.restaurantId, null, { includeRetired: true }),
			// Inactive included: a device re-reporting its address for a destination
			// the owner switched off is not an error, and refusing it would make the
			// binding vanish the moment the destination is switched back on.
			ListPrintDestinations(ctx.restaurantId, ctx.outletId, { includeInactive: true }),
		]);
		const device = devices.find((d) => d.device_key === deviceKey) ?? null;
		if (!device) { res.status(404).json({ error: "This device is not registered" }); return; }

		const wanted = (body.targets as unknown[]).map((raw) => {
			const t = (raw ?? {}) as Record<string, unknown>;
			return {
				destination_id: String(t.destination_id ?? "").trim(),
				target: String(t.target ?? "").trim(),
				priority: Number.isFinite(Number(t.priority)) ? Number(t.priority) : undefined,
				active: t.active === false ? false : true,
			};
		});
		// REFUSED, NOT DROPPED — the same rule PUT /print/routes follows, and here it
		// is load-bearing because SetPrintDeviceTargets `continue`s past a row whose
		// destination is not a uuid or whose address is empty. Without these two
		// checks a typo'd destination_id or an empty target would come back 200 with
		// the binding simply absent, and the device's screen would show an address
		// the server does not have — the dead control, one layer down. "Unbind" has
		// its own two spellings (omit the row, or send active:false); an empty string
		// is not one of them.
		const badDestination = wanted.find((t) => !UUID_RE.test(t.destination_id));
		if (badDestination) {
			res.status(400).json({ error: "Every target needs the id of a destination in this outlet.", destination_id: badDestination.destination_id });
			return;
		}
		const knownDestinations = new Set(destinations.map((d) => d.id));
		const foreign = wanted.find((t) => !knownDestinations.has(t.destination_id));
		if (foreign) {
			// Cross-outlet bindings are not a feature (§12): an address is a fact
			// about one LAN, and a row pointing out of this outlet can never be
			// resolved by anything — it would sit in the table looking configured.
			res.status(400).json({ error: "That destination is not in this outlet.", destination_id: foreign.destination_id });
			return;
		}
		const emptyTarget = wanted.find((t) => !t.target);
		if (emptyTarget) {
			res.status(400).json({ error: "A target needs a printer address. To unbind, leave the destination out of the list or send it with active:false.", destination_id: emptyTarget.destination_id });
			return;
		}
		// Capabilities are compared case-insensitively: a Windows spooler name is
		// the one string in this system a human retypes, and "EPSON TM-T82 Receipt"
		// against "Epson TM-T82 Receipt" is not a different printer.
		const reachable = new Set(device.capabilities.map((c) => c.trim().toLowerCase()));
		const unknownTarget = wanted.find((t) => !reachable.has(t.target.toLowerCase()));
		if (unknownTarget) {
			res.status(400).json({
				error: `This device did not report "${unknownTarget.target}" as a printer it can reach, so it will not be bound to one.`,
				target: unknownTarget.target,
				capabilities: device.capabilities,
			});
			return;
		}

		const saved = await SetPrintDeviceTargets(ctx.restaurantId, ctx.outletId, device.id, wanted);
		// A RETIRED MACHINE STAYS OUT OF THE DESTINATION ROOMS, the same as it is put
		// out by PATCH. The resolver already drops retired bindings, so this changes
		// no routing — it stops a retired till that is still switched on from
		// re-joining a destination room on its next address write and showing up
		// green on the health screen as the thing serving that printer.
		await syncRooms(ctx.restaurantId, ctx.outletId, device.id, device.retired_at ? [] : servedDestinations(saved));
		res.json({ device: deviceJson(device, null), targets: saved });
	} catch (err) {
		failWrite(res, err, "print_device_targets_set");
	}
});

/*
	The OWNER's edits to one machine: retire it, bring it back, or replace it.

	PATCH /print/devices/:id  body { retired?: boolean, replaces?: "<old device id>" }
	  -> 200 { device?, moved? }
	  -> 400 { error } on `label` — renaming is not wired, see below
	  -> 404 when either device is unknown to this tenant
	  -> 503 when migration 042 is not applied here

	RETIRE, DO NOT DELETE. PrintDeviceTargets.device_id cascades, so deleting a
	machine silently drops every binding it served and each of those destinations
	falls back to broadcast — "I deleted a device and now everything prints on
	every printer again" is correct behaviour that reads as a regression. There is
	no DELETE on this route for that reason.

	`replaces` IS THE REINSTALL PATH, and it is deliberately explicit. A reinstall
	mints a fresh device key and therefore a fresh row with zero bindings: it joins
	no destination room, is never a candidate, and every destination the old
	machine served falls through its chain to broadcast — nothing waits on the
	operator. This moves the bindings across and retires the old row in one audited
	statement. It is never inferred from a hostname or a platform: that is how a
	second till of the same model silently inherits the first's jobs.

	`label` IS REFUSED RATHER THAN IGNORED. The data layer exposes no label write
	(RegisterPrintDevice coalesces the stored label so an app start cannot undo a
	rename, and no other statement touches it), so accepting one here would mean a
	rename that reports success and changes nothing — a dead control, which is
	worse than the missing feature.

	BOTH DEVICES' ROOMS ARE RESYNCED after a replace, because both changed: the old
	one now serves nothing and the new one serves everything the old one did.
*/
app.patch("/print/devices/:id", validate, async (req: Request, res: Response) => {
	if (!(await enforcePermission(req, res, PERM_SETTINGS))) { return; }
	const ctx = scope(req, res);
	if (!ctx) { return; }
	const deviceId = String(req.params.id ?? "").trim();
	if (!UUID_RE.test(deviceId)) { res.status(400).json({ error: "Invalid device id" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	if (body.label !== undefined) {
		res.status(400).json({
			error: "Renaming a print device is not supported yet. The device's own label is what it reported at registration.",
		});
		return;
	}
	try {
		if (typeof body.replaces === "string" && body.replaces.trim()) {
			const oldId = body.replaces.trim();
			if (!UUID_RE.test(oldId)) { res.status(400).json({ error: "Invalid device id in replaces" }); return; }
			const moved = await ReplacePrintDevice(ctx.restaurantId, deviceId, oldId);
			// NULL, not 0: the data layer distinguishes "one of these devices is not
			// yours" from "that machine had no bindings", precisely so this can 404
			// instead of reporting a successful move of nothing.
			if (moved === null) { res.status(404).json({ error: "Unknown device" }); return; }
			const [oldTargets, newTargets] = await Promise.all([
				GetPrintDeviceTargets(ctx.restaurantId, ctx.outletId, oldId, { includeInactive: true }),
				GetPrintDeviceTargets(ctx.restaurantId, ctx.outletId, deviceId, { includeInactive: true }),
			]);
			await syncRooms(ctx.restaurantId, ctx.outletId, oldId, servedDestinations(oldTargets));
			await syncRooms(ctx.restaurantId, ctx.outletId, deviceId, servedDestinations(newTargets));
			try {
				await log_audit(req, AUDIT_SETTINGS, `Replaced print device ${oldId} with ${deviceId} (${moved.moved} binding(s) moved)`, Audit_log_category.General, {
					outlet_id: ctx.outletId, device_id: deviceId, replaces: oldId, moved: moved.moved,
				});
			} catch (err) { logger.warn({ err }, "log_audit print_device_replace failed"); }
			res.json({ success: true, moved: moved.moved });
			return;
		}

		if (typeof body.retired === "boolean") {
			const ok = await RetirePrintDevice(ctx.restaurantId, deviceId, body.retired);
			if (!ok) { res.status(404).json({ error: "Unknown device" }); return; }
			// A retired machine is never a chain candidate (the resolver drops it),
			// but its dest: rooms would still make it LOOK online on the health
			// screen, so they come off — and go back on when it is un-retired.
			const targets = await GetPrintDeviceTargets(ctx.restaurantId, ctx.outletId, deviceId, { includeInactive: true });
			await syncRooms(ctx.restaurantId, ctx.outletId, deviceId, body.retired ? [] : servedDestinations(targets));
			try {
				await log_audit(req, AUDIT_SETTINGS, `${body.retired ? "Retired" : "Un-retired"} print device ${deviceId}`, Audit_log_category.General, {
					outlet_id: ctx.outletId, device_id: deviceId, retired: body.retired,
				});
			} catch (err) { logger.warn({ err }, "log_audit print_device_retire failed"); }
			res.json({ success: true, retired: body.retired });
			return;
		}

		res.status(400).json({ error: "Nothing to change. Send `retired` or `replaces`." });
	} catch (err) {
		failWrite(res, err, "print_device_patch");
	}
});

// --- DESTINATIONS: the places --------------------------------------------------

/*
	This outlet's destinations.

	GET /print/destinations?include_inactive=false
	  -> 200 { destinations: [...], routing_enabled }

	Empty on every tenant until an owner creates one, and empty is the state in
	which everything broadcasts exactly as it did before this feature existed.
*/
app.get("/print/destinations", validateAction(PERM_PRINT), async (req: Request, res: Response) => {
	const ctx = scope(req, res);
	if (!ctx) { return; }
	try {
		const destinations = await ListPrintDestinations(ctx.restaurantId, ctx.outletId, {
			includeInactive: wantsInactive(req),
		});
		res.json({ destinations, routing_enabled: isPrintRoutingSchemaReady() });
	} catch (err) {
		logger.error({ err }, "list_print_destinations_failed");
		res.status(500).json({ error: "Unable to fetch print destinations" });
	}
});

/*
	Create, rename, reorder or deactivate a destination.

	POST /print/destinations  body { id?, name, sort_order?, active? }
	  -> 200 { destination }
	  -> 503 when migration 042 is not applied here

	AN UPSERT, ON (outlet, lower(name)), so re-saving the screen updates rather
	than duplicating and "Bar Printer" cannot become a second destination beside
	"bar printer" that nobody can tell apart on a routing screen. A supplied id
	that loses the conflict is discarded — the surviving row keeps its own id,
	because the routes and the device bindings reference it.

	AN OMITTED FIELD IS NOT A ZERO: the data layer coalesces sort_order and active
	from the parameter, so the natural `{id, name}` rename does not reset the
	order or silently re-activate a destination the owner deactivated on purpose.

	DEACTIVATING IS THE SOFT DELETE and it is what the screen should offer first:
	a route pointing at an inactive destination matches nothing, so the job
	broadcasts — the honest reading of "the owner switched this printer off".
*/
app.post("/print/destinations", validate, async (req: Request, res: Response) => {
	if (!(await enforcePermission(req, res, PERM_SETTINGS))) { return; }
	const ctx = scope(req, res);
	if (!ctx) { return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const name = String(body.name ?? "").trim();
	if (!name) { res.status(400).json({ error: "A destination name is required" }); return; }
	const id = typeof body.id === "string" ? body.id.trim() : "";
	if (id && !UUID_RE.test(id)) { res.status(400).json({ error: "Invalid destination id" }); return; }
	try {
		const destination = await UpsertPrintDestination(ctx.restaurantId, ctx.outletId, {
			id: id || null,
			name,
			...(body.sort_order === undefined ? {} : { sort_order: Number(body.sort_order) }),
			...(body.active === undefined ? {} : { active: body.active !== false }),
		});
		if (!destination) { res.status(500).json({ error: "Unable to save this destination" }); return; }
		try {
			await log_audit(req, AUDIT_SETTINGS, `Saved print destination "${destination.name}"`, Audit_log_category.General, {
				outlet_id: ctx.outletId, destination_id: destination.id, active: destination.active,
			});
		} catch (err) { logger.warn({ err }, "log_audit print_destination_save failed"); }
		res.json({ destination });
	} catch (err) {
		failWrite(res, err, "print_destination_upsert");
	}
});

/*
	Delete a destination outright.

	DELETE /print/destinations/:id
	  -> 200 { success: true }
	  -> 404 when it is not this outlet's
	  -> 503 when migration 042 is not applied here

	ITS ROUTES AND ITS DEVICE BINDINGS GO WITH IT, by 042's cascade, and every
	role that pointed at it goes back to broadcasting to the whole outlet. That is
	correct — a rule naming a place that does not exist is not a rule — and it is
	also the change most likely to be read as a regression, which is why
	POST /print/destinations `{active:false}` exists and why a screen should offer
	deactivation first.
*/
app.delete("/print/destinations/:id", validate, async (req: Request, res: Response) => {
	if (!(await enforcePermission(req, res, PERM_SETTINGS))) { return; }
	const ctx = scope(req, res);
	if (!ctx) { return; }
	const destinationId = String(req.params.id ?? "").trim();
	if (!UUID_RE.test(destinationId)) { res.status(400).json({ error: "Invalid destination id" }); return; }
	try {
		const removed = await DeletePrintDestination(ctx.restaurantId, ctx.outletId, destinationId);
		if (!removed) { res.status(404).json({ error: "Unknown destination" }); return; }
		try {
			await log_audit(req, AUDIT_SETTINGS, `Deleted print destination ${destinationId}`, Audit_log_category.General, {
				outlet_id: ctx.outletId, destination_id: destinationId,
			});
		} catch (err) { logger.warn({ err }, "log_audit print_destination_delete failed"); }
		res.json({ success: true });
	} catch (err) {
		failWrite(res, err, "print_destination_delete");
	}
});

// --- ROUTES: the rule set ------------------------------------------------------

/*
	This outlet's rules.

	GET /print/routes
	  -> 200 { routes: [...], destinations: [...], routing_enabled }

	A ROLE IS 'bill', 'kot', OR 'kot:<STATION UPPERCASED>' — the exact vocabulary
	the wire and the client already use. There is no group table: "Bar + Cocktails
	+ Juice on one printer" is three rows sharing one destination_id.

	The destinations ride along because a routing screen cannot render a rule
	without the name of the place it points at, and a second call to get them
	would let the two answers disagree across a rename.
*/
app.get("/print/routes", validateAction(PERM_PRINT), async (req: Request, res: Response) => {
	const ctx = scope(req, res);
	if (!ctx) { return; }
	try {
		const [routes, destinations] = await Promise.all([
			ListPrintRoutes(ctx.restaurantId, ctx.outletId),
			ListPrintDestinations(ctx.restaurantId, ctx.outletId, { includeInactive: true }),
		]);
		res.json({ routes, destinations, routing_enabled: isPrintRoutingSchemaReady() });
	} catch (err) {
		logger.error({ err }, "list_print_routes_failed");
		res.status(500).json({ error: "Unable to fetch print routes" });
	}
});

/*
	Replace this outlet's WHOLE rule set.

	PUT /print/routes  body { routes: [{ role, destination_id }] }
	  -> 200 { routes }
	  -> 400 when a role is not one of bill | kot | kot:<STATION>
	  -> 503 when migration 042 is not applied here

	A WHOLE-SET REPLACE, in one statement, and the one place in this file where
	that is the right shape: a routing screen that saved half its rules would send
	dockets to two different printers depending on which half landed. (This is not
	the bulk-save that wiped 56 menu items — that was a full-row replace over
	documents the payload did not carry. Here the payload IS the whole rule set,
	it is small, it is rendered from what the screen just read, and every field of
	every row is present.)

	AN EMPTY LIST IS A LEGAL AND MEANINGFUL SAVE: it is how an owner turns routing
	off for an outlet and goes back to broadcast, without a redeploy and without
	deleting the destinations they configured.

	A ROLE THAT CANONICALISES TO NOTHING IS REFUSED, NOT DROPPED. canonicalPrintRole
	returns null for anything that is not the wire's vocabulary; storing it would be
	a rule that can never match, and dropping it silently would be a save that
	reports success while the dropped section keeps printing everywhere.
*/
app.put("/print/routes", validate, async (req: Request, res: Response) => {
	if (!(await enforcePermission(req, res, PERM_SETTINGS))) { return; }
	const ctx = scope(req, res);
	if (!ctx) { return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	if (!Array.isArray(body.routes)) { res.status(400).json({ error: "routes must be an array" }); return; }
	const input: { role: string; destination_id: string }[] = [];
	for (const raw of body.routes as unknown[]) {
		const r = (raw ?? {}) as Record<string, unknown>;
		const role = canonicalPrintRole(r.role);
		const destinationId = String(r.destination_id ?? "").trim();
		if (!role) {
			res.status(400).json({ error: `"${String(r.role ?? "")}" is not a print role. Use "bill", "kot", or "kot:<STATION>".` });
			return;
		}
		if (!UUID_RE.test(destinationId)) {
			res.status(400).json({ error: `Route "${role}" needs a destination.` });
			return;
		}
		input.push({ role, destination_id: destinationId });
	}
	try {
		const routes = await SetPrintRoutes(ctx.restaurantId, ctx.outletId, input);
		try {
			await log_audit(req, AUDIT_SETTINGS, `Saved ${routes.length} print route(s)`, Audit_log_category.General, {
				outlet_id: ctx.outletId, roles: routes.map((r) => r.role),
			});
		} catch (err) { logger.warn({ err }, "log_audit print_routes_save failed"); }
		res.json({ routes });
	} catch (err) {
		failWrite(res, err, "print_routes_set");
	}
});

// --- HEALTH + TEST -------------------------------------------------------------

/*
	Can every configured destination actually be served right now?

	GET /print/health
	  -> 200 { routing_enabled, presence, destinations: [...], unbound_roles: [...],
	           legacy_agents, gaps }

	WHY THIS EXISTS. Every fallback in the router is "broadcast", which is correct
	and is also how the feature quietly stops being a feature: a destination whose
	tablet has been asleep since 16:00 prints on every printer in the outlet and
	nothing on any screen says so. This is the screen that says so.

	`status` per destination:
	  ok        at least one live device is bound and serving it
	  degraded  bound, but every binding is to a retired machine, or a binding
	            exists and the device is not connected while another one is
	  offline   nothing online can serve it — this destination's dockets are
	            broadcasting to the whole outlet right now
	  unbound   no device has ever given it an address
	  unknown   presence could not be read (no adapter / raced fetch); NOT offline

	`legacy_agents` COUNTS SOCKETS, NOT ROWS — see legacyAgents() for why that is
	the only count worth reporting, and for why it is an upper bound that a UI must
	word as "up to N". NULL MEANS UNKNOWN, never zero.
*/
app.get("/print/health", validateAction(PERM_PRINT), async (req: Request, res: Response) => {
	const ctx = scope(req, res);
	if (!ctx) { return; }
	try {
		const [destinations, routes, bindings, online] = await Promise.all([
			ListPrintDestinations(ctx.restaurantId, ctx.outletId, { includeInactive: true }),
			ListPrintRoutes(ctx.restaurantId, ctx.outletId),
			GetPrintDeviceTargets(ctx.restaurantId, ctx.outletId, null, { includeInactive: true }),
			presence(ctx.restaurantId, ctx.outletId),
		]);

		// AFTER presence, not beside it: the count is only trustworthy when it can
		// see at least the machines outletDeviceSockets just found in the same room.
		const legacy = await legacyAgents(ctx.restaurantId, ctx.outletId, online === null ? 0 : online.size);

		const rolesByDestination = new Map<string, string[]>();
		for (const r of routes) {
			const list = rolesByDestination.get(r.destination_id);
			if (list) { list.push(r.role); } else { rolesByDestination.set(r.destination_id, [r.role]); }
		}

		const report = destinations.map((d) => {
			const bound = bindings.filter((b) => b.destination_id === d.id);
			const devices = bound.map((b) => ({
				device_id: b.device_id,
				label: b.device_label ?? b.device_key,
				platform: b.device_platform,
				target: b.target,
				priority: b.priority,
				active: b.active,
				retired: b.device_retired_at !== null,
				// A room membership, not a binding row: the rooms are what the router
				// actually reads, so a device that is connected but has NOT joined this
				// destination's room is a live mismatch worth seeing.
				serving: online === null ? null : (online.get(b.device_id)?.has(d.id) ?? false),
			}));
			// The chain the resolver would actually build: active binding, machine not
			// retired, socket present and in the room.
			const servable = devices.filter((x) => x.active && !x.retired && x.serving === true);
			let status: string;
			if (online === null) { status = "unknown"; }
			else if (bound.length === 0) { status = "unbound"; }
			else if (servable.length > 0) { status = devices.some((x) => x.retired || !x.active) ? "degraded" : "ok"; }
			else { status = "offline"; }
			return {
				id: d.id,
				name: d.name,
				active: d.active,
				roles: rolesByDestination.get(d.id) ?? [],
				devices,
				status,
			};
		});

		res.json({
			routing_enabled: isPrintRoutingSchemaReady(),
			presence: online === null ? "unknown" : "ok",
			destinations: report,
			// A rule pointing at a destination that no longer exists cannot happen
			// (042 cascades), but a rule pointing at a DEACTIVATED one can, and it
			// silently broadcasts. Name it.
			unbound_roles: routes
				.filter((r) => !r.destination_active || !bindings.some((b) => b.destination_id === r.destination_id && b.active))
				.map((r) => r.role),
			legacy_agents: legacy,
			// An upper bound, stated in the payload so the screen cannot render it as
			// a census. See legacyAgents(): nothing in the join payload separates a
			// dashboard tab from a printer agent that will print every broadcast.
			legacy_agents_note: legacy === null
				? "Could not read this outlet's sockets, so this is unknown — not zero."
				: "Connected clients with no print identity. The C# agent and pre-routing app builds are in this number and will print every broadcast; so are dashboards and phones that never print. Read it as an upper bound.",
			// Said out loud rather than left as a missing key somebody reads as
			// "nothing to report". It is owed; it cannot be served from this lane.
			gaps: [
				"route_trace: the per-job \"why did the bar docket print at the pass?\" trace needs a read over \"PrintJobs\" routing columns that the data layer does not export yet.",
			],
		});
	} catch (err) {
		logger.error({ err }, "print_health_failed");
		res.status(500).json({ error: "Unable to read print health" });
	}
});

/*
	Push a test slip DOWN THE REAL ROUTING PATH.

	POST /print/test  body { role?: "bill" | "kot" | "kot:<STATION>" }
	  -> 200 { results: [{ role, destination, device, mode, reason, jobId }], skipped }
	  -> 400 when nothing is routed and no role was named

	THE POINT IS THAT IT PROVES THE SERVER'S DECISION, NOT THE CABLE. It resolves,
	assigns, emits, and leaves the job on the same ladder every real docket rides,
	so the answer it returns is the answer a real bill would have got: which
	destination matched, which machine was chosen, or — just as useful — that the
	job broadcast and why. A test that emitted straight at a printer would prove
	the one thing nobody doubts.

	WITH NO `role`, IT TESTS EVERY CONFIGURED ROLE. With no role AND no routes it
	REFUSES, rather than dispatching an unrouted slip that would broadcast to every
	printer in the building: somebody pressing "test" on an unconfigured outlet
	should not get paper out of every machine in the restaurant. Naming a role
	explicitly still works in that state, because "what would happen to a bar
	docket today?" is a fair question and the honest answer is "it broadcasts".

	THE SLIP IS A KOT-SHAPED SLIP EVEN FOR THE BILL ROLE, deliberately: a test slip
	must never be mistakable for a money document, and the KOT renderer produces a
	short, plainly-labelled ticket. The ROLE still decides the routing (kind 'bill'
	resolves the bill rule), so what is being tested is unaffected by what the
	paper looks like.
*/
app.post("/print/test", validateAction(PERM_PRINT), async (req: Request, res: Response) => {
	const ctx = scope(req, res);
	if (!ctx) { return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const askedRole = body.role === undefined || body.role === null ? null : canonicalPrintRole(body.role);
	if (body.role !== undefined && body.role !== null && !askedRole) {
		res.status(400).json({ error: `"${String(body.role)}" is not a print role. Use "bill", "kot", or "kot:<STATION>".` });
		return;
	}
	try {
		let roles: string[];
		if (askedRole) {
			roles = [askedRole];
		} else {
			const configured = await ListPrintRoutes(ctx.restaurantId, ctx.outletId);
			roles = [...new Set(configured.map((r) => canonicalPrintRole(r.role)).filter((r): r is string => r !== null))];
			if (roles.length === 0) {
				res.status(400).json({
					error: "Nothing is routed in this outlet yet, so a test slip would print on every printer. Create a destination and a rule first, or name a role to test.",
				});
				return;
			}
		}
		const skipped = Math.max(0, roles.length - MAX_TEST_ROLES);
		roles = roles.slice(0, MAX_TEST_ROLES);

		const profile = await GetRestaurantProfile(ctx.restaurantId).catch(() => null);
		const restaurantName = profile?.outlet_name || profile?.restaurant_name || "Printer test";
		// THE TEST SLIP PRINTS IN THIS RESTAURANT'S OWN KOT STYLE, and this is the
		// one place where that matters most. The slip's whole job is to answer "does
		// paper come out of that machine?" — so it has to be made of the same bytes
		// the machine will be sent at service. A slip that always printed as text
		// would come out clean on a printer that cannot draw the raster docket and
		// tell the owner their setup is fine, which is the exact false negative this
		// button exists to rule out. It is also the fastest way to CHECK the switch:
		// flip to Classic, press test, read the paper.
		const kotPrintStyle = await GetKotPrintStyle(ctx.restaurantId);
		// And at the restaurant's own type size, for the same reason: an owner who
		// has just picked "Small" presses this to see what the kitchen will get.
		const kotTextSize = await GetKotTextSize(ctx.restaurantId);
		const stamp = new Date();
		const results: Record<string, unknown>[] = [];
		for (const role of roles) {
			const kind: "bill" | "kot" = role === "bill" ? "bill" : "kot";
			const station = role.startsWith("kot:") ? role.slice(4) : null;
			// ONE ticket, because there is one item and buildKotBase64 splits by
			// station. `[0]` is guarded anyway: a renderer that returned nothing must
			// skip the role, not dispatch `undefined` bytes.
			const ticket = buildKotBase64({
				restaurantName,
				table: "PRINTER TEST",
				covers: 0,
				items: [{ name: `Printer test — ${role}`, quantity: 1, price: 0, station }],
				total: 0,
				// A test slip has no money on it; the renderer still wants a symbol.
				currency: "₹",
				kind: "kot",
				kotNo: null,
				printedAt: stamp.toISOString().slice(0, 16).replace("T", " "),
				orderContext: "Printer test",
				station,
				kotPrintStyle,
				kotTextSize,
			}, TEST_SLIP_COLS)[0];
			if (!ticket) { continue; }
			// bill_id is TEXT and is the handle a human uses to find this job in the
			// queue afterwards. Stamped with the clock so two presses are two rows —
			// a test slip is deliberately not deduplicated.
			const billId = `print-test-${stamp.getTime()}-${role.replace(/[^a-z0-9:]+/gi, "-")}`;
			const dispatched = await dispatchPrintJob(ctx.restaurantId, {
				outlet_id: ctx.outletId,
				bill_id: billId,
				kind,
				station,
				esc_base64: ticket.escBase64,
			});
			results.push({
				role,
				jobId: dispatched.jobId,
				mode: dispatched.decision.mode,
				reason: dispatched.decision.reason,
				destination: dispatched.decision.destinationName,
				destinationId: dispatched.decision.destinationId,
				device: dispatched.assignedDeviceId,
			});
		}
		try {
			await log_audit(req, PERM_PRINT, `Printed ${results.length} test slip(s)`, Audit_log_category.General, {
				outlet_id: ctx.outletId, roles: results.map((r) => r.role),
			});
		} catch (err) { logger.warn({ err }, "log_audit print_test failed"); }
		res.json({ results, skipped });
	} catch (err) {
		logger.error({ err }, "print_test_failed");
		res.status(500).json({ error: "Unable to send a test slip" });
	}
});

}
