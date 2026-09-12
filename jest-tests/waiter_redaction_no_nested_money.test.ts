// THE BLIND SPOT, NOT THE INSTANCE.
//
// ============================================================================
// WHAT HAPPENED
// ============================================================================
// `without()` in price_scope.ts is a FLAT copy — it deletes top-level keys and
// never descends. `redactBillForTable` knew that for `items` and `taxes` and
// handled both by hand. `service_charge_waiver` (migration 036) is the third
// nested object on the same payload, and it was handed back whole.
//
// That was not a partial leak. `basis_amount` is `round2(discounted_subtotal)` —
// it IS the post-discount subtotal the redaction had just removed, sitting one
// level down beside `amount_waived`, `tax_on_waived` and
// `grand_total_reduction`. So on every table where a manager had waived the
// charge — the routine case the whole 036 feature exists for — a waiter-only
// session could reconstruct the entire money ladder from a payload designed to
// carry none of it.
//
// The existing suite could not see it: waiter_price_redaction.test.ts:146 sets
// `service_charge_waiver: null`, so no case ever drove a waived bill.
//
// ============================================================================
// WHY THIS FILE IS RECURSIVE AND NOT A FOURTH HAND-WRITTEN CASE
// ============================================================================
// Adding "…and check the waiver too" fixes one key and leaves the mechanism
// intact: the NEXT nested money object added to a bill payload leaks in exactly
// the same way, silently, until somebody reviews it. Three of these already
// needed hand-holding.
//
// So this walks the WHOLE redacted payload to any depth and fails on any number
// under a money-shaped name. It does not know what `service_charge_waiver` is
// and does not need to — a new nested object with an `amount` in it fails here
// on the day it is added.

import { describe, test, expect } from "@jest/globals";
import { redactBillForTable, redactTableList, redactOrderList } from "../price_scope";

/**
 * Field names that carry MONEY, as opposed to a rate, a count or an id.
 *
 * Deliberately a pattern rather than a list: the point is to catch a key nobody
 * has written down yet. `percent`/`pct` are excluded because a rate with no
 * amount beside it reconstructs nothing — the same call the module itself makes
 * for `service_charge_percent` and `basis_percent`.
 */
const MONEY_NAME = /(^|_)(amount|amt|total|subtotal|discount|charge|waived|reduction|value|price|apc|basis)($|_)/i;
const RATE_NAME = /(percent|pct|rate)/i;

/** Every `path -> number` in an object, to any depth. */
function numericLeaves(value: unknown, path = ""): { path: string; value: number }[] {
  if (typeof value === "number") { return [{ path, value }]; }
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => numericLeaves(v, `${path}[${String(i)}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => numericLeaves(v, path ? `${path}.${k}` : k));
  }
  return [];
}

/** Money-shaped numbers left anywhere in a payload. */
function moneyLeaks(payload: unknown): string[] {
  return numericLeaves(payload)
    .filter(({ path, value }) => {
      const leaf = path.split(".").pop() ?? "";
      if (RATE_NAME.test(leaf)) { return false; }   // a rate is not an amount
      if (!MONEY_NAME.test(leaf)) { return false; }
      // Zero tells nobody what a table is worth, and several honest fields are
      // legitimately 0 on an untouched bill.
      return value !== 0;
    })
    .map(({ path, value }) => `${path} = ${String(value)}`);
}

/** A bill on a table where a manager HAS waived the service charge. */
const waivedBill = (): Record<string, unknown> => ({
  bill_id: "b-1",
  table_id: "t-7",
  bill_no: "0421",
  customer: "Mr Sharma",
  // --- the top-level money the old redaction already removed ---
  total_amt: 5082,
  subtotal: 4200,
  discount: 0,
  discount_type: null,
  discount_value: 0,
  service_charge: 0,
  service_charge_percent: 10,
  tax_total: 882,
  grand_total: 5082,
  nc_total: 0,
  apc: 1270.5,
  target_apc: 1200,
  covers: 4,
  // --- the nested objects ---
  items: [{ name: "Paneer Tikka", price: 390, quantity: 2, note: "less spice" }],
  taxes: [{ id: "gst", name: "GST", percentage: 5, amount: 441 }],
  service_charge_waived: true,
  // THE OBJECT THAT LEAKED. Every figure here is real: basis_amount is the
  // post-discount subtotal, and the rest is the money that came off.
  service_charge_waiver: {
    id: "w-1",
    created_at: "2026-09-12T10:00:00.000Z",
    outlet_id: "o-1",
    bill_id: "b-1",
    table_id: "t-7",
    waived_at: "2026-09-12T10:00:00.000Z",
    basis: "restaurant_percent",
    basis_percent: 10,
    basis_amount: 4200,
    amount_waived: 420,
    tax_on_waived: 21,
    grand_total_reduction: 441,
    waiver_kind: "guest_complaint",
    reason: "Long wait on the mains",
    waived_by_username: "meena",
  },
  order_ids: ["o1"],
  kot_nos: [214],
});

describe("a waived table hands a waiter no money at all", () => {
  test("THE LEAK: the subtotal no longer comes back as basis_amount", () => {
    const out = redactBillForTable(waivedBill());
    const waiver = out.service_charge_waiver as Record<string, unknown>;
    expect(waiver.basis_amount).toBeUndefined();
    // …and it is not merely absent from the top level while surviving below.
    expect(JSON.stringify(out)).not.toContain("4200");
  });

  test("every amount inside the waiver is gone", () => {
    const waiver = redactBillForTable(waivedBill()).service_charge_waiver as Record<string, unknown>;
    for (const k of ["basis_amount", "amount_waived", "tax_on_waived", "grand_total_reduction"]) {
      expect(waiver[k]).toBeUndefined();
    }
  });

  test("but WHO waived it, WHEN and WHY all survive", () => {
    // A waiter standing at that table is about to be asked. Dropping the waiver
    // whole would have been a different bug.
    const waiver = redactBillForTable(waivedBill()).service_charge_waiver as Record<string, unknown>;
    expect(waiver).toMatchObject({
      waived_by_username: "meena",
      reason: "Long wait on the mains",
      waiver_kind: "guest_complaint",
      basis: "restaurant_percent",
      basis_percent: 10,
    });
  });

  test("and the fact of the waiver is still visible", () => {
    expect(redactBillForTable(waivedBill()).service_charge_waived).toBe(true);
  });

  test("a bill with NO waiver passes null through untouched", () => {
    const out = redactBillForTable({ ...waivedBill(), service_charge_waiver: null, service_charge_waived: false });
    expect(out.service_charge_waiver).toBeNull();
  });

  test("a bill that never carried the key does not grow one", () => {
    const bill = waivedBill();
    delete bill.service_charge_waiver;
    expect("service_charge_waiver" in redactBillForTable(bill)).toBe(false);
  });
});

// ===========================================================================
// THE STRUCTURAL GUARD — this is the part that catches the NEXT one
// ===========================================================================
describe("NO money-shaped number survives redaction, at any depth", () => {
  test("the bill payload", () => {
    const leaks = moneyLeaks(redactBillForTable(waivedBill()));
    expect(leaks).toEqual([]);
  });

  test("the guard actually works — it catches the bug as it was", () => {
    // A test that can only pass is not a test. This is the OLD behaviour:
    // top-level keys removed, the nested waiver handed back whole.
    const bill = waivedBill();
    const asItWas: Record<string, unknown> = { ...bill };
    for (const k of ["total_amt", "subtotal", "discount", "discount_value", "service_charge",
      "tax_total", "grand_total", "nc_total", "apc", "target_apc"]) { delete asItWas[k]; }
    asItWas.items = [{ name: "Paneer Tikka", quantity: 2, note: "less spice" }];
    asItWas.taxes = [{ id: "gst", name: "GST", percentage: 5 }];
    const leaks = moneyLeaks(asItWas);
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks.join(" ")).toContain("service_charge_waiver.basis_amount = 4200");
  });

  test("the table list", () => {
    const rows = [{
      table_name: "T7", is_occupied: true, capacity: 4,
      table_total: 5082, table_apc: 1270.5, target_apc: 1200, apc_status: "on_target",
    }];
    expect(moneyLeaks(redactTableList(rows))).toEqual([]);
  });

  test("the order list", () => {
    const orders = [{
      id: "o1", table: "T7", status: "Preparing",
      subtotal: 780, total: 780,
      items: [{ name: "Paneer Tikka", price: 390, quantity: 2 }],
      taxes: [{ id: "gst", name: "GST", percentage: 5 }],
    }];
    expect(moneyLeaks(redactOrderList(orders))).toEqual([]);
  });

  test("rates and counts are NOT treated as money — the guard is not a blanket ban", () => {
    // If this ever fails the pattern has become too greedy and the next person
    // will start deleting legitimate fields to appease it.
    const out = redactBillForTable(waivedBill()) as Record<string, unknown>;
    expect(out.service_charge_percent).toBe(10);
    expect(out.covers).toBe(4);
    expect((out.service_charge_waiver as Record<string, unknown>).basis_percent).toBe(10);
    expect((out.taxes as { percentage: number }[])[0].percentage).toBe(5);
  });
});
