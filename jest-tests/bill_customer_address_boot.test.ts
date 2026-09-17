// MIGRATION 054's COLUMN AT BOOT — AND NOWHERE ELSE IN THE RUNTIME.
//
// "Bills".customer_address (client item 7) is made by the runtime itself, once,
// before the listener, because production connects as the table owner and the
// migration is applied by hand afterwards. "Bills" is the hottest money table
// in the product, so the rules are the ones InitKotDocketSchema follows, and
// stricter:
//
//   * nothing is issued when the column exists (ADD COLUMN IF NOT EXISTS takes
//     ACCESS EXCLUSIVE even when it has nothing to do);
//   * when it is missing, ONE autocommit statement sets a LOCAL 2s lock_timeout
//     before the ALTER, and the ALTER only runs if the column is still missing;
//   * it never throws, says false when the column is still not there, and seeds
//     the latch with that answer — an address write then answers 503;
//   * index.ts runs it before the server listens;
//   * NO REQUEST PATH ISSUES THE ALTER — the only DDL naming the column in
//     database_supabase.ts is inside this boot step;
//   * migrations/054 (when on this branch) waits at most 5s for its locks,
//     first thing, and adds the same column, idempotently.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RES = "11111111-1111-4111-8111-111111111111";
const OUTLET = "22222222-2222-4222-8222-222222222222";

const mockDb: {
  present: boolean;
  ddlError: (Error & { code?: string }) | null;
  /** False models a DO block that "succeeded" without the column appearing (no DDL rights). */
  ddlAdds: boolean;
  probeError: Error | null;
} = { present: false, ddlError: null, ddlAdds: true, probeError: null };

interface Statement { sql: string; on: "pool" | "transaction" }
const mockStatements: Statement[] = [];

jest.mock("pg", () => {
  const flat = (sql: string) => String(sql).replace(/\s+/g, " ").trim();
  const answer = (sql: string): unknown[] => {
    const q = flat(sql);
    if (/^(begin|commit|rollback)$/i.test(q) || /^select set_config\(/i.test(q)) {return [];}
    if (/^do \$\$/i.test(q)) {
      if (mockDb.ddlError) {throw mockDb.ddlError;}
      if (mockDb.ddlAdds) {mockDb.present = true;}
      return [];
    }
    if (/information_schema\.columns/i.test(q) && q.includes("'customer_address'")) {
      if (mockDb.probeError) {throw mockDb.probeError;}
      if (q.startsWith("select count(*)::int as n")) {return [{ n: mockDb.present ? 1 : 0 }];}
      return mockDb.present ? [{ column_name: "customer_address" }] : [];
    }
    if (/information_schema\.columns/i.test(q)) {return [];}
    if (q.includes('from "Restaurant" r')) {
      return [{
        res_id: RES, outlet_id: OUTLET, restaurant_slug: "fixture", restaurant_name: "Fixture Diner",
        restaurant_main_office_add: null, restaurant_logo_url: null, timezone: "Asia/Kolkata",
      }];
    }
    if (/^select id from "Tables"/i.test(q)) {return [{ id: "33333333-3333-4333-8333-333333333333" }];}
    if (/admin_approved_at from "Bills"/i.test(q)) {return [{ admin_approved_at: null }];}
    if (/^select id, food from "Orders"/i.test(q)) {return [{ id: "o1", food: { customer: "Guest", items: [] } }];}
    if (/^update /i.test(q)) {return [];}
    // The pre-existing lazy ensures a bill write already triggers (round_off,
    // the workflow columns) — memoised, and not what this file is about.
    if (/^(alter|create) /i.test(q) && !q.includes("customer_address")) {return [];}
    throw new Error(`address boot fixture: no answer for: ${q.slice(0, 140)}`);
  };
  const run = (on: "pool" | "transaction") => (sql: string): Promise<{ rows: unknown[] }> => {
    mockStatements.push({ sql: flat(sql), on });
    try { return Promise.resolve({ rows: answer(sql) }); }
    catch (err) { return Promise.reject(err); }
  };
  class FakeClient {
    query = run("transaction");
    release(): void { /* back to the pool */ }
  }
  class FakePool {
    on(): this { return this; }
    query = run("pool");
    connect(): Promise<FakeClient> { return Promise.resolve(new FakeClient()); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: jest.fn(), emitOutlet: jest.fn() }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: jest.fn() }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

type Db = typeof import("../database_supabase");
let db: Db;
let pending: typeof import("../customer_address").CustomerAddressSchemaPendingError;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
  pending = (await import("../customer_address")).CustomerAddressSchemaPendingError;
});

beforeEach(() => {
  db.resetBillCustomerAddressColumnCache();
  mockDb.present = false;
  mockDb.ddlError = null;
  mockDb.ddlAdds = true;
  mockDb.probeError = null;
  mockStatements.length = 0;
});

const ddl = () => mockStatements.filter((s) => /^(alter|do|create)\b/i.test(s.sql));
const src = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

describe("InitBillCustomerAddressSchema — migration 054 at boot", () => {
  test("the column there: no DDL at all, and it says ready", async () => {
    mockDb.present = true;
    await expect(db.InitBillCustomerAddressSchema()).resolves.toBe(true);
    expect(ddl()).toEqual([]);
  });

  test("the column missing: ONE autocommit statement — the lock timeout first, then the ALTER only while it is missing", async () => {
    await expect(db.InitBillCustomerAddressSchema()).resolves.toBe(true);
    const issued = ddl();
    expect(issued).toHaveLength(1);
    expect(issued[0]!.on).toBe("pool");
    const sql = issued[0]!.sql;
    const timeout = sql.indexOf("perform set_config('lock_timeout', '2s', true);");
    const guard = sql.indexOf("if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'Bills' and column_name = 'customer_address') then");
    const alter = sql.indexOf('alter table "Bills" add column if not exists customer_address text;');
    expect(timeout).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(timeout);
    expect(alter).toBeGreaterThan(guard);
    // Nullable, no default, no check: a catalogue-only change.
    expect(sql).not.toMatch(/default|not null|check/i);
  });

  test("once ready, the first address write does not ask the catalogue again", async () => {
    await db.InitBillCustomerAddressSchema();
    mockStatements.length = 0;
    await db.SetBillCustomerName(RES, "T1", "Acme", undefined, "12 MG Road");
    expect(mockStatements.some((s) => /information_schema/.test(s.sql))).toBe(false);
  });

  test("a lock timeout never takes boot down: false, and address writes answer 503", async () => {
    mockDb.ddlError = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
    await expect(db.InitBillCustomerAddressSchema()).resolves.toBe(false);
    await expect(db.SetBillCustomerName(RES, "T1", "Acme", undefined, "12 MG Road")).rejects.toBeInstanceOf(pending);
  });

  test("an ALTER that left no column (a runtime without DDL rights) is false, not a quiet ✅", async () => {
    mockDb.ddlAdds = false;
    await expect(db.InitBillCustomerAddressSchema()).resolves.toBe(false);
  });

  test("a catalogue that cannot be asked is false, and never throws", async () => {
    mockDb.probeError = new Error("connection terminated");
    await expect(db.InitBillCustomerAddressSchema()).resolves.toBe(false);
  });

  test("index.ts runs it before the server listens, after the other boot steps", () => {
    const index = src("index.ts");
    const boot = index.indexOf("if (await InitBillCustomerAddressSchema()) {");
    expect(boot).toBeGreaterThan(index.indexOf("if (await InitKotDocketSchema()) {"));
    expect(boot).toBeLessThan(index.indexOf("httpServer.listen("));
    expect(index).toMatch(/import \{[^}]*\bInitBillCustomerAddressSchema\b[^}]*\} from "\.\/database_supabase\.js";/);
  });

  test("no request path issues the ALTER: the only DDL naming the column is inside the boot step", () => {
    const dbSrc = src("database_supabase.ts");
    const at = dbSrc.indexOf("export async function InitBillCustomerAddressSchema(");
    const boot = dbSrc.slice(at, dbSrc.indexOf("\n}\n", at));
    const everywhere = [...dbSrc.matchAll(/alter table "Bills"[^;`]*customer_address/gi)].map((m) => m.index);
    expect(everywhere).toHaveLength(1);
    expect(everywhere[0]).toBeGreaterThan(at);
    expect(everywhere[0]).toBeLessThan(at + boot.length);
  });
});

describe("migration 054 (when present on this branch), applied by hand during service", () => {
  const file = join(__dirname, "..", "migrations", "054_bill_customer_address.sql");
  const code = (): string => readFileSync(file, "utf8").split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("--")).join("\n").trim();

  test("waits at most 5s for its locks on \"Bills\" — the first thing it does", () => {
    if (!existsSync(file)) { return; } // shipped in its own commit, applied by hand
    expect(code().startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true);
  });

  test("adds the same column the boot step adds, idempotently, and nothing else to the table", () => {
    if (!existsSync(file)) { return; }
    const sql = code();
    const alters = [...sql.matchAll(/ALTER TABLE "Bills"\s+ADD COLUMN IF NOT EXISTS (\w+) (\w+);/gi)].map((m) => `${m[1]} ${m[2]}`.toLowerCase());
    expect(alters).toEqual(["customer_address text"]);
    expect(sql.match(/ALTER TABLE/gi)).toHaveLength(1);
    // Nothing is rewritten or removed (the GRANT line names UPDATE/DELETE as privileges).
    expect(sql).not.toMatch(/^\s*(DROP|UPDATE|DELETE|TRUNCATE)\b|SET NOT NULL|\bDEFAULT\b/im);
    const boot = src("database_supabase.ts");
    expect(boot).toContain('alter table "Bills" add column if not exists customer_address text;');
  });

  test("says what it is (NOT money) and keeps the runtime role's grant", () => {
    if (!existsSync(file)) { return; }
    const sql = code();
    expect(sql).toMatch(/COMMENT ON COLUMN "Bills"\.customer_address IS/);
    expect(sql).toMatch(/NOT money/);
    expect(sql).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'\)/);
  });
});
