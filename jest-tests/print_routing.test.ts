// Server-decided print routing.
//
// THE ONE PROPERTY THIS SUITE EXISTS FOR, and the reason it can be deployed to a
// restaurant mid-service:
//
//   AN OUTLET WITH ZERO "PrintRoutes" ROWS BEHAVES EXACTLY AS IT DOES TODAY,
//   BYTE FOR BYTE.
//
// That is the first describe block, it is asserted at the level of payload keys
// and their order, and everything after it is a consequence: routing arms PER
// ROLE at the instant a rule row is created, so a tenant who routes only
// `kot:BAR` still broadcasts bills exactly as it did before 042 existed.
//
// The second property is the ladder's own invariant — every state in which
// nobody has printed a job has a named owner and a deadline, and the last rung is
// today's outlet-wide broadcast, never silence. The tests for it are written as
// the faults they cover (a device that says no, a device that jams, a row
// somebody else is holding, a replica that never saw the job) rather than as a
// walk through the code.
//
// HOW IT RUNS. The same rule as print_jobs.test.ts: the guarantees live in SQL —
// a generation fence, the 027 lease and its one named exception, a broadcast_at
// idempotence fence, an attribution leg — so every test drives the SHIPPED path
// (print_routing.ts -> database_supabase.ts -> realtime.ts) over the stubbed Pool
// and stubbed socket.io in print_routing_fixtures.ts, whose dispatch DERIVES its
// behaviour from the statement text. Delete a predicate and these turn red rather
// than continuing to enforce a rule the database no longer has.

import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from "@jest/globals";
import {
  DEST_BAR,
  DEST_BILL,
  DEVICE_1,
  DEVICE_2,
  DEVICE_3,
  OUTLET_ID,
  RES_ID,
  addBinding,
  addDestination,
  addJob,
  addLegacySocket,
  addPrintSocket,
  addRoute,
  breakRoutingTables,
  connections,
  deviceRoom,
  dropSocket,
  emits,
  emitsOf,
  jobById,
  lastStatement,
  outletRoom,
  resetRealtime,
  resetStore,
  theJob,
} from "./print_routing_fixtures";

jest.mock("pg", () => {
  interface FixtureGlobal {
    __printRoutingFixtureConnect?: () => {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
      release: () => void;
    };
  }
  const conn = () => {
    const make = (globalThis as unknown as FixtureGlobal).__printRoutingFixtureConnect;
    if (!make) { throw new Error("print routing fixture harness was not loaded"); }
    return make();
  };
  class FakePool {
    on(): this { return this; }
    // pool.query is the AMBIENT path (no tenant transaction); it must NOT count as
    // a checkout, or the pool-safety pin would be measuring the wrong thing.
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
      const c = conn();
      return c.query(sql, params);
    }
    connect(): Promise<unknown> { return Promise.resolve(conn()); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

jest.mock("socket.io", () => {
  interface FixtureGlobal { __printRoutingFixtureIo?: () => unknown }
  class FakeServerShim {
    constructor() {
      const make = (globalThis as unknown as FixtureGlobal).__printRoutingFixtureIo;
      if (!make) { throw new Error("print routing fixture io was not loaded"); }
      return make() as FakeServerShim;
    }
  }
  return { Server: FakeServerShim };
});

type PrintRouting = typeof import("../print_routing");
type PrintJobs = typeof import("../print_jobs");
type Realtime = typeof import("../realtime");
type Db = typeof import("../database_supabase");

let routing: PrintRouting;
let printJobs: PrintJobs;
let realtime: Realtime;
let db: Db;

const SEC = 1000;
const MIN = 60 * SEC;
const T0 = new Date("2026-09-11T18:30:00Z").getTime();

/** The four knobs the ladder's numbers come from, at their shipped defaults, so a
 *  developer with one exported does not get a green run that proves something
 *  different from CI's. */
const ACCEPT_MS = 4000;
const VERDICT_MS = 75 * SEC;

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  for (const k of [
    "PRINT_ROUTING", "PRINT_ACCEPT_TIMEOUT_MS", "PRINT_VERDICT_TIMEOUT_SEC",
    "PRINT_MAX_ASSIGN_GENERATIONS", "PRINT_ORPHAN_SWEEP_MAX", "PRINT_ASSIGN_REGISTRY_MAX",
    "PRINT_JOB_LEASE_MIN", "PRINT_JOB_MAX_B64_CHARS", "PRINT_JOB_REPLAY_LIMIT",
    "PRINT_JOB_KOT_TTL_MIN", "PRINT_JOB_BILL_TTL_MIN",
  ]) { delete process.env[k]; }
  // The route/presence caches exist so a busy service does not re-read the tables
  // per docket; they are not what is under test, and a 10s snapshot inside a
  // frozen-clock test would hide every mid-test change. One millisecond keeps the
  // code path (still a cache, still a Map with a timestamp) and makes `tick()` the
  // only thing that invalidates it.
  process.env.PRINT_ROUTE_CACHE_MS = "1";
  process.env.PRINT_PRESENCE_CACHE_MS = "1";

  db = await import("../database_supabase");
  printJobs = await import("../print_jobs");
  realtime = await import("../realtime");
  routing = await import("../print_routing");

  // NO AMBIENT REDIS. initRealtime builds a REAL node-redis client when
  // REDIS_URL is set, and CI sets it (to a Redis that is not in its services
  // block) — so this suite once hung the entire CI run for thirty-three minutes
  // while node-redis retried an address with nothing behind it, on a step that
  // takes seventy-five seconds locally where the variable is unset.
  //
  // The boot path is now bounded so it degrades instead of hanging, but a test
  // that behaves differently depending on a variable it never mentions is a
  // trap whatever the production code does: what is under test here is routing,
  // not the adapter.
  delete process.env.REDIS_URL;

  // Sets realtime.ts's module-level `io` to the fixture server, so emitDevice,
  // emitOutlet and outletDeviceSockets all run for real over a fake adapter.
  await realtime.initRealtime({} as unknown as Parameters<Realtime["initRealtime"]>[0]);
});

beforeEach(() => {
  // Timers are faked so the ladder's deadlines never fire on their own — every
  // rung in this suite is driven explicitly (a beat, an ack, an expired
  // registry entry) so that a test asserts a decision rather than a race.
  jest.useFakeTimers();
  jest.setSystemTime(new Date(T0));
  resetStore();
  resetRealtime();
  routing.__printRoutingTestSeam.reset();
  db.__printRoutingTestSeam.setSchemaReady(true);
  delete process.env.PRINT_ROUTING;
});

afterEach(() => {
  routing.__printRoutingTestSeam.reset();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

// --- helpers -----------------------------------------------------------------

function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) { throw new Error(`expected ${what}`); }
  return v;
}

/** Move the frozen clock forward. Also what invalidates the 1ms caches above. */
function tick(ms: number): void { jest.setSystemTime(new Date(Date.now() + ms)); }

/**
 * Drain the microtask queue.
 *
 * Needed for exactly ONE caller in this file — the registry-overflow eviction,
 * which starts its escalation with `void escalate(...)` because it runs inside a
 * synchronous dispatch. Every other rung here is awaited by the code under test.
 * No real timers are involved (the fixture's queries are plain async functions),
 * so draining microtasks is enough.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) { await Promise.resolve(); }
}

const norm = (sql: string): string => sql.replace(/\s+/g, " ").trim();

/** `Bar Printer`, bound to a Windows till (priority 10) and an Android tablet
 *  (priority 50), with `kot:BAR` pointed at it. The standard two-device failover
 *  chain: LOWER PRIORITY WINS, so D1 is the head. */
function configureBar(opts: { online?: string[]; route?: string } = {}): void {
  addDestination({ id: DEST_BAR, name: "Bar Printer" });
  addRoute(opts.route ?? "kot:BAR", DEST_BAR);
  addBinding({ device_id: DEVICE_1, destination_id: DEST_BAR, target: "tcp://10.0.0.5:9100", priority: 10, device_label: "Front till" });
  addBinding({ device_id: DEVICE_2, destination_id: DEST_BAR, target: "EPSON TM-T82", priority: 50, device_label: "Bar tablet" });
  for (const d of opts.online ?? [DEVICE_1, DEVICE_2]) {
    addPrintSocket({ deviceId: d, destinations: [DEST_BAR] });
  }
}

async function dispatchBarKot(billId = "KOT-1", esc = "esc-kot"): Promise<string> {
  const res = await routing.dispatchPrintJob(RES_ID, {
    outlet_id: OUTLET_ID, bill_id: billId, kind: "kot", station: "Bar", esc_base64: esc,
  });
  return must(res.jobId, "the KOT to have been persisted");
}

/** Every `bill:print` this run emitted into a device room, in order. */
function directedPrints(): { deviceId: string; payload: Record<string, unknown> }[] {
  return emitsOf("bill:print")
    .filter((e) => e.room.includes(":dev:"))
    .map((e) => ({ deviceId: e.room.slice(e.room.indexOf(":dev:") + 5), payload: e.payload }));
}

function broadcastPrints(): Record<string, unknown>[] {
  return emitsOf("bill:print")
    .filter((e) => e.room === outletRoom(RES_ID, OUTLET_ID))
    .map((e) => e.payload);
}

// ---------------------------------------------------------------------------
// PIN 1 — the deployability pin.
// ---------------------------------------------------------------------------
describe("an outlet with zero PrintRoutes rows is unchanged, byte for byte", () => {
  test("a bill's payload has EXACTLY {billId, escBase64, jobId, publishedAt} — no kind, no station, no route", async () => {
    const res = await routing.dispatchPrintJob(RES_ID, {
      outlet_id: OUTLET_ID, bill_id: "B1", kind: "bill", station: null, esc_base64: "esc-B1",
    });

    expect(res.decision).toMatchObject({ mode: "broadcast", reason: "no_route" });
    expect(res.assignedDeviceId).toBeNull();

    const sent = emitsOf("bill:print");
    expect(sent).toHaveLength(1);
    // The OUTLET room — the one every till, every phone and the C# agent have sat
    // in since 027. A directed emit never enters it, which is why a routed job
    // cannot be double-printed by a client that has never heard of routing.
    expect(sent[0].room).toBe(outletRoom(RES_ID, OUTLET_ID));
    // Key ORDER as well as key set: hundreds of fielded builds infer "this is a
    // bill" from the ABSENCE of `kind`, so this is a wire format, not a shape.
    expect(Object.keys(sent[0].payload)).toEqual(["billId", "escBase64", "jobId", "publishedAt"]);
    expect(sent[0].payload.escBase64).toBe("esc-B1");
  });

  test("a KOT ticket adds exactly `station` and `kind`, and nothing else", async () => {
    await routing.dispatchPrintJob(RES_ID, {
      outlet_id: OUTLET_ID, bill_id: "KOT-1", kind: "kot", station: "Grill", esc_base64: "esc-grill",
    });
    const sent = emitsOf("bill:print");
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0].payload)).toEqual(["billId", "escBase64", "station", "kind", "jobId", "publishedAt"]);
    expect(sent[0].payload).toMatchObject({ station: "Grill", kind: "kot" });
  });

  test("the row is written by today's INSERT: no assignment, no lease, nothing to escalate", async () => {
    const res = await routing.dispatchPrintJob(RES_ID, {
      outlet_id: OUTLET_ID, bill_id: "B1", kind: "bill", station: null, esc_base64: "esc",
    });
    const row = theJob(must(res.jobId, "a persisted job"));
    expect(row).toMatchObject({
      status: "pending", attempts: 0, claimed_by: null, claimed_until: null,
      assigned_device_id: null, assigned_target: null, destination_id: null,
      assign_expires_at: null, assign_generation: 0, broadcast_at: null,
    });
    // Nothing is being watched, so nothing can escalate, so nothing can revoke or
    // re-emit. An unconfigured tenant costs this feature exactly zero.
    expect(routing.__printRoutingTestSeam.outstanding()).toEqual([]);
  });

  test("a tenant that routes ONLY kot:BAR still broadcasts bills, byte-identically", async () => {
    configureBar();
    const res = await routing.dispatchPrintJob(RES_ID, {
      outlet_id: OUTLET_ID, bill_id: "B1", kind: "bill", station: null, esc_base64: "esc-B1",
    });
    // A bill tries the `bill` role and NOTHING ELSE. Falling through onto the
    // kitchen's destination would put the guest's receipt on the bar roll.
    expect(res.decision.reason).toBe("no_route");
    expect(Object.keys(emitsOf("bill:print")[0].payload)).toEqual(["billId", "escBase64", "jobId", "publishedAt"]);
  });

  test("with migration 042's tables absent it is still today's payload, on today's room", async () => {
    breakRoutingTables();
    configureBar();
    const res = await routing.dispatchPrintJob(RES_ID, {
      outlet_id: OUTLET_ID, bill_id: "KOT-1", kind: "kot", station: "Bar", esc_base64: "esc",
    });
    // `no_route`, NOT `schema_missing`, and that is the shipped behaviour rather
    // than a gap: routingQuery in database_supabase.ts absorbs 42P01/42501/42703
    // and answers [], so loadRoutes' own catch — the second lock on that door —
    // is never reached and an unreadable table is indistinguishable from an
    // unconfigured one. For PAPER the two are the same thing (both broadcast),
    // which is why this is pinned here as the byte-identity it is. The reason
    // GET /print/health will show is the honest cost, and warnPrintRoutingSchemaMissing
    // is what actually names the missing migration in the log.
    expect(res.decision).toMatchObject({ mode: "broadcast", reason: "no_route" });
    expect(emitsOf("bill:print")[0].room).toBe(outletRoom(RES_ID, OUTLET_ID));
    expect(Object.keys(emitsOf("bill:print")[0].payload)).toEqual(["billId", "escBase64", "station", "kind", "jobId", "publishedAt"]);
  });

  test("with the COLUMN latch false nothing is even asked of the routing tables", async () => {
    // The latch is checked before any query because being directed without the
    // assignment columns is worse than not being directed at all: the ladder would
    // have no rungs.
    db.__printRoutingTestSeam.setSchemaReady(false);
    configureBar();
    const res = await routing.dispatchPrintJob(RES_ID, {
      outlet_id: OUTLET_ID, bill_id: "KOT-1", kind: "kot", station: "Bar", esc_base64: "esc",
    });
    expect(res.decision.reason).toBe("schema_missing");
    expect(() => lastStatement(/"PrintRoutes"/)).toThrow();
    expect(theJob(must(res.jobId, "a persisted job")).assigned_device_id).toBeNull();
  });

  test("PRINT_ROUTING=false is the no-redeploy stop: configured routes, today's behaviour", async () => {
    configureBar();
    process.env.PRINT_ROUTING = "false";
    const res = await routing.dispatchPrintJob(RES_ID, {
      outlet_id: OUTLET_ID, bill_id: "KOT-1", kind: "kot", station: "Bar", esc_base64: "esc",
    });
    expect(res.decision).toMatchObject({ mode: "broadcast", reason: "flag_off" });
    expect(directedPrints()).toHaveLength(0);
    // The rules are still on disk — the flag stops the router, it does not delete
    // the owner's configuration.
    expect(lastStatement(/insert into "PrintJobs"/).sql).not.toContain("assigned_device_id");
  });
});

// ---------------------------------------------------------------------------
// PIN 2 — the statement that regresses silently.
// ---------------------------------------------------------------------------
describe("ClaimPrintJobsForAgent", () => {
  const TODAYS_SQL = norm(`with due as (
       select id
         from "PrintJobs"
        where res_id = $1
          and outlet_id = $2
          and status in ('pending','delivered')
          and (claimed_until is null or claimed_until < now())
          and created_at > (case when kind = 'kot' then $3::timestamptz else $4::timestamptz end)
        order by created_at asc, seq asc
        limit $7
        for update skip locked
     )
     update "PrintJobs" p
        set status = 'delivered',
            attempts = p.attempts + 1,
            claimed_by = $5,
            claimed_until = $6::timestamptz,
            delivered_at = now()
       from due
      where p.id = due.id
     returning p.id, p.seq, p.bill_id, p.kind, p.station, p.esc_base64, p.created_at, p.attempts`);

  const cutoffs = () => ({ kot: new Date(T0 - 30 * MIN), bill: new Date(T0 - 12 * 60 * MIN) });
  const lease = () => new Date(T0 + 2 * MIN);

  async function claim(deviceId: string | null): Promise<unknown[]> {
    return db.ClaimPrintJobsForAgent(RES_ID, OUTLET_ID, "till-a", cutoffs(), lease(), 20, deviceId);
  }

  test("with the latch FALSE it issues today's exact SQL, even when the agent names a device", async () => {
    // THIS IS THE PIN. 42703 is not caught by isSchemaMissing, so a backend
    // running ahead of 042 that emitted the routing clause anyway would kill
    // reconnect replay for EVERY tenant, silently, in exactly the Gate-B window
    // the latch exists to survive.
    db.__printRoutingTestSeam.setSchemaReady(false);
    await claim(DEVICE_1);
    const st = lastStatement(/^with due as/);
    expect(norm(st.sql)).toBe(TODAYS_SQL);
    // Seven parameters, as in 027: an eighth would mean a clause was built and
    // then lost, which is the failure this text assertion cannot otherwise see.
    expect(st.params).toHaveLength(7);
  });

  test("with the latch TRUE and no device identity, exactly ONE predicate is added", async () => {
    await claim(null);
    const st = lastStatement(/^with due as/);
    expect(norm(st.sql)).toBe(
      TODAYS_SQL.replace(" order by created_at asc", " and assigned_device_id is null order by created_at asc"),
    );
    expect(st.params).toHaveLength(7);
  });

  test("an agent with no device identity sees precisely today's row set — never a directed job", async () => {
    const unrouted = addJob({ bill_id: "B-open" });
    const directed = addJob({
      bill_id: "B-directed", status: "delivered",
      assigned_device_id: DEVICE_1, assign_expires_at: new Date(T0 - MIN), destination_id: DEST_BILL,
    });
    // The C# agent cannot report what it did with a job, so it must never resume
    // one the router has handed to somebody else. It still gets every broadcast.
    const rows = await claim(null) as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual([unrouted.id]);
    expect(theJob(directed.id).claimed_by).toBeNull();
  });

  test("a device resumes its OWN job across a flap, and a lapsed one, but not a live stranger's", async () => {
    const mine = addJob({
      bill_id: "B-mine", status: "delivered", assigned_device_id: DEVICE_1,
      assign_expires_at: new Date(T0 + VERDICT_MS), destination_id: DEST_BAR,
    });
    const lapsed = addJob({
      bill_id: "B-lapsed", status: "delivered", assigned_device_id: DEVICE_2,
      assign_expires_at: new Date(T0 - SEC), destination_id: DEST_BAR,
    });
    const theirs = addJob({
      bill_id: "B-theirs", status: "delivered", assigned_device_id: DEVICE_2,
      assign_expires_at: new Date(T0 + VERDICT_MS), destination_id: DEST_BAR,
    });
    const rows = await claim(DEVICE_1) as { id: string }[];
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([mine.id, lapsed.id]));
    expect(theJob(theirs.id).claimed_by).toBeNull();
  });

  test("the reconnect door is shut against a printer already in the job's failed_devices", async () => {
    // Otherwise the retry arm's released row — 'pending', unassigned — is matched
    // by the very device that just reported the jam, whose second 'failed' is a
    // no-op, so the row can never settle and is re-claimed on every flap.
    const jammed = addJob({
      bill_id: "B-jam", status: "pending", assigned_device_id: null,
      assign_expires_at: new Date(T0 - SEC), destination_id: DEST_BAR,
      failed_devices: [DEVICE_1],
    });
    expect(await claim(DEVICE_1)).toEqual([]);
    const rows = await claim(DEVICE_2) as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual([jammed.id]);
  });
});

// ---------------------------------------------------------------------------
// PIN 3 — precedence.
// ---------------------------------------------------------------------------
describe("precedence: kot:<STATION> beats kot beats nothing, and a bill only ever matches `bill`", () => {
  beforeEach(() => {
    addDestination({ id: DEST_BAR, name: "Bar Printer" });
    addDestination({ id: DEST_BILL, name: "Front Till" });
    addBinding({ device_id: DEVICE_1, destination_id: DEST_BAR, target: "tcp://bar", priority: 10 });
    addBinding({ device_id: DEVICE_2, destination_id: DEST_BILL, target: "tcp://till", priority: 10 });
    addPrintSocket({ deviceId: DEVICE_1, destinations: [DEST_BAR] });
    addPrintSocket({ deviceId: DEVICE_2, destinations: [DEST_BILL] });
  });

  test("the station rule wins over the catch-all", async () => {
    addRoute("kot:BAR", DEST_BAR);
    addRoute("kot", DEST_BILL);
    const d = await routing.resolvePrintTarget({ resId: RES_ID, outletId: OUTLET_ID, kind: "kot", station: "Bar" });
    expect(d).toMatchObject({ mode: "directed", reason: "routed", destinationId: DEST_BAR });
    expect(d.chain.map((c) => c.deviceId)).toEqual([DEVICE_1]);
  });

  test("an unrouted station falls to the `kot` catch-all, not to the bill printer", async () => {
    addRoute("kot", DEST_BAR);
    addRoute("bill", DEST_BILL);
    const d = await routing.resolvePrintTarget({ resId: RES_ID, outletId: OUTLET_ID, kind: "kot", station: "Pastry" });
    expect(d.destinationId).toBe(DEST_BAR);
  });

  test("a KOT with no matching kot rule BROADCASTS — it never borrows the bill destination", async () => {
    // §12.4's rule: guessing which printer is "the bar one" is how a guest's bill
    // ends up on the kitchen roll, and the reverse is just as bad.
    addRoute("bill", DEST_BILL);
    const d = await routing.resolvePrintTarget({ resId: RES_ID, outletId: OUTLET_ID, kind: "kot", station: "Pastry" });
    expect(d).toMatchObject({ mode: "broadcast", reason: "no_route", destinationId: null });
  });

  test("a bill never borrows a kitchen destination either", async () => {
    addRoute("kot", DEST_BAR);
    addRoute("kot:BAR", DEST_BAR);
    const d = await routing.resolvePrintTarget({ resId: RES_ID, outletId: OUTLET_ID, kind: "bill", station: null });
    expect(d).toMatchObject({ mode: "broadcast", reason: "no_route" });
  });

  test("stations match case-insensitively, and with surrounding whitespace", async () => {
    // 042's unique index is on lower(role), the client upper-cases, and a menu
    // typed "bar" must route like one typed "Bar" — otherwise grouping mints two
    // half-dockets for one kitchen section.
    addRoute("kot:BAR", DEST_BAR);
    for (const station of ["bar", "Bar", "  BaR  "]) {
      routing.__printRoutingTestSeam.reset();
      tick(5);
      const d = await routing.resolvePrintTarget({ resId: RES_ID, outletId: OUTLET_ID, kind: "kot", station });
      expect(d.destinationId).toBe(DEST_BAR);
    }
  });

  test("a rule row stored in the other casing matches too", async () => {
    addRoute("KoT:bar", DEST_BAR);
    const d = await routing.resolvePrintTarget({ resId: RES_ID, outletId: OUTLET_ID, kind: "kot", station: "Bar" });
    expect(d.destinationId).toBe(DEST_BAR);
  });

  test("a rule pointing at a DEACTIVATED destination matches nothing and broadcasts", async () => {
    addDestination({ id: "de533333-3333-4333-8333-333333333333", name: "Old Printer", active: false });
    addRoute("kot:BAR", "de533333-3333-4333-8333-333333333333");
    const d = await routing.resolvePrintTarget({ resId: RES_ID, outletId: OUTLET_ID, kind: "kot", station: "Bar" });
    expect(d).toMatchObject({ mode: "broadcast", reason: "no_route" });
  });
});

// ---------------------------------------------------------------------------
// PIN 8 — who counts as present.
// ---------------------------------------------------------------------------
describe("presence", () => {
  test("a socket with no socket.data.print is never a candidate and never counts as presence", async () => {
    // The C# agent (C_Sharp_temp_printer_server) and every Flutter build older
    // than this feature. It cannot ack, so targeting it is a silent drop that
    // costs the kitchen the whole accept deadline. It keeps every broadcast
    // instead, which makes it the printer of last resort.
    addDestination({ id: DEST_BAR, name: "Bar Printer" });
    addRoute("kot:BAR", DEST_BAR);
    addBinding({ device_id: DEVICE_1, destination_id: DEST_BAR, target: "tcp://bar", priority: 10 });
    addLegacySocket();
    addLegacySocket();

    // NEVER COUNTS AS PRESENCE, asserted at the source: outletDeviceSockets is
    // where socket.data.print is required, and an empty answer here is KNOWLEDGE
    // ("nothing routable is online") rather than ignorance, which is what earns
    // the destination-offline alert below.
    await expect(realtime.outletDeviceSockets(RES_ID, OUTLET_ID)).resolves.toEqual([]);

    const d = await routing.resolvePrintTarget({ resId: RES_ID, outletId: OUTLET_ID, kind: "kot", station: "Bar" });
    expect(d).toMatchObject({ mode: "broadcast", reason: "no_device_online", destinationId: DEST_BAR });
    expect(d.chain).toEqual([]);

    // …and it is told about the dark destination, rather than being left to
    // wonder why the bar docket came out at the pass.
    const jobId = await dispatchBarKot();
    expect(directedPrints()).toHaveLength(0);
    expect(broadcastPrints()).toHaveLength(1);
    expect(emitsOf("print:destination_offline")).toHaveLength(1);
    expect(theJob(jobId).assigned_device_id).toBeNull();
  });

  test("a client that named no agentVersion holds its room but is never given work", async () => {
    addDestination({ id: DEST_BAR, name: "Bar Printer" });
    addRoute("kot:BAR", DEST_BAR);
    addBinding({ device_id: DEVICE_1, destination_id: DEST_BAR, target: "tcp://bar", priority: 10 });
    // ready:false — the same interlock resumePrintJobsForAgent enforces for
    // replay: no per-job dedup, no ack.
    addPrintSocket({ deviceId: DEVICE_1, destinations: [DEST_BAR], ready: false });
    const d = await routing.resolvePrintTarget({ resId: RES_ID, outletId: OUTLET_ID, kind: "kot", station: "Bar" });
    expect(d.reason).toBe("no_device_online");
  });

  test("a RETIRED machine is never a candidate, even though the binding row survives it", async () => {
    addDestination({ id: DEST_BAR, name: "Bar Printer" });
    addRoute("kot:BAR", DEST_BAR);
    addBinding({
      device_id: DEVICE_1, destination_id: DEST_BAR, target: "tcp://bar", priority: 10,
      device_retired_at: new Date(T0 - MIN),
    });
    addPrintSocket({ deviceId: DEVICE_1, destinations: [DEST_BAR] });
    const d = await routing.resolvePrintTarget({ resId: RES_ID, outletId: OUTLET_ID, kind: "kot", station: "Bar" });
    // The SQL still returns the row — GET /print/health has to be able to say
    // "bound to a machine you retired" — so dropping it is the resolver's job.
    expect(d.reason).toBe("no_device_online");
  });

  test("a device that has left the dest: room is dropped even while its binding row is still cached", async () => {
    // syncDeviceRooms changes the LIVE socket the moment an owner unbinds a
    // printer from the office PC; the binding row can be up to a TTL stale.
    // Trusting the row alone keeps picking a device guaranteed to reject.
    configureBar({ online: [DEVICE_1, DEVICE_2] });
    const stale = addPrintSocket({ deviceId: DEVICE_3, destinations: [] });
    addBinding({ device_id: DEVICE_3, destination_id: DEST_BAR, target: "tcp://ghost", priority: 1 });
    const d = await routing.resolvePrintTarget({ resId: RES_ID, outletId: OUTLET_ID, kind: "kot", station: "Bar" });
    expect(d.chain.map((c) => c.deviceId)).toEqual([DEVICE_1, DEVICE_2]);
    dropSocket(stale);
  });

  test("the chain is ordered by priority: the Windows till beats the Android tablet", async () => {
    configureBar();
    const d = await routing.resolvePrintTarget({ resId: RES_ID, outletId: OUTLET_ID, kind: "kot", station: "Bar" });
    expect(d.chain.map((c) => ({ deviceId: c.deviceId, target: c.target }))).toEqual([
      { deviceId: DEVICE_1, target: "tcp://10.0.0.5:9100" },
      { deviceId: DEVICE_2, target: "EPSON TM-T82" },
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("a directed dispatch", () => {
  test("goes to ONE device room, carries a route block, and is leased in the same insert", async () => {
    configureBar();
    const jobId = await dispatchBarKot("KOT-9", "esc-9");

    const sent = emitsOf("bill:print");
    expect(sent).toHaveLength(1);
    // NEVER the outlet room. This is the property the whole no-double-print
    // argument rests on.
    expect(sent[0].room).toBe(deviceRoom(RES_ID, OUTLET_ID, DEVICE_1));
    expect(sent[0].payload.route).toEqual({
      destinationId: DEST_BAR, destinationName: "Bar Printer",
      deviceId: DEVICE_1, target: "tcp://10.0.0.5:9100", generation: 0,
    });
    // `route` is appended LAST, so a client that ignores it sees the same first
    // six keys it has always seen.
    expect(Object.keys(sent[0].payload)).toEqual(["billId", "escBase64", "station", "kind", "jobId", "publishedAt", "route"]);

    const row = theJob(jobId);
    expect(row).toMatchObject({ status: "delivered", attempts: 1, assigned_device_id: DEVICE_1 });
    // TWO CLOCKS. The ladder's deadline is seconds; the 027 at-most-once lease is
    // minutes. Conflating them opened the reconnect door at t=4s and printed
    // bills twice while the first till was still inside its ~61s spool.
    expect(must(row.assign_expires_at, "a deadline").getTime()).toBe(T0 + ACCEPT_MS);
    expect(must(row.claimed_until, "a lease").getTime()).toBe(T0 + 2 * MIN);
  });

  test("an unpersistable payload is DOWNGRADED to broadcast rather than directed at one device", async () => {
    // No row means no id; no id means the client can neither ack, accept nor
    // reject — a directed emit with the entire ladder switched off behind it.
    process.env.PRINT_JOB_MAX_B64_CHARS = "8";
    try {
      configureBar();
      const res = await routing.dispatchPrintJob(RES_ID, {
        outlet_id: OUTLET_ID, bill_id: "KOT-1", kind: "kot", station: "Bar", esc_base64: "x".repeat(64),
      });
      expect(res).toMatchObject({ jobId: null, assignedDeviceId: null });
      expect(res.decision).toMatchObject({ mode: "broadcast", reason: "unpersisted" });
      expect(directedPrints()).toHaveLength(0);
      expect(Object.keys(broadcastPrints()[0])).toEqual(["billId", "escBase64", "station", "kind", "jobId", "publishedAt"]);
    } finally {
      delete process.env.PRINT_JOB_MAX_B64_CHARS;
    }
  });

  test("the accept beat buys the long clock without shortening the at-most-once lease", async () => {
    configureBar();
    const jobId = await dispatchBarKot();
    await routing.acceptPrintJob(RES_ID, OUTLET_ID, jobId, DEVICE_1, 0);
    const row = theJob(jobId);
    expect(must(row.assign_accepted_at, "an accept stamp").getTime()).toBe(T0);
    expect(must(row.assign_expires_at, "a deadline").getTime()).toBe(T0 + VERDICT_MS);
    // greatest(): the beat's job is to give the device MORE time, never less. The
    // standard two-minute lease is longer than the 75-second verdict window, so
    // the lease wins here — a plain `claimed_until = $verdict` would have quietly
    // cut the 027 at-most-once guard down on exactly the jobs a device is
    // actively working on.
    expect(must(row.claimed_until, "a lease").getTime()).toBe(T0 + 2 * MIN);
    expect(must(row.claimed_until, "a lease").getTime())
      .toBeGreaterThanOrEqual(must(row.assign_expires_at, "a deadline").getTime());
  });

  test("a beat from a revoked generation extends nobody's deadline", async () => {
    configureBar();
    const jobId = await dispatchBarKot();
    await routing.acceptPrintJob(RES_ID, OUTLET_ID, jobId, DEVICE_1, 7);
    expect(theJob(jobId).assign_accepted_at).toBeNull();
    expect(must(theJob(jobId).assign_expires_at, "a deadline").getTime()).toBe(T0 + ACCEPT_MS);
  });
});

// ---------------------------------------------------------------------------
// PIN 4 — the CAS.
// ---------------------------------------------------------------------------
describe("the reassign compare-and-swap", () => {
  const next = () => ({
    assigned_device_id: DEVICE_2,
    assigned_target: "EPSON TM-T82",
    destination_id: DEST_BAR,
    assign_expires_at: new Date(T0 + ACCEPT_MS),
  });

  test("REFUSES a row somebody else is holding — live lease, a different claimed_by", async () => {
    // The ordinary shape of a device that accepted and is spooling (its beat
    // landed on another replica), or of an agent that picked the job up through
    // the reconnect door. Taking it back is two printers and one guest.
    const row = addJob({
      status: "delivered", assigned_device_id: DEVICE_3, assign_generation: 0,
      assign_expires_at: new Date(T0 - SEC),
      claimed_by: `device:${DEVICE_3}`, claimed_until: new Date(T0 + MIN),
    });
    await expect(db.ReassignPrintJob(RES_ID, row.id, 0, next(), DEVICE_1)).resolves.toBeNull();
    expect(theJob(row.id).assigned_device_id).toBe(DEVICE_3);
    expect(theJob(row.id).assign_generation).toBe(0);
  });

  test("ACCEPTS a row held by the device it is moving off — the one lease it is entitled to break", async () => {
    // Without this leg the ~1s reject beat and the ~62s 'failed' ack both wait out
    // a two-minute lease, and the kitchen discovers a jammed printer at the reaper.
    const row = addJob({
      status: "delivered", assigned_device_id: DEVICE_1, assign_generation: 0,
      assign_expires_at: new Date(T0 + ACCEPT_MS),
      claimed_by: `device:${DEVICE_1}`, claimed_until: new Date(T0 + 2 * MIN),
    });
    await expect(db.ReassignPrintJob(RES_ID, row.id, 0, next(), DEVICE_1))
      .resolves.toEqual({ id: row.id, assign_generation: 1 });
    const after = theJob(row.id);
    expect(after.assigned_device_id).toBe(DEVICE_2);
    // The device moved off is the device that must never be offered this job
    // again, so the CAS writes it into the exclude set itself.
    expect(after.failed_devices).toEqual([DEVICE_1]);
    expect(after.claimed_by).toBe(`device:${DEVICE_2}`);
    // The NEXT device's durable lease is minutes, from the database's clock —
    // never the caller's four-second deadline.
    expect(must(after.claimed_until, "a lease").getTime()).toBe(T0 + 2 * MIN);
    expect(must(after.assign_expires_at, "a deadline").getTime()).toBe(T0 + ACCEPT_MS);
  });

  test("refuses a stale generation, so two replicas racing one row produce exactly one hop", async () => {
    const row = addJob({
      status: "delivered", assigned_device_id: DEVICE_1, assign_generation: 0,
      assign_expires_at: new Date(T0 - SEC), claimed_by: `device:${DEVICE_1}`, claimed_until: null,
    });
    const [a, b] = await Promise.all([
      db.ReassignPrintJob(RES_ID, row.id, 0, next(), DEVICE_1),
      db.ReassignPrintJob(RES_ID, row.id, 0, next(), DEVICE_1),
    ]);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    expect(theJob(row.id).assign_generation).toBe(1);
  });

  test("refuses a terminal row: a printed docket is never handed on", async () => {
    const row = addJob({
      status: "acked", ack_result: "printed", assigned_device_id: DEVICE_1,
      assign_generation: 0, assign_expires_at: new Date(T0 - SEC), claimed_until: null,
    });
    await expect(db.ReassignPrintJob(RES_ID, row.id, 0, next(), DEVICE_1)).resolves.toBeNull();
  });

  test("with the latch false it refuses every CAS rather than raising 42703 into the ladder", async () => {
    db.__printRoutingTestSeam.setSchemaReady(false);
    const row = addJob({ status: "delivered", assign_generation: 0, claimed_until: null });
    await expect(db.ReassignPrintJob(RES_ID, row.id, 0, next(), null)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PIN 5 — the last rung.
// ---------------------------------------------------------------------------
describe("the broadcast rung", () => {
  test("is idempotent: the second replica to reach it for one job gets false", async () => {
    // Both used to get true, and both then shouted the whole ESC/POS payload into
    // the outlet room where the C# agent printed it unconditionally — two kitchen
    // dockets, or on a bill two charge slips. The SET writes status='pending'
    // while the WHERE admits 'pending', so status can never carry this
    // idempotence; broadcast_at is written once and never taken back.
    const row = addJob({
      status: "delivered", assigned_device_id: DEVICE_1, assign_generation: 1,
      claimed_by: `device:${DEVICE_1}`, claimed_until: new Date(T0 + 2 * MIN),
    });
    await expect(db.MarkPrintJobBroadcast(RES_ID, row.id, 1, DEVICE_1)).resolves.toBe(true);
    await expect(db.MarkPrintJobBroadcast(RES_ID, row.id, 1, DEVICE_1)).resolves.toBe(false);
    expect(theJob(row.id).broadcast_at).not.toBeNull();
    // Back in the legacy replay set: unassigned and 'pending' is what lets the C#
    // agent and every old build resume it on reconnect.
    expect(theJob(row.id)).toMatchObject({ status: "pending", assigned_device_id: null, claimed_until: null });
  });

  test("a stale escalation cannot announce 'nobody could serve this' about a moved job", async () => {
    const row = addJob({ status: "delivered", assign_generation: 2, claimed_until: null });
    await expect(db.MarkPrintJobBroadcast(RES_ID, row.id, 1, DEVICE_1)).resolves.toBe(false);
    expect(theJob(row.id).broadcast_at).toBeNull();
  });

  test("a row another agent is holding is not ours to hand to the whole outlet", async () => {
    const row = addJob({
      status: "delivered", assign_generation: 0,
      claimed_by: `device:${DEVICE_3}`, claimed_until: new Date(T0 + MIN),
    });
    await expect(db.MarkPrintJobBroadcast(RES_ID, row.id, 0, DEVICE_1)).resolves.toBe(false);
  });

  test("a job the database says is already settled is NOT re-emitted", async () => {
    // THE DOUBLE-PRINT THIS INTERLOCK EXISTS FOR: the device printed and acked,
    // and four seconds later a deadline nothing had cancelled fired anyway, found
    // an empty chain with that device excluded, and re-broadcast the payload.
    configureBar({ online: [DEVICE_1] });
    const jobId = await dispatchBarKot();
    // Settle the row behind the ladder's back, exactly as a cross-replica ack does.
    const row = theJob(jobId);
    row.status = "acked";
    row.ack_result = "printed";
    row.claimed_until = null;

    await routing.rejectPrintJob(RES_ID, OUTLET_ID, jobId, DEVICE_1, 0, "printer_gone");
    expect(broadcastPrints()).toHaveLength(0);
    expect(emitsOf("print:stuck")).toHaveLength(0);
  });

  test("but a row the DATABASE cannot answer about still gets its paper", async () => {
    // A definitive false suppresses; an exception or a pending 042 tells us
    // nothing, and refusing to print because we could not record WHY we are
    // printing would invert the whole point of this rung.
    configureBar({ online: [DEVICE_1] });
    const jobId = await dispatchBarKot();
    db.__printRoutingTestSeam.setSchemaReady(false);
    await routing.rejectPrintJob(RES_ID, OUTLET_ID, jobId, DEVICE_1, 0, "printer_gone");
    expect(broadcastPrints()).toHaveLength(1);
    expect(Object.keys(broadcastPrints()[0])).toEqual(["billId", "escBase64", "station", "kind", "jobId", "publishedAt"]);
  });
});

// ---------------------------------------------------------------------------
// PIN 6 — the lost-docket pin.
// ---------------------------------------------------------------------------
describe("a device is NEVER re-offered a job it has already refused", () => {
  // WHY THIS IS THE ONE THAT LOSES PAPER: the client writes
  // _settled[jobId]='printed' immediately BEFORE its first send, so a same-device
  // re-offer is answered with a FALSE 'printed' ack. The job is then recorded as
  // printed and no paper ever came out — a silent lost docket, with no bell.

  test("the reject beat walks the chain forward and never back", async () => {
    configureBar();
    const jobId = await dispatchBarKot("KOT-5", "esc-5");
    expect(directedPrints().map((p) => p.deviceId)).toEqual([DEVICE_1]);

    await routing.rejectPrintJob(RES_ID, OUTLET_ID, jobId, DEVICE_1, 0, "no_printer");

    // Recall FIRST: without it, reassignment IS a cross-device duplicate.
    expect(emitsOf("print:revoke").map((e) => e.room)).toEqual([deviceRoom(RES_ID, OUTLET_ID, DEVICE_1)]);
    expect(directedPrints().map((p) => p.deviceId)).toEqual([DEVICE_1, DEVICE_2]);
    // A re-offer RE-OFFERS; it never re-renders. Re-rendering would mint a second
    // KOT number, or a bill carrying figures the guest was never shown.
    expect(directedPrints()[1].payload.escBase64).toBe("esc-5");
    expect(directedPrints()[1].payload.route).toMatchObject({ deviceId: DEVICE_2, generation: 1 });
    expect(theJob(jobId).failed_devices).toEqual([DEVICE_1]);

    await routing.rejectPrintJob(RES_ID, OUTLET_ID, jobId, DEVICE_2, 1, "no_printer");

    // Chain exhausted with BOTH devices excluded -> today's outlet broadcast.
    expect(directedPrints().map((p) => p.deviceId)).toEqual([DEVICE_1, DEVICE_2]);
    expect(broadcastPrints()).toHaveLength(1);
    expect(broadcastPrints()[0]).not.toHaveProperty("route");
    expect(emitsOf("print:stuck")).toHaveLength(1);
    expect(theJob(jobId).failed_devices).toEqual([DEVICE_1, DEVICE_2]);
  });

  test("a reject naming a generation the ladder has moved past is discarded, not acted on", async () => {
    configureBar();
    const jobId = await dispatchBarKot();
    await routing.rejectPrintJob(RES_ID, OUTLET_ID, jobId, DEVICE_1, 0, "no_printer");
    const before = directedPrints().length;
    // D1's straggler, about an assignment that no longer exists. Acting on it
    // would take the job away from D2 on the strength of a message about D1.
    await routing.rejectPrintJob(RES_ID, OUTLET_ID, jobId, DEVICE_1, 0, "no_printer");
    expect(directedPrints()).toHaveLength(before);
    expect(theJob(jobId).assigned_device_id).toBe(DEVICE_2);
  });

  test("ON THE ADOPTION PATH the exclude set is built from the ROW, not from a registry entry", async () => {
    // The replica that dispatched the job is not the replica the ack landed on —
    // the ordinary multi-replica case, and the single-replica case after any
    // restart between dispatch and a ~62-second 'failed' ack. By then the row is
    // 'pending', unassigned, unleased and owned by nobody.
    configureBar();
    const row = addJob({
      kind: "kot", station: "Bar", bill_id: "KOT-7", esc_base64: "esc-7",
      status: "pending", assigned_device_id: null, destination_id: DEST_BAR,
      assign_generation: 0, assign_expires_at: new Date(T0), claimed_until: null,
      failed_devices: [DEVICE_1],
    });
    // This replica holds nothing for this job.
    expect(routing.__printRoutingTestSeam.peek(row.id)).toBeNull();

    await routing.escalatePrintJob(RES_ID, OUTLET_ID, row.id, "device_failed", 0, {
      billId: "KOT-7", escBase64: "esc-7", kind: "kot", station: "Bar",
      destinationId: DEST_BAR, generation: 0, failedDevices: [DEVICE_1], fromDeviceId: DEVICE_1,
    });

    expect(directedPrints().map((p) => p.deviceId)).toEqual([DEVICE_2]);
    expect(directedPrints()[0].payload.escBase64).toBe("esc-7");
    expect(theJob(row.id).assigned_device_id).toBe(DEVICE_2);
  });

  test("an adopted job whose row excludes EVERY candidate goes straight to the broadcast rung", async () => {
    configureBar();
    const row = addJob({
      kind: "kot", station: "Bar", bill_id: "KOT-8", esc_base64: "esc-8",
      status: "pending", assigned_device_id: null, destination_id: DEST_BAR,
      assign_generation: 0, assign_expires_at: new Date(T0), claimed_until: null,
      failed_devices: [DEVICE_1, DEVICE_2],
    });
    await routing.escalatePrintJob(RES_ID, OUTLET_ID, row.id, "device_failed", 0, {
      billId: "KOT-8", escBase64: "esc-8", kind: "kot", station: "Bar",
      destinationId: DEST_BAR, generation: 0, failedDevices: [DEVICE_1, DEVICE_2], fromDeviceId: DEVICE_1,
    });
    expect(directedPrints()).toHaveLength(0);
    expect(broadcastPrints()).toHaveLength(1);
    expect(broadcastPrints()[0].escBase64).toBe("esc-8");
    expect(theJob(row.id).broadcast_at).not.toBeNull();
  });

  test("the generation cap terminates the ladder instead of looping it", async () => {
    process.env.PRINT_MAX_ASSIGN_GENERATIONS = "1";
    try {
      configureBar();
      addBinding({ device_id: DEVICE_3, destination_id: DEST_BAR, target: "tcp://third", priority: 90 });
      addPrintSocket({ deviceId: DEVICE_3, destinations: [DEST_BAR] });
      const jobId = await dispatchBarKot();
      await routing.rejectPrintJob(RES_ID, OUTLET_ID, jobId, DEVICE_1, 0, "no_printer");
      expect(directedPrints().map((p) => p.deviceId)).toEqual([DEVICE_1, DEVICE_2]);
      // Generation 2 would exceed the cap, so D3 is never offered it — the paper
      // comes out on the broadcast rung instead of the ladder spinning.
      await routing.rejectPrintJob(RES_ID, OUTLET_ID, jobId, DEVICE_2, 1, "no_printer");
      expect(directedPrints().map((p) => p.deviceId)).toEqual([DEVICE_1, DEVICE_2]);
      expect(broadcastPrints()).toHaveLength(1);
    } finally {
      delete process.env.PRINT_MAX_ASSIGN_GENERATIONS;
    }
  });
});

// ---------------------------------------------------------------------------
// PIN 7 — the ack nobody signs.
// ---------------------------------------------------------------------------
describe("the routed ack", () => {
  test("an UNSIGNED 'failed' — which is every production ack — still records the failing device", async () => {
    // POST /print/ack has carried {jobId, result} since 027 and names no device.
    // Without the row-derived fallback the job is released with failed_devices
    // EMPTY, the ladder re-resolves with an empty exclude set, and re-offers the
    // docket to the printer that just reported the jam.
    const row = addJob({
      kind: "kot", station: "Bar", status: "delivered", assigned_device_id: DEVICE_1,
      assigned_target: "tcp://bar", destination_id: DEST_BAR, assign_generation: 0,
      claimed_by: `device:${DEVICE_1}`, claimed_until: new Date(T0 + 2 * MIN),
    });
    const out = await db.AckPrintJobRouted(RES_ID, row.id, { deviceId: null, generation: null }, "failed");
    expect(out).toMatchObject({ reassign: true, settled: false, terminal: false, superseded: false });
    expect(out.failed_devices).toEqual([DEVICE_1]);
    // Released and owned by nobody — which is why the caller must escalate here,
    // in process, before the request ends.
    expect(theJob(row.id)).toMatchObject({ status: "pending", assigned_device_id: null, claimed_until: null });
  });

  test("its own ack retry is a no-op and cannot disturb the live assignee", async () => {
    const row = addJob({
      status: "delivered", assigned_device_id: DEVICE_2, assigned_target: "t",
      destination_id: DEST_BAR, assign_generation: 1, failed_devices: [DEVICE_1],
      claimed_by: `device:${DEVICE_2}`, claimed_until: new Date(T0 + 2 * MIN),
    });
    // Unsigned, and the row is no longer at generation 0 with an empty
    // failed_devices, so it is NOT attributable: record and stop.
    const out = await db.AckPrintJobRouted(RES_ID, row.id, { deviceId: null, generation: null }, "failed");
    expect(out).toMatchObject({ reassign: false, superseded: true, duplicate: false });
    expect(theJob(row.id)).toMatchObject({ status: "delivered", assigned_device_id: DEVICE_2 });
  });

  test("an unsigned 'failed' is refused once MORE THAN ONE device has reported on the job", async () => {
    // The generation is still 0 — MarkPrintJobBroadcast and the record-only arm
    // both append to failed_devices without bumping it — but something other than
    // the assignee has already spoken about this job, so an ack nobody signed can
    // no longer be pinned on the assignee. Releasing D2's live assignment here
    // would tear it down mid-spool on the strength of a message from a stranger.
    const row = addJob({
      status: "delivered", assigned_device_id: DEVICE_2, assigned_target: "t",
      destination_id: DEST_BAR, assign_generation: 0, failed_devices: [DEVICE_1],
      claimed_by: `device:${DEVICE_2}`, claimed_until: new Date(T0 + 2 * MIN),
    });
    const out = await db.AckPrintJobRouted(RES_ID, row.id, { deviceId: null, generation: null }, "failed");
    expect(out).toMatchObject({ reassign: false, superseded: true, settled: false });
    expect(theJob(row.id)).toMatchObject({ status: "delivered", assigned_device_id: DEVICE_2 });
    expect(must(theJob(row.id).claimed_until, "a lease").getTime()).toBe(T0 + 2 * MIN);
  });

  test("a second 'failed' from a device already in failed_devices changes nothing at all", async () => {
    const row = addJob({
      status: "delivered", assigned_device_id: DEVICE_2, destination_id: DEST_BAR,
      assign_generation: 1, failed_devices: [DEVICE_1], claimed_until: null,
    });
    const out = await db.AckPrintJobRouted(RES_ID, row.id, { deviceId: DEVICE_1, generation: 0 }, "failed");
    expect(out).toMatchObject({ ok: false, duplicate: true, reassign: false });
    expect(theJob(row.id)).toMatchObject({ status: "delivered", assigned_device_id: DEVICE_2 });
  });

  test("a LATE 'printed' from a superseded assignee is honoured as printed, from any generation", async () => {
    // Paper is paper. Rejecting it as stale would leave the row pending and the
    // ladder would print it again — on a bill, a second charge slip.
    const row = addJob({
      status: "delivered", assigned_device_id: DEVICE_2, destination_id: DEST_BAR,
      assign_generation: 3, failed_devices: [DEVICE_1], claimed_until: null,
    });
    const out = await db.AckPrintJobRouted(RES_ID, row.id, { deviceId: DEVICE_1, generation: 0 }, "printed");
    expect(out).toMatchObject({ printed: true, settled: true, reassign: false });
    expect(theJob(row.id)).toMatchObject({ status: "acked", ack_result: "printed" });
    // …and receipt history is left alone rather than crediting whichever device
    // happens to hold the assignment now.
    expect(theJob(row.id).printed_by_device).toBeNull();
  });

  test("printed_by_device comes from the ROW, never from the caller", async () => {
    const row = addJob({
      status: "delivered", assigned_device_id: DEVICE_1, destination_id: DEST_BAR,
      assign_generation: 0, claimed_until: null,
    });
    await db.AckPrintJobRouted(RES_ID, row.id, { deviceId: DEVICE_1, generation: 0 }, "printed");
    expect(theJob(row.id).printed_by_device).toBe(DEVICE_1);
  });

  test("at the generation cap 'failed' is terminal again, as it was before routing", async () => {
    const row = addJob({
      status: "delivered", assigned_device_id: DEVICE_1, destination_id: DEST_BAR,
      assign_generation: 4, claimed_until: null,
    });
    const out = await db.AckPrintJobRouted(RES_ID, row.id, { deviceId: DEVICE_1, generation: 4 }, "failed");
    expect(out).toMatchObject({ terminal: true, settled: true, reassign: false });
    expect(theJob(row.id)).toMatchObject({ status: "failed", ack_result: "failed" });
  });

  test("END TO END: a jammed printer's unsigned ack moves the docket to the next device, never back", async () => {
    configureBar();
    const jobId = await dispatchBarKot("KOT-3", "esc-3");
    expect(directedPrints().map((p) => p.deviceId)).toEqual([DEVICE_1]);

    // Exactly what POST /print/ack does today: no device, no generation.
    const ack = await printJobs.ackPrintJob(RES_ID, jobId, "failed");
    expect(ack).toMatchObject({ settled: false, reassigned: true });

    expect(directedPrints().map((p) => p.deviceId)).toEqual([DEVICE_1, DEVICE_2]);
    expect(directedPrints()[1].payload.escBase64).toBe("esc-3");
    expect(theJob(jobId).failed_devices).toContain(DEVICE_1);
    expect(theJob(jobId).assigned_device_id).toBe(DEVICE_2);
  });

  test("END TO END, on a replica that never dispatched it: the row alone carries the exclude set", async () => {
    configureBar();
    const jobId = await dispatchBarKot("KOT-4", "esc-4");
    // The dispatching replica's registry is gone — a restart, or the ack landed
    // behind a different box on the load balancer.
    routing.__printRoutingTestSeam.reset();

    await printJobs.ackPrintJob(RES_ID, jobId, "failed");

    expect(directedPrints().map((p) => p.deviceId)).toEqual([DEVICE_1, DEVICE_2]);
    expect(theJob(jobId).assigned_device_id).toBe(DEVICE_2);
  });

  test("a 'printed' ack cancels the ladder, so nothing re-broadcasts behind it", async () => {
    configureBar({ online: [DEVICE_1] });
    const jobId = await dispatchBarKot();
    expect(routing.__printRoutingTestSeam.outstanding()).toEqual([jobId]);
    await printJobs.ackPrintJob(RES_ID, jobId, "printed");
    expect(routing.__printRoutingTestSeam.outstanding()).toEqual([]);
    expect(broadcastPrints()).toHaveLength(0);
  });

  test("an unrouted job takes the pre-042 ack path, where 'failed' is still terminal", async () => {
    const res = await routing.dispatchPrintJob(RES_ID, {
      outlet_id: OUTLET_ID, bill_id: "B1", kind: "bill", station: null, esc_base64: "esc",
    });
    const jobId = must(res.jobId, "a persisted job");
    await expect(printJobs.ackPrintJob(RES_ID, jobId, "failed"))
      .resolves.toEqual({ settled: true, duplicate: false });
    expect(theJob(jobId)).toMatchObject({ status: "failed", ack_result: "failed" });
  });
});

// ---------------------------------------------------------------------------
// PIN 9 — THE POOL-SAFETY PIN. DO NOT DELETE THIS BLOCK.
// ---------------------------------------------------------------------------
describe("runPrintOrphanSweep", () => {
  // The 2026-08-24 standstill was per-tenant sweeps on a timer against a 15-slot
  // session pooler. This sweep runs every 60 seconds in every replica, forever,
  // so its cost on an UNCONFIGURED fleet — which is the entire fleet on the day
  // this ships — has to be provably zero. The guard is two early returns in
  // print_routing.ts; these tests are the only thing standing between them and a
  // well-meaning "just check the database for orphans" refactor.

  test("opens ZERO database connections while no routed outlet has a device online", async () => {
    const withTenant = jest.spyOn(db, "withTenant");
    const before = connections();

    await routing.runPrintOrphanSweep();

    expect(withTenant).not.toHaveBeenCalled();
    expect(connections()).toBe(before);
    expect(emits()).toEqual([]);
  });

  test("an outlet that dispatched only BROADCAST jobs never reaches the registry, so the sweep stays free", async () => {
    const withTenant = jest.spyOn(db, "withTenant");
    // No routes: every docket takes today's path and nothing is watched.
    for (let i = 0; i < 5; i++) {
      await routing.dispatchPrintJob(RES_ID, {
        outlet_id: OUTLET_ID, bill_id: `B${String(i)}`, kind: "bill", station: null, esc_base64: "esc",
      });
    }
    const before = connections();
    await routing.runPrintOrphanSweep();
    expect(withTenant).not.toHaveBeenCalled();
    expect(connections()).toBe(before);
  });

  test("a routed job whose deadline is still in the future costs no connection either", async () => {
    configureBar();
    await dispatchBarKot();
    const withTenant = jest.spyOn(db, "withTenant");
    const before = connections();
    await routing.runPrintOrphanSweep();
    expect(withTenant).not.toHaveBeenCalled();
    expect(connections()).toBe(before);
  });

  test("…and the guard is not vacuous: an OVERDUE deadline is escalated", async () => {
    // If this ever goes green alongside a sweep that opens no connection, the
    // backstop has stopped being a backstop.
    configureBar();
    const jobId = await dispatchBarKot();
    expect(routing.__printRoutingTestSeam.expire(jobId)).toBe(true);
    const before = connections();
    await routing.runPrintOrphanSweep();
    expect(connections()).toBeGreaterThan(before);
    expect(directedPrints().map((p) => p.deviceId)).toEqual([DEVICE_1, DEVICE_2]);
  });
});

// ---------------------------------------------------------------------------
describe("the last rung is ALWAYS an outlet broadcast, whatever went wrong", () => {
  // §5's invariant as a table. Each row is a fault the design names; the
  // assertion is the same one every time, because the promise is the same one
  // every time: paper comes out, on the room this restaurant has printed from
  // since 027.

  test("no route at all", async () => {
    await routing.dispatchPrintJob(RES_ID, {
      outlet_id: OUTLET_ID, bill_id: "K", kind: "kot", station: "Bar", esc_base64: "e",
    });
    expect(broadcastPrints()).toHaveLength(1);
  });

  test("a route, but nothing online that can serve it", async () => {
    configureBar({ online: [] });
    await dispatchBarKot();
    expect(broadcastPrints()).toHaveLength(1);
    expect(emitsOf("print:destination_offline")).toHaveLength(1);
  });

  test("the only other device in the chain went offline mid-ladder", async () => {
    addDestination({ id: DEST_BAR, name: "Bar Printer" });
    addRoute("kot:BAR", DEST_BAR);
    addBinding({ device_id: DEVICE_1, destination_id: DEST_BAR, target: "tcp://bar", priority: 10 });
    addBinding({ device_id: DEVICE_2, destination_id: DEST_BAR, target: "EPSON TM-T82", priority: 50 });
    addPrintSocket({ deviceId: DEVICE_1, destinations: [DEST_BAR] });
    const tablet = addPrintSocket({ deviceId: DEVICE_2, destinations: [DEST_BAR] });

    const jobId = await dispatchBarKot();
    // The tablet sleeps between the dispatch and the till saying it cannot print.
    dropSocket(tablet);
    tick(10);
    await routing.rejectPrintJob(RES_ID, OUTLET_ID, jobId, DEVICE_1, 0, "no_printer");

    expect(directedPrints().map((p) => p.deviceId)).toEqual([DEVICE_1]);
    expect(broadcastPrints()).toHaveLength(1);
  });

  test("the whole routing schema is missing", async () => {
    breakRoutingTables();
    configureBar();
    await dispatchBarKot();
    expect(broadcastPrints()).toHaveLength(1);
  });

  test("the database refuses the reassignment", async () => {
    configureBar();
    const jobId = await dispatchBarKot();
    // The row cannot be moved, so the ladder cannot continue — but the paper
    // still has to come out, and the last rung needs no schema at all.
    db.__printRoutingTestSeam.setSchemaReady(false);
    await routing.rejectPrintJob(RES_ID, OUTLET_ID, jobId, DEVICE_1, 0, "no_printer");
    expect(broadcastPrints()).toHaveLength(1);
    expect(must(jobById(jobId), "the row").esc_base64).toBe(broadcastPrints()[0].escBase64);
  });

  test("the registry overflows", async () => {
    process.env.PRINT_ASSIGN_REGISTRY_MAX = "1";
    try {
      configureBar({ online: [DEVICE_1] });
      const first = await dispatchBarKot("KOT-A", "esc-A");
      await dispatchBarKot("KOT-B", "esc-B");
      await flush();
      // The OLDEST outstanding assignment is promoted to the broadcast rung, never
      // dropped: "the map was full" is not one of the states the invariant makes
      // an exception for.
      expect(broadcastPrints().map((p) => p.escBase64)).toEqual(["esc-A"]);
      expect(must(jobById(first), "the row").broadcast_at).not.toBeNull();
    } finally {
      delete process.env.PRINT_ASSIGN_REGISTRY_MAX;
    }
  });
});
