// In-memory store + a fake `pg` Pool, so the REAL durable-printing path
// (print_jobs.ts driving the "PrintJobs" statements in database_supabase.ts) can
// be exercised as a unit test — including two tills racing the same job and an
// agent that dies mid-print.
//
// WHY A FIXTURE RATHER THAN PURE FUNCTIONS: the guarantee is not in any function,
// it is in the SQL — a lease predicate, a terminal-status predicate, a read-time
// TTL and a compare-and-swap. A test that re-implemented the claim logic in
// TypeScript would assert only that the copy agrees with itself. Driving the
// shipped code path over a stubbed Pool tests the real predicates and needs no
// database, so the suite can never be "skipped because a database wasn't
// reachable". (Same reasoning, same shape, as report_fixtures.ts.)
//
// THE ONE RULE THAT MAKES THIS HONEST: dispatch DERIVES its behaviour from the
// SQL text rather than hardcoding the rules next to it. The status list is parsed
// out of the statement; the lease clause and the TTL clause are applied only if
// they are actually present. So mutating a guard in database_supabase.ts changes
// what these tests observe, instead of leaving the fixture enforcing a rule the
// database no longer has. Where a construct is too awkward to emulate
// (`for update skip locked`, `returning id`) requireShape asserts on its text
// instead, and says why.
//
// WHAT IT DOES NOT MODEL, stated because an inaccurate promise is worse than
// none: isolation. Writes are visible to other connections immediately, as if
// every transaction ran READ UNCOMMITTED. That is strictly HARSHER than Postgres
// for these tests — it lets a losing till see the winner's row mid-flight, which
// is the interleaving we want to survive — but it means this fixture cannot be
// used to reason about lost updates that real MVCC would prevent.
//
// Dispatch matches on a marker in the SQL and THROWS on anything unrecognised, so
// a code path that starts issuing a new query fails loudly here rather than
// silently receiving zero rows.

export const RES_ID = "77777777-7777-4777-8777-777777777777";
/** The till's outlet. */
export const OUTLET_ID = "88888888-8888-4888-8888-888888888888";
/** A SECOND outlet of the SAME tenant. RLS keys on res_id alone, so nothing in
 *  the database stops one branch's till reading this one's receipts — only
 *  OutletBelongsToRestaurant plus the outlet_id predicate do. */
export const OTHER_OUTLET_ID = "99999999-9999-4999-8999-999999999999";
/** An outlet id that belongs to NO restaurant — what a client can put on the
 *  wire, since joinOutlet's payload is unverified. */
export const FOREIGN_OUTLET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

export interface PrintJobRow {
  id: string;
  /** Insertion order, modelled because it is the ORDER BY's tiebreaker: without
   *  it, the tickets of one KOT (inserted in a tight loop, so plausibly sharing a
   *  created_at) come back in an arbitrary order. */
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
}

interface Store {
  jobs: PrintJobRow[];
  /** Every "PrintJobs" statement throws 42P01 — migration 027 not applied. */
  tableMissing: boolean;
  nextId: number;
}

let store: Store = freshStore();

function freshStore(): Store {
  return { jobs: [], tableMissing: false, nextId: 1 };
}

export function resetStore(): void { store = freshStore(); }

export function jobs(): PrintJobRow[] { return store.jobs; }
export function jobById(id: string): PrintJobRow | undefined {
  return store.jobs.find((j) => j.id === id);
}

/** Model a deployment where the backend shipped ahead of migration 027. */
export function breakPrintJobsTable(): void { store.tableMissing = true; }

/** Seed a row directly, for states a producer cannot reach (already acked, an
 *  abandoned lease, a row old enough to have expired). */
export function addJob(over: Partial<PrintJobRow> = {}): PrintJobRow {
  const n = store.nextId++;
  const row: PrintJobRow = {
    id: `job-${String(n)}`,
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
    ...over,
  };
  store.jobs.push(row);
  return row;
}

const now = (): Date => new Date();

class MissingTableError extends Error {
  code = "42P01";
  constructor() { super('relation "PrintJobs" does not exist'); }
}

/**
 * Asserted TEXT, for the two constructs this fixture cannot emulate. Everything
 * else is derived from the SQL instead (see the header) — a text assertion only
 * proves a string is present, not that it does anything.
 */
function requireShape(q: string, fragment: string, why: string): void {
  if (!q.toLowerCase().includes(fragment.toLowerCase())) {
    throw new Error(`print fixture: query lost "${fragment}" — ${why}\n  ${q.slice(0, 240)}`);
  }
}

// --- predicates parsed OUT OF the statement ---------------------------------

/**
 * The statuses a statement admits, read from its own `status [not] in (...)`.
 *
 * Parsed rather than hardcoded so that widening the list in database_supabase.ts
 * — the single most likely way to reintroduce a double-print — changes what the
 * tests see. Returns null when the statement carries no status predicate at all,
 * which is itself a mutation the tests must be able to observe.
 */
function statusPredicate(q: string): { negated: boolean; list: string[] } | null {
  const m = /status (not )?in \(([^)]*)\)/i.exec(q);
  if (!m) { return null; }
  return {
    negated: Boolean(m[1]),
    list: m[2].split(",").map((s) => s.trim().replace(/^'|'$/g, "")),
  };
}

function statusAdmits(pred: { negated: boolean; list: string[] } | null, status: string): boolean {
  if (!pred) { return true; }           // no predicate => every row matches
  const inList = pred.list.includes(status);
  return pred.negated ? !inList : inList;
}

/** Is the lease actually being enforced by this statement? */
function hasLeaseClause(q: string): boolean {
  return /claimed_until is null or claimed_until < now\(\)/i.test(q);
}

/**
 * The per-kind read-time TTL, INCLUDING WHICH PARAMETER FEEDS WHICH KIND.
 *
 * The branch wiring is read out of the statement rather than assumed, so
 * swapping the two cutoffs — handing kitchen dockets the 12-hour bill window —
 * is a mutation these tests can see. Returns null when the clause is absent or
 * unrecognised, which makes the fixture fail OPEN: more rows come back than
 * should, and an assertion trips.
 */
interface TtlClause { direction: "newer" | "older"; kotIdx: number; billIdx: number }
function ttlClause(q: string): TtlClause | null {
  const m = /created_at (>|<=) \(case when kind = 'kot' then \$(\d+)::timestamptz else \$(\d+)::timestamptz end\)/i.exec(q);
  if (!m) { return null; }
  return {
    direction: m[1] === ">" ? "newer" : "older",
    kotIdx: Number(m[2]),
    billIdx: Number(m[3]),
  };
}

function ttlCutoff(clause: TtlClause, kind: string, params: unknown[]): number {
  const idx = kind === "kot" ? clause.kotIdx : clause.billIdx;
  return new Date(String(params[idx - 1])).getTime();
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
// may not close over module scope.
export interface FixtureConnection {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  release: () => void;
}
interface FixtureGlobal {
  __printFixtureConnect?: () => FixtureConnection;
}
(globalThis as unknown as FixtureGlobal).__printFixtureConnect = () => new FakeClient();

const DDL = /^(alter|create|drop|do|grant|revoke|comment|set|truncate)\b/i;

// eslint-disable-next-line @typescript-eslint/require-await
async function dispatch(q: string, params: unknown[], journal: (u: Undo) => void): Promise<unknown[]> {
  if (DDL.test(q)) { return []; }
  if (/^select set_config\('app\.res_id'/i.test(q)) { return []; }

  // ListRestaurantIds — the reaper's only uncontexted read.
  if (/^select id from "Restaurant"$/i.test(q)) { return [{ id: RES_ID }]; }

  // OutletBelongsToRestaurant. The replay path's ONLY authorization question.
  if (/^select id from "Outlets" where id = \$1 and res_id = \$2/i.test(q)) {
    const [outletId, resId] = params as [string, string];
    const known = outletId === OUTLET_ID || outletId === OTHER_OUTLET_ID;
    return known && resId === RES_ID ? [{ id: outletId }] : [];
  }

  if (/"PrintJobs"/i.test(q) && store.tableMissing) { throw new MissingTableError(); }

  // --- EnqueuePrintJob ---
  if (/^insert into "PrintJobs"/i.test(q)) {
    requireShape(q, "returning id",
      "the producer must learn the job's uuid to put it in the emitted payload; without it the till is handed a job it can never ack");
    const [resId, outletId, billId, kind, station, esc] =
      params as [string, string, string, string, string | null, string];
    const row = addJob({
      res_id: resId, outlet_id: outletId, bill_id: billId, kind,
      station, esc_base64: esc, created_at: now(),
    });
    journal(() => { store.jobs = store.jobs.filter((j) => j !== row); });
    return [{ id: row.id }];
  }

  // --- ClaimPrintJobsForAgent ---
  if (/^with due as \( select id from "PrintJobs"/i.test(q)) {
    requireShape(q, "for update skip locked",
      "two replicas claiming at once must skip each other's locked rows rather than serialise; not the guard (the lease is) but its absence turns a reconnect storm into a queue");
    requireShape(q, "order by created_at asc",
      "the N station tickets of one KOT are one logical unit and dockets must reach the kitchen oldest-first");
    const [resId, outletId, , , agentId, leaseIso, limit] =
      params as [string, string, string, string, string, string, number];
    const pred = statusPredicate(q);
    const lease = hasLeaseClause(q);
    const ttl = ttlClause(q);
    const t = now().getTime();

    const eligible = store.jobs
      .filter((j) => j.res_id === resId && j.outlet_id === outletId)
      .filter((j) => statusAdmits(pred, j.status))
      // THE LEASE. Applied only when the statement actually carries it, so
      // deleting it from the SQL is visible here as two tills claiming one job.
      .filter((j) => !lease || j.claimed_until === null || j.claimed_until.getTime() < t)
      // THE READ-TIME TTL, per kind.
      .filter((j) => {
        if (ttl === null) { return true; }
        const cutoff = ttlCutoff(ttl, j.kind, params);
        return ttl.direction === "newer" ? j.created_at.getTime() > cutoff : j.created_at.getTime() <= cutoff;
      })
      // The ORDER BY's own key, tiebreaker included.
      .sort((a, b) => (a.created_at.getTime() - b.created_at.getTime()) || (a.seq - b.seq))
      .slice(0, limit);

    for (const j of eligible) {
      const before = { ...j };
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

  // --- AckPrintJob ---
  if (/^update "PrintJobs" set status = case when \$3 = 'printed'/i.test(q)) {
    requireShape(q, "returning id",
      "the caller distinguishes 'this call settled it' from 'already settled' by row count alone");
    const [jobId, resId, result] = params as [string, string, string];
    const pred = statusPredicate(q);
    const j = store.jobs.find((x) => x.id === jobId && x.res_id === resId);
    // THE COMPARE-AND-SWAP. Zero rows is what makes a duplicate ack a no-op.
    if (!j || !statusAdmits(pred, j.status)) { return []; }
    const before = { ...j };
    journal(() => { Object.assign(j, before); });
    j.status = result === "printed" ? "acked" : "failed";
    j.settled_at = now();
    j.ack_result = result;
    j.claimed_until = null;
    return [{ id: j.id }];
  }

  // --- ExpirePrintJobs ---
  if (/^update "PrintJobs" set status = 'expired'/i.test(q)) {
    const [resId] = params as [string];
    const pred = statusPredicate(q);
    const ttl = ttlClause(q);
    const lease = hasLeaseClause(q);
    const t = now().getTime();
    const hit = store.jobs.filter((j) =>
      j.res_id === resId &&
      statusAdmits(pred, j.status) &&
      // A job an agent currently holds is not the reaper's to settle.
      (!lease || j.claimed_until === null || j.claimed_until.getTime() < t) &&
      (ttl === null || (ttl.direction === "older"
        ? j.created_at.getTime() <= ttlCutoff(ttl, j.kind, params)
        : j.created_at.getTime() > ttlCutoff(ttl, j.kind, params))));
    for (const j of hit) {
      const before = { ...j };
      journal(() => { Object.assign(j, before); });
      j.status = "expired";
      j.settled_at = now();
    }
    return hit.map((j) => ({ id: j.id }));
  }

  // --- PurgeSettledPrintJobs ---
  if (/^with doomed as \( select id from "PrintJobs"/i.test(q)) {
    const [resId, olderThanIso, limit] = params as [string, string, number];
    const pred = statusPredicate(q);
    const cutoff = new Date(olderThanIso).getTime();
    // WHICH TIMESTAMP the window is measured from is the whole question here, so
    // it is read out of the statement rather than assumed: keying on created_at
    // deletes a just-expired job in the same sweep that expired it.
    const key: "settled_at" | "created_at" = /settled_at < \$\d+/i.test(q) ? "settled_at" : "created_at";
    const requiresSettled = /settled_at is not null/i.test(q);
    const hit = store.jobs
      .filter((j) => j.res_id === resId && statusAdmits(pred, j.status))
      .filter((j) => !requiresSettled || j.settled_at !== null)
      .filter((j) => { const at = j[key]; return at !== null && at.getTime() < cutoff; })
      .sort((a, b) => {
        const av = a[key]?.getTime() ?? 0; const bv = b[key]?.getTime() ?? 0;
        return av - bv;
      })
      .slice(0, limit);
    journal(() => { store.jobs.push(...hit); });
    store.jobs = store.jobs.filter((j) => !hit.includes(j));
    return hit.map((j) => ({ id: j.id }));
  }

  throw new Error(`print fixture: unstubbed SQL — ${q.slice(0, 240)}`);
}
