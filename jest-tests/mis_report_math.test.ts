// THE RULES THE FIFTEEN CONTROL REPORTS SHARE, proved by value.
//
// mis_report_math.ts imports nothing but the other pure modules, so this suite
// loads it directly — no pg mock, no fixture, no database_supabase.ts graph.
// test/money/mis_report_agreement.test.ts proves the same rules survive the trip
// through the real readers and the real SQL; this one proves the arithmetic.

import { describe, test, expect } from "@jest/globals";
import {
  BILL_EDIT_ACTION_IDS,
  EMPTIED_BY_KEY,
  REMOVED_LINES_KEY,
  UNALLOCATED_METHOD,
  UNATTRIBUTED_GROUP,
  addToLadder,
  allocateSettlement,
  attributionBucket,
  averageBillValue,
  billDiscountMoney,
  classifyBillEdit,
  PRINTED_BILL_NEW_ORDER_DOOR,
  composeBillMoney,
  formatMethodSplit,
  growthPct,
  humaniseVocabulary,
  isOrderCancelSentence,
  linesTakenOff,
  liveMoney,
  orderChannel,
  orderLineLabel,
  perCover,
  previousWindow,
  refundedTaxShare,
  serviceChargeBasisLabel,
  settlementByMethod,
  sharePct,
  stampLineRemoval,
  voidItemsText,
  voidKotLines,
  voidLineIdentity,
  zeroLadder,
  type SettlementBill,
} from "../mis_report_math";
import { UNCLASSIFIED_GROUP } from "../mis_capture";

const r2 = (n: number): number => Number(n.toFixed(2));

// --- The ladder --------------------------------------------------------------

describe("the money ladder", () => {
  // 1000 of food, 1% service charge, 5% tax on (food + charge):
  //   net 1000 · sc 10 · tax 50.50 · grand 1060.50 — a bill settled before
  //   migration 048, so its round-off reads back as 0.
  const charges = { taxable_base: 1000, service_charge: 10, tax_total: 50.5, round_off: 0 };

  test("net + service charge + tax + round off === grand total, exactly", () => {
    const m = composeBillMoney({ grand_total: 1060.5, charges });
    expect(r2(m.net + m.service_charge + m.tax + m.round_off)).toBe(m.grand_total);
  });

  test("a bill settled before rounding reports a truthful zero round off", () => {
    expect(composeBillMoney({ grand_total: 1060.5, charges }).round_off).toBe(0);
  });

  test("a rounded bill carries its RECORDED round off as a rung (migration 048)", () => {
    // Gaia's receipt: 4745 + 237.26 of GST = 4982.26, settled at 4982.00.
    const gaia = { taxable_base: 4745, service_charge: 0, tax_total: 237.26, round_off: -0.26 };
    const m = composeBillMoney({ grand_total: 4982, charges: gaia });
    expect(m.round_off).toBe(-0.26);
    expect(m.net).toBe(4745);
    expect(r2(m.net + m.service_charge + m.tax + m.round_off)).toBe(m.grand_total);
  });

  test("the ladder totals sum the round off like every other rung", () => {
    const acc = zeroLadder();
    addToLadder(acc, composeBillMoney({ grand_total: 4982, charges: { taxable_base: 4745, service_charge: 0, tax_total: 237.26, round_off: -0.26 } }));
    addToLadder(acc, composeBillMoney({ grand_total: 1060.5, charges }));
    addToLadder(acc, composeBillMoney({ grand_total: 95, charges: { taxable_base: 90, service_charge: 0, tax_total: 4.5, round_off: 0.5 } }));
    expect(acc.round_off).toBe(0.24);
    expect(r2(acc.net + acc.service_charge + acc.tax + acc.round_off)).toBe(acc.grand_total);
  });

  test("item total minus discount === net, so the top of the ladder is derived, not guessed", () => {
    const m = composeBillMoney({ grand_total: 1060.5, charges, discount_type: "flat", discount_value: 150 });
    expect(m.discount).toBe(150);
    expect(m.item_total).toBe(1150);
    expect(r2(m.item_total - m.discount)).toBe(m.net);
    // The discount does NOT move the bottom of the ladder: total_amt is stored
    // already net of it, which is the whole reason item_total is derived upward.
    expect(m.grand_total).toBe(1060.5);
  });

  test("a bill with no discount has item total === net", () => {
    const m = composeBillMoney({ grand_total: 1060.5, charges });
    expect(m.item_total).toBe(m.net);
    expect(m.discount).toBe(0);
    expect(m.discount_estimated).toBe(false);
  });

  // THE CLIENT'S TWO WORDS. Gross is the grand total — service charge, tax and
  // round off in; Net is the item total less discount — all three out. A
  // restaurant that never discounts (every production tenant in the last 30
  // days) must still see two DIFFERENT numbers, which is the whole complaint.
  test("Gross (grand_total) and Net differ by exactly service charge + tax + round off, discount or not", () => {
    const gaia = { taxable_base: 4745, service_charge: 0, tax_total: 237.26, round_off: -0.26 };
    for (const m of [
      composeBillMoney({ grand_total: 4982, charges: gaia }),
      composeBillMoney({ grand_total: 1060.5, charges, discount_type: "percent", discount_value: 10 }),
    ]) {
      expect(m.grand_total).not.toBe(m.net);
      expect(r2(m.grand_total - m.net)).toBe(r2(m.service_charge + m.tax + m.round_off));
    }
  });

  // `gross` is what installed 1.9.x tills read for their pre-discount tile. Its
  // value must not move while that alias lives — repointed at grand_total, an old
  // till would print "Gross 4982 − Discount 0 = Net 4745".
  test("the deprecated `gross` alias stays the item total, never the grand total", () => {
    const m = composeBillMoney({ grand_total: 1060.5, charges, discount_type: "flat", discount_value: 150 });
    expect(m.gross).toBe(m.item_total);
    expect(m.gross).not.toBe(m.grand_total);
    const acc = addToLadder(zeroLadder(), m);
    addToLadder(acc, composeBillMoney({ grand_total: 1060.5, charges }));
    expect(acc.item_total).toBe(2150);
    expect(acc.gross).toBe(acc.item_total);
    expect(r2(acc.item_total - acc.discount)).toBe(acc.net);
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
    addToLadder(acc, composeBillMoney({ grand_total: 100, charges: { taxable_base: 100, service_charge: 0, tax_total: 0, round_off: 0 }, discount_type: "flat", discount_value: 20 }));
    addToLadder(acc, composeBillMoney({ grand_total: 90, charges: { taxable_base: 90, service_charge: 0, tax_total: 0, round_off: 0 }, discount_type: "percent", discount_value: 10 }));
    addToLadder(acc, composeBillMoney({ grand_total: 50, charges: { taxable_base: 50, service_charge: 0, tax_total: 0, round_off: 0 } }));
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

// --- The cash-up by mode -----------------------------------------------------
//
// settlementByMethod is the Settlement Summary's loop, lifted so the Overview's
// "today by payment method" block is the same computation. These pin the rules
// the owner reconciles a till against; test/money/mis_report_agreement.test.ts
// proves the report and the headline both still read it.

describe("settlementByMethod", () => {
  const bill = (grand_total: number, payment_method: string | null, over: Partial<SettlementBill> = {}): SettlementBill =>
    ({ grand_total, refund: 0, payment_method, splits: [], ...over });
  const total = (rows: { amount: number }[]): number => r2(rows.reduce((s, r) => s + r.amount, 0));
  const row = (out: ReturnType<typeof settlementByMethod>, method: string) => out.rows.find((r) => r.method === method);

  test("single-mode bills group by mode, largest first, with bills and share", () => {
    const out = settlementByMethod([bill(1060.5, "Cash"), bill(530.25, "Card"), bill(1890, "Upi"), bill(318.16, "Cash")]);
    expect(out.rows.map((r) => r.method)).toEqual(["Upi", "Cash", "Card"]);
    expect(row(out, "Cash")).toEqual({ method: "Cash", bills: 2, amount: 1378.66, share_pct: 36.29, refund: 0, net_amount: 1378.66 });
    expect(out.total_amount).toBe(3798.91);
    expect(out.split_bills).toBe(0);
    expect(out.multi_method_bills).toBe(0);
    expect(out.unallocated).toBe(0);
  });

  test("a Cash + UPI split counts under BOTH modes, each with its own part", () => {
    // A ₹1,000 bill paid ₹600 cash and ₹400 UPI is ₹600 of cash, not ₹1,000.
    const out = settlementByMethod([
      bill(1000, "Split", { splits: [{ method: "Cash", amount: 600 }, { method: "Upi", amount: 400 }] }),
      bill(200, "Cash"),
    ]);
    expect(row(out, "Cash")).toMatchObject({ bills: 2, amount: 800 });
    expect(row(out, "Upi")).toMatchObject({ bills: 1, amount: 400 });
    expect(out.split_bills).toBe(1);
    expect(out.multi_method_bills).toBe(1);
    // So the bills column adds to 3 over 2 bills — and split_bills says why.
    expect(out.rows.reduce((s, r) => s + r.bills, 0)).toBe(3);
    expect(out.total_amount).toBe(1200);
  });

  test("a split whose parts fall short sends the residual to Unallocated, and the total still holds", () => {
    const out = settlementByMethod([bill(848.4, "Split", { splits: [{ method: "Cash", amount: 100 }] }), bill(100, "Upi")]);
    expect(row(out, UNALLOCATED_METHOD)?.amount).toBe(748.4);
    expect(out.unallocated).toBe(748.4);
    expect(out.total_amount).toBe(948.4);
    expect(total(out.rows)).toBe(948.4);
  });

  test("a residual is a PART but not a MODE: one real tender plus Unallocated is a split, not a multi-method bill", () => {
    // ₹100 UPI on a ₹300 bill. Two parts, so the report's Split-tender column
    // counts it (as it always has) — but it was paid ONE way, and a sentence
    // saying "paid across more than one method" would be false beside the
    // Unallocated warning that is true.
    const out = settlementByMethod([bill(300, "Split", { splits: [{ method: "Upi", amount: 100 }] })]);
    expect(out.rows.map((r) => r.method)).toEqual([UNALLOCATED_METHOD, "Upi"]);
    expect(out.split_bills).toBe(1);
    expect(out.multi_method_bills).toBe(0);
  });

  test("multi-method counts distinct real modes: a two-part split that is all cash is one mode", () => {
    const out = settlementByMethod([
      // Two cash parts: one mode, however many rows of the tender screen.
      bill(1000, "Split", { splits: [{ method: "Cash", amount: 600 }, { method: "Cash", amount: 400 }] }),
      // Cash + UPI, short by ₹100: two real modes, and a residual on top.
      bill(1000, "Split", { splits: [{ method: "Cash", amount: 500 }, { method: "Upi", amount: 400 }] }),
      // A ₹0 part names a mode that took no money.
      bill(500, "Split", { splits: [{ method: "Card", amount: 500 }, { method: "Upi", amount: 0 }] }),
    ]);
    expect(out.split_bills).toBe(3);
    expect(out.multi_method_bills).toBe(1);
  });

  test("residuals that cancel across bills net to ₹0 — the Unallocated row's bill count is what still says so", () => {
    // ₹50 short on one split, ₹50 over on another. `unallocated` is a netted sum
    // and reads 0; the row survives with both bills, which is why the headline
    // never filters it and the clients warn off the row rather than the sum.
    const out = settlementByMethod([
      bill(1000, "Split", { splits: [{ method: "Cash", amount: 600 }, { method: "Upi", amount: 350 }] }),
      bill(1000, "Split", { splits: [{ method: "Cash", amount: 650 }, { method: "Upi", amount: 400 }] }),
      bill(0, null),
    ]);
    expect(out.unallocated).toBe(0);
    expect(row(out, UNALLOCATED_METHOD)).toEqual({ method: UNALLOCATED_METHOD, bills: 2, amount: 0, share_pct: 0, refund: 0, net_amount: 0 });
    expect(total(out.rows)).toBe(2000);
  });

  test("a sub-tolerance crumb is folded into the largest part, never an Unallocated row", () => {
    const out = settlementByMethod([bill(1000, "Split", { splits: [{ method: "Cash", amount: 666.66 }, { method: "Card", amount: 333.33 }] })]);
    expect(row(out, "Cash")?.amount).toBe(666.67);
    expect(row(out, UNALLOCATED_METHOD)).toBeUndefined();
    expect(out.unallocated).toBe(0);
  });

  test("a refund follows the bill's modes pro rata, and Collected stays what the till took", () => {
    // ₹999.99 paid ⅓ cash, ⅔ card, ₹333.33 refunded: ₹111.11 comes off cash and
    // ₹222.22 off card. The collected column does not move.
    const out = settlementByMethod([
      bill(999.99, "Split", { refund: 333.33, splits: [{ method: "Cash", amount: 333.33 }, { method: "Card", amount: 666.66 }] }),
      bill(777.77, "Card", { refund: 77.7 }),
    ]);
    expect(row(out, "Cash")).toEqual({ method: "Cash", bills: 1, amount: 333.33, share_pct: 18.75, refund: 111.11, net_amount: 222.22 });
    expect(row(out, "Card")).toMatchObject({ bills: 2, amount: 1444.43, refund: 299.92, net_amount: 1144.51 });
    expect(out.total_amount).toBe(1777.76);
  });

  test("a released ₹0 table lands under Other with its bill count — the report never drops a row", () => {
    // The report's bills column has always counted these. Filtering them is the
    // headline's decision (GetOverviewHeadline), not this function's.
    const out = settlementByMethod([bill(0, null), bill(0, null), bill(450, "Cash")]);
    expect(row(out, "Other")).toEqual({ method: "Other", bills: 2, amount: 0, share_pct: 0, refund: 0, net_amount: 0 });
    expect(out.total_amount).toBe(450);
  });

  test("a ₹0 bill carrying a refund cannot divide by zero", () => {
    const out = settlementByMethod([bill(0, "Cash", { refund: 50 })]);
    expect(row(out, "Cash")).toEqual({ method: "Cash", bills: 1, amount: 0, share_pct: null, refund: 0, net_amount: 0 });
  });

  test("nothing settled is an empty cut, not a row of zeroes", () => {
    expect(settlementByMethod([])).toEqual({ rows: [], split_bills: 0, multi_method_bills: 0, unallocated: 0, total_amount: 0 });
  });

  test("THE INVARIANT: Σ rows.amount === Σ bill grand totals, whatever the splits say", () => {
    const bills = [
      bill(1060.5, "Cash"),
      bill(848.4, "Split", { splits: [{ method: "Cash", amount: 500 }, { method: "Card", amount: 348.4 }] }),
      bill(1000, "Split", { splits: [{ method: "Cash", amount: 800 }, { method: "Card", amount: 400 }] }),
      bill(333.34, "Split", { splits: [{ method: "Upi", amount: 111.11 }] }),
      bill(0, null),
      bill(99.99, "  "),
    ];
    const out = settlementByMethod(bills);
    const grand = r2(bills.reduce((s, b) => s + b.grand_total, 0));
    expect(total(out.rows)).toBe(grand);
    expect(out.total_amount).toBe(grand);
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

  test("a cancel that carries its reason is still a cancel, and an undo of one is not", () => {
    // The status route appends the reason it now captures. A suffix match missed
    // every one of those, and matched the undo registry's sentence instead.
    expect(classifyBillEdit(CATCH_ALL, "Order 9f2 -> Cancelled — reason: Other", { order_id: "9f2", status: "Cancelled", reason: "Other" })?.kind)
      .toBe("order_cancelled");
    expect(classifyBillEdit(CATCH_ALL, "Order 9f2 -> canceled", { order_id: "9f2", status: "canceled" })?.kind).toBe("order_cancelled");
    expect(classifyBillEdit(CATCH_ALL, "Undid: Order 9f2 -> Cancelled", { undo_of: "a1" })).toBeNull();
    // The void route keeps its own kind, by its action id, whatever its sentence says.
    expect(classifyBillEdit("c1f83b26-5a97-4e40-b8d3-7e02a9c4f156", "Voided order 9f2 (wrong_entry, ₹50.00, before_print)", { order_id: "9f2" })?.kind)
      .toBe("order_voided");
  });

  test("the cancel sentence is anchored at the start, as the Void KOT join's ilike is", () => {
    // SQL twin: l.reason ilike 'Order % -> Cancel%'.
    expect(isOrderCancelSentence("Order 9f2 -> Cancelled")).toBe(true);
    expect(isOrderCancelSentence("order 9f2 -> CANCELLED — reason: Guest left")).toBe(true);
    expect(isOrderCancelSentence("Undid: Order 9f2 -> Cancelled")).toBe(false);
    expect(isOrderCancelSentence("Removed 1x Chai (50.00) from order 9f2 -> Cancelled table")).toBe(false);
    expect(isOrderCancelSentence("Order 9f2 -> Served")).toBe(false);
    expect(isOrderCancelSentence(null)).toBe(false);
  });

  test("the dedicated action ids classify without any text matching", () => {
    expect(classifyBillEdit("d6bebeb5-111f-4371-b373-a99158116d71", null, { order_id: "9f2", item: { name: "Dal" } })?.kind).toBe("item_added");
    expect(classifyBillEdit("371ecf9f-303e-4114-92fb-3a5120d1565e", null, { order_id: "9f2", deleted_item_id: "line-3" })?.kind).toBe("item_removed");
    expect(classifyBillEdit("d5e3f7a9-2b4c-4d6e-9f80-3c5b7d9e1f2a", null, { bill_id: "b1" })?.kind).toBe("bill_reopened");
    expect(classifyBillEdit("383cc261-7e5c-4745-b16f-06a41e2ae047", null, { old_order_id: "o1" })?.kind).toBe("bill_replaced");
    expect(classifyBillEdit("c4d2e6f8-1a3b-4c5d-8e7f-2b4a6c8d0e1f", null, { bill_id: "b1", decision: "approve" })?.kind).toBe("discount_decision");
    expect(classifyBillEdit("8c3f5b21-0e74-4a96-b2d8-6f1a9c4e7b53", null, { order_id: "9f2" })?.kind).toBe("order_deleted");
  });

  // INTEGRATION REVIEW (kot-reports-email): 2.0.2 lets a waiter add a whole order
  // to a printed bill, and the report whose job is "what changed after the bill
  // was generated" — emailed daily now — had no row for it.
  test("a new order placed on a PRINTED bill is an edit, keyed on its writer's flag, with its order and table", () => {
    const line = "ADDED an order on the printed bill of table 12 (printed 1 time(s))";
    const details = { table: "12", after_print: true, write: "order", print_count: 1, confirmed: true, waiter_only: true, order_id: "9f2", door: PRINTED_BILL_NEW_ORDER_DOOR };
    const c = classifyBillEdit(CATCH_ALL, line, details);
    expect(c).toMatchObject({ kind: "printed_bill_order_added", label: "Order added after the bill was printed", order_id: "9f2", table: "12" });
    expect(PRINTED_BILL_NEW_ORDER_DOOR).toBe("new_order");
    // The reason text is not what decides it: the same flags under other words still classify.
    expect(classifyBillEdit(CATCH_ALL, "something else", details)?.kind).toBe("printed_bill_order_added");
  });

  test("…while the other doors' addition lines stay unclassified (each files its own classified line), and so does 'New order'", () => {
    const base = { table: "12", after_print: true, print_count: 1, confirmed: true, waiter_only: false };
    // POST /orders/:id/items (its Item added line classifies), a merge, a move: no door.
    expect(classifyBillEdit(CATCH_ALL, "ADDED an order on the printed bill of table 12 (printed 1 time(s))", { ...base, write: "order" })).toBeNull();
    expect(classifyBillEdit(CATCH_ALL, "ADDED a merge into the printed bill of table 12 (printed 1 time(s))", { ...base, write: "merge" })).toBeNull();
    expect(classifyBillEdit(CATCH_ALL, "ADDED a move onto the printed bill of table 12 (printed 1 time(s))", { ...base, write: "move" })).toBeNull();
    // A door without the after-print flag, or a string flag, is not the writer's claim.
    expect(classifyBillEdit(CATCH_ALL, "x", { door: PRINTED_BILL_NEW_ORDER_DOOR })).toBeNull();
    expect(classifyBillEdit(CATCH_ALL, "x", { after_print: "true", door: PRINTED_BILL_NEW_ORDER_DOOR })).toBeNull();
    // Placing an order is still not an edit by itself.
    expect(classifyBillEdit(CATCH_ALL, "New order 9f2 on table 12", { order_id: "9f2", table: "12" })).toBeNull();
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

describe("a voided ticket's dishes in one cell", () => {
  test("Name (Variation) xQty, one entry per line, joined by semicolons", () => {
    expect(voidItemsText([
      { name: "Biryani", variation: "Half", quantity: 2 },
      { name: "Raita", variation: null, quantity: 1 },
    ])).toBe("Biryani (Half) x2; Raita x1");
  });

  test("the same dish twice stays two entries, so the cell counts what Lines counts", () => {
    const lines = [
      { name: "Chai", variation: null, quantity: 1 },
      { name: "Chai", variation: null, quantity: 1 },
    ];
    expect(voidItemsText(lines)?.split("; ")).toHaveLength(lines.length);
  });

  test("a comma in a dish name cannot be mistaken for a line break, and nothing leaves Latin-1", () => {
    const cell = voidItemsText([{ name: "Paneer, Butter", variation: null, quantity: 1 }]) ?? "";
    expect(cell).toBe("Paneer, Butter x1");
    expect(cell).not.toContain(";");
    // The app's PDF font draws Latin-1 only: a multiplication sign would print as "?".
    expect(voidItemsText([{ name: "Dal", variation: null, quantity: 3 }])).toMatch(/^[ -~]*$/);
  });

  test("no lines is a blank cell, not an empty string pretending to be a list", () => {
    expect(voidItemsText([])).toBeNull();
  });

  test("the cell and the drill-down label a line alike: the dish, and its size when it has one", () => {
    expect(orderLineLabel({ name: "Biryani", variation: "Half" })).toBe("Biryani (Half)");
    expect(orderLineLabel({ name: "Raita", variation: null })).toBe("Raita");
    const lines = [{ name: "Biryani", variation: "Half", quantity: 1 }, { name: "Biryani", variation: "Full", quantity: 1 }];
    expect(voidItemsText(lines)).toBe(lines.map((l) => `${orderLineLabel(l)} x1`).join("; "));
  });

  test("a stored line is read as its dish and its size, trimmed, with nothing invented", () => {
    expect(voidLineIdentity({ name: " Biryani ", variation_name: " Half " })).toEqual({ name: "Biryani", variation: "Half" });
    expect(voidLineIdentity({ name: "Dal", variation_name: "" })).toEqual({ name: "Dal", variation: null });
    // Junk from an old client: never "[object Object]", never "undefined".
    expect(voidLineIdentity({ name: { en: "Dal" } })).toEqual({ name: "Item", variation: null });
    expect(voidLineIdentity(null)).toEqual({ name: "Item", variation: null });
  });
});

describe("what a bill-item removal leaves on the order", () => {
  const AT = "2026-09-14T14:40:00.000Z";
  const helios = { id: "l1", name: "HELIOS", price: 450, quantity: 1 };
  const ares = { id: "l2", name: "ARES", price: 300, quantity: 2 };

  test("a removal keeps the lines it took, as they stood, with the moment", () => {
    const food = stampLineRemoval({ items: [ares], subtotal: 600 }, [helios], "remove", false, AT);
    expect(food[REMOVED_LINES_KEY]).toEqual([{ ...helios, removed_at: AT }]);
    expect(food.items).toEqual([ares]);
    // Not emptied, so nothing claims it was.
    expect(food[EMPTIED_BY_KEY]).toBeUndefined();
  });

  test("a second removal appends; the first one's lines survive it", () => {
    const first = stampLineRemoval({ items: [ares] }, [helios], "remove", false, AT);
    const second = stampLineRemoval({ ...first, items: [] }, [ares], "remove", true, AT);
    expect((second[REMOVED_LINES_KEY] as { name: string }[]).map((l) => l.name)).toEqual(["HELIOS", "ARES"]);
    expect(second[EMPTIED_BY_KEY]).toBe("remove");
  });

  test("a move records no removed lines, because the dish is still on a bill", () => {
    const food = stampLineRemoval({ items: [] }, [helios], "move", true, AT);
    expect(food[REMOVED_LINES_KEY]).toBeUndefined();
    expect(food[EMPTIED_BY_KEY]).toBe("move");
  });

  test("the input blob is never mutated", () => {
    const input = { items: [ares] };
    stampLineRemoval(input, [helios], "remove", true, AT);
    expect(input).toEqual({ items: [ares] });
  });

  test("an items-split write took off exactly the lines that are gone, as they stood", () => {
    expect(linesTakenOff([helios, ares], [ares])).toEqual([helios]);
    expect(linesTakenOff([helios, ares], [])).toEqual([helios, ares]);
    // Adding a line takes nothing off.
    expect(linesTakenOff([helios], [helios, ares])).toEqual([]);
  });

  test("a line moved between Served and Preparing, or re-quantified, is the same line", () => {
    // The split is flattened Served-first, so a moved line changes position.
    expect(linesTakenOff([helios, ares], [ares, helios])).toEqual([]);
    expect(linesTakenOff([ares], [{ ...ares, quantity: 1 }])).toEqual([]);
    // An old client's id-less line is known by dish, size and price.
    const chai = { name: "Chai", price: 50, quantity: 2 };
    expect(linesTakenOff([chai], [{ ...chai, quantity: 1 }])).toEqual([]);
    expect(linesTakenOff([chai], [{ ...chai, price: 60 }])).toEqual([chai]);
    expect(linesTakenOff([{ ...chai, variation_name: "Large" }], [chai])).toEqual([{ ...chai, variation_name: "Large" }]);
  });

  test("matching is one for one: two identical lines of which one survived are one removal", () => {
    const chai = { name: "Chai", price: 50, quantity: 1 };
    expect(linesTakenOff([chai, chai], [chai])).toEqual([chai]);
    expect(linesTakenOff([{ id: "x", ...chai }, { id: "x", ...chai }], [{ id: "x", ...chai }])).toHaveLength(1);
  });

  test("the report reads the lines still on a ticket first, and the removed ones only when none are left", () => {
    expect(voidKotLines({ items: [ares], [REMOVED_LINES_KEY]: [helios] })).toEqual([ares]);
    expect(voidKotLines({ items: [], [REMOVED_LINES_KEY]: [helios] })).toEqual([helios]);
    expect(voidKotLines({ items: [] })).toEqual([]);
    // Junk in either key is no lines, never a crash.
    expect(voidKotLines({ items: "nope", [REMOVED_LINES_KEY]: { not: "a list" } })).toEqual([]);
  });
});
