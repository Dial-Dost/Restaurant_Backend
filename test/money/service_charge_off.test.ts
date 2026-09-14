// F2 — "BILLS PRINTED WITHOUT A SERVICE CHARGE SHOW THE SAME TOTAL AS BILLS WITH ONE."
//
// That sentence is a live client bug report against a running restaurant, and
// this file is it, turned into arithmetic. Every assertion below exists because
// a guest was charged for something the bill said was not charged.
//
// WHY IT WAS POSSIBLE AT ALL. A service charge occurs in TWO shapes (see
// quoteServiceChargeWaiver's header in billing_math.ts):
//
//   restaurant_percent  "Restaurant".service_charge — a percent applied UNDER
//                       the tax, so the GST rides on top of it.
//   tax_line            a "Service Charge" entry inside Outlets.default_tax —
//                       it IS one of the tax lines. This is the SHIPPED SEED
//                       (migrations/000_base_schema.sql:266), i.e. the default,
//                       i.e. the shape the reporting tenant is on.
//
// and "off" only ever meant the first of them. computeBillCharges'
// `includeServiceCharge=false` zeroes the restaurant_percent leg and nothing
// else; a tax-line charge sails straight through computeBillTaxes untouched. On
// that tenant the "without" bill equalled the "with" bill TO THE PAISA — which
// is the client's sentence, exactly.
//
// So the assertion that carries this whole file is deliberately the dumbest one
// in it: WITHOUT IS STRICTLY SMALLER THAN WITH, in every shape. It failed on the
// code that shipped, in two of the three shapes, and a regression would fail it
// again.
//
// Pure arithmetic — no database, no fixture — same discipline as
// money_invariants.test.ts and mis_capture_money.test.ts beside it.

import { describe, test, expect } from "@jest/globals";
import {
  round2,
  toPaisa,
  computeBillCharges,
  resolveServiceChargeConfig,
  quoteServiceChargeWaiver,
  type BillDiscount,
} from "../../billing_math";

// ============================================================================
// THE THREE SHAPES
// ============================================================================

/** The shipped seed's shape: the charge IS a tax line. */
const TAX_LINE_ONLY = { SGST: 2.5, CGST: 2.5, "Service Charge": 10 };
/** The other shape: a plain tax config, the charge on "Restaurant".service_charge. */
const TAX_ONLY = { SGST: 2.5, CGST: 2.5 };
/** No charge in either shape. This tenant must never notice this feature exists. */
const NO_CHARGE_TAX = { SGST: 2.5, CGST: 2.5 };

interface Shape {
  name: string;
  taxConfig: Record<string, number>;
  scPct: number;
  /** Does waiving it also drop GST? Only when the charge sits UNDER the tax. */
  taxRidesOnTheCharge: boolean;
}

// A tenant configured with BOTH is charging twice — billing_math.ts documents
// that and quoteServiceChargeWaiver waives both — so "off" has to remove both
// legs or the guest still pays one of them.
const SHAPES: Shape[] = [
  { name: "restaurant_percent", taxConfig: TAX_ONLY, scPct: 10, taxRidesOnTheCharge: true },
  { name: "tax_line", taxConfig: TAX_LINE_ONLY, scPct: 0, taxRidesOnTheCharge: false },
  { name: "both shapes at once", taxConfig: TAX_LINE_ONLY, scPct: 10, taxRidesOnTheCharge: true },
];

// Subtotals a real bill plausibly lands on, including ones that force a
// half-paisa into at least one tax line.
const SUBTOTALS = [1, 9.99, 100, 333.33, 500, 1000, 1234.56, 2400, 5499, 87654.32];

/**
 * THE CALL EVERY PRINTER MAKES, in one place.
 *
 * `off` is the "print this bill without the service charge" request — the
 * `no_service_charge` flag on /print/bill, the waiver on an open bill, the web
 * dashboard's opt-out. It routes through resolveServiceChargeConfig because
 * pairing `includeServiceCharge=false` with a tax config the charge has NOT been
 * lifted out of is precisely the bug: four call sites each paired those two by
 * hand and four of them got it wrong.
 */
function printedBill(shape: Shape, subtotal: number, off: boolean, discount?: BillDiscount) {
  const cfg = resolveServiceChargeConfig(shape.taxConfig, shape.scPct, off);
  const charges = computeBillCharges(subtotal, cfg.taxConfig, cfg.scPct, cfg.includeServiceCharge, discount);
  return { cfg, charges };
}

// ============================================================================
// THE CLIENT'S SENTENCE
// ============================================================================

describe("F2 — a bill printed WITHOUT the charge costs the guest less, in every shape", () => {
  for (const shape of SHAPES) {
    describe(shape.name, () => {
      test.each(SUBTOTALS)(
        "subtotal %p: without < with, STRICTLY",
        (subtotal) => {
          const withCharge = printedBill(shape, subtotal, false).charges;
          const without = printedBill(shape, subtotal, true).charges;
          // The one assertion this entire file exists for. On the shipped code
          // this was an EQUALITY in the tax_line shape. Asserted BEFORE the
          // rupee rounding of migration 048: on a one-rupee bill the charge is
          // ten paise, which both totals can round away — the charge still came
          // off, and the payable total can never go UP for it.
          expect(without.pre_round_total).toBeLessThan(withCharge.pre_round_total);
          expect(without.grand_total).toBeLessThanOrEqual(withCharge.grand_total);
        },
      );

      test("the difference is the charge PLUS the tax that rode on it — never just the charge", () => {
        const subtotal = 5499; // the real printed bill the client supplied.
        const withCharge = printedBill(shape, subtotal, false).charges;
        const without = printedBill(shape, subtotal, true).charges;
        const quote = quoteServiceChargeWaiver(subtotal, shape.taxConfig, shape.scPct, null);

        // The two ladders and the quote are three readings of one subtraction;
        // if they ever disagree, the bill the guest pays and the saving the
        // waiver record claims have come apart.
        // Pre-round: the rounded totals each carry their own round-off (048).
        expect(round2(withCharge.pre_round_total - without.pre_round_total)).toBe(quote.grand_total_reduction);
        expect(quote.grand_total_reduction).toBe(round2(quote.amount_waived + quote.tax_on_waived));
        expect(quote.grand_total_with).toBe(withCharge.grand_total);
        expect(quote.grand_total_without).toBe(without.grand_total);

        if (shape.taxRidesOnTheCharge) {
          // The charge sits UNDER the GST, so waiving it takes the GST with it.
          // Asserting only `reduction === amount_waived` here would have passed
          // while the guest was over-refunded or under-refunded by the GST.
          expect(quote.tax_on_waived).toBeGreaterThan(0);
          expect(quote.grand_total_reduction).toBeGreaterThan(quote.amount_waived);
        } else {
          // The charge IS a tax line: nothing is charged on top of it, so there
          // is structurally no tax to give back with it.
          expect(quote.tax_on_waived).toBe(0);
          expect(quote.grand_total_reduction).toBe(quote.amount_waived);
        }
      });

      test("the bill tells the truth about WHETHER a charge was removed", () => {
        // The (since retired) Opted-out line and the voluntary-charge disclaimer
        // used to key off `settings.service_charge > 0`, which is 0 on a tax_line
        // tenant — so the one tenant being overcharged was also the one whose bill
        // declined to mention the charge at all. These three fields are the
        // replacement; today they gate the disclaimer, the audit line and the
        // waiver card, and no printed line.
        const on = printedBill(shape, 1000, false).cfg;
        const offCfg = printedBill(shape, 1000, true).cfg;

        expect(on.basis).not.toBe("none");
        expect(on.service_charge_applied).toBe(true);
        expect(on.service_charge_removed).toBe(false);

        expect(offCfg.basis).toBe(on.basis);
        expect(offCfg.service_charge_applied).toBe(false);
        expect(offCfg.service_charge_removed).toBe(true);

        // A percentage the display line can print in EITHER shape. On a tax_line
        // tenant `settings.service_charge` is 0 and this is 10.
        expect(offCfg.service_charge_percent).toBeGreaterThan(0);
        expect(offCfg.service_charge_percent).toBe(on.service_charge_percent);
      });

      test("off really means off: no rung of the waived ladder carries a charge", () => {
        const { cfg, charges } = printedBill(shape, 2400, true);
        expect(charges.service_charge).toBe(0);
        expect(charges.service_charge_percent).toBe(0);
        // The tax_line leg is the one the shipped code left behind. It must not
        // survive into the taxes the guest is shown OR the ones they are charged.
        expect(charges.taxes.some((t) => /service\s*charge/i.test(t.name))).toBe(false);
        expect(cfg.includeServiceCharge).toBe(false);
        expect(cfg.scPct).toBe(0);
      });

      test.each(SUBTOTALS)("subtotal %p: the waived ladder still conserves, to the paisa", (subtotal) => {
        const { charges } = printedBill(shape, subtotal, true);
        // subtotal - discount + service_charge + tax_total + round_off === grand_total.
        // Compared in whole paisa for the reason billing_math.ts's TENDERS
        // header gives: 33.33 + 33.33 + 33.34 is not 100 in a double.
        const rungs =
          toPaisa(charges.subtotal) - toPaisa(charges.discount) +
          toPaisa(charges.service_charge) + toPaisa(charges.tax_total) + toPaisa(charges.round_off);
        expect(rungs).toBe(toPaisa(charges.grand_total));
        expect(toPaisa(charges.discounted_subtotal)).toBe(toPaisa(charges.subtotal) - toPaisa(charges.discount));
      });

      test("a discount applies first, and the charge still comes off on top of it", () => {
        const discount: BillDiscount = { type: "percent", value: 25 };
        const withCharge = printedBill(shape, 2400, false, discount).charges;
        const without = printedBill(shape, 2400, true, discount).charges;
        expect(without.grand_total).toBeLessThan(withCharge.grand_total);
        // The discount is untouched by the waiver: only the charge moved.
        expect(without.discount).toBe(withCharge.discount);
        expect(without.discounted_subtotal).toBe(withCharge.discounted_subtotal);
        const quote = quoteServiceChargeWaiver(2400, shape.taxConfig, shape.scPct, discount);
        expect(round2(withCharge.pre_round_total - without.pre_round_total)).toBe(quote.grand_total_reduction);
      });
    });
  }
});

// ============================================================================
// THE TENANT WHO HAS NEVER USED THIS
// ============================================================================

describe("a tenant with NO service charge configured prints identically either way", () => {
  test.each(SUBTOTALS)("subtotal %p is byte-identical with the flag on or off", (subtotal) => {
    const on = printedBill({ name: "none", taxConfig: NO_CHARGE_TAX, scPct: 0, taxRidesOnTheCharge: false }, subtotal, false);
    const off = printedBill({ name: "none", taxConfig: NO_CHARGE_TAX, scPct: 0, taxRidesOnTheCharge: false }, subtotal, true);
    // Not "close enough": the same JSON. A tenant who has never heard of this
    // feature must not be able to tell that it shipped.
    expect(JSON.stringify(off.charges)).toBe(JSON.stringify(on.charges));
  });

  test("and nothing reports a removal on a tenant that has no charge to remove", () => {
    const off = printedBill({ name: "none", taxConfig: NO_CHARGE_TAX, scPct: 0, taxRidesOnTheCharge: false }, 1000, true).cfg;
    expect(off.basis).toBe("none");
    expect(off.service_charge_removed).toBe(false);
    expect(off.service_charge_applied).toBe(false);
    expect(off.service_charge_percent).toBe(0);
    // Nothing to remove means the caller's own config comes back untouched —
    // identity, not a normalised copy — so no printer can be handed a rebuilt
    // tax list it did not ask for.
    expect(off.taxConfig).toBe(NO_CHARGE_TAX);
  });

  test("an empty / absent tax config survives the round trip", () => {
    for (const empty of [null, undefined, {}, []] as const) {
      const cfg = resolveServiceChargeConfig(empty, 0, true);
      expect(cfg.basis).toBe("none");
      expect(cfg.service_charge_removed).toBe(false);
      expect(computeBillCharges(1000, cfg.taxConfig, cfg.scPct, cfg.includeServiceCharge).grand_total).toBe(1000);
    }
  });
});

// ============================================================================
// THE RESOLVER'S OWN CONTRACT
// ============================================================================

describe("resolveServiceChargeConfig — one answer, asked twice, is the same answer", () => {
  test("leaving the charge ON hands back the caller's own config object", () => {
    const cfg = resolveServiceChargeConfig(TAX_LINE_ONLY, 10, false);
    // Identity, not equality: the on-path is the path every existing bill takes
    // and it must not be rebuilt underneath them.
    expect(cfg.taxConfig).toBe(TAX_LINE_ONLY);
    expect(cfg.includeServiceCharge).toBe(true);
    expect(cfg.scPct).toBe(10);
  });

  test("the tax_line shape is named as such even when no percent is configured", () => {
    const cfg = resolveServiceChargeConfig(TAX_LINE_ONLY, 0, false);
    expect(cfg.basis).toBe("tax_line");
    expect(cfg.service_charge_percent).toBe(10);
    // The precedence matches quoteServiceChargeWaiver's: a tenant carrying both
    // is reported under the tax_line shape, because that is the one the settled
    // bill is read back through.
    expect(resolveServiceChargeConfig(TAX_LINE_ONLY, 10, false).basis).toBe("tax_line");
    expect(resolveServiceChargeConfig(TAX_ONLY, 10, false).basis).toBe("restaurant_percent");
  });

  test("turning it off is idempotent — a second pass removes nothing more", () => {
    const once = resolveServiceChargeConfig(TAX_LINE_ONLY, 10, true);
    const twice = resolveServiceChargeConfig(once.taxConfig, once.scPct, true);
    expect(computeBillCharges(2400, twice.taxConfig, twice.scPct, twice.includeServiceCharge).grand_total)
      .toBe(computeBillCharges(2400, once.taxConfig, once.scPct, once.includeServiceCharge).grand_total);
    // Nothing left to remove, so the second pass truthfully reports none.
    expect(twice.basis).toBe("none");
    expect(twice.service_charge_removed).toBe(false);
  });

  test("the waived config it returns is the one quoteServiceChargeWaiver priced against", () => {
    // If these two ever produce different configs, the bill the guest pays and
    // the saving written to "ServiceChargeWaivers" are measuring different
    // things — the failure that is invisible until a manager reconciles.
    for (const shape of SHAPES) {
      const cfg = resolveServiceChargeConfig(shape.taxConfig, shape.scPct, true);
      const quote = quoteServiceChargeWaiver(0, shape.taxConfig, shape.scPct, null);
      expect(cfg.taxConfig).toEqual(quote.tax_config_waived);
      expect(cfg.scPct).toBe(quote.service_charge_percent_waived);
    }
  });

  test("a negative or junk percent cannot become a negative charge", () => {
    for (const junk of [-10, NaN, Infinity, "abc" as unknown as number, null as unknown as number]) {
      const cfg = resolveServiceChargeConfig(TAX_ONLY, junk, false);
      expect(cfg.scPct).toBeGreaterThanOrEqual(0);
      expect(computeBillCharges(1000, cfg.taxConfig, cfg.scPct, cfg.includeServiceCharge).service_charge)
        .toBeGreaterThanOrEqual(0);
    }
  });
});
