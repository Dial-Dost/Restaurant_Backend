// The 042 half of the fake `pg` Pool, plus a fake socket.io Server, so the REAL
// routing path (print_routing.ts -> database_supabase.ts -> realtime.ts) can be
// driven as a unit test with no database and no network.
//
// WHY A SECOND FIXTURE FILE AND NOT AN EXTENSION OF print_fixtures.ts. That file
// belongs to the durability suite (print_jobs.test.ts) and models exactly the
// six "PrintJobs" statements migration 027 shipped. Routing adds nine columns to
// that table, four new tables, and six more statements, and — more importantly —
// it needs a socket layer, because half of what resolvePrintTarget decides is
// decided by who is in which room. Folding all of that into print_fixtures.ts
// would make the durability suite's harness depend on 042. The tenant ids ARE
// imported from there rather than re-declared: the two suites describe one
// restaurant, and a second set of uuids that drifted would be a silent lie about
// which outlet a job belongs to.
//
// THE RULE THAT MAKES THIS HONEST IS print_fixtures.ts's, unchanged: BEHAVIOUR IS
// DERIVED FROM THE SQL TEXT. The generation fence, the 027 lease leg, its named
// claimed_by exception, the broadcast_at idempotence fence, the routed ack's
// attribution leg and ClaimPrintJobsForAgent's conditional routing clause are all
// read out of the statement and applied only if they are actually there. Delete a
// predicate in database_supabase.ts and a test here goes red, instead of the
// fixture continuing to enforce a rule the database no longer has. Where a
// construct cannot be emulated, requireShape asserts on its text and says why.
//
// WHAT IT DOES NOT MODEL, because an inaccurate promise is worse than none:
//   * isolation — every write is visible immediately, as if READ UNCOMMITTED.
//     Strictly harsher than Postgres for these tests (a loser sees the winner's
//     row mid-flight, which is the interleaving we want to survive).
//   * the adapter — fetchSockets() here is synchronous truth about a Map. The
//     750ms race, the null-vs-empty distinction and the cross-replica case are
//     realtime.ts's own and are exercised by feeding this Map, not by faking a
//     network partition.
//
// Dispatch matches on a marker in the SQL and THROWS on anything unrecognised, so
// a code path that starts issuing a new query fails loudly here rather than
// silently receiving zero rows.

import { OTHER_OUTLET_ID, OUTLET_ID, RES_ID } from "./print_fixtures";

// Re-exported so a test file needs one import for the whole harness. These are
// print_fixtures.ts's constants; see the header for why they are not re-minted.
export { OTHER_OUTLET_ID, OUTLET_ID, RES_ID };

/** Two devices bound to one destination ARE the failover chain. Windows binds at
 *  priority 10 and Android at 50 (LOWER WINS), so D1 is the till and D2 the
 *  tablet in every test below unless a case says otherwise. */
export const DEVICE_1 = "d1111111-1111-4111-8111-111111111111";
export const DEVICE_2 = "d2222222-2222-4222-8222-222222222222";
export const DEVICE_3 = "d3333333-3333-4333-8333-333333333333";
export const DEST_BAR = "de511111-1111-4111-8111-111111111111";
export const DEST_BILL = "de522222-2222-4222-8222-222222222222";

// --- the store ---------------------------------------------------------------

export interface RoutingJobRow {
  id: string;
  /** Insertion order — the ORDER BY's tiebreaker. */
  seq: number;
  created_at: Date;
  res_id: string;
  outlet_id: string;
  bill_id: string;
  kind: string;
  station: string | null;
  esc_base64: string;
  status: string;
  attempts: number;
  claimed_by: string | null;
  claimed_until: Date | null;
  delivered_at: Date | null;
  settled_at: Date | null;
  ack_result: string | null;
  // --- migration 042's nine additive columns ---
  assigned_device_id: string | null;
  assigned_target: string | null;
  destination_id: string | null;
  assign_expires_at: Date | null;
  assign_generation: number;
  assign_accepted_at: Date | null;
  failed_devices: string[];
  printed_by_device: string | null;
  broadcast_at: Date | null;
}

export interface DestinationRow { id: string; res_id: string; outlet_id: string; name: string; active: boolean }
export interface RouteRow { id: string; res_id: string; outlet_id: string; role: string; destination_id: string }
export interface BindingRow {
  res_id: string; outlet_id: string; device_id: string; device_key: string;
  device_label: string | null; device_platform: string | null; device_retired_at: Date | null;
  destination_id: string; target: string; priority: number; active: boolean;
}

interface Store {
  jobs: RoutingJobRow[];
  destinations: DestinationRow[];
  routes: RouteRow[];
  bindings: BindingRow[];
  /** Migration 027 not applied: every "PrintJobs" statement raises 42P01. */
  jobsTableMissing: boolean;
  /** Migration 042's TABLES not applied: the four new tables raise 42P01. The
   *  COLUMN half is a different fault and is simulated by the boot latch. */
  routingTablesMissing: boolean;
  nextId: number;
  /** pool.connect() count. THE POOL-SAFETY PIN READS THIS. */
  connects: number;
  /** Every statement this run issued, raw, for the tests that assert on text. */
  statements: { sql: string; params: unknown[] }[];
}

let store: Store = freshStore();

function freshStore(): Store {
  return {
    jobs: [], destinations: [], routes: [], bindings: [],
    jobsTableMissing: false, routingTablesMissing: false,
    nextId: 1, connects: 0, statements: [],
  };
}

export function resetStore(): void { store = freshStore(); }

export function jobs(): RoutingJobRow[] { return store.jobs; }
export function jobById(id: string): RoutingJobRow | undefined { return store.jobs.find((j) => j.id === id); }
export function theJob(id: string): RoutingJobRow {
  const r = jobById(id);
  if (!r) { throw new Error(`no "PrintJobs" row ${id}`); }
  return r;
}

/** How many connections the code under test checked out of the pool. */
export function connections(): number { return store.connects; }
export function statements(): { sql: string; params: unknown[] }[] { return store.statements; }

/** The most recent statement matching `marker`, RAW — for the pins that assert on
 *  text rather than on behaviour. */
export function lastStatement(marker: RegExp): { sql: string; params: unknown[] } {
  for (let i = store.statements.length - 1; i >= 0; i--) {
    const s = store.statements[i];
    if (marker.test(s.sql.replace(/\s+/g, " "))) { return s; }
  }
  throw new Error(`no statement matched ${String(marker)}`);
}

export function breakPrintJobsTable(): void { store.jobsTableMissing = true; }
export function breakRoutingTables(): void { store.routingTablesMissing = true; }

export function addJob(over: Partial<RoutingJobRow> = {}): RoutingJobRow {
  const n = store.nextId++;
  const row: RoutingJobRow = {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    seq: n,
    created_at: new Date(),
    res_id: RES_ID,
    outlet_id: OUTLET_ID,
    bill_id: "BILL-1",
    kind: "bill",
    station: null,
    esc_base64: "SEVMTE8=",
    status: "pending",
    attempts: 0,
    claimed_by: null,
    claimed_until: null,
    delivered_at: null,
    settled_at: null,
    ack_result: null,
    assigned_device_id: null,
    assigned_target: null,
    destination_id: null,
    assign_expires_at: null,
    assign_generation: 0,
    assign_accepted_at: null,
    failed_devices: [],
    printed_by_device: null,
    broadcast_at: null,
    ...over,
  };
  store.jobs.push(row);
  return row;
}

export function addDestination(over: Partial<DestinationRow> & { id: string; name: string }): DestinationRow {
  const row: DestinationRow = {
    res_id: RES_ID, outlet_id: OUTLET_ID, active: true, ...over,
  };
  store.destinations.push(row);
  return row;
}

/** A RULE. `role` is stored exactly as given, because 042's unique index is on
 *  lower(role) and a tenant's rows can therefore differ only in case — which is
 *  the thing the case-insensitivity pin is about. */
export function addRoute(role: string, destinationId: string, over: Partial<RouteRow> = {}): RouteRow {
  const row: RouteRow = {
    id: `r-${String(store.routes.length + 1)}`,
    res_id: RES_ID, outlet_id: OUTLET_ID, role, destination_id: destinationId, ...over,
  };
  store.routes.push(row);
  return row;
}

/** THE ADDRESS. Only the device that can reach a printer knows how to name it. */
export function addBinding(over: Partial<BindingRow> & { device_id: string; destination_id: string; target: string }): BindingRow {
  const row: BindingRow = {
    res_id: RES_ID,
    outlet_id: OUTLET_ID,
    device_key: `key-${over.device_id.slice(0, 8)}`,
    device_label: null,
    device_platform: "windows",
    device_retired_at: null,
    priority: 50,
    active: true,
    ...over,
  };
  store.bindings.push(row);
  return row;
}

const now = (): Date => new Date();

class MissingTableError extends Error {
  code = "42P01";
  constructor(table: string) { super(`relation "${table}" does not exist`); }
}

/**
 * Asserted TEXT, for constructs this fixture cannot emulate. A text assertion
 * only proves a string is present, so everything that CAN be derived is derived
 * instead — see the header.
 */
function requireShape(q: string, fragment: string, why: string): void {
  if (!q.toLowerCase().includes(fragment.toLowerCase())) {
    throw new Error(`print routing fixture: query lost "${fragment}" — ${why}\n  ${q.slice(0, 300)}`);
  }
}

// --- predicates parsed OUT OF the statement ----------------------------------

function statusPredicate(q: string): { negated: boolean; list: string[] } | null {
  const m = /status (not )?in \(([^)]*)\)/i.exec(q);
  if (!m) { return null; }
  return { negated: Boolean(m[1]), list: m[2].split(",").map((s) => s.trim().replace(/^'|'$/g, "")) };
}

function statusAdmits(pred: { negated: boolean; list: string[] } | null, status: string): boolean {
  if (!pred) { return true; }
  const inList = pred.list.includes(status);
  return pred.negated ? !inList : inList;
}

/**
 * THE 027 LEASE LEG, WITH ITS NAMED EXCEPTION, as ReassignPrintJob and
 * MarkPrintJobBroadcast both carry it.
 *
 * Both halves are read out of the text and both are load-bearing in opposite
 * directions, which is exactly why neither may be assumed here: without the
 * lease the ladder yanks rows out from under a device that is spooling them (two
 * printers, one guest); without the `claimed_by = $n` exception the fast rungs
 * match zero rows and a rejected docket waits out a two-minute lease. Returning
 * null means the statement carries no lease predicate at all — a mutation the
 * tests must be able to see.
 */
interface LeaseLeg { exceptionIdx: number | null }
function leaseLeg(q: string): LeaseLeg | null {
  const m = /\(claimed_until is null or claimed_until < now\(\)(?: or claimed_by = \$(\d+))?\)/i.exec(q);
  if (!m) { return null; }
  return { exceptionIdx: m[1] ? Number(m[1]) : null };
}

/** THE LADDER'S OWN DEADLINE, same shape and same exception. */
function deadlineLeg(q: string): LeaseLeg | null {
  const m = /\(assign_expires_at is null or assign_expires_at <= now\(\)(?: or claimed_by = \$(\d+))?\)/i.exec(q);
  if (!m) { return null; }
  return { exceptionIdx: m[1] ? Number(m[1]) : null };
}

/**
 * AckPrintJobRouted's two most load-bearing expressions, read conjunct by
 * conjunct rather than asserted as text.
 *
 * WHY NOT requireShape FOR THESE. A text assertion catches a DELETION and
 * nothing else — it cannot tell a widened attribution leg from a correct one,
 * and widening is the dangerous direction: an unsigned ack trusted outside
 * generation 0 lets a revoked device's straggling 'failed' tear down the live
 * assignee while it is spooling. Reading each conjunct separately means a
 * fixture that applies exactly the rule the database has, so both deleting and
 * loosening it change what these tests observe.
 */
interface RoutedAckShape {
  /** An ack that names no device may be attributed at all. */
  unsignedAttribution: boolean;
  /** …only at generation 0. */
  unsignedNeedsGenZero: boolean;
  /** …and only with nothing yet in failed_devices. */
  unsignedNeedsNoFailures: boolean;
  /**
   * The retry arm falls back to the ROW's assignee when the ack named nobody.
   * Every production ack is unsigned, so without this the row is released with
   * an EMPTY exclude set and the ladder re-offers the docket to the printer that
   * just reported the jam — which answers with a FALSE 'printed'.
   */
  retryFallsBackToRow: boolean;
}
function routedAckShape(q: string): RoutedAckShape {
  return {
    unsignedAttribution: /\$3::uuid is null/i.test(q),
    unsignedNeedsGenZero: /\$3::uuid is null and c\.assign_generation = 0/i.test(q),
    unsignedNeedsNoFailures: /jsonb_array_length\(c\.failed_devices\) = 0/i.test(q),
    retryFallsBackToRow:
      /when f\.do_retry then p\.failed_devices \|\| coalesce\( ?\$6::jsonb, case when p\.assigned_device_id is not null then jsonb_build_array\(p\.assigned_device_id::text\)/i.test(q),
  };
}

/** THE GENERATION FENCE. Null when the statement stopped carrying one, which is
 *  how a stale escalation would start winning races it must lose. */
function generationFence(q: string): number | null {
  const m = /assign_generation = \$(\d+)::int/i.exec(q);
  return m ? Number(m[1]) : null;
}

function leaseIntervalIdx(q: string): number | null {
  const m = /make_interval\(mins => \$(\d+)::int\)/i.exec(q);
  return m ? Number(m[1]) : null;
}

function param<T = unknown>(params: unknown[], oneBasedIdx: number | null): T | null {
  if (oneBasedIdx === null) { return null; }
  return (params[oneBasedIdx - 1] ?? null) as T | null;
}

function jsonArray(v: unknown): string[] {
  if (v === null || v === undefined) { return []; }
  try {
    const parsed: unknown = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch { return []; }
}

/**
 * ClaimPrintJobsForAgent's CONDITIONAL routing clause, read branch by branch.
 *
 * The whole point of the boot latch is that this clause is ABSENT under a pending
 * 042 — so its absence has to be observable here, not assumed away. An empty
 * result means "today's statement", and the fixture then applies no routing
 * filter at all, which is precisely what the pin asserts.
 */
interface ClaimRoutingClause {
  unassigned: boolean;
  ownDeviceIdx: number | null;
  lapsed: boolean;
  notFailedIdx: number | null;
}
function claimRoutingClause(q: string): ClaimRoutingClause {
  const own = /assigned_device_id = \$(\d+)::uuid/i.exec(q);
  const notFailed = /not \(failed_devices @> \$(\d+)::jsonb\)/i.exec(q);
  return {
    unassigned: /assigned_device_id is null/i.test(q),
    ownDeviceIdx: own ? Number(own[1]) : null,
    lapsed: /assign_expires_at < now\(\)/i.test(q),
    notFailedIdx: notFailed ? Number(notFailed[1]) : null,
  };
}

// --- the fake client ---------------------------------------------------------

type Undo = () => void;

class FakeClient {
  private undo: Undo[] = [];
  private inTxn = false;

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    const q = sql.replace(/\s+/g, " ").trim();
    if (/^begin$/i.test(q)) { this.inTxn = true; this.undo = []; return { rows: [] }; }
    if (/^commit$/i.test(q)) { this.inTxn = false; this.undo = []; return { rows: [] }; }
    if (/^rollback$/i.test(q)) {
      for (const u of this.undo.reverse()) { u(); }
      this.undo = []; this.inTxn = false;
      return { rows: [] };
    }
    return { rows: await dispatch(sql, q, params, (u) => { if (this.inTxn) { this.undo.push(u); } }) };
  }

  release(): void { /* pooled clients are reusable here */ }
}

export interface FixtureConnection {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  release: () => void;
}
interface FixtureGlobal {
  __printRoutingFixtureConnect?: () => FixtureConnection;
  __printRoutingFixtureIo?: () => unknown;
}
// Wired onto globalThis because a jest.mock factory is hoisted above imports and
// may not close over module scope. A DIFFERENT key from print_fixtures.ts's, so
// importing both files cannot cross-wire two harnesses.
(globalThis as unknown as FixtureGlobal).__printRoutingFixtureConnect = () => {
  store.connects += 1;
  return new FakeClient();
};

const DDL = /^(alter|create|drop|do|grant|revoke|comment|set|truncate)\b/i;
const ROUTING_TABLES = /"(PrintRoutes|PrintDestinations|PrintDeviceTargets|PrintDevices)"/i;

// eslint-disable-next-line @typescript-eslint/require-await
async function dispatch(raw: string, q: string, params: unknown[], journal: (u: Undo) => void): Promise<unknown[]> {
  if (DDL.test(q)) { return []; }
  if (/^select set_config\('app\.res_id'/i.test(q)) { return []; }
  store.statements.push({ sql: raw, params });

  if (/^select id from "Restaurant"$/i.test(q)) { return [{ id: RES_ID }]; }

  // OutletBelongsToRestaurant — the replay path's only authorization question.
  if (/^select id from "Outlets" where id = \$1 and res_id = \$2/i.test(q)) {
    const [outletId, resId] = params as [string, string];
    const known = outletId === OUTLET_ID || outletId === OTHER_OUTLET_ID;
    return known && resId === RES_ID ? [{ id: outletId }] : [];
  }

  const routingTable = ROUTING_TABLES.exec(q);
  if (routingTable && store.routingTablesMissing) {
    throw new MissingTableError(routingTable[1]);
  }
  if (/"PrintJobs"/i.test(q) && store.jobsTableMissing) { throw new MissingTableError("PrintJobs"); }

  // --- ListPrintRoutes ---
  if (/^select r\.id, r\.role, r\.destination_id/i.test(q)) {
    requireShape(q, 'join "PrintDestinations"',
      "an INNER join: 042 cascades a deleted destination's routes away, and a route naming no destination must read as NO RULE (broadcast), never as a rule pointing nowhere");
    const [resId, outletId] = params as [string, string];
    return store.routes
      .filter((r) => r.res_id === resId && r.outlet_id === outletId)
      .flatMap((r) => {
        const d = store.destinations.find((x) => x.id === r.destination_id && x.res_id === r.res_id);
        // The join, not a left join: no destination row means no route row.
        return d ? [{
          id: r.id, role: r.role, destination_id: r.destination_id,
          destination_name: d.name, destination_active: d.active,
        }] : [];
      })
      .sort((a, b) => a.role.toLowerCase().localeCompare(b.role.toLowerCase()));
  }

  // --- ListPrintDestinations ---
  if (/^select id, outlet_id, name, sort_order, active from "PrintDestinations"/i.test(q)) {
    const [resId, outletId] = params as [string, string];
    const includeInactive = /\(true\)/i.test(q);
    return store.destinations
      .filter((d) => d.res_id === resId && d.outlet_id === outletId && (includeInactive || d.active))
      .map((d) => ({ id: d.id, outlet_id: d.outlet_id, name: d.name, sort_order: 0, active: d.active }));
  }

  // --- GetPrintDeviceTargets ---
  if (/^select t\.outlet_id, t\.device_id/i.test(q)) {
    const [resId, outletId, deviceId, destinationId] = params as [string, string, string | null, string | null];
    // Read out of the statement: an ACTIVE-only read is the default, and a
    // retired device is JOINED IN rather than filtered out, so that dropping it
    // from a chain stays the resolver's job and GET /print/health can still say
    // "bound to a machine you retired".
    const activeOnly = !/\(true\)/i.test(q);
    return store.bindings
      .filter((b) => b.res_id === resId && b.outlet_id === outletId)
      .filter((b) => deviceId === null || b.device_id === deviceId)
      .filter((b) => destinationId === null || b.destination_id === destinationId)
      .filter((b) => !activeOnly || b.active)
      .sort((x, y) => (x.priority - y.priority)
        || (x.device_label ?? x.device_key).toLowerCase().localeCompare((y.device_label ?? y.device_key).toLowerCase()))
      .map((b) => ({
        outlet_id: b.outlet_id, device_id: b.device_id, device_key: b.device_key,
        device_label: b.device_label, device_platform: b.device_platform,
        device_retired_at: b.device_retired_at,
        destination_id: b.destination_id,
        destination_name: store.destinations.find((d) => d.id === b.destination_id)?.name ?? null,
        target: b.target, priority: b.priority, active: b.active,
      }));
  }

  // --- EnqueuePrintJob, ASSIGNED arm (migration 042) ---
  if (/^insert into "PrintJobs" \(res_id, outlet_id, bill_id, kind, station, esc_base64, status/i.test(q)) {
    requireShape(q, "returning id",
      "the producer must learn the job's uuid to put it in the emitted payload; without it the till is handed a job it can never ack");
    requireShape(q, "'delivered', 1,",
      "the assignment and the lease are written by THE SAME insert — a job that is assigned but unleased is a row ClaimPrintJobsForAgent hands to the next till that reconnects while the assignee is already spooling it");
    const [resId, outletId, billId, kind, station, esc, claimedBy, expiresIso, deviceId, target, destId] =
      params as [string, string, string, string, string | null, string, string, string, string, string | null, string | null];
    const mins = Number(param(params, leaseIntervalIdx(q)) ?? 0);
    const row = addJob({
      res_id: resId, outlet_id: outletId, bill_id: billId, kind, station,
      esc_base64: esc, created_at: now(),
      status: "delivered", attempts: 1,
      claimed_by: claimedBy,
      // THE LEASE IS MINUTES AND COMES FROM THE DATABASE'S CLOCK, never from the
      // router's four-second deadline — conflating the two opened the reconnect
      // door at t=4s and printed bills twice.
      claimed_until: new Date(now().getTime() + mins * 60_000),
      delivered_at: now(),
      assigned_device_id: deviceId,
      assigned_target: target,
      destination_id: destId,
      assign_expires_at: new Date(expiresIso),
    });
    journal(() => { store.jobs = store.jobs.filter((j) => j !== row); });
    return [{ id: row.id }];
  }

  // --- EnqueuePrintJob, today's unassigned insert ---
  if (/^insert into "PrintJobs" \(res_id, outlet_id, bill_id, kind, station, esc_base64\)/i.test(q)) {
    requireShape(q, "returning id",
      "the producer must learn the job's uuid to put it in the emitted payload");
    const [resId, outletId, billId, kind, station, esc] =
      params as [string, string, string, string, string | null, string];
    const row = addJob({
      res_id: resId, outlet_id: outletId, bill_id: billId, kind, station,
      esc_base64: esc, created_at: now(),
    });
    journal(() => { store.jobs = store.jobs.filter((j) => j !== row); });
    return [{ id: row.id }];
  }

  // --- ClaimPrintJobsForAgent ---
  if (/^with due as \( select id from "PrintJobs"/i.test(q)) {
    requireShape(q, "for update skip locked",
      "two replicas claiming at once must skip each other's locked rows rather than serialise");
    requireShape(q, "order by created_at asc",
      "the N station tickets of one KOT are one logical unit and dockets must reach the kitchen oldest-first");
    const [resId, outletId, , , agentId, leaseIso, limit] =
      params as [string, string, string, string, string, string, number];
    const pred = statusPredicate(q);
    const lease = /\(claimed_until is null or claimed_until < now\(\)\)/i.test(q);
    const routing = claimRoutingClause(q);
    const ownDevice = param<string>(params, routing.ownDeviceIdx);
    const excluded = jsonArray(param(params, routing.notFailedIdx));
    const t = now().getTime();
    const ttl = /created_at > \(case when kind = 'kot' then \$3::timestamptz else \$4::timestamptz end\)/i.test(q);

    const eligible = store.jobs
      .filter((j) => j.res_id === resId && j.outlet_id === outletId)
      .filter((j) => statusAdmits(pred, j.status))
      .filter((j) => !lease || j.claimed_until === null || j.claimed_until.getTime() < t)
      .filter((j) => {
        if (!ttl) { return true; }
        const cutoff = new Date(String(params[j.kind === "kot" ? 2 : 3])).getTime();
        return j.created_at.getTime() > cutoff;
      })
      // THE 042 CLAUSE, applied only if it is actually in the statement. Under the
      // latch it is absent entirely and the row set is today's, to the row.
      .filter((j) => {
        if (!routing.unassigned && routing.ownDeviceIdx === null && !routing.lapsed) { return true; }
        return (routing.unassigned && j.assigned_device_id === null)
          || (ownDevice !== null && j.assigned_device_id === ownDevice)
          || (routing.lapsed && j.assign_expires_at !== null && j.assign_expires_at.getTime() < t);
      })
      .filter((j) => excluded.length === 0 || !excluded.some((d) => j.failed_devices.includes(d)))
      .sort((a, b) => (a.created_at.getTime() - b.created_at.getTime()) || (a.seq - b.seq))
      .slice(0, limit);

    for (const j of eligible) {
      const before = { ...j, failed_devices: [...j.failed_devices] };
      journal(() => { Object.assign(j, before); });
      j.status = "delivered";
      j.attempts += 1;
      j.claimed_by = agentId;
      j.claimed_until = new Date(leaseIso);
      j.delivered_at = now();
    }
    // RETURNING has no defined order; hand them back shuffled so a caller that
    // forgets to sort is caught rather than accidentally correct.
    return [...eligible].reverse().map((j) => ({
      id: j.id, seq: String(j.seq), bill_id: j.bill_id, kind: j.kind, station: j.station,
      esc_base64: j.esc_base64, created_at: j.created_at, attempts: j.attempts,
    }));
  }

  // --- GetPrintJobAssignment ---
  if (/^select outlet_id, assigned_device_id, assign_generation/i.test(q)) {
    requireShape(q, "assign_accepted_at",
      "the deadline arbiter re-reads the row to learn whether the assignee accepted on ANOTHER replica; without this column a timer revokes a device that is already spooling");
    const [jobId, resId] = params as [string, string];
    const j = store.jobs.find((x) => x.id === jobId && x.res_id === resId);
    if (!j) { return []; }
    return [{
      outlet_id: j.outlet_id,
      assigned_device_id: j.assigned_device_id,
      assign_generation: j.assign_generation,
      destination_id: j.destination_id,
      broadcast_at: j.broadcast_at,
      failed_devices: [...j.failed_devices],
      assign_accepted_at: j.assign_accepted_at,
      assign_expires_at: j.assign_expires_at,
    }];
  }

  // --- ReassignPrintJob (THE CAS) ---
  if (/^update "PrintJobs" set assigned_device_id = \$4::uuid/i.test(q)) {
    const [jobId, resId, expectGen, nextDevice, nextTarget, nextDest, expiresIso] =
      params as [string, string, number, string, string | null, string | null, string];
    const pred = statusPredicate(q);
    const fence = generationFence(q);
    const deadline = deadlineLeg(q);
    const lease = leaseLeg(q);
    const appended = jsonArray(params[7]);
    const nextClaimedBy = String(params[8] ?? "");
    const mins = Number(param(params, leaseIntervalIdx(q)) ?? 0);
    const t = now().getTime();

    const j = store.jobs.find((x) => x.id === jobId && x.res_id === resId);
    if (!j) { return []; }
    if (!statusAdmits(pred, j.status)) { return []; }
    if (fence !== null && j.assign_generation !== Number(expectGen)) { return []; }
    // THE DEADLINE and THE LEASE, each with its named exception. Both are read
    // out of the text; deleting either one changes what this fixture allows, and
    // that is the whole point of the pins that surround this statement.
    if (deadline) {
      const except = param<string>(params, deadline.exceptionIdx);
      const ok = j.assign_expires_at === null
        || j.assign_expires_at.getTime() <= t
        || (except !== null && j.claimed_by === except);
      if (!ok) { return []; }
    }
    if (lease) {
      const except = param<string>(params, lease.exceptionIdx);
      const ok = j.claimed_until === null
        || j.claimed_until.getTime() < t
        || (except !== null && j.claimed_by === except);
      if (!ok) { return []; }
    }

    const before = { ...j, failed_devices: [...j.failed_devices] };
    journal(() => { Object.assign(j, before); });
    j.assigned_device_id = nextDevice;
    j.assigned_target = nextTarget;
    j.destination_id = nextDest ?? j.destination_id;
    j.assign_generation += 1;
    j.assign_expires_at = new Date(expiresIso);
    j.assign_accepted_at = null;
    j.failed_devices = [...j.failed_devices, ...appended];
    j.attempts += 1;
    j.status = "delivered";
    j.claimed_by = nextClaimedBy;
    j.claimed_until = new Date(t + mins * 60_000);
    return [{ id: j.id, assign_generation: j.assign_generation }];
  }

  // --- AcceptPrintAssignment (the beat) ---
  if (/^update "PrintJobs" set assign_accepted_at = coalesce\(assign_accepted_at, now\(\)\)/i.test(q)) {
    const [jobId, resId, deviceId, generation, untilIso] =
      params as [string, string, string, number, string];
    const pred = statusPredicate(q);
    const mins = Number(param(params, leaseIntervalIdx(q)) ?? 0);
    // Derived: does the beat REFRESH the lease or REPLACE it? A plain
    // `claimed_until = $verdict` quietly shortens the 027 at-most-once guard from
    // two minutes to 75 seconds on exactly the jobs a device is actively working
    // on, which is how the reconnect door opens under a live spool.
    const refreshesLease = /claimed_until = greatest\(/i.test(q);
    const j = store.jobs.find((x) => x.id === jobId && x.res_id === resId);
    if (!j || !statusAdmits(pred, j.status)) { return []; }
    if (j.assigned_device_id !== deviceId || j.assign_generation !== Number(generation)) { return []; }
    const before = { ...j, failed_devices: [...j.failed_devices] };
    journal(() => { Object.assign(j, before); });
    const until = new Date(untilIso);
    j.assign_accepted_at = j.assign_accepted_at ?? now();
    j.assign_expires_at = until;
    j.claimed_until = refreshesLease
      ? new Date(Math.max(now().getTime() + mins * 60_000, until.getTime()))
      : until;
    return [{ id: j.id }];
  }

  // --- MarkPrintJobBroadcast (the last rung's interlock) ---
  if (/^update "PrintJobs" set assigned_device_id = null/i.test(q)) {
    const [jobId, resId, expectGen] = params as [string, string, number];
    const pred = statusPredicate(q);
    const fence = generationFence(q);
    const lease = leaseLeg(q);
    // IDEMPOTENCE lives on broadcast_at and nowhere else: the SET writes
    // status='pending' while the WHERE admits 'pending', so without this fence
    // the statement re-matches its own result and answers true forever — and two
    // replicas reaching this rung both shout the whole ESC/POS payload.
    const idempotent = /broadcast_at is null/i.test(q);
    const appended = jsonArray(params[3]);
    const t = now().getTime();

    const j = store.jobs.find((x) => x.id === jobId && x.res_id === resId);
    if (!j || !statusAdmits(pred, j.status)) { return []; }
    if (idempotent && j.broadcast_at !== null) { return []; }
    if (fence !== null && j.assign_generation !== Number(expectGen)) { return []; }
    if (lease) {
      const except = param<string>(params, lease.exceptionIdx);
      const ok = j.claimed_until === null
        || j.claimed_until.getTime() < t
        || (except !== null && j.claimed_by === except);
      if (!ok) { return []; }
    }
    const before = { ...j, failed_devices: [...j.failed_devices] };
    journal(() => { Object.assign(j, before); });
    j.assigned_device_id = null;
    j.assigned_target = null;
    j.assign_expires_at = null;
    j.assign_accepted_at = null;
    j.claimed_by = null;
    j.claimed_until = null;
    j.status = "pending";
    j.broadcast_at = now();
    j.failed_devices = [...j.failed_devices, ...appended];
    return [{ id: j.id }];
  }

  // --- AckPrintJob (the pre-042 terminal write) ---
  if (/^update "PrintJobs" set status = case when \$3 = 'printed'/i.test(q)) {
    const [jobId, resId, result] = params as [string, string, string];
    const pred = statusPredicate(q);
    const j = store.jobs.find((x) => x.id === jobId && x.res_id === resId);
    if (!j || !statusAdmits(pred, j.status)) { return []; }
    const before = { ...j, failed_devices: [...j.failed_devices] };
    journal(() => { Object.assign(j, before); });
    j.status = result === "printed" ? "acked" : "failed";
    j.settled_at = now();
    j.ack_result = result;
    j.claimed_until = null;
    return [{ id: j.id }];
  }

  // --- AckPrintJobRouted ---
  if (/^with cur as \( select id, status, assign_generation, assigned_device_id/i.test(q)) {
    // The ONE text assertion left on this statement, because "which expression
    // feeds this column" cannot be derived from a boolean: a mutation to
    // `coalesce($3::uuid, p.assigned_device_id)` would still credit the row in
    // every test that happens not to pass a device, while handing a till the
    // power to write itself into the record of who printed a money document.
    requireShape(q, "printed_by_device = case when f.do_printed and f.current_gen then p.assigned_device_id",
      "receipt history is taken from the ROW and only from the row");
    const [jobId, resId, ackDevice, ackGen, result, failedJson, maxGen] =
      params as [string, string, string | null, number | null, string, string | null, number];
    const pred = statusPredicate(q);
    const shape = routedAckShape(q);
    const j = store.jobs.find((x) => x.id === jobId && x.res_id === resId);
    if (!j) { return []; }

    const live = statusAdmits(pred, j.status);
    const wantPrinted = result === "printed";
    const alreadyFailed = result === "failed" && failedJson !== null
      && jsonArray(failedJson).every((d) => j.failed_devices.includes(d));
    // THE ATTRIBUTION FENCE, conjunct by conjunct out of the statement. An
    // unstated generation is no fence; an unstated DEVICE is trusted only where
    // the SQL says it may be — which is the state in which a directed emit can
    // only ever have reached one client.
    const unsignedAttributable = ackDevice === null
      && shape.unsignedAttribution
      && (!shape.unsignedNeedsGenZero || j.assign_generation === 0)
      && (!shape.unsignedNeedsNoFailures || j.failed_devices.length === 0);
    const currentGen = (ackGen === null || j.assign_generation === Number(ackGen))
      && j.assigned_device_id !== null
      && (ackDevice === j.assigned_device_id || unsignedAttributable);

    const doPrinted = live && wantPrinted;
    const doRecord = live && !wantPrinted && !alreadyFailed && !currentGen;
    const doRetry = live && !wantPrinted && !alreadyFailed && currentGen && j.assign_generation < Number(maxGen);
    const doFail = live && !wantPrinted && !alreadyFailed && currentGen && j.assign_generation >= Number(maxGen);

    let updated = false;
    if (doPrinted || doRecord || doRetry || doFail) {
      updated = true;
      const before = { ...j, failed_devices: [...j.failed_devices] };
      journal(() => { Object.assign(j, before); });
      if (doPrinted) { j.status = "acked"; j.ack_result = "printed"; j.settled_at = now(); }
      if (doFail) { j.status = "failed"; j.ack_result = "failed"; j.settled_at = now(); }
      if (doPrinted && currentGen) { j.printed_by_device = j.assigned_device_id; }
      if (doRetry) {
        // The row-derived fallback, applied only if the statement carries it: the
        // ack said nothing, so the server credits the failure to whoever it
        // believes was holding the row. Lose this and the exclude set comes back
        // empty and the ladder re-offers the docket to the jammed printer.
        const fallback = shape.retryFallsBackToRow && j.assigned_device_id ? [j.assigned_device_id] : [];
        const add = failedJson !== null ? jsonArray(failedJson) : fallback;
        j.failed_devices = [...j.failed_devices, ...add];
      } else if (doRecord || doFail) {
        j.failed_devices = [...j.failed_devices, ...jsonArray(failedJson)];
      }
      if (doPrinted || doFail || doRetry) { j.claimed_until = null; }
      if (doRetry) {
        j.status = "pending";
        j.assigned_device_id = null;
        j.assigned_target = null;
        j.assign_expires_at = now();
        j.assign_accepted_at = null;
      }
    }

    return [{
      live, already_failed: alreadyFailed, current_gen: currentGen,
      do_printed: doPrinted, do_record: doRecord, do_retry: doRetry, do_fail: doFail,
      upd_id: updated ? j.id : null,
      assign_generation: j.assign_generation,
      failed_devices: [...j.failed_devices],
      outlet_id: updated ? j.outlet_id : null,
      bill_id: updated ? j.bill_id : null,
      kind: updated ? j.kind : null,
      station: updated ? j.station : null,
      esc_base64: updated ? j.esc_base64 : null,
      destination_id: updated ? j.destination_id : null,
    }];
  }

  // --- ExpirePrintJobs / PurgeSettledPrintJobs (the reaper; unchanged by 042) ---
  if (/^update "PrintJobs" set status = 'expired'/i.test(q)) { return []; }
  if (/^with doomed as \( select id from "PrintJobs"/i.test(q)) { return []; }

  throw new Error(`print routing fixture: unstubbed SQL — ${q.slice(0, 300)}`);
}

// --- the fake socket.io ------------------------------------------------------
//
// REAL ROOM NAMES, BUILT HERE TOO, ON PURPOSE. realtime.ts keeps its room-name
// builders private, so a test that wants to place a socket in an outlet room has
// to spell the name. That duplication is the pin: `…:dev:<id>` is the delivery
// address a directed emit uses and `…:dest:<id>` is what presence is derived
// from, so a rename on either side shows up as a socket that is suddenly invisible
// to the router rather than as a silent behaviour change.

export const outletRoom = (resId: string, outletId: string): string =>
  `restaurant:${resId}:outlet:${outletId}`;
export const deviceRoom = (resId: string, outletId: string, deviceId: string): string =>
  `${outletRoom(resId, outletId)}:dev:${deviceId}`;
export const destinationRoom = (resId: string, outletId: string, destinationId: string): string =>
  `${outletRoom(resId, outletId)}:dest:${destinationId}`;
export const restaurantRoom = (resId: string): string => `restaurant:${resId}`;

export interface FakeSocket {
  id: string;
  data: Record<string, unknown>;
  rooms: Set<string>;
}

export interface RecordedEmit { room: string; event: string; payload: Record<string, unknown> }

const sockets = new Map<string, FakeSocket>();
let emitted: RecordedEmit[] = [];
let socketSeq = 0;

export function resetRealtime(): void {
  sockets.clear();
  emitted = [];
  socketSeq = 0;
}

export function emits(): RecordedEmit[] { return emitted; }
export function emitsOf(event: string): RecordedEmit[] { return emitted.filter((e) => e.event === event); }

/**
 * A routing-aware printing client: it carries socket.data.print AND holds its
 * dev: room, which is what printSocketInfo requires before it will call anything
 * a candidate.
 */
export function addPrintSocket(a: {
  deviceId: string;
  destinations?: string[];
  outletId?: string;
  ready?: boolean;
  platform?: string;
  agentVersion?: string;
}): FakeSocket {
  const outletId = a.outletId ?? OUTLET_ID;
  const id = `sock-${String(++socketSeq)}`;
  const rooms = new Set<string>([
    restaurantRoom(RES_ID),
    outletRoom(RES_ID, outletId),
    deviceRoom(RES_ID, outletId, a.deviceId),
  ]);
  for (const d of a.destinations ?? []) { rooms.add(destinationRoom(RES_ID, outletId, d)); }
  const s: FakeSocket = {
    id,
    data: {
      print: {
        deviceId: a.deviceId,
        outletId,
        platform: a.platform ?? "windows",
        agentVersion: a.agentVersion ?? "1.1.0",
        ready: a.ready !== false,
        joinedAt: Date.now(),
      },
    },
    rooms,
  };
  sockets.set(id, s);
  return s;
}

/**
 * The C# agent at C_Sharp_temp_printer_server, or any Flutter build that
 * predates routing: in the outlet room, printing everything it hears, carrying no
 * socket.data.print and unable to ack.
 */
export function addLegacySocket(outletId: string = OUTLET_ID): FakeSocket {
  const id = `legacy-${String(++socketSeq)}`;
  const s: FakeSocket = {
    id,
    data: {},
    rooms: new Set<string>([restaurantRoom(RES_ID), outletRoom(RES_ID, outletId)]),
  };
  sockets.set(id, s);
  return s;
}

export function dropSocket(s: FakeSocket): void { sockets.delete(s.id); }

class FakeRoomOperator {
  constructor(private readonly room: string) {}
  emit(event: string, payload: unknown): void {
    emitted.push({ room: this.room, event, payload: payload as Record<string, unknown> });
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async fetchSockets(): Promise<FakeSocket[]> {
    return [...sockets.values()].filter((s) => s.rooms.has(this.room));
  }
  socketsJoin(rooms: string | string[]): void {
    const want = Array.isArray(rooms) ? rooms : [rooms];
    for (const s of sockets.values()) {
      if (!s.rooms.has(this.room)) { continue; }
      for (const r of want) { s.rooms.add(r); }
    }
  }
  socketsLeave(rooms: string | string[]): void {
    const drop = Array.isArray(rooms) ? rooms : [rooms];
    for (const s of sockets.values()) {
      if (!s.rooms.has(this.room)) { continue; }
      for (const r of drop) { s.rooms.delete(r); }
    }
  }
}

class FakeIoServer {
  on(): this { return this; }
  use(): this { return this; }
  adapter(): this { return this; }
  to(room: string): FakeRoomOperator { return new FakeRoomOperator(room); }
  in(room: string): FakeRoomOperator { return new FakeRoomOperator(room); }
  close(cb?: () => void): void { cb?.(); }
}

(globalThis as unknown as FixtureGlobal).__printRoutingFixtureIo = () => new FakeIoServer();
