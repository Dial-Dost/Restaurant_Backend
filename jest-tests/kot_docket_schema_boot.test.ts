// MIGRATION 050's COLUMNS AT BOOT, AND NEVER INSIDE A REQUEST'S TRANSACTION.
//
// "Restaurant".kot_print_style is the owner's escape hatch from a kitchen
// printer that answers the raster docket with blank paper, and kot_text_size
// sits beside it. Until this step they were made only by ensureBrandingColumns
// — at boot only when REPORT_SCHEDULER is set (production does not set it), so
// in practice by the first request of the process that touched settings, and
// that request could be inside a transaction: the 30-minute exception sweep, a
// guest pre-order confirm, a seating's OTP check. A DDL there rolls back with
// its transaction while the in-process flag goes on saying it happened, and
// the Classic-docket save then fails with 42703 until a restart.
//
// Pinned here, against the real functions over a recording Pool:
//   * InitKotDocketSchema issues NOTHING when both columns exist (an ADD COLUMN
//     takes ACCESS EXCLUSIVE on "Restaurant" even when it has nothing to do);
//   * when one is missing it issues ONE autocommit statement that sets a LOCAL
//     2s lock_timeout before either ALTER, and each ALTER only if its column
//     is still missing;
//   * it never throws, and says false when the columns are still not there;
//   * index.ts runs it before the server listens;
//   * ensureBrandingColumns issues no DDL inside a transaction and does not
//     remember having run there — the next autocommit caller does the work.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RES = "11111111-1111-4111-8111-111111111111";
const OUTLET = "22222222-2222-4222-8222-222222222222";

/** The two columns, as the catalogue sees them. */
const mockDb: {
  columns: Set<string>;
  /** Makes the DO block fail as Postgres would (a lock timeout, a refused ALTER). */
  ddlError: (Error & { code?: string }) | null;
  /** False models a DO block that "succeeded" without the columns appearing. */
  ddlAdds: boolean;
} = { columns: new Set(), ddlError: null, ddlAdds: true };

interface Statement { sql: string; on: "pool" | "transaction" }
const mockStatements: Statement[] = [];

jest.mock("pg", () => {
  const flat = (sql: string) => String(sql).replace(/\s+/g, " ").trim();
  const answer = (sql: string): unknown[] => {
    const q = flat(sql);
    if (/^(begin|commit|rollback)$/i.test(q) || /^select set_config\(/i.test(q)) {return [];}
    if (/^do \$\$/i.test(q)) {
      if (mockDb.ddlError) {throw mockDb.ddlError;}
      if (mockDb.ddlAdds) {
        mockDb.columns.add("kot_print_style");
        mockDb.columns.add("kot_text_size");
      }
      return [];
    }
    if (q.startsWith("select count(*)::int as n from information_schema.columns") && q.includes("table_name = 'Restaurant'")) {
      return [{ n: ["kot_print_style", "kot_text_size"].filter((c) => mockDb.columns.has(c)).length }];
    }
    if (/^alter table "Restaurant" add column if not exists /i.test(q)) {
      const col = /add column if not exists (\w+)/i.exec(q)?.[1] ?? "";
      mockDb.columns.add(col);
      return [];
    }
    if (q.includes('from "Restaurant" r')) {
      return [{
        res_id: RES, outlet_id: OUTLET, restaurant_slug: "fixture", restaurant_name: "Fixture Diner",
        restaurant_main_office_add: null, restaurant_logo_url: null, timezone: "Asia/Kolkata",
      }];
    }
    if (/^select auto_push_orders,/i.test(q)) {return [{ currency: "₹", bill_paper_width: "80mm" }];}
    if (q.includes('select default_tax from "Outlets"')) {return [{ default_tax: null }];}
    if (q.startsWith("select kot_print_style from")) {return [{ kot_print_style: null }];}
    if (q.startsWith("select kot_text_size from")) {return [{ kot_text_size: null }];}
    throw new Error(`kot docket boot fixture: no answer for: ${q.slice(0, 140)}`);
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

type Db = typeof import("../database_supabase");
let db: Db;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
});

beforeEach(() => {
  mockDb.columns = new Set();
  mockDb.ddlError = null;
  mockDb.ddlAdds = true;
  mockStatements.length = 0;
});

const ddl = () => mockStatements.filter((s) => /^(alter|do|create)\b/i.test(s.sql));

describe("InitKotDocketSchema — migration 050 at boot", () => {
  test("both columns there: no DDL at all, and it says ready", async () => {
    mockDb.columns = new Set(["kot_print_style", "kot_text_size"]);
    await expect(db.InitKotDocketSchema()).resolves.toBe(true);
    expect(ddl()).toEqual([]);
  });

  test("a column missing: ONE autocommit statement — the lock timeout first, then each ALTER only while its column is missing", async () => {
    mockDb.columns = new Set(["kot_print_style"]);
    await expect(db.InitKotDocketSchema()).resolves.toBe(true);
    const issued = ddl();
    expect(issued).toHaveLength(1);
    const [block] = issued;
    expect(block!.on).toBe("pool");
    const sql = block!.sql;
    const timeout = sql.indexOf("perform set_config('lock_timeout', '2s', true);");
    const style = sql.indexOf('alter table "Restaurant" add column if not exists kot_print_style text;');
    const size = sql.indexOf('alter table "Restaurant" add column if not exists kot_text_size text;');
    expect(timeout).toBeGreaterThan(-1);
    expect(style).toBeGreaterThan(timeout);
    // The style first — it is the escape hatch — as in ensureBrandingColumns and the file.
    expect(size).toBeGreaterThan(style);
    for (const column of ["kot_print_style", "kot_text_size"]) {
      expect(sql).toContain(`if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'Restaurant' and column_name = '${column}') then alter table`);
    }
  });

  test("a lock timeout never takes boot down: false, and the lazy ensure is left to retry", async () => {
    mockDb.ddlError = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
    await expect(db.InitKotDocketSchema()).resolves.toBe(false);
  });

  test("an ALTER that left no column (a runtime without DDL rights) is false, not a quiet ✅", async () => {
    mockDb.ddlAdds = false;
    await expect(db.InitKotDocketSchema()).resolves.toBe(false);
  });

  test("index.ts runs it before the server listens, beside the other 2.0.1 boot steps", () => {
    const index = readFileSync(join(__dirname, "..", "index.ts"), "utf8");
    const boot = index.indexOf("if (await InitKotDocketSchema()) {");
    expect(boot).toBeGreaterThan(index.indexOf("if (await InitTableNextPartySchema()) {"));
    expect(boot).toBeLessThan(index.indexOf("httpServer.listen("));
    expect(index).toMatch(/import \{[^}]*\bInitKotDocketSchema\b[^}]*\} from "\.\/database_supabase\.js";/);
  });
});

describe("migration 050 (when present on this branch), applied by hand during service", () => {
  const file = join(__dirname, "..", "migrations", "050_kot_print_style.sql");
  const code = (): string => readFileSync(file, "utf8").split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("--")).join("\n").trim();

  test("waits at most 5s for its locks on \"Restaurant\" — the first thing it does", () => {
    if (!existsSync(file)) { return; } // shipped in its own commit, applied by hand
    expect(code().startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true);
  });

  test("adds the same two columns, in the same order, as the boot step", () => {
    if (!existsSync(file)) { return; }
    const src = readFileSync(join(__dirname, "..", "database_supabase.ts"), "utf8").replace(/\r\n/g, "\n");
    const at = src.indexOf("export async function InitKotDocketSchema(");
    const boot = src.slice(at, src.indexOf("\n}\n", at));
    const alters = (s: string) => [...s.matchAll(/alter table "Restaurant" add column if not exists \w+ text/gi)].map((m) => m[0].toLowerCase());
    expect(alters(boot)).toEqual([
      'alter table "restaurant" add column if not exists kot_print_style text',
      'alter table "restaurant" add column if not exists kot_text_size text',
    ]);
    expect(alters(code())).toEqual(alters(boot));
  });
});

describe("ensureBrandingColumns never issues DDL inside a transaction", () => {
  test("inside one it skips — and does not remember having run — so the next autocommit caller does the work, once", async () => {
    mockDb.columns = new Set(["kot_print_style", "kot_text_size"]);
    const ctx = { res_id: RES, outlet_id: OUTLET, employeeId: "", role: "" };
    await db.withTenant(ctx, () => db.GetRestaurantSettings(RES));
    const inside = mockStatements.filter((s) => s.on === "transaction");
    expect(inside.some((s) => /^select auto_push_orders,/.test(s.sql))).toBe(true);
    expect(ddl()).toEqual([]);

    await db.GetRestaurantSettings(RES);
    const alters = ddl();
    expect(alters.length).toBeGreaterThan(0);
    expect(alters.every((s) => s.on === "pool")).toBe(true);
    expect(alters.map((s) => s.sql)).toContain('alter table "Restaurant" add column if not exists kot_print_style text');

    mockStatements.length = 0;
    await db.GetRestaurantSettings(RES);
    expect(ddl()).toEqual([]);
  });
});
