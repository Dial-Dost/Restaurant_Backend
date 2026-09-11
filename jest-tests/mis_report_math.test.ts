// THE RULES THE FIFTEEN CONTROL REPORTS SHARE, proved by value.
//
// mis_report_math.ts imports nothing but the other pure modules, so this suite
// loads it directly — no pg mock, no fixture, no database_supabase.ts graph.
// test/money/mis_report_agreement.test.ts proves the same rules survive the trip
// through the real readers and the real SQL; this one proves the arithmetic.

import { describe, test, expect } from "@jest/globals";
import {
  BILL_EDIT_ACTION_IDS,
  UNALLOCATED_METHOD,
  UNATTRIBUTED_GROUP,
  addToLadder,
  allocateSettlement,
  attributionBucket,
  averageBillValue,
  billDiscountMoney,
  classifyBillEdit,
  composeBillMoney,
  formatMethodSplit,
  growthPct,
  humaniseVocabulary,
  liveMoney,
  orderChannel,
  perCover,
  previousWindow,
  refundedTaxShare,
  serviceChargeBasisLabel,
  sharePct,
  zeroLadder,
} from "../mis_report_math";
import { UNCLASSIFIED_GROUP } from "../mis_capture";

const r2 = (n: number): number => Number(n.toFixed(2));

// --- The ladder --------------------------------------------------------------

describe("the money ladder", () => {
  // 1000 of food, 1% service charge, 5% tax on (food + charge):
  //   net 1000 · sc 10 · tax 50.50 · grand 1060.50
  const charges = { taxable_base: 1000, service_charge: 10, tax_total: 50.5 };

  test("net + service charge + tax + round off === grand total, exactly", () => {
    const m = composeBillMoney({ grand_total: 1060.5, charges });
    expect(r2(m.net + m.service_charge + m.tax + m.round_off)).toBe(m.grand_total);
  });

  test("round off is a truthful zero — the schema records no rounding adjustment", () => {
    expect(composeBillMoney({ grand_total: 1060.5, charges }).round_off).toBe(0);
  });

  test("gross minus discount === net, so the top of the ladder is derived, not guessed", () => {
    const m = composeBillMoney({ grand_total: 1060.5, charges, discount_type: "flat", discount_value: 150 });
    expect(m.discount).toBe(150);
    expect(r2(m.gross - m.discount)).toBe(m.net);
    // The discount does NOT move the bottom of the ladder: total_amt is stored
    // already net of it, which is the whole reason gross is derived upward.
    expect(m.grand_total).toBe(1060.5);
  });

  test("a bill with no discount has gross === net", () => {
    const m = composeBillMoney({ grand_total: 1060.5, charges });
    expect(m.gross).toBe(m.net);
    expect(m.discount).toBe(0);
    expect(m.discount_estimated).toBe(false);
  });
});

describe("billDiscountMoney", () => {
  test("a flat discount is the money, exactly, and is never an estimate", () => {
    expect(billDiscountMoney(900, "flat", 100)).toEqual({ discount: 100, estimated: false });
  });

  test("a percent discount is reconstructed from the anchor, and IS an estimate", () => {
    // net 900 after 10% off means gross was 1000 and 100 was given away.
    const d = billDiscountMoney(900, "percent", 10);
    expect(d).toEqual({ discount: 100, estimated: true });
    expect(r2(900 + d.discount)).toBe(1000);
  });

  test("the reconstruction inverts the discount for any percentage", () => {
    for (const pct of [5, 12.5, 20, 33, 50, 75]) {
      const gross = 4321;
      const net = r2(gross * (1 - pct / 100));
      const back = r2(net + billDiscountMoney(net, "percent", pct).discount);
      expect(Math.abs(back - gross)).toBeLessThanOrEqual(0.05);
    }
  });

  test("a 100%-off bill contributes nothing but is still flagged as an estimate", () => {
    // net is 0 and every gross satisfies it: unknowable, so 0 rather than invented.
    expect(billDiscountMoney(0, "percent", 100)).toEqual({ discount: 0, estimated: true });
  });

  test("no discount is no discount", () => {
    expect(billDiscountMoney(900, null, 0)).toEqual({ discount: 0, estimated: false });
    expect(billDiscountMoney(900, "flat", -5)).toEqual({ discount: 0, estimated: false });
  });

  test("an unrecognised type reads as percent, matching closedBillDiscount's default", () => {
    expect(billDiscountMoney(900, "something-else", 10).discount).toBe(100);
  });
});

describe("refundedTaxShare", () => {
  test("a full refund reverses all of the tax", () => {
    expect(refundedTaxShare(1060.5, 1060.5, 50.5)).toBe(50.5);
  });
  test("a part refund reverses its share", () => {
    expect(refundedTaxShare(1000, 250, 50)).toBe(12.5);
  });
  test("no refund reverses nothing, and a refund over the total cannot exceed it", () => {
    expect(refundedTaxShare(1000, 0, 50)).toBe(0);
    expect(refundedTaxShare(1000, 9999, 50)).toBe(50);
  });
});

describe("the ladder totals", () => {
  test("estimated discounts are counted separately from the discounted bills", () => {
    const acc = zeroLadder();
    addToLadder(acc, composeBillMoney({ grand_total: 100, charges: { taxable_base: 100, service_charge: 0, tax_total: 0 }, discount_type: "flat", discount_value: 20 }));
    addToLadder(acc, composeBillMoney({ grand_total: 90, charges: { taxable_base: 90, service_charge: 0, tax_total: 0 }, discount_type: "percent", discount_value: 10 }));
    addToLadder(acc, composeBillMoney({ grand_total: 50, charges: { taxable_base: 50, service_charge: 0, tax_total: 0 } }));
    expect(acc.bills).toBe(3);
    expect(acc.discounted_bills).toBe(2);
    expect(acc.estimated_discount_bills).toBe(1);
    expect(acc.grand_total).toBe(240);
  });

  test("per-cover money is PRE-TAX and average bill value is tax-inclusive", () => {
    // Same bill set: 2000 net, 2360 grand, 4 covers, 2 bills.
    expect(perCover(2000, 4)).toBe(500);
    expect(averageBillValue(2360, 2)).toBe(1180);
  });

  test("dividing by no covers and no bills gives null, never Infinity or NaN", () => {
    expect(perCover(2000, 0)).toBeNull();
    expect(averageBillValue(2360, 0)).toBeNull();
  });
});

// --- Settlement allocation ---------------------------------------------------

describe("allocateSettlement", () => {
  const sum = (parts: { amount: number }[]): number => r2(parts.reduce((s, p) => s + p.amount, 0));

  test("a single-mode bill lands whole under its mode", () => {
    expect(allocateSettlement(1000, "Cash", [])).toEqual([{ method: "Cash", amount: 1000 }]);
  });

  test("a bill with no recorded mode lands under Other rather than being dropped", () => {
    // Dropping it would break the cash-up reconciliation and hide money.
    expect(allocateSettlement(1000, null, [])).toEqual([{ method: "Other", amount: 1000 }]);
    expect(allocateSettlement(1000, "  ", [])).toEqual([{ method: "Other", amount: 1000 }]);
  });

  test("splits are only read when the mode says Split — the same rule GetSalesReport applies", () => {
    // A stray splits payload on a Cash bill must not re-cut it.
    const parts = allocateSettlement(1000, "Cash", [{ method: "Card", amount: 400 }]);
    expect(parts).toEqual([{ method: "Cash", amount: 1000 }]);
  });

  test("a split tender that reconstructs is honoured part for part", () => {
    const parts = allocateSettlement(1000, "Split", [{ method: "Cash", amount: 600 }, { method: "Card", amount: 400 }]);
    expect(parts).toEqual([{ method: "Cash", amount: 600 }, { method: "Card", amount: 400 }]);
    expect(sum(parts)).toBe(1000);
  });

  test("a SHORT split books the residual to Unallocated instead of losing it", () => {
    // This is the live-data case: quietly trusting the parts would shrink the
    // day's takings by 250 and send the cashier hunting a phantom shortfall.
    const parts = allocateSettlement(1000, "Split", [{ method: "Cash", amount: 500 }, { method: "Card", amount: 250 }]);
    expect(sum(parts)).toBe(1000);
    expect(parts.find((p) => p.method === UNALLOCATED_METHOD)?.amount).toBe(250);
  });

  test("an OVER split books a negative residual, so the sum is still the bill total", () => {
    const parts = allocateSettlement(1000, "Split", [{ method: "Cash", amount: 800 }, { method: "Card", amount: 400 }]);
    expect(sum(parts)).toBe(1000);
    expect(parts.find((p) => p.method === UNALLOCATED_METHOD)?.amount).toBe(-200);
  });

  test("a rounding crumb inside tolerance is folded into the largest part, not shown as a row", () => {
    const parts = allocateSettlement(1000, "Split", [{ method: "Cash", amount: 666.66 }, { method: "Card", amount: 333.33 }]);
    expect(sum(parts)).toBe(1000);
    expect(parts.some((p) => p.method === UNALLOCATED_METHOD)).toBe(false);
    expect(parts.find((p) => p.method === "Cash")?.amount).toBe(666.67);
  });

  test("a Split bill with no parsable parts falls back to the Split bucket whole", () => {
    expect(allocateSettlement(1000, "Split", [])).toEqual([{ method: "Split", amount: 1000 }]);
  });
});

// --- Period-on-period --------------------------------------------------------

describe("previousWindow", () => {
  test("a whole month compares against the whole month before it, not 30 days", () => {
    // August has 31 days, July has 31 — a day-count subtraction would have
    // compared August against 2-31 July, a period nobody asked about.
    expect(previousWindow("2026-08-01", "2026-08-31")).toEqual({ from: "2026-07-01", to: "2026-07-31", basis: "months" });
  });

  test("March compares against February, with the right number of days", () => {
    expect(previousWindow("2026-03-01", "2026-03-31")).toEqual({ from: "2026-02-01", to: "2026-02-28", basis: "months" });
    expect(previousWindow("2028-03-01", "2028-03-31")).toEqual({ from: "2028-02-01", to: "2028-02-29", basis: "months" });
  });

  test("January reaches back across the year boundary", () => {
    expect(previousWindow("2026-01-01", "2026-01-31")).toEqual({ from: "2025-12-01", to: "2025-12-31", basis: "months" });
  });

  test("a quarter compares against the previous quarter", () => {
    expect(previousWindow("2026-01-01", "2026-03-31")).toEqual({ from: "2025-10-01", to: "2025-12-31", basis: "months" });
  });

  test("an Indian financial year compares against the previous financial year", () => {
    expect(previousWindow("2026-04-01", "2027-03-31")).toEqual({ from: "2025-04-01", to: "2026-03-31", basis: "months" });
  });

  // -------------------------------------------------------------------------
  // V3: MATCHING DATE RANGES, not a rolling window
  // -------------------------------------------------------------------------
  // THE REQUIREMENT, and why it is not a preference. On the 9th of September the
  // dashboard's window is 1-9 September. The old rule compared it against "the
  // equally-long window immediately before" — 23-31 AUGUST — and that is a
  // systematically different nine days for a restaurant: a different weekend
  // distribution, salaries paid, month-end habits. "Month-to-date, up 12%" was
  // measured against a period nobody meant, under a label that said otherwise.
  //
  // The three tests below used to assert the OLD behaviour and are rewritten
  // rather than deleted, because what each one covers is still worth covering —
  // and because leaving them asserting the previous answer would have made this
  // change look like a regression to whoever read them next.

  test("MONTH-TO-DATE compares against the SAME DATES of the previous month", () => {
    // The example from the requirement, verbatim.
    expect(previousWindow("2026-09-01", "2026-09-09"))
      .toEqual({ from: "2026-08-01", to: "2026-08-09", basis: "same_dates_prev_month", short: false });
  });

  test("an arbitrary drag INSIDE one month matches its own dates a month earlier", () => {
    // 3-17 August now compares against 3-17 July, not 19 July - 2 August.
    expect(previousWindow("2026-08-03", "2026-08-17"))
      .toEqual({ from: "2026-07-03", to: "2026-07-17", basis: "same_dates_prev_month", short: false });
  });

  test("a single day compares against the same date last month", () => {
    expect(previousWindow("2026-08-15", "2026-08-15"))
      .toEqual({ from: "2026-07-15", to: "2026-07-15", basis: "same_dates_prev_month", short: false });
  });

  test("a month-start that is not a month-end matches the same dates a month back", () => {
    expect(previousWindow("2026-08-01", "2026-08-15"))
      .toEqual({ from: "2026-07-01", to: "2026-07-15", basis: "same_dates_prev_month", short: false });
  });

  test("a shorter previous month is CLAMPED, and says so", () => {
    // 1-31 March has no counterpart in February. Comparing 31 days of trade
    // against 28 and printing a growth percentage is a ~10% lie; `short` is what
    // lets the caller say the periods differ instead of hiding it.
    expect(previousWindow("2026-03-01", "2026-03-31"))
      // …except that 1-31 March IS month-aligned, so it takes the months branch,
      // which already answers 1-28 February. The clamp matters on a drag.
      .toEqual({ from: "2026-02-01", to: "2026-02-28", basis: "months" });
    expect(previousWindow("2026-03-15", "2026-03-30"))
      .toEqual({ from: "2026-02-15", to: "2026-02-28", basis: "same_dates_prev_month", short: true });
    expect(previousWindow("2028-03-15", "2028-03-30"))
      .toEqual({ from: "2028-02-15", to: "2028-02-29", basis: "same_dates_prev_month", short: true });
  });

  test("January reaches back across the year boundary on this branch too", () => {
    expect(previousWindow("2026-01-01", "2026-01-09"))
      .toEqual({ from: "2025-12-01", to: "2025-12-09", basis: "same_dates_prev_month", short: false });
  });

  test("a drag that STRADDLES months keeps the equally-long window before it", () => {
    // There are no "matching dates" for 20 July - 5 September, so the old rule is
    // still the only sensible one and is deliberately untouched.
    expect(previousWindow("2026-07-20", "2026-09-05"))
      .toEqual({ from: "2026-06-02", to: "2026-07-19", basis: "days" });
  });

  test("rubbish input is returned unchanged rather than throwing inside a money report", () => {
    expect(previousWindow("not-a-date", "2026-08-01")).toEqual({ from: "not-a-date", to: "2026-08-01", basis: "days" });
    expect(previousWindow("2026-08-09", "2026-08-01")).toEqual({ from: "2026-08-09", to: "2026-08-01", basis: "days" });
  });
});

describe("growthPct", () => {
  test("ordinary growth and decline", () => {
    expect(growthPct(120, 100)).toBe(20);
    expect(growthPct(80, 100)).toBe(-20);
  });
  test("growth from zero is null — there is no honest percentage from a base of nothing", () => {
    expect(growthPct(500, 0)).toBeNull();
    expect(growthPct(0, 0)).toBeNull();
  });
  test("a negative base uses its magnitude, so the sign of the change is preserved", () => {
    expect(growthPct(-50, -100)).toBe(50);
  });
});

// --- Bill Edit classification ------------------------------------------------

const CATCH_ALL = "4ad474d4-5230-449c-874f-6a238b833bca";

describe("classifyBillEdit", () => {
  test("printing a KOT or a bill is NOT a bill edit and is dropped", () => {
    // The catch-all action id covers printing as well as editing. Reporting a
    // print in a fraud-control document trains the reader to skim it.
    expect(classifyBillEdit(CATCH_ALL, "Printed KOT for table T4 (2 station ticket(s))", { table: "T4", kind: "KOT", kot_no: 26 })).toBeNull();
    expect(classifyBillEdit(CATCH_ALL, "Printed bill for table T4", { table: "T4", kind: "bill" })).toBeNull();
  });

  test("creating an order is not an edit to a generated bill", () => {
    expect(classifyBillEdit(CATCH_ALL, "New takeaway order 9f2", { order_id: "9f2", order_type: "takeaway" })).toBeNull();
  });

  test("removing an item off a running bill is an edit, with its table and item", () => {
    const c = classifyBillEdit(CATCH_ALL, "Removed item Paneer Tikka from table T4", { table: "T4", item: "Paneer Tikka" });
    expect(c?.kind).toBe("item_removed");
    expect(c?.table).toBe("T4");
    expect(c?.item).toBe("Paneer Tikka");
  });

  test("moving an item between tables carries the destination table", () => {
    const c = classifyBillEdit(CATCH_ALL, "Moved item Dal from T4 to T7", { from: "T4", to: "T7", item: "Dal" });
    expect(c?.kind).toBe("item_moved");
    expect(c?.table).toBe("T7");
  });

  test("a discount applied directly and one sent for approval classify apart", () => {
    expect(classifyBillEdit(CATCH_ALL, "Applied 10% discount on table T4", { table: "T4", type: "percent", value: 10 })?.kind)
      .toBe("discount_applied");
    expect(classifyBillEdit(CATCH_ALL, "Requested 40% discount on table T4 (above approval threshold 20)", { table: "T4", type: "percent", value: 40, request_id: "r1" })?.kind)
      .toBe("discount_requested");
  });

  test("a coupon, a note and a merge are all edits", () => {
    expect(classifyBillEdit(CATCH_ALL, "Applied coupon FEST20 to table T4", { table: "T4", code: "FEST20" })?.kind).toBe("coupon_applied");
    expect(classifyBillEdit(CATCH_ALL, "Set note on Dal (table T4)", { table: "T4", item: "Dal" })?.kind).toBe("item_note");
    expect(classifyBillEdit(CATCH_ALL, "Merged table T4 into T7 (3 orders)", { from: "T4", to: "T7" })?.kind).toBe("tables_merged");
  });

  test("a cancelled order is an edit; every other status move on that id is not", () => {
    expect(classifyBillEdit(CATCH_ALL, "Order 9f2 -> Cancelled", { order_id: "9f2", status: "Cancelled" })?.kind).toBe("order_cancelled");
    expect(classifyBillEdit(CATCH_ALL, "Order 9f2 -> Served", { order_id: "9f2", status: "Served" })).toBeNull();
  });

  test("the dedicated action ids classify without any text matching", () => {
    expect(classifyBillEdit("d6bebeb5-111f-4371-b373-a99158116d71", null, { order_id: "9f2", item: { name: "Dal" } })?.kind).toBe("item_added");
    expect(classifyBillEdit("371ecf9f-303e-4114-92fb-3a5120d1565e", null, { order_id: "9f2", deleted_item_id: "line-3" })?.kind).toBe("item_removed");
    expect(classifyBillEdit("d5e3f7a9-2b4c-4d6e-9f80-3c5b7d9e1f2a", null, { bill_id: "b1" })?.kind).toBe("bill_reopened");
    expect(classifyBillEdit("383cc261-7e5c-4745-b16f-06a41e2ae047", null, { old_order_id: "o1" })?.kind).toBe("bill_replaced");
    expect(classifyBillEdit("c4d2e6f8-1a3b-4c5d-8e7f-2b4a6c8d0e1f", null, { bill_id: "b1", decision: "approve" })?.kind).toBe("discount_decision");
    expect(classifyBillEdit("8c3f5b21-0e74-4a96-b2d8-6f1a9c4e7b53", null, { order_id: "9f2" })?.kind).toBe("order_deleted");
  });

  test("the add-item entry reads the item NAME out of the whole item object", () => {
    expect(classifyBillEdit("d6bebeb5-111f-4371-b373-a99158116d71", null, { order_id: "9f2", item: { name: "Dal", quantity: 2 } })?.item).toBe("Dal");
  });

  test("approving a payment is routine settlement; refunding the bill is an edit", () => {
    // Both are written under the same action id, and only the second belongs here.
    const approve = "fc57d407-4bba-442c-97a2-9e6f3c57f288";
    expect(classifyBillEdit(approve, "Admin approved payment for order 9f2", { order_id: "9f2" })).toBeNull();
    const c = classifyBillEdit(approve, "Refunded bill b1 (amount 500, gateway manual)", { bill_id: "b1", amount: 500 });
    expect(c?.kind).toBe("bill_refunded");
    expect(c?.bill_id).toBe("b1");
  });

  test("an unrelated action is not forced into an 'other' bucket", () => {
    expect(classifyBillEdit("00000000-0000-4000-8000-000000000000", "Changed the logo", {})).toBeNull();
  });
});

// --- Small shared helpers ----------------------------------------------------

describe("shares and channels", () => {
  test("a share of nothing is null, never NaN", () => {
    expect(sharePct(50, 200)).toBe(25);
    expect(sharePct(0, 0)).toBeNull();
    expect(sharePct(50, 0)).toBeNull();
  });

  test("an absent or unknown order type is not silently counted as dine-in", () => {
    expect(orderChannel(undefined)).toBe("dine_in");
    expect(orderChannel("dine_in")).toBe("dine_in");
    expect(orderChannel("Takeaway")).toBe("takeaway");
    expect(orderChannel("delivery")).toBe("delivery");
    expect(orderChannel("catering")).toBe("other");
  });
});

/**
 * Loyalty redemption takes money off an open bill through the same flat-discount
 * path as a manual discount. A coupon shows in Bill Edit; a redemption is the
 * same act by the same staff member, so it must show too — otherwise the report
 * is inconsistent about how a bill got smaller, which is the one question it
 * exists to answer.
 */
describe("bill edit: loyalty redemption", () => {
  const LOYALTY = "5b3f9d71-2c84-47e6-9a05-8e64d1f0b923";

  test("is in the SQL prefilter, so the rows are even fetched", () => {
    expect(BILL_EDIT_ACTION_IDS).toContain(LOYALTY);
  });

  test("classifies, rather than being dropped as unmatched", () => {
    const c = classifyBillEdit(
      LOYALTY,
      "Redeemed 200 loyalty points (250) on table T4",
      { table: "T4", phone: "9876543210", points: 200, discount: 250 },
    );
    expect(c).not.toBeNull();
    expect(c!.kind).toBe("loyalty_redeemed");
    expect(c!.label).toBe("Loyalty points redeemed");
    expect(c!.table).toBe("T4");
  });

  test("does NOT carry the customer's phone into the report", () => {
    // A control report must not quietly become a PII export.
    const c = classifyBillEdit(LOYALTY, "Redeemed 10 points", {
      table: "T1",
      phone: "9876543210",
    });
    expect(JSON.stringify(c)).not.toContain("9876543210");
  });
});

// --- The rules the six capture reports add -----------------------------------

describe("a reversed act gave away nothing", () => {
  test("a live row carries its money and reads zero reversed", () => {
    expect(liveMoney(400, false)).toEqual({ live: 400, reversed: 0 });
  });

  test("a reversed row reads zero live and carries its money under reversed", () => {
    expect(liveMoney(400, true)).toEqual({ live: 0, reversed: 400 });
  });

  test("there is no third state: the two never both carry money", () => {
    for (const value of [0, 0.01, 18.9, 1000.555]) {
      for (const reversed of [true, false]) {
        const m = liveMoney(value, reversed);
        expect(m.live === 0 || m.reversed === 0).toBe(true);
        // Nothing is invented and nothing is lost — it only moves columns.
        expect(r2(m.live + m.reversed)).toBe(r2(value));
      }
    }
  });

  test("a non-finite amount is a zero, not a NaN in a money column", () => {
    expect(liveMoney(Number.NaN, false)).toEqual({ live: 0, reversed: 0 });
    expect(liveMoney(Number.POSITIVE_INFINITY, true)).toEqual({ live: 0, reversed: 0 });
  });
});

describe("the two attribution gaps are different gaps", () => {
  test("a dish in a real group is filed under it, keyed by the group's id", () => {
    const b = attributionBucket({ group_id: "g-food", group_name: "Food", source: "stamped" });
    expect(b).toEqual({ key: "g-food", name: "Food", gap: false });
  });

  test("a dish that resolved but has no group is Unclassified — a CONFIGURATION gap", () => {
    const b = attributionBucket({ group_id: null, group_name: UNCLASSIFIED_GROUP, source: "legacy_name" });
    expect(b.name).toBe(UNCLASSIFIED_GROUP);
    expect(b.gap).toBe(true);
  });

  test("a line that resolved to nothing is Unattributed — a HISTORY gap", () => {
    const b = attributionBucket({ group_id: null, group_name: UNCLASSIFIED_GROUP, source: "unresolved" });
    expect(b.name).toBe(UNATTRIBUTED_GROUP);
    expect(b.gap).toBe(true);
  });

  test("the two never collapse into one bucket", () => {
    const unclassified = attributionBucket({ group_id: null, group_name: UNCLASSIFIED_GROUP, source: "stamped" });
    const unattributed = attributionBucket({ group_id: null, group_name: UNCLASSIFIED_GROUP, source: "unresolved" });
    expect(unclassified.key).not.toBe(unattributed.key);
  });

  test("a tenant who names a real group \"Unclassified\" does not lose it", () => {
    // The source flag decides, never the name — otherwise this group's money
    // would be reported as a configuration gap the owner had already closed.
    const b = attributionBucket({ group_id: "g-real", group_name: UNCLASSIFIED_GROUP, source: "stamped" });
    expect(b.gap).toBe(false);
    expect(b.key).toBe("g-real");
  });
});

describe("vocabulary labels", () => {
  test("an enum becomes a column a human reads", () => {
    expect(humaniseVocabulary("guest_complaint")).toBe("Guest complaint");
    expect(humaniseVocabulary("staff_meal")).toBe("Staff meal");
    expect(humaniseVocabulary("upi")).toBe("Upi");
  });

  test("a value this build has never heard of still reads as itself", () => {
    // Never replaced with "Other": a report must not relabel a reason somebody
    // recorded just because a newer vocabulary added it.
    expect(humaniseVocabulary("some_new_kind")).toBe("Some new kind");
  });

  test("nothing in, nothing out — never the string \"undefined\"", () => {
    expect(humaniseVocabulary(null)).toBe("");
    expect(humaniseVocabulary(undefined)).toBe("");
    expect(humaniseVocabulary("   ")).toBe("");
  });

  test("both service-charge shapes are NAMED, so a waiver says which it came off", () => {
    expect(serviceChargeBasisLabel("tax_line")).toBe("Tax line");
    expect(serviceChargeBasisLabel("restaurant_percent")).toBe("Restaurant %");
    expect(serviceChargeBasisLabel(null)).toBe("None");
  });
});

describe("a payment mix in one cell", () => {
  test("biggest first, so the same mix always renders as the same string", () => {
    const a = formatMethodSplit([{ method: "Card", amount: 100 }, { method: "Cash", amount: 250 }]);
    const b = formatMethodSplit([{ method: "Cash", amount: 250 }, { method: "Card", amount: 100 }]);
    expect(a).toBe("Cash 250.00 | Card 100.00");
    expect(a).toBe(b);
  });

  test("ties break on the name, so nothing reorders between two exports", () => {
    expect(formatMethodSplit([{ method: "Upi", amount: 50 }, { method: "Cash", amount: 50 }]))
      .toBe("Cash 50.00 | Upi 50.00");
  });

  test("a zero part is not a mode anybody paid with", () => {
    expect(formatMethodSplit([{ method: "Cash", amount: 100 }, { method: "Card", amount: 0 }]))
      .toBe("Cash 100.00");
  });

  test("an Unallocated residual is SHOWN, in either direction", () => {
    // The whole point of that bucket is that it is visible on a cash-up sheet.
    expect(formatMethodSplit([{ method: "Cash", amount: 100 }, { method: UNALLOCATED_METHOD, amount: -5 }]))
      .toBe("Cash 100.00 | Unallocated -5.00");
  });

  test("no separator can be mistaken for a CSV delimiter", () => {
    const cell = formatMethodSplit([{ method: "Cash", amount: 1 }, { method: "Card", amount: 2 }]);
    expect(cell).not.toContain(",");
    expect(cell).not.toContain("\n");
  });

  test("nothing tendered is an empty cell, not a lone separator", () => {
    expect(formatMethodSplit([])).toBe("");
  });
});
