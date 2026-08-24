// The 2026-08-24 production stall, pinned as regression tests.
//
// WHAT HAPPENED. The backend talks to Supabase through the SESSION-mode pooler,
// which allows 15 clients for the runtime role. Two defects compounded under a
// busy service:
//
//   1) ensureOutletColumns memoized itself with `if (ensured && !client)`, so
//      every bill settlement — which calls nextBillNo(context, client) inside
//      the settle transaction — re-ran two ALTER TABLEs on "Outlets" on the
//      hottest money path. ALTER TABLE wants an ACCESS EXCLUSIVE lock while
//      concurrent settles hold bill_seq row locks: the convoy hit the statement
//      timeout ("canceling statement due to statement timeout" at
//      ensureOutletColumns <- nextBillNo <- withTransaction <- waiter_confirm)
//      and held pooled sessions for the full wait.
//   2) When the local pg pool saturated, the acquire timeout fell through to the
//      ipv4 FALLBACK pool — same role, same database — which opened up to
//      POOL_MAX MORE sessions and blew the pooler's 15-slot cap. From then on
//      every connect was refused with FATAL "max clients reached in session
//      mode", requireAuth could not bind a tenant connection, and every module
//      of every tenant 500'd at once.
//
// Each test drives the SHIPPED functions in database_supabase.ts over a faked
// `pg` (the established pattern of segments_and_weights.test.ts) — no copies.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";

jest.mock("pg", () => {
  interface QueryLogEntry { sql: string; params: unknown[] }
  class FakeClient {
    queries: QueryLogEntry[] = [];
    /** One entry per release() call; the entry is the error passed (or null). */
    released: unknown[] = [];
    onQuery: ((sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>) | null = null;
    query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
      this.queries.push({ sql, params });
      return this.onQuery ? this.onQuery(sql, params) : Promise.resolve({ rows: [] });
    }
    release(err?: unknown): void { this.released.push(err ?? null); }
    on(): this { return this; }
  }
  class FakePool {
    static instances: FakePool[] = [];
    config: { connectionString?: string };
    connectCalls = 0;
    client = new FakeClient();
    connectImpl: (() => Promise<FakeClient>) | null = null;
    totalCount = 0;
    idleCount = 0;
    waitingCount = 0;
    constructor(config: { connectionString?: string }) {
      this.config = config;
      FakePool.instances.push(this);
    }
    on(): this { return this; }
    connect(): Promise<FakeClient> {
      this.connectCalls += 1;
      return this.connectImpl ? this.connectImpl() : Promise.resolve(this.client);
    }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
      return this.client.query(sql, params ?? []);
    }
    end(): Promise<void> { return Promise.resolve(); }
  }
  (globalThis as Record<string, unknown>).__fakePg = { FakePool, FakeClient };
  return { Pool: FakePool, default: { Pool: FakePool } };
});

interface FakeClientT {
  queries: { sql: string; params: unknown[] }[];
  released: unknown[];
  onQuery: ((sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>) | null;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(err?: unknown): void;
}
interface FakePoolT {
  config: { connectionString?: string };
  connectCalls: number;
  client: FakeClientT;
  connectImpl: (() => Promise<FakeClientT>) | null;
}
interface FakePgHandles {
  FakePool: { instances: FakePoolT[] };
  FakeClient: new () => FakeClientT;
}

const PRIMARY_URL = "postgres://fixture:fixture@primary.fixture.local:5432/fixture";
const IPV4_URL = "postgres://fixture:fixture@203.0.113.7:5432/fixture";

type Db = typeof import("../database_supabase");
let db: Db;
let seam: Db["__poolHygieneTestSeam"];
let primary: FakePoolT;
let ipv4: FakePoolT;
let FakeClientCtor: new () => FakeClientT;

const ctx = {
  res_id: "0b6a2f34-0000-4000-8000-000000000001",
  outlet_id: "0b6a2f34-0000-4000-8000-000000000002",
  employeeId: "0b6a2f34-0000-4000-8000-000000000003",
  role: "admin",
};

const normalize = (sql: string): string => sql.replace(/\s+/g, " ").trim();
const altersOnOutlets = (c: FakeClientT): number =>
  c.queries.filter((q) => /alter table "Outlets"/i.test(q.sql)).length;

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL = PRIMARY_URL;
  process.env.SUPABASE_IPV4_URL = IPV4_URL;
  db = await import("../database_supabase");
  seam = db.__poolHygieneTestSeam;
  const handles = (globalThis as Record<string, unknown>).__fakePg as FakePgHandles;
  FakeClientCtor = handles.FakeClient;
  const byUrl = (url: string): FakePoolT => {
    const found = handles.FakePool.instances.find((p) => p.config.connectionString === url);
    if (!found) {throw new Error(`no fake pool was constructed for ${url}`);}
    return found;
  };
  primary = byUrl(PRIMARY_URL);
  ipv4 = byUrl(IPV4_URL);
});

beforeEach(async () => {
  seam.resetDdlMemo();
  // Restore a healthy primary and clear per-test state. The trailing successful
  // acquire also resets the module's isipv4Fallback flag in case a previous test
  // exercised the fallback path.
  primary.connectImpl = null;
  ipv4.connectImpl = null;
  primary.client = new FakeClientCtor();
  ipv4.client = new FakeClientCtor();
  await db.withTenant(ctx, async () => undefined);
  primary.client = new FakeClientCtor();
});

// ---------------------------------------------------------------------------
describe("ensure* schema DDL runs once per process", () => {
  test("ensureOutletColumns with a transaction client (the settle path) runs its ALTERs exactly once, ever", async () => {
    const txClient = new FakeClientCtor();

    // First settle of the process: the two ALTERs run, on the settle txn client.
    await seam.ensureOutletColumns(txClient as never);
    expect(altersOnOutlets(txClient)).toBe(2);

    // Every later settle — with a client, with another client, without one —
    // must be a pure no-op: no query anywhere. This is the exact call shape of
    // nextBillNo(context, client) that re-ran DDL inside the settle transaction.
    const secondTxClient = new FakeClientCtor();
    await seam.ensureOutletColumns(txClient as never);
    await seam.ensureOutletColumns(secondTxClient as never);
    await seam.ensureOutletColumns();
    expect(txClient.queries.length).toBe(2);
    expect(secondTxClient.queries.length).toBe(0);
    expect(primary.client.queries.length).toBe(0);
    expect(ipv4.client.queries.length).toBe(0);
  });

  test("N concurrent first calls share ONE DDL run (no ACCESS EXCLUSIVE lock convoy)", async () => {
    const txClient = new FakeClientCtor();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    txClient.onQuery = async () => { await gate; return { rows: [] }; };

    const racers = [
      seam.ensureOutletColumns(txClient as never),
      seam.ensureOutletColumns(txClient as never),
      seam.ensureOutletColumns(txClient as never),
      seam.ensureOutletColumns(txClient as never),
      seam.ensureOutletColumns(txClient as never),
    ];
    open();
    await Promise.all(racers);
    // 5 un-deduplicated racers would have issued 10 ALTERs; one run issues 2.
    expect(altersOnOutlets(txClient)).toBe(2);
  });

  test("a FAILED first run is not memoized — the next call retries", async () => {
    const txClient = new FakeClientCtor();
    txClient.onQuery = () => Promise.reject(new Error("connection reset"));
    await expect(seam.ensureOutletColumns(txClient as never)).rejects.toThrow("connection reset");

    const retryClient = new FakeClientCtor();
    await seam.ensureOutletColumns(retryClient as never);
    expect(altersOnOutlets(retryClient)).toBe(2);
  });

  test("ensureFeedbackColumns is memoized even when a client is passed", async () => {
    const txClient = new FakeClientCtor();
    await seam.ensureFeedbackColumns(txClient as never);
    const firstRun = txClient.queries.length;
    expect(firstRun).toBeGreaterThan(0);
    await seam.ensureFeedbackColumns(txClient as never);
    await seam.ensureFeedbackColumns();
    expect(txClient.queries.length).toBe(firstRun);
    expect(primary.client.queries.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("pool saturation surfaces as a clean 503-busy, never a FATAL cascade", () => {
  test("DbBusyError carries status 503 for the terminal express handler", () => {
    const err = new db.DbBusyError();
    expect(err.status).toBe(503);
    expect(err.name).toBe("DbBusyError");
  });

  test("classification: local acquire timeout, pooler max-clients FATAL and 53300 are saturation; network failures are not", () => {
    expect(seam.isPoolSaturationError(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(seam.isPoolSaturationError(new Error(
      "max clients reached in session mode - max clients are limited to pool_size: 15",
    ))).toBe(true);
    expect(seam.isPoolSaturationError(Object.assign(new Error("too many connections"), { code: "53300" }))).toBe(true);
    expect(seam.isPoolSaturationError(Object.assign(new Error("connect ENETUNREACH 2406::1:5432"), { code: "ENETUNREACH" }))).toBe(false);
    expect(seam.isPoolSaturationError(Object.assign(new Error("getaddrinfo ENOTFOUND db.host"), { code: "ENOTFOUND" }))).toBe(false);
  });

  test("a saturated primary pool rejects openTenantConnection with DbBusyError and NEVER dials the ipv4 fallback", async () => {
    primary.connectImpl = () => Promise.reject(new Error("timeout exceeded when trying to connect"));
    const fallbackDialsBefore = ipv4.connectCalls;
    await expect(db.openTenantConnection(ctx)).rejects.toMatchObject({ name: "DbBusyError", status: 503 });
    // The cascade that blew the pooler's 15-slot cap: saturation must not open
    // MORE sessions of the same role through the fallback pool.
    expect(ipv4.connectCalls).toBe(fallbackDialsBefore);
  });

  test("the pooler's own 'max clients reached' FATAL maps to the same DbBusyError on withTenant", async () => {
    primary.connectImpl = () => Promise.reject(new Error(
      "max clients reached in session mode - max clients are limited to pool_size: 15",
    ));
    const fallbackDialsBefore = ipv4.connectCalls;
    await expect(db.withTenant(ctx, async () => "unreached")).rejects.toBeInstanceOf(db.DbBusyError);
    expect(ipv4.connectCalls).toBe(fallbackDialsBefore);
  });

  test("a saturated FALLBACK pool also surfaces as DbBusyError (after a genuine primary outage)", async () => {
    primary.connectImpl = () => Promise.reject(Object.assign(new Error("connect ENETUNREACH 2406::1:5432"), { code: "ENETUNREACH" }));
    ipv4.connectImpl = () => Promise.reject(new Error("max clients reached in session mode - max clients are limited to pool_size: 15"));
    await expect(db.openTenantConnection(ctx)).rejects.toBeInstanceOf(db.DbBusyError);
  });

  test("a genuine connectivity failure on the primary still falls back to the ipv4 pool", async () => {
    primary.connectImpl = () => Promise.reject(Object.assign(new Error("connect ENETUNREACH 2406::1:5432"), { code: "ENETUNREACH" }));
    const fallbackDialsBefore = ipv4.connectCalls;
    const conn = await db.openTenantConnection(ctx);
    expect(ipv4.connectCalls).toBe(fallbackDialsBefore + 1);
    expect(ipv4.client.queries[0]?.sql).toContain("set_config('app.res_id', $1, false)");
    await conn.release();
    expect(ipv4.client.released.length).toBe(1);
  });

  test("a failed GUC bind releases (destroys) the checked-out client instead of leaking it", async () => {
    primary.client.onQuery = () => Promise.reject(new Error("server closed the connection unexpectedly"));
    await expect(db.openTenantConnection(ctx)).rejects.toThrow("server closed the connection unexpectedly");
    expect(primary.client.released.length).toBe(1);
    // Released WITH the error, so pg destroys the connection rather than
    // recycling one whose GUC state is unknown.
    expect(primary.client.released[0]).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
describe("the withTenant transactional path is unchanged", () => {
  test("BEGIN → TXN-LOCAL set_config of all four app.* GUCs → work → COMMIT, on one client, then released", async () => {
    const value = await db.withTenant(ctx, async () => {
      await db.runTenantQuery("select 1", []);
      return 42;
    });
    expect(value).toBe(42);

    const client = primary.client;
    const sqls = client.queries.map((q) => normalize(q.sql));
    expect(sqls[0]).toBe("BEGIN");
    // Transaction-local binding (`true`) is what guarantees the tenant context
    // can never leak across pooled connections — it must not become session-level.
    expect(sqls[1]).toContain("set_config('app.res_id', $1, true)");
    expect(sqls[1]).toContain("set_config('app.outlet_id', $2, true)");
    expect(sqls[1]).toContain("set_config('app.employee_id', $3, true)");
    expect(sqls[1]).toContain("set_config('app.role', $4, true)");
    expect(client.queries[1]?.params).toEqual([ctx.res_id, ctx.outlet_id, ctx.employeeId, ctx.role]);
    // The work's query runs on the SAME client, inside the transaction.
    expect(sqls[2]).toBe("select 1");
    expect(sqls[3]).toBe("COMMIT");
    expect(sqls.length).toBe(4);
    expect(client.released.length).toBe(1);
    expect(client.released[0]).toBeNull();
  });

  test("a throwing work() still ROLLBACKs and releases", async () => {
    await expect(db.withTenant(ctx, async () => { throw new Error("route blew up"); })).rejects.toThrow("route blew up");
    const sqls = primary.client.queries.map((q) => normalize(q.sql));
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[sqls.length - 1]).toBe("ROLLBACK");
    expect(primary.client.released.length).toBe(1);
  });

  test("openTenantConnection stays SESSION-level and release() clears the GUCs before returning the client", async () => {
    const conn = await db.openTenantConnection(ctx);
    const bind = normalize(primary.client.queries[0]?.sql ?? "");
    expect(bind).toContain("set_config('app.res_id', $1, false)");
    expect(bind).toContain("set_config('app.role', $4, false)");

    await conn.release();
    const sqls = primary.client.queries.map((q) => normalize(q.sql));
    // Stray-transaction guard, then the GUC reset, then back to the pool.
    expect(sqls[1]).toBe("ROLLBACK");
    expect(sqls[2]).toContain("set_config('app.res_id', '', false)");
    expect(sqls[2]).toContain("set_config('app.role', '', false)");
    expect(primary.client.released.length).toBe(1);

    // release() is idempotent — requireAuth wires it to BOTH 'finish' and 'close'.
    await conn.release();
    expect(primary.client.released.length).toBe(1);
  });
});
