// initPrintRoutingSchema, PROBE FIRST — integration review of 2.0.2
// (kot-reports-email).
//
// Every boot ran nine `ALTER TABLE "PrintJobs" ADD COLUMN IF NOT EXISTS`
// statements (migration 042's columns) with no lock timeout, and ADD COLUMN IF
// NOT EXISTS takes ACCESS EXCLUSIVE before it looks. One session still holding
// any lock on "PrintJobs" — a settle on the container being replaced — hung the
// boot indefinitely (a local PG17 run was killed at 120 s), ahead of every
// 2.0.2 step deliberately limited to 2 s and ahead of the listener. Production
// has all nine, so the step must ASK and do nothing:
//
//   * the list it asks about is migration 042's, name and definition;
//   * with all nine present it issues NO ALTER and marks the memo;
//   * with some missing it adds ONLY those, in one statement, under a 2 s LOCAL
//     lock timeout, each guarded by the catalogue;
//   * a lock timeout does not fail the boot, and the `limit 0` probe still sets
//     the latch.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Fake {
  sql: string[];
  columns: string[];
  /** Make the DO block fail as a lock timeout would. */
  lockTimeout: boolean;
  /** Does the `limit 0` probe find assigned_device_id? */
  probeOk: boolean;
}
const fake: Fake = { sql: [], columns: [], lockTimeout: false, probeOk: true };

jest.mock("pg", () => {
  const g = globalThis as unknown as { __printRoutingBootFake: Fake };
  const query = async (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const f = g.__printRoutingBootFake;
    const q = String(sql).replace(/\s+/g, " ").trim();
    f.sql.push(q);
    if (/^select column_name from information_schema\.columns where table_schema = 'public' and table_name = 'PrintJobs' and column_name = any\(\$1::text\[\]\)/i.test(q)) {
      const asked = (params?.[0] as string[]) ?? [];
      return { rows: f.columns.filter((c) => asked.includes(c)).map((c) => ({ column_name: c })) };
    }
    if (/^do \$\$/i.test(q)) {
      if (f.lockTimeout) {
        throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
      }
      for (const m of q.matchAll(/alter table "PrintJobs" add column if not exists (\w+)/gi)) { f.columns.push(m[1]); }
      return { rows: [] };
    }
    if (/^select assigned_device_id from "PrintJobs" limit 0/i.test(q)) {
      if (!f.probeOk) { throw Object.assign(new Error("column \"assigned_device_id\" does not exist"), { code: "42703" }); }
      return { rows: [] };
    }
    return { rows: [] };
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]) { return query(sql, params); }
    connect() { return Promise.resolve({ query, release: () => undefined }); }
    end() { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});
jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: jest.fn(), emitOutlet: jest.fn() }));

(globalThis as unknown as { __printRoutingBootFake: Fake }).__printRoutingBootFake = fake;

let db: typeof import("../database_supabase");
const NINE = [
  "assigned_device_id", "assigned_target", "destination_id", "assign_expires_at", "assign_generation",
  "assign_accepted_at", "failed_devices", "printed_by_device", "broadcast_at",
];
const alters = (): string[] => fake.sql.filter((q) => /alter table/i.test(q));

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
});

beforeEach(() => {
  fake.sql = [];
  fake.columns = [];
  fake.lockTimeout = false;
  fake.probeOk = true;
  db.__poolHygieneTestSeam.resetDdlMemo();
});

describe("the list is migration 042's", () => {
  test("the nine columns, name and definition, in the file's order", () => {
    const file = readFileSync(join(__dirname, "..", "migrations", "042_print_routing.sql"), "utf8");
    const inFile = [...file.matchAll(/^ALTER TABLE "PrintJobs" ADD COLUMN IF NOT EXISTS (\w+)\s+([^;]+);/gim)]
      .map((m) => [m[1], m[2].trim().toLowerCase()]);
    expect(inFile).toEqual(db.PRINT_ROUTING_COLUMN_DDL.map(([n, d]) => [n, d.toLowerCase()]));
    expect(db.PRINT_ROUTING_COLUMN_DDL.map(([n]) => n)).toEqual(NINE);
  });
});

describe("ensurePrintRoutingColumns asks first", () => {
  test("all nine present (production): NO ALTER and no DO block — one catalogue read — and the memo is set", async () => {
    fake.columns = [...NINE];
    await db.ensurePrintRoutingColumns();
    expect(alters()).toEqual([]);
    expect(fake.sql.filter((q) => /^do \$\$/i.test(q))).toEqual([]);
    expect(fake.sql.filter((q) => /information_schema\.columns/i.test(q))).toHaveLength(1);
    fake.sql = [];
    await db.ensurePrintRoutingColumns();
    expect(fake.sql).toEqual([]);
  });

  test("two missing: ONE statement, a 2s LOCAL lock timeout first, adding only those two, each guarded", async () => {
    fake.columns = NINE.filter((c) => c !== "assign_generation" && c !== "broadcast_at");
    await db.ensurePrintRoutingColumns();
    const blocks = fake.sql.filter((q) => /^do \$\$/i.test(q));
    expect(blocks).toHaveLength(1);
    const block = blocks[0]!;
    expect(block).toMatch(/^do \$\$ begin perform set_config\('lock_timeout', '2s', true\);/i);
    expect([...block.matchAll(/add column if not exists (\w+) ([^;]+);/gi)].map((m) => [m[1], m[2]])).toEqual([
      ["assign_generation", "smallint not null default 0"],
      ["broadcast_at", "timestamptz"],
    ]);
    expect(block.match(/if not exists \(select 1 from information_schema\.columns/gi)).toHaveLength(2);
    // Nothing outside the block alters the table.
    expect(alters().filter((q) => !/^do \$\$/i.test(q))).toEqual([]);
  });

  test("none present (a fresh box that owns the table): all nine, in one guarded statement", async () => {
    await db.ensurePrintRoutingColumns();
    const block = fake.sql.find((q) => /^do \$\$/i.test(q))!;
    expect([...block.matchAll(/add column if not exists (\w+)/gi)].map((m) => m[1])).toEqual(NINE);
    expect(fake.columns).toEqual(NINE);
  });

  test("a lock timeout throws (the memo stays unset, so a later boot tries again)", async () => {
    fake.columns = NINE.slice(1);
    fake.lockTimeout = true;
    await expect(db.ensurePrintRoutingColumns()).rejects.toMatchObject({ code: "55P03" });
    fake.lockTimeout = false;
    fake.sql = [];
    await db.ensurePrintRoutingColumns();
    expect(fake.sql.some((q) => /^do \$\$/i.test(q))).toBe(true);
  });
});

describe("initPrintRoutingSchema (the boot step)", () => {
  test("production: no ALTER, and the latch is ON by the probe", async () => {
    fake.columns = [...NINE];
    await expect(db.initPrintRoutingSchema()).resolves.toBe(true);
    expect(alters()).toEqual([]);
    expect(db.isPrintRoutingSchemaReady()).toBe(true);
  });

  test("a lock timeout on a box that needed a column never fails the boot; the probe decides", async () => {
    fake.columns = NINE.slice(1);
    fake.lockTimeout = true;
    fake.probeOk = false;
    await expect(db.initPrintRoutingSchema()).resolves.toBe(false);
    expect(db.isPrintRoutingSchemaReady()).toBe(false);
  });

  test("the boot still calls it unconditionally, before the listener", () => {
    const index = readFileSync(join(__dirname, "..", "index.ts"), "utf8");
    const at = index.indexOf("initPrintRoutingSchema()");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(index.indexOf("httpServer.listen("));
  });
});
