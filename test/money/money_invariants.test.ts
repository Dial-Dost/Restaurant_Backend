// THE CORE MONEY INVARIANT, as pure arithmetic:
//
//     taxable_base + service_charge + tax_total === grand_total
//
// Every bill ever written must satisfy it, in both shapes a service charge
// occurs in. These tests need no database and no fixture — they pin the shared
// arithmetic in billing_math.ts that the write side (settle) uses to BUILD a
// bill, so a bill can never be stored in a state the read side cannot decompose.
// The read side's half of the contract is in report_agreement.test.ts.

import { describe, test, expect } from "@jest/globals";
import { round2, computeBillTaxes, computeBillCharges, computeBillSplit } from "../../billing_math";

// The shipped seed (migrations/000_base_schema.sql:266) puts the service charge
// INSIDE Outlets.default_tax, so it lands in Bills.tax_breakdown looking like a
// tax line. This is the configuration that caused the misreport.
const DEFAULT_TAX_WITH_SC = { SGST: 2.5, CGST: 2.5, "Service Charge": 1 };
const DEFAULT_TAX_ONLY = { SGST: 2.5, CGST: 2.5 };

const isServiceCharge = (name: string) => /service\s*charge/i.test(name);

describe("core invariant — shape (b): service charge inside Outlets.default_tax", () => {
  // Every subtotal a real bill plausibly lands on, including ones that force a
  // half-paisa in at least one tax line.
  const subtotals = [0, 1, 9.99, 100, 333.33, 500, 1000, 1234.56, 2400, 87654.32];

  test.each(subtotals)("subtotal %p decomposes back to the grand total", (subtotal) => {
    const { taxes, grand_total } = computeBillTaxes(subtotal, DEFAULT_TAX_WITH_SC);

    // The read side's decomposition: lift the service-charge line out, everything
    // else is genuine tax, and the base is what is left of the grand total.
    const service = taxes.filter((t) => isServiceCharge(t.name));
    const genuine = taxes.filter((t) => !isServiceCharge(t.name));
    const service_charge = round2(service.reduce((s, t) => s + t.amount, 0));
    const tax_total = round2(genuine.reduce((s, t) => s + t.amount, 0));
    const taxable_base = round2(grand_total - tax_total - service_charge);

    expect(round2(taxable_base + service_charge + tax_total)).toBe(grand_total);
    expect(taxable_base).toBe(round2(subtotal));
    // The bug in one line: summing the breakdown blindly overstates tax by the
    // service charge whenever one is configured.
    const blindTaxSum = round2(taxes.reduce((s, t) => s + t.amount, 0));
    if (subtotal > 0) {expect(blindTaxSum).toBeGreaterThan(tax_total);}
  });
});

describe("core invariant — shape (a): Restaurant.service_charge percent", () => {
  const cases: { subtotal: number; sc: number; discount?: { type: "percent" | "flat"; value: number } }[] = [
    { subtotal: 1000, sc: 0 },
    { subtotal: 1000, sc: 1 },
    { subtotal: 1000, sc: 10 },
    { subtotal: 333.33, sc: 7.5 },
    { subtotal: 1234.56, sc: 2.5, discount: { type: "percent", value: 10 } },
    { subtotal: 1234.56, sc: 2.5, discount: { type: "flat", value: 234.56 } },
    { subtotal: 50, sc: 5, discount: { type: "flat", value: 999 } }, // clamped to zero
    { subtotal: 0, sc: 5 },
  ];

  test.each(cases)("subtotal %p", ({ subtotal, sc, discount }) => {
    const r = computeBillCharges(subtotal, DEFAULT_TAX_ONLY, sc, true, discount ?? null);
    // discounted_subtotal IS the taxable base: what was charged for food, after
    // discount, before service charge and tax.
    expect(round2(r.discounted_subtotal + r.service_charge + r.tax_total)).toBe(r.grand_total);
    // No breakdown line may be a service charge in this shape — the charge is
    // folded into the amount the taxes were computed on instead.
    expect(r.taxes.some((t) => isServiceCharge(t.name))).toBe(false);
  });

  test("the two shapes agree on the same money", () => {
    // Shape (a): 1000 food + 1% SC, taxes on the base only (matching how shape
    // (b) applies every default_tax entry to the same subtotal).
    const base = 1000;
    const scPct = 1;
    const service_charge = round2((base * scPct) / 100);
    const a = computeBillTaxes(base, DEFAULT_TAX_ONLY);
    const aGrand = round2(base + service_charge + a.tax_total);

    // Shape (b): the same charge, expressed as a default_tax entry.
    const b = computeBillTaxes(base, DEFAULT_TAX_WITH_SC);
    const bService = round2(b.taxes.filter((t) => isServiceCharge(t.name)).reduce((s, t) => s + t.amount, 0));
    const bTax = round2(b.taxes.filter((t) => !isServiceCharge(t.name)).reduce((s, t) => s + t.amount, 0));

    expect(bService).toBe(service_charge);
    expect(bTax).toBe(a.tax_total);
    expect(b.grand_total).toBe(aGrand);
  });
});

describe("rounding tolerance", () => {
  // TOLERANCE, stated and justified:
  //
  //   round2() can move a single figure by at most 0.005 (half a paisa). A total
  //   built by summing N already-rounded figures can therefore sit at most
  //   N * 0.005 away from the rounded sum of the exact figures. That is the ONLY
  //   drift this codebase may tolerate; anything larger is a real arithmetic bug,
  //   not a rounding artefact.
  //
  // The bound is deliberately loose enough to never flake and tight enough that
  // the service-charge bug (which shifted 31,733.92) blows straight through it.
  const perFigureTolerance = 0.005;

  // Deterministic PRNG — a flaky money test gets ignored, which is worse than no test.
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  test("a sum of rounded bill totals stays within N * 0.005 of the rounded exact sum", () => {
    const rand = mulberry32(20260802);
    const n = 500;
    let exact = 0;
    let rounded = 0;
    for (let i = 0; i < n; i++) {
      const subtotal = round2(rand() * 5000);
      const r = computeBillTaxes(subtotal, DEFAULT_TAX_WITH_SC);
      rounded = round2(rounded + r.grand_total);
      // The same total without any intermediate rounding.
      exact += subtotal * (1 + (2.5 + 2.5 + 1) / 100);
    }
    const drift = Math.abs(rounded - round2(exact));
    expect(drift).toBeLessThanOrEqual(perFigureTolerance * n);
    // In practice the drift is orders of magnitude below the bound; if this ever
    // starts hugging the limit, the per-step rounding has changed.
    expect(drift).toBeLessThan(1);
  });

  test("a bill split conserves EXACTLY — zero tolerance, the last part absorbs the remainder", () => {
    for (const [grand, parts] of [[100, 3], [10, 3], [1060, 7], [0.05, 4], [99999.99, 50]] as const) {
      const r = computeBillSplit(grand, "even", { parts });
      expect(round2(r.parts.reduce((s, p) => s + p.total, 0))).toBe(round2(grand));
    }
  });
});
