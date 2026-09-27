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
//   4. THE FLOOR: /get-tables names the sibling, lists it beside its root, gives
//      it the root's booking, keeps it out of every room-counting reader, and
//      makes the seat a print before 2.0.1 never made.
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
  addBooking,
  addOrder,
  addPrint,
  addTable,
  failNextStatementContaining,
  liveSiblingsOf,
  liveTable,
  liveTables,
  orders,
  resetStore,
  seat,
  setColumnsPresent,
  setOrderStatus,
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

  test("EVERY PRINTED BILL EARNS ITS SEAT: 12 printed, its next party printed too -> '12 #3'", async () => {
    // Gaia Global settles at night, so a printed bill sits unsettled for hours
    // and the number really can owe two of them at once. One duplicate per bill
    // printed is exactly what the client asked for.
    busyTwelve({ printed: true });
    await db.EnsureNextPartyTable(SLUG, "12");
    seat("12 #2", 2);
    addOrder("12 #2", 600);
    tick(4);
    addPrint(`12 #2-${String(Date.now())}`);
    const out = await db.EnsureNextPartyTable(SLUG, "12 #2");
    expect(out).toEqual({ table_name: "12 #3", parent_table: "12", party_no: 3, created: true });
    expect(liveTable("12 #3").parent_table_id).toBe(liveTable("12").id);
  });

  test("A SECOND PRINT OF THE SAME BILL MAKES NOTHING once the next party is on its seat", async () => {
    // THE BUG, in four steps: print 12, seat the next party on "12 #2", print 12
    // AGAIN (a reprint, a duplicate for the guest, or the reprint a waiter is
    // told to do after adding to printed paper) — and the family used to mint a
    // second seat, "12 #3", for a bill that had already had one.
    busyTwelve({ printed: true });
    expect(await db.EnsureNextPartyTable(SLUG, "12")).toMatchObject({ table_name: "12 #2", created: true });
    seat("12 #2", 2);
    addOrder("12 #2", 600);
    tick(4);
    addPrint(`12-${String(Date.now())}`);
    expect(await db.EnsureNextPartyTable(SLUG, "12")).toBeNull();
    expect(names(liveSiblingsOf("12"))).toEqual(["12 #2"]);
    expect(statements().filter((q) => q.startsWith('insert into "tables"'))).toHaveLength(1);
  });

  test("…and the same while the party on the seat has only been SEATED, nothing rung yet", async () => {
    busyTwelve({ printed: true });
    await db.EnsureNextPartyTable(SLUG, "12");
    seat("12 #2", 2);
    tick(4);
    addPrint(`12-${String(Date.now())}`);
    expect(await db.EnsureNextPartyTable(SLUG, "12")).toBeNull();
  });

  test("an unseated '12 #2' that still OWES is neither a free seat nor a reason to mint", async () => {
    // Freed by hand with the bill unpaid. Handing that seat to a new party would
    // put their food on somebody else's bill, so "free" is decided by the row's
    // money as well as its occupancy — and money with no paper out is a party
    // this number has not finished with, so no third card is minted either.
    busyTwelve({ printed: true });
    await db.EnsureNextPartyTable(SLUG, "12");
    seat("12 #2", 2);
    addOrder("12 #2", 600);
    liveTable("12 #2").is_occupied = false;
    expect(await db.EnsureNextPartyTable(SLUG, "12")).toBeNull();
    expect(names(liveSiblingsOf("12"))).toEqual(["12 #2"]);
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
    // Two seats at one number is a shape a print can no longer leave behind (one
    // per printed bill, once), but a floor that ran an older build can hold it,
    // so the retirement rule still has to answer for it.
    await familyOf12({ siblingSeated: true });
    addTable({ table_name: "12 #3", parent_table_id: liveTable("12").id, party_seq: 3 });
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

  test("an upsert's order is read LINE BY LINE, so a status change can be told from an addition", async () => {
    busyTwelve({ printed: true });
    const order = addOrder("12", 250);
    const lineId = String((order.food.items as { id: string }[])[0]!.id);
    const guard = await db.GetOrderingPrintGuard(SLUG, "12", { orderId: order.id });
    expect(guard).toMatchObject({ print_count: 1, existing_lines: [{ id: lineId, quantity: 1 }] });
    // …from the split when the order has one, as AddOrder merges from it.
    order.food.items_split = [["Served", [{ id: lineId, quantity: 1 }]], ["Preparing", [{ id: "late", quantity: 2 }]]];
    expect((await db.GetOrderingPrintGuard(SLUG, "12", { orderId: order.id }))?.existing_lines)
      .toEqual([{ id: lineId, quantity: 1 }, { id: "late", quantity: 2 }]);
    // Not an order that exists: a new one.
    expect((await db.GetOrderingPrintGuard(SLUG, "12", { orderId: "0de70000-0000-4000-8000-999999999999" }))?.existing_lines)
      .toBeNull();
    // Not asked, or nothing printed: never read at all.
    expect((await db.GetOrderingPrintGuard(SLUG, "12"))?.existing_lines).toBeNull();
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
  // PRINTED, because round-3 item 4 is that a second card is drawn only while
  // the first party's paper is out. An unprinted 12 with a free "12 #2" beside
  // it is a state a print can no longer leave behind, and the floor no longer
  // draws it (see "no paper, no second card" below).
  test("/get-tables names the sibling and lists it straight after its root, with the root's zone and booking", async () => {
    addTable({ table_name: "10" });
    busyTwelve({ printed: true });
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

  test("THE KITCHEN DOCKET NAMES THE ZONE THE FLOOR SHOWS: a root dragged to another zone takes its seat's docket with it", async () => {
    busyTwelve({ printed: true });
    await db.EnsureNextPartyTable(SLUG, "12");
    seat("12 #2", 2);
    const order = addOrder("12 #2", 600);
    // The drag: PATCH /table/12 writes the ONE row it names.
    await db.UpdateTable(SLUG, "12", { section: "Terrace" });
    expect(liveTable("12 #2").section).toBe("Garden"); // the seat's own copy is stale
    const floor = (await db.GetTables(SLUG))!;
    expect(floor.find((r) => r.table_name === "12 #2")?.section).toBe("Terrace");
    // Both KOT readers say what the floor says — the table-scoped docket and the bark docket.
    expect((await db.GetKotTableContext(SLUG, "12 #2"))?.section).toBe("Terrace");
    expect((await db.GetOrderKotContext(SLUG, order.id))?.section).toBe("Terrace");
    // A root, and an ordinary table, read their own zone as before.
    expect((await db.GetKotTableContext(SLUG, "12"))?.section).toBe("Terrace");
    expect((await db.GetKotTableContext(SLUG, "15"))?.section).toBe("Garden");
  });

  test("a seat whose root has gone keeps its own zone on the docket rather than none", async () => {
    busyTwelve({ printed: true });
    await db.EnsureNextPartyTable(SLUG, "12");
    liveTable("12").is_deleted = true;
    expect((await db.GetKotTableContext(SLUG, "12 #2"))?.section).toBe("Garden");
  });

  test.each([
    ["booked (a reservation running now)", -10, "booked"],
    ["reserved (a reservation later today)", 60, "reserved"],
  ] as const)("a sibling carries its ROOT's booking state — %s", async (_l, offsetMin, field) => {
    // PRINTED, so both cards are drawn: round-3 item 4 hides the free one of a
    // family whose paper is not out (see "no paper, no second card").
    busyTwelve({ printed: true });
    await db.EnsureNextPartyTable(SLUG, "12");
    const at = new Date();
    at.setHours(12, 0, 0, 0);
    addBooking("12", new Date(at.getTime() + offsetMin * 60_000), 120);
    const rows = (await db.GetTables(SLUG, at))!;
    const other = field === "booked" ? "reserved" : "booked";
    expect(rows.find((r) => r.table_name === "12")).toMatchObject({ [field]: true, [other]: false });
    expect(rows.find((r) => r.table_name === "12 #2")).toMatchObject({ [field]: true, [other]: false });
    // …and a table with no booking of its own, or of its root's, has none.
    expect(rows.find((r) => r.table_name === "15")).toMatchObject({ booked: false, reserved: false });
  });

  test("THE SEAT A PRE-2.0.1 PRINT NEVER MADE: the floor read makes it, once, beside its table", async () => {
    // 12 was printed before this deploy, so no print ever opened its seat.
    busyTwelve({ printed: true });
    expect(liveSiblingsOf("12")).toEqual([]);
    const rows = (await db.GetTables(SLUG))!;
    expect(rows.map((r) => r.table_name)).toEqual(["12", "12 #2", "15"]);
    expect(rows.find((r) => r.table_name === "12 #2")).toMatchObject({ parent_table: "12", display_name: "12", occupied: false });
    // The next poll finds it and makes nothing more.
    await db.GetTables(SLUG);
    expect(names(liveSiblingsOf("12"))).toEqual(["12 #2"]);
    expect(statements().filter((q) => q.startsWith('insert into "tables"'))).toHaveLength(1);
  });

  test("…never for a table that is not printed, and never beside a family that already has a next party", async () => {
    busyTwelve();
    await db.GetTables(SLUG);
    expect(liveSiblingsOf("12")).toEqual([]);
    // Printed, with its next party already SEATED at "12 #2": no "12 #3" from a read.
    await db.EnsureNextPartyTable(SLUG, "12");
    seat("12 #2", 2);
    addOrder("12 #2", 300);
    tick(4);
    addPrint(`12-${String(Date.now())}`);
    await db.GetTables(SLUG);
    expect(names(liveSiblingsOf("12"))).toEqual(["12 #2"]);
  });

  test("…a seat that cannot be made never fails the floor, and is not retried on every poll", async () => {
    busyTwelve({ printed: true });
    failNextStatementContaining('insert into "tables"');
    const rows = await db.GetTables(SLUG);
    expect(rows?.map((r) => r.table_name)).toEqual(["12", "15"]);
    await db.GetTables(SLUG);
    expect(liveSiblingsOf("12")).toEqual([]);
    expect(statements().filter((q) => q.startsWith('insert into "tables"'))).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // ROUND-3 CLIENT ITEM 4 — two cards for one table only while its paper is out.
  //
  // The client's photo: a green, FREE "14" card beside a running "14 #2". 14 had
  // been settled minutes before and its next party was still eating, and the
  // free card is how a waiter seats a party on a table that is already taken.
  // "If there's a running table, no duplication should be there. Only when its
  // bill is printed but not settled should it be there."
  // -------------------------------------------------------------------------

  /** The table cards /get-tables draws, in the order it draws them. */
  const floor = async (): Promise<string[]> => (await db.GetTables(SLUG))!.map((r) => r.table_name);

  test("PRINTED AND UNSETTLED: 12 and its green seat are both cards — the duplicate the feature is for", async () => {
    busyTwelve({ printed: true });
    await db.EnsureNextPartyTable(SLUG, "12");
    expect(await floor()).toEqual(["12", "12 #2", "15"]);
  });

  test("THE CLIENT'S PHOTO: 12 settled while its next party eats -> the free 12 card goes", async () => {
    busyTwelve({ printed: true });
    await db.EnsureNextPartyTable(SLUG, "12");
    seat("12 #2", 2);
    addOrder("12 #2", 600);
    // 12 is paid and cleared; its seating — and with it its print count — is over.
    await db.ReleaseTable(SLUG, "12");
    expect(liveTable("12").is_occupied).toBe(false);
    expect(liveTable("12 #2").is_occupied).toBe(true);

    // ONE card for the number, and it is the one with the party on it.
    const rows = (await db.GetTables(SLUG))!;
    expect(rows.map((r) => r.table_name)).toEqual(["12 #2", "15"]);
    expect(rows.filter((r) => r.display_name === "12")).toHaveLength(1);
    expect(rows.find((r) => r.table_name === "12 #2")).toMatchObject({ display_name: "12", occupied: true });
    // The ROW is still there — it holds a bill's worth of history and the floor
    // plan — and it is still addressable by name everywhere else.
    expect(liveTable("12").is_deleted).toBe(false);
    expect(await db.GetBillForTable(SLUG, "12 #2")).toMatchObject({ subtotal: 600 });
  });

  test("…and once the next party's OWN bill is printed, 12 is a card again: it is the seat", async () => {
    busyTwelve({ printed: true });
    await db.EnsureNextPartyTable(SLUG, "12");
    seat("12 #2", 2);
    addOrder("12 #2", 600);
    await db.ReleaseTable(SLUG, "12");
    tick(4);
    addPrint(`12 #2-${String(Date.now())}`);
    expect(await floor()).toEqual(["12", "12 #2", "15"]);
    // And the seat a print of "12 #2" hands out IS that free root, not a "12 #3".
    expect(await db.EnsureNextPartyTable(SLUG, "12 #2"))
      .toEqual({ table_name: "12", parent_table: "12", party_no: null, created: false });
  });

  test("NO PAPER, NO SECOND CARD: a running 12 with nothing printed shows once", async () => {
    busyTwelve();
    // A seat left behind by a settle whose tidy-up was missed (retirement is
    // self-healing, and until it heals the floor must not draw 12 twice).
    await db.EnsureNextPartyTable(SLUG, "12");
    expect(names(liveSiblingsOf("12"))).toEqual(["12 #2"]);
    expect(await floor()).toEqual(["12", "15"]);
  });

  test("AN IDLE NUMBER SHOWS ONCE, as the root, while its sibling waits to be retired", async () => {
    busyTwelve({ printed: true });
    await db.EnsureNextPartyTable(SLUG, "12");
    liveTable("12").is_occupied = false;
    const twelve = liveTable("12").id;
    for (const o of orders().filter((x) => x.table_id === twelve)) { setOrderStatus(o.id, "7"); }
    expect(await floor()).toEqual(["12", "15"]);
  });

  test("SETTLE, VOID AND RELEASE ALL LAND ON ONE CARD — the sibling row goes with the party", async () => {
    busyTwelve({ printed: true });
    await db.EnsureNextPartyTable(SLUG, "12");
    seat("12 #2", 2);
    const second = addOrder("12 #2", 600);
    await db.ReleaseTable(SLUG, "12");
    expect(await floor()).toEqual(["12 #2", "15"]);
    // The next party leaves: the row is retired for good and 12 is the free card.
    setOrderStatus(second.id, "7");
    await db.ReleaseTable(SLUG, "12 #2");
    expect(liveSiblingsOf("12")).toEqual([]);
    expect(await floor()).toEqual(["12", "15"]);
  });

  // -------------------------------------------------------------------------
  // THE SECOND PHOTO — "2 running tables shouldn't be the case."
  //
  // Table 11 drawn three times: "11" running, "11 #2" with its bill printed,
  // "11 #3" running. Two live parties and a printed one, for one table in the
  // room. Both halves of that are held here: the spare seat a second print used
  // to mint, and the floor that used to draw it because paper was out somewhere
  // in the family.
  // -------------------------------------------------------------------------

  test("A REPRINT NO LONGER PUTS A SPARE FREE CARD BESIDE A RUNNING SEAT", async () => {
    busyTwelve({ printed: true });
    await db.EnsureNextPartyTable(SLUG, "12"); // "12 #2", the seat
    seat("12 #2", 2);
    addOrder("12 #2", 600);
    tick(4);
    addPrint(`12-${String(Date.now())}`); // the SAME bill, printed again
    await db.EnsureNextPartyTable(SLUG, "12");
    // Two cards: the paper, and the party sitting at the number. No third.
    expect(await floor()).toEqual(["12", "12 #2", "15"]);
  });

  test("TWO LIVE PARTIES AT ONE NUMBER: the later card goes, and its money is still reachable", async () => {
    // How the data gets there even with the mint fixed: 12 is settled and freed
    // while "12 #2" eats, and an order lands on 12 anyway — the table's QR is
    // signed for the ROOT, so a guest who scans the card on the table puts it
    // there. Two running cards for one table; the floor draws one.
    busyTwelve({ printed: true });
    await db.EnsureNextPartyTable(SLUG, "12");
    seat("12 #2", 2);
    addOrder("12 #2", 600);
    await db.ReleaseTable(SLUG, "12");
    tick(20);
    seat("12", 2);
    addOrder("12", 300);
    expect(liveTable("12").is_occupied).toBe(true);
    expect(liveTable("12 #2").is_occupied).toBe(true);

    const rows = (await db.GetTables(SLUG))!;
    expect(rows.map((r) => r.table_name)).toEqual(["12 #2", "15"]);
    expect(rows.filter((r) => r.display_name === "12")).toHaveLength(1);
    // HIDDEN, NOT DELETED, and not out of reach: the row is live and every
    // name-keyed reader still answers for it.
    expect(liveTable("12").is_deleted).toBe(false);
    expect((await db.GetBillForTable(SLUG, "12"))?.subtotal).toBe(300);
    expect((await db.GetBillForTable(SLUG, "12 #2"))?.subtotal).toBe(600);
  });

  test("…and printing the hidden party's bill brings its card straight back", async () => {
    busyTwelve({ printed: true });
    await db.EnsureNextPartyTable(SLUG, "12");
    seat("12 #2", 2);
    addOrder("12 #2", 600);
    await db.ReleaseTable(SLUG, "12");
    tick(20);
    seat("12", 2);
    addOrder("12", 300);
    expect(await floor()).toEqual(["12 #2", "15"]);
    tick(4);
    addPrint(`12-${String(Date.now())}`);
    expect(await floor()).toEqual(["12", "12 #2", "15"]);
  });

  test("the two parties still bill apart while both cards are up", async () => {
    busyTwelve({ printed: true });
    await db.EnsureNextPartyTable(SLUG, "12");
    seat("12 #2", 2);
    addOrder("12 #2", 600);
    expect(await floor()).toEqual(["12", "12 #2", "15"]);
    expect((await db.GetBillForTable(SLUG, "12"))?.subtotal).toBe(1000);
    expect((await db.GetBillForTable(SLUG, "12 #2"))?.subtotal).toBe(600);
  });

  // THE INVARIANT, over sequences rather than shapes: whatever order a service
  // prints, seats and settles table 12 in, the floor draws at most ONE running
  // card for it. Every state next_party.test.ts enumerates by hand is reachable
  // here through the SHIPPED paths — EnsureNextPartyTable, ReleaseTable and
  // GetTables — including the ones a stray write makes (a seating on a row the
  // floor is not drawing is exactly what a QR order on a hidden root is).
  test.each([1, 2, 3, 4, 5, 6, 7, 8])("for any sequence of print/seat/settle, one running card (seed %i)", async (seed) => {
    let rng = seed * 2654435761;
    const next = (n: number): number => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng % n; };
    busyTwelve();
    const owing = (id: string): boolean => orders().some((o) => o.table_id === id && !["4", "5", "7"].includes(o.status));

    for (let step = 0; step < 24; step += 1) {
      const family = liveTables().filter((t) => t.table_name === "12" || t.parent_table_id === liveTable("12").id);
      const pick = family[next(family.length)]!;
      const busy = pick.is_occupied || owing(pick.id);
      const op = next(3);
      try {
        if (op === 0 && busy) {
          addPrint(`${pick.table_name}-${String(Date.now())}`);
          await db.EnsureNextPartyTable(SLUG, pick.table_name);
        } else if (op === 1) {
          seat(pick.table_name, 2);
          addOrder(pick.table_name, 100 + next(9) * 100);
        } else {
          await db.ReleaseTable(SLUG, pick.table_name);
        }
      } catch { /* a nonsense op on a nonsense state is still a state the floor must answer for */ }
      tick(3 + next(7));

      const rows = (await db.GetTables(SLUG))!.filter((r) => r.display_name === "12");
      const running = rows.filter((r) => (r.occupied || r.has_order) && (r.print_count ?? 0) === 0);
      expect(running.length).toBeLessThanOrEqual(1);
      // ...and never a free card beside a party, and never no card at all.
      if (running.length > 0) { expect(rows.filter((r) => !r.occupied && !r.has_order)).toHaveLength(0); }
      expect(rows.length).toBeGreaterThanOrEqual(1);
      // Every bill whose paper is out keeps a card: the floor can always reach it.
      const paperOut = liveTables()
        .filter((t) => (t.table_name === "12" || t.parent_table_id === liveTable("12").id) && (t.is_occupied || owing(t.id)));
      for (const t of paperOut) {
        const drawn = rows.find((r) => r.table_name === t.table_name);
        if (!drawn) { expect((await db.GetOrderingPrintGuard(SLUG, t.table_name))?.print_count ?? 0).toBe(0); }
      }
    }
  });

  test("an ordinary table is never touched by the rule — no family, no hiding", async () => {
    addTable({ table_name: "7" });
    addTable({ table_name: "8" });
    seat("8", 2);
    addOrder("8", 200);
    expect(await floor()).toEqual(["7", "8"]);
  });

  // -------------------------------------------------------------------------
  // ...AND THE ROOM STILL HAS EVERY TABLE IN IT — the follow-up to item 4.
  //
  // The rule above hides CARDS, and the card it hides is sometimes the ROOT's.
  // Both clients build their non-service lists — the floor-plan editor, the
  // delete picker, the booking picker, "N of M tables occupied" — out of this
  // same payload by dropping every row that carries a `parent_table`, so a
  // family whose root is hidden loses its number from all four: the owner sees
  // a table they never deleted go missing. `includeFloorHidden` is the read
  // those surfaces make, and it is opt-in so the floor an installed till draws
  // does not change by one byte.
  // -------------------------------------------------------------------------

  /** The rows the ROOM read lists, in order. */
  const room = async (): Promise<string[]> =>
    (await db.GetTables(SLUG, undefined, { includeFloorHidden: true }))!.map((r) => r.table_name);

  test("THE CLIENT'S PHOTO, ASKED AS THE ROOM: the hidden 12 is still a table", async () => {
    busyTwelve({ printed: true });
    await db.EnsureNextPartyTable(SLUG, "12");
    seat("12 #2", 2);
    addOrder("12 #2", 600);
    await db.ReleaseTable(SLUG, "12");
    // The FLOOR draws one card, as item 4 asks.
    expect(await floor()).toEqual(["12 #2", "15"]);
    // The ROOM still has table 12 in it, beside its sibling and its neighbour…
    expect(await room()).toEqual(["12", "12 #2", "15"]);
    // …and it is the real row, with 12's own seats and zone, so the floor-plan
    // editor can still move it, re-size it and delete it BY NAME.
    const twelve = (await db.GetTables(SLUG, undefined, { includeFloorHidden: true }))!
      .find((r) => r.table_name === "12");
    expect(twelve).toMatchObject({ table_name: "12", parent_table: null, capacity: 4, section: "Garden" });
  });

  test("ONE SURVIVING ROW IS EXACTLY ONE TABLE: dropping the siblings leaves every number once", async () => {
    busyTwelve({ printed: true });
    await db.EnsureNextPartyTable(SLUG, "12");
    seat("12 #2", 2);
    addOrder("12 #2", 600);
    await db.ReleaseTable(SLUG, "12");
    // What the editor, the delete picker and the booking picker actually build:
    // the room read with every `parent_table` row dropped.
    const rooms = (await db.GetTables(SLUG, undefined, { includeFloorHidden: true }))!
      .filter((r) => r.parent_table === null)
      .map((r) => r.table_name);
    expect(rooms).toEqual(["12", "15"]);
    // And the counts that follow from it: 2 tables, 12 in use through its sibling.
    expect(rooms).toHaveLength(liveTables().filter((t) => t.parent_table_id === null).length);
  });

  test("THE ROOM IS EVERY LIVE ROW, whatever the card rule decides — the invariant, not the case", async () => {
    // Held across the four states a family can be in, so a later refinement of
    // planNextPartyFloorHidden (one running card per number, one seat per
    // printed bill) cannot quietly take a table out of the room again.
    busyTwelve({ printed: true });
    await db.EnsureNextPartyTable(SLUG, "12");
    const live = () => liveTables().map((t) => t.table_name).sort();
    expect((await room()).sort()).toEqual(live());          // printed + free seat
    seat("12 #2", 2);
    addOrder("12 #2", 600);
    expect((await room()).sort()).toEqual(live());          // printed + running sibling
    await db.ReleaseTable(SLUG, "12");
    expect((await room()).sort()).toEqual(live());          // settled root + running sibling
    tick(4);
    addPrint(`12 #2-${String(Date.now())}`);
    expect((await room()).sort()).toEqual(live());          // free root + printed sibling
  });

  test("THE DEFAULT READ IS UNTOUCHED — an installed till asks nothing and gets today's floor", async () => {
    busyTwelve({ printed: true });
    await db.EnsureNextPartyTable(SLUG, "12");
    seat("12 #2", 2);
    addOrder("12 #2", 600);
    await db.ReleaseTable(SLUG, "12");
    expect(JSON.stringify(await db.GetTables(SLUG)))
      .toEqual(JSON.stringify(await db.GetTables(SLUG, undefined, { includeFloorHidden: false })));
    expect((await db.GetTables(SLUG))!.map((r) => r.table_name)).toEqual(["12 #2", "15"]);
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

  test("the floor read's backfill runs only outside a transaction, and re-reads without backfilling", () => {
    const body = chunk("GetTables");
    expect(body).toMatch(/opts\.backfillNextParty !== false && \(tenantStorage\.getStore\(\)\?\.txnDepth \?\? 0\) === 0/);
    // …and the re-read carries the caller's own room/floor choice with it: a
    // backfill on the ROOM read must not answer with the floor's hidden cards
    // taken out.
    expect(body).toMatch(/return GetTables\(restaurantId, time, \{ backfillNextParty: false, includeFloorHidden: opts\.includeFloorHidden \}\);/);
    expect(body).toMatch(/if \(!claimNextPartyBackfill\(context, r\.id\)\) \{continue;\}/);
  });

  test("the card rule is the FLOOR's only — the room read never enters it", () => {
    const body = chunk("GetTables");
    expect(body).toMatch(/if \(withParty && opts\.includeFloorHidden !== true\) \{/);
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

  test("the KOT readers read the row's own zone and name no 053 column", async () => {
    busyTwelve();
    const order = addOrder("12", 200);
    await db.UpdateTable(SLUG, "12", { section: "Terrace" });
    expect((await db.GetKotTableContext(SLUG, "12"))?.section).toBe("Terrace");
    expect((await db.GetOrderKotContext(SLUG, order.id))?.section).toBe("Terrace");
    const kot = statements().filter((q) => q.includes("latest_food") || q.startsWith("select o.id as order_id"));
    expect(kot).toHaveLength(2);
    for (const q of kot) {expect(q).not.toMatch(/parent_table_id|"tables" kp/);}
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
