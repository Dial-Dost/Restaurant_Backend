// THE MONEY INVARIANTS OF THE SIX DATA-CAPTURE MIGRATIONS (034-039).
//
// Two of the six change what a guest is charged, and this file is the proof that
// they change it by exactly the right amount and no other:
//
//   NON-CHARGEABLE (034)  a comped line must come OUT of what the guest pays
//                         while still being counted as revenue given away. Get
//                         it wrong in one direction and free food is billed; in
//                         the other, real revenue vanishes with no record.
//   TENDERS (037)         N payments must reconstruct the grand total EXACTLY.
//                         The three-way split of an odd amount is the case where
//                         naive float arithmetic drifts, and it is tested first.
//   SERVICE CHARGE WAIVER (036) must work in BOTH shapes a service charge occurs
//                         in — and they behave differently, which is the whole
//                         reason the quote carries three numbers instead of one.
//
// Pure arithmetic, no database, no fixture — the same discipline as
// money_invariants.test.ts beside it.

import { describe, test, expect } from "@jest/globals";
import {
  round2,
  computeBillCharges,
  chargeableSubtotal,
  nonChargeableValue,
  tenderAmountsTowardBill,
  isNonChargeableLine,
  quoteServiceChargeWaiver,
  taxConfigWithoutServiceCharge,
  reconcileTenders,
  allocateTenderAmounts,
  toPaisa,
} from "../../billing_math";

// The shipped seed (migrations/000_base_schema.sql:266) puts the service charge
// INSIDE Outlets.default_tax — shape (b). A tenant on Restaurant.service_charge
// is shape (a) and has no such line.
const TAX_WITH_SC = { SGST: 2.5, CGST: 2.5, "Service Charge": 10 };
const TAX_ONLY = { SGST: 2.5, CGST: 2.5 };

// One order's lines, exactly as they sit inside "Orders".food.items.
const line = (name: string, price: number, quantity: number, nc = false) =>
  ({ name, price, quantity, ...(nc ? { nc: true } : {}) });

// ============================================================================
// 034 — NON-CHARGEABLE
// ============================================================================

describe("034 non-chargeable: the comped line comes out of the bill, exactly", () => {
  // Three desserts ordered; one of them is on the house.
  const withComp = [
    line("Paneer Tikka", 390, 2),
    line("Gulab Jamun", 180, 2),
    line("Gulab Jamun", 180, 1, true),
  ];
  // The same table with the comped line simply not ordered.
  const withoutIt = [
    line("Paneer Tikka", 390, 2),
    line("Gulab Jamun", 180, 2),
  ];

  test("THE HEADLINE: a bill with one NC item equals the bill without it", () => {
    expect(chargeableSubtotal(withComp)).toBe(chargeableSubtotal(withoutIt));
    expect(chargeableSubtotal(withComp)).toBe(round2(390 * 2 + 180 * 2));
  });

  test("...and that equality survives the whole charge ladder, in both tax shapes", () => {
    for (const cfg of [TAX_WITH_SC, TAX_ONLY]) {
      for (const scPct of [0, 10]) {
        const a = computeBillCharges(chargeableSubtotal(withComp), cfg, scPct, true, null);
        const b = computeBillCharges(chargeableSubtotal(withoutIt), cfg, scPct, true, null);
        expect(a.grand_total).toBe(b.grand_total);
        expect(a.service_charge).toBe(b.service_charge);
        expect(a.tax_total).toBe(b.tax_total);
      }
    }
  });

  test("the NC value is separately recoverable, and nothing is lost or invented", () => {
    expect(nonChargeableValue(withComp)).toBe(180);
    // The conservation law: charged + given away === the full menu value of
    // everything that left the kitchen.
    const fullValue = chargeableSubtotal(withComp.map((l) => ({ ...l, nc: undefined })));
    expect(round2(chargeableSubtotal(withComp) + nonChargeableValue(withComp))).toBe(fullValue);
  });

  test("a comped line is not charged even when it is the ONLY line", () => {
    const only = [line("Tasting Menu", 2500, 1, true)];
    expect(chargeableSubtotal(only)).toBe(0);
    expect(nonChargeableValue(only)).toBe(2500);
    expect(computeBillCharges(chargeableSubtotal(only), TAX_WITH_SC, 10, true, null).grand_total).toBe(0);
  });

  test("a partial comp splits the line and both halves stay exact", () => {
    // Three of a dish at 333.33; one comped. The split the write path makes.
    const split = [line("Biryani", 333.33, 2), line("Biryani", 333.33, 1, true)];
    expect(chargeableSubtotal(split)).toBe(666.66);
    expect(nonChargeableValue(split)).toBe(333.33);
    expect(round2(chargeableSubtotal(split) + nonChargeableValue(split))).toBe(round2(333.33 * 3));
  });

  test("the flag is strictly `true` — no truthiness, so a stray value cannot free a dish", () => {
    for (const bogus of ["false", "true", 1, 0, "", null, undefined, {}]) {
      expect(isNonChargeableLine({ price: 100, quantity: 1, nc: bogus })).toBe(false);
    }
    expect(isNonChargeableLine({ price: 100, quantity: 1, nc: true })).toBe(true);
  });

  test("no NC lines: chargeableSubtotal is byte-identical to the reduction it replaced", () => {
    // The reduction AddOrder inlined before migration 034. If these ever diverge,
    // adopting chargeableSubtotal silently repriced every existing order.
    const legacy = (items: { price: number; quantity: number }[]) =>
      round2(items.reduce((acc, it) => acc + Number(it.price) * Math.max(1, Number(it.quantity) || 1), 0));
    const cases = [
      [line("A", 0, 1)],
      [line("A", 99.99, 3), line("B", 0.01, 7)],
      [line("A", 333.33, 3)],
      [{ name: "weighed", price: 120, quantity: 2.5 }],
      [{ name: "no qty", price: 250, quantity: 0 }],
    ];
    for (const c of cases) {
      expect(chargeableSubtotal(c)).toBe(legacy(c as { price: number; quantity: number }[]));
    }
  });
});

// ============================================================================
// 036 — SERVICE CHARGE WAIVER, IN BOTH TAX SHAPES
// ============================================================================

describe("036 service-charge waiver: shape (b), the charge is a tax line", () => {
  const SUBTOTAL = 2400;

  test("the charge is removed and NOTHING else moves", () => {
    const q = quoteServiceChargeWaiver(SUBTOTAL, TAX_WITH_SC, 0, null);
    expect(q.basis).toBe("tax_line");
    // 10% of the discounted subtotal.
    expect(q.amount_waived).toBe(240);
    // Structurally zero: nothing is charged on top of a tax line.
    expect(q.tax_on_waived).toBe(0);
    expect(q.grand_total_reduction).toBe(240);
    expect(q.basis_amount).toBe(SUBTOTAL);
    expect(q.basis_percent).toBe(10);
  });

  test("the waived config reproduces the waived total exactly — no residual", () => {
    const q = quoteServiceChargeWaiver(SUBTOTAL, TAX_WITH_SC, 0, null);
    const billed = computeBillCharges(SUBTOTAL, q.tax_config_waived, q.service_charge_percent_waived, false, null);
    expect(billed.grand_total).toBe(q.grand_total_without);
    expect(round2(q.grand_total_with - q.grand_total_reduction)).toBe(q.grand_total_without);
    // GST is untouched by the waiver: 5% of 2400.
    expect(billed.tax_total).toBe(120);
    expect(billed.service_charge).toBe(0);
  });

  test("the filtered config keeps every genuine tax and drops only the charge", () => {
    const { taxes, service_line } = taxConfigWithoutServiceCharge(TAX_WITH_SC);
    expect(service_line?.name).toBe("Service Charge");
    expect(taxes.map((t) => t.name).sort()).toEqual(["CGST", "SGST"]);
  });
});

describe("036 service-charge waiver: shape (a), Restaurant.service_charge", () => {
  const SUBTOTAL = 2400;
  const SC = 10;

  test("the charge AND the tax that sat on it fall away", () => {
    const q = quoteServiceChargeWaiver(SUBTOTAL, TAX_ONLY, SC, null);
    expect(q.basis).toBe("restaurant_percent");
    expect(q.amount_waived).toBe(240);
    // 5% GST was charged on (2400 + 240); waiving the charge removes 5% of 240.
    expect(q.tax_on_waived).toBe(12);
    expect(q.grand_total_reduction).toBe(252);
    expect(q.basis_percent).toBe(10);
  });

  test("the waived config reproduces the waived total exactly — no residual", () => {
    const q = quoteServiceChargeWaiver(SUBTOTAL, TAX_ONLY, SC, null);
    const billed = computeBillCharges(SUBTOTAL, q.tax_config_waived, q.service_charge_percent_waived, false, null);
    expect(billed.grand_total).toBe(q.grand_total_without);
    expect(round2(q.grand_total_with - q.grand_total_reduction)).toBe(q.grand_total_without);
    expect(billed.service_charge).toBe(0);
    expect(billed.tax_total).toBe(120);
  });

  test("THE SHAPES GENUINELY DIFFER — one number would have been wrong for half the fleet", () => {
    const b = quoteServiceChargeWaiver(SUBTOTAL, TAX_WITH_SC, 0, null);
    const a = quoteServiceChargeWaiver(SUBTOTAL, TAX_ONLY, SC, null);
    expect(a.amount_waived).toBe(b.amount_waived);          // same charge...
    expect(a.grand_total_reduction).not.toBe(b.grand_total_reduction); // ...different saving
    expect(a.tax_on_waived).toBeGreaterThan(b.tax_on_waived);
  });
});

describe("036 service-charge waiver: edges", () => {
  test("no charge configured = nothing to waive", () => {
    const q = quoteServiceChargeWaiver(1000, TAX_ONLY, 0, null);
    expect(q.basis).toBe("none");
    expect(q.amount_waived).toBe(0);
    expect(q.grand_total_reduction).toBe(0);
    expect(q.grand_total_with).toBe(q.grand_total_without);
  });

  test("a discount comes off FIRST — the charge is waived on the discounted base", () => {
    const q = quoteServiceChargeWaiver(2400, TAX_WITH_SC, 0, { type: "percent", value: 25 });
    expect(q.basis_amount).toBe(1800);
    expect(q.amount_waived).toBe(180);
    expect(q.grand_total_reduction).toBe(180);
  });

  test("a tenant configured with BOTH shapes has BOTH waived", () => {
    const q = quoteServiceChargeWaiver(2400, TAX_WITH_SC, 5, null);
    // Shape (a) charges 5% of 2400 = 120; the tax line then charges 10% of
    // (2400 + 120) = 252. Both are the service charge, and both come off.
    expect(q.amount_waived).toBe(round2(120 + 252));
    expect(q.basis).toBe("tax_line");
    const billed = computeBillCharges(2400, q.tax_config_waived, q.service_charge_percent_waived, false, null);
    expect(billed.grand_total).toBe(q.grand_total_without);
  });

  test.each([0, 1, 9.99, 333.33, 1234.56, 87654.32])(
    "the ladder still closes after a waiver — subtotal %p, both shapes",
    (subtotal) => {
      for (const [cfg, sc] of [[TAX_WITH_SC, 0], [TAX_ONLY, 10]] as const) {
        const q = quoteServiceChargeWaiver(subtotal, cfg, sc, null);
        const billed = computeBillCharges(subtotal, q.tax_config_waived, 0, false, null);
        expect(toPaisa(billed.discounted_subtotal) + toPaisa(billed.service_charge) + toPaisa(billed.tax_total) + toPaisa(billed.round_off))
          .toBe(toPaisa(billed.grand_total));
        expect(billed.grand_total).toBe(q.grand_total_without);
        expect(round2(q.amount_waived + q.tax_on_waived)).toBe(q.grand_total_reduction);
      }
    },
  );

  // Migration 048. Both grand totals are rupee-rounded, each with its own
  // round-off, so their DIFFERENCE is not what the waiver took off. 2400.40 on
  // the seed shape: 2760.46 -> 2760 with the charge, 2520.42 -> 2520 without —
  // a difference of 240.00 against a waived charge of 240.04, and a recorded
  // waiver whose saving is smaller than its own charge.
  test("the saving is the PRE-ROUND difference: the recorded arithmetic stays exact across the rounding", () => {
    const q = quoteServiceChargeWaiver(2400.4, TAX_WITH_SC, 0, null);
    expect(q.grand_total_with).toBe(2760);
    expect(q.grand_total_without).toBe(2520);
    expect(q.amount_waived).toBe(240.04);
    expect(q.tax_on_waived).toBe(0);
    expect(q.grand_total_reduction).toBe(240.04);
    // Shape (a) as well, where the tax that rode on the charge falls away too.
    const a = quoteServiceChargeWaiver(2400.4, TAX_ONLY, 10, null);
    expect(round2(a.amount_waived + a.tax_on_waived)).toBe(a.grand_total_reduction);
    expect(a.grand_total_reduction).toBeGreaterThanOrEqual(a.amount_waived);
  });

  test("across a sweep, saving === charge + its tax, never less than the charge, in both shapes", () => {
    for (let paisa = 100; paisa < 500000; paisa += 1237) {
      const subtotal = paisa / 100;
      for (const [cfg, sc] of [[TAX_WITH_SC, 0], [TAX_ONLY, 10]] as const) {
        const q = quoteServiceChargeWaiver(subtotal, cfg, sc, null);
        expect(toPaisa(q.amount_waived) + toPaisa(q.tax_on_waived)).toBe(toPaisa(q.grand_total_reduction));
        expect(toPaisa(q.grand_total_reduction)).toBeGreaterThanOrEqual(toPaisa(q.amount_waived));
      }
    }
  });
});

// ============================================================================
// 037 — TENDERS SUM EXACTLY
// ============================================================================

describe("037 tenders: a split must reconstruct the grand total to the paisa", () => {
  test("THE CASE THAT DRIFTS: a three-way split of an odd amount", () => {
    // ₹1230.30 three ways is 410.10 each — and 410.10 + 410.10 + 410.10 as
    // IEEE-754 doubles is 1230.3000000000002. A naive `sum === total` therefore
    // REJECTS a split that is exactly right, and the obvious "fix" (an epsilon)
    // would accept a split that is exactly ₹0.01 wrong. Summed in paisa it is
    // 123030, full stop.
    const parts = allocateTenderAmounts(1230.30, 3);
    expect(parts).toEqual([410.10, 410.10, 410.10]);
    expect(parts.reduce((s, p) => s + p, 0)).not.toBe(1230.30); // the float trap, named
    expect(parts.reduce((s, p) => s + toPaisa(p), 0)).toBe(123030);
    expect(reconcileTenders(1230.30, parts).exact).toBe(true);
    expect(reconcileTenders(1230.30, parts).outstanding).toBe(0);

    // And the uneven-remainder case, where the paisa cannot divide three ways:
    // the last tender absorbs it and the sum is still exactly the bill.
    const uneven = allocateTenderAmounts(100, 3);
    expect(uneven).toEqual([33.33, 33.33, 33.34]);
    expect(reconcileTenders(100, uneven).exact).toBe(true);

    // One paisa out in either direction is caught, which is the other half of
    // the guarantee — exact means exact, not "close enough".
    expect(reconcileTenders(1230.30, [410.10, 410.10, 410.09]).exact).toBe(false);
    expect(reconcileTenders(1230.30, [410.10, 410.10, 410.11]).exact).toBe(false);
  });

  test.each([
    [100, 3], [0.01, 1], [0.03, 3], [1, 7], [755.55, 2], [755.55, 3], [1234.57, 3],
    [2645.44, 4], [9999.99, 6], [10, 50], [87654.32, 9],
  ])("an even split of %p across %p tenders reconciles exactly", (total, n) => {
    const parts = allocateTenderAmounts(total, n);
    expect(parts).toHaveLength(n);
    for (const p of parts) {expect(p).toBeGreaterThanOrEqual(0);}
    // Summed in paisa, the parts ARE the total. This is the invariant, not an
    // approximation of it.
    expect(parts.reduce((s, p) => s + toPaisa(p), 0)).toBe(toPaisa(total));
    const rec = reconcileTenders(total, parts);
    expect(rec.exact).toBe(true);
    expect(rec.over).toBe(false);
    expect(rec.partial).toBe(false);
    expect(rec.tendered).toBe(round2(total));
  });

  test("a hand-built split of unequal amounts reconciles when it should", () => {
    expect(reconcileTenders(755.55, [500, 255.55]).exact).toBe(true);
    expect(reconcileTenders(755.55, [500, 200, 55.55]).exact).toBe(true);
  });

  test("a SHORT split is a partial settlement, not a rounding excuse", () => {
    const rec = reconcileTenders(755.55, [500, 255.54]);
    expect(rec.exact).toBe(false);
    expect(rec.partial).toBe(true);
    expect(rec.over).toBe(false);
    expect(rec.outstanding).toBe(0.01);
  });

  test("an OVER split is refused, and says by how much", () => {
    const rec = reconcileTenders(755.55, [500, 300]);
    expect(rec.over).toBe(true);
    expect(rec.exact).toBe(false);
    expect(rec.outstanding).toBe(-44.45);
  });

  test("no tenders at all is neither partial nor exact-by-accident on a non-zero bill", () => {
    const rec = reconcileTenders(755.55, []);
    expect(rec.tendered).toBe(0);
    expect(rec.partial).toBe(false);
    expect(rec.exact).toBe(false);
    expect(rec.outstanding).toBe(755.55);
  });

  test("VOIDING one tender of a pair leaves the bill under-tendered, not double-counted", () => {
    // The double-count 037 exists to stop: a card payment keyed twice.
    const keyedTwice = [755.55, 755.55];
    expect(reconcileTenders(755.55, keyedTwice).over).toBe(true);
    // Voiding one drops it out of the sum (the caller filters voided_at is null).
    const afterVoid = [755.55];
    expect(reconcileTenders(755.55, afterVoid).exact).toBe(true);
  });

  test("A TIP IS NOT PART OF THE SUM — a tipped bill is still exactly settled", () => {
    // 037: `amount` settles the bill, `tip_amount` rides on top. If a tip were
    // folded into the amount, every tipped bill would read as over-tendered.
    const tenders = [{ amount: 755.55, tip_amount: 50 }];
    expect(reconcileTenders(755.55, tenders.map((t) => t.amount)).exact).toBe(true);
    expect(reconcileTenders(755.55, tenders.map((t) => t.amount + t.tip_amount)).over).toBe(true);
  });

  test("a tender given to more precision than a paisa is rounded before comparing", () => {
    // 33.333333 cannot be paid. It is round2'd to 33.33 first, so the comparison
    // is between two things that could actually change hands.
    expect(toPaisa(33.333333)).toBe(3333);
    expect(reconcileTenders(100, [33.333333, 33.333333, 33.34]).exact).toBe(true);
  });
});

/**
 * COVERAGE HOLES CLOSED — each of these was found by mutation testing surviving
 * the whole suite (1004 jest + 105 integration assertions). The code was right;
 * nothing was watching it.
 */
describe("NC value counts quantity, not lines", () => {
  test("a comp of 3 gives away 3x the price, not 1x", () => {
    // Every pre-existing NC fixture used quantity 1, so deleting the
    // `* orderLineQuantity(line)` multiplier in nonChargeableValue passed the
    // entire suite. A whole-line comp of a qty-3 dish would then have reported
    // 200 instead of 600 — the guest is never overcharged, but the owner is told
    // they gave away a third of what they actually did, on the bill view, the
    // printed bill and the NC control report alike.
    const lines = [line("Probe Dish", 200, 3, true)];
    expect(nonChargeableValue(lines)).toBe(600);
    expect(chargeableSubtotal(lines)).toBe(0);
  });

  test("fractional quantity is respected (weighed items)", () => {
    expect(nonChargeableValue([line("Prawns 250g", 120, 2.5, true)])).toBe(300);
  });

  test("the conservation identity holds at quantity > 1", () => {
    // The invariant the module documents: nothing lost, nothing invented — the
    // money only moves from the charged column to the given-away column.
    const mixed = [line("Paid", 150, 2), line("Comped", 200, 3, true)];
    const asIfAllCharged = chargeableSubtotal([line("Paid", 150, 2), line("Comped", 200, 3)]);
    expect(chargeableSubtotal(mixed) + nonChargeableValue(mixed)).toBe(asIfAllCharged);
    expect(asIfAllCharged).toBe(900);
  });
});

describe("a tip is not payment for food", () => {
  test("only `amount` counts toward the bill; `tip_amount` never does", () => {
    // Folding tip_amount into the reconciliation input passed tsc and all 1004
    // tests, because the rule lived in an inline `.map(t => t.amount)` that no
    // test could reach. Every TIPPED bill would then read as over-tendered, and
    // assertTendersReconcileForSettle would REFUSE the settle — a guest at the
    // till with a payment that cannot be closed.
    const tenders = [
      { amount: 600, tip_amount: 50 },
      { amount: 430.30, tip_amount: 0 },
    ];
    expect(tenderAmountsTowardBill(tenders)).toEqual([600, 430.30]);

    const grand = 1030.30;
    const rec = reconcileTenders(grand, tenderAmountsTowardBill(tenders));
    expect(rec.exact).toBe(true);
    expect(rec.over).toBe(false);
    expect(rec.tendered).toBe(grand);

    // And the counter-proof: had the tip been folded in, this same fully-paid
    // bill would read over-tendered and be refused at settle.
    const contaminated = reconcileTenders(grand, tenders.map((t) => t.amount + t.tip_amount));
    expect(contaminated.over).toBe(true);
    expect(contaminated.exact).toBe(false);
  });

  test("a tip-only tender pays nothing toward the bill", () => {
    expect(tenderAmountsTowardBill([{ amount: 0, tip_amount: 100 }])).toEqual([0]);
  });
});
