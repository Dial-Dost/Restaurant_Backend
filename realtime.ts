import type { Server as HttpServer } from "http";
import { Server } from "socket.io";
import { createClient } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";
import { getSession, type SessionPayload } from "./auth/sessions.js";
import { logger } from "./observability.js";
import { resumeJitterMs, resumePrintJobsForAgent } from "./print_jobs.js";
// STATIC, and safe to be static: print_jobs.js (imported above) already pulls
// database_supabase.js into this module's graph, so this adds no edge and no
// cycle. print_routing.js is the one that must stay lazy — it imports THIS file.
import { GetPrintDeviceTargets, ListPrintDevices, withTenant } from "./database_supabase.js";

export let io: Server | null = null;

// Whether the Redis pub/sub adapter is wired. When false on a multi-replica
// deployment, realtime events (bill:print, KDS, orders) only reach clients on the
// same replica. Surfaced in /health so the degradation isn't silent.
let adapterReady = false;
export function realtimeAdapterReady(): boolean {
  return adapterReady;
}

/* ------------------------------------------------------------------------- *
 * PRINT ROUTING ROOMS
 *
 * Three rooms per outlet. Only the first existed before server-decided print
 * routing, and it still means exactly what it always meant:
 *
 *   restaurant:<res>:outlet:<o>                    every printing client. BROADCAST.
 *   restaurant:<res>:outlet:<o>:dev:<deviceId>     AT MOST ONE SOCKET. The address.
 *   restaurant:<res>:outlet:<o>:dest:<destId>      one per active binding. The directory.
 *
 * A directed job is emitted to a dev: room and therefore NEVER enters the outlet
 * room. That is the whole reason routing cannot double-print: the C# agent
 * (C_Sharp_temp_printer_server/MainPage.xaml.cs:296-337 prints whatever it is
 * handed, unconditionally, and cannot ack) only ever sees broadcasts, so it can
 * never receive a job that another device was also given.
 *
 * The dest: rooms are the routing DIRECTORY, not a delivery address — nothing is
 * ever emitted to one. They exist so a replica can answer "who can serve this
 * destination right now" out of the adapter instead of the database, and so the
 * disconnect handler can notice a destination going dark.
 * ------------------------------------------------------------------------- */

const outletRoom = (resId: string, outletId: string): string =>
  `restaurant:${resId}:outlet:${outletId}`;
const deviceRoom = (resId: string, outletId: string, deviceId: string): string =>
  `${outletRoom(resId, outletId)}:dev:${deviceId}`;
const destinationRoomPrefix = (resId: string, outletId: string): string =>
  `${outletRoom(resId, outletId)}:dest:`;
const destinationRoom = (resId: string, outletId: string, destinationId: string): string =>
  `${destinationRoomPrefix(resId, outletId)}${destinationId}`;

const DEST_ROOM_RE = /^restaurant:([^:]+):outlet:([^:]+):dest:(.+)$/;

/**
 * Room names are colon-delimited and built by string concatenation, so an id
 * carrying a colon could name a room it does not own (a "deviceId" of
 * `x:dest:<other>` would otherwise mint a destination room). Every id that
 * reaches these builders is a server-minted uuid or a client ULID; this exists
 * only so a malformed or hostile client cannot forge a room name, and so a
 * garbage id fails closed instead of quietly creating an unreachable room.
 *
 * EVERY id, and that emphatically INCLUDES outletId. The dev: and dest: room
 * names are suffix-extensions of the outlet room name, so an outletId is not a
 * lesser input than a deviceId — it is the PREFIX of the whole print namespace.
 * Before routing existed, joinOutlet took payload.outletId on a bare
 * `typeof === 'string'` and a colon in it merely produced a useless room. Once
 * emitDevice started delivering guest bills to `…:outlet:<o>:dev:<d>`, the same
 * laxity let any authenticated socket in the tenant join
 * `{outletId: "<real-outlet>:dev:<victim-device>"}` and sit inside another
 * device's DELIVERY room — which breaks the one property the no-double-print
 * argument rests on (a directed emit reaches exactly one client). Same treatment,
 * same reason.
 */
const ROOM_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
function safeRoomId(raw: unknown): string | null {
  if (typeof raw !== "string") { return null; }
  const t = raw.trim();
  // The character class excludes ':' deliberately — it is the room separator, and
  // an id allowed to carry one could name any room in the namespace.
  return ROOM_ID_RE.test(t) ? t : null;
}

/** How many destination rooms one device may hold. The binding table is the only
 *  source of these now, so this is no longer a guard against a client assertion —
 *  it bounds the blast radius of a fat-fingered config (or a corrupted row set)
 *  turning one till into a member of every room in the outlet. A till binds a
 *  handful of printers; past this the excess is dropped and logged. */
const MAX_DESTINATIONS_PER_DEVICE = 32;

/**
 * A job id at the socket edge.
 *
 * "PrintJobs".id is `uuid primary key default gen_random_uuid()`
 * (migrations/027:35), so anything else is not a job this server ever minted.
 * Checking the shape HERE is the point: `handlePrintBeat` used to forward any
 * non-empty string into print_routing, which opens a tenant transaction per beat.
 * A looping or hostile client could therefore drive an unbounded stream of
 * checkouts against the 15-slot session pooler — the exact mechanism behind the
 * 2026-08-24 standstill this feature's whole escalation model is shaped to avoid —
 * and a non-uuid additionally raised 22P02 *inside* that transaction, so the
 * garbage cost a session before it was rejected. Losing that argument costs the
 * restaurant every route, not just printing.
 */
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Per-socket beat budget: the second half of the same argument.
 *
 * A valid-looking uuid is free to generate, so the shape check alone still leaves
 * one session per emit available to a client in a loop. This is a plain in-memory
 * bucket on the socket rather than routes/_shared.ts's `rateLimit`, and that is
 * deliberate on two counts: that helper is Express middleware — it wants
 * (req, res, next) and answers with a 429, neither of which exists on a one-way
 * socket beat — and it awaits the shared session store, which would put a Redis
 * round trip on the one path whose entire justification is that it costs none.
 * Per-socket and per-replica is the right grain anyway: the thing being bounded is
 * one client's emit rate, not a tenant's.
 *
 * A KOT fans out to several station dockets at once, so the ceiling is a burst,
 * not one-per-second. Over budget the beat is dropped, which costs that job one
 * escalation deadline — which is what the deadline is for.
 */
const BEAT_WINDOW_MS = 1000;
const BEAT_MAX_PER_WINDOW = 20;

/**
 * Presence lookups are wrapped in this because they cross replicas: with the
 * Redis adapter, fetchSockets() is a request/response round trip over pub/sub
 * and a wedged or slow Redis would otherwise hold a print hot path open for as
 * long as it liked. 750ms is well under the client's own patience and well over
 * a healthy round trip.
 */
const PRESENCE_TIMEOUT_MS = 750;

/** Grace before a now-empty destination room is called offline. A deploy or an
 *  app restart drops the socket and re-establishes within a second or two; an
 *  alert on every deploy is an alert the owner learns to ignore. Note this is on
 *  top of pingTimeout — a device yanked off Wi-Fi has already been silent for up
 *  to 90s before 'disconnecting' even fires. */
const DESTINATION_OFFLINE_GRACE_MS = 5000;

/** Re-alert window per destination room. A redeploy can drop three sockets out of
 *  one destination room at once and every one of them would otherwise find the
 *  room empty and fire. */
const DESTINATION_OFFLINE_REALERT_MS = 5 * 60 * 1000;
const destinationOfflineAlertedAt = new Map<string, number>();

/** What a routing decision needs to know about one connected printing client.
 *  This is what fetchSockets() gives a replica that never saw the socket. */
export interface PrintSocketInfo {
  socketId: string;
  deviceId: string;
  outletId: string;
  /** Derived from the socket's dest: ROOMS, not from socket.data — see
   *  syncDeviceRooms: rooms are the only binding state that can be changed on a
   *  remote replica's socket. */
  destinations: string[];
  platform: string | null;
  agentVersion: string | null;
  /** False for a client that named no agentVersion. It has no per-job dedup and
   *  no way to ack (the same interlock resumePrintJobsForAgent enforces), so a
   *  directed job to it is a silent drop waiting for the accept deadline. It
   *  still holds its dev: room so revoke and superseded reach it. */
  ready: boolean;
  /** Newest-wins tiebreak. Only load-bearing in the window where a superseded
   *  clone is still in the outlet room but has not yet left its dev: room. */
  joinedAt: number;
}

/* ------------------------------------------------------------------------- *
 * THE DEVICE REGISTRY SNAPSHOT — why this file reads the database at all
 *
 * Two things used to be taken from the joinOutlet payload and believed:
 *
 *   WHO the socket is. Any authenticated session — a waiter's phone — could
 *   name any deviceId, and claiming it EVICTED whoever held that dev: room. The
 *   till kept socket.data.print and the outlet room but stopped being a chain
 *   candidate, while its address was answered by a client that will never print.
 *   Nothing was lost (the ladder still ends in a broadcast) but every bill first
 *   burned the 4s accept deadline, and the printer screen showed the impostor as
 *   "online", so the cause was invisible.
 *
 *   WHAT it serves. The dest: rooms were built from a client-supplied array, so a
 *   device could volunteer for another device's destinations and start receiving
 *   its dockets — and, worse in practice, the reverse: a till bound by the owner
 *   while it was OFFLINE reconnects with a stale local cache, joins zero dest:
 *   rooms, is filtered out of every chain, and the destination resolves
 *   `no_device_online` forever. That is the dead control syncDeviceRooms exists to
 *   kill, merely moved: the owner's decision was overwritten by the client's cache
 *   on the next flap.
 *
 * Both answers live in "PrintDevices" / "PrintDeviceTargets", so both are read
 * here, together, once per outlet per TTL, OFF the synchronous path.
 *
 * POOL SAFETY, and why this one memo DOES store an in-flight promise when
 * print_routing.ts's caches deliberately do not. That rule exists because a
 * resolver called from a request path already holds a pooled connection, so
 * awaiting somebody else's promise pins yours — the 2026-08-24 shape. Here the
 * reasoning inverts: a socket handler holds NO connection, and a redeploy
 * reconnects the whole fleet inside a second or two. Independent misses would be
 * one checkout per till against fifteen slots; coalescing makes it one checkout
 * per outlet, and the waiters are detached callbacks holding nothing at all.
 *
 * Every failure mode lands on the same answer — an empty snapshot, no dev: room,
 * no chain, broadcast — which is this outlet's behaviour before routing existed.
 * That covers a backend running ahead of 042 (routingQuery degrades 42P01/42501/
 * 42703 to empty rows), a pool that cannot give us a connection, and a wedged
 * database alike.
 * ------------------------------------------------------------------------- */

interface OutletDeviceSnapshot {
  at: number;
  /** "PrintDevices".id -> the destination ids that machine is ACTIVELY bound to
   *  in this outlet. Present-with-an-empty-array is a registered machine nobody
   *  has bound yet; absent is a machine this restaurant does not have. */
  byDevice: Map<string, string[]>;
  /** device_key (the client-minted ULID) -> "PrintDevices".id. The brief has the
   *  client send the server uuid on joinOutlet, but accepting its own key and
   *  normalising to the uuid here costs one map and removes a whole class of
   *  "the client wired the other id" bug from a client that is not built yet.
   *  Everything downstream — rooms, chains, binding rows — is keyed on the uuid. */
  byKey: Map<string, string>;
  /** True when the registry could not be read at all. Cached like any other
   *  answer so a database outage costs one query per outlet per TTL rather than
   *  one per reconnecting till, and treated exactly like "no such device":
   *  unverified, no dev: room, broadcast. */
  unknown: boolean;
}

/** Matches print_routing.ts's route/binding TTL. A rebinding reaches a socket
 *  that is already connected through syncDeviceRooms (that is the whole point of
 *  that export); this window only bounds how stale a JOINING socket's view can be. */
const DEVICE_SNAPSHOT_TTL_MS = 10_000;
/** Bounded so a long-lived process cannot accumulate one entry per outlet the
 *  fleet has ever touched. Cleared wholesale rather than evicted one at a time —
 *  the next miss costs one query. */
const DEVICE_SNAPSHOT_MAX = 64;
const deviceSnapshots = new Map<string, OutletDeviceSnapshot>();
const deviceSnapshotInFlight = new Map<string, Promise<OutletDeviceSnapshot>>();

/** Never rejects: every caller's fallback is "unverified", and a throw escaping
 *  into the coalescing map would reject every till waiting on it. */
async function loadOutletDeviceSnapshot(resId: string, outletId: string): Promise<OutletDeviceSnapshot> {
  const snap: OutletDeviceSnapshot = {
    at: Date.now(), byDevice: new Map(), byKey: new Map(), unknown: false,
  };
  try {
    // ONE tenant transaction for both statements. A socket handler has no ambient
    // tenant, and without withTenant these run on the bare pool with no
    // app.res_id GUC — under FORCE ROW LEVEL SECURITY that is not an error, it is
    // ZERO ROWS, which would silently mean "no device in this restaurant is real".
    await withTenant({ res_id: resId, outlet_id: outletId, employeeId: "", role: "" }, async () => {
      // Restaurant-wide (outletId null) on purpose: PrintDevices is res_id-unique,
      // a machine is the same machine in every branch it signs into, and its
      // outlet_id is only the branch it most recently REGISTERED under — which is
      // stale by definition at the moment a till switches branch. Retired machines
      // are excluded by default, and a retired machine must not hold a dev: room:
      // print_routing drops it from every chain anyway, so keeping the room would
      // only cost each of its destinations the accept deadline before the ladder
      // moved on.
      for (const d of await ListPrintDevices(resId, null)) {
        snap.byDevice.set(d.id, []);
        if (d.device_key) { snap.byKey.set(d.device_key, d.id); }
      }
      // Bindings ARE outlet-scoped: an address is a fact about one LAN.
      for (const b of await GetPrintDeviceTargets(resId, outletId, null)) {
        if (!b.active || b.device_retired_at !== null) { continue; }
        const list = snap.byDevice.get(b.device_id);
        // A binding whose machine is retired or gone. Left to fall through to
        // broadcast; GET /print/health is where that is meant to be visible.
        if (!list) { continue; }
        if (list.includes(b.destination_id)) { continue; }
        if (list.length >= MAX_DESTINATIONS_PER_DEVICE) {
          logger.warn(
            { outletId, deviceId: b.device_id },
            "print_device_destination_cap_reached",
          );
          continue;
        }
        list.push(b.destination_id);
      }
    });
  } catch (err) {
    snap.unknown = true;
    logger.error({ err, outletId }, "print_device_registry_unavailable");
  }
  return snap;
}

function outletDeviceSnapshot(resId: string, outletId: string): Promise<OutletDeviceSnapshot> {
  const key = `${resId}|${outletId}`;
  const hit = deviceSnapshots.get(key);
  if (hit && Date.now() - hit.at < DEVICE_SNAPSHOT_TTL_MS) { return Promise.resolve(hit); }
  const inFlight = deviceSnapshotInFlight.get(key);
  if (inFlight) { return inFlight; }
  const work = loadOutletDeviceSnapshot(resId, outletId)
    .then((snap) => {
      if (deviceSnapshots.size >= DEVICE_SNAPSHOT_MAX) { deviceSnapshots.clear(); }
      deviceSnapshots.set(key, snap);
      return snap;
    })
    .finally(() => { deviceSnapshotInFlight.delete(key); });
  deviceSnapshotInFlight.set(key, work);
  return work;
}

/**
 * Race a cross-replica adapter call against PRESENCE_TIMEOUT_MS.
 *
 * Returns null on timeout OR on failure, and the caller MUST treat null as "I
 * could not find out", never as "nobody is there". The two lead to different
 * decisions: an empty chain means broadcast immediately with a destination-offline
 * alert, while an unknown chain means broadcast without crying wolf.
 */
async function raceAdapter<T>(work: Promise<T>, label: string): Promise<T | null> {
  // Attached before the race so a rejection arriving AFTER the timeout has a
  // handler; without this a slow-then-failing fetchSockets is an unhandled
  // rejection that can take the process down.
  const guarded: Promise<T | null> = work.then(
    (v) => v,
    (err: unknown) => { logger.error({ err }, `${label}_failed`); return null; },
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => { resolve(null); }, PRESENCE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const res = await Promise.race([guarded, timeout]);
    if (res === null) { logger.warn({ label }, "realtime_adapter_call_unavailable"); }
    return res;
  } finally {
    if (timer) { clearTimeout(timer); }
  }
}

/** Pull the dest: room ids for one outlet out of a socket's room set. */
function destinationsFromRooms(rooms: Iterable<string>, resId: string, outletId: string): string[] {
  const prefix = destinationRoomPrefix(resId, outletId);
  const out: string[] = [];
  for (const room of rooms) {
    if (room.startsWith(prefix)) { out.push(room.slice(prefix.length)); }
  }
  return out;
}

/**
 * Build a PrintSocketInfo, or null if this socket must never be a routing
 * candidate. Returning null is the back-compat story: the C# agent and any
 * Flutter build that predates routing carry no socket.data.print, so they are
 * never targeted and never counted as presence — they simply keep every
 * broadcast, which is the only safe role for a client that cannot report what it
 * did with a job.
 */
function printSocketInfo(
  socketId: string,
  data: any,
  rooms: Iterable<string>,
  resId: string,
  outletId: string,
): PrintSocketInfo | null {
  const print = data && typeof data === "object" ? data.print : null;
  if (!print || typeof print !== "object") { return null; }
  const deviceId = safeRoomId(print.deviceId);
  if (!deviceId) { return null; }
  if (print.outletId !== outletId) { return null; }
  // DEV-ROOM MEMBERSHIP IS THE PRESENCE TEST, not the presence of socket.data.
  // A superseded clone keeps its socket.data.print and stays in the outlet room
  // (deliberately — it is never silenced), but it has left its dev: room, and it
  // must not be handed jobs the newest socket is answering for.
  const roomSet = rooms instanceof Set ? rooms : new Set(rooms);
  if (!roomSet.has(deviceRoom(resId, outletId, deviceId))) { return null; }
  return {
    socketId,
    deviceId,
    outletId,
    destinations: destinationsFromRooms(roomSet, resId, outletId),
    platform: typeof print.platform === "string" ? print.platform : null,
    agentVersion: typeof print.agentVersion === "string" ? print.agentVersion : null,
    ready: print.ready === true,
    joinedAt: typeof print.joinedAt === "number" ? print.joinedAt : 0,
  };
}

export async function initRealtime(httpServer: HttpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        // Allow all origins in development and production
        callback(null, true);
      },
      methods: ["GET", "POST", "OPTIONS"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
    pingInterval: 30000,
    pingTimeout: 60000,
  });

  // Redis adapter for multi-process scaling. Required in production for realtime
  // to reach clients across replicas; without it, events stay on one replica.
  // How long boot will wait for the Redis adapter before going on without it.
  // Generous enough for a cold container on a shared network, short enough that
  // a restaurant is never kept off the air by a cache.
  const REDIS_CONNECT_TIMEOUT_MS = Math.max(1000, Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 8000);
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    // DECLARED OUTSIDE THE TRY so the catch can shut them down. A client that
    // failed to connect is still retrying, and the handler below has to be able
    // to reach it — see the note there.
    let pubClient: ReturnType<typeof createClient> | undefined;
    let subClient: ReturnType<typeof createClient> | undefined;
    try {
      pubClient = createClient({ url: redisUrl });
      subClient = pubClient.duplicate();
      // node-redis emits 'error' on connection drops; without a listener that can
      // crash the process. Log and let node-redis auto-reconnect.
      pubClient.on("error", (err) => { logger.error({ err }, "socketio_redis_pub_error"); });
      subClient.on("error", (err) => { logger.error({ err }, "socketio_redis_sub_error"); });
      // BOUNDED, BECAUSE connect() DOES NOT GIVE UP ON ITS OWN.
      //
      // node-redis's default reconnect strategy retries FOREVER, so against an
      // address with nothing behind it this promise never settles — it does not
      // reject either, which means the catch below, written to degrade to
      // single-replica, was unreachable. The whole boot sequence awaits this, so
      // a Redis that is down, wrong or firewalled did not cost the adapter: it
      // cost the SERVER. Nobody had hit it because REDIS_URL has only ever been
      // set where a Redis really was, and nothing in CI called initRealtime
      // until the print-routing suite did.
      //
      // A race rather than a socket timeout because the failure to bound is in
      // the RETRY LOOP, not in any one attempt: a per-attempt timeout would be
      // re-armed forever by the same strategy. The clients are told to stop on
      // the way out so a late connection cannot resurrect a half-built adapter,
      // and the timer is unref'd so it can never be the thing holding a process
      // (or a test runner) open.
      let bail: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.all([pubClient.connect(), subClient.connect()]),
          new Promise((_resolve, reject) => {
            bail = setTimeout(() => { reject(new Error(`redis adapter did not connect within ${String(REDIS_CONNECT_TIMEOUT_MS)}ms`)); }, REDIS_CONNECT_TIMEOUT_MS);
            bail.unref?.();
          }),
        ]);
      } finally {
        if (bail) { clearTimeout(bail); }
      }
      io.adapter(createAdapter(pubClient, subClient));
      adapterReady = true;
      logger.info("Socket.IO redis adapter connected");
    } catch (err) {
      adapterReady = false;
      // STOP THE CLIENTS. They are still retrying on their own schedule, and a
      // node-redis client mid-reconnect is an open handle: left alone it keeps
      // this process — and a test runner — alive forever, and can attach an
      // adapter to `io` minutes after boot decided to go without one.
      for (const c of [pubClient, subClient]) {
        try { void c?.destroy?.(); } catch { /* already gone */ }
      }
      logger.error({ err }, "Failed to initialize redis adapter for socket.io:");
      if (process.env.NODE_ENV === "production") {
        logger.error(
          "WARNING: running in production WITHOUT a socket.io Redis adapter — realtime " +
            "events will not reach clients on other replicas.",
        );
      }
    }
  } else if (process.env.NODE_ENV === "production") {
    logger.warn(
      "REDIS_URL not set — socket.io has no Redis adapter; realtime is single-replica only.",
    );
  }

  // SYNCHRONOUS, AND THAT IS THE FIX. This handler used to be `async`: it awaited
  // the session lookup and only THEN attached its listeners. Socket.IO has already
  // sent CONNECT by the time 'connection' handlers run, and it dispatches incoming
  // events with no buffering — so the printer agent, which emits joinOutlet the
  // instant it sees CONNECT, raced a Redis round trip. Whenever the lookup lost
  // (a cold store after every deploy, a busy event loop during a fleet-wide
  // reconnect) the join went to a socket with no listener and vanished: no room,
  // no replay, no answer, a till showing "Connected" that never printed again
  // until somebody restarted the app. Every listener is now attached before this
  // function returns and waits on the lookup itself.
  io.on("connection", (socket) => {
    // Derive the tenant from the verified session token, never from a
    // client-supplied restaurantId — otherwise a client could subscribe to
    // another restaurant's realtime events.
    const auth = socket.handshake.auth as any || {};
    const token = typeof auth.token === "string" ? auth.token : null;

    // THREE ANSWERS, NOT TWO. A session, `null` (the store answered: this token is
    // not a session) and `undefined` (the store could not be asked). Only `null`
    // may ever be reported to the client as a rejection — the app signs its user
    // out on that word, and a Redis blip must not sign out every till at once.
    const lookupSession = (t: string): Promise<SessionPayload | null | undefined> =>
      getSession(t).catch((err: unknown) => {
        logger.error({ err, socketId: socket.id }, "socket_session_lookup_failed");
        return undefined;
      });
    let lookup: Promise<SessionPayload | null | undefined> = token ? lookupSession(token) : Promise.resolve(null);
    // MEMOISED: one store read per connection, exactly as before, however many
    // events wait on it. A lookup that FAILED is retried once by the next waiter
    // — shared by every waiter already queued behind it, so a burst of events
    // costs one retry, not one each — instead of leaving a live socket deaf for
    // the rest of its life over a single store timeout. Waiters resume in the
    // order they arrived, so join-then-leave is never applied as leave-then-join.
    const resolveSession = async (): Promise<SessionPayload | null | undefined> => {
      const seen = lookup;
      const first = await seen;
      if (first !== undefined || !token) { return first; }
      if (lookup === seen) { lookup = lookupSession(token); }
      return lookup;
    };
    // The restaurant room, joined ONCE, the first time the session is known — the
    // same room on the same condition as before, for every socket (KDS, orders,
    // dashboards and printers alike). Once, so a later event can never undo a
    // client's own "leave".
    let admitted = false;
    const admit = (session: SessionPayload): void => {
      if (admitted) { return; }
      admitted = true;
      socket.join(`restaurant:${session.res_id}`);
    };
    // Every tenant-scoped listener goes through here. The connected check matters
    // because the wait is now INSIDE the listener: a socket that disconnected
    // while its lookup was in flight must not be put back into a room it has
    // already been removed from, where it would sit as a dead member forever.
    const onAuthed = (
      event: string,
      handler: (session: SessionPayload, payload: any) => void,
      onRejected?: () => void,
    ): void => {
      socket.on(event, (payload: any) => {
        resolveSession()
          .then((session) => {
            if (!socket.connected) { return; }
            if (session) {
              // A no-op on the normal path (the connection-level wait below got
              // there first); the admission for a socket whose first lookup failed.
              admit(session);
              handler(session, payload);
              return;
            }
            if (session === null && onRejected) { onRejected(); }
          })
          .catch((err: unknown) => { logger.error({ err, event, socketId: socket.id }, "socket_event_failed"); });
      });
    };

    // Attached BEFORE any listener, so it resolves ahead of every queued event and
    // a joinOutlet is never handled on a socket still outside its restaurant.
    void resolveSession().then((session) => {
      if (session) {
        if (socket.connected) { admit(session); }
        return;
      }
      if (session === null) {
        // Connect but join no tenant rooms and ignore join requests, so an
        // unauthenticated socket never receives any restaurant's events.
        logger.warn({ socketId: socket.id }, "socket connected without a valid session; no rooms joined");
      }
    });

    // All room operations are pinned to the caller's own restaurant.
    onAuthed("join", (session, rid: string) => {
      if (rid === session.res_id) {socket.join(`restaurant:${session.res_id}`);}
    });

    onAuthed("leave", (session, rid: string) => {
      if (rid === session.res_id) {socket.leave(`restaurant:${session.res_id}`);}
    });

    // THE RECONNECT HOOK. The printer agent re-emits joinOutlet on every connect
    // AND every reconnect, so this is already the exact moment a till comes back —
    // no new client-side trigger had to be invented for replay.
    //
    // ANSWERED EITHER WAY. joinedOutlet on success has always been sent; a dead
    // session used to get silence, which to the agent looked exactly like a slow
    // server, so it waited forever. It now hears joinRejected and can send its
    // user to sign in. The socket is deliberately NOT disconnected: the Dart
    // client treats a server-side disconnect as final and never reconnects, which
    // would turn a recoverable sign-in into a till that stays offline for good.
    onAuthed("joinOutlet", (session, payload: any) => {
      const resId = session.res_id;
      const employeeId = session.employeeId;
      const role = session.role;
      // safeRoomId, NOT a bare typeof — see its comment. This id is the PREFIX of
      // every print room name, so a colon in it lets a socket name a dev: room it
      // does not own and receive another device's guest bills. Every real outlet
      // id is a uuid, so nothing legitimate changes shape here.
      const o = safeRoomId(payload ? payload.outletId : null);
      if (!o && payload && typeof payload.outletId === 'string') {
        logger.warn({ socketId: socket.id }, "joinOutlet rejected an unusable outletId");
      }
      // ADDITIVE and optional. A build that predates durable printing sends no
      // version and is never replayed to (resumePrintJobsForAgent's interlock):
      // it has no per-job dedup and no way to ack, so replaying to it would
      // reprint the outstanding backlog on every socket flap, forever.
      const rawVersion = payload && typeof payload.agentVersion === 'string' ? payload.agentVersion.trim() : "";
      const agentVersion = rawVersion.length > 0 ? rawVersion : null;
      // ALSO ADDITIVE. A client that sends neither of these behaves exactly as it
      // did before routing existed: outlet room only, broadcast only, never a
      // candidate. That is the entire "new backend, old apps" compatibility story
      // and it is worth keeping literal — nothing below this line may change what
      // happens when deviceId is absent.
      const claimedDeviceId = safeRoomId(payload ? payload.deviceId : null);
      const platform = payload && typeof payload.platform === 'string'
        ? payload.platform.trim().slice(0, 32) || null
        : null;
      // payload.destinations IS DELIBERATELY NOT READ. It used to decide which
      // dest: rooms this socket joined, i.e. which dockets it received, which made
      // "what do you serve" a client assertion — a device could volunteer for
      // another device's destinations, and a device whose local cache was stale
      // could silently un-bind itself from the owner's decision. The binding table
      // is the answer now; see outletDeviceSnapshot. Not reading the array at all
      // also disposes of the old bound: MAX_DESTINATIONS_PER_DEVICE capped the
      // rooms JOINED but not the array walked, so a million-element list was a
      // million iterations inside a synchronous handler, blocking every other
      // tenant's realtime traffic on this replica.
      if (o) {
        socket.join(outletRoom(resId, o));
        socket.emit('joinedOutlet', { restaurantId: resId, outletId: o });
        logger.info(`Socket ${socket.id} joined restaurant:${resId}:outlet:${o}`);
        if (claimedDeviceId) {
          // socket.data.print IS NOT WRITTEN HERE ANY MORE, and the reason is the
          // whole of the identity fix: the claim is unverified at this instant. A
          // socket carrying socket.data.print is a socket that can send accept and
          // reject beats for that deviceId, so writing it before the registry says
          // the machine exists would hand a waiter's phone the till's beats even
          // when the dev: room join is later refused. claimDeviceRooms writes the
          // identity and joins the room together, once, after verification — which
          // is also the honest invariant, since an identity without dev: room
          // membership is not addressable and printSocketInfo fails it closed.
          void claimDeviceRooms(socket, resId, o, employeeId, claimedDeviceId, platform, agentVersion)
            .catch((err: unknown) => { logger.error({ err }, "print_device_room_join_failed"); });
        }
        // Deliberately NOT awaited and deliberately jittered. The room join must
        // be immediate (live printing depends on it) and a fleet-wide reconnect
        // must not turn into a fleet-wide simultaneous query. Errors are swallowed
        // inside resumePrintJobsForAgent; the catch here only covers a scheduling
        // failure so an unhandled rejection can never take the process down.
        const timer = setTimeout(() => {
          void resumePrintJobsForAgent({
            resId,
            outletId: o,
            // socket.id is stable for this connection and changes on reconnect,
            // which is exactly the identity a lease wants: diagnostic in
            // claimed_by, and never reused by a socket that has gone away.
            agentId: socket.id,
            agentVersion,
            // The reconnect door: a device that flapped mid-print can pick its own
            // lapsed assignment straight back up instead of waiting for the
            // escalation ladder. Null for a build with no device identity, which
            // matches precisely the jobs it can see today.
            //
            // READ AT FIRE TIME, NOT AT JOIN TIME, and only from socket.data: it is
            // the VERIFIED, registry-normalised id, and it is the one this claim
            // predicate may see. Feeding it the raw payload claim would let any
            // authenticated socket name another device and pick up that device's
            // lapsed assignment — a docket delivered to a phone that cannot print
            // it. If verification has not finished yet (this timer is jittered, so
            // it usually has) the value is null, which selects precisely today's
            // legacy row set.
            deviceId: verifiedDeviceId(socket),
            employeeId,
            role,
            deliver: (p) => { socket.emit('bill:print', p); },
          }).catch((err: unknown) => { logger.error({ err }, "print_resume_dispatch_failed"); });
        }, resumeJitterMs());
        timer.unref?.();
      }
    }, () => {
      logger.warn({ socketId: socket.id }, "joinOutlet from a socket without a valid session; rejected");
      socket.emit('joinRejected', { reason: 'session_invalid' });
    });

    onAuthed("leaveOutlet", (session, payload: any) => {
      const resId = session.res_id;
      // Same validation as joinOutlet, for the same reason and so the two cannot
      // disagree about what an outlet id is: a room this handler can never build
      // is a room joinOutlet must never have built either.
      const o = safeRoomId(payload ? payload.outletId : null);
      if (o) {
        socket.leave(outletRoom(resId, o));
        // The dev: and dest: rooms must go with it. A till switching branches keeps
        // its socket, and a socket still sitting in the old branch's dev: room
        // would keep receiving that branch's directed jobs on a printer that is
        // now a hundred kilometres away.
        const vacated = leavePrintRooms(socket, resId, (outletId) => outletId === o);
        if (vacated.length > 0) { scheduleDestinationOfflineChecks(vacated, socket.id); }
      }
    });

    /* --- the three client -> server print beats -------------------------- *
     * One-way, no ack, no round trip on the hot path. They exist to tell a
     * silent failure ("nobody heard me") apart from a working one ("somebody is
     * trying"), which is the only thing that makes a 4s accept deadline safe.
     *
     * The logic lives in print_routing.ts; this file only validates the sender
     * and hands over. deviceId and outletId come from socket.data.print, NEVER
     * from the payload — same rule as resId coming from the session: a client
     * must not be able to accept or reject another device's job.
     *
     * "Validates" now means shape and rate as well as sender: each beat costs a
     * tenant transaction downstream, so an unbounded stream of them is an
     * unbounded stream of checkouts against a fifteen-slot pooler. See JOB_ID_RE
     * and BEAT_MAX_PER_WINDOW.                                                   */
    onAuthed('print:accepted', (session, payload: any) => {
      void handlePrintBeat("accepted", socket, session.res_id, payload);
    });
    onAuthed('print:reject', (session, payload: any) => {
      void handlePrintBeat("reject", socket, session.res_id, payload);
    });
    onAuthed('print:revoked-ok', (session, payload: any) => {
      void handlePrintBeat("revoked-ok", socket, session.res_id, payload);
    });

    // Rooms are cleared before 'disconnect' fires, so the destination rooms this
    // socket was serving can only be read here.
    socket.on("disconnecting", () => {
      if (!socket.data || !socket.data.print) { return; }
      const rooms: string[] = [];
      for (const room of socket.rooms) {
        if (DEST_ROOM_RE.test(room)) { rooms.push(room); }
      }
      if (rooms.length > 0) { scheduleDestinationOfflineChecks(rooms, socket.id); }
    });
  });

  logger.info("Realtime Socket.IO initialized");
}

/**
 * Drop this socket's dev:/dest: rooms for the outlets `match` selects, and return
 * the destination rooms it vacated. The outlet room itself is never touched here
 * — leaveOutlet and disconnect own that, and a socket must keep receiving
 * broadcasts for as long as it is in the outlet.
 */
function leavePrintRooms(socket: any, resId: string, match: (outletId: string) => boolean): string[] {
  const base = `restaurant:${resId}:outlet:`;
  const vacated: string[] = [];
  // Snapshotted because socket.leave mutates the very Set being walked.
  const rooms: string[] = socket.rooms ? [...socket.rooms] : [];
  for (const room of rooms) {
    if (typeof room !== "string" || !room.startsWith(base)) { continue; }
    const rest = room.slice(base.length);
    const sep = rest.indexOf(":");
    if (sep < 0) { continue; }
    const outletId = rest.slice(0, sep);
    const tail = rest.slice(sep + 1);
    if (!tail.startsWith("dev:") && !tail.startsWith("dest:")) { continue; }
    if (!match(outletId)) { continue; }
    socket.leave(room);
    if (tail.startsWith("dest:")) { vacated.push(room); }
  }
  return vacated;
}

/** The VERIFIED device id on a socket, or null. The only id any server decision
 *  may use: it exists on socket.data solely because claimDeviceRooms found the
 *  machine in "PrintDevices" for this restaurant and gave the socket its dev:
 *  room. The raw joinOutlet claim is never it. */
function verifiedDeviceId(socket: any): string | null {
  const print = socket && socket.data ? socket.data.print : null;
  return print && typeof print.deviceId === "string" ? print.deviceId : null;
}

/** The employee whose session claimed a dev: room, off a local or a RemoteSocket.
 *  Null means "an incumbent we cannot identify" — see the contest fence. */
function socketPrintEmployee(s: any): string | null {
  const print = s && s.data ? s.data.print : null;
  return print && typeof print.employeeId === "string" && print.employeeId ? print.employeeId : null;
}

/**
 * NEWEST SOCKET WINS THE DEV ROOM — but only a socket that proved which machine
 * it is, and only against an incumbent it is entitled to displace. There is at
 * most one member, and the evicted socket stays in the outlet room, so a clone is
 * never silenced — it keeps every broadcast and is told, via
 * print:device-superseded, to say so on screen.
 *
 * WHY THERE IS NO FORK RULE (two devices claiming one identity must not trigger
 * identity surgery): pingTimeout is 60000 and pingInterval 30000, so a device
 * yanked off Wi-Fi leaves a socket the server still considers live for up to 90
 * seconds while the client itself reconnects in a second or two. A rule that
 * re-mints an identity, or splits bindings, on seeing "two" sockets would fire on
 * every ordinary Wi-Fi blip and almost never on an actual clone — and it would
 * mutate the owner's printer configuration to do it. Eviction costs a genuine
 * flap nothing at all: the old socket is simply gone.
 *
 * THE ORDER OF THE JOIN AND THE EVICTION IS LOAD-BEARING AND THE NAIVE ORDER IS
 * WRONG **ONLY UNDER REDIS**, which is to say only in production. It was written
 * evict-then-join, on the belief that the leave applies locally and synchronously
 * and that the adapter ignores its own published message. Both halves are false:
 *
 *   RedisAdapter.delSockets (node_modules/@socket.io/redis-adapter/dist/index.js:
 *   599-613) returns after PUBLISHING a REMOTE_LEAVE and applies nothing locally
 *   unless the `local` flag is set; and onrequest (:155-226) has NO same-uid guard
 *   — the `if (this.uid === uid) return` check exists only in onmessage, the
 *   BROADCAST path (:133). So the publishing replica receives its own REMOTE_LEAVE
 *   about a Redis round trip later and runs super.delSockets over the room,
 *   evicting the winner it joined synchronously milliseconds earlier.
 *
 * The in-memory adapter's delSockets IS synchronous (socket.io-adapter/dist/
 * in-memory-adapter.js:235-239), so the broken order passes every test on a dev
 * box and fails on the one deployment that matters. Its two symptoms: every dev
 * room empties ~1ms after every join, so printSocketInfo's membership test fails
 * for everyone, every chain is empty and every docket broadcasts with a spurious
 * destination-offline alert; and in the window where a dispatch wins that race,
 * the job IS directed but the later print:revoke goes to a room the assignee has
 * silently been removed from — the revoke vanishes, the assignee prints anyway,
 * and the ladder hands the same esc_base64 to D2 or to the broadcast rung. Two
 * charge slips for one table, through the very machinery meant to prevent it.
 *
 * JOIN FIRST, THEN EVICT EVERYONE ELSE BY EXCLUSION. `.except(socket.id)` works
 * because every socket is implicitly in a room named by its own id
 * (socket.io/dist/socket.js:409, `this.join(this.id)` on connect), the exclusion
 * rides along in the published request (broadcast-operator.js:337-343 →
 * redis-adapter index.js:219-225), and the in-memory apply() resolves it through
 * computeExceptSids. So the echo skips the winner on every node INCLUDING this
 * one. Do not "simplify" this back to evict-then-join because it passes locally.
 */
async function claimDeviceRooms(
  socket: any,
  resId: string,
  outletId: string,
  employeeId: string,
  claimedDeviceId: string,
  platform: string | null,
  agentVersion: string | null,
): Promise<void> {
  if (!io) { return; }
  // An outlet switch on a live socket (the owner app does this) would otherwise
  // leave the previous branch's dev:/dest: memberships in place and keep feeding
  // this socket that branch's directed jobs. The rooms it vacates are scheduled
  // for an offline check for the same reason leaveOutlet does it: a till that
  // changes branch without leaveOutlet silently empties the OLD branch's
  // destination rooms, and without this nobody is told until some unrelated socket
  // happens to leave the same room.
  const stranded = leavePrintRooms(socket, resId, (o) => o !== outletId);
  if (stranded.length > 0) { scheduleDestinationOfflineChecks(stranded, socket.id); }

  // IDENTITY IS VERIFIED, NOT ASSERTED. Until this returned, "deviceId" was only a
  // string a client typed: any authenticated session in the tenant, a waiter's
  // phone included, could name the bill till's id and take its delivery address
  // away. Every failure — an unregistered id, a retired machine, a pending 042, a
  // database we cannot reach — lands on the same fail-closed answer: no dev: room,
  // never a candidate, everything broadcasts, which is this outlet before routing.
  const snapshot = await outletDeviceSnapshot(resId, outletId);
  const deviceId = snapshot.byDevice.has(claimedDeviceId)
    ? claimedDeviceId
    : (snapshot.byKey.get(claimedDeviceId) ?? null);
  if (!deviceId) {
    logger.warn(
      { socketId: socket.id, outletId, claimedDeviceId, employeeId, registry: snapshot.unknown ? "unavailable" : "read" },
      "print_device_identity_unverified",
    );
    // Told, rather than left to guess: a device that registered over HTTP and then
    // could not claim its room is a device whose printer screen must say so, and
    // 'registry_unavailable' is a transient the client should retry while
    // 'not_registered' means POST /print/devices/register never landed.
    socket.emit('print:device-unknown', {
      outletId,
      deviceId: claimedDeviceId,
      reason: snapshot.unknown ? 'registry_unavailable' : 'not_registered',
    });
    return;
  }

  // Written together with the dev: room join below, and on no other path. An
  // identity without room membership is not addressable (printSocketInfo fails it
  // closed), and an identity on a socket that was refused the room would still let
  // that socket send accept/reject beats in the real device's name.
  const writeIdentity = (): void => {
    socket.data.print = {
      deviceId,
      outletId,
      // DIAGNOSTIC ONLY, and server-resolved. Nothing reads it back to make a
      // routing decision: PrintSocketInfo.destinations is derived from the live
      // dest: ROOMS, because rooms are the only binding state syncDeviceRooms can
      // change on a socket connected to another replica.
      destinations: snapshot.byDevice.get(deviceId) ?? [],
      platform,
      agentVersion,
      ready: agentVersion !== null,
      // The session that holds this machine's address, for the contest fence
      // below and so a health screen can say WHO took a device over instead of
      // showing silence.
      employeeId,
      joinedAt: Date.now(),
    };
  };

  const devRoom = deviceRoom(resId, outletId, deviceId);
  // The printer agent re-emits joinOutlet on the SAME socket in some flows; without
  // this guard the socket would supersede itself and the client would show a
  // "another device took over" banner about nobody.
  if (!socket.rooms || !socket.rooms.has(devRoom)) {
    // Read BEFORE joining, so the answer is purely the incumbents. It serves three
    // purposes at one round trip: the contest fence, the dest: rooms the loser
    // must give up with its address, and the fact of there being an incumbent at
    // all (so a first join does not emit a superseded banner about nobody).
    const incumbents = await raceAdapter(io.in(devRoom).fetchSockets(), "print_device_incumbent");
    const others = (incumbents ?? []).filter((s: any) => s.id !== socket.id);

    // THE CONTEST FENCE. Newest-wins is right for the case it was written for — a
    // device flapping and coming back, where the incumbent is its own 90-second
    // zombie and the session is the same one. It is wrong when the two sockets are
    // different people: that is either a waiter's phone claiming the till's id or
    // two installs restored from one backup, and honouring it hands the till's
    // delivery address to a client that will never print, costing every bill the
    // accept deadline while the printer screen reports the impostor as "online".
    // Refusing costs the legitimate loser nothing it did not already have: it keeps
    // the outlet room and every broadcast.
    const contested = others.filter((s: any) => {
      const holder = socketPrintEmployee(s);
      // An incumbent we cannot identify is NOT treated as a contest — refusing on
      // unreadable data would let one corrupted socket squat on an address forever.
      return holder !== null && holder !== employeeId;
    });
    if (contested.length > 0) {
      logger.warn(
        {
          outletId, deviceId, socketId: socket.id, employeeId,
          incumbentSocketId: contested[0].id,
          incumbentEmployeeId: socketPrintEmployee(contested[0]),
        },
        "print_device_room_contested",
      );
      socket.emit('print:device-contested', { outletId, deviceId, at: new Date().toISOString() });
      return;
    }

    // Every dest: room the losers hold, so the address and the directory go
    // together. Leaving them behind lets a superseded zombie keep a destination
    // looking staffed: checkDestinationOffline counts any socket in the room, so
    // when the real device then goes dark the 5s check finds the zombie and stays
    // quiet until its own pingTimeout expires up to ~90s later — in exactly the
    // flap-and-reconnect case that produces zombies in the first place.
    const strandedDest = new Set<string>();
    for (const s of others) {
      for (const room of s.rooms) {
        if (typeof room === "string" && DEST_ROOM_RE.test(room)) { strandedDest.add(room); }
      }
    }

    try {
      // Told before the eviction, because afterwards the room is the wrong place
      // to reach the loser from. Skipped when the room is provably empty so a
      // first join does not announce a takeover from nobody; sent anyway when the
      // adapter could not answer, because a missed banner is worse than a spurious
      // one.
      // supersededBy is the winning socket id: the loser is usually this same
      // device's own zombie socket after a flap, and without something to compare
      // against, a client cannot tell that from a genuine second machine running
      // the same install.
      if (incumbents === null || others.length > 0) {
        io.to(devRoom).emit('print:device-superseded', {
          outletId,
          deviceId,
          supersededBy: socket.id,
          at: new Date().toISOString(),
        });
      }
      writeIdentity();
      // JOIN FIRST — see the header. The eviction that follows excludes this
      // socket by its own id-room, which is the only form that survives the Redis
      // adapter re-applying its own published REMOTE_LEAVE on this very replica.
      socket.join(devRoom);
      io.in(devRoom).except(socket.id).socketsLeave([devRoom, ...strandedDest]);
    } catch (err) {
      logger.error({ err, outletId, deviceId }, "print_device_room_evict_failed");
      // The identity and the join are what live printing needs; an eviction that
      // threw leaves a stale member behind, which the ladder survives (it is a
      // duplicate candidate, deduped by deviceId in outletDeviceSockets).
      if (!socket.rooms || !socket.rooms.has(devRoom)) { writeIdentity(); socket.join(devRoom); }
    }
    if (strandedDest.size > 0) { scheduleDestinationOfflineChecks([...strandedDest], socket.id); }
  } else {
    // Same socket, same room, re-emitted joinOutlet: no eviction, but refresh the
    // identity so a changed agentVersion or a rebinding since the first join is
    // reflected rather than frozen at whatever the first payload said.
    writeIdentity();
  }
  await syncDeviceRooms(resId, outletId, deviceId, snapshot.byDevice.get(deviceId) ?? []);
}

/**
 * One socket's beat budget, in memory, on the socket.
 *
 * Deliberately not routes/_shared.ts's rateLimit — see BEAT_MAX_PER_WINDOW for
 * why that helper cannot be used here. A fixed window rather than a sliding one
 * because the thing being defended is a pooled session count, and doubling the
 * ceiling at a window boundary is a cost this can absorb; the precision is not
 * worth the bookkeeping on a hot path.
 */
function beatBudgetOk(socket: any): boolean {
  const now = Date.now();
  const bucket = socket.data ? socket.data.printBeats : null;
  if (!bucket || now - bucket.at >= BEAT_WINDOW_MS) {
    socket.data.printBeats = { at: now, n: 1 };
    return true;
  }
  bucket.n += 1;
  if (bucket.n <= BEAT_MAX_PER_WINDOW) { return true; }
  // Once per window, not once per dropped beat: the client being defended against
  // is by definition producing a lot of them, and a log line each would move the
  // denial of service from the pool to the log pipeline.
  if (bucket.n === BEAT_MAX_PER_WINDOW + 1) {
    logger.warn(
      { socketId: socket.id, deviceId: verifiedDeviceId(socket) },
      "print_beat_rate_limited",
    );
  }
  return false;
}

async function handlePrintBeat(
  kind: "accepted" | "reject" | "revoked-ok",
  socket: any,
  resId: string,
  payload: any,
): Promise<void> {
  const print = socket && socket.data ? socket.data.print : null;
  if (!print || typeof print.deviceId !== "string" || typeof print.outletId !== "string") {
    // A legacy or unregistered socket cannot be an assignee, so a beat from one is
    // either a stale client or noise. Never guess an identity for it.
    logger.warn({ socketId: socket && socket.id, kind }, "print_beat_from_unrouted_socket");
    return;
  }
  // SHAPE BEFORE WORK. A jobId that is not a uuid cannot name a row this server
  // minted, and forwarding it used to cost a tenant transaction and a 22P02 raised
  // INSIDE it to discover that. See JOB_ID_RE.
  const jobId = payload && typeof payload.jobId === "string" ? payload.jobId.trim() : "";
  if (!JOB_ID_RE.test(jobId)) {
    if (jobId) {
      logger.warn({ socketId: socket.id, kind, deviceId: print.deviceId }, "print_beat_bad_job_id");
    }
    return;
  }
  // RATE AFTER SHAPE, so a well-formed flood is bounded too: a valid-looking uuid
  // is free to generate, and one tenant checkout per emit against fifteen slots is
  // the 2026-08-24 standstill with a different trigger.
  if (!beatBudgetOk(socket)) { return; }
  const rawGen = payload ? Number(payload.generation) : NaN;
  const generation = Number.isFinite(rawGen) ? Math.trunc(rawGen) : 0;

  if (kind === "revoked-ok") {
    // Bookkeeping only: by the time this arrives the job has already been
    // reassigned and the new assignee owns the deadline. It is logged because a
    // revoke that is never acknowledged is the signature of a client that kept a
    // job it was told to drop — the one shape that can still double-print.
    logger.info(
      { jobId, deviceId: print.deviceId, outletId: print.outletId },
      "print_job_revoke_acknowledged",
    );
    return;
  }

  try {
    // LAZY on purpose: print_routing.ts imports this module (emitDevice,
    // outletDeviceSockets), so a static import here would close an ESM cycle and
    // one of the two would see a half-initialised namespace at boot.
    const routing = await import("./print_routing.js");
    if (kind === "accepted") {
      await routing.acceptPrintJob(resId, print.outletId, jobId, print.deviceId, generation);
    } else {
      const reason = payload && typeof payload.reason === "string"
        ? payload.reason.trim().slice(0, 120) || "unspecified"
        : "unspecified";
      await routing.rejectPrintJob(resId, print.outletId, jobId, print.deviceId, generation, reason);
    }
  } catch (err) {
    // Never throw out of a socket handler: an unhandled rejection here would take
    // the process down and with it every till in the fleet. A dropped beat costs
    // one escalation deadline, which is what the deadline is for.
    logger.error({ err, kind, jobId, outletId: print.outletId }, "print_beat_handler_failed");
  }
}

/**
 * THE ALERT MUST FIRE WHEN THE BAR TABLET SLEEPS AT 16:00, NOT WHEN THE FIRST
 * COCKTAIL IS RUNG AT 19:30.
 *
 * Discovering a dead destination at dispatch time is discovering it three hours
 * too late — the docket still prints (the ladder ends in a broadcast, never in
 * silence), but by then somebody is waiting on a drink. So the last socket
 * leaving a destination room is itself the event.
 */
function scheduleDestinationOfflineChecks(rooms: string[], socketId: string): void {
  // Stamped now, not when the check runs: the useful fact for the owner is when
  // the device actually went away, and the grace and the adapter round trip both
  // sit between the two.
  const since = new Date().toISOString();
  const timer = setTimeout(() => {
    for (const room of rooms) {
      void checkDestinationOffline(room, socketId, since)
        .catch((err: unknown) => { logger.error({ err, room }, "print_destination_offline_check_failed"); });
    }
  }, DESTINATION_OFFLINE_GRACE_MS);
  timer.unref?.();
}

async function checkDestinationOffline(room: string, socketId: string, since: string): Promise<void> {
  if (!io) { return; }
  const m = DEST_ROOM_RE.exec(room);
  if (!m) { return; }
  const [, resId, outletId, destinationId] = m;

  const remaining = await raceAdapter(io.in(room).fetchSockets(), "print_destination_presence");
  // null is "I could not find out", not "nobody is there". Alerting on a slow
  // Redis is how an alert channel gets muted.
  if (remaining === null || remaining.length > 0) { return; }

  const now = Date.now();
  const last = destinationOfflineAlertedAt.get(room);
  if (last !== undefined && now - last < DESTINATION_OFFLINE_REALERT_MS) { return; }

  // A destination nobody routes to is a destination nobody misses: the owner may
  // have created it and never pointed a section at it. destinationIsRouted is
  // optional so this file does not hard-depend on print_routing.ts's shape; when
  // it is absent the alert still fires, because a BOUND destination going dark is
  // worth saying out loud either way.
  let routed = true;
  try {
    const routing = await import("./print_routing.js") as unknown as {
      destinationIsRouted?: (resId: string, outletId: string, destinationId: string) => Promise<boolean>;
    };
    if (typeof routing.destinationIsRouted === "function") {
      const probe = routing.destinationIsRouted;
      // WRAPPED IN withTenant BECAUSE THERE IS NO REQUEST HERE. destinationIsRouted
      // reads "PrintRoutes" through the ordinary tenant path, and on a cache miss a
      // disconnect handler has no ambient tenant connection: the statement would run
      // on the bare pool with no app.res_id GUC, which under FORCE ROW LEVEL SECURITY
      // is not an error but ZERO ROWS — every destination would look unrouted and the
      // alert this whole path exists for would never fire. Cheap because it is reached
      // at most once per room per re-alert window (the suppression check above runs
      // first), and it reuses print_routing's 10s snapshot on a hit.
      routed = await withTenant(
        { res_id: resId, outlet_id: outletId, employeeId: "", role: "" },
        () => probe(resId, outletId, destinationId),
      );
    }
  } catch (err) {
    logger.error({ err, room }, "print_destination_route_probe_failed");
  }
  if (!routed) { return; }

  pruneDestinationAlerts(now);
  destinationOfflineAlertedAt.set(room, now);
  logger.warn({ resId, outletId, destinationId, socketId }, "print_destination_offline");
  emitRestaurant(resId, 'print:destination_offline', { outletId, destinationId, since });
}

/** Bounded because this map is keyed by room and a long-lived process would
 *  otherwise accumulate one entry per destination the tenant ever had. */
function pruneDestinationAlerts(now: number): void {
  for (const [room, at] of destinationOfflineAlertedAt) {
    if (now - at > DESTINATION_OFFLINE_REALERT_MS) { destinationOfflineAlertedAt.delete(room); }
  }
}

export function emitRestaurant(restaurantId: string, event: string, payload: unknown) {
  if (!io) {return;}
  try {
    const room = `restaurant:${restaurantId}`;
    // Don't log the payload (may contain customer/bill data); event name only.
    io.to(room).emit(event, payload);
  } catch (err) {
    logger.error({ err }, "emitRestaurant failed");
  }
}

export function emitOutlet(restaurantId: string, outletId: string, event: string, payload: unknown) {
  if (!io) {return;}
  try {
    const room = outletRoom(restaurantId, outletId);
    io.to(room).emit(event, payload);
  } catch (err) {
    logger.error({ err }, "emitOutlet failed");
  }
}

/**
 * Emit to ONE device. The delivery half of routing.
 *
 * This never touches the outlet room, which is the property the whole design
 * rests on: a job sent here cannot also reach the C# agent or an old build, so a
 * routed job cannot be printed twice by two clients that both thought it was
 * theirs. A device that is not connected simply gets nothing — emitting to an
 * empty room is a successful no-op with no return value, which is exactly why the
 * job row is written first and the accept beat exists.
 */
export function emitDevice(
  restaurantId: string,
  outletId: string,
  deviceId: string,
  event: string,
  payload: unknown,
) {
  if (!io) {return;}
  const id = safeRoomId(deviceId);
  if (!id) {
    logger.warn({ outletId, event }, "emitDevice rejected an unusable deviceId");
    return;
  }
  try {
    io.to(deviceRoom(restaurantId, outletId, id)).emit(event, payload);
  } catch (err) {
    logger.error({ err }, "emitDevice failed");
  }
}

/**
 * Who is connected and routable in this outlet, right now, across every replica.
 *
 * RETURNS NULL, NOT [], WHEN THE ANSWER IS UNKNOWN — on timeout, with no io, or
 * in production without the Redis adapter (where fetchSockets can only see this
 * replica's sockets and an empty answer would be a lie about the others). The
 * caller must branch differently on the two: an empty array means "chain empty,
 * broadcast now and raise a destination-offline alert", null means "I could not
 * ask, broadcast now and do not accuse anything of being offline".
 */
export async function outletDeviceSockets(
  resId: string,
  outletId: string,
): Promise<PrintSocketInfo[] | null> {
  if (!io) { return null; }
  if (!adapterReady && process.env.NODE_ENV === "production") { return null; }
  const sockets = await raceAdapter(
    io.in(outletRoom(resId, outletId)).fetchSockets(),
    "print_outlet_presence",
  );
  if (sockets === null) { return null; }
  // Keyed by device so a superseded clone that has not finished leaving its dev
  // room cannot appear twice in a chain and be assigned the same job on both.
  const byDevice = new Map<string, PrintSocketInfo>();
  for (const s of sockets) {
    const info = printSocketInfo(s.id, s.data, s.rooms, resId, outletId);
    if (!info) { continue; }
    const prev = byDevice.get(info.deviceId);
    if (!prev || prev.joinedAt <= info.joinedAt) { byDevice.set(info.deviceId, info); }
  }
  return [...byDevice.values()];
}

/**
 * Rewrite one device's destination rooms in place.
 *
 * THIS IS WHY BINDING A PRINTER FROM THE OFFICE PC IS NOT A DEAD CONTROL. The
 * owner is nowhere near the till; without this, a binding written to the database
 * would not reach the till's live socket until it happened to reconnect, and the
 * screen would show a rule that the router does not yet obey. Every config write
 * route calls this.
 *
 * Room membership — not socket.data — is the binding state precisely because it
 * is the only thing that can be changed on a socket connected to another replica:
 * socket.data is a per-replica object and a mutation to a RemoteSocket's copy goes
 * nowhere.
 */
export async function syncDeviceRooms(
  resId: string,
  outletId: string,
  deviceId: string,
  destinationIds: string[],
): Promise<void> {
  if (!io) { return; }
  const id = safeRoomId(deviceId);
  if (!id) { return; }
  const devRoom = deviceRoom(resId, outletId, id);
  const prefix = destinationRoomPrefix(resId, outletId);

  const want = new Set<string>();
  for (const raw of destinationIds || []) {
    const d = safeRoomId(raw);
    if (d) { want.add(destinationRoom(resId, outletId, d)); }
    if (want.size >= MAX_DESTINATIONS_PER_DEVICE) { break; }
  }

  const sockets = await raceAdapter(io.in(devRoom).fetchSockets(), "print_device_rooms");
  const have = new Set<string>();
  if (sockets) {
    for (const s of sockets) {
      for (const room of s.rooms) {
        if (room.startsWith(prefix)) { have.add(room); }
      }
    }
  }

  const toJoin = [...want].filter((r) => !have.has(r));
  // Empty when the fetch failed, and that asymmetry is deliberate: adding a
  // binding blind is harmless (the route table still decides what is sent), but
  // REMOVING one blind is impossible — we would have to guess which rooms exist.
  // An unbind that could not be applied is warned about below and lands on the
  // device's next reconnect.
  const toLeave = [...have].filter((r) => !want.has(r));

  try {
    if (toJoin.length > 0) {
      io.in(devRoom).socketsJoin(toJoin);
      // A destination that just gained a member is not offline any more, so the
      // suppression window must not stop the NEXT outage from alerting.
      for (const room of toJoin) { destinationOfflineAlertedAt.delete(room); }
    }
    if (toLeave.length > 0) { io.in(devRoom).socketsLeave(toLeave); }
  } catch (err) {
    logger.error({ err, outletId, deviceId: id }, "print_sync_device_rooms_failed");
    return;
  }

  if (sockets === null && want.size > 0) {
    logger.warn(
      { outletId, deviceId: id },
      "print_sync_device_rooms_blind: could not read current rooms; stale bindings persist until reconnect",
    );
  }
}

export function getIo() {
  return io;
}

// Close socket.io (and its underlying connections) for graceful shutdown.
export async function closeRealtime(): Promise<void> {
  if (!io) {return;}
  await new Promise<void>((resolve) => io!.close(() => { resolve(); }));
}
