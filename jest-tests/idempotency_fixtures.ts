// In-memory store + a fake `pg` Pool, so the REAL retry-safety path
// (idempotency.ts driving the "IdempotencyKeys" statements in
// database_supabase.ts) can be exercised as a unit test — including two
// duplicates racing each other and a holder that died mid-request.
//
// WHY A FIXTURE RATHER THAN PURE FUNCTIONS: the guarantee is not in any
// function, it is in the SQL — a unique index, an ON CONFLICT takeover
// predicate, and two compare-and-swaps on a claim token. A test that
// re-implemented the claim in TypeScript would assert only that the copy agrees
// with itself. Driving the shipped code path over a stubbed Pool tests the real
// predicates and needs no database, so the suite can never be "skipped because a
// database wasn't reachable". (Same reasoning, same shape, as print_fixtures.ts.)
//
// THE ONE RULE THAT MAKES THIS HONEST: dispatch DERIVES its behaviour from the
// SQL text rather than hardcoding the rules next to it. The takeover predicate's
// two arms are parsed out of the statement and applied only if they are actually
// present; the compare-and-swap columns are read out of the WHERE clause. So
// deleting a guard in database_supabase.ts changes what these tests observe,
// instead of leaving the fixture enforcing a rule the database no longer has.
// Where a construct is too awkward to emulate, requireShape asserts on its text
// instead and says why.
//
// WHAT IT DOES NOT MODEL, stated because an inaccurate promise is worse than
// none: isolation. Writes are visible to other connections immediately, as if
// every transaction ran READ UNCOMMITTED, and the ON CONFLICT arbitration is
// emulated by a lookup rather than by a real unique index under MVCC. That is
// strictly HARSHER than Postgres for these tests — two duplicates racing here
// interleave more aggressively than they could in the database — but it means
// this fixture cannot be used to reason about lost updates that real MVCC would
// prevent.
//
// Dispatch matches on a marker in the SQL and THROWS on anything unrecognised,
// so a code path that starts issuing a new query fails loudly here rather than
// silently receiving zero rows.

export const RES_ID = "55555555-5555-4555-8555-555555555555";
export const OUTLET_ID = "66666666-6666-4666-8666-666666666666";
/** A SECOND outlet of the SAME tenant — the fingerprint's cross-branch guard. */
export const OTHER_OUTLET_ID = "77777777-7777-4777-8777-777777777777";
export const EMPLOYEE_ID = "44444444-4444-4444-8444-444444444444";

export interface IdemRow {
  id: string;
  created_at: Date;
  res_id: string;
  outlet_id: string | null;
  employee_id: string | null;
  idem_key: string;
  route_key: string;
  fingerprint: string;
  status: string;
  attempts: number;
  claim_token: string;
  lease_until: Date | null;
  completed_at: Date | null;
  response_status: number | null;
  response_body: unknown;
  expires_at: Date;
}

interface Store {
  rows: IdemRow[];
  /** Every "IdempotencyKeys" statement throws 42P01 — migration 033 not applied. */
  tableMissing: boolean;
  nextId: number;
  nextToken: number;
  /** EVERY statement this fixture is asked to run, in order. The "no key means
   *  no behaviour change" test asserts on this list being untouched, which is
   *  the only way to prove the claim rather than assert it. */
  log: string[];
}

let store: Store = freshStore();

function freshStore(): Store {
  return { rows: [], tableMissing: false, nextId: 1, nextToken: 1, log: [] };
}

export function resetStore(): void { store = freshStore(); }
export function rows(): IdemRow[] { return store.rows; }
export function rowByKey(key: string): IdemRow | undefined {
  return store.rows.find((r) => r.idem_key === key);
}
/** Statements issued since the last reset, normalised to one line each. */
export function queryLog(): string[] { return store.log; }
/** Only the statements that touched the key table — the request path's own
 *  queries (there are none in these tests) are not interesting here. */
export function keyQueryLog(): string[] {
  return store.log.filter((q) => q.includes('"IdempotencyKeys"'));
}

/** Model a deployment where the backend shipped ahead of migration 033. */
export function breakKeyTable(): void { store.tableMissing = true; }

/** Seed a row directly, for states a request cannot reach (an expired key, a
 *  holder whose lease lapsed, a completed key from a previous shift). */
export function addRow(over: Partial<IdemRow> = {}): IdemRow {
  const n = store.nextId++;
  const row: IdemRow = {
    id: `idem-${String(n)}`,
    created_at: new Date(),
    res_id: RES_ID,
    outlet_id: OUTLET_ID,
    employee_id: EMPLOYEE_ID,
    idem_key: `key-${String(n)}`,
    route_key: "POST /orders",
    fingerprint: "deadbeef",
    status: "in_flight",
    attempts: 1,
    claim_token: `tok-${String(store.nextToken++)}`,
    lease_until: null,
    completed_at: null,
    response_status: null,
    response_body: null,
    expires_at: new Date(Date.now() + 3600_000),
    ...over,
  };
  store.rows.push(row);
  return row;
}

const now = (): Date => new Date();

class MissingTableError extends Error {
  code = "42P01";
  constructor() { super('relation "IdempotencyKeys" does not exist'); }
}

/**
 * Asserted TEXT, for constructs this fixture cannot emulate. Everything else is
 * derived from the SQL instead (see the header) — a text assertion only proves a
 * string is present, not that it does anything.
 */
function requireShape(q: string, fragment: string, why: string): void {
  if (!q.toLowerCase().includes(fragment.toLowerCase())) {
    throw new Error(`idempotency fixture: query lost "${fragment}" — ${why}\n  ${q.slice(0, 240)}`);
  }
}

// --- predicates parsed OUT OF the statement ---------------------------------

/**
 * THE TAKEOVER PREDICATE, read out of the claim's ON CONFLICT ... WHERE.
 *
 * Two independent arms, and losing either one is a distinct production defect:
 *
 *   expiry arm  — without it the 48-hour window would depend on the reaper
 *                 having run, and a key would be honoured forever.
 *   lease arm   — without it a request whose process died between claim and
 *                 response pins its key as permanently in_flight, and the client
 *                 can never land that write at all.
 *
 * Both are parsed rather than assumed, so deleting either from
 * database_supabase.ts turns a test red instead of leaving this fixture
 * enforcing a rule the database no longer has.
 */
interface Takeover { expiry: boolean; lease: boolean }
function takeoverClause(q: string): Takeover {
  return {
    expiry: /"IdempotencyKeys"\.expires_at <= now\(\)/i.test(q),
    lease: /"IdempotencyKeys"\.status = 'in_flight'\s*and\s*\("IdempotencyKeys"\.lease_until is null\s*or\s*"IdempotencyKeys"\.lease_until <= now\(\)\)/i.test(q),
  };
}

function canTakeOver(row: IdemRow, t: Takeover, at: number): boolean {
  if (t.expiry && row.expires_at.getTime() <= at) { return true; }
  if (t.lease && row.status === "in_flight"
      && (row.lease_until === null || row.lease_until.getTime() <= at)) { return true; }
  return false;
}

/**
 * The compare-and-swap columns a settle statement actually checks.
 *
 * claim_token is what stops a request whose lease lapsed from writing its
 * (superseded) response over the row a later request now owns; status is what
 * stops one claim being completed twice. Read out of the WHERE so removing
 * either is visible here.
 */
function guardsClaimToken(q: string): boolean { return /claim_token = \$\d+/i.test(q); }
function guardsInFlight(q: string): boolean { return /status = 'in_flight'/i.test(q); }

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
  __idemFixtureConnect?: () => FixtureConnection;
}
(globalThis as unknown as FixtureGlobal).__idemFixtureConnect = () => new FakeClient();

const DDL = /^(alter|create|drop|do|grant|revoke|comment|set|truncate)\b/i;

// eslint-disable-next-line @typescript-eslint/require-await
async function dispatch(q: string, params: unknown[], journal: (u: Undo) => void): Promise<unknown[]> {
  store.log.push(q);
  if (DDL.test(q)) { return []; }
  if (/^select set_config\('app\.res_id'/i.test(q)) { return []; }
  if (/^select id from "Restaurant"$/i.test(q)) { return [{ id: RES_ID }]; }

  if (/"IdempotencyKeys"/i.test(q) && store.tableMissing) { throw new MissingTableError(); }

  // --- ClaimIdempotencyKey, statement one -----------------------------------
  if (/^insert into "IdempotencyKeys"/i.test(q)) {
    requireShape(q, "on conflict (res_id, idem_key)",
      "identity is the tenant plus the client's key; conflicting on anything else would let one restaurant burn another's keys, or let one client's key collide with itself across outlets");
    requireShape(q, "claim_token = gen_random_uuid()",
      "a takeover MUST reissue the token, or the previous holder's late completion would overwrite the row the new holder owns");
    requireShape(q, "returning claim_token",
      "the caller settles by compare-and-swap on this token; without it there is nothing to swap on");
    const [resId, outletId, employeeId, idemKey, routeKey, fingerprint, leaseIso, expiresIso] =
      params as [string, string | null, string | null, string, string, string, string, string];
    const t = takeoverClause(q);
    const at = now().getTime();
    const existing = store.rows.find((r) => r.res_id === resId && r.idem_key === idemKey);

    if (existing && !canTakeOver(existing, t, at)) { return []; }

    if (existing) {
      const before = { ...existing };
      journal(() => { Object.assign(existing, before); });
      existing.outlet_id = outletId;
      existing.employee_id = employeeId;
      existing.route_key = routeKey;
      existing.fingerprint = fingerprint;
      existing.status = "in_flight";
      existing.attempts += 1;
      existing.claim_token = `tok-${String(store.nextToken++)}`;
      existing.lease_until = new Date(leaseIso);
      existing.expires_at = new Date(expiresIso);
      existing.created_at = now();
      existing.completed_at = null;
      existing.response_status = null;
      existing.response_body = null;
      return [{ claim_token: existing.claim_token }];
    }

    const row = addRow({
      res_id: resId, outlet_id: outletId, employee_id: employeeId,
      idem_key: idemKey, route_key: routeKey, fingerprint,
      status: "in_flight", attempts: 1,
      lease_until: new Date(leaseIso), expires_at: new Date(expiresIso),
      created_at: now(),
    });
    journal(() => { store.rows = store.rows.filter((r) => r !== row); });
    return [{ claim_token: row.claim_token }];
  }

  // --- ClaimIdempotencyKey, statement two -----------------------------------
  if (/^select claim_token, status, fingerprint, route_key, response_status, response_body from "IdempotencyKeys"/i.test(q)) {
    // The read-back must ITSELF respect the window, or a key whose row is
    // expired-but-not-yet-purged would be reported as completed and replayed
    // long after it should have stopped being honoured.
    requireShape(q, "expires_at > now()",
      "an expired row must never be replayed, whether or not the reaper has run");
    const [resId, idemKey] = params as [string, string];
    const at = now().getTime();
    const row = store.rows.find(
      (r) => r.res_id === resId && r.idem_key === idemKey && r.expires_at.getTime() > at,
    );
    return row
      ? [{
        claim_token: row.claim_token, status: row.status, fingerprint: row.fingerprint,
        route_key: row.route_key, response_status: row.response_status,
        response_body: row.response_body,
      }]
      : [];
  }

  // --- CompleteIdempotencyKey ------------------------------------------------
  if (/^update "IdempotencyKeys" set status = 'completed'/i.test(q)) {
    requireShape(q, "returning id",
      "the caller distinguishes 'this holder settled it' from 'the lease was taken over' by row count alone");
    const [resId, idemKey, claimToken, responseStatus, responseBody, expiresIso] =
      params as [string, string, string, number, string | null, string];
    const row = store.rows.find((r) => r.res_id === resId && r.idem_key === idemKey);
    if (!row) { return []; }
    // THE COMPARE-AND-SWAP. Applied only when the statement actually carries it,
    // so removing either guard is visible as a stale response being stored.
    if (guardsClaimToken(q) && row.claim_token !== claimToken) { return []; }
    if (guardsInFlight(q) && row.status !== "in_flight") { return []; }
    const before = { ...row };
    journal(() => { Object.assign(row, before); });
    row.status = "completed";
    row.completed_at = now();
    row.response_status = responseStatus;
    row.response_body = responseBody === null ? null : JSON.parse(responseBody);
    row.lease_until = null;
    row.expires_at = new Date(expiresIso);
    return [{ id: row.id }];
  }

  // --- ReleaseIdempotencyKey -------------------------------------------------
  if (/^delete from "IdempotencyKeys" where res_id = \$1 and idem_key = \$2/i.test(q)) {
    const [resId, idemKey, claimToken] = params as [string, string, string];
    const row = store.rows.find((r) => r.res_id === resId && r.idem_key === idemKey);
    if (!row) { return []; }
    if (guardsClaimToken(q) && row.claim_token !== claimToken) { return []; }
    if (guardsInFlight(q) && row.status !== "in_flight") { return []; }
    journal(() => { store.rows.push(row); });
    store.rows = store.rows.filter((r) => r !== row);
    return [{ id: row.id }];
  }

  // --- PurgeExpiredIdempotencyKeys -------------------------------------------
  if (/^with doomed as \( select id from "IdempotencyKeys"/i.test(q)) {
    const [resId, limit] = params as [string, number];
    const at = now().getTime();
    // WHICH predicate bounds the purge is the whole question: keying on
    // created_at would delete a live key inside its window.
    const keyed = /expires_at <= now\(\)/i.test(q);
    const doomed = store.rows
      .filter((r) => r.res_id === resId && (!keyed || r.expires_at.getTime() <= at))
      .sort((a, b) => a.expires_at.getTime() - b.expires_at.getTime())
      .slice(0, limit);
    journal(() => { store.rows.push(...doomed); });
    store.rows = store.rows.filter((r) => !doomed.includes(r));
    return doomed.map((r) => ({ id: r.id }));
  }

  throw new Error(`idempotency fixture: unstubbed SQL — ${q.slice(0, 240)}`);
}
