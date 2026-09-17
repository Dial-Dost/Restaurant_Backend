// MIGRATION 055 AND THE PRINTED TABLE ON THE FLOOR — client items 1 and 2.
//
// Through the SHIPPED data layer over the in-memory floor in
// next_party_fixtures.ts (which throws 42703 on any statement naming 055's
// columns when they are absent, exactly as Postgres would):
//
//   1. THE FILE says what the runtime issues, with the lock timeout first.
//   2. WHAT A PRINT SAID is filed against its job and read back by both
//      payloads: GetBillForTable (the digest, the printed total, the printed-as
//      name) and GetTables (paper_stale from the lines, printed_as).
//   3. 055 ABSENT: every print still counts, nothing is written or read, every
//      paper is unknown — exactly 2.0.1.
//   4. MOVING A PRINTED PARTY: the destination is printed (and says under which
//      name), the source frees and its idle seat retires, the destination gets
//      its own next-party seat, and a move into the same family is refused.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SLUG,
  addOrder,
  addPrint,
  addTable,
  liveSiblingsOf,
  liveTable,
  printJobs,
  resetStore,
  seat,
  setPaperColumnsPresent,
  statements,
  tick,
} from "./next_party_fixtures";
import { billLinesDigest } from "../bill_paper_digest";

jest.mock("pg", () => {
  interface Fx {
    connect: () => unknown;
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  }
  const fx = (): Fx => {
    const f = (globalThis as unknown as { __nextPartyFixture?: Fx }).__nextPartyFixture;
    if (!f) {throw new Error("next party fixture was not loaded");}
    return f;
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]) { return fx().query(sql, params); }
    connect() { return Promise.resolve(fx().connect()); }
    end() { return Promise.resolve(); }
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
  resetStore();
  db.resetTableNextPartyCache();
  db.resetPrintJobPaperCache();
});

const PRINTED_AT = Date.parse("2026-09-16T08:04:00.000Z");

/** 12 seated with four, ₹1,000 ordered, printed under the fallback id; 20 free. */
function printedTwelve(): { jobId: string } {
  addTable({ table_name: "12", capacity: 4 });
  addTable({ table_name: "20", capacity: 6 });
  seat("12", 4);
  addOrder("12", 1000);
  tick(4);
  const job = addPrint(`12-${String(PRINTED_AT)}`);
  return { jobId: job.id! };
}

const PAPER = (lines: string) => ({ bill_digest: "b".repeat(64), lines_digest: lines, bill_grand_total: 1050, table_name: "12" });
const rowOf = async (name: string) => (await db.GetTables(SLUG))?.find((r) => r.table_name === name);

// ===========================================================================
describe("1. the migration file is the runtime's DDL", () => {
  const file = readFileSync(join(__dirname, "..", "migrations", "055_print_job_paper_digest.sql"), "utf8");
  const code = file.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const flat = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

  test("every statement the runtime issues is in the file, in order, and nothing else alters a table", () => {
    let from = 0;
    for (const sql of db.PRINT_JOB_PAPER_DDL) {
      const at = flat(code).indexOf(flat(sql), from);
      expect({ sql, found: at > -1 }).toEqual({ sql, found: true });
      from = at;
    }
    expect(flat(code).match(/alter table/g)).toHaveLength(db.PRINT_JOB_PAPER_DDL.length);
  });

  test("the lock timeout is the file's FIRST statement, and every column is nullable with no default", () => {
    const first = code.split(";").map((s) => s.trim()).find((s) => s.length > 0);
    expect(first).toBe("SET LOCAL lock_timeout = '5s'");
    expect(flat(code)).not.toMatch(/not null|default /);
    for (const sql of db.PRINT_JOB_PAPER_DDL) {expect(sql).toMatch(/add column if not exists/);}
  });

  test("it is idempotent: every ALTER says IF NOT EXISTS, and the grant is guarded", () => {
    expect(code).not.toMatch(/ADD COLUMN (?!IF NOT EXISTS)/);
    expect(code).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'\)/);
  });
});

// ===========================================================================
describe("2. what a print said, filed and read back", () => {
  test("RecordBillPrintPaper writes the four columns on THAT job, and the bill read returns them", async () => {
    const { jobId } = printedTwelve();
    const lines = billLinesDigest([{ name: "Dish on 12", price: 1000, quantity: 1 }]);
    await expect(db.RecordBillPrintPaper(SLUG, [jobId], PAPER(lines))).resolves.toBe(true);
    expect(printJobs().find((j) => j.id === jobId)).toMatchObject({ bill_digest: "b".repeat(64), lines_digest: lines, bill_grand_total: 1050, table_name: "12" });

    const bill = await db.GetBillForTable(SLUG, "12");
    expect(bill).toMatchObject({ print_count: 1, last_paper_digest: "b".repeat(64), printed_total: 1050, printed_as: null });
  });

  test("the floor tile: paper current -> false; a dish added after the print -> true; nothing printed -> null", async () => {
    const { jobId } = printedTwelve();
    const lines = billLinesDigest([{ name: "Dish on 12", price: 1000, quantity: 1 }]);
    await db.RecordBillPrintPaper(SLUG, [jobId], PAPER(lines));
    expect(await rowOf("12")).toMatchObject({ print_count: 1, paper_stale: false, printed_as: null });
    expect(await rowOf("20")).toMatchObject({ print_count: 0, paper_stale: null, printed_as: null });

    tick(10);
    addOrder("12", 200);
    expect(await rowOf("12")).toMatchObject({ print_count: 1, paper_stale: true });
    // The bill read agrees the paper is short: its digest is still the print's,
    // and the printed total is the old one.
    expect(await db.GetBillForTable(SLUG, "12")).toMatchObject({ printed_total: 1050, grand_total: 1260 });
  });

  test("the NEWEST print decides: an updated print that recorded its paper makes the tile current again", async () => {
    const { jobId } = printedTwelve();
    await db.RecordBillPrintPaper(SLUG, [jobId], PAPER(billLinesDigest([{ name: "Dish on 12", price: 1000, quantity: 1 }])));
    tick(10);
    addOrder("12", 200);
    tick(1);
    const updated = addPrint(`12-${String(PRINTED_AT + 11 * 60_000)}`);
    await db.RecordBillPrintPaper(SLUG, [updated.id!], {
      ...PAPER(billLinesDigest([{ name: "Dish on 12", price: 1000, quantity: 1 }, { name: "Dish on 12", price: 200, quantity: 1 }])),
      bill_grand_total: 1260,
    });
    expect(await rowOf("12")).toMatchObject({ print_count: 2, paper_stale: false });
    expect(await db.GetBillForTable(SLUG, "12")).toMatchObject({ print_count: 2, printed_total: 1260 });
  });

  test("a print whose content was never recorded is UNKNOWN on the tile, not 'current'", async () => {
    printedTwelve();
    expect(await rowOf("12")).toMatchObject({ print_count: 1, paper_stale: null });
    expect(await db.GetBillForTable(SLUG, "12")).toMatchObject({ last_paper_digest: null, printed_total: null });
  });

  test("no job id, or no uuid, writes nothing", async () => {
    printedTwelve();
    await expect(db.RecordBillPrintPaper(SLUG, [null, undefined, "", "job-1"], PAPER("l"))).resolves.toBe(false);
    expect(statements().filter((q) => q.includes("set bill_digest"))).toEqual([]);
  });
});

// ===========================================================================
describe("3. migration 055 absent — exactly 2.0.1", () => {
  beforeEach(() => { setPaperColumnsPresent(false); });

  test("prints still COUNT (a waiter keeps no extra print), and nothing names a 055 column", async () => {
    const { jobId } = printedTwelve();
    await expect(db.InitPrintJobPaperSchema()).resolves.toBe(false);
    await expect(db.RecordBillPrintPaper(SLUG, [jobId], PAPER("l"))).resolves.toBe(false);
    expect(await db.GetBillForTable(SLUG, "12")).toMatchObject({ print_count: 1, last_paper_digest: null, printed_total: null });
    expect(await rowOf("12")).toMatchObject({ print_count: 1, paper_stale: null, printed_as: null });
    const named = statements().filter((q) => !/^(alter|create|do|comment|grant)\b/.test(q)
      && !q.includes("information_schema") && /bill_digest|lines_digest|bill_grand_total/.test(q));
    expect(named).toEqual([]);
  });

  test("a later hand-apply is picked up within a minute", async () => {
    const { jobId } = printedTwelve();
    await db.InitPrintJobPaperSchema();
    setPaperColumnsPresent(true);
    await expect(db.RecordBillPrintPaper(SLUG, [jobId], PAPER("l"))).resolves.toBe(false); // still in the window
    db.resetPrintJobPaperCache(); // the minute has passed
    await expect(db.RecordBillPrintPaper(SLUG, [jobId], PAPER("l"))).resolves.toBe(true);
  });

  test("a stale 'present' that answers 42703 falls back to the pre-055 read — never to 'nothing printed'", async () => {
    printedTwelve();
    setPaperColumnsPresent(true);
    await db.InitPrintJobPaperSchema(); // latch: present
    setPaperColumnsPresent(false); // ...and then the columns are gone
    expect(await db.GetBillForTable(SLUG, "12")).toMatchObject({ print_count: 1, last_paper_digest: null });
    expect(await rowOf("12")).toMatchObject({ print_count: 1 });
  });
});

// ===========================================================================
describe("4. moving a printed party", () => {
  test("12 -> 20: 20 is printed AS 12, its paper still current; 12 frees and its idle seat retires; 20 gets its own seat", async () => {
    const { jobId } = printedTwelve();
    await db.RecordBillPrintPaper(SLUG, [jobId], PAPER(billLinesDigest([{ name: "Dish on 12", price: 1000, quantity: 1 }])));
    expect(await db.EnsureNextPartyTable(SLUG, "12")).toMatchObject({ table_name: "12 #2", created: true });

    const out = await db.MoveTableParty(SLUG, "12", "20");
    expect(out).toMatchObject({ to_table: "20", printed: true, printed_as: "12", moved_prints: 1 });
    expect(printJobs().map((j) => j.bill_id)).toEqual([`20-${String(PRINTED_AT)}`]);
    // 12 is free, so its idle "12 #2" is no longer needed.
    expect(liveSiblingsOf("12")).toEqual([]);
    // The route then opens 20's green seat (nextPartyAfterPrint -> this).
    expect(await db.EnsureNextPartyTable(SLUG, "20")).toMatchObject({ table_name: "20 #2", parent_table: "20", created: true });

    expect(await rowOf("20")).toMatchObject({ print_count: 1, printed_as: "12", paper_stale: false, occupied: true });
    expect(await rowOf("20 #2")).toMatchObject({ parent_table: "20", display_name: "20", occupied: false, print_count: 0 });
    expect(await rowOf("12")).toMatchObject({ print_count: 0, occupied: false });
    // The order and its printed name follow the party.
    expect((await db.GetBillForTable(SLUG, "20"))).toMatchObject({ print_count: 1, printed_as: "12", subtotal: 1000 });
  });

  test("a move into the table's OWN family is refused in words, and nothing moves", async () => {
    printedTwelve();
    await db.EnsureNextPartyTable(SLUG, "12");
    const before = printJobs();
    await expect(db.MoveTableParty(SLUG, "12", "12 #2"))
      .rejects.toThrow("12 (next party) is the same table as 12 — pick a different table to move to.");
    expect(liveTable("12").is_occupied).toBe(true);
    expect(liveTable("12 #2").is_occupied).toBe(false);
    expect(printJobs()).toEqual(before);
  });

  test("…and the other way round, the next party onto its own root", async () => {
    addTable({ table_name: "12", capacity: 4 });
    seat("12", 2);
    addOrder("12", 500);
    addPrint(`12-${String(PRINTED_AT)}`);
    await db.EnsureNextPartyTable(SLUG, "12");
    seat("12 #2", 2);
    await expect(db.MoveTableParty(SLUG, "12 #2", "12")).rejects.toThrow("12 is the same table as 12 (next party)");
  });

  test("another family's free seat is a real destination (the party becomes that family's printed member)", async () => {
    printedTwelve();
    addTable({ table_name: "15", capacity: 4 });
    seat("15", 2);
    addOrder("15", 300);
    addPrint(`15-${String(PRINTED_AT)}`);
    await db.EnsureNextPartyTable(SLUG, "15"); // "15 #2", free
    const out = await db.MoveTableParty(SLUG, "12", "15 #2");
    expect(out).toMatchObject({ to_table: "15 #2", printed: true });
    expect(printJobs().map((j) => j.bill_id).sort()).toEqual([`15 #2-${String(PRINTED_AT)}`, `15-${String(PRINTED_AT)}`]);
    // 15's family is now fully busy: its next party would get "15 #3".
    expect(await db.EnsureNextPartyTable(SLUG, "15 #2")).toMatchObject({ table_name: "15 #3", created: true });
  });
});
