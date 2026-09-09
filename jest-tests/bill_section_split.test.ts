// THE SECTION SPLIT — splitting one bill between the parts of the menu it came
// from (starters / mains / bar), rather than between the people at the table.
//
// EVERY TEST HERE IS ABOUT ONE OF TWO THINGS: that the parts add back up to the
// bill (the column), and that each part adds up to itself (the row). A split
// that fails either is not a rounding bug, it is a tax document that does not
// reconcile — so the tolerance throughout is ZERO and every comparison is made
// in whole paisa, where "equal" means equal.

import {
  allocateInPaisa,
  computeBillCharges,
  computeSectionSplit,
  round2,
  toPaisa,
  type SectionSplitLine,
  type SectionSplitResult,
} from "../billing_math";

const p = (n: number) => toPaisa(n);
const sumP = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

/** A line, with the fields a test does not care about filled in. */
function line(section: string, name: string, price: number, quantity = 1, extra: Partial<SectionSplitLine> = {}): SectionSplitLine {
  return { section_key: section.toLowerCase(), section_label: section, name, price, quantity, ...extra };
}

/** The two invariants, asserted together, in paisa. Called by nearly every test. */
function assertConserves(bill: Parameters<typeof computeSectionSplit>[0], r: SectionSplitResult): void {
  // COLUMN — every rung of the bill is fully distributed.
  expect(sumP(r.parts.map((x) => p(x.grand_total)))).toBe(p(bill.grand_total));
  expect(sumP(r.parts.map((x) => p(x.subtotal)))).toBe(p(bill.subtotal));
  expect(sumP(r.parts.map((x) => p(x.discount)))).toBe(p(bill.discount));
  expect(sumP(r.parts.map((x) => p(x.service_charge)))).toBe(p(bill.service_charge));
  expect(sumP(r.parts.map((x) => p(x.tax_total)))).toBe(p(bill.tax_total));
  bill.taxes.forEach((t, i) => {
    expect(sumP(r.parts.map((x) => p(x.taxes[i]!.amount)))).toBe(p(t.amount));
    expect(r.parts.every((x) => x.taxes[i]!.name === t.name)).toBe(true);
  });
  // ROW — each part is a bill in miniature and adds up to its own total.
  for (const part of r.parts) {
    expect(p(part.subtotal) - p(part.discount)).toBe(p(part.discounted_subtotal));
    expect(sumP(part.taxes.map((t) => p(t.amount)))).toBe(p(part.tax_total));
    expect(
      p(part.discounted_subtotal) + p(part.service_charge) + p(part.tax_total) + p(part.round_off),
    ).toBe(p(part.grand_total));
    // No part is ever negative — the reason the NET subtotal is the allocated
    // rung and the gross one is derived from it.
    expect(part.grand_total).toBeGreaterThanOrEqual(0);
  }
}

const GST = [
  { name: "CGST", percentage: 2.5 },
  { name: "SGST", percentage: 2.5 },
];

// Deterministic PRNG — a flaky money test gets ignored, which is worse than none.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("allocateInPaisa — the allocator both invariants rest on", () => {
  test("no weights at all allocates nothing", () => {
    expect(allocateInPaisa(1234, [])).toEqual([]);
  });

  test("the parts sum back to the total EXACTLY, over a wide random sweep", () => {
    const rand = mulberry32(20260909);
    for (let trial = 0; trial < 2000; trial++) {
      const n = 1 + Math.floor(rand() * 8);
      const weights = Array.from({ length: n }, () => Math.floor(rand() * 500000));
      const total = Math.floor(rand() * 20000000);
      const parts = allocateInPaisa(total, weights);
      expect(parts).toHaveLength(n);
      expect(sumP(parts)).toBe(total);
    }
  });

  test("largest remainder: the leftover paisa go to the biggest fractional claims, not to the last part", () => {
    // 100 paisa over three equal sections: 33.33/33.33/33.34 in rupees. Every
    // claim ties, so the tie-break (index) hands the extra paisa to the FIRST.
    expect(allocateInPaisa(100, [1, 1, 1])).toEqual([34, 33, 33]);
    // 10 paisa over 1:2:7 is exact, no leftover at all.
    expect(allocateInPaisa(10, [1, 2, 7])).toEqual([1, 2, 7]);
    // 100 over 1:1:1:1:1:1 leaves 4 paisa, one each to the first four.
    expect(allocateInPaisa(100, [1, 1, 1, 1, 1, 1])).toEqual([17, 17, 17, 17, 16, 16]);
  });

  test("no part is ever more than one paisa off its exact share", () => {
    const rand = mulberry32(7);
    for (let trial = 0; trial < 500; trial++) {
      const n = 2 + Math.floor(rand() * 10);
      const weights = Array.from({ length: n }, () => 1 + Math.floor(rand() * 9999));
      const total = Math.floor(rand() * 5000000);
      const W = sumP(weights);
      const parts = allocateInPaisa(total, weights);
      parts.forEach((got, i) => {
        expect(Math.abs(got - (total * weights[i]!) / W)).toBeLessThan(1);
      });
    }
  });

  test("a zero-weight part is never handed a stray paisa", () => {
    // Two paying sections and one wholly comped one. The comped one gets zero,
    // even though there is a leftover paisa to place.
    expect(allocateInPaisa(101, [50, 50, 0])).toEqual([51, 50, 0]);
    expect(allocateInPaisa(1, [7, 0, 0])).toEqual([1, 0, 0]);
  });

  test("when NOTHING has weight the amount is spread evenly, never dropped and never all on one", () => {
    expect(allocateInPaisa(100, [0, 0, 0])).toEqual([34, 33, 33]);
    expect(sumP(allocateInPaisa(7, [0, 0]))).toBe(7);
  });

  test("stays exact past 2^53, where a double multiplication would not", () => {
    // 90,000 crore paisa against weights of the same order. total x weight here
    // is ~8.1e21; a double stops being an integer at 9.007e15.
    const total = 900000000000;
    const weights = [900000000000, 900000000001, 3];
    const parts = allocateInPaisa(total, weights);
    expect(sumP(parts)).toBe(total);
  });

  test("a negative amount (a refund-shaped ladder) still conserves", () => {
    expect(sumP(allocateInPaisa(-100, [1, 1, 1]))).toBe(-100);
  });
});

describe("computeSectionSplit — the money rule", () => {
  test("the textbook case: food and bar, GST and service charge apportioned to both", () => {
    const bill = computeBillCharges(1000, GST, 10, true);
    // 700 of food, 300 of bar.
    const r = computeSectionSplit(bill, [
      line("Mains", "Butter Chicken", 350, 2),
      line("Bar", "Beer", 150, 2),
    ]);
    expect(r.parts.map((x) => x.label)).toEqual(["Mains", "Bar"]);
    expect(r.parts[0]!.subtotal).toBe(700);
    expect(r.parts[1]!.subtotal).toBe(300);
    // Service charge 10% and 5% GST ride along in proportion — not dropped.
    expect(r.parts[0]!.service_charge).toBe(70);
    expect(r.parts[1]!.service_charge).toBe(30);
    expect(r.parts[0]!.tax_total).toBe(38.5);
    expect(r.parts[1]!.tax_total).toBe(16.5);
    expect(r.parts[0]!.grand_total).toBe(808.5);
    expect(r.parts[1]!.grand_total).toBe(346.5);
    expect(round2(r.parts[0]!.grand_total + r.parts[1]!.grand_total)).toBe(bill.grand_total);
    assertConserves(bill, r);
  });

  test("A THREE-WAY SPLIT OF AN ODD AMOUNT — the case that drifts", () => {
    // Three equal sections over a total that does not divide by three.
    const bill = computeBillCharges(100.01, GST, 0, true);
    const r = computeSectionSplit(bill, [
      line("Starters", "a", 33.34),
      line("Mains", "b", 33.34),
      line("Bar", "c", 33.33),
    ]);
    assertConserves(bill, r);
    // And the same shape with the awkward totals the tender header calls out.
    for (const subtotal of [100, 10, 0.05, 33.33, 99999.99, 1060]) {
      const b = computeBillCharges(subtotal, GST, 7.5, true);
      const s = computeSectionSplit(b, [
        line("Starters", "a", round2(subtotal / 3)),
        line("Mains", "b", round2(subtotal / 3)),
        line("Bar", "c", round2(subtotal - 2 * round2(subtotal / 3))),
      ]);
      assertConserves(b, s);
    }
  });

  test("a randomised sweep of bills, sections and line values conserves with ZERO tolerance", () => {
    const rand = mulberry32(20260909);
    for (let trial = 0; trial < 800; trial++) {
      const sections = 1 + Math.floor(rand() * 6);
      const lines: SectionSplitLine[] = [];
      let subtotal = 0;
      for (let s = 0; s < sections; s++) {
        const howMany = 1 + Math.floor(rand() * 4);
        for (let k = 0; k < howMany; k++) {
          const price = round2(rand() * 900 + 0.01);
          const quantity = 1 + Math.floor(rand() * 4);
          // Roughly one line in eight is comped: it must weigh nothing.
          const nc = rand() < 0.125;
          lines.push(line(`S${s}`, `dish ${s}-${k}`, price, quantity, nc ? { nc: true, nc_kind: "staff_meal" } : {}));
          if (!nc) {subtotal = round2(subtotal + price * quantity);}
        }
      }
      const scPct = [0, 5, 7.5, 10][Math.floor(rand() * 4)]!;
      const discount = rand() < 0.3
        ? { type: (rand() < 0.5 ? "percent" : "flat") as "percent" | "flat", value: round2(rand() * (rand() < 0.5 ? 40 : subtotal)) }
        : null;
      const bill = computeBillCharges(subtotal, GST, scPct, true, discount);
      assertConserves(bill, computeSectionSplit(bill, lines));
    }
  });

  test("a 100% discount leaves every part at zero — and none of them negative", () => {
    const bill = computeBillCharges(101, GST, 10, true, { type: "percent", value: 100 });
    const r = computeSectionSplit(bill, [
      line("Starters", "a", 0.01),
      line("Mains", "b", 100),
    ]);
    expect(bill.grand_total).toBe(0);
    expect(r.parts.every((x) => x.grand_total === 0)).toBe(true);
    assertConserves(bill, r);
  });

  test("when the section weights already sum to the bill, each section gets exactly its own lines' value", () => {
    // The property that makes the split explainable at the till: nobody is
    // pro-rated away from what they actually ate.
    const bill = computeBillCharges(1234.56, GST, 0, true);
    const r = computeSectionSplit(bill, [
      line("Mains", "a", 1000.01),
      line("Bar", "b", 234.55),
    ]);
    expect(r.parts.find((x) => x.label === "Mains")!.subtotal).toBe(1000.01);
    expect(r.parts.find((x) => x.label === "Bar")!.subtotal).toBe(234.55);
    assertConserves(bill, r);
  });
});

describe("computeSectionSplit — what goes where", () => {
  test("a non-chargeable line weighs nothing but is still listed under its section", () => {
    const bill = computeBillCharges(500, GST, 0, true);
    const r = computeSectionSplit(bill, [
      line("Mains", "Paid dish", 500),
      line("Desserts", "Comped Gulab Jamun", 120, 2, { nc: true, nc_kind: "guest_complaint" }),
    ]);
    const desserts = r.parts.find((x) => x.label === "Desserts")!;
    // The comped section owes nothing at all — not one stray paisa.
    expect(desserts.grand_total).toBe(0);
    expect(desserts.subtotal).toBe(0);
    expect(desserts.nc_value).toBe(240);
    expect(desserts.items[0]!.nc).toBe(true);
    expect(desserts.items[0]!.nc_kind).toBe("guest_complaint");
    // ...and it is not counted as something anybody has to pay.
    expect(r.payable_parts).toBe(1);
    expect(r.parts).toHaveLength(2);
    assertConserves(bill, r);
  });

  test("an item in no section goes somewhere EXPLICIT — it never vanishes and never joins a real section", () => {
    const bill = computeBillCharges(300, GST, 0, true);
    const r = computeSectionSplit(bill, [
      line("Mains", "Dal", 100),
      line("Unclassified", "Steamed Rice", 100, 1, { section_gap: true }),
      line("Unattributed", "Valet fee", 100, 1, { section_gap: true }),
    ]);
    expect(r.parts.map((x) => x.label)).toEqual(["Mains", "Unattributed", "Unclassified"]);
    expect(r.parts.map((x) => x.gap)).toEqual([false, true, true]);
    // Each of them carries its own money rather than being folded anywhere.
    expect(r.parts.map((x) => x.subtotal)).toEqual([100, 100, 100]);
    assertConserves(bill, r);
  });

  test("the two gap buckets stay APART from each other — a config gap is not a history gap", () => {
    const bill = computeBillCharges(200, [], 0, true);
    const r = computeSectionSplit(bill, [
      line("Unclassified", "Steamed Rice", 100, 1, { section_gap: true }),
      line("Unattributed", "Deleted dish", 100, 1, { section_gap: true }),
    ]);
    expect(r.parts).toHaveLength(2);
  });

  test("gaps sort last, real sections sort heaviest-first", () => {
    const bill = computeBillCharges(1000, [], 0, true);
    const r = computeSectionSplit(bill, [
      line("Unclassified", "x", 400, 1, { section_gap: true }),
      line("Starters", "y", 100),
      line("Bar", "z", 500),
    ]);
    expect(r.parts.map((x) => x.label)).toEqual(["Bar", "Starters", "Unclassified"]);
  });

  test("a bill with no lines at all still returns the whole bill as one part", () => {
    const bill = computeBillCharges(250, GST, 10, true);
    const r = computeSectionSplit(bill, [], { fallbackLabel: "Whole bill" });
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0]!.label).toBe("Whole bill");
    expect(r.parts[0]!.grand_total).toBe(bill.grand_total);
    assertConserves(bill, r);
  });

  test("the same dish across two orders merges into one line, exactly as the open bill merges it", () => {
    const bill = computeBillCharges(400, [], 0, true);
    const r = computeSectionSplit(bill, [
      line("Bar", "Beer", 100, 2),
      line("Bar", "Beer", 100, 1),
      line("Bar", "Beer", 120, 1),
    ]);
    const bar = r.parts[0]!;
    expect(bar.items).toHaveLength(2);
    expect(bar.items[0]).toMatchObject({ name: "Beer", price: 100, quantity: 3 });
    expect(bar.items[1]).toMatchObject({ name: "Beer", price: 120, quantity: 1 });
    expect(bar.qty).toBe(4);
  });

  test("a variation is its own line, and a comped one is kept apart from a paid one", () => {
    const bill = computeBillCharges(400, [], 0, true);
    const r = computeSectionSplit(bill, [
      line("Mains", "Paneer Tikka", 150, 1, { variation: "Half" }),
      line("Mains", "Paneer Tikka", 250, 1, { variation: "Full" }),
      line("Mains", "Paneer Tikka", 250, 1, { variation: "Full", nc: true }),
    ]);
    expect(r.parts[0]!.items).toHaveLength(3);
    expect(r.parts[0]!.items.map((x) => x.variation)).toEqual(["Half", "Full", "Full"]);
  });

  test("a weighed line (2.5 kg) is NOT rounded to 3 — the same quantity rule the rest of the money uses", () => {
    const bill = computeBillCharges(500, [], 0, true);
    const r = computeSectionSplit(bill, [
      line("Mains", "Mutton by weight", 200, 2.5),
    ]);
    expect(r.parts[0]!.qty).toBe(2.5);
    expect(r.parts[0]!.subtotal).toBe(500);
  });

  test("a ladder that does not add up is reconciled through round_off, never by losing money", () => {
    // A caller hands in a grand total 1 rupee above its own rungs. The split
    // must still sum to the grand total the guest is being charged.
    const broken = { subtotal: 100, discount: 0, service_charge: 0, taxes: [], tax_total: 0, grand_total: 101 };
    const r = computeSectionSplit(broken, [line("A", "x", 50), line("B", "y", 50)]);
    expect(sumP(r.parts.map((x) => p(x.grand_total)))).toBe(p(101));
    expect(round2(r.parts[0]!.round_off + r.parts[1]!.round_off)).toBe(1);
    assertConserves(broken, r);
  });

  test("`total` still means what an existing split client thinks it means", () => {
    const bill = computeBillCharges(600, GST, 0, true);
    const r = computeSectionSplit(bill, [line("Mains", "a", 300), line("Bar", "b", 300)]);
    expect(r.parts.every((x) => x.total === x.grand_total)).toBe(true);
    expect(round2(r.parts.reduce((s, x) => s + x.total, 0))).toBe(bill.grand_total);
  });
});
