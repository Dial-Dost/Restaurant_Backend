// WarmReportingSchema, PROBE FIRST (client item 9: before the scheduler may be
// switched on).
//
// The boot step exists so the sweep never triggers lazy DDL inside a request
// transaction. As shipped it issued ~17 `ALTER TABLE "Bills"` and ~40 `ALTER
// TABLE "Restaurant"` ADD COLUMN IF NOT EXISTS statements on every boot, with
// no lock timeout — and ADD COLUMN IF NOT EXISTS takes ACCESS EXCLUSIVE before
// it looks. On the two tables every request reads first, that is the shape of
// the 2026-08-24 convoy. Production has every one of those columns, so the step
// must ASK and do nothing:
//
//   * the column lists it asks about are held to the ensure functions, so the
//     probe can never check a different list from the one the lazy path makes;
//   * with every column present it issues NO ALTER, and the lazy helpers are
//     marked done (a later settle issues none either);
//   * with one missing it adds ONLY that one, under a 2s LOCAL lock timeout.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Fake {
  sql: string[];
  columns: Record<string, string[]>;
  tablesWarm: boolean;
}
const fake: Fake = { sql: [], columns: {}, tablesWarm: true };

jest.mock("pg", () => {
  const g = globalThis as unknown as { __warmFake: Fake };
  const query = async (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const f = g.__warmFake;
    const q = String(sql).replace(/\s+/g, " ").trim();
    f.sql.push(q);
    if (/^select column_name from information_schema\.columns where table_schema = 'public' and table_name = \$1/i.test(q)) {
      return { rows: (f.columns[String(params?.[0])] ?? []).map((c) => ({ column_name: c })) };
    }
    if (/relrowsecurity and relforcerowsecurity\) and/i.test(q)) {
      return { rows: [{ ok: f.tablesWarm }] };
    }
    if (/^do \$\$/i.test(q)) {
      // Apply what the block adds, so the re-probe sees it.
      for (const m of q.matchAll(/alter table "(\w+)" add column if not exists (\w+)/gi)) {
        (f.columns[m[1]] ??= []).push(m[2]);
      }
      return { rows: [] };
    }
    if (/from "Restaurant" r/i.test(q)) {
      return { rows: [{ res_id: "11111111-1111-4111-8111-111111111111", outlet_id: "22222222-2222-4222-8222-222222222222", restaurant_slug: "x", restaurant_name: "X", restaurant_main_office_add: null, restaurant_logo_url: null, timezone: "Asia/Kolkata" }] };
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

(globalThis as unknown as { __warmFake: Fake }).__warmFake = fake;

let db: typeof import("../database_supabase");
const SRC = readFileSync(join(__dirname, "..", "database_supabase.ts"), "utf8").replace(/\r\n/g, "\n");

function fnBody(name: string): string {
  const start = SRC.indexOf(`async function ${name}(`);
  if (start < 0) {throw new Error(`no function ${name}`);}
  const next = SRC.indexOf("\nasync function ", start + 10);
  const nextExport = SRC.indexOf("\nexport ", start + 10);
  const end = Math.min(...[next, nextExport].filter((i) => i > 0));
  return SRC.slice(start, end);
}

const addedIn = (body: string): [string, string][] =>
  [...body.matchAll(/add column if not exists (\w+) ([^`]+?)\s*`/gi)].map((m) => [m[1], m[2].trim()]);

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
});

beforeEach(() => {
  fake.sql = [];
  fake.tablesWarm = true;
  db.__poolHygieneTestSeam.resetDdlMemo();
});

describe("the lists the probe asks about ARE the ensure functions' lists", () => {
  test("Bills: ensureBillRoundOffColumn + ensureBillWorkflowColumns, name and definition, in order", () => {
    const listed = [...addedIn(fnBody("ensureBillRoundOffColumn")), ...addedIn(fnBody("ensureBillWorkflowColumns"))];
    expect(listed.map(([n, d]) => [n, d.replace(/\s+/g, " ")])).toEqual(db.BILL_WORKFLOW_COLUMN_DDL.map(([n, d]) => [n, d]));
    expect(listed).toHaveLength(18);
  });

  test("Restaurant: ensureBrandingColumns, name and definition, in order", () => {
    const listed = addedIn(fnBody("ensureBrandingColumns"));
    expect(listed).toEqual(db.RESTAURANT_BRANDING_COLUMN_DDL.map(([n, d]) => [n, d]));
    expect(listed.length).toBeGreaterThan(40);
  });
});

describe("WarmReportingSchema asks first", () => {
  const all = () => ({
    Bills: db.BILL_WORKFLOW_COLUMN_DDL.map(([n]) => n),
    Restaurant: db.RESTAURANT_BRANDING_COLUMN_DDL.map(([n]) => n),
  });

  test("every column present: NO ALTER at all, no CREATE, no RLS statement", async () => {
    fake.columns = all();
    await db.WarmReportingSchema();
    const ddl = fake.sql.filter((q) => /^(alter|create|do)\b/i.test(q));
    expect(ddl).toEqual([]);
    expect(fake.sql.filter((q) => /information_schema\.columns/i.test(q))).toHaveLength(2);
  });

  test("…and the lazy helpers are then done: a settled-bill read issues no DDL", async () => {
    fake.columns = all();
    await db.WarmReportingSchema();
    fake.sql = [];
    await db.GetSalesReport("11111111-1111-4111-8111-111111111111", "2026-09-01", "2026-09-01");
    expect(fake.sql.filter((q) => /^alter table "Bills"/i.test(q))).toEqual([]);
  });

  test("one column missing: ONE block, only that column, under a 2s LOCAL lock timeout", async () => {
    const cols = all();
    cols.Bills = cols.Bills.filter((c) => c !== "payment_splits");
    cols.Restaurant = cols.Restaurant.filter((c) => c !== "kot_text_size");
    fake.columns = cols;
    await db.WarmReportingSchema();
    const blocks = fake.sql.filter((q) => /^do \$\$/i.test(q));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("perform set_config('lock_timeout', '2s', true);");
    expect([...blocks[0].matchAll(/alter table/gi)]).toHaveLength(1);
    expect(blocks[0]).toContain('alter table "Bills" add column if not exists payment_splits jsonb;');
    expect(blocks[1]).toContain('alter table "Restaurant" add column if not exists kot_text_size text;');
    expect(fake.sql.filter((q) => /^alter table/i.test(q))).toEqual([]);
  });

  test("the lazy tables: warm (RLS forced) is only asked about; cold runs their ensure", async () => {
    fake.columns = all();
    fake.tablesWarm = false;
    await db.WarmReportingSchema();
    expect(fake.sql.some((q) => /create table if not exists "Expenses"/i.test(q))).toBe(true);
    expect(fake.sql.some((q) => /create table if not exists "Notifications"/i.test(q))).toBe(true);
  });
});

describe("the boot switch", () => {
  const index = readFileSync(join(__dirname, "..", "index.ts"), "utf8").replace(/\r\n/g, "\n");
  test("WARM_REPORTING_SCHEMA is its own switch, and unset it follows the sweep as before", () => {
    expect(index).toContain('const warm = process.env.WARM_REPORTING_SCHEMA === "true"\n\t\t|| (process.env.WARM_REPORTING_SCHEMA !== "false" && process.env.REPORT_SCHEDULER === "true");');
    expect(index).toContain("if (warm) {\n\t\ttry {\n\t\t\tawait WarmReportingSchema();");
  });
});
