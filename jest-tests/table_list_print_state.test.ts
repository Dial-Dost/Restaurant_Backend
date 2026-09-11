// A CLIENT READ WITH NO SERVER FIELD BEHIND IT — the fourth time in this
// project, and the reason this suite exists rather than a comment.
//
// ============================================================================
// WHAT WENT WRONG
// ============================================================================
// C3 says a waiter prints a bill once and the table then clears from their view.
// GET /bill-for-table answers "has it been printed" with three fields —
// `print_count`, `bill_printed_at`, `printed_at`. The Flutter FLOOR GRID asks the
// same question of a DIFFERENT payload, the `/get-tables` row it renders, and
// that payload carried none of them. So the grid's read came back empty on every
// table, every time, and it fell through to a per-DEVICE memory that survives
// neither a reinstall nor a second tablet. One restaurant, a different answer per
// device — which is the exact defect C3 was written to end.
//
// Nothing failed. Nothing logged. The feature simply meant nothing, which is why
// the rule now is: IF YOUR LANE ADDS A FIELD, ADD THE TEST THAT FAILS WHEN
// NOBODY SENDS IT.
//
// ============================================================================
// WHAT THIS SUITE PINS
// ============================================================================
//   1. The rule itself (bill_print_state.ts) — which jobs count, which seating
//      they belong to, and the three field names, which ARE the client contract.
//   2. THE SHIPPED GetTables really emits all three on every row, driven over a
//      fake Pool. Delete the three lines from the projection and this fails.
//   3. Both payloads spell them the same way, asserted against the source, so
//      /bill-for-table cannot drift to `last_printed_at` while the grid reads
//      `printed_at`.
//   4. It fails SAFE and never takes the floor plan down: no "PrintJobs" table,
//      or a read that throws, degrades to "not printed" rather than to a 500.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COUNTED_PRINT_JOB_STATUSES,
  NO_BILL_PRINTS,
  billPrintFallbackPrefix,
  billPrintJobBelongsToSeating,
  summarizeBillPrints,
} from "../bill_print_state";

const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";
const T7 = "33333333-3333-3333-3333-333333333333";
const T8 = "44444444-4444-4444-4444-444444444444";
const BILL_T7 = "55555555-5555-5555-5555-555555555555";

const SEATED_AT = "2026-09-11T12:00:00.000Z";
const PRINT_1 = "2026-09-11T13:40:00.000Z";
const PRINT_2 = "2026-09-11T13:55:00.000Z";
const LAST_PARTY = "2026-09-11T09:10:00.000Z";

interface Fixture {
  tables: { id: string; table_name: string }[];
  bills: { id: string; table_id: string; created_at: string }[];
  orders: { table_id: string; food: unknown; created_at: string }[];
  printJobs: { bill_id: string; created_at: string }[];
  /** Make the "PrintJobs" read blow up, as an unmigrated deployment does. */
  printJobsThrow: null | Error;
  sql: string[];
}
const fx: Fixture = { tables: [], bills: [], orders: [], printJobs: [], printJobsThrow: null, sql: [] };

jest.mock("pg", () => {
  const query = async (sql: string): Promise<{ rows: unknown[] }> => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    fx.sql.push(q);
    if (/from "Restaurant" r/i.test(q)) {
      return { rows: [{
        res_id: RES, outlet_id: OUTLET, restaurant_slug: "gaia", restaurant_name: "Gaia",
        restaurant_main_office_add: null, restaurant_logo_url: null, timezone: null,
      }] };
    }
    if (/select id, table_name, capacity/i.test(q)) {
      return { rows: fx.tables.map((t) => ({
        id: t.id, table_name: t.table_name, capacity: 4, max_capacity: 4,
        section: null, is_occupied: true, num_covers: 2, order_otp: null,
      })) };
    }
    if (/from "Bookings"/i.test(q)) { return { rows: [] }; }
    if (/select id, table_id, created_at, status, waiter_confirmed_at, admin_approved_at/i.test(q)) {
      return { rows: fx.bills.map((b) => ({
        id: b.id, table_id: b.table_id, created_at: new Date(b.created_at),
        status: 1, waiter_confirmed_at: null, admin_approved_at: null,
      })) };
    }
    if (/select table_id, food, created_at from "Orders"/i.test(q)) {
      return { rows: fx.orders.map((o) => ({ ...o, created_at: new Date(o.created_at) })) };
    }
    if (/from "PrintJobs"/i.test(q)) {
      if (fx.printJobsThrow) { throw fx.printJobsThrow; }
      return { rows: fx.printJobs.map((j) => ({ bill_id: j.bill_id, created_at: new Date(j.created_at) })) };
    }
    return { rows: [] };
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string): Promise<{ rows: unknown[] }> { return query(sql); }
    connect(): Promise<unknown> { return Promise.resolve({ query, release: () => undefined }); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

let db: typeof import("../database_supabase");

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
});

beforeEach(() => {
  fx.sql = [];
  fx.printJobsThrow = null;
  fx.tables = [{ id: T7, table_name: "T7" }, { id: T8, table_name: "T8" }];
  fx.bills = [{ id: BILL_T7, table_id: T7, created_at: SEATED_AT }];
  fx.orders = [
    { table_id: T7, food: { subtotal: 1200, total: 1200 }, created_at: SEATED_AT },
    { table_id: T8, food: { subtotal: 800, total: 800 }, created_at: SEATED_AT },
  ];
  fx.printJobs = [];
});

const seating = (over: Partial<Parameters<typeof summarizeBillPrints>[1]> = {}) => ({
  open_bill_id: BILL_T7, table_name: "T7", seating_start: SEATED_AT, ...over,
});

const tableRow = async (name: string) => {
  const rows = await db.GetTables(RES);
  return (rows ?? []).find((r) => r.table_name === name);
};

// ===========================================================================
describe("the rule — which prints belong to this seating", () => {
  test("a job addressed to the open bill counts", () => {
    expect(billPrintJobBelongsToSeating({ bill_id: BILL_T7, created_at: PRINT_1 }, seating())).toBe(true);
  });

  test("the `<table>-<epoch>` fallback bill_id counts too — both shapes are written", () => {
    expect(billPrintJobBelongsToSeating({ bill_id: "T7-1789000000000", created_at: PRINT_1 }, seating()))
      .toBe(true);
    expect(billPrintFallbackPrefix("T7")).toBe("T7-");
  });

  test("another table's print never counts, and a LIKE metacharacter cannot widen the match", () => {
    expect(billPrintJobBelongsToSeating({ bill_id: "T8-1789000000000", created_at: PRINT_1 }, seating()))
      .toBe(false);
    // The SQL version matched `T_1-%`, where `_` is "any character", so "TX1-…"
    // counted as T_1's own print. A prefix test has no metacharacters to escape.
    expect(billPrintJobBelongsToSeating(
      { bill_id: "TX1-1789000000000", created_at: PRINT_1 },
      seating({ open_bill_id: null, table_name: "T_1" }),
    )).toBe(false);
  });

  test("the previous party's prints do not follow the table into this seating", () => {
    expect(billPrintJobBelongsToSeating({ bill_id: "T7-1788000000000", created_at: LAST_PARTY }, seating()))
      .toBe(false);
  });

  test("'pending', 'delivered' and 'acked' count — a jam does not burn the attempt", () => {
    // Stated as the contract the SQL filters on; 'failed'/'expired' are terminal
    // non-events, and burning a waiter's one attempt on a paper jam would leave
    // them holding a table they cannot bill.
    expect([...COUNTED_PRINT_JOB_STATUSES].sort()).toEqual(["acked", "delivered", "pending"]);
    expect(COUNTED_PRINT_JOB_STATUSES).not.toContain("failed");
    expect(COUNTED_PRINT_JOB_STATUSES).not.toContain("expired");
  });

  test("the summary is first print, last print and a count", () => {
    const s = summarizeBillPrints(
      [
        { bill_id: BILL_T7, created_at: PRINT_2 },
        { bill_id: BILL_T7, created_at: PRINT_1 },
        { bill_id: "T8-1", created_at: PRINT_1 },
      ],
      seating(),
    );
    expect(s).toEqual({ print_count: 2, bill_printed_at: PRINT_1, printed_at: PRINT_2 });
  });

  test("nothing printed is 0/null/null — silence means 'not printed', so the waiter keeps the button", () => {
    expect(summarizeBillPrints([], seating())).toEqual(NO_BILL_PRINTS);
    expect(NO_BILL_PRINTS).toEqual({ print_count: 0, bill_printed_at: null, printed_at: null });
  });

  test("THE FIELD NAMES ARE THE CONTRACT — exactly the three the client reads", () => {
    // serverBillPrintState() in the Flutter app reads these spellings. A fourth
    // spelling here is the same defect in a new costume.
    expect(Object.keys(NO_BILL_PRINTS).sort()).toEqual(["bill_printed_at", "print_count", "printed_at"]);
  });
});

// ===========================================================================
describe("the shipped /get-tables payload", () => {
  test("EVERY row carries all three names — delete them and this fails", async () => {
    const rows = await db.GetTables(RES);
    expect(rows).not.toBeNull();
    for (const r of rows ?? []) {
      expect([r.table_name, Object.prototype.hasOwnProperty.call(r, "print_count")]).toEqual([r.table_name, true]);
      expect([r.table_name, Object.prototype.hasOwnProperty.call(r, "bill_printed_at")]).toEqual([r.table_name, true]);
      expect([r.table_name, Object.prototype.hasOwnProperty.call(r, "printed_at")]).toEqual([r.table_name, true]);
    }
  });

  test("a table whose bill has been printed says so, with both instants", async () => {
    fx.printJobs = [
      { bill_id: BILL_T7, created_at: PRINT_1 },
      { bill_id: BILL_T7, created_at: PRINT_2 },
    ];
    const row = await tableRow("T7");
    expect(row?.print_count).toBe(2);
    expect(row?.bill_printed_at).toBe(PRINT_1);
    expect(row?.printed_at).toBe(PRINT_2);
  });

  test("…and its neighbour, which nobody printed, still says 0", async () => {
    fx.printJobs = [{ bill_id: BILL_T7, created_at: PRINT_1 }];
    const row = await tableRow("T8");
    expect(row?.print_count).toBe(0);
    expect(row?.bill_printed_at).toBeNull();
    expect(row?.printed_at).toBeNull();
  });

  test("a table with no bill row yet is bounded by its earliest still-owing order", async () => {
    // T8 has orders and no "Bills" row — the fallback bill_id shape — and the
    // seating starts at the order, exactly as GetBillForTable bounds it.
    fx.printJobs = [
      { bill_id: "T8-1789000000000", created_at: PRINT_1 },
      { bill_id: "T8-1788000000000", created_at: LAST_PARTY },
    ];
    const row = await tableRow("T8");
    expect(row?.print_count).toBe(1);
    expect(row?.bill_printed_at).toBe(PRINT_1);
  });

  test("ONE query for the whole floor, not one per table", async () => {
    // /get-tables is the most-polled endpoint in the product. A per-table
    // aggregate would add a round trip per table to every poll of every device.
    await db.GetTables(RES);
    expect(fx.sql.filter((q) => /from "PrintJobs"/i.test(q)).length).toBe(1);
  });

  test("a print ledger that is one migration behind does NOT take the floor plan down", async () => {
    const missing = Object.assign(new Error(`relation "PrintJobs" does not exist`), { code: "42P01" });
    fx.printJobsThrow = missing;
    const row = await tableRow("T7");
    expect(row?.print_count).toBe(0);
    expect(row?.bill_printed_at).toBeNull();
    // …and the rest of the row is intact, which is the point: the grid renders.
    expect(row?.table_total).toBe(1200);
  });

  test("any other read failure degrades the same way rather than 500-ing the grid", async () => {
    fx.printJobsThrow = new Error("connection terminated unexpectedly");
    const rows = await db.GetTables(RES);
    expect((rows ?? []).length).toBe(2);
    for (const r of rows ?? []) { expect([r.table_name, r.print_count]).toEqual([r.table_name, 0]); }
  });

  test("payment_pending still works after the open-bill read was widened", async () => {
    // The pending test moved from SQL into TypeScript when that query stopped
    // selecting only confirmed-but-unapproved bills. It must not have changed.
    fx.bills = [{ id: BILL_T7, table_id: T7, created_at: SEATED_AT }];
    expect((await tableRow("T7"))?.payment_pending).toBe(false);
  });
});

// ===========================================================================
describe("both payloads spell it the same way", () => {
  const source = readFileSync(join(__dirname, "..", "database_supabase.ts"), "utf8");
  const bodyOf = (name: string): string => {
    const at = source.indexOf(`export async function ${name}(`);
    expect(at).toBeGreaterThan(-1);
    const end = source.indexOf("\nexport async function ", at + 10);
    return source.slice(at, end === -1 ? source.length : end);
  };

  for (const fn of ["GetBillForTable", "GetTables"]) {
    test(`${fn} emits print_count, bill_printed_at and printed_at`, () => {
      const body = bodyOf(fn);
      for (const key of ["print_count:", "bill_printed_at:", "printed_at:"]) {
        expect([fn, key, body.includes(key)]).toEqual([fn, key, true]);
      }
    });
  }
});
