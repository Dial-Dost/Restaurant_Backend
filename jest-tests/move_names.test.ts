// CLIENT ITEM 4 (2026-09-17) — "Right now there are no item names visible when
// an order is moved from one table to another. This needs to be visible and
// implemented correctly." — against the REAL MoveOrderToTable, MoveBillItem and
// MoveTableParty over table_move_fixtures.ts.
//
// WHAT WAS WRONG, as production stored it (GGV, 2026-09-14):
//
//   * "Move an order" (KOT-65, 12 -> 15): the order kept its dishes but nothing
//     on it said it had moved, and the result the route builds its audit line
//     from named no dish — the line read "Moved order 5a4099ef-… from 12 to 15".
//   * "Move to another table" on a line (NOT YOUR PUCHKA, 31A -> 31): the source
//     ticket became "Cancelled · 0 item(s)" naming nothing, and the dish arrived
//     as a new "Moved item" order rebuilt from { id, name, price, quantity } —
//     no size, no note, no hold, no menu id, no order-taker. A COMPED dish
//     arrived chargeable: 0 to pay on 31A became 469 to pay on 31, for food the
//     NC ledger still says was given away.
//
// WHAT THIS PINS: the moved order names its dishes and its history; a dish move
// carries every line whole, per source order, with where it came from and the
// KOT it was cooked under; the source records what left and where; the money is
// conserved line for line; a comp is refused before a single row changes; and
// the stage and the kitchen clock travel with the food.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import {
  RESTAURANT_SLUG,
  addBill,
  addOrder,
  addTable,
  bills,
  orders,
  resetStore,
  tableByName,
} from "./table_move_fixtures";

jest.mock("pg", () => {
  interface FixtureGlobal {
    __tableMoveFixtureConnect?: () => { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; release: () => void };
  }
  const conn = () => {
    const make = (globalThis as unknown as FixtureGlobal).__tableMoveFixtureConnect;
    if (!make) {throw new Error("table move fixture harness was not loaded");}
    return make();
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> { return conn().query(sql, params); }
    connect(): Promise<unknown> { return Promise.resolve(conn()); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

type Db = typeof import("../database_supabase");
let db: Db;

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
});

beforeEach(() => {
  resetStore();
  db.__resetSectionOrderProbe();
});

type Line = Record<string, unknown>;
const GGV_LINES: Line[] = [
  { id: "a8fe0bc8", name: "KUNAFA BIRDS NEST", price: 489, menu_id: "a8fe0bc8", quantity: 1 },
  { id: "fd41af86", name: "STIR FRIED WATERCHESTNUT", price: 419, menu_id: "fd41af86", quantity: 1, note: "less spicy" },
  { id: "43ce3048", name: "TRUFFLE CREAM CHEESE", price: 519, menu_id: "43ce3048", quantity: 1 },
];

const sumLines = (lines: Line[]): number => lines.reduce((s, l) => s + Number(l.price) * Number(l.quantity), 0);

/** Every order's chargeable total on a table, as the bill sums it. */
const tableTotal = (tableId: string): number => orders()
  .filter((o) => o.table_id === tableId && !["4", "5", "7"].includes(o.status))
  .reduce((s, o) => s + Number((o.food as { subtotal?: unknown }).subtotal ?? 0), 0);

// ===========================================================================
describe("MoveOrderToTable — the ticket names its dishes and where it came from", () => {
  test("the result names every dish (no price) and the order carries the move", async () => {
    const t12 = addTable({ table_name: "12", is_occupied: true, num_covers: 4 });
    const t15 = addTable({ table_name: "15", is_occupied: true, num_covers: 2 });
    const o = addOrder({ table_id: t12.id, food: { id: "o", table: "12", customer: "Guest", items: GGV_LINES, subtotal: 1427, total: 1427, taken_by_employee_name: "Vineet Khanna" } });
    addBill({ table_id: t12.id, total_amt: 1427 });

    const res = await db.MoveOrderToTable(RESTAURANT_SLUG, o.id, "15", { by: "nirav" });

    expect(res.items).toEqual([
      { name: "KUNAFA BIRDS NEST", variation: null, quantity: 1 },
      { name: "STIR FRIED WATERCHESTNUT", variation: null, quantity: 1 },
      { name: "TRUFFLE CREAM CHEESE", variation: null, quantity: 1 },
    ]);
    expect(JSON.stringify(res.items)).not.toMatch(/price|489|419|519/);
    expect(res.kot_nos).toEqual([]);
    const moved = orders().find((x) => x.id === o.id)!;
    expect(moved.table_id).toBe(t15.id);
    expect(moved.food.table).toBe("15");
    expect(moved.food.moves).toEqual([
      { from_table: "12", to_table: "15", at: expect.any(String), by: "nirav" },
    ]);
    // Every other key survives: the lines, the order-taker, the money.
    expect(moved.food.items).toEqual(GGV_LINES);
    expect(moved.food.taken_by_employee_name).toBe("Vineet Khanna");
    expect(moved.food.subtotal).toBe(1427);
  });

  test("a second move appends — the history is kept, the latest last", async () => {
    const a = addTable({ table_name: "12", is_occupied: true });
    addTable({ table_name: "15", is_occupied: true });
    addTable({ table_name: "16" });
    const o = addOrder({ table_id: a.id, food: { table: "12", items: GGV_LINES, subtotal: 1427, total: 1427 } });
    await db.MoveOrderToTable(RESTAURANT_SLUG, o.id, "15");
    await db.MoveOrderToTable(RESTAURANT_SLUG, o.id, "16");
    const moves = orders().find((x) => x.id === o.id)!.food.moves as { from_table: string; to_table: string; by: unknown }[];
    expect(moves.map((m) => `${m.from_table}->${m.to_table}`)).toEqual(["12->15", "15->16"]);
    expect(moves[0]!.by).toBeNull();
  });

  test("a split order is named from its split, as GET /orders reads it", async () => {
    const a = addTable({ table_name: "12", is_occupied: true });
    addTable({ table_name: "15" });
    const o = addOrder({
      table_id: a.id,
      food: {
        table: "12", items: [{ id: "stale", name: "Stale", price: 1, quantity: 1 }],
        items_split: [["Served", [{ id: "s1", name: "Dal", price: 200, quantity: 2, variation_name: "Half" }]], ["Preparing", [{ id: "p1", name: "Roti", price: 30, quantity: 4 }]]],
        subtotal: 520, total: 520,
      },
    });
    const res = await db.MoveOrderToTable(RESTAURANT_SLUG, o.id, "15");
    expect(res.items).toEqual([
      { name: "Dal", variation: "Half", quantity: 2 },
      { name: "Roti", variation: null, quantity: 4 },
    ]);
  });
});

// ===========================================================================
describe("MoveBillItem — the dish arrives whole", () => {
  function tables31(): { a31: string; t31: string } {
    const a31 = addTable({ table_name: "31A", is_occupied: true, num_covers: 3 });
    const t31 = addTable({ table_name: "31", is_occupied: true, num_covers: 2 });
    return { a31: a31.id, t31: t31.id };
  }

  test("every key of the line comes across, on a Guest order that names the table, the order and the KOT it came from", async () => {
    const { a31, t31 } = tables31();
    const src = addOrder({
      table_id: a31,
      status: "1",
      barked_at: "2026-09-14T09:40:00.000Z",
      food: {
        id: "src", table: "31A", customer: "Guest", order_type: "dine_in", note: "no peanuts",
        taken_by_employee_id: "emp-atsu", taken_by_employee_name: "Atsu", taken_by_employee_role: "waiter",
        items: [
          { id: "l1", name: "NOT YOUR PUCHKA", price: 469, quantity: 1, menu_id: "m-puchka", note: "extra chutney" },
          { id: "l2", name: "PANEER KHURCHAN TACOS", price: 479, quantity: 1, menu_id: "m-tacos", variation_id: "v-half", variation_name: "Half", course_hold: true },
        ],
        subtotal: 948, total: 948,
      },
    });
    addBill({ table_id: a31, total_amt: 948 });
    addBill({ table_id: t31, total_amt: 1000 });
    const before = tableTotal(a31) + tableTotal(t31);

    const r = await db.MoveBillItem(RESTAURANT_SLUG, "31A", "31", "PANEER KHURCHAN TACOS", 479, {
      by: "nirav",
      kotNosByOrder: new Map([[src.id, [35]]]),
    });

    const dest = orders().filter((o) => o.table_id === t31);
    expect(dest).toHaveLength(1);
    const d = dest[0]!;
    expect(d.food.customer).toBe("Guest");
    expect(d.food.taken_by_employee_name).toBe("Atsu");
    expect(d.food.taken_by_employee_id).toBe("emp-atsu");
    expect(d.food.order_type).toBe("dine_in");
    expect(d.food.note).toBe("no peanuts");
    expect(d.food.items).toEqual([
      { id: "l2", name: "PANEER KHURCHAN TACOS", price: 479, quantity: 1, menu_id: "m-tacos", variation_id: "v-half", variation_name: "Half", course_hold: true },
    ]);
    expect(d.food.moved_from).toEqual({ table: "31A", order_id: src.id, kot_nos: [35], at: expect.any(String), by: "nirav" });
    // The stage and the kitchen clock travel with the food.
    expect(d.status).toBe("1");
    expect(d.barked_at).toBe("2026-09-14T09:40:00.000Z");
    // The answer names the dish (no price) and the destination order.
    expect(r.items).toEqual([{ name: "PANEER KHURCHAN TACOS", variation: "Half", quantity: 1 }]);
    expect(r.destinations).toEqual([{ order_id: d.id, source_order_id: src.id, kot_nos: [35], items: r.items }]);
    // The summary the route has always answered with is still there.
    expect(r.moved).toMatchObject({ name: "PANEER KHURCHAN TACOS", price: 479, quantity: 1, value: 479 });

    // THE SOURCE records what left and where; it is not emptied, so no stamp.
    const s = orders().find((o) => o.id === src.id)!;
    expect(s.status).toBe("1");
    expect((s.food.items as Line[]).map((l) => l.name)).toEqual(["NOT YOUR PUCHKA"]);
    expect(s.food.moved_items).toEqual([
      expect.objectContaining({ id: "l2", name: "PANEER KHURCHAN TACOS", variation_name: "Half", to_table: "31", to_order_id: d.id, moved_at: expect.any(String) }),
    ]);
    expect(s.food.emptied_by).toBeUndefined();
    expect(s.food.removed_items).toBeUndefined();

    // MONEY IS CONSERVED, line for line, and both bills say so.
    expect(tableTotal(a31) + tableTotal(t31)).toBe(before);
    expect(tableTotal(a31)).toBe(469);
    expect(bills().find((b) => b.table_id === a31)!.total_amt).toBe(469);
    expect(bills().find((b) => b.table_id === t31)!.total_amt).toBe(479);
  });

  test("the LAST dish leaving empties the source as a MOVE, and it still says what left", async () => {
    const { a31, t31 } = tables31();
    const src = addOrder({ table_id: a31, food: { table: "31A", items: [{ id: "l1", name: "NOT YOUR PUCHKA", price: 469, quantity: 1 }], subtotal: 469, total: 469 } });
    await db.MoveBillItem(RESTAURANT_SLUG, "31A", "31", "NOT YOUR PUCHKA", 469);
    const s = orders().find((o) => o.id === src.id)!;
    expect(s.status).toBe("5");
    expect(s.food.items).toEqual([]);
    expect(s.food.emptied_by).toBe("move");
    expect((s.food.moved_items as Line[]).map((l) => [l.name, l.quantity, l.to_table])).toEqual([["NOT YOUR PUCHKA", 1, "31"]]);
    // A move is never a void: the removal list the Void KOT report reads stays absent.
    expect(s.food.removed_items).toBeUndefined();
    expect(orders().filter((o) => o.table_id === t31)).toHaveLength(1);
  });

  test("one destination order PER SOURCE order, each naming its own ticket", async () => {
    const { a31, t31 } = tables31();
    const first = addOrder({ table_id: a31, created_at: "2026-09-14T09:00:00.000Z", food: { table: "31A", items: [{ id: "a", name: "Dal", price: 200, quantity: 1 }], subtotal: 200, total: 200 } });
    const second = addOrder({ table_id: a31, created_at: "2026-09-14T09:30:00.000Z", food: { table: "31A", items: [{ id: "b", name: "Dal", price: 120, quantity: 2, variation_name: "Half" }], subtotal: 240, total: 240 } });
    const r = await db.MoveBillItem(RESTAURANT_SLUG, "31A", "31", "Dal", 0, {
      kotNosByOrder: new Map([[first.id, [7]], [second.id, []]]),
    });
    const dest = orders().filter((o) => o.table_id === t31);
    expect(dest).toHaveLength(2);
    expect(r.destinations.map((d) => [d.source_order_id, d.kot_nos])).toEqual([[first.id, [7]], [second.id, []]]);
    // Two prices, two lines, the same money on both sides.
    expect(dest.map((d) => d.food.subtotal)).toEqual([200, 240]);
    expect(tableTotal(t31)).toBe(440);
    expect(r.moved.value).toBe(440);
  });

  // REVIEW FINDING — THE SECOND DOCKET. Production barks almost no ticket (GGV:
  // 1 of 80 printed orders in a fortnight), so a moved dish's source is almost
  // always un-barked. Copied across as-is, the destination offered "Bark ->
  // kitchen", and the bark's automatic print found no memo for (31, the dish) —
  // the move's docket is PINNED and memoises nothing — and printed the dish
  // again under a NEW number. A ticketed dish arrives barked, as it did before.
  test("an UN-barked but ticketed dish arrives barked, so the destination's bark prints nothing", async () => {
    const { a31, t31 } = tables31();
    const src = addOrder({
      table_id: a31, status: "1", barked_at: null,
      food: { table: "31A", items: [{ id: "l1", name: "NOT YOUR PUCHKA", price: 469, quantity: 1 }, { id: "l2", name: "Chai", price: 40, quantity: 1 }], subtotal: 509, total: 509 },
    });
    const r = await db.MoveBillItem(RESTAURANT_SLUG, "31A", "31", "NOT YOUR PUCHKA", 469, {
      kotNosByOrder: new Map([[src.id, [35]]]),
    });
    const d = orders().find((o) => o.table_id === t31)!;
    expect(d.barked_at).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(String(d.barked_at)))).toBe(false);
    // The source is not touched: it was un-barked and stays so.
    expect(orders().find((o) => o.id === src.id)!.barked_at).toBeNull();
    // THE BARK: BarkOrder's compare-and-set answers already_barked, which is
    // what stops POST /orders/:id/bark before autoPrintOrderKot (routes/orders.ts).
    const bark = await db.BarkOrder(RESTAURANT_SLUG, r.destinations[0]!.order_id, "expo");
    expect(bark).toEqual({ barked_at: d.barked_at, already_barked: true });
  });

  test("a dish the kitchen was never given paper for keeps its source's un-barked state", async () => {
    const { a31, t31 } = tables31();
    const src = addOrder({
      table_id: a31, status: "1", barked_at: null,
      food: { table: "31A", items: [{ id: "l1", name: "NOT YOUR PUCHKA", price: 469, quantity: 1 }], subtotal: 469, total: 469 },
    });
    await db.MoveBillItem(RESTAURANT_SLUG, "31A", "31", "NOT YOUR PUCHKA", 469, { kotNosByOrder: new Map([[src.id, []]]) });
    expect(orders().find((o) => o.table_id === t31)!.barked_at ?? null).toBeNull();
  });

  test("Served stays Served, Pending stays Pending, and a split keeps its labels", async () => {
    const { a31, t31 } = tables31();
    addOrder({
      table_id: a31, status: "2", barked_at: "2026-09-14T09:00:00.000Z",
      food: { table: "31A", items: [{ id: "s", name: "Soup", price: 150, quantity: 1 }], items_split: [["Served", [{ id: "s", name: "Soup", price: 150, quantity: 1 }]], ["Preparing", []]], subtotal: 150, total: 150 },
    });
    addOrder({ table_id: a31, status: "8", barked_at: null, food: { table: "31A", items: [{ id: "q", name: "Soup", price: 150, quantity: 1 }], subtotal: 150, total: 150 } });
    await db.MoveBillItem(RESTAURANT_SLUG, "31A", "31", "Soup", 150);
    const dest = orders().filter((o) => o.table_id === t31).sort((x, y) => x.status.localeCompare(y.status));
    expect(dest.map((d) => [d.status, d.food.status, d.barked_at ?? null])).toEqual([
      ["2", "Served", "2026-09-14T09:00:00.000Z"],
      ["8", "Pending", null],
    ]);
    expect(dest[0]!.food.items_split).toEqual([["Served", [expect.objectContaining({ id: "s" })]], ["Preparing", []]]);
    expect(dest[1]!.food.items_split).toBeUndefined();
  });

  test("A COMPED DISH IS REFUSED — 'reverse the comp first' — and not one row changes", async () => {
    const { a31, t31 } = tables31();
    const src = addOrder({
      table_id: a31,
      food: {
        table: "31A",
        items: [
          { id: "l1", name: "NOT YOUR PUCHKA", price: 469, quantity: 1, nc: true, nc_id: "nc-1", nc_kind: "complimentary" },
          { id: "l2", name: "MOCKMEAT SAMOSA", price: 399, quantity: 1 },
        ],
        subtotal: 399, total: 399, nc_subtotal: 469,
      },
    });
    addBill({ table_id: a31, total_amt: 399 });
    addBill({ table_id: t31, total_amt: 0 });
    const snapshot = JSON.stringify({ o: orders(), b: bills(), t: tableByName("31") });

    await expect(db.MoveBillItem(RESTAURANT_SLUG, "31A", "31", "NOT YOUR PUCHKA", 469))
      .rejects.toThrow("NOT YOUR PUCHKA is non-chargeable on 31A. Reverse the comp first, then move it.");
    expect(JSON.stringify({ o: orders(), b: bills(), t: tableByName("31") })).toBe(snapshot);
    expect(orders().find((o) => o.id === src.id)!.food.nc_subtotal).toBe(469);
  });

  test("a price of 0 (any price) that sweeps a comped line with a chargeable one is refused whole", async () => {
    const { a31 } = tables31();
    addOrder({ table_id: a31, food: { table: "31A", items: [{ id: "x", name: "Chai", price: 40, quantity: 1 }], subtotal: 40, total: 40 } });
    addOrder({ table_id: a31, food: { table: "31A", items: [{ id: "y", name: "Chai", price: 40, quantity: 1, nc: true, nc_id: "n" }], subtotal: 0, total: 0, nc_subtotal: 40 } });
    const before = JSON.stringify(orders());
    await expect(db.MoveBillItem(RESTAURANT_SLUG, "31A", "31", "Chai", 0)).rejects.toThrow(/Reverse the comp first/);
    expect(JSON.stringify(orders())).toBe(before);
  });

  test("RemoveBillItem answers exactly the summary it always did — the whole source orders stay inside", async () => {
    const { a31 } = tables31();
    addOrder({ table_id: a31, food: { table: "31A", items: [{ id: "l1", name: "Dal", price: 200, quantity: 1 }], subtotal: 200, total: 200 } });
    const r = await db.RemoveBillItem(RESTAURANT_SLUG, "31A", "Dal", 200);
    expect(Object.keys(r.removed).sort()).toEqual(["lines", "name", "price", "quantity", "value"]);
  });
});

// ===========================================================================
describe("MoveTableParty — the tickets that travelled", () => {
  test("names the orders and their dishes, never a price", async () => {
    const t1 = addTable({ table_name: "T1", capacity: 4, is_occupied: true, num_covers: 2 });
    addTable({ table_name: "T2", capacity: 6 });
    const a = addOrder({ table_id: t1.id, food: { table: "T1", items: [{ id: "1", name: "Dal", price: 200, quantity: 2 }], subtotal: 400, total: 400 } });
    const b = addOrder({ table_id: t1.id, food: { table: "T1", items: [{ id: "2", name: "Naan", price: 50, quantity: 1, variation_name: "Butter" }], subtotal: 50, total: 50 } });
    const r = await db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2");
    expect(r.moved_order_ids).toEqual([a.id, b.id]);
    expect(r.moved_items).toEqual([
      { name: "Dal", variation: null, quantity: 2 },
      { name: "Naan", variation: "Butter", quantity: 1 },
    ]);
  });
});
