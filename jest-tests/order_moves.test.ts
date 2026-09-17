// CLIENT ITEM 4 — the pure vocabulary of a move (order_moves.ts), and the two
// report rules it touches (mis_report_math.ts): what is stamped, what GET
// /orders says about it, and what the audit trail and Bill Edit read.
import { describe, test, expect } from "@jest/globals";
import {
  appendOrderMove,
  carriedLine,
  comppedMoveRefusal,
  holdsComppedLine,
  kotHandles,
  moveItemAuditSentence,
  moveOrderAuditSentence,
  movedDestinationFood,
  movedDish,
  movedFromKotNos,
  movedOrderStatusCode,
  orderDishes,
  orderMoveProvenance,
  storedLinesOf,
} from "../order_moves";
import { classifyBillEdit, MOVED_LINES_KEY, REMOVED_LINES_KEY, stampLineRemoval, voidKotLines } from "../mis_report_math";

const CATCH_ALL = "4ad474d4-5230-449c-874f-6a238b833bca";

describe("what a move names", () => {
  test("a dish is its name, its size and a whole quantity — never a price", () => {
    expect(movedDish({ name: " Biryani ", variation_name: "Half", quantity: "2", price: 400 })).toEqual({ name: "Biryani", variation: "Half", quantity: 2 });
    expect(movedDish({ price: 1 })).toEqual({ name: "Item", variation: null, quantity: 1 });
    expect(movedDish({ name: "Chai", quantity: 0 })).toEqual({ name: "Chai", variation: null, quantity: 1 });
    expect(movedDish(null)).toEqual({ name: "Item", variation: null, quantity: 1 });
  });

  test("an order's dishes are read the way GET /orders reads them — split first, legacy tuples flattened", () => {
    expect(orderDishes({ items: [{ name: "A", quantity: 1 }] }).map((d) => d.name)).toEqual(["A"]);
    expect(orderDishes({ items: [{ name: "stale" }], items_split: [["Served", [{ name: "S" }]], ["Preparing", [{ name: "P" }]]] }).map((d) => d.name)).toEqual(["S", "P"]);
    expect(orderDishes({ items: [["Served", [{ name: "T" }]]] }).map((d) => d.name)).toEqual(["T"]);
    expect(orderDishes({ items: [{ name: "A" }], items_split: [] }).map((d) => d.name)).toEqual(["A"]);
    expect(storedLinesOf({})).toEqual([]);
  });

  test("KOT handles are de-duplicated, whole and positive", () => {
    expect(kotHandles([65])).toBe("KOT-65");
    expect(kotHandles([65, 65, 66.2, 0, -3, Number.NaN])).toBe("KOT-65, KOT-66");
    expect(kotHandles([])).toBe("");
  });
});

describe("the move-order audit line", () => {
  const dishes = [
    { name: "KUNAFA BIRDS NEST", variation: null, quantity: 1 },
    { name: "Dal", variation: "Half", quantity: 2 },
  ];

  test("names the KOT and every dish — the production line named a UUID", () => {
    expect(moveOrderAuditSentence({ kotNos: [65], dishes, fromTable: "12", toTable: "15", printed: true }))
      .toBe("Moved KOT-65 (KUNAFA BIRDS NEST x1; Dal (Half) x2) from 12 to 15 (correction docket printed)");
  });

  test("an unticketed order is 'order', and says why nothing printed", () => {
    expect(moveOrderAuditSentence({ kotNos: [], dishes, fromTable: "12", toTable: "15", printed: false, printReason: "never_ticketed" }))
      .toBe("Moved order (KUNAFA BIRDS NEST x1; Dal (Half) x2) from 12 to 15 (no docket was on the pass)");
    expect(moveOrderAuditSentence({ kotNos: [3], dishes: [], fromTable: "1", toTable: "2", printed: false, printReason: "disabled" }))
      .toBe("Moved KOT-3 from 1 to 2 (automatic dockets are off)");
    expect(moveOrderAuditSentence({ kotNos: [3], dishes: [], fromTable: "1", toTable: "2", printed: false, printReason: "print_failed" }))
      .toBe("Moved KOT-3 from 1 to 2 (the correction docket did not print)");
    expect(moveOrderAuditSentence({ kotNos: [3], dishes: [], fromTable: "1", toTable: "2", printed: false }))
      .toBe("Moved KOT-3 from 1 to 2 (no correction docket printed)");
  });

  test("Bill Edit now classifies it — and every older wording — as an order move", () => {
    for (const reason of [
      "Moved KOT-65 (KUNAFA BIRDS NEST x1) from 12 to 15 (correction docket printed)",
      "Moved order (Dal x2) from 12 to 15 (no docket was on the pass)",
      "Moved order 5a4099ef-98c9-4310-9237-f44b98dc7bac from 12 to 15 (correction docket KOT-65 printed)",
    ]) {
      const c = classifyBillEdit(CATCH_ALL, reason, { table: "15", from: "12", to: "15", item: "KUNAFA BIRDS NEST x1", order_id: "o-1" });
      expect(c).toMatchObject({ kind: "order_moved", label: "Order moved to another table", table: "15", item: "KUNAFA BIRDS NEST x1", order_id: "o-1" });
    }
  });

  test("…but not a party move, nor a dish move, nor a word that merely starts the same", () => {
    expect(classifyBillEdit(CATCH_ALL, "Moved the party at 15 to 12 (2 covers, 4 orders, bill carried)", {})).toBeNull();
    expect(classifyBillEdit(CATCH_ALL, "Moved item Dal x1 from T4 (KOT-3) to T7", { from: "T4", to: "T7" })?.kind).toBe("item_moved");
    expect(classifyBillEdit(CATCH_ALL, "Moved orders around", {})).toBeNull();
    expect(classifyBillEdit(CATCH_ALL, "Moved kotwali", {})).toBeNull();
  });
});

describe("the move-item audit line", () => {
  test("names the dish, the quantity and the KOT, and keeps the prefix Bill Edit keys on", () => {
    const s = moveItemAuditSentence({ dishes: [{ name: "NOT YOUR PUCHKA", variation: null, quantity: 1 }], fallbackName: "x", fromTable: "31A", toTable: "31", kotNos: [35] });
    expect(s).toBe("Moved item NOT YOUR PUCHKA x1 from 31A (KOT-35) to 31");
    expect(classifyBillEdit(CATCH_ALL, s, { from: "31A", to: "31" })?.kind).toBe("item_moved");
  });

  test("no KOT, no brackets; no dishes, the requested name", () => {
    expect(moveItemAuditSentence({ dishes: [], fallbackName: "Dal", fromTable: "1", toTable: "2", kotNos: [] }))
      .toBe("Moved item Dal from 1 to 2");
  });
});

describe("the stamps", () => {
  test("appendOrderMove keeps every key and appends in order", () => {
    const food = { table: "12", items: [{ name: "A" }], subtotal: 10, moves: [{ from_table: "9", to_table: "12", at: "t0", by: null }] };
    const out = appendOrderMove(food, { from_table: "12", to_table: "15", at: "t1", by: "nirav" });
    expect(out).toEqual({ ...food, table: "15", moves: [food.moves[0], { from_table: "12", to_table: "15", at: "t1", by: "nirav" }] });
    // Pure: the input is untouched.
    expect(food.table).toBe("12");
    expect(food.moves).toHaveLength(1);
  });

  test("a move stamps MOVED_LINES_KEY and never the removal list the void report reads", () => {
    const line = { id: "l1", name: "Dal", price: 200, quantity: 1 };
    const out = stampLineRemoval({ items: [] }, [line], "move", true, "T", { to_table: "31", to_order_id: "new-1" });
    expect(out[MOVED_LINES_KEY]).toEqual([{ ...line, moved_at: "T", to_table: "31", to_order_id: "new-1" }]);
    expect(out[REMOVED_LINES_KEY]).toBeUndefined();
    expect(out.emptied_by).toBe("move");
    // …so the Void KOT line list of an emptied, moved ticket is still empty.
    expect(voidKotLines(out)).toEqual([]);
  });

  test("an earlier move's lines survive a later one, and a removal is recorded as before", () => {
    const first = stampLineRemoval({ items: [{ id: "b" }] }, [{ id: "a" }], "move", false, "T1", { to_table: "2", to_order_id: "x" });
    const second = stampLineRemoval(first, [{ id: "b" }], "remove", true, "T2", null);
    expect((second[MOVED_LINES_KEY] as unknown[]).length).toBe(1);
    expect(second[REMOVED_LINES_KEY]).toEqual([{ id: "b", removed_at: "T2" }]);
    expect(second.emptied_by).toBe("remove");
  });

  test("a move with no destination given records nothing new — the pre-2.0.2 behaviour", () => {
    const out = stampLineRemoval({ items: [] }, [{ id: "a" }], "move", true, "T");
    expect(out[MOVED_LINES_KEY]).toBeUndefined();
    expect(out.emptied_by).toBe("move");
  });
});

describe("what GET /orders says about a move", () => {
  test("nothing at all for an order that never moved", () => {
    expect(orderMoveProvenance({ items: [{ name: "A" }], subtotal: 1 })).toEqual({});
  });

  test("a whole-order move: the last table it came from", () => {
    expect(orderMoveProvenance({ moves: [
      { from_table: "9", to_table: "12", at: "2026-09-14T10:00:00Z" },
      { from_table: "12", to_table: "15", at: "2026-09-14T11:00:00Z" },
    ] })).toEqual({ moved_from: "12", moved_at: "2026-09-14T11:00:00Z" });
  });

  test("a dish-move order, and the later of the two when both are there", () => {
    expect(orderMoveProvenance({ moved_from: { table: "31A", order_id: "o", kot_nos: [35], at: "2026-09-14T09:00:00Z", by: null } }))
      .toEqual({ moved_from: "31A", moved_at: "2026-09-14T09:00:00Z" });
    expect(orderMoveProvenance({
      moved_from: { table: "31A", at: "2026-09-14T09:00:00Z" },
      moves: [{ from_table: "31", to_table: "40", at: "2026-09-14T10:00:00Z" }],
    }).moved_from).toBe("31");
  });

  test("an emptied source says what left and where — names and quantities, NO PRICE", () => {
    const p = orderMoveProvenance({
      items: [], emptied_by: "move",
      moved_items: [{ id: "l1", name: "NOT YOUR PUCHKA", price: 469, quantity: 1, nc_id: "x", moved_at: "T", to_table: "31", to_order_id: "n" }],
    });
    expect(p).toEqual({
      emptied_by: "move",
      moved_items: [{ name: "NOT YOUR PUCHKA", variation: null, quantity: 1, to_table: "31", moved_at: "T" }],
    });
    expect(JSON.stringify(p)).not.toMatch(/469|price|nc_id/);
  });

  test("a dish-move order's recorded KOT numbers, cleaned", () => {
    expect(movedFromKotNos({ moved_from: { kot_nos: [35, "35", 0, -1, "x", 36.4] } })).toEqual([35, 36]);
    expect(movedFromKotNos({ moved_from: "31A" })).toEqual([]);
    expect(movedFromKotNos({})).toEqual([]);
  });
});

describe("the dish-move destination", () => {
  test("a carried line keeps every key but the source's own history, at the clamped money", () => {
    expect(carriedLine({ id: "l", name: "Dal", price: -5, quantity: 2.4, note: "n", course_hold: true, fired_at: null, removed_at: "x", moved_at: "y", to_table: "z", to_order_id: "w" }, 0, 2))
      .toEqual({ id: "l", name: "Dal", price: 0, quantity: 2, note: "n", course_hold: true, fired_at: null });
  });

  test("the stage: Served and Pending travel, everything else is cooking", () => {
    expect([2, "2", 8, 1, 3, 6, null, "x"].map(movedOrderStatusCode)).toEqual([2, 2, 8, 1, 1, 1, 1, 1]);
  });

  test("a comp is refused in words, and any comped line in the sweep is found", () => {
    expect(comppedMoveRefusal("Dal", "31A")).toBe("Dal is non-chargeable on 31A. Reverse the comp first, then move it.");
    expect(holdsComppedLine([{ nc: true }])).toBe(true);
    expect(holdsComppedLine([{ nc: "true" }, { nc: 1 }, {}, null])).toBe(false);
  });

  test("the destination food: a Guest order, the source's taker/channel/note, moved_from, the money of its lines", () => {
    const food = movedDestinationFood({
      orderId: "new",
      toTable: "31",
      lines: [{ id: "a", name: "Dal", price: 200, quantity: 2 }, { id: "b", name: "Roti", price: 30, quantity: 1 }],
      source: { customer: "Moved item", taken_by_employee_id: "e", taken_by_employee_name: "Atsu", taken_by_employee_role: "waiter", order_type: "takeaway", note: " nuts " },
      statusLabel: "Preparing",
      movedFrom: { table: "31A", order_id: "src", kot_nos: [35], at: "T", by: null },
      splitLabelOf: (l) => (l.id === "a" ? "Served" : "Preparing"),
    });
    expect(food).toMatchObject({
      id: "new", table: "31", customer: "Guest",
      taken_by_employee_id: "e", taken_by_employee_name: "Atsu", taken_by_employee_role: "waiter",
      subtotal: 430, total: 430, status: "Preparing", order_type: "takeaway", note: "nuts",
      moved_from: { table: "31A", order_id: "src", kot_nos: [35], at: "T", by: null },
      items_split: [["Served", [{ id: "a", name: "Dal", price: 200, quantity: 2 }]], ["Preparing", [{ id: "b", name: "Roti", price: 30, quantity: 1 }]]],
    });
    const bare = movedDestinationFood({ orderId: "n", toTable: "1", lines: [], source: {}, statusLabel: "Served", movedFrom: { table: "2", order_id: "o", kot_nos: [], at: "T", by: null } });
    expect(bare).toMatchObject({ customer: "Guest", order_type: "dine_in", note: null, taken_by_employee_name: null, subtotal: 0 });
    expect(bare.items_split).toBeUndefined();
  });
});
