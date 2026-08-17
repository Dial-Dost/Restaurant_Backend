// In-memory store + a fake `pg` Pool, so the REAL scheduled-report sweep
// (report_schedules.ts driving the data functions in database_supabase.ts) can be
// exercised as a unit test — including two workers racing the same occurrence.
//
// WHY A FIXTURE RATHER THAN PURE FUNCTIONS: the at-most-once guarantee is not in
// any function, it is in the SQL — a partial unique index and two compare-and-swap
// UPDATEs. A test that re-implemented the claim logic in TypeScript would assert
// only that the copy agrees with itself, which is exactly the hole the reviewed
// design fell through. Driving the shipped code path over a stubbed Pool tests the
// real predicates, and needs no database, so the suite can never be "skipped
// because a database wasn't reachable".
//
// WHAT THIS MODELS FAITHFULLY, because the guarantee depends on it:
//   * report_deliveries_occurrence_uniq — the PARTIAL unique index on
//     (schedule_id, occurrence_key) WHERE occurrence_key IS NOT NULL, and
//     ON CONFLICT ... DO NOTHING returning zero rows on collision.
//   * Conditional UPDATE matching: `attempts = $3`, `status <> 'delivered'` and
//     `next_attempt_at <= now()` all decide whether a row is returned.
//   * ROLLBACK undoing writes, so a throwing transaction really does discard its
//     notification.
//   * resolveRestaurantContext's TWO BRANCHES, separately. The outlet-bound branch
//     (database_supabase.ts:1566-1615) resolves only a REAL outlet of this
//     restaurant and selects r.timezone; the default branch (:1617-1644) selects
//     no timezone at all and returns the OLDEST outlet. Modelling them as one
//     branch is what previously let the whole suite stay green while the sweep ran
//     every report on the wrong outlet in the wrong zone.
//
// WHAT IT DOES NOT MODEL, stated because an inaccurate promise is worse than
// none: isolation. Writes are visible to other connections immediately, as if
// every transaction ran READ UNCOMMITTED. That is strictly HARSHER than Postgres
// for these tests — it lets a losing worker see the winner's row mid-flight,
// which is the interleaving we want to survive — but it means this fixture cannot
// be used to reason about lost updates that real MVCC would prevent.
//
// Dispatch matches on a marker in the SQL and THROWS on anything unrecognised, so
// a code path that starts issuing a new query fails loudly here rather than
// silently receiving zero rows.

export const RES_ID = "33333333-3333-4333-8333-333333333333";
/** The outlet every schedule below belongs to. Deliberately NOT the tenant's
 *  oldest outlet, so binding the wrong one is observable. */
export const OUTLET_ID = "44444444-4444-4444-8444-444444444444";
/** The tenant's OLDEST outlet — what resolveRestaurantContext's default branch
 *  returns (`order by o.created_at asc nulls last limit 1`,
 *  database_supabase.ts:1639) when no real outlet is bound. A report that comes
 *  back scoped to this one was scoped by accident. */
export const FIRST_OUTLET_ID = "55555555-5555-4555-8555-555555555555";

export interface ScheduleRow {
  id: string;
  res_id: string;
  outlet_id: string;
  name: string;
  report_key: string;
  frequency: string;
  hour_local: number;
  minute_local: number;
  weekday: number | null;
  day_of_month: number | null;
  channel: string;
  format: string;
  enabled: boolean;
  archived_at: Date | null;
  last_occurrence_key: string | null;
  last_status: string | null;
  last_error: string | null;
  consecutive_failures: number;
  created_at: Date;
}

export interface DeliveryRow {
  id: string;
  res_id: string;
  outlet_id: string;
  schedule_id: string;
  occurrence_key: string | null;
  fire_at: Date;
  period_from: string;
  period_to: string;
  timezone: string;
  status: string;
  attempts: number;
  next_attempt_at: Date;
  claimed_by: string | null;
  channel: string | null;
  artifact_name: string | null;
  artifact_mime: string | null;
  artifact_body: string | null;
  artifact_bytes: number | null;
  artifact_truncated: boolean;
  error: string | null;
  delivered_at: Date | null;
  created_at: Date;
}

export interface NotificationRow {
  type: string;
  title: string;
  body: string | null;
  meta: Record<string, unknown>;
}

/** One "Bills" read as the report path issued it: the outlet it was scoped to and
 *  the zone-midnight bounds normalizeReportRange built from the resolved zone. */
export interface BillsRead {
  outlet_id: string;
  from: string;
  to: string;
}

interface Store {
  timezone: string;
  account_status: string;
  /** false models a "Restaurant" read that returns ZERO ROWS — what a pooled
   *  client carrying another tenant's app.res_id GUC does to the fail-open RLS
   *  policy (migrations/003_enable_rls.sql:53-61). */
  restaurantRowReadable: boolean;
  schedules: ScheduleRow[];
  deliveries: DeliveryRow[];
  notifications: NotificationRow[];
  billsReads: BillsRead[];
  /** Holds the next "Bills" read open, so a render can be suspended while another
   *  worker takes over the same occurrence. One-shot. */
  billsGate: { gate: Promise<void>; markReached: () => void } | null;
  /** Every "Bills" read throws — the render half of a failing delivery. */
  billsFail: boolean;
  /** The schedule-card mirror throws, but ONLY for a 'delivered' outcome: the
   *  post-delivery bookkeeping write, after TX4 has already committed. */
  deliveredOutcomeFails: boolean;
  nextId: number;
}

let store: Store = freshStore();

function freshStore(): Store {
  return {
    timezone: "Asia/Kolkata",
    account_status: "active",
    restaurantRowReadable: true,
    schedules: [],
    deliveries: [],
    notifications: [],
    billsReads: [],
    billsGate: null,
    billsFail: false,
    deliveredOutcomeFails: false,
    nextId: 1,
  };
}

export function resetStore(
  over: Partial<Pick<Store, "timezone" | "account_status" | "restaurantRowReadable">> = {},
): void {
  store = { ...freshStore(), ...over };
}

export function addSchedule(over: Partial<ScheduleRow> = {}): ScheduleRow {
  const row: ScheduleRow = {
    id: `sched-${String(store.nextId++)}`,
    res_id: RES_ID,
    outlet_id: OUTLET_ID,
    name: "Daily sales",
    report_key: "sales",
    frequency: "daily",
    hour_local: 8,
    minute_local: 0,
    weekday: null,
    day_of_month: null,
    channel: "inbox",
    format: "csv",
    enabled: true,
    archived_at: null,
    last_occurrence_key: null,
    last_status: null,
    last_error: null,
    consecutive_failures: 0,
    created_at: new Date("2020-01-01T00:00:00Z"),
    ...over,
  };
  store.schedules.push(row);
  return row;
}

/** Seed a delivery row directly — for the failure paths, which start from a row
 *  that already carries attempts (the reaper, attempt exhaustion, auto-disable). */
export function addDelivery(over: Partial<DeliveryRow> & { schedule_id: string }): DeliveryRow {
  const row: DeliveryRow = {
    id: `del-${String(store.nextId++)}`,
    res_id: RES_ID,
    outlet_id: OUTLET_ID,
    occurrence_key: "2026-08-11",
    fire_at: new Date("2026-08-11T02:30:00Z"),
    period_from: "2026-08-10",
    period_to: "2026-08-10",
    timezone: "Asia/Kolkata",
    status: "claimed",
    attempts: 0,
    next_attempt_at: new Date("2026-08-11T02:30:00Z"),
    claimed_by: "seed",
    channel: "inbox",
    artifact_name: null,
    artifact_mime: null,
    artifact_body: null,
    artifact_bytes: null,
    artifact_truncated: false,
    error: null,
    delivered_at: null,
    created_at: new Date("2026-08-11T02:30:00Z"),
    ...over,
  };
  store.deliveries.push(row);
  return row;
}

export function deliveries(): DeliveryRow[] { return store.deliveries; }
export function notifications(): NotificationRow[] { return store.notifications; }
export function schedules(): ScheduleRow[] { return store.schedules; }
export function billsReads(): BillsRead[] { return store.billsReads; }

/** Make every render fail, so recordFailure, the backoff and attempt exhaustion
 *  can be driven through the real code path rather than called directly. */
export function breakBillsRead(): void { store.billsFail = true; }

/** Make the schedule-card mirror throw for a 'delivered' outcome only — i.e. fail
 *  the bookkeeping that runs AFTER TX4 has committed and the report has really
 *  been delivered. Nothing else on the path is disturbed. */
export function breakDeliveredOutcomeWrite(): void { store.deliveredOutcomeFails = true; }

/**
 * Suspend the next "Bills" read — i.e. hold one worker inside TX3, mid-render.
 *
 * `reached` resolves once that worker is actually blocked, so a test can assert
 * on the row it has already written without racing it; `release()` lets it
 * finish. Awaiting a bare microtask instead is not deterministic — there are a
 * dozen awaits between the sweep starting and the render beginning.
 */
export function gateBillsRead(): { reached: Promise<void>; release: () => void } {
  let release: () => void = () => { /* replaced below */ };
  let markReached: () => void = () => { /* replaced below */ };
  const gate = new Promise<void>((resolve) => { release = () => { resolve(); }; });
  const reached = new Promise<void>((resolve) => { markReached = () => { resolve(); }; });
  store.billsGate = { gate, markReached };
  return { reached, release };
}

const now = (): Date => new Date();

/**
 * Dispatch below re-implements each guard's PREDICATE, which means deleting the
 * predicate from the SQL would leave these tests green — the fixture would keep
 * enforcing a rule the database no longer had. So every guard statement also has
 * its text checked here. Losing `attempts = $3`, or the partial index's
 * `where occurrence_key is not null` on the ON CONFLICT clause, now fails loudly
 * rather than silently.
 */
function requireShape(q: string, fragment: string, why: string): void {
  if (!q.toLowerCase().includes(fragment.toLowerCase())) {
    throw new Error(`report fixture: query lost "${fragment}" — ${why}\n  ${q.slice(0, 220)}`);
  }
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
    return { rows: await dispatch(q, params, (u) => { if (this.inTxn) { this.undo.push(u); } }) };
  }

  release(): void { /* pooled clients are reusable here */ }
}

// Wired onto globalThis because a jest.mock factory is hoisted above imports and
// may not close over module scope. The factory in the test file only has to hand
// out these connections.
export interface FixtureConnection {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  release: () => void;
}
interface FixtureGlobal {
  __reportFixtureConnect?: () => FixtureConnection;
}
(globalThis as unknown as FixtureGlobal).__reportFixtureConnect = () => new FakeClient();

// DDL and session statements the lazy-table helpers fire; no-ops, because the
// fixture defines the schema.
const DDL = /^(alter|create|drop|do|grant|revoke|comment|set|truncate)\b/i;

async function dispatch(q: string, params: unknown[], journal: (u: Undo) => void): Promise<unknown[]> {
  if (DDL.test(q)) { return []; }
  if (/^select set_config\('app\.res_id'/i.test(q)) { return []; }

  // --- "Restaurant" reads ---
  if (/^select id from "Restaurant"$/i.test(q)) { return [{ id: RES_ID }]; }
  if (/platform\.restaurant_status/i.test(q)) { return [{ status: store.account_status }]; }
  if (/select timezone from "Restaurant"/i.test(q)) {
    return store.restaurantRowReadable ? [{ timezone: store.timezone }] : [];
  }
  if (/select service_charge from "Restaurant"/i.test(q)) { return [{ service_charge: 0 }]; }

  // resolveRestaurantContext, ONE BRANCH AT A TIME. Which one issued the query is
  // readable from the SQL: only the outlet-bound branch carries the outlet
  // predicate (database_supabase.ts:1592).
  if (/from "Restaurant" r/i.test(q)) {
    const identity = {
      res_id: RES_ID,
      restaurant_slug: "zztest-reports",
      restaurant_name: "ZZTEST Reports",
      restaurant_main_office_add: null,
      restaurant_logo_url: null,
    };
    if (/o\.id::text = \$4/i.test(q)) {
      // Outlet-bound branch. `and (o.id::text = $4 or ...)` matches a REAL outlet
      // of this restaurant or nothing — an empty or unknown bind resolves no row
      // and the caller falls through to the default branch below, exactly as it
      // does in production. This branch is also the only one that selects
      // r.timezone (:1585).
      const bound = typeof params[3] === "string" ? params[3] : "";
      if (bound !== OUTLET_ID && bound !== FIRST_OUTLET_ID) { return []; }
      return [{ ...identity, outlet_id: bound, timezone: store.timezone }];
    }
    // Default branch: the OLDEST outlet, and NO timezone column in the select
    // list at all — so sanitizeTimezone sees undefined and hands back its
    // Asia/Kolkata default. Both halves of that are the regression this models.
    return [{ ...identity, outlet_id: FIRST_OUTLET_ID }];
  }

  // --- the report path (an empty but valid revenue basis) ---
  if (/from "Bills"/i.test(q)) {
    // Recorded, because the outlet and the window this read carries ARE the
    // resolved context: a report scoped to the wrong outlet or bucketed in the
    // wrong zone is invisible in the delivery row and visible only here.
    store.billsReads.push({
      outlet_id: String(params[1] ?? ""),
      from: String(params[2] ?? ""),
      to: String(params[3] ?? ""),
    });
    if (store.billsGate) {
      const g = store.billsGate;
      store.billsGate = null;   // one-shot: only the first render is suspended
      g.markReached();
      await g.gate;
    }
    if (store.billsFail) { throw new Error("bills read failed"); }
    return [];
  }
  if (/from "Expenses"/i.test(q)) { return []; }

  if (/insert into "Notifications"/i.test(q)) {
    const [, , type, title, body, meta] = params as [string, string, string, string, string | null, string];
    const row: NotificationRow = {
      type, title, body,
      meta: JSON.parse(meta) as Record<string, unknown>,
    };
    store.notifications.push(row);
    journal(() => { store.notifications = store.notifications.filter((n) => n !== row); });
    return [];
  }

  // --- "ReportSchedules" ---
  if (/from "ReportSchedules" where res_id = \$1 and enabled = true/i.test(q)) {
    return store.schedules
      .filter((s) => s.res_id === params[0] && s.enabled && s.archived_at === null)
      .map((s) => ({ ...s }));
  }
  if (/^update "ReportSchedules" set last_occurrence_key/i.test(q)) {
    requireShape(q, "enabled and consecutive_failures + 1 <",
      "on failure this expression may only turn a schedule OFF; recomputing `enabled` from the failure count alone re-enables one the owner explicitly paused");
    const [resId, scheduleId, occKey, status, error, ok, limit] = params as
      [string, string, string | null, string, string | null, boolean, number];
    if (store.deliveredOutcomeFails && status === "delivered") {
      throw new Error("schedule outcome write failed");
    }
    const s = store.schedules.find((x) => x.id === scheduleId && x.res_id === resId);
    if (!s) { return []; }
    const before = { ...s };
    journal(() => { Object.assign(s, before); });
    s.last_occurrence_key = occKey;
    s.last_status = status;
    s.last_error = error;
    s.consecutive_failures = ok ? 0 : s.consecutive_failures + 1;
    // `before.enabled &&` mirrors the SQL's own guard: a failure may only ever
    // turn a schedule off, never back on.
    if (!ok) { s.enabled = before.enabled && before.consecutive_failures + 1 < limit; }
    return [{ consecutive_failures: s.consecutive_failures, enabled: s.enabled }];
  }

  // --- "ReportDeliveries" ---
  if (/^insert into "ReportDeliveries"/i.test(q)) {
    requireShape(q, "on conflict (schedule_id, occurrence_key) where occurrence_key is not null",
      "Postgres cannot infer a PARTIAL index unless the ON CONFLICT clause repeats its predicate; omitting it raises 42P10 on every insert");
    const [resId, outletId, scheduleId, occKey, fireAt, from, to, tz, claimedBy, status, channel, nextAt] =
      params as [string, string, string, string | null, string, string, string, string, string, string, string, string];
    // The PARTIAL unique index: rows with a null occurrence_key never collide.
    if (occKey !== null && store.deliveries.some((d) => d.schedule_id === scheduleId && d.occurrence_key === occKey)) {
      return [];
    }
    const row: DeliveryRow = {
      id: `del-${String(store.nextId++)}`,
      res_id: resId, outlet_id: outletId, schedule_id: scheduleId, occurrence_key: occKey,
      fire_at: new Date(fireAt), period_from: from, period_to: to, timezone: tz,
      status, attempts: 0, next_attempt_at: new Date(nextAt), claimed_by: claimedBy,
      channel, artifact_name: null, artifact_mime: null, artifact_body: null,
      artifact_bytes: null, artifact_truncated: false, error: null, delivered_at: null,
      created_at: now(),
    };
    store.deliveries.push(row);
    journal(() => { store.deliveries = store.deliveries.filter((d) => d !== row); });
    return [{ id: row.id }];
  }

  if (/^update "ReportDeliveries" set attempts = attempts \+ 1/i.test(q)) {
    requireShape(q, "attempts = $3", "the attempt compare-and-swap is the only thing stopping two replicas taking the same attempt");
    const [id, resId, expected, nextAt, worker] = params as [string, string, number, string, string];
    const d = store.deliveries.find((x) => x.id === id && x.res_id === resId);
    // THE COMPARE-AND-SWAP. `attempts = $3` is the whole cross-replica guard.
    if (!d || d.attempts !== expected || !["claimed", "rendered", "failed"].includes(d.status)) { return []; }
    const before = { ...d };
    journal(() => { Object.assign(d, before); });
    d.attempts += 1;
    d.next_attempt_at = new Date(nextAt);
    d.claimed_by = worker;
    if (d.status === "failed") { d.status = "claimed"; }
    return [{ attempts: d.attempts }];
  }

  if (/^update "ReportDeliveries" set status = 'rendered'/i.test(q)) {
    requireShape(q, "attempts = $3", "a superseded worker must not overwrite the winner's artifact");
    const [id, resId, attempts, name, mime, body, bytes, truncated] =
      params as [string, string, number, string, string, string, number, boolean];
    const d = store.deliveries.find((x) => x.id === id && x.res_id === resId);
    if (!d || d.attempts !== attempts || d.status === "delivered") { return []; }
    const before = { ...d };
    journal(() => { Object.assign(d, before); });
    d.status = "rendered"; d.artifact_name = name; d.artifact_mime = mime;
    d.artifact_body = body; d.artifact_bytes = bytes; d.artifact_truncated = truncated;
    d.error = null;
    return [];
  }

  if (/^update "ReportDeliveries" set status = 'delivered'/i.test(q)) {
    requireShape(q, "attempts = $3", "the terminal write is a compare-and-swap; without it a superseded worker delivers a second time");
    requireShape(q, "returning id", "the caller must be able to detect zero rows and throw");
    const [id, resId, attempts] = params as [string, string, number];
    const d = store.deliveries.find((x) => x.id === id && x.res_id === resId);
    // The terminal CAS. Zero rows here is what makes a superseded worker throw.
    if (!d || d.attempts !== attempts || d.status === "delivered") { return []; }
    const before = { ...d };
    journal(() => { Object.assign(d, before); });
    d.status = "delivered"; d.delivered_at = now(); d.error = null;
    return [{ id: d.id }];
  }

  if (/^update "ReportDeliveries" set status = 'failed', error = \$5/i.test(q)) {
    requireShape(q, "attempts = $3", "a superseded worker's error must not land on a row another worker delivered");
    const [id, resId, attempts, nextAt, error] = params as [string, string, number, string, string];
    const d = store.deliveries.find((x) => x.id === id && x.res_id === resId);
    if (!d || d.attempts !== attempts || d.status === "delivered") { return []; }
    const before = { ...d };
    journal(() => { Object.assign(d, before); });
    d.status = "failed"; d.error = error; d.next_attempt_at = new Date(nextAt);
    return [];
  }

  if (/^update "ReportDeliveries" set status = 'failed', error = coalesce/i.test(q)) {
    const [resId, maxAttempts] = params as [string, number];
    const hit = store.deliveries.filter((d) =>
      d.res_id === resId && d.attempts >= maxAttempts &&
      d.next_attempt_at.getTime() <= now().getTime() &&
      ["claimed", "rendered"].includes(d.status));
    for (const d of hit) {
      const before = { ...d };
      journal(() => { Object.assign(d, before); });
      d.status = "failed"; d.error = d.error ?? "Retries exhausted";
    }
    return hit.map((d) => ({ id: d.id }));
  }

  if (/from "ReportDeliveries" d join "ReportSchedules" s/i.test(q)) {
    const [resId, maxAttempts] = params as [string, number];
    return store.deliveries
      .filter((d) =>
        d.res_id === resId &&
        ["claimed", "rendered", "failed"].includes(d.status) &&
        d.attempts < maxAttempts &&
        d.next_attempt_at.getTime() <= now().getTime())
      .map((d) => {
        const s = store.schedules.find((x) => x.id === d.schedule_id);
        if (!s) { return null; }
        return {
          id: d.id, schedule_id: d.schedule_id, outlet_id: d.outlet_id,
          occurrence_key: d.occurrence_key, period_from: d.period_from,
          period_to: d.period_to, timezone: d.timezone, attempts: d.attempts,
          channel: d.channel, name: s.name, report_key: s.report_key, format: s.format,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }

  throw new Error(`report fixture: unstubbed SQL — ${q.slice(0, 220)}`);
}
