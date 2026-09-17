// SETTLE AS NC AFTER THE EVERYDAY WRITERS HAVE BEEN AT THE TABLE — review fixes.
//
// nc_settle_transaction.test.ts drives the settle on tables nothing else has
// touched. A live table is not like that: a dish is comped, then a waiter drags
// lines between Served and Preparing, deletes one, adds one, or an admin removes
// one from the bill. Each of those REWRITES the order, and each used to price
// the rewrite over every line, comped ones included. This file drives those
// writers and then the settle, over the same fake pg, and holds:
//
//   * the items-split writer (UpdateOrderItemsSplit) prices chargeable lines
//     only, keeps the server's comps, and cannot be used to make one — and a
//     Settle as NC afterwards goes through at the till's own quote;
//   * an order already STORING a figure written over its comps (the old
//     pricing) neither blocks the quote nor the ₹0 invariant: every owing order
//     is re-priced from its lines, and one with no lines is never zeroed;
//   * the writer never lands on top of a settle or a comp that committed
//     between its read and its write;
//   * a table of free lines only is not an NC bill;
//   * the admin remove-item path prices chargeable lines only;
//   * the settled NC bill reads back with its settlement, and a comped line at
//     0.00 marked nc — the facts the reprint and both drill-downs print;
//   * re-opening a bill made 'NC' by the ₹0 hardening reports nothing undone.

import { describe, test, expect, beforeAll, jest } from "@jest/globals";
import { computeBillCharges } from "../../billing_math";
import {
  TABLE_ID,
  clone,
  current,
  makeState,
  statements,
  useState,
  type NcFixtureLine,
  type NcFixtureOrder,
  type NcFixtureRow,
  type NcFixtureState,
} from "./nc_settle_fixture";

jest.mock("pg", () => {
  interface FixtureGlobal { __ncFixtureQuery?: (sql: string, params?: unknown[]) => { rows: unknown[] } }
  const run = (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const q = (globalThis as unknown as FixtureGlobal).__ncFixtureQuery;
    if (!q) {return Promise.reject(new Error("nc fixture harness was not loaded"));}
    try { return Promise.resolve(q(sql, params)); } catch (err) { return Promise.reject(err); }
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> { return run(sql, params); }
    connect(): Promise<{ query: typeof run; release: () => void }> {
      return Promise.resolve({ query: run, release: () => { /* pooled */ } });
    }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

type Db = typeof import("../../database_supabase");
let db: Db;
const RID = "zztest-nc";

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL ?? "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../../database_supabase");
});

const ORDER_1 = "11111111-1111-4111-8111-111111111111";
const ORDER_2 = "22222222-1111-4111-8111-222222222222";
const ACTOR = { employee_id: null, username: "cashier1", authorised_by_employee_id: null, authorised_by_username: "manager01" };
const PERM_NC = "b4e7a1c9-2d58-4f36-9a07-5c81e3b0d472";

const PANEER: NcFixtureLine = { id: "p", name: "Paneer Tikka", price: 350, quantity: 1 };
const JAMUN: NcFixtureLine = { id: "j", name: "Gulab Jamun", price: 120, quantity: 2, nc: true, nc_id: "nc-item-1", nc_kind: "guest_complaint" };
const JAMUN_PLAIN: NcFixtureLine = { id: "j", name: "Gulab Jamun", price: 120, quantity: 2 };

/** The item comp behind JAMUN, as MarkOrderItemNonChargeable wrote it. */
const jamunRow = (orderId = ORDER_1): NcFixtureRow => ({
  id: "nc-item-1", created_at: "2026-09-16T08:05:00Z", outlet_id: "o", order_id: orderId, item_id: "j",
  item_name: "Gulab Jamun", table_id: TABLE_ID, nc_kind: "guest_complaint", reason: "Cold",
  quantity: 2, unit_price: 120, menu_price_at_nc: 120, marked_by_employee_id: null, marked_by_username: "cashier1",
  authorised_by_employee_id: null, authorised_by_username: "manager01", scope: "item", bill_id: null,
  settle_group: null, reversed_at: null, reversed_by_username: null, reversal_reason: null,
});

const order = (over: Partial<NcFixtureOrder> & { items: NcFixtureLine[] }): NcFixtureOrder => ({
  id: ORDER_1, status: 2, created_at: "2026-09-16T08:00:00Z", ...over,
});

/** A comped table: Paneer 350 charged, 2 x Gulab Jamun comped (240). */
const compedTable = (over: Partial<NcFixtureOrder> = {}): NcFixtureState => makeState({
  orders: [order({ items: [clone(PANEER), clone(JAMUN)], ...over })],
  nc: [jamunRow()],
});

/** What the web orders page sends back: every line as the mapper read it. */
const webEcho = (l: NcFixtureLine): Record<string, unknown> => ({
  ...l, orderedAt: "2026-09-16T08:00:00Z", note: null,
  nc: l.nc === true, nc_id: l.nc_id ?? null, nc_kind: l.nc_kind ?? null,
});

const settle = (over: Partial<Parameters<Db["SettleBillAsNonChargeable"]>[1]> = {}) =>
  db.SettleBillAsNonChargeable(RID, {
    order_id: ORDER_1, nc_kind: "complimentary", reason: "Owner's family", actor: ACTOR, ...over,
  });

const split = (lines: unknown[][], opts: { isAdmin?: boolean } = { isAdmin: true }) =>
  db.UpdateOrderItemsSplit(RID, ORDER_1, [["Served", lines[0] ?? []], ["Preparing", lines[1] ?? []]], opts);

const snapshot = (): string => JSON.stringify({ ...current(), after_split_read: null });

describe("a comp, then an everyday rewrite, then Settle as NC", () => {
  test("the drag keeps the comp and prices chargeable lines only; the settle then takes the till's quote", async () => {
    useState(compedTable());
    await split([[webEcho(JAMUN)], [webEcho(PANEER)]]);
    const o = current().orders[0]!;
    // 350, not 590: the comped dish is not charged again. (Status 1: a line is Preparing.)
    expect(o).toMatchObject({ subtotal: 350, total: 350, nc_subtotal: 240, status: 1 });
    expect(o.items).toEqual([
      { ...JAMUN, orderedAt: "2026-09-16T08:00:00Z", note: null },
      { ...PANEER, orderedAt: "2026-09-16T08:00:00Z", note: null },
    ]);
    expect(o.items_split).toEqual([["Served", [o.items[0]]], ["Preparing", [o.items[1]]]]);

    // The till quotes 350 now, and the settle agrees with it.
    const result = await settle({ expected_value: 350 });
    const s = current();
    expect(result).toMatchObject({ payment_method: "NC", total_amt: 0, nc_lines: 1, nc_value: 590 });
    expect(s.orders[0]).toMatchObject({ status: 4, subtotal: 0, total: 0, nc_subtotal: 590 });
    expect(s.nc.map((r) => [r.scope, r.item_name, r.nc_kind])).toEqual([
      ["item", "Gulab Jamun", "guest_complaint"],
      ["bill", "Paneer Tikka", "complimentary"],
    ]);
    expect(s.bills[0]).toMatchObject({ payment_method: "NC", total_amt: 0 });
  });

  test("a delete and an add through the same writer keep the comp and the price", async () => {
    useState(compedTable());
    // DELETE /orders/:id/items/:itemId sends the order back without the line.
    await split([[webEcho(JAMUN)], []]);
    expect(current().orders[0]).toMatchObject({ subtotal: 0, total: 0, nc_subtotal: 240 });
    expect(current().orders[0]!.items[0]!.nc_id).toBe("nc-item-1");
    // POST /orders/:id/items appends one to Preparing.
    await split([[webEcho(JAMUN)], [{ id: "c", name: "Chaas", price: 90, quantity: 1 }]]);
    expect(current().orders[0]).toMatchObject({ subtotal: 90, total: 90, nc_subtotal: 240 });
    const result = await settle({ expected_value: 90 });
    expect(result.nc_value).toBe(330);
  });

  test("an order STORING a figure written over its comp (the old pricing): the till's quote is accepted and the order re-priced", async () => {
    // What the items-split writer used to leave: 590 stored over 350 + a comped 240.
    useState(compedTable({ subtotal: 590, total: 590 }));
    const before = snapshot();
    // The lines say 350; the till (GET /bill-for-table) says 590 — and 590 is what both clients send.
    await expect(settle({ expected_value: 350 })).rejects.toMatchObject({
      status: 400, code: "quote_moved",
      message: "The bill changed while you were deciding: its food now comes to ₹590.00, not ₹350.00. Check it and settle again.",
    });
    expect(snapshot()).toBe(before);
    const result = await settle({ expected_value: 590 });
    expect(result).toMatchObject({ payment_method: "NC", nc_lines: 1, nc_value: 590 });
    // The informational figure is priced on what the lines say was still owed.
    const TAXES = [{ name: "SGST", percentage: 2.5 }, { name: "CGST", percentage: 2.5 }];
    expect(result.would_have_charged).toBe(computeBillCharges(350, TAXES, 10, true, null).grand_total);
    expect(result.would_have_charged).not.toBe(computeBillCharges(590, TAXES, 10, true, null).grand_total);
    expect(current().orders[0]).toMatchObject({ status: 4, subtotal: 0, total: 0 });
  });

  test("an order whose only line was comped earlier, still storing its old figure, is re-priced with the rest", async () => {
    useState(makeState({
      orders: [
        order({ items: [clone(JAMUN)], subtotal: 240, total: 240 }),
        order({ id: ORDER_2, created_at: "2026-09-16T08:20:00Z", items: [{ id: "c", name: "Chaas", price: 90, quantity: 1 }] }),
      ],
      nc: [jamunRow()],
    }));
    const result = await settle();
    expect(result).toMatchObject({ payment_method: "NC", nc_lines: 1, nc_value: 330 });
    expect(current().orders.map((o) => [o.status, o.subtotal, o.total])).toEqual([[4, 0, 0], [4, 0, 0]]);
    // The already-comped order kept its comp, untouched.
    expect(current().orders[0]!.items[0]).toEqual(JAMUN);
  });

  test("an order with NO lines is never zeroed to make the invariant pass — the settle is refused whole", async () => {
    useState(makeState({
      orders: [
        order({ items: [], subtotal: 500, total: 500 }),
        order({ id: ORDER_2, created_at: "2026-09-16T08:20:00Z", items: [{ id: "c", name: "Chaas", price: 90, quantity: 1 }] }),
      ],
    }));
    const before = snapshot();
    await expect(settle()).rejects.toThrow("Settling as non-chargeable left ₹500.00 on this table, so nothing was changed. Refresh the bill and try again.");
    expect(snapshot()).toBe(before);
  });

  test("a table of free lines only is not an NC bill: refused before any write, no bill number burnt", async () => {
    useState(makeState({ orders: [order({ items: [{ id: "w", name: "Water", price: 0, quantity: 2 }] })] }));
    const before = snapshot();
    await expect(settle({ expected_value: 0 })).rejects.toMatchObject({
      status: 400, code: "nothing_to_settle", message: "There is nothing on this table to settle.",
    });
    expect(snapshot()).toBe(before);
    expect(current().next_bill_no).toBe(101);
    expect(statements.some((st) => /^(insert|update)\b/i.test(st.sql))).toBe(false);
  });
});

describe("the items-split writer: the comps are the server's", () => {
  test("a forged comp is stripped — a payload cannot make a dish free", async () => {
    useState(makeState({ orders: [order({ items: [clone(PANEER)] })] }));
    await split([[{ ...PANEER, nc: true, nc_id: "forged", nc_kind: "complimentary" }], []]);
    const o = current().orders[0]!;
    expect(o).toMatchObject({ subtotal: 350, total: 350 });
    expect(o.nc_subtotal).toBeUndefined();
    expect(o.items).toEqual([PANEER]);
    // …and a JSON-string line is parsed before the strip, not stored with its flag.
    await split([[JSON.stringify({ ...PANEER, nc: true, nc_id: "forged" })], []]);
    expect(current().orders[0]!.items).toEqual([PANEER]);
    expect(current().orders[0]!.subtotal).toBe(350);
  });

  test("a stale payload that dropped the nc keys does not re-charge the comped dish", async () => {
    useState(compedTable());
    await split([[clone(PANEER), clone(JAMUN_PLAIN)], []]);
    expect(current().orders[0]).toMatchObject({ subtotal: 350, nc_subtotal: 240 });
    expect(current().orders[0]!.items[1]).toEqual(JAMUN);
  });

  test("a comped dish changed by the payload is refused, and nothing is written", async () => {
    useState(compedTable());
    const before = snapshot();
    await expect(split([[webEcho(PANEER), webEcho({ ...JAMUN, quantity: 3 })], []]))
      .rejects.toThrow("Gulab Jamun is comped as non-chargeable, and this change would alter it. Undo the comp first, or refresh the order and try again.");
    expect(snapshot()).toBe(before);
    expect(statements.some((st) => /^update\b/i.test(st.sql))).toBe(false);
  });

  test("removing the comped line takes its flag with it; the twin under the same id stays charged", async () => {
    useState(makeState({ orders: [order({ items: [clone(JAMUN), clone(JAMUN_PLAIN)] })], nc: [jamunRow()] }));
    await split([[], [clone(JAMUN_PLAIN)]]);
    expect(current().orders[0]).toMatchObject({ subtotal: 240, total: 240 });
    expect(current().orders[0]!.nc_subtotal).toBeUndefined();
  });

  test("a Settle as NC that commits between the writer's read and its write is left exactly as it closed", async () => {
    useState(compedTable());
    await settle();
    const closed = clone({ ...current(), after_split_read: null });
    useState(compedTable());
    current().after_split_read = () => { Object.assign(current(), clone(closed)); };
    await expect(split([[webEcho(JAMUN)], [webEcho(PANEER)]]))
      .rejects.toThrow("This order's bill is already settled and locked — its status can no longer be changed.");
    const s = current();
    expect(JSON.stringify(s.orders)).toBe(JSON.stringify(closed.orders));
    expect(s.orders[0]).toMatchObject({ status: 4, subtotal: 0 });
    expect(s.orders[0]!.items.every((i) => i.nc === true)).toBe(true);
    expect(s.bills[0]).toMatchObject({ payment_method: "NC", total_amt: 0 });
    expect(s.table.is_occupied).toBe(false);
  });

  test("a comp made between the read and the write is not overwritten", async () => {
    useState(compedTable());
    current().after_split_read = () => {
      const o = current().orders[0]!;
      o.items[0] = { ...o.items[0]!, nc: true, nc_id: "nc-late", nc_kind: "staff_meal" };
      o.subtotal = 0; o.total = 0;
    };
    await expect(split([[webEcho(JAMUN)], [webEcho(PANEER)]]))
      .rejects.toThrow("This order changed on another screen while it was being edited — a dish on it was comped, un-comped or settled. Refresh it and try again.");
    expect(current().orders[0]!.items[0]).toMatchObject({ nc: true, nc_id: "nc-late" });
    expect(current().orders[0]!.subtotal).toBe(0);
  });

  test("a payment put up for approval between the read and the write freezes the order", async () => {
    useState(compedTable());
    current().after_split_read = () => { current().orders[0]!.status = 6; };
    await expect(split([[webEcho(JAMUN)], [webEcho(PANEER)]])).rejects.toThrow(db.ORDER_PAYMENT_PENDING_MESSAGE);
    expect(current().orders[0]!.items_split).toBeUndefined();
  });
});

describe("the admin remove-item path prices chargeable lines only", () => {
  test("removing a charged dish leaves the comped one at 0.00, not at its menu price", async () => {
    useState(makeState({
      orders: [
        order({ items: [clone(PANEER), clone(JAMUN)] }),
        order({ id: ORDER_2, created_at: "2026-09-16T08:20:00Z", items: [{ id: "c", name: "Chaas", price: 90, quantity: 1 }] }),
      ],
      nc: [jamunRow()],
      bills: [{
        id: "b0000000-0000-4000-8000-000000000001", bill_no: 55, created_at: "2026-09-16T08:01:00Z",
        table_id: TABLE_ID, status: 1, total_amt: 440, tax_breakdown: [], round_off: null,
        payment_method: null, payment_splits: null, payment_proof_screenshot_url: null,
        waiter_confirmed_at: null, waiter_confirmed_by_username: null,
        admin_approved_at: null, admin_approved_by_username: null, closed_at: null, closed_by_username: null,
        discount_type: null, discount_value: 0, coupon_code: null,
      }],
    }));
    await db.RemoveBillItem(RID, "T7", "Paneer Tikka", 350);
    const s = current();
    expect(s.orders[0]).toMatchObject({ subtotal: 0, total: 0, nc_subtotal: 240 });
    expect(s.orders[0]!.items).toEqual([JAMUN]);
    // The open bill's running pre-tax total: the Chaas alone.
    expect(s.bills[0]!.total_amt).toBe(90);
  });
});

describe("the settled NC bill, read back — what the reprint and both drill-downs print", () => {
  test("its settlement (from the ledger and the settle's audit line) and its comped lines at 0.00", async () => {
    useState(compedTable());
    const result = await settle({ expected_value: 350 });
    current().audit = [{
      action_id: PERM_NC, bill_id: result.bill_id, scope: "bill", would_have_charged: 404, created_at: "2026-09-16T09:00:00Z",
    }];
    const bill = await db.GetClosedBill(RID, result.bill_id);
    expect(bill).not.toBeNull();
    expect(bill!.payment_method).toBe("NC");
    expect(bill!.nc_settlement).toEqual({
      // The bill-scope rows decide the kind and the names; the item comp counts in the value.
      kind: "complimentary", kind_label: "Complimentary", authorised_by: "manager01", marked_by: "cashier1",
      reason: "Owner's family", lines: 2, value: 590, would_have_charged: 404,
    });
    const byName = new Map(bill!.items.map((i) => [i.name, i]));
    expect(byName.get("Gulab Jamun")).toMatchObject({ price: 120, quantity: 2, line_total: 0, nc: true });
    expect(byName.get("Paneer Tikka")).toMatchObject({ price: 350, quantity: 1, line_total: 0, nc: true });
    expect(bill!.grand_total).toBe(0);
  });

  test("without the audit line the figure is unknown (null), never invented", async () => {
    useState(compedTable());
    const result = await settle();
    const bill = await db.GetClosedBill(RID, result.bill_id);
    expect(bill!.nc_settlement).toMatchObject({ kind: "complimentary", authorised_by: "manager01", would_have_charged: null });
  });

  test("a PAID bill with a comped dish: the comp at 0.00 on its own line, the rest at price, and no settlement", async () => {
    useState(makeState({
      orders: [order({ status: 4, items: [clone(PANEER), clone(JAMUN), { ...JAMUN_PLAIN, id: "j2" }] })],
      nc: [jamunRow()],
      bills: [{
        id: "b0000000-0000-4000-8000-000000000002", bill_no: 56, created_at: "2026-09-16T08:01:00Z",
        table_id: TABLE_ID, status: 2, total_amt: 693, tax_breakdown: [{ name: "SGST", percentage: 2.5, amount: 16.5 }, { name: "CGST", percentage: 2.5, amount: 16.5 }],
        round_off: 0, payment_method: "Cash", payment_splits: null, payment_proof_screenshot_url: null,
        waiter_confirmed_at: "2026-09-16T09:00:00Z", waiter_confirmed_by_username: "cashier1",
        admin_approved_at: "2026-09-16T09:00:00Z", admin_approved_by_username: "cashier1",
        closed_at: "2026-09-16T09:00:00Z", closed_by_username: "cashier1",
        discount_type: null, discount_value: 0, coupon_code: null,
      }],
    }));
    const bill = await db.GetClosedBill(RID, "b0000000-0000-4000-8000-000000000002");
    expect(bill!.nc_settlement).toBeNull();
    expect(bill!.items).toEqual([
      expect.objectContaining({ name: "Paneer Tikka", line_total: 350 }),
      expect.objectContaining({ name: "Gulab Jamun", quantity: 2, line_total: 0, nc: true }),
      expect.objectContaining({ name: "Gulab Jamun", quantity: 2, line_total: 240 }),
    ]);
    expect(bill!.items[2]!.nc).toBeUndefined();
    expect(statements.some((st) => /from "OrderItemNonChargeable"/.test(st.sql))).toBe(false);
  });
});

describe("re-opening a bill made 'NC' by the ₹0 hardening", () => {
  test("reports nothing undone, and leaves the item comps where they are", async () => {
    const allComped = [
      order({ status: 4, items: [{ ...PANEER, nc: true, nc_id: "nc-item-0", nc_kind: "staff_meal" }, clone(JAMUN)] }),
    ];
    useState(makeState({
      // Settled, so the table is free (every settle path releases it).
      table: { id: TABLE_ID, name: "T7", is_occupied: false, num_covers: 1 },
      orders: allComped,
      nc: [jamunRow(), { ...jamunRow(), id: "nc-item-0", item_id: "p", item_name: "Paneer Tikka", quantity: 1, unit_price: 350, nc_kind: "staff_meal" }],
      bills: [{
        id: "b0000000-0000-4000-8000-000000000003", bill_no: 57, created_at: "2026-09-16T08:01:00Z",
        table_id: TABLE_ID, status: 2, total_amt: 0, tax_breakdown: [], round_off: 0,
        payment_method: "NC", payment_splits: null, payment_proof_screenshot_url: null,
        waiter_confirmed_at: "2026-09-16T09:00:00Z", waiter_confirmed_by_username: "cashier1",
        admin_approved_at: "2026-09-16T09:00:00Z", admin_approved_by_username: "manager01",
        closed_at: "2026-09-16T09:00:00Z", closed_by_username: "manager01",
        discount_type: null, discount_value: 0, coupon_code: null,
      }],
    }));
    const result = await db.ReopenBill(RID, "b0000000-0000-4000-8000-000000000003", null, "manager01");
    expect(result.nc_reversed).toBeUndefined();
    expect("nc_reversed" in result).toBe(false);
    const s = current();
    expect(s.nc.every((r) => r.reversed_at === null)).toBe(true);
    expect(s.orders[0]!.items.every((i) => i.nc === true)).toBe(true);
    expect(s.bills[0]).toMatchObject({ payment_method: null, closed_at: null, total_amt: 0 });
  });
});
