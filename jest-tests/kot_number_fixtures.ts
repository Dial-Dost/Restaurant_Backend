// In-memory store + a fake `pg` Pool so the REAL KOT-numbering path
// (kot_numbers.ts driving AllocateKotNumber's statements in
// database_supabase.ts) can be exercised as a unit test — including several
// tills racing the same outlet-day and a waiter reprinting a ticket.
//
// WHY A FIXTURE RATHER THAN PURE FUNCTIONS: none of the four guarantees live in
// a TypeScript function. "Gapless under concurrency" IS a `select … for update`
// on the day's counter row. "A reprint reuses its number" IS the memo lookup
// happening AFTER that lock is taken. "Resets at the restaurant's midnight" IS
// which day key the parameters carry. A test that re-implemented any of it in
// TypeScript would assert only that the copy agrees with itself. Same shape and
// reasoning as report_fixtures.ts, print_fixtures.ts and
// table_assignment_fixtures.ts.
//
// WHAT THIS ONE MODELS THAT ITS SIBLINGS DELIBERATELY DO NOT: LOCKING. The other
// fixtures state plainly that transactions are decorative, which is fine for
// what they test. It is not fine here — serialisation is the entire mechanism —
// so `for update` really does block, per connection, and really is released on
// COMMIT/ROLLBACK. Two behaviours therefore fall out of the SQL rather than out
// of the fixture: remove the `for update` and the concurrency test starts seeing
// duplicate numbers; move the memo lookup above the lock and the reprint race
// starts burning numbers.
//
// ROLLBACK IS MODELLED TOO, by a per-connection undo log rather than by copying
// the store. "A failed print does not burn a number" is a claim about the bump
// and the memo insert being in ONE transaction, and a fixture whose ROLLBACK
// left the counter advanced could not tell that apart from a broken allocator.
// An undo log is used instead of a snapshot on purpose: a snapshot restored on
// one connection would silently discard another connection's committed writes.
//
// STILL NOT MODELLED, stated because an inaccurate promise is worse than none:
// MVCC snapshots. A statement sees the latest committed AND uncommitted state of
// every other connection except where a lock stops it. That is harsher than
// Postgres, never softer, so a test that passes here would pass there.
//
// Dispatch matches on a marker in the SQL and THROWS on anything unrecognised,
// so a code path that starts issuing a new query fails loudly rather than
// silently receiving zero rows.

export const RES_ID = "11111111-1111-4111-8111-111111111111";
export const OUTLET_ID = "22222222-2222-4222-8222-222222222222";
export const RESTAURANT_SLUG = "navkrish";

/** The tenant's IANA zone. Mutable so a test can prove the day boundary really
 *  does follow the RESTAURANT and not the server or a hardcoded default. */
let timezone = "Asia/Kolkata";
export function setTimezone(tz: string): void { timezone = tz; }

export interface CounterRow {
  res_id: string;
  outlet_id: string;
  business_day: string;
  seq: number;
}

export interface TicketRow {
  res_id: string;
  outlet_id: string;
  business_day: string;
  kot_no: number;
  ticket_key: string;
}

/**
 * One "Menu" row, reduced to the two columns a kitchen docket actually reads.
 *
 * The station is what buildKotBase64 splits a ticket by, and it lives inside the
 * JSON `description` blob rather than in a column of its own (see
 * parseMenuDescription) — so the dispatcher below re-encodes it exactly the way
 * the real column stores it instead of inventing a shape GetMenuItems would not
 * understand.
 */
export interface MenuFixtureRow {
  id: string;
  name: string;
  station: string | null;
}

interface Store {
  counters: Map<string, CounterRow>;
  tickets: TicketRow[];
  /** The outlet's menu, as GetMenuItems would read it. Empty by default, which
   *  is the "no stations configured" restaurant: every dish falls into the one
   *  shared docket. */
  menu: MenuFixtureRow[];
  /** Every "KotCounters"/"KotTickets" statement throws 42P01 — migration 029
   *  not applied. */
  tableMissing: boolean;
}

let store: Store = freshStore();

function freshStore(): Store {
  return { counters: new Map(), tickets: [], menu: [], tableMissing: false };
}

/**
 * THE ROWS "PrintJobs" WAS HANDED, in dispatch order.
 *
 * A STABLE ARRAY, EMPTIED IN PLACE, because the suites that read it bind a
 * reference once at module load. Reassigning it here would leave every test
 * holding yesterday's array and asserting against an empty one.
 *
 * It exists because the enqueue moved. These suites used to intercept
 * print_jobs.ts's `enqueuePrintJob` wrapper with a recorder; since migration 042
 * the producers go through dispatchPrintJob, which calls the data layer's
 * EnqueuePrintJob DIRECTLY so it can pass the assignment — so the wrapper is no
 * longer on the path and a mock of it records nothing. Modelling the INSERT is
 * the honest replacement: it records what the queue was actually told, one layer
 * below where the old recorder sat, and it cannot drift out of the path again.
 */
export const printJobRows: { outlet_id: string; bill_id: string; kind: string; station: string | null; esc_base64: string }[] = [];

export function resetStore(): void {
  printJobRows.length = 0;
  store = freshStore();
  locks.clear();
  waiters.length = 0;
  undo.clear();
  timezone = "Asia/Kolkata";
}

export function counters(): CounterRow[] { return [...store.counters.values()]; }
export function tickets(): TicketRow[] { return [...store.tickets]; }

/** Model a deployment where the backend shipped ahead of migration 029. */
export function breakKotTables(): void { store.tableMissing = true; }

/**
 * Seed a ticket row directly, for a state a producer cannot legitimately reach.
 *
 * Used to occupy a number the allocator is ABOUT to hand out, so the memo insert
 * trips migration 029's kottickets_no_unique and the transaction has to roll
 * back — which is the only way to observe from outside whether the bump and the
 * insert really are one unit of work.
 */
export function seedTicket(row: TicketRow): void { store.tickets.push(row); }

/**
 * Give the outlet a menu, so a docket can be split across kitchen stations.
 *
 * Needed only by the tests that assert the SPLIT shares one number: without it
 * GetMenuItems returns nothing, every line resolves to a null station, and
 * buildKotBase64 produces the single "General" docket a one-station kitchen gets.
 */
export function seedMenu(rows: MenuFixtureRow[]): void { store.menu = [...rows]; }

const counterKey = (res: string, outlet: string, day: string) => `${res}|${outlet}|${day}`;

// ---------------------------------------------------------------------------
// Rollback — the per-connection undo log
// ---------------------------------------------------------------------------

/** connection id -> the inverse of each write it has made since BEGIN, in order. */
const undo = new Map<number, (() => void)[]>();

function record(connId: number, inverse: () => void): void {
  const log = undo.get(connId);
  if (log) {log.push(inverse);}
}

/** COMMIT: the writes stand, so the undo log is simply discarded. */
function commitUndo(connId: number): void { undo.delete(connId); }

/** ROLLBACK: replay the inverses newest-first, exactly as the real thing does. */
function rollbackUndo(connId: number): void {
  const log = undo.get(connId);
  undo.delete(connId);
  if (!log) {return;}
  for (let i = log.length - 1; i >= 0; i--) {log[i]!();}
}

// ---------------------------------------------------------------------------
// Row locking — the part that makes the concurrency test mean something
// ---------------------------------------------------------------------------

/** lock key -> the connection id holding it. */
const locks = new Map<string, number>();
/** FIFO of connections blocked on a key, so a released lock hands off in order. */
const waiters: { key: string; connId: number; resolve: () => void }[] = [];

function acquireLock(key: string, connId: number): Promise<void> {
  const holder = locks.get(key);
  if (holder === undefined || holder === connId) {
    locks.set(key, connId);
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => { waiters.push({ key, connId, resolve }); });
}

/** Release every lock this connection holds — what COMMIT and ROLLBACK do. */
function releaseLocks(connId: number): void {
  for (const [key, holder] of [...locks.entries()]) {
    if (holder !== connId) {continue;}
    locks.delete(key);
    const idx = waiters.findIndex((w) => w.key === key);
    if (idx >= 0) {
      const next = waiters.splice(idx, 1)[0]!;
      locks.set(key, next.connId);
      next.resolve();
    }
  }
}

// ---------------------------------------------------------------------------
// SQL dispatch
// ---------------------------------------------------------------------------

const str = (v: unknown): string => String(v ?? "");

class MissingTableError extends Error {
  code = "42P01";
  constructor(table: string) { super(`relation "${table}" does not exist`); }
}

/** Postgres' unique_violation, so the test can prove the constraint is load-bearing. */
class UniqueViolationError extends Error {
  code = "23505";
  constructor(constraint: string) { super(`duplicate key value violates unique constraint "${constraint}"`); }
}

function contextRow(): Record<string, unknown> {
  return {
    res_id: RES_ID,
    outlet_id: OUTLET_ID,
    restaurant_slug: RESTAURANT_SLUG,
    restaurant_name: "Navkrish",
    restaurant_main_office_add: null,
    restaurant_logo_url: null,
    timezone,
  };
}

async function query(connId: number, sqlRaw: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
  const sql = sqlRaw.replace(/\s+/g, " ").trim();
  const s = sql.toLowerCase();

  // Transaction control. BEGIN opens an undo log; COMMIT discards it and
  // ROLLBACK replays it; both end the lock's life, which is what lets a blocked
  // allocation proceed.
  if (/^begin/.test(s)) { undo.set(connId, []); return { rows: [] }; }
  if (/^commit/.test(s)) { commitUndo(connId); releaseLocks(connId); return { rows: [] }; }
  if (/^rollback/.test(s)) { rollbackUndo(connId); releaseLocks(connId); return { rows: [] }; }
  if (/^(savepoint|release)/.test(s)) {return { rows: [] };}
  if (s.includes("set_config(")) {return { rows: [] };}

  // Lazy DDL / RLS — swallowed.
  if (/^(create|alter|drop|do \$\$)/.test(s)) {return { rows: [] };}

  // --- Context resolution ---------------------------------------------------
  if (s.includes('from "restaurant" r')) {return { rows: [contextRow()] };}

  // --- Menu -----------------------------------------------------------------
  // GetMenuItems, which dispatchKot consults to tag each line with the station
  // that cooks it. Modelled because the per-station SPLIT is the thing that
  // makes "one number for the whole ticket" a claim worth testing at all — with
  // no menu there is only ever one docket and the claim is vacuous.
  if (s.includes('from "menu" m')) {
    return {
      rows: store.menu.map((m) => ({
        id: m.id,
        name: m.name,
        // The real column is a JSON blob; parseMenuDescription reads `station`
        // out of it. Encoding it here rather than returning a `station` column
        // keeps the fixture honest about where the value actually lives.
        description: JSON.stringify({ price: 0, station: m.station }),
        sub_category: null,
        main_category: null,
      })),
    };
  }

  const kotStatement = s.includes('"kotcounters"') || s.includes('"kottickets"');
  if (kotStatement && store.tableMissing) {
    throw new MissingTableError(s.includes('"kotcounters"') ? "KotCounters" : "KotTickets");
  }

  // --- KotCounters ----------------------------------------------------------
  if (s.startsWith('insert into "kotcounters"')) {
    const key = counterKey(str(params[0]), str(params[1]), str(params[2]));
    // `on conflict … do nothing` — a concurrent seeder winning is normal.
    if (!store.counters.has(key)) {
      store.counters.set(key, { res_id: str(params[0]), outlet_id: str(params[1]), business_day: str(params[2]), seq: 0 });
      record(connId, () => { store.counters.delete(key); });
    }
    return { rows: [] };
  }

  if (s.includes('from "kotcounters"') && s.includes("for update")) {
    // THE SERIALISATION POINT. Derived from the statement text: drop the
    // `for update` from database_supabase.ts and this stops blocking, which is
    // exactly when the concurrency test should start failing.
    const key = counterKey(str(params[0]), str(params[1]), str(params[2]));
    await acquireLock(key, connId);
    const row = store.counters.get(key);
    return { rows: row ? [{ seq: row.seq }] : [] };
  }

  if (s.startsWith('update "kotcounters"') && s.includes("seq = seq + 1")) {
    const key = counterKey(str(params[0]), str(params[1]), str(params[2]));
    const row = store.counters.get(key);
    if (!row) {return { rows: [] };}
    row.seq += 1;
    record(connId, () => { row.seq -= 1; });
    return { rows: [{ seq: row.seq }] };
  }

  // --- KotTickets -----------------------------------------------------------
  if (s.startsWith('select kot_no from "kottickets"')) {
    const hit = store.tickets.find(
      (t) => t.res_id === str(params[0]) && t.outlet_id === str(params[1]) && t.ticket_key === str(params[2]),
    );
    return { rows: hit ? [{ kot_no: hit.kot_no }] : [] };
  }

  if (s.startsWith('insert into "kottickets"')) {
    const [resId, outletId, day, kotNo, key] = [str(params[0]), str(params[1]), str(params[2]), Number(params[3]), str(params[4])];
    // Both unique constraints from migration 029, enforced rather than assumed —
    // the no_unique one is the backstop that turns a broken allocator into a
    // 23505 instead of two dockets printing the same number.
    if (store.tickets.some((t) => t.res_id === resId && t.outlet_id === outletId && t.ticket_key === key)) {
      throw new UniqueViolationError("kottickets_key_unique");
    }
    if (store.tickets.some((t) => t.res_id === resId && t.outlet_id === outletId && t.business_day === day && t.kot_no === kotNo)) {
      throw new UniqueViolationError("kottickets_no_unique");
    }
    const row: TicketRow = { res_id: resId, outlet_id: outletId, business_day: day, kot_no: kotNo, ticket_key: key };
    store.tickets.push(row);
    record(connId, () => {
      const at = store.tickets.indexOf(row);
      if (at >= 0) {store.tickets.splice(at, 1);}
    });
    return { rows: [] };
  }

  // --- PrintJobs -------------------------------------------------------------
  // The durable print queue (migration 027), reached through dispatchPrintJob.
  // Only the INSERT is modelled: what these suites assert is what the kitchen is
  // handed, and the queue's own statements are driven for real by
  // print_jobs.test.ts and print_routing.test.ts over their own fixtures.
  if (s.startsWith('insert into "printjobs"')) {
    printJobRows.push({
      outlet_id: str(params[1]),
      bill_id: str(params[2]),
      kind: str(params[3]),
      station: params[4] === null || params[4] === undefined ? null : str(params[4]),
      esc_base64: str(params[5]),
    });
    return { rows: [{ id: `job-${String(printJobRows.length)}` }] };
  }
  if (s.includes('"printjobs"')) {
    // Any other PrintJobs statement — a routed assignment read, an ack, the
    // reaper. Not this fixture's subject; answer empty rather than throwing, so
    // a routing path that degrades gracefully is not turned into a test failure.
    return { rows: [] };
  }

  throw new Error(`kot_number_fixtures: unmodelled SQL: ${sql.slice(0, 160)}`);
}

// ---------------------------------------------------------------------------
// Fake pg wiring — same globalThis pattern as the sibling fixtures, because a
// jest.mock("pg") factory is hoisted above imports and cannot close over them.
//
// EVERY connect() HANDS BACK A DISTINCT CONNECTION, unlike the siblings' shared
// one. Locks are per connection, so a shared object would make two concurrent
// allocations look like one and the concurrency test would pass vacuously.
// ---------------------------------------------------------------------------

let nextConnId = 1;

interface FixtureGlobal {
  __kotFixtureConnect?: () => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    release: () => void;
  };
}

(globalThis as unknown as FixtureGlobal).__kotFixtureConnect = () => {
  const connId = nextConnId++;
  return {
    query: (sql: string, params?: unknown[]) => query(connId, sql, params ?? []),
    // A released client must not keep holding locks — a leak here would deadlock
    // the whole suite rather than fail one test, which is much harder to read.
    release: () => { releaseLocks(connId); },
  };
};
