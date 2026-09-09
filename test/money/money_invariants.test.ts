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
import { round2, computeBillTaxes, computeBillCharges, computeBillSplit, computeSectionSplit, toPaisa } from "../../billing_math";

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

// ============================================================================
// THE SECTION SPLIT'S OWN INVARIANT
// ============================================================================
//
// Splitting a bill between the parts of the menu it came from (starters, mains,
// the bar) produces N documents that a guest pays against. The core invariant
// above is about ONE bill decomposing; this is about N of them RECOMPOSING —
// every rung of the ladder, not just the total. A split that apportions the food
// but drops the GST hands the restaurant a set of parts whose tax does not equal
// the tax on the bill they came from, which is a filing problem and not a
// display one.
//
// Zero tolerance and whole paisa, for the reason the tender header gives: 33.33
// x 3 is 100.00000000000001 in a double, so "sums exactly" can only be asserted
// in integers.

describe("section split — the parts recompose the bill, rung by rung", () => {
  const GST_SPLIT = [
    { name: "CGST", percentage: 2.5 },
    { name: "SGST", percentage: 2.5 },
  ];
  const paisa = (n: number) => toPaisa(n);
  const sumPaisa = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

  // Every awkward money shape this suite already worries about, split across two
  // to five menu sections whose values do not divide evenly.
  const cases: { subtotal: number; sc: number; weights: number[] }[] = [
    { subtotal: 100, sc: 0, weights: [1, 1, 1] },
    { subtotal: 10, sc: 10, weights: [1, 1, 1] },
    { subtotal: 0.05, sc: 0, weights: [1, 1, 1, 1] },
    { subtotal: 1060, sc: 7.5, weights: [3, 2, 1, 1] },
    { subtotal: 1234.56, sc: 5, weights: [7, 3] },
    { subtotal: 333.33, sc: 10, weights: [1, 1, 1] },
    { subtotal: 99999.99, sc: 10, weights: [5, 4, 3, 2, 1] },
    { subtotal: 87654.32, sc: 0, weights: [1, 999999] },
  ];

  test.each(cases)("subtotal %p splits without losing or inventing a paisa", ({ subtotal, sc, weights }) => {
    const bill = computeBillCharges(subtotal, DEFAULT_TAX_ONLY, sc, true);
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    // Lines whose values sum to the subtotal, in the requested proportions.
    let placed = 0;
    const lines = weights.map((w, i) => {
      const value = i === weights.length - 1
        ? round2(subtotal - placed)
        : round2((subtotal * w) / totalWeight);
      placed = round2(placed + value);
      return {
        section_key: `s${String(i)}`,
        section_label: `Section ${String(i)}`,
        name: `dish ${String(i)}`,
        price: value,
        quantity: 1,
      };
    });
    const r = computeSectionSplit(bill, lines);

    expect(sumPaisa(r.parts.map((p) => paisa(p.grand_total)))).toBe(paisa(bill.grand_total));
    expect(sumPaisa(r.parts.map((p) => paisa(p.subtotal)))).toBe(paisa(bill.subtotal));
    expect(sumPaisa(r.parts.map((p) => paisa(p.service_charge)))).toBe(paisa(bill.service_charge));
    expect(sumPaisa(r.parts.map((p) => paisa(p.tax_total)))).toBe(paisa(bill.tax_total));
    // THE GST IS APPORTIONED, NOT DROPPED — asserted per named tax line, because
    // a split whose CGST and SGST do not each add back up is not a tax document.
    bill.taxes.forEach((t, i) => {
      expect(sumPaisa(r.parts.map((p) => paisa(p.taxes[i]!.amount)))).toBe(paisa(t.amount));
    });
    // And each part is a bill in miniature that adds up to itself.
    for (const part of r.parts) {
      expect(paisa(part.discounted_subtotal) + paisa(part.service_charge) + paisa(part.tax_total) + paisa(part.round_off))
        .toBe(paisa(part.grand_total));
      expect(part.grand_total).toBeGreaterThanOrEqual(0);
    }
  });

  test("the service charge is apportioned in BOTH shapes it occurs in", () => {
    // Shape (b): the charge lives inside the tax config, so it arrives as a tax
    // LINE and must be apportioned as one — the shipped seed's configuration.
    const inTaxConfig = computeBillCharges(1000, DEFAULT_TAX_WITH_SC, 0, true);
    // Shape (a): "Restaurant".service_charge, its own rung under the tax.
    const asPercent = computeBillCharges(1000, DEFAULT_TAX_ONLY, 10, true);
    const lines = [
      { section_key: "kitchen", section_label: "Kitchen", name: "Dal", price: 700, quantity: 1 },
      { section_key: "bar", section_label: "Bar", name: "Beer", price: 300, quantity: 1 },
    ];
    for (const bill of [inTaxConfig, asPercent]) {
      const r = computeSectionSplit(bill, lines);
      const charged = round2(
        r.parts.reduce((s, p) => s + p.service_charge + p.taxes.filter((t) => isServiceCharge(t.name)).reduce((a, t) => a + t.amount, 0), 0),
      );
      const onBill = round2(
        bill.service_charge + bill.taxes.filter((t) => isServiceCharge(t.name)).reduce((a, t) => a + t.amount, 0),
      );
      expect(paisa(charged)).toBe(paisa(onBill));
      expect(charged).toBeGreaterThan(0);
      expect(sumPaisa(r.parts.map((p) => paisa(p.grand_total)))).toBe(paisa(bill.grand_total));
    }
  });

  test("a discounted bill splits without the discount leaking or doubling", () => {
    for (const discount of [
      { type: "percent" as const, value: 15 },
      { type: "flat" as const, value: 333.33 },
      { type: "percent" as const, value: 100 },
    ]) {
      const bill = computeBillCharges(1000.01, DEFAULT_TAX_ONLY, 7.5, true, discount);
      const r = computeSectionSplit(bill, [
        { section_key: "a", section_label: "Starters", name: "x", price: 333.34, quantity: 1 },
        { section_key: "b", section_label: "Mains", name: "y", price: 333.34, quantity: 1 },
        { section_key: "c", section_label: "Bar", name: "z", price: 333.33, quantity: 1 },
      ]);
      expect(sumPaisa(r.parts.map((p) => paisa(p.discount)))).toBe(paisa(bill.discount));
      expect(sumPaisa(r.parts.map((p) => paisa(p.subtotal)))).toBe(paisa(bill.subtotal));
      expect(sumPaisa(r.parts.map((p) => paisa(p.grand_total)))).toBe(paisa(bill.grand_total));
      expect(r.parts.every((p) => p.grand_total >= 0)).toBe(true);
    }
  });

  test("the by-covers split still behaves exactly as it shipped", () => {
    // The section split is an ADDITIONAL mode. This is the same assertion as the
    // even-split test above, restated beside the new one so a change to the
    // shared allocator that broke the old mode could not pass unnoticed.
    expect(computeBillSplit(100, "even", { parts: 3 }).parts.map((p) => p.total)).toEqual([33.33, 33.33, 33.34]);
    expect(computeBillSplit(100, "item", {
      groups: [
        { label: "A", items: [{ name: "x", price: 30, quantity: 1 }] },
        { label: "B", items: [{ name: "y", price: 70, quantity: 1 }] },
      ],
    }).parts.map((p) => p.total)).toEqual([30, 70]);
  });
});
