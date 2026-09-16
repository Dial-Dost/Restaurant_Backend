// THE NEXT-PARTY ROW'S LIFE — made on a print, handed out, retired when idle.
//
// Client item 6 (migration 053). The money half — that "12 #2" never shares a
// rupee with the printed 12 — is test/money/next_party_money.test.ts. This file
// is everything around it, through the SHIPPED data layer over the in-memory
// floor in next_party_fixtures.ts:
//
//   1. CREATION: once, idempotently, the root first, one row under two tills
//      printing at once (with the row lock, and with only the unique index),
//      a retired row brought back rather than a new one minted, never for a
//      takeaway, never across outlets.
//   2. RETIREMENT: at most one free seat per family, preferring the root —
//      across release, merge-away and move-away, and never a row with a party
//      or money on it.
//   3. THE GUARD'S READ: the same print count the Print button reads, bounded
//      by the same seating start.
//   4. THE FLOOR: /get-tables names the sibling, lists it beside its root, and
//      keeps it out of every room-counting reader.
//   5. THE NAME SPACE: "12 #2" cannot be made by hand, a sibling cannot be
//      deleted from the floor plan, a table cannot be deleted from under its
//      next party, and an offline seating of a retired "12 #2" comes back.
//   6. MIGRATION 053 ABSENT: every one of those paths behaves exactly as it did
//      on 2.0.0 — no sibling, no guard, no statement naming a missing column.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OTHER_OUTLET_ID,
  SLUG,
  addBill,
  addOrder,
  addPrint,
  addTable,
  liveSiblingsOf,
  liveTable,
  liveTables,
  resetStore,
  seat,
  setColumnsPresent,
  setRowLocking,
  statements,
  tables,
  tick,
} from "./next_party_fixtures";

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
});

/** 12 seated and ordered on; optionally printed under the fallback id. */
function busyTwelve(opts: { printed?: boolean } = {}): void {
  addTable({ table_name: "12", capacity: 4, section: "Garden" });
  addTable({ table_name: "15", capacity: 6, section: "Garden" });
  seat("12", 4);
  addOrder("12", 1000);
  if (opts.printed) {
    tick(4);
    addPrint(`12-${String(Date.now())}`);
  }
}

const names = (rows: { table_name: string }[]) => rows.map((r) => r.table_name);

// ===========================================================================
describe("1. creation", () => {
  test("a print of a busy 12 makes '12 #2' with 12's seats and zone, not virtual, unseated", async () => {
    busyTwelve();
    const out = await db.EnsureNextPartyTable(SLUG, "12");
    expect(out).toEqual({ table_name: "12 #2", parent_table: "12", party_no: 2, created: true });
    const row = liveTable("12 #2");
    expect(row).toMatchObject({
      parent_table_id: liveTable("12").id, party_seq: 2, capacity: 4, section: "Garden",
      is_virtual: false, is_occupied: false, is_deleted: false,
    });
  });

  test("idempotent: a reprint returns the same free seat and makes nothing", async () => {
    busyTwelve();
    await db.EnsureNextPartyTable(SLUG, "12");
    const again = await db.EnsureNextPartyTable(SLUG, "12");
    expect(again).toEqual({ table_name: "12 #2", parent_table: "12", party_no: 2, created: false });
    expect(names(liveSiblingsOf("12"))).toEqual(["12 #2"]);
  });

  test("the ROOT is the seat when it is free — a print of '12 #2' after 12 settled names 12", async () => {
    busyTwelve();
    await db.EnsureNextPartyTable(SLUG, "12");
    seat("12 #2", 2);
    addOrder("12 #2", 600);
    await db.ReleaseTable(SLUG, "12");
    const out = await db.EnsureNextPartyTable(SLUG, "12 #2");
    expect(out).toEqual({ table_name: "12", parent_table: "12", party_no: null, created: false });
  });

  test("the whole family busy: a print of '12 #2' makes '12 #3', never a sibling of a sibling", async () => {
    busyTwelve();
    await db.EnsureNextPartyTable(SLUG, "12");
    seat("12 #2", 2);
    addOrder("12 #2", 600);
    const out = await db.EnsureNextPartyTable(SLUG, "12 #2");
    expect(out).toEqual({ table_name: "12 #3", parent_table: "12", party_no: 3, created: true });
    expect(liveTable("12 #3").parent_table_id).toBe(liveTable("12").id);
  });

  test("an unseated '12 #2' that still OWES is not a free seat: the next party gets '12 #3'", async () => {
    // Freed by hand with the bill unpaid. Handing that seat to a new party would
    // put their food on somebody else's bill, so "free" is decided by the row's
    // money as well as its occupancy.
    busyTwelve();
    await db.EnsureNextPartyTable(SLUG, "12");
    seat("12 #2", 2);
    addOrder("12 #2", 600);
    liveTable("12 #2").is_occupied = false;
    const out = await db.EnsureNextPartyTable(SLUG, "12");
    expect(out).toEqual({ table_name: "12 #3", parent_table: "12", party_no: 3, created: true });
  });

  test("TWO TILLS AT ONCE: the root row lock makes one sibling, and both tills name it", async () => {
    busyTwelve();
    const [a, b] = await Promise.all([db.EnsureNextPartyTable(SLUG, "12"), db.EnsureNextPartyTable(SLUG, "12")]);
    expect(names(liveSiblingsOf("12"))).toEqual(["12 #2"]);
    expect([a?.table_name, b?.table_name]).toEqual(["12 #2", "12 #2"]);
    expect([a?.created, b?.created].sort()).toEqual([false, true]);
    // The lock is really taken, on the ROOT's row.
    expect(statements().filter((q) => q.endsWith("for update")).length).toBeGreaterThanOrEqual(2);
  });

  test("…and with no lock at all, the unique index is the backstop: still one row", async () => {
    busyTwelve();
    setRowLocking(false);
    const both = await Promise.all([db.EnsureNextPartyTable(SLUG, "12"), db.EnsureNextPartyTable(SLUG, "12")]);
    expect(names(liveSiblingsOf("12"))).toEqual(["12 #2"]);
    expect(both.map((x) => x?.table_name)).toEqual(["12 #2", "12 #2"]);
  });

  test("a RETIRED '12 #2' is brought back — same id, fresh seat, no waiter", async () => {
    busyTwelve();
    await db.EnsureNextPartyTable(SLUG, "12");
    const firstId = liveTable("12 #2").id;
    await db.ReleaseTable(SLUG, "12"); // 12 free -> the idle "12 #2" retires
    expect(liveSiblingsOf("12")).toEqual([]);
    seat("12", 2);
    addOrder("12", 300);
    const out = await db.EnsureNextPartyTable(SLUG, "12");
    expect(out).toMatchObject({ table_name: "12 #2", created: true });
    expect(liveTable("12 #2").id).toBe(firstId);
    expect(tables().filter((t) => t.table_name === "12 #2")).toHaveLength(1);
  });

  test("a grandfathered room table already called '12 #2' is stepped over: '12 #3'", async () => {
    busyTwelve();
    addTable({ table_name: "12 #2" }); // made before the name was reserved
    const out = await db.EnsureNextPartyTable(SLUG, "12");
    expect(out?.table_name).toBe("12 #3");
  });

  test("never for a takeaway, never for an unknown table", async () => {
    addTable({ table_name: "Takeaway A1B2", is_virtual: true, is_occupied: true });
    expect(await db.EnsureNextPartyTable(SLUG, "Takeaway A1B2")).toBeNull();
    expect(await db.EnsureNextPartyTable(SLUG, "99")).toBeNull();
    expect(await db.EnsureNextPartyTable(SLUG, "  ")).toBeNull();
    expect(liveTables().filter((t) => t.parent_table_id)).toEqual([]);
  });

  test("MULTI-OUTLET: another outlet's '12' is a different family and is never touched", async () => {
    busyTwelve();
    addTable({ table_name: "12", outlet_id: OTHER_OUTLET_ID, is_occupied: true, num_covers: 2 });
    await db.EnsureNextPartyTable(SLUG, "12");
    const other = tables().filter((t) => t.outlet_id === OTHER_OUTLET_ID);
    expect(names(other)).toEqual(["12"]);
    expect(liveSiblingsOf("12").every((t) => t.outlet_id !== OTHER_OUTLET_ID)).toBe(true);
  });

  test("never throws — a failing write answers null and the print it follows is untouched", async () => {
    busyTwelve();
    const { failNextStatementContaining } = await import("./next_party_fixtures");
    failNextStatementContaining('insert into "tables"');
    await expect(db.EnsureNextPartyTable(SLUG, "12")).resolves.toBeNull();
    expect(liveSiblingsOf("12")).toEqual([]);
  });
});

// ===========================================================================
describe("2. retirement: at most one free seat per family, preferring the root", () => {
  async function familyOf12(opts: { siblingSeated: boolean }): Promise<void> {
    busyTwelve();
    await db.EnsureNextPartyTable(SLUG, "12");
    if (opts.siblingSeated) {
      seat("12 #2", 2);
      addOrder("12 #2", 600);
    }
  }

  test.each([
    // [what happens, sibling seated?, siblings left]
    ["RELEASE 12, '12 #2' idle -> '12 #2' retires", false, []],
    ["RELEASE 12, '12 #2' seated -> '12 #2' stays", true, ["12 #2"]],
  ])("%s", async (_label, siblingSeated, left) => {
    await familyOf12({ siblingSeated });
    await db.ReleaseTable(SLUG, "12");
    expect(names(liveSiblingsOf("12"))).toEqual(left);
  });

  test("RELEASE '12 #2' while 12 is still busy -> it stays, as 12's one free seat", async () => {
    await familyOf12({ siblingSeated: true });
    await db.ReleaseTable(SLUG, "12 #2");
    expect(names(liveSiblingsOf("12"))).toEqual(["12 #2"]);
    expect(liveTable("12 #2").is_occupied).toBe(false);
  });

  test("RELEASE '12 #2' after 12 is free -> it retires; 12 is the seat", async () => {
    await familyOf12({ siblingSeated: true });
    await db.ReleaseTable(SLUG, "12");
    await db.ReleaseTable(SLUG, "12 #2");
    expect(liveSiblingsOf("12")).toEqual([]);
    expect(liveTable("12").is_occupied).toBe(false);
  });

  test("two free siblings beside a busy 12 -> the higher number retires, '12 #2' stays", async () => {
    await familyOf12({ siblingSeated: true });
    await db.EnsureNextPartyTable(SLUG, "12 #2"); // makes "12 #3"
    await db.ReleaseTable(SLUG, "12 #2");
    expect(names(liveSiblingsOf("12"))).toEqual(["12 #2"]);
  });

  test("MERGE '12 #2' into 12 (same guests, one more round) -> '12 #2' is freed and stays as the seat", async () => {
    await familyOf12({ siblingSeated: true });
    await db.MergeTableBills(SLUG, "12 #2", "12");
    expect(names(liveSiblingsOf("12"))).toEqual(["12 #2"]);
    expect(liveTable("12 #2").is_occupied).toBe(false);
  });

  test("MERGE 12 away into 15 -> 12 is free and the idle '12 #2' retires", async () => {
    await familyOf12({ siblingSeated: false });
    seat("15", 2);
    addOrder("15", 100);
    await db.MergeTableBills(SLUG, "12", "15");
    expect(liveSiblingsOf("12")).toEqual([]);
  });

  test.each([
    ["idle", false, []],
    ["seated", true, ["12 #2"]],
  ])("MOVE 12's party to 15, '12 #2' %s", async (_label, siblingSeated, left) => {
    await familyOf12({ siblingSeated });
    await db.MoveTableParty(SLUG, "12", "15");
    expect(names(liveSiblingsOf("12"))).toEqual(left);
    expect(liveTable("15").is_occupied).toBe(true);
  });

  test("MOVE a party ONTO an idle '12 #2' is allowed — it is a free destination", async () => {
    await familyOf12({ siblingSeated: false });
    seat("15", 2);
    addOrder("15", 250);
    const out = await db.MoveTableParty(SLUG, "15", "12 #2");
    expect(out.to_table).toBe("12 #2");
    expect(liveTable("12 #2").is_occupied).toBe(true);
  });

  test("an idle sibling carrying an unpaid order is money, not idle: never retired", async () => {
    await familyOf12({ siblingSeated: true });
    liveTable("12 #2").is_occupied = false; // freed by hand, bill still owing
    await db.ReleaseTable(SLUG, "12");
    expect(names(liveSiblingsOf("12"))).toEqual(["12 #2"]);
  });
});

// ===========================================================================
describe("3. the money guard's read", () => {
  test("not printed -> 0; printed under the fallback id -> 1; and it names no parent for a root", async () => {
    busyTwelve();
    expect(await db.GetOrderingPrintGuard(SLUG, "12")).toMatchObject({ table: "12", print_count: 0, parent_table: null });
    tick(4);
    addPrint(`12-${String(Date.now())}`);
    expect(await db.GetOrderingPrintGuard(SLUG, "12")).toMatchObject({ print_count: 1, parent_table: null });
  });

  test("an upsert's order is measured, so a status change can be told from an addition", async () => {
    busyTwelve({ printed: true });
    const order = addOrder("12", 250);
    const guard = await db.GetOrderingPrintGuard(SLUG, "12", { orderId: order.id });
    expect(guard).toMatchObject({ print_count: 1, existing_order: { quantity: 1, amount: 250 } });
    // Not an order that exists: a new one.
    expect((await db.GetOrderingPrintGuard(SLUG, "12", { orderId: "0de70000-0000-4000-8000-999999999999" }))?.existing_order)
      .toBeNull();
    // Not asked, or nothing printed: never read at all.
    expect((await db.GetOrderingPrintGuard(SLUG, "12"))?.existing_order).toBeNull();
  });

  test("a print filed under the open bill id counts, and so does a SPLIT print of it", async () => {
    busyTwelve();
    const bill = addBill("12");
    tick(1);
    addPrint(`${bill.id}-split-1of2`);
    addPrint(`${bill.id}-split-2of2`);
    expect((await db.GetOrderingPrintGuard(SLUG, "12"))?.print_count).toBe(2);
  });

  test("THE SEATING-START REGRESSION: a bill row born AFTER the print does not un-print the table", async () => {
    busyTwelve({ printed: true });
    tick(3);
    addBill("12"); // a discount, a waiver or a tender, three minutes later
    expect((await db.GetOrderingPrintGuard(SLUG, "12"))?.print_count).toBe(1);
    expect((await db.GetBillForTable(SLUG, "12"))?.print_count).toBe(1);
    const row = (await db.GetTables(SLUG))?.find((r) => r.table_name === "12");
    expect(row?.print_count).toBe(1);
  });

  test("the previous party's print does not follow the table into the next seating", async () => {
    busyTwelve({ printed: true });
    await db.FinalizeOnlinePayment(SLUG, "12", "pay_prev");
    tick(20);
    seat("12", 2);
    addOrder("12", 400);
    expect((await db.GetOrderingPrintGuard(SLUG, "12"))?.print_count).toBe(0);
  });

  test("a printed sibling names its root, so the refusal can say '12 (next party)'", async () => {
    busyTwelve();
    await db.EnsureNextPartyTable(SLUG, "12");
    seat("12 #2", 2);
    addOrder("12 #2", 600);
    tick(2);
    addPrint(`12 #2-${String(Date.now())}`);
    expect(await db.GetOrderingPrintGuard(SLUG, "12 #2")).toMatchObject({ print_count: 1, parent_table: "12" });
  });

  test("no guard for a takeaway, an unknown table, or a database without 053", async () => {
    addTable({ table_name: "Takeaway A1B2", is_virtual: true, is_occupied: true });
    expect(await db.GetOrderingPrintGuard(SLUG, "Takeaway A1B2")).toBeNull();
    expect(await db.GetOrderingPrintGuard(SLUG, "nope")).toBeNull();
    busyTwelve({ printed: true });
    setColumnsPresent(false);
    db.resetTableNextPartyCache();
    expect(await db.GetOrderingPrintGuard(SLUG, "12")).toBeNull();
  });
});

// ===========================================================================
describe("4. the floor", () => {
  test("/get-tables names the sibling and lists it straight after its root, with the root's zone and booking", async () => {
    addTable({ table_name: "10" });
    busyTwelve();
    addTable({ table_name: "120" });
    await db.EnsureNextPartyTable(SLUG, "12");
    liveTable("12 #2").section = "Somewhere stale";
    const rows = (await db.GetTables(SLUG))!;
    expect(rows.map((r) => r.table_name)).toEqual(["10", "12", "12 #2", "120", "15"]);
    const root = rows.find((r) => r.table_name === "12")!;
    const next = rows.find((r) => r.table_name === "12 #2")!;
    expect(root).toMatchObject({ parent_table: null, party_no: null, display_name: "12" });
    expect(next).toMatchObject({ parent_table: "12", party_no: 2, display_name: "12", section: "Garden", occupied: false });
    // Its OWN occupancy, money and print state.
    expect(next.print_count).toBe(0);
    expect(next.table_total).toBe(0);
    expect(next.qr_token).not.toBe(root.qr_token);
  });

  test("the room-counting readers never see a sibling: sections, bookings, seating suggestions", async () => {
    busyTwelve();
    await db.EnsureNextPartyTable(SLUG, "12");
    const sections = await db.GetTableSections(SLUG);
    expect(sections.sections.find((x) => x.section === "Garden")).toMatchObject({ tables: 2, seats: 10 });
    const free = await db.GetAvailableTablesForInterval(SLUG, new Date(), 90);
    expect(free.map((t) => t.table_name).sort()).toEqual(["12", "15"]);
    const suggestion = await db.GetSeatingSuggestion(SLUG, 2, new Date(), 90);
    expect(JSON.stringify(suggestion)).not.toContain("12 #2");
  });

  // The readers whose SQL this fixture does not run are held to the ONE
  // predicate by their source. A reader added later that counts the room with a
  // bare `is_virtual` test is what this is here to catch.
  const DB_SRC = readFileSync(join(__dirname, "..", "database_supabase.ts"), "utf8").replace(/\r\n/g, "\n");
  const chunk = (name: string): string => {
    const at = DB_SRC.search(new RegExp(`^(?:export )?async function ${name}\\(`, "m"));
    expect(at).toBeGreaterThan(-1);
    const next = DB_SRC.slice(at + 1).search(/^(?:export )?(?:async )?function /m);
    return DB_SRC.slice(at, next < 0 ? undefined : at + 1 + next);
  };
  test.each([
    "readSectionBirthByKey", "GetTableSections", "ReorderTableSections", "GetSeatingSuggestion",
    "GetAvailableTablesForInterval", "GetAdvancedAnalytics", "GetSimulationRawStats",
  ])("%s counts the room through physicalTableSql", (name) => {
    const body = chunk(name);
    expect(body).toMatch(/await physicalTableSql\(/);
    // No bare is_virtual filter left on a plain "Tables" read in it — the
    // TableSessions joins keep theirs on purpose (a next party's seating is a
    // real seating for turnaround), and they read `t.is_virtual` off a join.
    expect(body).not.toMatch(/from "Tables"\s+where[^`]*coalesce\(is_virtual, ?false\) ?= ?false/);
  });

  test("physicalTableSql is the virtual filter, plus the parent filter only when 053 is there", () => {
    const body = chunk("physicalTableSql");
    expect(body).toContain("coalesce(${col(\"is_virtual\")}, false) = false");
    expect(body).toContain("${col(\"parent_table_id\")} is null");
    expect(body).toMatch(/await nextPartyReady\(\)/);
  });

  test("the table-wise turnaround folds a next party's seating into its table's label", () => {
    const body = chunk("GetAdvancedAnalytics");
    expect(body).toMatch(/coalesce\(\$\{foldToRoot \? "pt\.table_name, " : ""\}s\.table_name, '\?'\) table_name/);
    expect(body).toMatch(/left join "Tables" pt on pt\.id = t\.parent_table_id/);
  });
});

// ===========================================================================
describe("5. the name space", () => {
  test("AddTable refuses a reserved name; the revive lookup is for room tables only", async () => {
    addTable({ table_name: "12" });
    await expect(db.AddTable(SLUG, "12 #2", 4)).rejects.toThrow(/kept for the next party/);
    await expect(db.AddTable(SLUG, "Patio 4 #13", 4)).rejects.toMatchObject({ name: "ReservedTableNameError" });
    await expect(db.AddTable(SLUG, "12#2", 4)).resolves.toMatchObject({ table_name: "12#2" }); // no space: a real name
    expect(statements().some((q) => q.includes("lower(table_name) = lower($3) and parent_table_id is null"))).toBe(true);
  });

  test("a sibling is not the floor plan's to delete", async () => {
    busyTwelve();
    await db.EnsureNextPartyTable(SLUG, "12");
    const out = await db.RemoveTable(SLUG, "12 #2");
    expect(out).toEqual({ status: "blocked", message: expect.stringContaining("next-party seat for 12") });
    expect(liveTable("12 #2").is_deleted).toBe(false);
  });

  test("a table cannot be deleted from under its seated next party", async () => {
    busyTwelve();
    await db.EnsureNextPartyTable(SLUG, "12");
    seat("12 #2", 2);
    addOrder("12 #2", 600);
    await db.FinalizeOnlinePayment(SLUG, "12", "pay_a"); // 12 is free and billless now
    const out = await db.RemoveTable(SLUG, "12");
    expect(out).toEqual({ status: "blocked", message: expect.stringContaining("12 #2 is still open") });
    expect(liveTable("12").is_deleted).toBe(false);
  });

  test("an idle sibling is tidied first, and the root is SOFT-deleted (the sibling row still points at it)", async () => {
    addTable({ table_name: "12" });
    addTable({ table_name: "15" });
    seat("12", 1);
    await db.EnsureNextPartyTable(SLUG, "12"); // 12 seated but not ordered: busy
    liveTable("12").is_occupied = false; // left without ordering
    const out = await db.RemoveTable(SLUG, "12");
    expect(out).toEqual({ status: "deleted" });
    expect(tables().find((t) => t.table_name === "12")?.is_deleted).toBe(true);
    expect(tables().find((t) => t.table_name === "12 #2")?.is_deleted).toBe(true);
  });

  test("OFFLINE: seating a RETIRED '12 #2' brings it back while 12 still exists", async () => {
    busyTwelve();
    await db.EnsureNextPartyTable(SLUG, "12");
    await db.ReleaseTable(SLUG, "12"); // "12 #2" retires
    expect(liveSiblingsOf("12")).toEqual([]);
    const out = await db.OccupyTable(SLUG, "12 #2", 2, null, null);
    expect(out.is_occupied).toBe(true);
    expect(liveTable("12 #2")).toMatchObject({ is_occupied: true, num_covers: 2, is_deleted: false });
  });

  test("…but not once 12 itself is gone, and never over a live table of the same name", async () => {
    busyTwelve();
    await db.EnsureNextPartyTable(SLUG, "12");
    await db.ReleaseTable(SLUG, "12");
    liveTable("12").is_deleted = true;
    await expect(db.OccupyTable(SLUG, "12 #2", 2, null, null)).rejects.toThrow("Table not found");
  });
});

// ===========================================================================
describe("6. migration 053 absent — exactly 2.0.0", () => {
  beforeEach(() => {
    setColumnsPresent(false);
    db.resetTableNextPartyCache();
  });

  test("no sibling, no error, and the print path's call simply answers null", async () => {
    busyTwelve({ printed: true });
    await expect(db.EnsureNextPartyTable(SLUG, "12")).resolves.toBeNull();
    expect(liveTables().map((t) => t.table_name).sort()).toEqual(["12", "15"]);
  });

  test("/get-tables, release, settle, merge, move, add, delete and seat all work and never name a 053 column", async () => {
    busyTwelve({ printed: true });
    const rows = await db.GetTables(SLUG);
    expect(rows?.find((r) => r.table_name === "12")).toMatchObject({ parent_table: null, party_no: null, display_name: "12", print_count: 1 });
    await db.FinalizeOnlinePayment(SLUG, "12", "pay_a");
    seat("12", 2);
    addOrder("12", 200);
    await db.MoveTableParty(SLUG, "12", "15");
    await db.ReleaseTable(SLUG, "15");
    await db.AddTable(SLUG, "16", 4);
    await expect(db.RemoveTable(SLUG, "16")).resolves.toEqual({ status: "deleted" });
    await db.GetTableSections(SLUG);
    await db.GetAvailableTablesForInterval(SLUG, new Date(), 90);
    await expect(db.OccupyTable(SLUG, "12 #2", 2, null, null)).rejects.toThrow("Table not found");
    // The fixture throws 42703 on any statement naming the columns, so reaching
    // here is the proof; this makes it explicit.
    const named = statements().filter((q) => !/^(alter|create|do|comment|grant)\b/.test(q)
      && !q.includes("information_schema") && (q.includes("parent_table_id") || q.includes("party_seq")));
    expect(named).toEqual([]);
  });

  test("the boot step reports OFF, and a later hand-apply is picked up within a minute", async () => {
    await expect(db.InitTableNextPartySchema()).resolves.toBe(false);
    setColumnsPresent(true);
    // Still inside the re-probe window: stays off.
    busyTwelve();
    expect(await db.EnsureNextPartyTable(SLUG, "12")).toBeNull();
    db.resetTableNextPartyCache(); // the minute has passed
    expect(await db.EnsureNextPartyTable(SLUG, "12")).toMatchObject({ table_name: "12 #2" });
  });
});
