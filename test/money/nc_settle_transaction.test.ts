// SETTLE AS NC, THROUGH THE REAL TRANSACTION — client item 5.
//
// "NC has to come up as an option for payment mode when settling a bill."
//
// nc_settle.ts proves the rules by value (jest-tests/nc_settle.test.ts). This
// file drives the shipped SettleBillAsNonChargeable — and the settle paths it has
// to agree with — over nc_settle_fixture.ts, a fake pg with real transaction
// semantics (BEGIN snapshots, ROLLBACK restores), and holds the money to:
//
//   * every remaining chargeable LINE becomes one ledger row, scope 'bill',
//     naming the bill and one settle group, with both names and the reason;
//   * the table then sums to 0.00, and the bill closes at 0.00 as 'NC';
//   * NC value = the pre-tax line value (the same basis as an item comp);
//     what the guest would have paid is reported, and written nowhere;
//   * every refusal is decided before ANY write, and burns no bill number;
//   * a failure half-way writes nothing at all;
//   * a replay answers `already` with the first settle's bill;
//   * installed 2.0.0 tills' ₹0 UPI settle of a fully comped table is stored 'NC';
//   * "NC" is never a way to pay, and the refusal says where NC lives;
//   * re-opening an NC bill undoes the settle whole; refunding one is refused.

import { describe, test, expect, beforeAll, jest } from "@jest/globals";
import { computeBillCharges } from "../../billing_math";
import {
  TABLE_ID,
  current,
  makeState,
  statements,
  useState,
  type NcFixtureOrder,
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
const TAXES = [{ name: "SGST", percentage: 2.5 }, { name: "CGST", percentage: 2.5 }];

/** Two rounds on one table: 350 + 2 x 120, then 1.5 x 90.50 (a weighed line). */
function twoRounds(): NcFixtureOrder[] {
  return [
    { id: ORDER_1, status: 2, created_at: "2026-09-16T10:00:00Z", items: [
      { id: "l1", name: "Paneer Tikka", price: 350, quantity: 1 },
      { id: "l2", name: "Gulab Jamun", price: 120, quantity: 2 },
    ] },
    { id: ORDER_2, status: 2, created_at: "2026-09-16T10:20:00Z", items: [
      { id: "l3", name: "Masala Chaas", price: 90.5, quantity: 1.5 },
    ] },
  ];
}
const FOOD = 350 + 240 + 135.75; // 725.75

function openBill(over: Partial<NcFixtureState["bills"][number]> = {}): NcFixtureState["bills"][number] {
  return {
    id: "b0000000-0000-4000-8000-000000000001", bill_no: 55, created_at: "2026-09-16T10:01:00Z",
    table_id: TABLE_ID, status: 1, total_amt: FOOD, tax_breakdown: [], round_off: null,
    payment_method: null, payment_splits: null, payment_proof_screenshot_url: null,
    waiter_confirmed_at: null, waiter_confirmed_by_username: null,
    admin_approved_at: null, admin_approved_by_username: null, closed_at: null, closed_by_username: null,
    discount_type: null, discount_value: 0, coupon_code: null,
    ...over,
  };
}

const settle = (over: Partial<Parameters<Db["SettleBillAsNonChargeable"]>[1]> = {}) =>
  db.SettleBillAsNonChargeable(RID, {
    order_id: ORDER_1, nc_kind: "complimentary", reason: "Owner's family", actor: ACTOR, ...over,
  });

/** Statements that change a row, issued inside the settle transaction. */
const writesAfterBegin = (): string[] => {
  const begin = statements.findIndex((s) => /^begin$/i.test(s.sql));
  return statements.slice(begin + 1)
    .map((s) => s.sql)
    .filter((q) => /^(insert|update|delete)\b/i.test(q));
};

const snapshot = (): string => JSON.stringify({ ...current(), fail_on: null, leak_after_comp: 0 });

describe("a table settled as NC: every line into the ledger, the bill closed at 0.00", () => {
  test("the rows, the orders, the bill and the table", async () => {
    useState(makeState({ orders: twoRounds() }));
    const result = await settle({ expected_value: FOOD });
    const s = current();

    // THE LEDGER: one row per line, pre-tax, scope 'bill', one settle group.
    expect(s.nc).toHaveLength(3);
    const group = s.nc[0]!.settle_group;
    expect(group).toBeTruthy();
    for (const r of s.nc) {
      expect(r).toMatchObject({
        scope: "bill", bill_id: result.bill_id, settle_group: group,
        nc_kind: "complimentary", reason: "Owner's family",
        marked_by_username: "cashier1", authorised_by_username: "manager01",
        table_id: TABLE_ID, reversed_at: null,
      });
    }
    expect(s.nc.map((r) => [r.item_name, r.quantity, r.unit_price])).toEqual([
      ["Paneer Tikka", 1, 350], ["Gulab Jamun", 2, 120], ["Masala Chaas", 1.5, 90.5],
    ]);

    // THE ORDERS: every line flagged with ITS ledger row, nothing chargeable left.
    for (const o of s.orders) {
      expect(o.subtotal).toBe(0);
      expect(o.total).toBe(0);
      expect(o.status).toBe(4); // Paid, as an ordinary settle leaves them
      for (const line of o.items) {
        const row = s.nc.find((r) => r.id === line.nc_id);
        expect(line.nc).toBe(true);
        expect(line.nc_kind).toBe("complimentary");
        expect(row?.item_id).toBe(line.id);
        expect(row?.order_id).toBe(o.id);
      }
    }
    expect(s.orders.map((o) => o.nc_subtotal)).toEqual([590, 135.75]);

    // THE BILL: minted now (no bill existed), closed at 0.00 as 'NC'.
    expect(s.bills).toHaveLength(1);
    expect(s.bills[0]).toMatchObject({
      id: result.bill_id, bill_no: 101, payment_method: "NC", total_amt: 0, round_off: 0,
      tax_breakdown: [], payment_splits: null, status: 2,
      waiter_confirmed_by_username: "cashier1", admin_approved_by_username: "cashier1", closed_by_username: "cashier1",
    });
    expect(s.bills[0]!.closed_at).toBeTruthy();

    // THE TABLE is free for the next party.
    expect(s.table.is_occupied).toBe(false);

    // THE ANSWER.
    expect(result).toMatchObject({
      success: true, payment_method: "NC", total_amt: 0, bill_no: "101", table_name: "T7",
      nc_value: FOOD, nc_lines: 3, settle_group: group,
    });
    expect(result.already).toBeUndefined();
    expect(result.non_chargeables.map((r) => r.value)).toEqual([350, 240, 135.75]);
  });

  test("NC value is the pre-tax line value; what the guest would have paid is reported, and stored nowhere", async () => {
    useState(makeState({ orders: twoRounds() }));
    const result = await settle();
    const would = computeBillCharges(FOOD, TAXES, 10, true, null).grand_total;
    expect(would).toBeGreaterThan(FOOD);
    expect(result.would_have_charged).toBe(would);
    expect(result.nc_value).toBe(FOOD);
    // Written nowhere: no statement carried the figure.
    expect(statements.some((st) => st.params.some((p) => p === would))).toBe(false);
  });

  test("the orders are locked BEFORE the bill — the order a double tap needs", async () => {
    useState(makeState({ orders: twoRounds(), bills: [openBill()] }));
    await settle();
    const orders = statements.findIndex((st) => /^select id, food, status from "Orders" .* for update$/i.test(st.sql));
    const bill = statements.findIndex((st) => /^select id, bill_no::text as bill_no, waiter_confirmed_at/i.test(st.sql));
    expect(orders).toBeGreaterThan(-1);
    expect(bill).toBeGreaterThan(orders);
  });

  test("an OPEN bill is settled in place: its number, no new one burnt", async () => {
    useState(makeState({ orders: twoRounds(), bills: [openBill()] }));
    const result = await settle();
    const s = current();
    expect(s.bills).toHaveLength(1);
    expect(result.bill_id).toBe("b0000000-0000-4000-8000-000000000001");
    expect(result.bill_no).toBe("55");
    expect(s.next_bill_no).toBe(101);
    expect(statements.some((st) => /bill_seq/i.test(st.sql))).toBe(false);
  });

  test("a dish comped earlier keeps its item comp; the settle takes the rest and the value counts both", async () => {
    const orders = twoRounds();
    orders[0]!.items[1] = { ...orders[0]!.items[1]!, nc: true, nc_id: "item-nc-1", nc_kind: "guest_complaint" };
    useState(makeState({
      orders,
      nc: [{
        id: "item-nc-1", created_at: "2026-09-16T10:05:00Z", outlet_id: "o", order_id: ORDER_1, item_id: "l2",
        item_name: "Gulab Jamun", table_id: TABLE_ID, nc_kind: "guest_complaint", reason: "Cold",
        quantity: 2, unit_price: 120, menu_price_at_nc: 120, marked_by_employee_id: null, marked_by_username: "cashier1",
        authorised_by_employee_id: null, authorised_by_username: "manager01", scope: "item", bill_id: null,
        settle_group: null, reversed_at: null, reversed_by_username: null, reversal_reason: null,
      }],
    }));
    const result = await settle({ expected_value: 350 + 135.75 });
    const s = current();
    expect(result.nc_lines).toBe(2);
    expect(result.nc_value).toBe(FOOD);
    expect(s.nc.filter((r) => r.scope === "item")).toHaveLength(1);
    expect(s.nc.find((r) => r.id === "item-nc-1")?.nc_kind).toBe("guest_complaint");
    expect(s.orders[0]!.items[1]!.nc_id).toBe("item-nc-1");
  });

  test("a line with no id, or an id another line already carries, is still comped — under an id of its own", async () => {
    const order: NcFixtureOrder = {
      id: ORDER_1, status: 2, created_at: "2026-09-16T10:00:00Z",
      items: [
        { id: "dup", name: "Roti", price: 30, quantity: 2 },
        { id: "dup", name: "Roti", price: 30, quantity: 1 },
        { name: "Water", price: 20, quantity: 1 },
        { id: "free", name: "Pickle", price: 0, quantity: 1 },
      ],
      items_split: [["Mains", [
        { id: "dup", name: "Roti", price: 30, quantity: 2 },
        { id: "free", name: "Pickle", price: 0, quantity: 1 },
      ]]],
    };
    useState(makeState({ orders: [order] }));
    await settle();
    const s = current();
    const ids = s.nc.map((r) => r.item_id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe("dup");
    const items = s.orders[0]!.items;
    expect(items.slice(0, 3).map((i) => i.nc)).toEqual([true, true, true]);
    expect(items.slice(0, 3).map((i) => i.id)).toEqual(ids);
    // The zero-priced line gives nothing away: no row, no flag, still 0.00.
    expect(items[3]!.nc).toBeUndefined();
    expect(s.orders[0]!.subtotal).toBe(0);
    // The split line that shares the unique stored id is flagged with it.
    expect(s.orders[0]!.items_split![0]![1][0]!.nc).toBe(true);
    expect(s.orders[0]!.items_split![0]![1][0]!.nc_id).toBe(s.nc[0]!.id);
  });
});

describe("every refusal is decided before any write — and burns no bill number", () => {
  const refused = async (state: NcFixtureState, code: string, over: Parameters<typeof settle>[0] = {}): Promise<Error & { status?: number; code?: string }> => {
    useState(state);
    const before = snapshot();
    let err: (Error & { status?: number; code?: string }) | null = null;
    try { await settle(over); } catch (e) { err = e as Error & { status?: number; code?: string }; }
    expect(err).not.toBeNull();
    expect(err!.code).toBe(code);
    expect(writesAfterBegin()).toEqual([]);
    expect(snapshot()).toBe(before);
    return err!;
  };

  test("a payment already waiting for approval", async () => {
    const err = await refused(makeState({
      orders: twoRounds(), bills: [openBill({ waiter_confirmed_at: "2026-09-16T10:30:00Z", payment_method: "Upi" })],
    }), "payment_pending");
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/waiting for approval/);
  });

  test("live tenders on the bill — a voided one is not money", async () => {
    const err = await refused(makeState({
      orders: twoRounds(), bills: [openBill()],
      tenders: [{ bill_id: "b0000000-0000-4000-8000-000000000001", amount: 200, voided: false }],
    }), "tenders_recorded");
    expect(err.message).toBe("₹200.00 is already recorded as paid on this bill. Void that payment first, or comp dishes individually and take the rest.");

    useState(makeState({
      orders: twoRounds(), bills: [openBill()],
      tenders: [{ bill_id: "b0000000-0000-4000-8000-000000000001", amount: 200, voided: true }],
    }));
    await expect(settle()).resolves.toMatchObject({ payment_method: "NC" });
  });

  test("a discount, a coupon, or redeemed points", async () => {
    await refused(makeState({ orders: twoRounds(), bills: [openBill({ discount_type: "flat", discount_value: 50 })] }), "discount_on_bill");
    await refused(makeState({ orders: twoRounds(), bills: [openBill({ coupon_code: "DIWALI" })] }), "discount_on_bill");
    const err = await refused(makeState({
      orders: twoRounds(),
      bills: [openBill({ discount_type: "flat", discount_value: 50 })],
      loyalty_redeemed_bills: ["b0000000-0000-4000-8000-000000000001"],
    }), "discount_on_bill");
    expect(err.message).toMatch(/points would be lost/);
  });

  test("food on course hold that never went to the kitchen", async () => {
    const orders = twoRounds();
    orders[1]!.items[0] = { ...orders[1]!.items[0]!, course_hold: true, fired_at: null };
    const err = await refused(makeState({ orders }), "held_lines");
    expect(err.message).toMatch(/^Masala Chaas is on course hold/);
  });

  test("the quote moved — compared in whole paisa", async () => {
    const err = await refused(makeState({ orders: twoRounds() }), "quote_moved", { expected_value: 725.74 });
    expect(err.status).toBe(400);
    useState(makeState({ orders: twoRounds() }));
    await expect(settle({ expected_value: 725.75 })).resolves.toMatchObject({ nc_value: FOOD });
  });

  test("migration 052 neither applied nor creatable: the 503 error, and not even a transaction", async () => {
    // A process that has not yet seen the columns (the memo only ever latches true).
    db.__poolHygieneTestSeam.resetDdlMemo();
    useState(makeState({ orders: twoRounds(), nc_columns: false }));
    const before = snapshot();
    await expect(settle()).rejects.toBeInstanceOf(db.BillNonChargeableSchemaMissingError);
    expect(statements.some((st) => /^begin$/i.test(st.sql))).toBe(false);
    expect(snapshot()).toBe(before);
    // Applied by hand later: picked up without a restart.
    current().nc_columns = true;
    await expect(settle()).resolves.toMatchObject({ payment_method: "NC" });
  });

  test("the request's own fields are refused before a single statement", async () => {
    for (const over of [{ nc_kind: "birthday" }, { reason: "   " }, { actor: { ...ACTOR, authorised_by_username: "" } }, { order_id: "not-a-uuid" }]) {
      useState(makeState({ orders: twoRounds() }));
      await expect(settle(over)).rejects.toThrow();
      expect(statements).toEqual([]);
    }
  });
});

describe("half-way failures write nothing; replays write nothing", () => {
  test("a failure at the final bill stamp rolls back the rows, the flags and the bill number", async () => {
    useState(makeState({ orders: twoRounds(), fail_on: /^update "Bills" set payment_method = \$1, payment_splits = null/i }));
    const before = snapshot();
    await expect(settle()).rejects.toThrow(/injected failure/);
    expect(snapshot()).toBe(before);
    expect(current().next_bill_no).toBe(101);
    expect(statements.some((st) => /^rollback$/i.test(st.sql))).toBe(true);
  });

  test("a table that still sums to money after the comps is not closed at 0.00", async () => {
    useState(makeState({ orders: twoRounds(), leak_after_comp: 12.5 }));
    const before = snapshot();
    await expect(settle()).rejects.toThrow(/left ₹25\.00 on this table, so nothing was changed/);
    expect(snapshot()).toBe(before);
  });

  test("the same settle twice: the second answers `already` with the first bill, and writes nothing", async () => {
    useState(makeState({ orders: twoRounds() }));
    const first = await settle();
    const rowsAfterFirst = JSON.stringify(current().nc);
    statements.length = 0;
    const second = await settle();
    expect(second).toMatchObject({
      already: true, bill_id: first.bill_id, bill_no: first.bill_no, payment_method: "NC",
      nc_lines: 3, nc_value: FOOD, settle_group: first.settle_group,
    });
    expect(statements.filter((st) => /^(insert|update|delete)\b/i.test(st.sql))).toEqual([]);
    expect(JSON.stringify(current().nc)).toBe(rowsAfterFirst);
    // A tap on another order of the same, already settled table is the same replay.
    await expect(settle({ order_id: ORDER_2 })).resolves.toMatchObject({ already: true, bill_id: first.bill_id });
  });

  test("the NEXT party on the same table is a new bill, not a replay", async () => {
    useState(makeState({ orders: twoRounds() }));
    const first = await settle();
    const next: NcFixtureOrder = {
      id: "33333333-1111-4111-8111-333333333333", status: 1, created_at: new Date(Date.now() + 1000).toISOString(),
      items: [{ id: "n1", name: "Coffee", price: 150, quantity: 1 }],
    };
    current().orders.push(next);
    current().table.is_occupied = true;
    const second = await settle({ order_id: next.id });
    expect(second.already).toBeUndefined();
    expect(second.bill_id).not.toBe(first.bill_id);
    expect(second.bill_no).toBe("102");
    expect(second.nc_value).toBe(150);
  });
});

describe("the settle paths that meet an NC bill", () => {
  /** Every line of both rounds already comped one by one — a table that owes 0.00. */
  const allComped = (): NcFixtureOrder[] => twoRounds().map((o) => ({
    ...o, items: o.items.map((i, n) => ({ ...i, nc: true, nc_id: `${o.id}-${String(n)}`, nc_kind: "complimentary" })),
  }));

  test("installed 2.0.0 tills: a ₹0 UPI settle of a fully comped table is stored as NC", async () => {
    useState(makeState({ orders: allComped(), bills: [openBill({ total_amt: 0 })] }));
    const result = await db.ConfirmBillPaymentByWaiter(RID, ORDER_1, "cashier1", "Upi");
    expect(result.payment_method).toBe("NC");
    expect(current().bills[0]).toMatchObject({ payment_method: "NC", total_amt: 0, payment_proof_screenshot_url: null });
  });

  test("…and a table with anything chargeable keeps the mode it was paid with", async () => {
    const orders = allComped();
    orders[1]!.items[0] = { id: "l3", name: "Masala Chaas", price: 90.5, quantity: 1.5 };
    useState(makeState({ orders, bills: [openBill()] }));
    const result = await db.ConfirmBillPaymentByWaiter(RID, ORDER_1, "cashier1", "Upi");
    expect(result.payment_method).toBe("Upi");
    expect(current().bills[0]!.payment_method).toBe("Upi");
  });

  test('"NC" is never a way to pay — and the refusal says where NC lives', async () => {
    for (const word of ["NC", "nc", "Complimentary", "Non Chargeable"]) {
      useState(makeState({ orders: twoRounds(), bills: [openBill()] }));
      await expect(db.ConfirmBillPaymentByWaiter(RID, ORDER_1, "cashier1", word))
        .rejects.toThrow(`"${word}" is not a way to pay — nothing is collected on a non-chargeable bill. Use "Non-chargeable (NC)" when settling, or comp dishes individually and take the rest.`);
      expect(current().bills[0]!.payment_method).toBeNull();
    }
    useState(makeState({ orders: twoRounds(), bills: [openBill()] }));
    await expect(db.ConfirmBillPaymentByWaiter(RID, ORDER_1, "cashier1", "", null, [
      { method: "Cash", amount: 400 }, { method: "NC", amount: 325.75 },
    ])).rejects.toThrow(/"NC" is not a way to pay/);
    // A word that is not a comp word keeps the plain refusal.
    await expect(db.ConfirmBillPaymentByWaiter(RID, ORDER_1, "cashier1", "Bitcoin")).rejects.toThrow("Invalid payment method");
  });

  test("re-opening an NC bill undoes the settle whole: comps reversed, marker cleared, orders Served", async () => {
    useState(makeState({ orders: twoRounds() }));
    const settled = await settle();
    const result = await db.ReopenBill(RID, settled.bill_id, null, "manager01");
    const s = current();
    expect(result.nc_reversed).toMatchObject({ lines: 3, value: FOOD, settle_group: settled.settle_group });
    expect(s.nc.every((r) => r.reversed_at !== null && r.reversed_by_username === "manager01")).toBe(true);
    for (const o of s.orders) {
      expect(o.status).toBe(2);
      expect(o.items.every((i) => i.nc === undefined && i.nc_id === undefined)).toBe(true);
    }
    expect(s.orders.map((o) => o.subtotal)).toEqual([590, 135.75]);
    expect(s.bills[0]).toMatchObject({
      payment_method: null, waiter_confirmed_at: null, waiter_confirmed_by_username: null,
      closed_at: null, admin_approved_at: null, total_amt: FOOD, round_off: null, status: 1,
    });
    expect(result.bill).toMatchObject({ payment_method: null, waiter_confirmed_at: null, total_amt: FOOD });
    expect(s.table.is_occupied).toBe(true);
  });

  test("re-opening a bill that was PAID is unchanged: its method kept, its orders awaiting approval", async () => {
    useState(makeState({
      // A settled table is a FREE table: every settle path releases it, and
      // ReopenBill refuses a table that has been seated again since.
      table: { id: TABLE_ID, name: "T7", is_occupied: false, num_covers: 1 },
      orders: twoRounds().map((o) => ({ ...o, status: 4 })),
      bills: [openBill({
        payment_method: "Cash", total_amt: 838.24, closed_at: "2026-09-16T11:00:00Z", status: 2,
        waiter_confirmed_at: "2026-09-16T10:59:00Z", admin_approved_at: "2026-09-16T11:00:00Z",
      })],
    }));
    const result = await db.ReopenBill(RID, "b0000000-0000-4000-8000-000000000001", null, "manager01");
    expect(result.nc_reversed).toBeUndefined();
    expect(current().orders.map((o) => o.status)).toEqual([6, 6]);
    expect(current().bills[0]).toMatchObject({ payment_method: "Cash", total_amt: 838.24 });
    expect(statements.some((st) => /"OrderItemNonChargeable"/.test(st.sql))).toBe(false);
  });

  test("a refund of an NC bill is refused — nothing was collected", async () => {
    useState(makeState({ orders: twoRounds() }));
    const settled = await settle();
    const before = snapshot();
    await expect(db.RefundBill(RID, { billId: settled.bill_id, byUsername: "manager01" }))
      .rejects.toThrow("Nothing was collected on a non-chargeable bill, so there is nothing to refund. Re-open it instead if it was settled by mistake.");
    expect(snapshot()).toBe(before);
  });

  test("approving an 'NC' bill that owes money again is refused", async () => {
    // A ₹0 settle stored as NC, then a comp reversed underneath it before approval.
    useState(makeState({
      orders: twoRounds(),
      bills: [openBill({ payment_method: "NC", total_amt: 0, waiter_confirmed_at: "2026-09-16T10:40:00Z" })],
    }));
    await expect(db.ApproveBillPaymentByAdmin(RID, ORDER_1, "manager01"))
      .rejects.toThrow(/This bill was recorded as non-chargeable, but it now comes to ₹\d+\.\d\d\. Take the payment again/);
    expect(current().bills[0]!.closed_at).toBeNull();
    expect(current().orders.map((o) => o.status)).toEqual([2, 2]);
  });
});
