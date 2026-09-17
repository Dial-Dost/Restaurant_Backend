// A MOVED ORDER BELONGS TO THE SEATING IT MOVED INTO — integration review of
// 2.0.2 (money-floor), through the SHIPPED data layer over next_party_fixtures.
//
//   1. THE SETTLED-BILL WINDOW. A settled bill's orders are found by time on its
//      table (ReopenBill, GetClosedBill, the History list). The three doors that
//      change an order's table — MoveTableParty, MoveOrderToTable and
//      MergeTableBills — kept its created_at, so an order placed before the
//      destination's previous party paid was counted on THAT party's bill:
//      production GGV bill #3 (2120.58) read 3891 with the moved party's 2055 on
//      it, and a re-open would have put an order the guest had already paid back
//      on it. Each door now stamps food.table_since (by the database's clock) and
//      the window reads the arrival.
//   2. THE PRINT BOUND. "Move an order" changed which prints a seating counted,
//      on both tables: the destination took the previous party's paper as its
//      own (orange, a 423, "Replaces the bill printed …" on somebody else's
//      paper), and the source forgot its own print when its first ticket left.
//      The bound is now anchored on the open seating (seatingStartFor).
//   3. THE GUEST ON A MOVED TICKET is the destination's, not the source's.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { billLinesDigest } from "../bill_paper_digest";
import { PREVIOUS_PARTY_PRINT_MARK, seatingStartFor } from "../bill_print_state";
import { orderArrivedAt, seatingIdentityOf, withFilledSeatingIdentity, withSeatingIdentity } from "../order_moves";
import {
  SLUG,
  addOrder,
  addPrint,
  addTable,
  bills,
  nowIso,
  orders,
  printJobs,
  resetStore,
  seat,
  setOrderFood,
  setOrderStatus,
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
  db.__poolHygieneTestSeam.resetDdlMemo();
});

const closedOn = (tableName: string) => bills()
  .filter((b) => b.closed_at !== null && b.table_id === tableIdOf(tableName))
  .sort((a, z) => (a.closed_at! < z.closed_at! ? -1 : 1));
let tableIds: Record<string, string> = {};
const tableIdOf = (name: string): string => tableIds[name] ?? "";
function tablesNamed(...names: string[]): void {
  tableIds = {};
  for (const n of names) {tableIds[n] = addTable({ table_name: n, capacity: 6 }).id;}
}
const owingOn = (name: string) => orders().filter((o) => o.table_id === tableIdOf(name) && !["4", "5", "7"].includes(o.status));

// ===========================================================================
describe("1. the settled-bill window reads when an order ARRIVED", () => {
  /**
   * GGV 2026-09-14, 15 -> 14: 14's party orders 1836; 15's party orders 2055;
   * 14 pays; 15's party moves to 14, adds 907 and pays.
   */
  async function partyMovedOntoAPaidTable(): Promise<{ previous: string; moved: string; first15: string }> {
    tablesNamed("14", "15");
    seat("14", 2);
    addOrder("14", 1836);
    tick(2);
    seat("15", 3);
    const first15 = addOrder("15", 2055).id;
    tick(3);
    await db.FinalizeOnlinePayment(SLUG, "14", "pay_previous");
    tick(4);
    await db.MoveTableParty(SLUG, "15", "14");
    tick(2);
    addOrder("14", 907);
    tick(5);
    await db.FinalizeOnlinePayment(SLUG, "14", "pay_moved");
    const [previous, moved] = closedOn("14");
    return { previous: previous.id, moved: moved.id, first15 };
  }

  test("the party move stamps each order with when it arrived, by the database's clock", async () => {
    tablesNamed("14", "15");
    seat("15", 3);
    const o = addOrder("15", 2055);
    tick(7);
    await db.MoveTableParty(SLUG, "15", "14");
    const moved = orders().find((x) => x.id === o.id)!;
    expect(moved).toMatchObject({ table_id: tableIdOf("14"), created_at: o.created_at });
    expect(moved.food).toMatchObject({ table: "14", table_since: nowIso() });
  });

  test("re-opening the PREVIOUS party's bill restores its own order only (was: the moved party's 2055 too)", async () => {
    const { previous, first15 } = await partyMovedOntoAPaidTable();
    const out = await db.ReopenBill(SLUG, previous);
    expect(out.restored_orders).toBe(1);
    const back = owingOn("14");
    expect(back.map((o) => o.food.subtotal)).toEqual([1836]);
    // The moved party's paid order stays paid.
    expect(orders().find((o) => o.id === first15)?.status).toBe("4");
    expect((await db.GetBillForTable(SLUG, "14"))?.subtotal).toBe(1836);
  });

  test("re-opening the MOVED party's bill restores all of its food (was: 907 of 2962)", async () => {
    const { moved } = await partyMovedOntoAPaidTable();
    const out = await db.ReopenBill(SLUG, moved);
    expect(out.restored_orders).toBe(2);
    expect(owingOn("14").map((o) => o.food.subtotal).sort()).toEqual([2055, 907]);
    expect((await db.GetBillForTable(SLUG, "14"))?.subtotal).toBe(2962);
  });

  test("move-order: a ticket moved onto a paid table is the new seating's, not the previous party's", async () => {
    tablesNamed("12", "15");
    seat("15", 2);
    addOrder("15", 600);
    tick(1);
    seat("12", 2);
    const ticket = addOrder("12", 450).id;
    addOrder("12", 300);
    tick(3);
    await db.FinalizeOnlinePayment(SLUG, "15", "pay_15_previous");
    tick(2);
    await db.MoveOrderToTable(SLUG, ticket, "15");
    expect(orders().find((o) => o.id === ticket)?.food.table_since).toBe(nowIso());
    tick(4);
    await db.FinalizeOnlinePayment(SLUG, "15", "pay_15_moved");
    const [previous, movedBill] = closedOn("15");

    const back = await db.ReopenBill(SLUG, previous.id);
    expect(back.restored_orders).toBe(1);
    expect(owingOn("15").map((o) => o.food.subtotal)).toEqual([600]);
    expect(orders().find((o) => o.id === ticket)?.status).toBe("4");
    expect(movedBill.id).not.toBe(previous.id);
  });

  test("merge: the source's orders are the destination's NEW seating, not the one that paid before", async () => {
    tablesNamed("12", "15");
    seat("15", 2);
    addOrder("15", 600);
    tick(1);
    seat("12", 2);
    addOrder("12", 450);
    tick(3);
    await db.FinalizeOnlinePayment(SLUG, "15", "pay_15_previous");
    tick(1);
    seat("15", 2);
    addOrder("15", 200);
    tick(1);
    await db.MergeTableBills(SLUG, "12", "15");
    expect(orders().filter((o) => o.table_id === tableIdOf("15") && o.food.subtotal === 450)[0]?.food.table_since).toBe(nowIso());
    tick(2);
    await db.FinalizeOnlinePayment(SLUG, "15", "pay_15_merged");
    const [previous] = closedOn("15");
    const back = await db.ReopenBill(SLUG, previous.id);
    expect(back.restored_orders).toBe(1);
    expect(owingOn("15").map((o) => o.food.subtotal)).toEqual([600]);
  });

  test("an order that never moved is placed by its created_at, exactly as before", async () => {
    tablesNamed("12");
    seat("12", 2);
    addOrder("12", 500);
    tick(2);
    await db.FinalizeOnlinePayment(SLUG, "12", "pay_a");
    tick(2);
    seat("12", 2);
    addOrder("12", 700);
    tick(2);
    await db.FinalizeOnlinePayment(SLUG, "12", "pay_b");
    const [first, second] = closedOn("12");
    const out = await db.ReopenBill(SLUG, second.id);
    expect(out.restored_orders).toBe(1);
    expect(owingOn("12").map((o) => o.food.subtotal)).toEqual([700]);
    expect(first.id).not.toBe(second.id);
  });
});

// ===========================================================================
describe("2. the print bound survives an order moving on or off a table", () => {
  const printCounts = async (name: string) => ({
    bill: (await db.GetBillForTable(SLUG, name))?.print_count ?? null,
    guard: (await db.GetOrderingPrintGuard(SLUG, name))?.print_count ?? null,
    tile: (await db.GetTables(SLUG))?.find((r) => r.table_name === name)?.print_count ?? null,
  });

  test("DESTINATION: the previous party's paper is not the new seating's (was: printed, 423, 'Replaces …')", async () => {
    tablesNamed("12", "20");
    seat("20", 2);
    addOrder("20", 800);
    tick(1);
    seat("12", 2);
    const ticket = addOrder("12", 450).id;
    tick(1);
    // 20's previous party is handed its bill AFTER the ticket at 12 was placed.
    const paperBillId = `20-${String(Date.parse(nowIso()))}`;
    const paper = addPrint(paperBillId);
    tick(1);
    await db.FinalizeOnlinePayment(SLUG, "20", "pay_20");
    tick(1);
    const moved = await db.MoveOrderToTable(SLUG, ticket, "20");
    expect(moved.seated_destination).toBe(true);
    expect(await printCounts("20")).toEqual({ bill: 0, guard: 0, tile: 0 });
    // ...and that paper is filed as nobody's (the move retired it).
    expect(printJobs().find((j) => j.id === paper.id)?.bill_id).toBe(`${PREVIOUS_PARTY_PRINT_MARK}${paperBillId}`);
  });

  test("DESTINATION ALREADY SEATED: the moved ticket does not drag the start back into the previous party's service", async () => {
    tablesNamed("12", "20");
    seat("12", 2);
    const ticket = addOrder("12", 450).id;
    tick(1);
    seat("20", 2);
    addOrder("20", 800);
    tick(1);
    const previousPaperId = `20-${String(Date.parse(nowIso()))}`;
    const previousPaper = addPrint(previousPaperId);
    tick(1);
    await db.FinalizeOnlinePayment(SLUG, "20", "pay_20");
    tick(1);
    seat("20", 2);
    addOrder("20", 90);
    tick(1);
    const moved = await db.MoveOrderToTable(SLUG, ticket, "20");
    expect(moved.seated_destination).toBe(false);
    expect(await printCounts("20")).toEqual({ bill: 0, guard: 0, tile: 0 });
    // Not retired: 20 was seated, so its prints are left alone.
    expect(printJobs().find((j) => j.id === previousPaper.id)?.bill_id).toBe(previousPaperId);
  });

  test("SOURCE: 12 keeps its print when its first ticket moves away, and the paper reads stale", async () => {
    tablesNamed("12", "15");
    seat("12", 2);
    const first = addOrder("12", 300);
    tick(2);
    addPrint(`12-${String(Date.parse(nowIso()))}`, {
      bill_digest: "b".repeat(64),
      lines_digest: billLinesDigest([{ name: "Dish on 12", price: 300, quantity: 1 }]),
      bill_grand_total: 315, table_name: "12",
    });
    tick(1);
    addOrder("12", 200);
    tick(1);
    seat("15", 2);
    await db.MoveOrderToTable(SLUG, first.id, "15");
    expect(await printCounts("12")).toEqual({ bill: 1, guard: 1, tile: 1 });
    const tile = (await db.GetTables(SLUG))?.find((r) => r.table_name === "12");
    expect(tile?.paper_stale).toBe(true);
    // 15 was seated before the move and never printed.
    expect(await printCounts("15")).toEqual({ bill: 0, guard: 0, tile: 0 });
  });

  test("SOURCE: a first ticket CANCELLED after the print does not un-print the table either", async () => {
    tablesNamed("12");
    seat("12", 2);
    const first = addOrder("12", 300);
    tick(2);
    addPrint(`12-${String(Date.parse(nowIso()))}`);
    tick(1);
    addOrder("12", 200);
    tick(1);
    setOrderStatus(first.id, "5");
    expect(await printCounts("12")).toEqual({ bill: 1, guard: 1, tile: 1 });
  });

  test("RE-OPENED: a bill whose row was born at the settle, after its print, still reads printed", async () => {
    tablesNamed("12");
    seat("12", 2);
    addOrder("12", 300);
    tick(2);
    addPrint(`12-${String(Date.parse(nowIso()))}`);
    tick(3);
    await db.FinalizeOnlinePayment(SLUG, "12", "pay_12");
    tick(5);
    const [closed] = closedOn("12");
    expect(Date.parse(closed.created_at)).toBeGreaterThan(Date.parse(printJobs()[0].created_at));
    await db.ReopenBill(SLUG, closed.id);
    // The re-open opened a fresh seating now — after the print — but the
    // restored order arrived before it.
    expect(await printCounts("12")).toEqual({ bill: 1, guard: 1, tile: 1 });
  });

  test("the previous party's print still does not follow the table into the next seating", async () => {
    tablesNamed("12");
    seat("12", 2);
    addOrder("12", 300);
    tick(2);
    addPrint(`12-${String(Date.parse(nowIso()))}`);
    tick(1);
    await db.FinalizeOnlinePayment(SLUG, "12", "pay_12");
    tick(3);
    seat("12", 2);
    addOrder("12", 150);
    expect(await printCounts("12")).toEqual({ bill: 0, guard: 0, tile: 0 });
  });
});

// ===========================================================================
describe("3. a moved ticket takes the destination's guest", () => {
  const ACME = { customer: "Acme Pvt Ltd", customer_gstin: "29ABCDE1234F1Z5", customer_address: "Tower B\nMG Road" };
  const identity = async (name: string) => {
    const b = await db.GetBillForTable(SLUG, name);
    return b ? { customer: b.customer, customer_gstin: b.customer_gstin, customer_address: b.customer_address } : null;
  };

  function namedTwelve(): string {
    tablesNamed("12", "15");
    seat("12", 2);
    const t = addOrder("12", 450);
    const o = orders().find((x) => x.id === t.id)!;
    setOrderFood(o.id, { ...o.food, ...ACME });
    addOrder("12", 100, { food: { table: "12", subtotal: 100, total: 100, items: [], ...ACME } });
    return t.id;
  }

  test("onto an unnamed 15: the ticket becomes 15's 'Guest' with no GSTIN or address, and 15's paper is unchanged", async () => {
    const ticket = namedTwelve();
    // 15's own order is YOUNGER than the ticket, so after the move the ticket is
    // 15's oldest order — the one its paper's identity is read from first.
    tick(1);
    seat("15", 2);
    addOrder("15", 90);
    tick(2);
    const before = await identity("15");
    await db.MoveOrderToTable(SLUG, ticket, "15");
    const food = orders().find((o) => o.id === ticket)!.food;
    expect(food.customer).toBe("Guest");
    expect(food).not.toHaveProperty("customer_gstin");
    expect(food).not.toHaveProperty("customer_address");
    expect(await identity("15")).toEqual(before);
    expect(before).toEqual({ customer: null, customer_gstin: null, customer_address: null });
    // 12 keeps its own guest (its other order carries it).
    expect(await identity("12")).toEqual(ACME);
  });

  test("onto a named 15: the ticket carries 15's guest, so 15's paper still names Beta", async () => {
    const ticket = namedTwelve();
    tick(1);
    seat("15", 2);
    const BETA = { customer: "Beta LLP", customer_gstin: "27AAACB1234C1Z9", customer_address: "Plot 4" };
    addOrder("15", 90, { food: { table: "15", subtotal: 90, total: 90, items: [], ...BETA } });
    const before = await identity("15");
    await db.MoveOrderToTable(SLUG, ticket, "15");
    expect(orders().find((o) => o.id === ticket)!.food).toMatchObject(BETA);
    expect(await identity("15")).toEqual(before);
    expect(before).toEqual(BETA);
  });

  test("12 KEEPS its guest when only the moved ticket carried it (named, then ordered on again)", async () => {
    tablesNamed("12", "15");
    seat("12", 2);
    const first = addOrder("12", 450);
    setOrderFood(first.id, { ...orders().find((x) => x.id === first.id)!.food, ...ACME });
    tick(1);
    const later = addOrder("12", 100);
    const before = await identity("12");
    expect(before).toEqual(ACME);
    await db.MoveOrderToTable(SLUG, first.id, "15");
    expect(await identity("12")).toEqual(before);
    expect(orders().find((o) => o.id === later.id)!.food).toMatchObject(ACME);
    // ...and 15 (free) is handed none of it.
    expect(await identity("15")).toEqual({ customer: null, customer_gstin: null, customer_address: null });
  });

  test("a value an order left behind already carries is never overwritten", async () => {
    tablesNamed("12", "15");
    seat("12", 2);
    const first = addOrder("12", 450);
    setOrderFood(first.id, { ...orders().find((x) => x.id === first.id)!.food, ...ACME });
    tick(1);
    const later = addOrder("12", 100, { food: { table: "12", subtotal: 100, total: 100, items: [], customer: "Bob", customer_gstin: "27AAACB1234C1Z9" } });
    await db.MoveOrderToTable(SLUG, first.id, "15");
    expect(orders().find((o) => o.id === later.id)!.food).toMatchObject({ customer: "Bob", customer_gstin: "27AAACB1234C1Z9", customer_address: ACME.customer_address });
  });

  test("onto a FREE 15: nobody's guest travels", async () => {
    const ticket = namedTwelve();
    await db.MoveOrderToTable(SLUG, ticket, "15");
    expect(await identity("15")).toEqual({ customer: null, customer_gstin: null, customer_address: null });
  });
});

// ===========================================================================
describe("4. the rules, pure", () => {
  test("orderArrivedAt: table_since, else the latest move onto THIS table, else created_at", () => {
    const created = "2026-09-14T10:17:00.000Z";
    expect(orderArrivedAt({}, "14", created)).toBe(Date.parse(created));
    expect(orderArrivedAt({ table_since: "2026-09-14T10:34:00.123456+00:00" }, "14", created)).toBe(Date.parse("2026-09-14T10:34:00.123Z"));
    const moves = [
      { from_table: "12", to_table: "14", at: "2026-09-14T10:20:00.000Z", by: null },
      { from_table: "14", to_table: "15", at: "2026-09-14T10:25:00.000Z", by: null },
      { from_table: "15", to_table: " 14 ", at: "2026-09-14T10:30:00.000Z", by: null },
    ];
    expect(orderArrivedAt({ moves }, "14", created)).toBe(Date.parse("2026-09-14T10:30:00.000Z"));
    expect(orderArrivedAt({ moves }, "15", created)).toBe(Date.parse("2026-09-14T10:25:00.000Z"));
    // A move onto another name, a malformed instant, a non-array: created_at.
    expect(orderArrivedAt({ moves }, "20", created)).toBe(Date.parse(created));
    expect(orderArrivedAt({ moves: [{ to_table: "14", at: "yesterday" }] }, "14", created)).toBe(Date.parse(created));
    expect(orderArrivedAt({ moves: "x", table_since: "not a time" }, "14", created)).toBe(Date.parse(created));
    // The stamp outranks the history.
    expect(orderArrivedAt({ moves, table_since: "2026-09-14T11:00:00Z" }, "14", created)).toBe(Date.parse("2026-09-14T11:00:00Z"));
    expect(orderArrivedAt({}, "14", null)).toBeNull();
  });

  test("the seating identity is GetBillForTable's: first real name, first GSTIN, first address — each on its own", () => {
    expect(seatingIdentityOf([
      { customer: "Guest" }, { customer: " QR guest " }, { customer: "  Acme  ", customer_address: "null" },
      { customer: "Bob", customer_gstin: " 29ABCDE1234F1Z5 " }, { customer_address: "Tower B" },
    ])).toEqual({ customer: "Acme", customer_gstin: "29ABCDE1234F1Z5", customer_address: "Tower B" });
    expect(seatingIdentityOf([])).toEqual({ customer: null, customer_gstin: null, customer_address: null });
  });

  test("withSeatingIdentity replaces all three; withFilledSeatingIdentity only fills what is missing", () => {
    const acme = { customer: "Acme", customer_gstin: "29ABCDE1234F1Z5", customer_address: "Tower B" };
    const none = { customer: null, customer_gstin: null, customer_address: null };
    const food = { table: "12", customer: "Zed", customer_gstin: "X", customer_address: "Y", items: [1] };
    expect(withSeatingIdentity(food, none)).toEqual({ table: "12", customer: "Guest", items: [1] });
    expect(withSeatingIdentity(food, acme)).toEqual({ table: "12", items: [1], ...acme });
    expect(withFilledSeatingIdentity(food, acme)).toBeNull();
    expect(withFilledSeatingIdentity({ customer: "Guest" }, acme)).toEqual(acme);
    expect(withFilledSeatingIdentity({ customer: "qr guest", customer_gstin: "null" }, { ...acme, customer_address: null })).toEqual({ customer: "Acme", customer_gstin: acme.customer_gstin });
    expect(withFilledSeatingIdentity({ customer: "Guest" }, none)).toBeNull();
  });

  test("seatingStartFor: the open seating is a floor no order move reaches; without one, the old rule", () => {
    const at = (hm: string) => `2026-09-16T${hm}:00.000Z`;
    // No seating: the earlier of the bill row and the first order.
    expect(seatingStartFor({ billCreatedAt: at("08:05"), firstOrderAt: at("07:58"), firstArrivalAt: at("08:10") })?.toISOString()).toBe(at("07:58"));
    expect(seatingStartFor({})).toBeNull();
    // A seating: the earliest of it, the bill row and the first ARRIVAL.
    expect(seatingStartFor({ sessionSeatedAt: at("08:00"), firstOrderAt: at("07:00"), firstArrivalAt: at("08:30") })?.toISOString()).toBe(at("08:00"));
    expect(seatingStartFor({ sessionSeatedAt: at("08:10"), billCreatedAt: at("08:20"), firstArrivalAt: at("07:50") })?.toISOString()).toBe(at("07:50"));
    expect(seatingStartFor({ sessionSeatedAt: at("08:10"), billCreatedAt: at("08:05") })?.toISOString()).toBe(at("08:05"));
    // No arrival given: the first order stands in for it.
    expect(seatingStartFor({ sessionSeatedAt: at("08:10"), firstOrderAt: at("08:01") })?.toISOString()).toBe(at("08:01"));
    // A seating alone still bounds (a seated table with nothing on it yet).
    expect(seatingStartFor({ sessionSeatedAt: at("08:10") })?.toISOString()).toBe(at("08:10"));
  });
});
