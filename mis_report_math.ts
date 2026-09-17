/**
 * THE MONEY LADDER FOR THE MIS / CONTROL REPORTS — and the pure rules the
 * fifteen of them share.
 *
 * PURE module: it imports only the other pure modules (billing_math.ts,
 * report_window.ts) and touches no database, no clock and no network. Same
 * discipline as billing_math.ts / report_window.ts / simulation_math.ts, and for
 * the same reason: every rule below is decided by value, so jest can prove it
 * without a pg pool. The fifteen readers at the bottom of database_supabase.ts
 * are the only consumers.
 *
 * ============================================================================
 * THE LADDER. WRITTEN ONCE. EVERY REPORT THAT REPORTS SALES DERIVES FROM IT.
 * ============================================================================
 *
 * These are FRAUD-CONTROL documents. Two of them disagreeing about "net sales"
 * is how an auditor stops believing all fifteen, so the composition is pinned
 * here and nowhere else:
 *
 *     items_gross      Σ price × quantity over the order lines behind the bill.
 *                      Reconstructible only PER BILL (Orders.food is a JSON blob
 *                      and there is no OrderItems table), never stored, and NOT
 *                      part of this ladder — see the Item Wise note below.
 *     ────────────────────────────────────────────────────────────────────────
 *       item_total     = net + discount   "Item total"             (DERIVED UP)
 *     − discount       Bills.discount_value resolved to money (billDiscountMoney)
 *     ────────────────────────────────────────────────────────────────────────
 *     = net            closedBillCharges().taxable_base   "Net"   ← THE ANCHOR
 *     + service_charge closedBillCharges().service_charge
 *     + tax            closedBillCharges().tax_total
 *     + round_off      closedBillCharges().round_off  ("Bills".round_off, 048)
 *     ────────────────────────────────────────────────────────────────────────
 *     = grand_total    Bills.total_amt   "Gross"  (TAX-INCLUSIVE, already net
 *                                                  of discount, before refunds)
 *
 * THE THREE WORDS, AND WHY THEY ARE THESE. The client's own definitions: GROSS
 * is "the total value of all the bills including service charge, taxes and so
 * on" — the grand total, round off included, because that is the figure printed
 * on the bill and taken at the till. NET is "just the menu price value of the
 * bills" with the discount, service charge and tax taken back out — `net`. The
 * rung ABOVE the discount had been called "gross", which put one word on two
 * different numbers and printed Gross === Net on every report of a restaurant
 * that never discounts. It is now "Item total" (`item_total`). Every column
 * labelled Gross is keyed grand_total and every one labelled Net is keyed net;
 * test/money pins that on every payload.
 *
 * `gross` IS A DEPRECATED ALIAS OF `item_total`, same value, kept because
 * installed 1.9.x tills read ladder['gross'] for their pre-discount tile. It must
 * NEVER be repointed at grand_total: an old till would then print
 * "Gross 4982 − Discount 0 = Net 4745", arithmetic that does not add up. Remove
 * it once the minimum app version reads item_total.
 *
 * WHY `net` IS THE ANCHOR AND `item_total` IS DERIVED UPWARD. The only stored money
 * fact on a settled bill is total_amt, the tax-inclusive grand total. Everything
 * above it is recovered by SUBTRACTION inside closedBillCharges, which is what
 * makes `net + service_charge + tax + round_off === grand_total` hold EXACTLY, per bill, in
 * both service-charge shapes. Building the ladder the other way round — summing
 * reconstructed item lines up to a total — would leave a residual on every bill
 * whose items cannot be rebuilt, and a control report with a residual is a
 * control report nobody signs.
 *
 * ROUND OFF is a real rung since migration 048. Every bill is rounded to the
 * rupee inside computeBillCharges and the settle paths record the adjustment in
 * "Bills".round_off beside total_amt, so it is READ, never derived: subtracting
 * it before the charges are split is what keeps the paise out of `net` (and so
 * out of APC and GST turnover). A bill settled before rounding existed has NULL
 * there, which reads as 0 — exactly what it was. It is carried even when zero,
 * because "where is the round off?" is the first question an auditor asks of an
 * Indian bill, and a silent absence reads as a missing number.
 *
 * CANCELLED IS NOT SALES. "Orders".status = 5 never contributes to any revenue
 * figure anywhere (it appears only as the SUBJECT of the Void report).
 *
 * A NON-CHARGEABLE IS NOT A RUNG. A comped dish never reached total_amt, so it
 * is already absent from `net` and from every rung above it. It is reported
 * BESIDE the ladder — never inside it — because adding it back would invent
 * revenue the guest was never charged, and leaving it out entirely would hide
 * revenue that was given away. Both facts, in two places, is the only honest
 * shape. See the NC Summary and `non_chargeable` on the Sales Summary.
 *
 * A TIP IS NOT REVENUE AND NOT A RUNG EITHER. "BillTenders".tip_amount rides on
 * a tender and is excluded from every sum of `amount`, so it reaches no rung, no
 * APC, no ABV and no settlement bucket. The Tip Summary reports it and reports
 * nothing else.
 *
 * COVERS ARE COUNTED ONCE PER SEATING, never per bill: split bills on one table
 * share one "TableSessions" row, and counting covers per bill is what doubles a
 * party of four into eight. A bill with no resolvable seating contributes its
 * MONEY but no covers, and the per-cover figures say how many bills that was.
 *
 * PER-COVER MONEY IS PRE-TAX (the house APC convention — see
 * mapClosedBillSummary): the basis is `net`, never grand_total. ABV (average
 * bill value) is the other way round: grand_total ÷ bills, because that is the
 * number on the paper the guest was handed.
 *
 * WHAT THE MUST-AGREE REPORTS AGREE ON. Over one window:
 *     Sales Summary.grand_total
 *       === Σ Order Summary rows.grand_total
 *       === Σ Settlement Summary rows.amount
 *       === Σ Counter Summary rows.grand_total
 * The first two are the same bill set summed twice. The third is that same set
 * re-cut by payment mode, which is why allocateSettlement below refuses to lose a
 * paisa: a split tender whose parts do not reconstruct the bill total sends the
 * residual to an explicit Unallocated bucket rather than quietly shrinking the
 * day's takings. jest proves all three equal — see test/money.
 *
 * ITEM WISE CANNOT BE MADE TO RECONCILE WITH THE BILL-LEVEL REPORTS, and pretending
 * otherwise would be the dishonest option. It is bucketed by ORDER PLACEMENT
 * time; every other report is bucketed by SETTLEMENT time, because that is when
 * the money exists. An order placed at 23:50 and settled at 00:10 belongs to two
 * different days in the two views, and no amount of arithmetic reconciles that.
 * The Item Wise payload says so in its own `notes`, and its money basis is the
 * MENU PRICE (price × quantity), which is above `item_total` on the ladder: it carries
 * no bill-level discount, no service charge and no tax. The Group Summary and
 * the Variation Summary are the SAME cut of the SAME lines on the SAME clock, so
 * those three tie to each other exactly and to nothing else — jest proves that
 * too, because three item-level reports disagreeing is the same failure one
 * level down.
 */

import { round2 } from "./billing_math.js";
import { addDaysToKey, countDays } from "./report_window.js";

// --- The ladder --------------------------------------------------------------

/** One settled bill's money, composed exactly as the ladder above. */
export interface BillMoney {
  /** "Item total": net + discount. Pre-discount food value. DERIVED, never stored. */
  item_total: number;
  /**
   * @deprecated Same value as `item_total`, for installed 1.9.x tills. NOT the
   * client's Gross — that is `grand_total`. See the header before touching it.
   */
  gross: number;
  /** Money removed by a bill discount or coupon. See billDiscountMoney. */
  discount: number;
  /** THE ANCHOR: closedBillCharges().taxable_base — post-discount, pre-SC, pre-tax. */
  net: number;
  service_charge: number;
  tax: number;
  /** "Bills".round_off (migration 048): what rounded the bill to the rupee. 0 before it. */
  round_off: number;
  /** "Gross": "Bills".total_amt. net + service_charge + tax + round_off, exactly. */
  grand_total: number;
  /** "Bills".refund_amount. Reverses a TAX-INCLUSIVE amount. */
  refund: number;
  /** The share of `tax` sitting inside the refunded portion. */
  refunded_tax: number;
  /** True when the discount money was RECONSTRUCTED from a stored percentage. */
  discount_estimated: boolean;
}

/** The classified charges of one settled bill — closedBillCharges()'s output. */
export interface BillCharges {
  taxable_base: number;
  service_charge: number;
  tax_total: number;
  round_off: number;
}

/**
 * The MONEY a stored discount removed.
 *
 * Two stored shapes, and only one of them is a fact:
 *
 *   flat    — discount_value IS the money. Every coupon, gift voucher and
 *             loyalty redemption is written flat (ApplyCouponToBill), so this is
 *             the common case and it is exact.
 *   percent — discount_value is the RAW PERCENTAGE and the money it removed was
 *             never snapshotted. It is recovered from the anchor:
 *                 net      = gross × (1 − p/100)
 *                 ⇒ gross  = net ÷ (1 − p/100)
 *                 ⇒ disc   = gross − net = net × p ÷ (100 − p)
 *             `estimated` is true for these, and every report that totals them
 *             reports how many bills were estimates rather than burying it.
 *
 * A 100%-off bill is unknowable (net is 0 and every gross satisfies it), so it
 * contributes 0 and is still counted as an estimate — an invented number would
 * be worse than a visible gap.
 *
 * NOTE ON THE BASIS, because it differs from the legacy /reports/discounts.
 * That endpoint reconstructs the percent case from `(total − tax) ÷ (1 + sc/100)`
 * using "Restaurant".service_charge. On a tenant that instead lists "Service
 * Charge" as a line inside Outlets.default_tax (shape (b) — the shipped seed
 * does exactly this, and service_charge is then 0) that expression leaves the
 * service charge INSIDE the base and over-states the discount by the charge's
 * share. This module takes `net` from closedBillCharges, which lifts the charge
 * out in BOTH shapes, so it is right in both. The legacy endpoint is deliberately
 * left untouched.
 */
export function billDiscountMoney(
  net: number,
  discountType: string | null | undefined,
  discountValue: number,
): { discount: number; estimated: boolean } {
  const value = Number.isFinite(discountValue) ? Math.max(0, discountValue) : 0;
  if (!(value > 0)) {return { discount: 0, estimated: false };}
  if (discountType === "flat") {return { discount: round2(value), estimated: false };}
  // Anything not explicitly flat is a percentage — same reading as
  // closedBillDiscount / getOpenBillDiscount, which default to "percent".
  const p = Math.min(value, 100);
  if (p >= 100) {return { discount: 0, estimated: true };}
  const base = Number.isFinite(net) ? Math.max(0, net) : 0;
  return { discount: round2((base * p) / (100 - p)), estimated: true };
}

/**
 * The tax reversed by a refund. A refund is recorded on the bill row WITHOUT
 * rewriting total_amt or tax_breakdown, so the refunded gross and the tax inside
 * it are both still in the totals; this is the part a report must net out rather
 * than subtracting a tax-inclusive refund from an already-ex-tax figure. Same
 * rule as refundedTaxOf in the accounting readers, kept identical on purpose.
 */
export function refundedTaxShare(grandTotal: number, refund: number, tax: number): number {
  if (!(grandTotal > 0) || !(refund > 0)) {return 0;}
  return round2((tax * Math.min(refund, grandTotal)) / grandTotal);
}

/**
 * Compose one settled bill onto the ladder.
 *
 * `charges` must come from closedBillCharges (the SAME classifier the bill
 * detail, the accounting reports and APC use), which guarantees
 * taxable_base + service_charge + tax_total + round_off === grand_total. This function does
 * not re-derive that split and must never be handed a hand-rolled one.
 */
export function composeBillMoney(input: {
  grand_total: number;
  charges: BillCharges;
  discount_type?: string | null;
  discount_value?: number | null;
  refund_amount?: number | null;
}): BillMoney {
  const grand_total = round2(input.grand_total);
  const net = round2(input.charges.taxable_base);
  const service_charge = round2(input.charges.service_charge);
  const tax = round2(input.charges.tax_total);
  const d = billDiscountMoney(net, input.discount_type, input.discount_value ?? 0);
  const refund = round2(Math.max(0, input.refund_amount ?? 0));
  const item_total = round2(net + d.discount);
  return {
    item_total,
    gross: item_total,
    discount: d.discount,
    net,
    service_charge,
    tax,
    round_off: round2(input.charges.round_off),
    grand_total,
    refund,
    refunded_tax: refundedTaxShare(grand_total, refund, tax),
    discount_estimated: d.estimated,
  };
}

/** An empty rung set — what a window with no bills must return (never a 500). */
export function zeroLadder(): LadderTotals {
  return {
    item_total: 0, gross: 0, discount: 0, net: 0, service_charge: 0, tax: 0,
    round_off: 0, grand_total: 0, refund: 0, refunded_tax: 0,
    bills: 0, covers: 0, discounted_bills: 0, estimated_discount_bills: 0,
  };
}

/** The ladder, summed over a set of bills, plus the counts that qualify it. */
export interface LadderTotals {
  item_total: number;
  /** @deprecated Same value as `item_total` — see BillMoney.gross. */
  gross: number;
  discount: number;
  net: number;
  service_charge: number;
  tax: number;
  round_off: number;
  grand_total: number;
  refund: number;
  refunded_tax: number;
  bills: number;
  /** Counted ONCE PER SEATING. See the header. */
  covers: number;
  discounted_bills: number;
  /** How many of `discounted_bills` had their discount reconstructed. */
  estimated_discount_bills: number;
}

/** Add one bill onto a running total. Mutates and returns `acc` (hot loop). */
export function addToLadder(acc: LadderTotals, m: BillMoney): LadderTotals {
  acc.item_total = round2(acc.item_total + m.item_total);
  acc.gross = round2(acc.gross + m.gross);
  acc.discount = round2(acc.discount + m.discount);
  acc.net = round2(acc.net + m.net);
  acc.service_charge = round2(acc.service_charge + m.service_charge);
  acc.tax = round2(acc.tax + m.tax);
  acc.round_off = round2(acc.round_off + m.round_off);
  acc.grand_total = round2(acc.grand_total + m.grand_total);
  acc.refund = round2(acc.refund + m.refund);
  acc.refunded_tax = round2(acc.refunded_tax + m.refunded_tax);
  acc.bills += 1;
  if (m.discount > 0 || m.discount_estimated) {
    acc.discounted_bills += 1;
    if (m.discount_estimated) {acc.estimated_discount_bills += 1;}
  }
  return acc;
}

/** Per-cover money is PRE-TAX (`net`); ABV is the tax-inclusive grand total. */
export function perCover(net: number, covers: number): number | null {
  return covers > 0 ? round2(net / covers) : null;
}
export function averageBillValue(grandTotal: number, bills: number): number | null {
  return bills > 0 ? round2(grandTotal / bills) : null;
}

// --- Settlement allocation ---------------------------------------------------

/** Where the sum of a split tender's parts goes when it does not reconstruct. */
export const UNALLOCATED_METHOD = "Unallocated";
/** The mode a bill with no recorded payment method lands in. */
export const UNRECORDED_METHOD = "Other";
/** Tolerance for "the parts add up" — a paisa of float noise, nothing more. */
const SPLIT_TOLERANCE = 0.05;

export interface SettlementPart { method: string; amount: number }

/**
 * Cut ONE settled bill by payment mode, LOSING NOTHING.
 *
 * The Settlement Summary is what a cashier cashes up against, so its total is
 * required to equal the Sales Summary's grand total exactly (jest asserts this).
 * That makes the split-tender case the whole problem: "Bills".payment_splits is
 * free-form JSON written by the settle path, and live data contains rows whose
 * parts do not add back to total_amt. Silently trusting them shrinks the day's
 * takings by the difference and the cashier hunts a phantom shortfall.
 *
 * So: parts are honoured, and any residual — in EITHER direction — is booked to
 * an explicit Unallocated bucket. The report shows it, which is the point.
 *
 * Splits are only read when payment_method is 'split', mirroring GetSalesReport
 * exactly, so the two by-method cuts can never disagree about which bills are
 * even eligible to be split.
 */
export function allocateSettlement(
  grandTotal: number,
  paymentMethod: string | null | undefined,
  splits: SettlementPart[],
): SettlementPart[] {
  const total = round2(grandTotal);
  const method = (paymentMethod ?? "").trim();
  if (method.toLowerCase() !== "split" || splits.length === 0) {
    return [{ method: method || UNRECORDED_METHOD, amount: total }];
  }
  const parts = splits.map((s) => ({ method: s.method, amount: round2(s.amount) }));
  const allocated = round2(parts.reduce((s, p) => s + p.amount, 0));
  const residual = round2(total - allocated);
  if (Math.abs(residual) > SPLIT_TOLERANCE) {
    parts.push({ method: UNALLOCATED_METHOD, amount: residual });
  } else if (residual !== 0) {
    // Inside tolerance: fold the rounding crumb into the largest part so the
    // bucket sum is still EXACTLY the bill total. An Unallocated row of ₹0.01
    // would be noise on a cash-up sheet; a one-paisa gap would be a bug hunt.
    // `parts` is non-empty here: the guard above returned for splits.length === 0.
    let biggest = parts[0];
    for (const part of parts) {
      if (part.amount > biggest.amount) {biggest = part;}
    }
    biggest.amount = round2(biggest.amount + residual);
  }
  return parts;
}

/** One settled bill, as the by-mode cut needs it. */
export interface SettlementBill {
  /** The bill's composed grand total — BillMoney.grand_total. */
  grand_total: number;
  /** BillMoney.refund. A refund has no mode of its own; see settlementByMethod. */
  refund: number;
  payment_method: string | null | undefined;
  splits: SettlementPart[];
}

/** One payment mode's line on a cash-up. */
export interface SettlementMethodRow {
  method: string;
  /** Bills that touched this mode. A split bill counts under each mode it used. */
  bills: number;
  amount: number;
  share_pct: number | null;
  refund: number;
  net_amount: number;
}

export interface SettlementByMethod {
  /** Largest amount first. Includes the Other and Unallocated buckets when used. */
  rows: SettlementMethodRow[];
  /**
   * Bills cut into more than one PART — the Settlement Summary's own count,
   * unchanged. An Unallocated residual is a part, so a 'Split' bill whose only
   * tender is ₹100 UPI on a ₹300 bill counts here.
   */
  split_bills: number;
  /**
   * Bills whose money came in by MORE THAN ONE REAL MODE: distinct modes with
   * money on them, the Unallocated residual not among them. The bill above —
   * ₹100 UPI and ₹200 nobody can place — was paid one way and is missing money;
   * a sentence saying it was "paid across more than one method" would be false,
   * and would sit right beside the warning that is true. Use this for any copy
   * that makes that claim.
   */
  multi_method_bills: number;
  /** Money that split parts failed to account for. Should always be 0. */
  unallocated: number;
  /** Σ rows.amount — equal to the bills' grand totals, by allocateSettlement. */
  total_amount: number;
}

/**
 * THE CASH-UP BY PAYMENT MODE, for any set of settled bills.
 *
 * Lifted verbatim out of GetSettlementSummaryReport so the Overview's "today by
 * payment method" block and the Settlement Summary are ONE computation rather
 * than two that agree today. Three different by-mode sums already exist in the
 * data layer (this one, GetSalesReport.by_method, cashTotalsSince); they only
 * agree while nobody has split a tender with a residual or refunded a bill. A
 * screen that put a Cash row from one of them beside a Cash tile from another
 * would eventually show an owner two answers to "how much cash came in", so
 * every new surface reads this.
 *
 * Every rule is allocateSettlement's plus two of its own:
 *
 *   * A BILL COUNTS ONCE UNDER EACH MODE IT TOUCHED, so the bills column can add
 *     up to more than the bill count. `split_bills` says by how much.
 *   * A REFUND FOLLOWS THE MONEY. "Bills" records a refund without a mode, so
 *     each part carries its share of the bill's refund, pro rata. `amount` stays
 *     what the till took; `net_amount` is what survived.
 *
 * Nothing is filtered. A released ₹0 table lands under Other with a bill count
 * and ₹0, because the Settlement Summary's bills column has always counted it;
 * a surface that does not want that row filters it at the surface.
 *
 * Order-sensitive only in the ways the report always was: accumulation is in
 * the order given (callers pass settle order), each step round2'd, and the rows
 * are sorted by amount descending with the insertion order breaking ties.
 */
export function settlementByMethod(bills: readonly SettlementBill[]): SettlementByMethod {
  const acc = new Map<string, { bills: number; amount: number; refund: number }>();
  let splitBills = 0;
  let multiMethodBills = 0;
  let unallocated = 0;
  for (const b of bills) {
    const parts = allocateSettlement(b.grand_total, b.payment_method, b.splits);
    if (parts.length > 1) {splitBills += 1;}
    // Counted apart from split_bills rather than instead of it: the report's
    // "Split-tender bills" column has always been parts.length > 1, and changing
    // it would move a number on a report owners already reconcile against.
    const realModes = new Set(
      parts.filter((p) => p.method !== UNALLOCATED_METHOD && p.amount !== 0).map((p) => p.method),
    );
    if (realModes.size > 1) {multiMethodBills += 1;}
    for (const p of parts) {
      if (p.method === UNALLOCATED_METHOD) {unallocated = round2(unallocated + p.amount);}
      const e = acc.get(p.method) ?? { bills: 0, amount: 0, refund: 0 };
      e.bills += 1;
      e.amount = round2(e.amount + p.amount);
      // A refund has no mode of its own, so it follows the money: each part
      // carries its share of the bill's refund.
      if (b.refund > 0 && b.grand_total > 0) {
        e.refund = round2(e.refund + (b.refund * p.amount) / b.grand_total);
      }
      acc.set(p.method, e);
    }
  }

  const totalAmount = round2([...acc.values()].reduce((s, v) => s + v.amount, 0));
  const rows: SettlementMethodRow[] = [...acc.entries()]
    .map(([method, v]) => ({
      method,
      bills: v.bills,
      amount: v.amount,
      share_pct: sharePct(v.amount, totalAmount),
      refund: round2(v.refund),
      net_amount: round2(v.amount - v.refund),
    }))
    .sort((a, z) => z.amount - a.amount);

  return {
    rows, split_bills: splitBills, multi_method_bills: multiMethodBills, unallocated, total_amount: totalAmount,
  };
}

// --- Period-on-period comparison (Executive Summary) -------------------------

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days in a calendar month. Leap years included (Date does the work). */
function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Is this key the first day of its month? */
function isMonthStart(key: string): boolean {
  const m = DATE_KEY.exec(key);
  return m !== null && m[3] === "01";
}

/** Is this key the last day of its month? */
function isMonthEnd(key: string): boolean {
  const m = DATE_KEY.exec(key);
  if (!m) {return false;}
  return Number(m[3]) === daysInMonth(Number(m[1]), Number(m[2]));
}

/** Whole months between two month-aligned keys, inclusive. */
function monthSpan(fromKey: string, toKey: string): number {
  const a = DATE_KEY.exec(fromKey), b = DATE_KEY.exec(toKey);
  if (!a || !b) {return 0;}
  return (Number(b[1]) - Number(a[1])) * 12 + (Number(b[2]) - Number(a[2])) + 1;
}

/** Shift a month-aligned pair back by `months` whole calendar months. */
function shiftMonths(fromKey: string, months: number): { from: string; to: string } {
  const m = DATE_KEY.exec(fromKey);
  // Unreachable: previousWindow only calls this after isMonthStart matched the
  // same regex. Kept because an unchecked exec() is how a refactor turns a
  // date-shape change into a null dereference in a money report.
  if (!m) {return { from: fromKey, to: fromKey };}
  const y = Number(m[1]), mo = Number(m[2]);
  const zero = (y * 12 + (mo - 1)) - months;
  const startY = Math.floor(zero / 12), startM = (zero % 12) + 1;
  const endZero = zero + months - 1;
  const endY = Math.floor(endZero / 12), endM = (endZero % 12) + 1;
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return {
    from: `${String(startY)}-${p2(startM)}-01`,
    to: `${String(endY)}-${p2(endM)}-${p2(daysInMonth(endY, endM))}`,
  };
}

/** The same day-of-month range one calendar month earlier, clamped to fit. */
function sameDaysPreviousMonth(fromKey: string, toKey: string): { from: string; to: string; short: boolean } {
  const a = DATE_KEY.exec(fromKey);
  const b = DATE_KEY.exec(toKey);
  if (!a || !b) {return { from: fromKey, to: toKey, short: false };}
  const zero = (Number(a[1]) * 12 + (Number(a[2]) - 1)) - 1;
  const y = Math.floor(zero / 12);
  const mo = (zero % 12) + 1;
  const last = daysInMonth(y, mo);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  // CLAMPED, AND THE CLAMP IS REPORTED. 1–31 March has no counterpart in
  // February, so the comparison is 1–28 (or 29) and the periods are genuinely
  // unequal. Silently comparing 31 days of trade against 28 and printing a
  // growth percentage is a lie of roughly 10%; saying so is the whole point.
  const startDay = Math.min(Number(a[3]), last);
  const endDay = Math.min(Number(b[3]), last);
  return {
    from: `${String(y)}-${p2(mo)}-${p2(startDay)}`,
    to: `${String(y)}-${p2(mo)}-${p2(endDay)}`,
    short: endDay < Number(b[3]),
  };
}

/** Do both keys fall inside the same calendar month? */
function inSameMonth(fromKey: string, toKey: string): boolean {
  const a = DATE_KEY.exec(fromKey);
  const b = DATE_KEY.exec(toKey);
  return a !== null && b !== null && a[1] === b[1] && a[2] === b[2];
}

/**
 * THE COMPARISON WINDOW, in tenant calendar days.
 *
 * "A 1-month window is not 30 days" — so this is calendar arithmetic on day keys,
 * never milliseconds, and it has three branches:
 *
 *   MONTH-ALIGNED. `from` is the 1st of a month and `to` is the last day of a
 *   month: the window is N whole months, and the comparison an owner means is
 *   the N whole months BEFORE it. August (31 days) compares against July (31);
 *   March compares against February (28 or 29); Q1 compares against Q4 of the
 *   previous year; a 1 Apr – 31 Mar financial year compares against the previous
 *   financial year. Subtracting a day count would compare August against
 *   "2–31 July", which is not a period any owner has ever asked about.
 *
 *   WITHIN ONE MONTH — THE MATCHING DATE RANGE. This is the branch V3 asked for
 *   and it is worth spelling out, because the old behaviour was not a rounding
 *   difference; it compared against a period nobody meant.
 *
 *       On the 9th of September, the dashboard's window is 1–9 September.
 *       The rolling rule made the comparison "the equally-long window ending
 *       the day before", i.e. 23–31 AUGUST.
 *
 *   23–31 August is the END of a month: the weekend distribution is different,
 *   salaries have been paid, and for a restaurant it is a systematically
 *   different nine days from the START of one. An owner comparing "this month so
 *   far" is asking about 1–9 August, and was being shown something else entirely
 *   under a label that said month-to-date. So any window lying inside a single
 *   calendar month now compares against the SAME DATES of the previous month —
 *   which subsumes the 1st-to-today case and also does the right thing for an
 *   arbitrary drag like 3–17 August (→ 3–17 July).
 *
 *   EVERYTHING ELSE. A drag that straddles months without being month-aligned
 *   (say 20 July – 5 September) has no "matching dates" to speak of, so it keeps
 *   the equally-long window ending the day before it starts.
 *
 * Every branch returns INCLUSIVE day keys in the same zone as the input, because
 * a day key already names a day and needs no zone to shift backwards. `short` is
 * true only when the previous month could not supply the same last date, so a
 * caller can say so rather than printing an unequal comparison as if it were one.
 */
export function previousWindow(from: string, to: string): {
  from: string;
  to: string;
  basis: "months" | "same_dates_prev_month" | "days";
  /** The previous month was shorter, so the comparison covers fewer days. */
  short?: boolean;
} {
  if (!DATE_KEY.test(from) || !DATE_KEY.test(to) || from > to) {
    return { from, to, basis: "days" };
  }
  if (isMonthStart(from) && isMonthEnd(to)) {
    const months = monthSpan(from, to);
    if (months >= 1) {return { ...shiftMonths(from, months), basis: "months" };}
  }
  if (inSameMonth(from, to)) {
    const prev = sameDaysPreviousMonth(from, to);
    return { from: prev.from, to: prev.to, basis: "same_dates_prev_month", short: prev.short };
  }
  const span = countDays(from, to);
  const prevTo = addDaysToKey(from, -1);
  return { from: addDaysToKey(prevTo, -(span - 1)), to: prevTo, basis: "days" };
}

/**
 * Period-on-period growth, as a percentage.
 *
 * `null` when the previous period is zero. There is no honest growth percentage
 * from a base of nothing: "infinite" is not a number an owner can act on and
 * "100%" is a lie. The Executive Summary renders the dash and shows both
 * absolute figures next to it, which is the information that was actually wanted.
 */
export function growthPct(current: number, previous: number): number | null {
  const prev = Number.isFinite(previous) ? previous : 0;
  if (prev === 0) {return null;}
  const cur = Number.isFinite(current) ? current : 0;
  return round2(((cur - prev) / Math.abs(prev)) * 100);
}

// --- Bill Edit classification ------------------------------------------------

/**
 * WHY A CLASSIFIER RATHER THAN A LIST OF ACTION IDS.
 *
 * The Bill Edit report answers "what was changed on a bill after it was
 * generated, by whom". Its only source is "Audit_logs", and that trail was not
 * designed as a report: ONE action id — 4ad474d4… ("Add Orders") — covers
 * removing an item from a running bill, moving an item between tables, applying
 * a discount, applying a coupon, merging two tables, editing an item note AND
 * simply printing a KOT. Filtering by action id alone would put every print in a
 * fraud-control document; filtering it out entirely would drop the discounts.
 *
 * So an entry is classified from (action_id, reason, additional_details) — all
 * three written by the call sites in routes/bills.ts, routes/orders.ts and
 * routes/discounts.ts — and only entries that classify are reported. Unmatched
 * entries are DROPPED, not reported as "other": an unlabelled row in a control
 * document is noise that trains the reader to skim.
 *
 * WHAT IS NOT HERE, AND WHY. `additional_details` is free-form per call site and
 * NONE of the bill-edit writers record a before/after AMOUNT. There is therefore
 * no "value before", no "value after" and no computed difference anywhere in
 * this report — an invented delta in a fraud document is worse than a blank
 * column. What the writers DO record (the table, the item name, the discount
 * type and value, the coupon code, the bill id) is surfaced verbatim.
 */
export type BillEditKind =
  | "item_added" | "item_removed" | "item_moved" | "item_note"
  // A whole ticket moved to another table (POST /tables/move-order). It changes
  // two bills at once — one loses the ticket's value, the other gains it — and
  // it used to be dropped from this report because its sentence named no dish.
  | "order_moved"
  | "discount_applied" | "discount_requested" | "discount_decision" | "coupon_applied"
  | "tables_merged" | "bill_reopened" | "bill_refunded" | "bill_replaced"
  | "bill_status_changed" | "order_cancelled" | "order_deleted"
  | "loyalty_redeemed"
  // Migrations 034/035/036. A reversal is its OWN kind rather than a flag on the
  // original, because "12 comps" and "12 comps, 2 of which a manager overturned"
  // are different facts and the second is the interesting one.
  | "item_non_chargeable" | "item_non_chargeable_reversed"
  // A whole bill settled as NC (migration 052), and that settle undone by a
  // re-open. Its own kind: "one dish comped" and "the whole table given away"
  // are different acts, and a control reader looks for the second.
  | "bill_non_chargeable" | "bill_non_chargeable_reversed"
  | "order_voided"
  | "service_charge_waived" | "service_charge_waiver_reversed";

export interface BillEditClassification {
  kind: BillEditKind;
  /** Short human label for the column, stable across locales of the raw reason. */
  label: string;
  /** "Bills".id when the writer recorded one. */
  bill_id: string | null;
  /** "Orders".id when the writer recorded one. */
  order_id: string | null;
  /** Table name when the writer recorded one (most floor-side edits do). */
  table: string | null;
  /** Item name when the edit was about one line. */
  item: string | null;
}

const ACTION_ITEM_ADDED = "d6bebeb5-111f-4371-b373-a99158116d71";
const ACTION_ITEM_DELETED = "371ecf9f-303e-4114-92fb-3a5120d1565e";
const ACTION_BILL_REOPENED = "d5e3f7a9-2b4c-4d6e-9f80-3c5b7d9e1f2a";
const ACTION_BILL_REPLACED = "383cc261-7e5c-4745-b16f-06a41e2ae047";
const ACTION_DISCOUNT_DECISION = "c4d2e6f8-1a3b-4c5d-8e7f-2b4a6c8d0e1f";
const ACTION_BILL_STATUS = "07e364cc-f40d-46f3-b691-0f719dd38e0f";
const ACTION_ORDER_DELETE = "8c3f5b21-0e74-4a96-b2d8-6f1a9c4e7b53";
const ACTION_ADMIN_APPROVE = "fc57d407-4bba-442c-97a2-9e6f3c57f288";
// Redeeming loyalty points takes money off an open bill through the SAME flat
// discount path as a manual discount (RedeemLoyaltyPoints ->
// applyDiscountToOpenBill). A coupon application appears in this report; a
// points redemption is the same act by the same staff member, so leaving it out
// made the fraud-control view inconsistent about how a bill got smaller.
const ACTION_LOYALTY_REDEEM = "5b3f9d71-2c84-47e6-9a05-8e64d1f0b923";
// The three MIS-capture manager acts (routes/mis_capture.ts, migrations
// 034/035/036). Each has its OWN action id — it is the route's permission gate
// and its audit action id at once — so unlike everything on the catch-all above,
// these classify with no text matching at all and can never be confused with a
// print. They belong in this report because each one makes a generated bill
// smaller: a comp takes a dish off it, a void takes a whole ticket off it, a
// waiver takes the service charge off it.
const ACTION_NON_CHARGEABLE = "b4e7a1c9-2d58-4f36-9a07-5c81e3b0d472";
const ACTION_VOID_ORDER = "c1f83b26-5a97-4e40-b8d3-7e02a9c4f156";
const ACTION_SC_WAIVER = "d5a06e73-9c41-4b28-8f6a-1b74d3e08c95";

/** Every action id that can produce a bill edit — the SQL prefilter. */
export const BILL_EDIT_ACTION_IDS: readonly string[] = [
  "4ad474d4-5230-449c-874f-6a238b833bca", // Add Orders — the catch-all, see above
  ACTION_ITEM_ADDED,
  ACTION_ITEM_DELETED,
  ACTION_BILL_REOPENED,
  ACTION_BILL_REPLACED,
  ACTION_DISCOUNT_DECISION,
  ACTION_BILL_STATUS,
  ACTION_ORDER_DELETE,
  ACTION_ADMIN_APPROVE,
  ACTION_LOYALTY_REDEEM,
  ACTION_NON_CHARGEABLE,
  ACTION_VOID_ORDER,
  ACTION_SC_WAIVER,
];

const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > 0 ? s : null;
};

/** `details.item` is written as a bare name by some call sites and as the whole
 *  item object by others (routes/orders.ts's add-item path). Read both. */
const itemName = (v: unknown): string | null => {
  if (typeof v === "string") {return str(v);}
  if (v !== null && typeof v === "object" && "name" in v) {return str(v.name);}
  return null;
};

/**
 * THE STATUS ROUTE'S "THIS ORDER WAS CANCELLED" SENTENCE.
 *
 * PATCH /orders/:id/status writes `Order <id> -> Cancelled`, and since the cancel
 * reason was captured it appends one: `Order <id> -> Cancelled — reason: Other`.
 * The old test was a SUFFIX match (`-> Cancelled` at the end), so it missed every
 * cancel that carried a reason and dropped it from Bill Edit. It also matched the
 * undo registry's `Undid: Order <id> -> Cancelled`, which REVERSES a cancel, and
 * listed that as one. Anchored at the start, it takes both wordings of a cancel
 * and neither the undo nor any other sentence that merely names the order.
 * `cancel` without the rest also takes the route's accepted spelling "canceled".
 *
 * The SQL twin is VOID_KOT_CANCEL_AUDIT_SQL's `l.reason ilike 'Order % -> Cancel%'`
 * in database_supabase.ts, so Bill Edit and Void KOT read the same audit row the
 * same way. The void route's `Voided order <id> …` is not matched here: it has
 * its own action id, which classifies it as "order_voided" before any text is read.
 */
export function isOrderCancelSentence(reason: string | null | undefined): boolean {
  return /^order .* -> cancel/i.test((reason ?? "").trim());
}

/**
 * Classify one audit entry, or return null when it is not a bill edit.
 *
 * ORDER MATTERS: the dedicated action ids are matched first, then the shapes of
 * `additional_details`, then the reason text. Reason text is the LAST resort
 * precisely because it is the least stable input.
 */
export function classifyBillEdit(
  actionId: string,
  reason: string | null | undefined,
  details: Record<string, unknown> | null | undefined,
): BillEditClassification | null {
  const d = details ?? {};
  const r = reason ?? "";
  const base = {
    bill_id: str(d.bill_id),
    order_id: str(d.order_id),
    table: str(d.table) ?? str(d.to) ?? str(d.from) ?? str(d.table_name),
    item: itemName(d.item) ?? str(d.deleted_item_id),
  };
  const hit = (kind: BillEditKind, label: string): BillEditClassification => ({ kind, label, ...base });

  // 1. Dedicated action ids — unambiguous, no text matching needed.
  switch (actionId) {
    case ACTION_ITEM_ADDED: return hit("item_added", "Item added");
    case ACTION_ITEM_DELETED: return hit("item_removed", "Item deleted");
    case ACTION_BILL_REOPENED: return hit("bill_reopened", "Bill re-opened");
    case ACTION_BILL_REPLACED: return hit("bill_replaced", "Bill replaced");
    case ACTION_DISCOUNT_DECISION: return hit("discount_decision", "Discount decision");
    case ACTION_BILL_STATUS: return hit("bill_status_changed", "Bill status changed");
    case ACTION_ORDER_DELETE: return hit("order_deleted", "Order deleted");
    // The audit detail also carries the customer's phone; `base` deliberately
    // does not read it, so a control report never becomes a PII export.
    case ACTION_LOYALTY_REDEEM: return hit("loyalty_redeemed", "Loyalty points redeemed");
    // 034/035/036. The mark and its reversal share one action id (it is one
    // permission), so they are told apart by `details.reversal` — the writer's
    // own flag, not a reading of its prose. Detail shape over reason text is the
    // rule this classifier already follows everywhere below.
    case ACTION_NON_CHARGEABLE:
      // `scope: 'bill'` is the NC settle's own flag (routes/nc_settle.ts), read
      // before `reversal` for the same reason reversal is read at all: the
      // writer says what it did, and the prose is never consulted.
      if (d.scope === "bill") {
        return d.reversal === true
          ? hit("bill_non_chargeable_reversed", "Bill NC undone (re-opened)")
          : hit("bill_non_chargeable", "Bill settled as non-chargeable");
      }
      return d.reversal === true
        ? hit("item_non_chargeable_reversed", "Non-chargeable reversed")
        : hit("item_non_chargeable", "Item made non-chargeable");
    // Distinct from "order_cancelled" (a bare status flip through PATCH
    // /orders/:id/status, which records no reason and no authoriser). Collapsing
    // the two would hide exactly the difference a control reader is looking for.
    case ACTION_VOID_ORDER: return hit("order_voided", "Order voided (reason recorded)");
    case ACTION_SC_WAIVER:
      return d.reversal === true
        ? hit("service_charge_waiver_reversed", "Service charge waiver reversed")
        : hit("service_charge_waived", "Service charge waived");
    default: break;
  }

  // 2. fc57d407 covers BOTH "admin approved payment" (routine settlement, not an
  //    edit) and "Refunded bill" (very much one). The reason separates them.
  if (actionId === ACTION_ADMIN_APPROVE) {
    return /^refunded bill/i.test(r) ? hit("bill_refunded", "Bill refunded") : null;
  }

  // 3. The catch-all id. Detail SHAPE first — a discount records type+value, a
  //    coupon records a code — then the reason for the ones that record neither.
  if (d.request_id !== undefined && d.type !== undefined) {return hit("discount_requested", "Discount requested");}
  if (d.type !== undefined && d.value !== undefined && /discount/i.test(r)) {
    return hit("discount_applied", "Discount applied");
  }
  if (str(d.code) && /^applied coupon/i.test(r)) {return hit("coupon_applied", "Coupon applied");}
  if (/^removed item /i.test(r)) {return hit("item_removed", "Item removed");}
  if (/^moved item /i.test(r)) {return hit("item_moved", "Item moved");}
  // "Moved KOT-65 (…) from 12 to 15 …" / "Moved order (…) from …", and the
  // pre-2.0.2 "Moved order <uuid> from 12 to 15 …". Not "Moved the party …",
  // which is a seating move filed under the occupancy action, not a bill edit.
  if (/^moved (kot|order)\b/i.test(r)) {return hit("order_moved", "Order moved to another table");}
  if (/^merged table /i.test(r)) {return hit("tables_merged", "Tables merged");}
  if (/note on /i.test(r)) {return hit("item_note", "Item note changed");}
  if (isOrderCancelSentence(r)) {return hit("order_cancelled", "Order cancelled");}

  // Printing a KOT or a bill, creating an order, firing a course: real events,
  // but not edits to a generated bill. Deliberately dropped.
  return null;
}

// --- Small shared helpers ----------------------------------------------------

/** A safe percentage share, `null` rather than NaN/Infinity when the base is 0. */
export function sharePct(part: number, whole: number): number | null {
  const w = Number.isFinite(whole) ? whole : 0;
  if (w === 0) {return null;}
  const p = Number.isFinite(part) ? part : 0;
  return round2((p / w) * 100);
}

/**
 * Bucket an order's `order_type` into the three service channels the reports cut
 * by. AddOrder defaults the field to "dine_in" and the aggregator/QR paths write
 * "takeaway"/"delivery"; anything else (older rows, a channel added later) lands
 * in "other" rather than being silently counted as dine-in.
 */
export function orderChannel(raw: unknown): "dine_in" | "takeaway" | "delivery" | "other" {
  const v = (typeof raw === "string" ? raw : "").trim().toLowerCase();
  if (v === "" || v === "dine_in" || v === "dinein" || v === "dine-in") {return "dine_in";}
  if (v === "takeaway" || v === "take_away" || v === "pickup") {return "takeaway";}
  if (v === "delivery") {return "delivery";}
  return "other";
}

// ============================================================================
// THE SIX CAPTURE REPORTS — migrations 034-039
// ============================================================================
//
// These six describe things the money ladder above deliberately does NOT rung:
// a dish given away, a service charge taken off, a tip, a till, a menu group, a
// variation. What they share with the nine is this module — the same rounding,
// the same sharePct, the same refusal to invent a number — and what they add is
// below. Every rule here is decided by value, so jest proves it without a pool.
//
// THE ONE RULE THAT SPANS ALL SIX. A reversal is not a deletion. 034, 036 and
// 037 all supersede rather than delete, so every row a control report shows can
// be live or reversed, and the money of a reversed act is ZERO — it was put
// back. Reporting the original amount on a reversed row and then excluding it
// from the totals is how a column stops adding up to its own total, which is the
// first thing an auditor checks. So: `liveMoney` below, used on every money cell
// of every reversible row, and the reversed amount carried in its OWN column.

/**
 * The money a reversible row contributes, and the money it does not.
 *
 * Returns the pair rather than a single number so the two columns are always
 * written from one decision: a row is either live (its value counts, reversed
 * reads 0) or reversed (its value reads 0, reversed carries it). There is no
 * third state and no row where both are non-zero.
 */
export function liveMoney(value: number, reversed: boolean): { live: number; reversed: number } {
  const v = round2(Number.isFinite(value) ? value : 0);
  return reversed ? { live: 0, reversed: v } : { live: v, reversed: 0 };
}

// --- Menu attribution buckets (Group Summary, report 10) ---------------------

/**
 * The bucket for a line that resolves to NO menu row at all.
 *
 * DISTINCT FROM `UNCLASSIFIED_GROUP` (mis_capture.ts), and the difference is the
 * whole point of having two words:
 *
 *   Unclassified — the dish IS on the menu and is in no group. A CONFIGURATION
 *                  gap: somebody has to open the group editor. It shrinks to
 *                  zero the moment the menu is classified.
 *   Unattributed — the line resolves to no menu row at all: a dish deleted or
 *                  renamed since, an off-menu charge, a line written by an old
 *                  client. A HISTORY gap. It never shrinks, because the past
 *                  cannot be reclassified.
 *
 * Folding them together would tell an owner who has just classified their whole
 * menu that a bucket they cannot empty is still their fault. Folding EITHER into
 * a real group would be worse: it would move money into a group nobody put it
 * in, which is the one thing a group report must never do.
 */
export const UNATTRIBUTED_GROUP = "Unattributed";

/** What attributeOrderLine's output means to a group report. */
export interface AttributionBucket {
  /** Stable grouping key. The group id when there is one; the bucket name else. */
  key: string;
  name: string;
  /** True for the two gap buckets, so a report can total them out separately. */
  gap: boolean;
}

/**
 * Decide which group row one attributed line belongs in.
 *
 * `source === "unresolved"` is the ONLY signal that separates the two gaps, and
 * it is the writer's own — attributeOrderLine sets it when nothing matched, not
 * when a match had no group. Reading the group name to tell them apart would
 * break the day somebody names a real group "Unclassified".
 */
export function attributionBucket(a: {
  group_id: string | null;
  group_name: string;
  source: string;
}): AttributionBucket {
  if (a.source === "unresolved") {
    return { key: `~${UNATTRIBUTED_GROUP}`, name: UNATTRIBUTED_GROUP, gap: true };
  }
  if (a.group_id) {
    return { key: a.group_id, name: a.group_name, gap: false };
  }
  return { key: `~${a.group_name}`, name: a.group_name, gap: true };
}

// --- Labels ------------------------------------------------------------------

/**
 * Turn a controlled-vocabulary value into a column a human reads.
 *
 * ONE function rather than five hand-written maps, because five maps drift: a
 * vocabulary gains a value in mis_capture.ts, four of the maps are updated and
 * the fifth silently renders a raw enum in a report an owner is signing.
 * "guest_complaint" -> "Guest complaint". Unknown input is returned trimmed
 * rather than replaced, so a value this build has never heard of still reads as
 * itself instead of as "Other".
 */
export function humaniseVocabulary(raw: unknown): string {
  const s = (typeof raw === "string" ? raw : "").trim().replace(/[_-]+/g, " ").trim();
  if (!s) {return "";}
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** How a bill's service charge was configured, in words. See migration 036. */
export function serviceChargeBasisLabel(basis: unknown): string {
  const b = String(basis ?? "").trim();
  if (b === "tax_line") {return "Tax line";}
  if (b === "restaurant_percent") {return "Restaurant %";}
  return b || "None";
}

/**
 * A settled bill's payment mix as ONE cell.
 *
 * The Counter Summary cuts by payment mode inside a row that is already a
 * counter, and the mode set is free text (normalizePaymentMethod's nine, plus
 * the Unallocated bucket). A fixed column per mode would either miss one or
 * carry seven empty columns on every single-till tenant, and a spreadsheet
 * cannot hold an array — so the split rides one text column, and the machine-
 * readable array rides the JSON beside it for the screen.
 *
 * Sorted by amount DESCENDING, then by name, so the same mix always renders as
 * the same string: a cell that reorders itself between two exports of the same
 * window reads as data changing when nothing changed.
 */
export function formatMethodSplit(parts: readonly SettlementPart[]): string {
  return [...parts]
    .filter((p) => p.amount !== 0)
    .sort((a, z) => z.amount - a.amount || a.method.localeCompare(z.method))
    .map((p) => `${p.method} ${round2(p.amount).toFixed(2)}`)
    .join(" | ");
}

// --- Void KOT: the lines a cancelled ticket is reported WITH -----------------

/**
 * WHERE A DISH GOES WHEN IT IS TAKEN OFF A BILL BY NAME.
 *
 * POST /bills/remove-item and POST /bills/move-item both run
 * removeItemFromTableOrders, which filters the matching lines out of
 * "Orders".food.items and, when nothing is left on an order, cancels it
 * (status 5). The lines used to vanish with the filter. The Void KOT row for that
 * ticket then read Lines 0, Qty 0, Value 0 and named no dish: a void the report
 * counted but could not describe, holding money the report could not see. A
 * ticket emptied by a MOVE was listed the same way, although its food was served
 * at the other table.
 *
 * So the writer records two facts on the order, in the SAME update that filters
 * the lines and flips the status:
 *   * REMOVED_LINES_KEY holds every line a REMOVAL took off, exactly as it stood,
 *     plus the moment. A move records none there, because a moved dish is still
 *     on a bill, at the destination table.
 *   * MOVED_LINES_KEY (client item 4) holds every line a MOVE took off, with
 *     where it went — a list no void reader ever reads.
 *   * EMPTIED_BY_KEY names which of the two emptied the order.
 *
 * WHY ON THE ORDER AND NOT AS "OrderVoids" ROWS. The void ledger is the other
 * obvious home. It was not chosen, for three reasons:
 *   1. The ledger insert would be a second statement inside the removal's
 *      transaction. It would need a savepoint, or a missing table or a
 *      constraint would roll the removal back. The JSON rides in the one update
 *      that already has to succeed, so it cannot fail independently.
 *   2. The ledger allows one row per (order, item_id). Lines written by old
 *      clients have no id, so removing the same dish twice would keep only the
 *      first row and understate the money.
 *   3. The report's totals come from one aggregate over the same statement as
 *      its rows. A line list on the order feeds that aggregate and the row mapper
 *      the same input, so the rows add up to the total by construction.
 *      Ledger money would need a second degrading read that has to agree with
 *      the first.
 * Nothing is back-filled: an order emptied before this shipped has neither key,
 * and it still reports as it did (no lines, no value), because an audit
 * sentence keyed by table and time cannot say which ORDER a dish came off.
 */
export const REMOVED_LINES_KEY = "removed_items";
export const EMPTIED_BY_KEY = "emptied_by";

/**
 * CLIENT ITEM 4 — THE DISHES A MOVE TOOK OFF, AND WHERE EACH WENT.
 *
 * A move used to record nothing on the source, so the ticket it emptied read
 * "Cancelled · 0 item(s)" on every screen and nobody could say what had left
 * it. MOVED_LINES_KEY holds each moved line as it stood, plus the moment and
 * the destination table and order. It is a DIFFERENT key from
 * REMOVED_LINES_KEY on purpose: VOID_KOT_LINES_JSON and voidKotLines read
 * only the removal list, so a moved dish is still never counted as a void —
 * its money is on the destination's bill, and counting it here as well would
 * list it twice.
 */
export const MOVED_LINES_KEY = "moved_items";

/** Which bill-item writer took the lines off. */
export type LineRemovalMode = "remove" | "move";

/**
 * The order's food after lines were taken off it: the evidence above, stamped.
 *
 * `food` is the blob with the matching lines ALREADY filtered out; `removed` are
 * those lines as they stood. Pure, and it never drops a key the blob already
 * carries, so an earlier removal's lines survive a later one.
 */
export function stampLineRemoval(
  food: Readonly<Record<string, unknown>>,
  removed: readonly unknown[],
  mode: LineRemovalMode,
  emptied: boolean,
  at: string,
  /** A move only: where the lines went. Absent = nothing recorded, as before. */
  movedTo?: { to_table: string; to_order_id: string | null } | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...food };
  if (mode === "remove" && removed.length > 0) {
    const prior = food[REMOVED_LINES_KEY];
    out[REMOVED_LINES_KEY] = [
      ...(Array.isArray(prior) ? prior : []),
      ...removed.map((line) => (line !== null && typeof line === "object" ? { ...line, removed_at: at } : line)),
    ];
  }
  if (mode === "move" && removed.length > 0 && movedTo) {
    const prior = food[MOVED_LINES_KEY];
    out[MOVED_LINES_KEY] = [
      ...(Array.isArray(prior) ? prior : []),
      ...removed.map((line) => (line !== null && typeof line === "object"
        ? { ...line, moved_at: at, to_table: movedTo.to_table, to_order_id: movedTo.to_order_id }
        : line)),
    ];
  }
  if (emptied) {out[EMPTIED_BY_KEY] = mode;}
  return out;
}

/**
 * The lines the Void KOT report reads off a CANCELLED order.
 *
 * The lines still on the ticket when it has any (a cancel through the status
 * route or the void route leaves them in place). Otherwise, the lines Remove
 * item took off it. The SQL twin is VOID_KOT_LINES_JSON in database_supabase.ts,
 * which the totals aggregate expands. The two have to choose the same list, or
 * the rows stop adding up to the total.
 */
export function voidKotLines(food: Readonly<Record<string, unknown>>): unknown[] {
  const items = Array.isArray(food.items) ? (food.items as unknown[]) : [];
  if (items.length > 0) {return items;}
  const removed = food[REMOVED_LINES_KEY];
  return Array.isArray(removed) ? (removed as unknown[]) : [];
}

/** One cancelled line as the Void KOT row carries it. */
export interface VoidKotLine {
  name: string;
  variation: string | null;
  quantity: number;
  price: number;
}

/** The dish and, when there is one, the size, as a stored line spells them. */
export function voidLineIdentity(raw: unknown): { name: string; variation: string | null } {
  const it = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = (typeof it.name === "string" ? it.name.trim() : "") || "Item";
  const variation = typeof it.variation_name === "string" ? it.variation_name.trim() : "";
  return { name, variation: variation || null };
}

/**
 * A voided ticket's dishes as ONE spreadsheet cell: `Biryani (Half) x2; Raita x1`.
 *
 * WHY A TEXT CELL. The row already carries `items` as an array, and every export
 * on both clients is column-driven. A spreadsheet cannot hold an array, so the
 * dish names never reached any file: the Excel showed a 36-character order id
 * and a line count. Same answer as formatMethodSplit, for the same reason.
 *
 * `Name (Variation)` is the label the docket and the bill print (escpos.ts
 * itemLabel), so the sheet names a dish the way the paper did. ` x` is ASCII
 * because the app's PDF font has no multiplication sign. `; ` separates lines
 * because a comma inside a dish name is ordinary. Every line stays its own entry,
 * so the cell and the Lines column count the same thing. No lines is null (a
 * blank cell), never an empty string pretending to be a list.
 */
export function voidItemsText(lines: readonly Pick<VoidKotLine, "name" | "variation" | "quantity">[]): string | null {
  if (lines.length === 0) {return null;}
  return lines
    .map((l) => `${orderLineLabel(l)} x${String(l.quantity)}`)
    .join("; ");
}

/**
 * `Biryani (Half)`: the dish as the docket and the bill print it (escpos.ts
 * itemLabel). ONE label for the Void KOT cell and the KOT drill-down, so a row
 * reading "Biryani (Half) x1; Biryani (Full) x1" never opens a ticket with two
 * lines both called "Biryani".
 */
export function orderLineLabel(line: Pick<VoidKotLine, "name" | "variation">): string {
  return line.variation ? `${line.name} (${line.variation})` : line.name;
}

/**
 * THE LINES AN ITEMS-SPLIT WRITE TOOK OFF AN ORDER, as they stood.
 *
 * UpdateOrderItemsSplit replaces an order's whole line list. DELETE
 * /orders/:id/items/:itemId uses it to strip a line, and stripping the last one
 * leaves the order ACTIVE with no lines. Releasing the table later cancels it
 * (status 5), and its Void KOT row then had nothing to name and no value, the
 * same blank row Remove item used to leave. So that write stamps what it took off
 * with stampLineRemoval, exactly as removeItemFromTableOrders does, and every
 * strip path records its lines on the order. The delete route also writes an
 * "OrderVoids" scope='item' row, but after the fact, best-effort and only where
 * migration 035 is applied. The report still reads ONE list off the order, for
 * the reasons stampLineRemoval's header gives, so its rows keep adding up to its
 * totals.
 *
 * A line is identified by its `id` when it has one, which is every line the
 * delete route can address. A line written by an old client without an id is
 * identified by dish, size and price, so a line whose QUANTITY was edited is the
 * same line, not a removal plus an addition. Matching is one-for-one, so two
 * identical id-less lines of which one survived give one removal, not two.
 * A line moved between Served and Preparing is still on the order and is never a
 * removal. A quantity reduced on a line that stays is not recorded: the line is
 * still on the ticket, and the report reads a cancelled ticket's lines as they
 * stood when it was cancelled.
 */
export function linesTakenOff(before: readonly unknown[], after: readonly unknown[]): unknown[] {
  const keyOf = (raw: unknown): string => {
    const it = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const id = typeof it.id === "string" ? it.id.trim() : typeof it.id === "number" ? String(it.id) : "";
    if (id) {return `id:${id}`;}
    const { name, variation } = voidLineIdentity(it);
    return `line:${name}|${variation ?? ""}|${String(Number(it.price) || 0)}`;
  };
  const remaining = new Map<string, number>();
  for (const line of after) {
    const k = keyOf(line);
    remaining.set(k, (remaining.get(k) ?? 0) + 1);
  }
  const taken: unknown[] = [];
  for (const line of before) {
    const k = keyOf(line);
    const left = remaining.get(k) ?? 0;
    if (left > 0) {remaining.set(k, left - 1);} else {taken.push(line);}
  }
  return taken;
}
