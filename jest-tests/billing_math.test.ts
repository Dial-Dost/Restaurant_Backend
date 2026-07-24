import { describe, test, expect } from "@jest/globals";
import {
  round2,
  computeBillTaxes,
  computeBillCharges,
  computeCouponDiscount,
  computeBillSplit,
} from "../billing_math";

describe("round2", () => {
  test("rounds to 2 decimals (banker-agnostic toFixed)", () => {
    expect(round2(88.199999)).toBe(88.2);
    expect(round2(1.005)).toBe(1.0); // toFixed quirk — documents actual behavior
    expect(round2(10)).toBe(10);
  });
  test("coerces junk to 0 instead of NaN", () => {
    expect(round2(NaN)).toBe(0);
    // @ts-expect-error — exercising defensive coercion of a non-number
    expect(round2(undefined)).toBe(0);
    // @ts-expect-error
    expect(round2("abc")).toBe(0);
  });
});

describe("computeBillTaxes", () => {
  test("array config: one tax line", () => {
    const r = computeBillTaxes(100, [{ name: "GST", percentage: 5 }]);
    expect(r.taxes).toEqual([{ name: "GST", percentage: 5, amount: 5 }]);
    expect(r.tax_total).toBe(5);
    expect(r.grand_total).toBe(105);
  });
  test("object (default_tax map) config: split CGST/SGST", () => {
    const r = computeBillTaxes(200, { CGST: 2.5, SGST: 2.5 });
    expect(r.tax_total).toBe(10);
    expect(r.grand_total).toBe(210);
    expect(r.taxes.map((t) => t.amount)).toEqual([5, 5]);
  });
  test("ignores zero/blank/negative tax entries", () => {
    const r = computeBillTaxes(100, [
      { name: "GST", percentage: 5 },
      { name: "", percentage: 10 },
      { name: "Bad", percentage: 0 },
      { name: "Neg", percentage: -3 },
    ]);
    expect(r.taxes).toHaveLength(1);
    expect(r.tax_total).toBe(5);
  });
  test("null/undefined config yields no tax", () => {
    expect(computeBillTaxes(100, null).grand_total).toBe(100);
    expect(computeBillTaxes(100, undefined).tax_total).toBe(0);
  });
});

describe("computeBillCharges — ordering & totals", () => {
  test("discount → service charge → tax, in that order", () => {
    // 100 - 20 = 80; +5% SC = 4 -> 84; +5% GST = 4.2 -> grand 88.2
    const r = computeBillCharges(100, [{ name: "GST", percentage: 5 }], 5, true, {
      type: "flat",
      value: 20,
    });
    expect(r.subtotal).toBe(100);
    expect(r.discount).toBe(20);
    expect(r.discounted_subtotal).toBe(80);
    expect(r.service_charge).toBe(4);
    expect(r.tax_total).toBe(4.2);
    expect(r.grand_total).toBe(88.2);
  });

  test("percent discount", () => {
    // 10% off 100 = 90; no SC; 5% GST = 4.5 -> 94.5
    const r = computeBillCharges(100, [{ name: "GST", percentage: 5 }], 0, true, {
      type: "percent",
      value: 10,
    });
    expect(r.discount).toBe(10);
    expect(r.discounted_subtotal).toBe(90);
    expect(r.service_charge).toBe(0);
    expect(r.grand_total).toBe(94.5);
  });

  test("includeServiceCharge=false suppresses SC even if a percent is configured", () => {
    const r = computeBillCharges(100, null, 10, false);
    expect(r.service_charge).toBe(0);
    expect(r.service_charge_percent).toBe(0);
    expect(r.grand_total).toBe(100);
  });

  test("flat discount is clamped to the subtotal (never negative)", () => {
    const r = computeBillCharges(50, null, 0, true, { type: "flat", value: 999 });
    expect(r.discount).toBe(50);
    expect(r.discounted_subtotal).toBe(0);
    expect(r.grand_total).toBe(0);
  });

  test("percent discount is clamped to 100%", () => {
    const r = computeBillCharges(80, [{ name: "GST", percentage: 5 }], 0, true, {
      type: "percent",
      value: 250,
    });
    expect(r.discount).toBe(80);
    expect(r.discounted_subtotal).toBe(0);
    expect(r.grand_total).toBe(0);
  });

  test("no discount argument behaves like a zero discount", () => {
    const r = computeBillCharges(100, [{ name: "GST", percentage: 5 }], 10);
    // 100 +10% SC = 110; +5% GST = 5.5 -> 115.5
    expect(r.discount).toBe(0);
    expect(r.discount_type).toBeNull();
    expect(r.service_charge).toBe(10);
    expect(r.grand_total).toBe(115.5);
  });

  test("a zero-value discount does not flip discount_type on", () => {
    const r = computeBillCharges(100, null, 0, true, { type: "percent", value: 0 });
    expect(r.discount).toBe(0);
    expect(r.discount_type).toBeNull();
  });
});

describe("computeCouponDiscount", () => {
  test("flat coupon", () => {
    expect(computeCouponDiscount({ type: "flat", value: 30 }, 200)).toBe(30);
  });
  test("percent coupon", () => {
    expect(computeCouponDiscount({ type: "percent", value: 15 }, 200)).toBe(30);
  });
  test("max_discount caps a percent coupon", () => {
    expect(computeCouponDiscount({ type: "percent", value: 50, max_discount: 40 }, 200)).toBe(40);
  });
  test("max_discount of 0/null is treated as 'no cap'", () => {
    expect(computeCouponDiscount({ type: "percent", value: 50, max_discount: 0 }, 200)).toBe(100);
    expect(computeCouponDiscount({ type: "percent", value: 50, max_discount: null }, 200)).toBe(100);
  });
  test("discount never exceeds the subtotal", () => {
    expect(computeCouponDiscount({ type: "flat", value: 500 }, 120)).toBe(120);
  });
  test("non-positive subtotal yields no discount", () => {
    expect(computeCouponDiscount({ type: "flat", value: 30 }, 0)).toBe(0);
    expect(computeCouponDiscount({ type: "percent", value: 30 }, -5)).toBe(0);
  });
});

describe("computeBillSplit — conservation & allocation", () => {
  const sum = (r: { parts: { total: number }[] }) => round2(r.parts.reduce((s, p) => s + p.total, 0));

  test("even split: parts sum back to the grand total exactly (remainder on last)", () => {
    const r = computeBillSplit(100, "even", { parts: 3 });
    expect(r.parts.map((p) => p.total)).toEqual([33.33, 33.33, 33.34]);
    expect(sum(r)).toBe(100);
  });

  test("even split: clean division", () => {
    const r = computeBillSplit(100, "even", { parts: 4 });
    expect(r.parts.map((p) => p.total)).toEqual([25, 25, 25, 25]);
    expect(sum(r)).toBe(100);
  });

  test("even split: parts clamped to [2,50] and default 2", () => {
    expect(computeBillSplit(50, "even", { parts: 1 }).parts).toHaveLength(2);
    expect(computeBillSplit(50, "even", { parts: 999 }).parts).toHaveLength(50);
    expect(computeBillSplit(50, "even", {}).parts).toHaveLength(2);
  });

  test("even split: an awkward total still conserves", () => {
    const r = computeBillSplit(10, "even", { parts: 3 });
    expect(sum(r)).toBe(10); // 3.33 + 3.33 + 3.34
  });

  test("item split: allocates proportionally to group subtotals and conserves", () => {
    const r = computeBillSplit(120, "item", {
      groups: [
        { label: "A", items: [{ name: "x", price: 30, quantity: 1 }] }, // 30
        { label: "B", items: [{ name: "y", price: 90, quantity: 1 }] }, // 90
      ],
    });
    expect(r.parts[0].total).toBe(30);
    expect(r.parts[1].total).toBe(90);
    expect(sum(r)).toBe(120);
  });

  test("item split: quantities count, last group absorbs rounding", () => {
    const r = computeBillSplit(100, "item", {
      groups: [
        { items: [{ name: "a", price: 10, quantity: 1 }] }, // 10
        { items: [{ name: "b", price: 10, quantity: 1 }] }, // 10
        { items: [{ name: "c", price: 10, quantity: 1 }] }, // 10  → 1/3 each of 100
      ],
    });
    expect(sum(r)).toBe(100);
  });

  test("item split: zero-value groups fall back to the bill subtotal, still conserves", () => {
    const r = computeBillSplit(60, "item", {
      groups: [{ items: [] }, { items: [] }],
      subtotalFallback: 60,
    });
    expect(sum(r)).toBe(60);
  });

  test("item split: empty groups array falls back to even split", () => {
    const r = computeBillSplit(40, "item", { groups: [], parts: 2 });
    expect(r.mode).toBe("even");
    expect(sum(r)).toBe(40);
  });
});
