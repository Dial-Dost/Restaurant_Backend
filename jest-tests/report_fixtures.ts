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
//
// SINCE ITEM 9 (report email, migrations 056-058) it also models the address
// book, the per-address outcome columns, the attachment store and the sweep's
// single-row lease — each guard statement's predicate re-implemented AND its
// text checked, for the reason `requireShape` gives. `schema` says whether the
// runtime's probe finds 056-058; the default is present, which is the path
// production takes once they are applied.

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
  /** Migration 044. */
  recipients: string[];
  /** Migration 057. */
  report_keys: string[];
  formats: string[];
  window_mode: string;
  outlet_scope: string;
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
  schedule_id: string | null;
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
  /** Migration 044 / 058. */
  delivered_to: string[] | null;
  kind: string;
  report_keys: string[];
  formats: string[];
  outlet_scope: string;
  day_close: string | null;
  window_start_at: string | null;
  window_end_at: string | null;
  recipients: string[] | null;
  rejected_to: string[] | null;
  skipped_to: string[] | null;
  provider: string | null;
  requested_by: string | null;
  sending_at: Date | null;
  maybe_duplicate: boolean;
}

export interface RecipientRow {
  id: string;
  res_id: string;
  email: string;
  status: "active" | "suppressed";
  removed_at: Date | null;
}

export interface FileRow {
  id: string;
  res_id: string;
  delivery_id: string;
  report_key: string;
  format: string;
  filename: string;
  mime: string;
  bytes: number;
  rows: number;
  truncated: boolean;
  body: Buffer | null;
  created_at: Date;
}

export interface LeaseRow {
  holder: string | null;
  until: Date;
  heartbeat_at: Date | null;
  mail_ready: boolean;
  sent_day: string | null;
  sent_count: number;
  purged_day: string | null;
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
  /** What the runtime's probe finds for migrations 056, 057 and 058. */
  schema: { m056: boolean; m057: boolean; m058: boolean };
  recipients: RecipientRow[];
  files: FileRow[];
  lease: LeaseRow;
  /** Statements issued, in order, for the ordering assertions (the send path). */
  journalSql: string[];
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
    schema: { m056: true, m057: true, m058: true },
    recipients: [],
    files: [],
    lease: { holder: null, until: new Date(0), heartbeat_at: null, mail_ready: false, sent_day: null, sent_count: 0, purged_day: null },
    journalSql: [],
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
  over: Partial<Pick<Store, "timezone" | "account_status" | "restaurantRowReadable" | "schema">> = {},
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
    recipients: [],
    report_keys: [],
    formats: ["csv"],
    window_mode: "calendar",
    outlet_scope: "outlet",
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
export function addDelivery(over: Partial<DeliveryRow> & { schedule_id: string | null }): DeliveryRow {
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
    delivered_to: null,
    kind: "scheduled",
    report_keys: [],
    formats: ["csv"],
    outlet_scope: "outlet",
    day_close: null,
    window_start_at: null,
    window_end_at: null,
    recipients: null,
    rejected_to: null,
    skipped_to: null,
    provider: null,
    requested_by: null,
    sending_at: null,
    maybe_duplicate: false,
    ...over,
  };
  store.deliveries.push(row);
  return row;
}

/** An address in the restaurant's book (migration 056). */
export function addRecipient(email: string, over: Partial<RecipientRow> = {}): RecipientRow {
  const row: RecipientRow = {
    id: `rcp-${String(store.nextId++)}`,
    res_id: RES_ID,
    email,
    status: "active",
    removed_at: null,
    ...over,
  };
  store.recipients.push(row);
  return row;
}

export function recipients(): RecipientRow[] { return store.recipients; }
export function files(): FileRow[] { return store.files; }
export function lease(): LeaseRow { return store.lease; }
export function sqlJournal(): string[] { return store.journalSql; }
export function setLease(over: Partial<LeaseRow>): void { store.lease = { ...store.lease, ...over }; }

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
  if (!/^(begin|commit|rollback)$/i.test(q)) {store.journalSql.push(q.slice(0, 80));}
  if (DDL.test(q)) { return []; }
  if (/^select set_config\('app\.res_id'/i.test(q)) { return []; }
  if (/^select set_config\('statement_timeout'/i.test(q)) { return []; }

  // --- item 9: the runtime's schema probe (report_email_schema.ts) ---
  if (/to_regclass\('"ReportEmailRecipients"'\) is not null as m056/i.test(q)) {
    return [{ ...store.schema }];
  }

  // --- "ReportSweepLease" ---
  if (/^update "ReportSweepLease" set holder = \$1/i.test(q)) {
    requireShape(q, "where id = 1 and (until < now() or holder = $1)",
      "the lease may be taken only when it has lapsed or is already ours; without it two processes sweep at once");
    const [holder, , minutes, mailReady] = params as [string, string, number, boolean];
    const l = store.lease;
    if (!(l.until.getTime() < now().getTime() || l.holder === holder)) { return []; }
    const before = { ...l };
    journal(() => { store.lease = before; });
    store.lease = { ...l, holder, until: new Date(now().getTime() + minutes * 60_000), heartbeat_at: now(), mail_ready: mailReady };
    return [{ holder }];
  }
  if (/^update "ReportSweepLease" set purged_day = current_date/i.test(q)) {
    const today = now().toISOString().slice(0, 10);
    if (store.lease.purged_day === today) { return []; }
    store.lease.purged_day = today;
    return [{ id: 1 }];
  }
  if (/^update "ReportSweepLease" set sent_count/i.test(q)) {
    const today = now().toISOString().slice(0, 10);
    const n = Number(params[0]);
    store.lease.sent_count = store.lease.sent_day === today ? store.lease.sent_count + n : n;
    store.lease.sent_day = today;
    return [{ n: store.lease.sent_count }];
  }
  if (/from "ReportSweepLease" where id = 1$/i.test(q) && /sent_count else 0 end as n/i.test(q) && !/holder/i.test(q)) {
    const today = now().toISOString().slice(0, 10);
    return [{ n: store.lease.sent_day === today ? store.lease.sent_count : 0 }];
  }
  if (/^select holder, heartbeat_at, until, mail_ready/i.test(q)) {
    const today = now().toISOString().slice(0, 10);
    const l = store.lease;
    return [{ holder: l.holder, heartbeat_at: l.heartbeat_at, until: l.until, mail_ready: l.mail_ready, sent: l.sent_day === today ? l.sent_count : 0 }];
  }

  // --- "ReportEmailRecipients" (the send-time check) ---
  if (/^select email_norm, status from "ReportEmailRecipients"/i.test(q)) {
    requireShape(q, "removed_at is null", "a removed address must stop the next send");
    return store.recipients
      .filter((r) => r.res_id === params[0] && r.removed_at === null)
      .map((r) => ({ email_norm: r.email.trim().toLowerCase(), status: r.status }));
  }

  // --- the restaurant as an email names it ---
  if (/^select r\.res_name, r\.currency, r\.timezone, o\.outlet_name/i.test(q)) {
    return [{ res_name: "ZZTEST Reports", currency: "INR", timezone: store.timezone, outlet_name: params[1] === OUTLET_ID ? "Main Street" : null }];
  }

  // --- the 24-hour count behind the per-restaurant cap ---
  if (/^select coalesce\(sum\(coalesce\(cardinality\(delivered_to\)/i.test(q)) {
    const since = now().getTime() - 24 * 3600_000;
    const n = store.deliveries
      .filter((d) => d.res_id === params[0] && d.channel === "email" && d.created_at.getTime() > since)
      .reduce((acc, d) => acc + (d.delivered_to?.length ?? 0), 0);
    return [{ n }];
  }

  // --- "Notifications": the once-a-day bell ---
  if (/from "Notifications" where res_id = \$1 and type = 'report' and meta->>'kind' = \$2/i.test(q)) {
    const [, kind, day] = params as [string, string, string];
    return store.notifications.filter((n) => n.meta.kind === kind && n.meta.day === day).map(() => ({ id: "n" }));
  }

  // --- "ReportDeliveryFiles" ---
  if (/^update "ReportDeliveries" set status = case when status = 'sending' then 'sending' else 'rendered' end, error = null/i.test(q)) {
    requireShape(q, "attempts = $3", "a superseded worker's files must never replace the winner's");
    const [id, resId, attempts] = params as [string, string, number];
    const d = store.deliveries.find((x) => x.id === id && x.res_id === resId);
    if (!d || d.attempts !== attempts || !["claimed", "rendered", "sending", "failed"].includes(d.status)) { return []; }
    const before = { ...d };
    journal(() => { Object.assign(d, before); });
    d.status = d.status === "sending" ? "sending" : "rendered"; d.error = null;
    return [{ id: d.id }];
  }
  if (/^delete from "ReportDeliveryFiles" where res_id = \$1 and delivery_id = \$2/i.test(q)) {
    const [resId, deliveryId] = params as [string, string];
    const kept = store.files;
    journal(() => { store.files = kept; });
    store.files = store.files.filter((f) => !(f.res_id === resId && f.delivery_id === deliveryId));
    return [];
  }
  if (/^insert into "ReportDeliveryFiles"/i.test(q)) {
    const [resId, deliveryId, key, format, filename, mime, bytes, rows, truncated, body] =
      params as [string, string, string, string, string, string, number, number, boolean, Buffer];
    const row: FileRow = {
      id: `file-${String(store.nextId++)}`, res_id: resId, delivery_id: deliveryId, report_key: key, format,
      filename, mime, bytes, rows, truncated, body, created_at: now(),
    };
    store.files.push(row);
    journal(() => { store.files = store.files.filter((f) => f !== row); });
    return [];
  }
  if (/from "ReportDeliveryFiles" where res_id = \$1 and delivery_id = \$2 and body is not null/i.test(q)) {
    return store.files
      .filter((f) => f.res_id === params[0] && f.delivery_id === params[1] && f.body !== null)
      .map((f) => ({ report_key: f.report_key, format: f.format, filename: f.filename, mime: f.mime, rows: f.rows, truncated: f.truncated, body: f.body }));
  }
  if (/^update "ReportDeliveryFiles" set body = null/i.test(q)) {
    const [resId, days] = params as [string, number];
    const cut = now().getTime() - days * 86_400_000;
    const hit = store.files.filter((f) => f.res_id === resId && f.body !== null && f.created_at.getTime() < cut);
    for (const f of hit) { f.body = null; }
    return hit.map((f) => ({ id: f.id }));
  }

  // --- the send path (058) ---
  if (/^update "ReportDeliveries" set status = 'sending'/i.test(q)) {
    requireShape(q, "attempts = $3", "'sending' is committed under the same CAS as every other write");
    const [id, resId, attempts, provider] = params as [string, string, number, string];
    const d = store.deliveries.find((x) => x.id === id && x.res_id === resId);
    if (!d || d.attempts !== attempts || !["claimed", "rendered", "sending", "failed"].includes(d.status)) { return []; }
    const before = { ...d };
    journal(() => { Object.assign(d, before); });
    d.status = "sending"; d.sending_at = d.sending_at ?? now(); d.provider = provider; d.channel = "email";
    return [{ delivered_to: d.delivered_to, rejected_to: d.rejected_to, skipped_to: d.skipped_to }];
  }
  {
    const m = /^update "ReportDeliveries" set (delivered_to|rejected_to|skipped_to) = case/i.exec(q);
    if (m) {
      requireShape(q, "status = 'sending'", "an outcome is recorded only while the row is mid-send");
      requireShape(q, "attempts = $3", "a superseded worker must not record outcomes on the winner's row");
      const column = m[1] as "delivered_to" | "rejected_to" | "skipped_to";
      const [id, resId, attempts, email] = params as [string, string, number, string];
      const d = store.deliveries.find((x) => x.id === id && x.res_id === resId);
      if (!d || d.attempts !== attempts || d.status !== "sending") { return []; }
      const before = { ...d, [column]: d[column] ? [...(d[column] as string[])] : null };
      journal(() => { Object.assign(d, before); });
      const list = d[column] ?? [];
      if (!list.includes(email)) { d[column] = [...list, email]; }
      return [{ id: d.id }];
    }
  }
  if (/from "ReportDeliveries" where res_id = \$1 and kind = 'adhoc' and status in/i.test(q)) {
    const [resId, maxAttempts, minutes] = params as [string, number, number];
    const since = now().getTime() - minutes * 60_000;
    return store.deliveries
      .filter((d) => d.res_id === resId && d.kind === "adhoc" && ["claimed", "rendered", "sending", "failed"].includes(d.status)
        && d.attempts < maxAttempts && d.next_attempt_at.getTime() <= now().getTime() && d.created_at.getTime() > since)
      .map((d) => ({ id: d.id, outlet_id: d.outlet_id }));
  }

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
  if (/^insert into "ReportDeliveries"/i.test(q) && /on conflict \(res_id, occurrence_key\)/i.test(q)) {
    requireShape(q, "on conflict (res_id, occurrence_key) where schedule_id is null",
      "report_deliveries_adhoc_uniq is PARTIAL; the ON CONFLICT must repeat its predicate or Postgres raises 42P10");
    const [resId, outletId, occKey, from, to, tz, keys, formats, scope, dayClose, start, end, recips, by] =
      params as [string, string, string, string, string, string, string[], string[], string, string | null, string, string, string[], string | null];
    if (store.deliveries.some((d) => d.res_id === resId && d.schedule_id === null && d.occurrence_key === occKey)) { return []; }
    const row = addDelivery({
      schedule_id: null, res_id: resId, outlet_id: outletId, occurrence_key: occKey, fire_at: now(),
      period_from: from, period_to: to, timezone: tz, claimed_by: "send-now", status: "claimed", channel: "email",
      next_attempt_at: now(), created_at: now(), kind: "adhoc", report_keys: keys, formats, outlet_scope: scope,
      day_close: dayClose, window_start_at: start, window_end_at: end, recipients: recips, requested_by: by,
    });
    journal(() => { store.deliveries = store.deliveries.filter((d) => d !== row); });
    return [{ id: row.id }];
  }
  if (/^insert into "ReportDeliveries"/i.test(q)) {
    requireShape(q, "on conflict (schedule_id, occurrence_key) where occurrence_key is not null",
      "Postgres cannot infer a PARTIAL index unless the ON CONFLICT clause repeats its predicate; omitting it raises 42P10 on every insert");
    const [resId, outletId, scheduleId, occKey, fireAt, from, to, tz, claimedBy, status, channel, nextAt, kind, keys, formats, scope, dayClose, start, end, by] =
      params as [string, string, string, string | null, string, string, string, string, string, string, string, string,
        string | undefined, string[] | undefined, string[] | undefined, string | undefined, string | null | undefined, string | undefined, string | undefined, string | null | undefined];
    const bundle = /\bkind\b/i.test(q);
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
      delivered_to: null,
      kind: bundle ? String(kind) : "scheduled",
      report_keys: bundle ? [...(keys ?? [])] : [],
      formats: bundle ? [...(formats ?? ["csv"])] : ["csv"],
      outlet_scope: bundle ? String(scope) : "outlet",
      day_close: bundle ? (dayClose ?? null) : null,
      window_start_at: bundle ? (start ?? null) : null,
      window_end_at: bundle ? (end ?? null) : null,
      recipients: null, rejected_to: null, skipped_to: null, provider: null,
      requested_by: bundle ? (by ?? null) : null,
      sending_at: null, maybe_duplicate: false,
    };
    store.deliveries.push(row);
    journal(() => { store.deliveries = store.deliveries.filter((d) => d !== row); });
    return [{ id: row.id }];
  }

  if (/^update "ReportDeliveries" set attempts = attempts \+ 1/i.test(q)) {
    requireShape(q, "attempts = $3", "the attempt compare-and-swap is the only thing stopping two replicas taking the same attempt");
    const [id, resId, expected, nextAt, worker] = params as [string, string, number, string, string];
    const d = store.deliveries.find((x) => x.id === id && x.res_id === resId);
    // 058's form also admits a row a dead process left mid-send, and flags it.
    const v058 = /maybe_duplicate/i.test(q);
    const allowed = v058 ? ["claimed", "rendered", "sending", "failed"] : ["claimed", "rendered", "failed"];
    // THE COMPARE-AND-SWAP. `attempts = $3` is the whole cross-replica guard.
    if (!d || d.attempts !== expected || !allowed.includes(d.status)) { return []; }
    const before = { ...d };
    journal(() => { Object.assign(d, before); });
    d.attempts += 1;
    d.next_attempt_at = new Date(nextAt);
    d.claimed_by = worker;
    if (v058 && d.status === "sending") { d.maybe_duplicate = true; }
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
    requireShape(q, "delivered_to = coalesce($5, delivered_to)",
      "the per-address path commits delivered_to address by address; the terminal write must not wipe it");
    const [id, resId, attempts, channel, deliveredTo] = params as [string, string, number, string | null, string[] | null];
    const d = store.deliveries.find((x) => x.id === id && x.res_id === resId);
    // The terminal CAS. Zero rows here is what makes a superseded worker throw.
    if (!d || d.attempts !== attempts || d.status === "delivered") { return []; }
    const before = { ...d };
    journal(() => { Object.assign(d, before); });
    d.status = "delivered"; d.delivered_at = now(); d.error = null;
    d.channel = channel ?? d.channel;
    d.delivered_to = deliveredTo ?? d.delivered_to;
    return [{ id: d.id }];
  }

  if (/^update "ReportDeliveries" set status = 'failed', error = \$5/i.test(q)) {
    requireShape(q, "attempts = $3", "a superseded worker's error must not land on a row another worker delivered");
    const [id, resId, attempts, nextAt, error, final, max] = params as [string, string, number, string, string, boolean, number];
    const d = store.deliveries.find((x) => x.id === id && x.res_id === resId);
    if (!d || d.attempts !== attempts || d.status === "delivered") { return []; }
    const before = { ...d };
    journal(() => { Object.assign(d, before); });
    d.status = "failed"; d.error = error; d.next_attempt_at = new Date(nextAt);
    if (final) { d.attempts = Math.max(d.attempts, max); }
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

  if (/from "ReportDeliveries" d left join "ReportSchedules" s/i.test(q)) {
    requireShape(q, "(d.schedule_id is null or s.id is not null)",
      "a Send now has no schedule; an inner join would leave every failed one unretried");
    const [resId, maxAttempts] = params as [string, number];
    return store.deliveries
      .filter((d) =>
        d.res_id === resId &&
        ["claimed", "rendered", "sending", "failed"].includes(d.status) &&
        d.attempts < maxAttempts &&
        d.next_attempt_at.getTime() <= now().getTime())
      .map((d) => {
        const s = d.schedule_id === null ? null : store.schedules.find((x) => x.id === d.schedule_id) ?? null;
        if (d.schedule_id !== null && !s) { return null; }
        return {
          id: d.id, schedule_id: d.schedule_id, outlet_id: d.outlet_id,
          occurrence_key: d.occurrence_key, period_from: d.period_from,
          period_to: d.period_to, timezone: d.timezone, attempts: d.attempts,
          channel: d.channel, status: d.status,
          name: s?.name ?? "Send now", report_key: s?.report_key ?? "bundle", format: s?.format ?? d.formats[0] ?? "csv",
          recipients: d.schedule_id === null ? d.recipients : s?.recipients,
          kind: d.kind, outlet_scope: d.outlet_scope, day_close: d.day_close,
          window_start_at: d.window_start_at, window_end_at: d.window_end_at, requested_by: d.requested_by,
          report_keys: d.report_keys.length > 0 ? d.report_keys : s?.report_keys ?? [],
          formats: d.kind === "scheduled" && d.report_keys.length === 0 ? s?.formats ?? ["csv"] : d.formats,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
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
