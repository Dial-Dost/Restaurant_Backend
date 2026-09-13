// PRINTING A SPLIT BILL — F3, the half of it that did not exist.
//
// The arithmetic was already done, tested and conserving (see
// bill_section_split.test.ts): computeSectionSplit apportions every rung of the
// ladder in whole paisa and the parts add back up to the bill exactly. What was
// missing was paper. This suite is about the renderer, and it asks the one
// question that can lose money on the way to the roll: DO THE PRINTED NUMBERS
// STILL ADD UP?
//
// So nearly every assertion here is made against the PRINTED CHARACTERS — the
// figure a guest reads off the slip and hands over cash against — rather than
// against the object the allocator returned. A renderer that re-derives a part's
// total and whole-rupee-rounds it (the legacy branch of buildReceiptBase64,
// which is exactly what a part must never fall into) returns a perfectly correct
// SectionSplitResult and prints three slips that do not sum to the bill.
//
// Tolerance is ZERO throughout and every comparison is made in whole paisa,
// where "equal" means equal.

import { describe, test, expect } from "@jest/globals";
import {
  computeBillCharges,
  computeSectionSplit,
  toPaisa,
  type SectionSplitLine,
} from "../billing_math";
import {
  buildReceiptBase64,
  buildSplitReceiptsBase64,
  type ReceiptOptions,
} from "../escpos";

const decode = (b64: string) => Buffer.from(b64, "base64").toString("latin1");

/**
 * The receipt as the PAPER shows it — the same helper escpos.test.ts uses, and
 * for the same reason: the ESC/POS mode bytes are interleaved with the text, so
 * a naive substring match misses "Grand Total:" (which is prefixed by ESC E 1)
 * and a naive length read comes out three characters long.
 */
function printed(b64: string): string {
  return decode(b64)
    .replace(/\x1b@/g, "")            // ESC @   initialize
    .replace(/\x1b[a!E][\s\S]/g, "")  // ESC a/!/E n   align / mode / bold
    .replace(/\x1dV[\s\S]/g, "");     // GS V n  cut
}

/** Printed width in CELLS, not characters — a doubled banner eats two each. */
function cellWidths(b64: string): number[] {
  const raw = decode(b64);
  const widths: number[] = [];
  let cur = 0;
  let scale = 1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\x1b") {
      const cmd = raw[i + 1];
      if (cmd === "!") { scale = (raw.charCodeAt(i + 2) & 0x20) ? 2 : 1; i += 2; continue; }
      if (cmd === "a" || cmd === "E") { i += 2; continue; }
      if (cmd === "@") { scale = 1; i += 1; continue; }
    }
    if (c === "\x1d" && raw[i + 1] === "V") { i += 2; continue; } // GS V n — cut
    if (c === "\n") { widths.push(cur); cur = 0; continue; }
    cur += scale;
  }
  if (cur > 0) { widths.push(cur); }
  return widths;
}

/**
 * THE NUMBER OFF THE PAPER, IN PAISA. Read back out of the printed characters
 * rather than off the part object — that round trip is the whole point of this
 * file, because the paper is the only place a second rounding could hide.
 */
function printedGrandTotalPaisa(b64: string): number {
  const match = /^Grand Total: +Rs ([0-9]+\.[0-9]{2})$/m.exec(printed(b64));
  if (!match) { throw new Error(`no Grand Total line on this receipt:\n${printed(b64)}`); }
  return toPaisa(Number(match[1]));
}

/** How many documents came off the roll — one full cut terminates each. */
const cuts = (b64: string) => decode(b64).split("\x1dV\x00").length - 1;

const GST = [
  { name: "CGST", percentage: 2.5 },
  { name: "SGST", percentage: 2.5 },
];

function line(section: string, name: string, price: number, quantity = 1, extra: Partial<SectionSplitLine> = {}): SectionSplitLine {
  return { section_key: section.toLowerCase(), section_label: section, name, price, quantity, ...extra };
}

/**
 * A real table: three menu sections, a coupon, a 10% service charge and two GST
 * lines. The subtotal (1,833.00) is deliberately NOT divisible three ways, so
 * every rung of the ladder is allocated with a remainder and a renderer that
 * rounded on its own would be caught by the very first sum in this file.
 */
const LINES: SectionSplitLine[] = [
  line("Starters", "Paneer Tikka", 320, 1),
  line("Starters", "Papad", 61, 1),
  line("Mains", "Dal Makhani", 380, 2),
  line("Bar", "Old Monk", 231, 1),
  line("Bar", "Beer", 461, 1),
];
const SUBTOTAL = 1833;
const CHARGES = computeBillCharges(SUBTOTAL, GST, 10, true, { type: "percent", value: 7 });
const SPLIT = computeSectionSplit({ ...CHARGES }, LINES);

/** The bill this table prints today, before anybody asks for a split. */
const WHOLE: ReceiptOptions = {
  restaurantName: "Gaia",
  legalName: "NAVKRISH HOSPITALITY LLP",
  address: "12 Main St",
  gstin: "29AAXFN2701Q1ZF",
  table: "12",
  covers: 4,
  customer: "Alice",
  billNo: "5910",
  cashier: "JIM",
  kotNumbers: [214, 218],
  items: LINES.map((l) => ({ name: l.name, price: l.price, quantity: l.quantity })),
  total: CHARGES.subtotal,
  currency: "₹",
  discount: { amount: CHARGES.discount, label: "Coupon SAVE7" },
  serviceCharge: { percent: CHARGES.service_charge_percent, amount: CHARGES.service_charge },
  taxes: CHARGES.taxes,
  grandTotal: CHARGES.grand_total,
  serviceChargeNote: "A Voluntary Service Charge is included to support our staff.",
};

describe("buildSplitReceiptsBase64 — one document per part", () => {
  test("N parts produce N receipts", () => {
    const out = buildSplitReceiptsBase64(WHOLE, SPLIT.parts);
    expect(SPLIT.parts).toHaveLength(3);
    expect(out).toHaveLength(SPLIT.parts.length);
  });

  test("each receipt is a standalone, cut-terminated bill", () => {
    // One cut per slip, not one cut for the batch: two slips on an uncut run of
    // paper are handed across the table as a single bill.
    for (const receipt of buildSplitReceiptsBase64(WHOLE, SPLIT.parts)) {
      expect(cuts(receipt.escBase64)).toBe(1);
      expect(printed(receipt.escBase64)).toContain("Grand Total:");
    }
  });

  test("each part carries its own ladder, not the whole bill's", () => {
    const out = buildSplitReceiptsBase64(WHOLE, SPLIT.parts);
    out.forEach((receipt, i) => {
      const part = SPLIT.parts[i]!;
      const page = printed(receipt.escBase64);
      expect(page).toMatch(new RegExp(`^Subtotal +${part.subtotal.toFixed(2)}$`, "m"));
      expect(page).toMatch(new RegExp(`^Service Charge \\(10%\\) +${part.service_charge.toFixed(2)}$`, "m"));
      for (const tax of part.taxes) {
        expect(page).toMatch(new RegExp(`^${tax.name} \\(2.5%\\) +${tax.amount.toFixed(2)}$`, "m"));
      }
    });
  });

  test("the caller gets back the identity it needs to route each slip", () => {
    const out = buildSplitReceiptsBase64(WHOLE, SPLIT.parts);
    expect(out.map((r) => r.index)).toEqual([1, 2, 3]);
    expect(out.every((r) => r.of === 3)).toBe(true);
    expect(out.map((r) => r.label)).toEqual(SPLIT.parts.map((p) => p.label));
    expect(out.map((r) => r.key)).toEqual(SPLIT.parts.map((p) => p.key));
    // The total is ECHOED, never recomputed — a caller logging this figure and a
    // guest reading the paper must be looking at the same number.
    for (const receipt of out) {
      expect(toPaisa(receipt.grandTotal)).toBe(printedGrandTotalPaisa(receipt.escBase64));
    }
  });
});

describe("buildSplitReceiptsBase64 — the printed money", () => {
  test("the parts' PRINTED grand totals sum to the whole bill's, to the paisa", () => {
    const whole = printedGrandTotalPaisa(buildReceiptBase64(WHOLE));
    const parts = buildSplitReceiptsBase64(WHOLE, SPLIT.parts)
      .map((r) => printedGrandTotalPaisa(r.escBase64))
      .reduce((s, x) => s + x, 0);
    expect(parts).toBe(whole);
    expect(parts).toBe(toPaisa(CHARGES.grand_total));
  });

  test("no part invents its own rounding — it prints the allocator's number", () => {
    const out = buildSplitReceiptsBase64(WHOLE, SPLIT.parts);
    out.forEach((receipt, i) => {
      expect(printedGrandTotalPaisa(receipt.escBase64)).toBe(toPaisa(SPLIT.parts[i]!.grand_total));
    });
    // The guard is only worth anything if a part's total is NOT a whole rupee:
    // the legacy branch of buildReceiptBase64 whole-rupee-rounds, and against a
    // fixture that happened to land on round numbers this suite would pass while
    // the guest was being overcharged.
    expect(out.some((r) => printedGrandTotalPaisa(r.escBase64) % 100 !== 0)).toBe(true);
  });

  test("a part never prints a round-off it made up", () => {
    // Every part of a ladder that reconciles has round_off 0, and the supplied-
    // total rule leaves nothing to disclose. A "Round off" line on one of these
    // slips would mean the renderer had gone back to deriving.
    for (const part of SPLIT.parts) { expect(toPaisa(part.round_off)).toBe(0); }
    for (const receipt of buildSplitReceiptsBase64(WHOLE, SPLIT.parts)) {
      expect(printed(receipt.escBase64)).not.toContain("Round off");
    }
  });

  test("a round-off the billing layer DID allocate is disclosed on the slip", () => {
    // A ladder handed in that does not add up (a grand total one rupee above its
    // own rungs) is apportioned as a visible round_off rather than quietly lost
    // — and a part that swallowed its share would be a slip whose printed lines
    // do not reach its own printed total.
    const skewed = computeSectionSplit({ ...CHARGES, grand_total: CHARGES.grand_total + 1 }, LINES);
    const out = buildSplitReceiptsBase64(WHOLE, skewed.parts);
    const disclosed = out
      .map((r) => /^Round off +([+-]?[0-9]+\.[0-9]{2})$/m.exec(printed(r.escBase64)))
      .filter((m): m is RegExpExecArray => m !== null)
      .reduce((s, m) => s + toPaisa(Number(m[1])), 0);
    expect(disclosed).toBe(100);
    // And the slips still sum to the (skewed) bill, which is the point.
    expect(out.map((r) => printedGrandTotalPaisa(r.escBase64)).reduce((s, x) => s + x, 0))
      .toBe(toPaisa(CHARGES.grand_total + 1));
  });

  test("every rung a slip prints adds up to the total it prints", () => {
    // The ROW invariant, read off the paper. A part IS a bill in miniature and
    // the guest handed one can check it with the calculator on their phone.
    for (const receipt of buildSplitReceiptsBase64(WHOLE, SPLIT.parts)) {
      const page = printed(receipt.escBase64);
      const read = (re: RegExp) => { const m = re.exec(page); return m ? toPaisa(Number(m[1])) : 0; };
      const subtotal = read(/^Subtotal +([0-9]+\.[0-9]{2})$/m);
      const discount = read(/^Coupon SAVE7 +- ([0-9]+\.[0-9]{2})$/m);
      const service = read(/^Service Charge \(10%\) +([0-9]+\.[0-9]{2})$/m);
      const taxes = [...page.matchAll(/^[CS]GST \(2\.5%\) +([0-9]+\.[0-9]{2})$/gm)]
        .reduce((s, m) => s + toPaisa(Number(m[1])), 0);
      expect(subtotal - discount + service + taxes).toBe(printedGrandTotalPaisa(receipt.escBase64));
    }
  });
});

describe("buildSplitReceiptsBase64 — telling two slips apart", () => {
  test("each slip says which part it is, of how many, and which table", () => {
    const out = buildSplitReceiptsBase64(WHOLE, SPLIT.parts);
    out.forEach((receipt, i) => {
      const page = printed(receipt.escBase64);
      expect(page).toContain(`** PART ${i + 1}/3 **`);
      expect(page).toContain(`${SPLIT.parts[i]!.label} - Table 12`);
    });
  });

  test("the part banner is the biggest type on the slip, above the meta block", () => {
    const first = buildSplitReceiptsBase64(WHOLE, SPLIT.parts)[0]!.escBase64;
    // ESC E 1 (bold) + ESC ! 0x38 (double width AND height, with the bold bit
    // so `ESC !` does not switch emphasis back off) — the same treatment the
    // CANCELLED and REPRINT banners get, and for the same reason.
    expect(decode(first)).toContain("\x1bE\x01\x1b!8** PART 1/3 **\n\x1b!\x00\x1bE\x00");
    const page = printed(first);
    expect(page.indexOf("** PART 1/3 **")).toBeLessThan(page.indexOf("Customer Name:"));
  });

  test("two slips of one bill differ in the banner and the money, nowhere else", () => {
    const [first, second] = buildSplitReceiptsBase64(WHOLE, SPLIT.parts);
    // Same bill: the identity block is shared, which is exactly why the banner
    // has to be the thing that tells them apart.
    for (const shared of ["Bill No.: 5910", "Cashier: JIM", "Token No.: 214, 218", "GSTN : 29AAXFN2701Q1ZF"]) {
      expect(printed(first!.escBase64)).toContain(shared);
      expect(printed(second!.escBase64)).toContain(shared);
    }
    expect(printed(first!.escBase64)).not.toBe(printed(second!.escBase64));
  });

  test("an unlabelled part still says which table it belongs to", () => {
    const out = buildSplitReceiptsBase64(WHOLE, [
      { label: "  ", subtotal: 100, grand_total: 100, items: [{ name: "Tea", price: 100, quantity: 1 }] },
      { label: null, subtotal: 100, grand_total: 100, items: [{ name: "Cake", price: 100, quantity: 1 }] },
    ]);
    for (const receipt of out) {
      expect(printed(receipt.escBase64)).toContain("Table 12");
      expect(printed(receipt.escBase64)).not.toContain(" - Table 12");
    }
  });

  test("the banner survives double width on 58mm paper, and so does a 12-way split", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      key: `s${i}`, label: `Section ${i + 1}`, subtotal: 100, grand_total: 100,
      items: [{ name: "Tea", price: 100, quantity: 1 }],
    }));
    for (const cols of [32, 48]) {
      for (const receipt of buildSplitReceiptsBase64(WHOLE, many, cols)) {
        for (const w of cellWidths(receipt.escBase64)) { expect(w).toBeLessThanOrEqual(cols); }
      }
    }
    expect(printed(buildSplitReceiptsBase64(WHOLE, many, 32)[9]!.escBase64)).toContain("** PART 10/12 **");
  });

  test("every line of every slip fits the roll it is printed on", () => {
    for (const cols of [32, 48]) {
      for (const receipt of buildSplitReceiptsBase64(WHOLE, SPLIT.parts, cols)) {
        for (const w of cellWidths(receipt.escBase64)) { expect(w).toBeLessThanOrEqual(cols); }
      }
    }
  });
});

describe("buildSplitReceiptsBase64 — the one-part compat pin", () => {
  /**
   * A TABLE WHOSE WHOLE BILL IS ONE SECTION IS NOT SPLIT, AND MUST NOT PRINT AS
   * IF IT WERE. It is the commonest case there is — a bar tab, a table that only
   * ordered mains — and it is also the assertion that keeps every tenant who
   * never touches this feature on byte-identical paper.
   */
  const single = computeSectionSplit(
    { ...CHARGES },
    LINES.map((l) => ({ ...l, section_key: "all", section_label: "All" })),
  );

  test("the split has exactly one part, and it is the whole bill", () => {
    expect(single.parts).toHaveLength(1);
    expect(toPaisa(single.parts[0]!.grand_total)).toBe(toPaisa(CHARGES.grand_total));
  });

  test("a one-part split renders the bill that table prints today, byte for byte", () => {
    const part = single.parts[0]!;
    const out = buildSplitReceiptsBase64({ ...WHOLE, items: part.items }, [part]);
    expect(out).toHaveLength(1);
    expect(out[0]!.escBase64).toBe(buildReceiptBase64({ ...WHOLE, items: part.items }));
  });

  test("a one-part slip carries no part banner", () => {
    const page = printed(buildSplitReceiptsBase64(WHOLE, [single.parts[0]!])[0]!.escBase64);
    expect(page).not.toContain("PART 1/1");
    expect(page).not.toContain("** PART");
  });

  test("no parts at all still prints the whole bill", () => {
    // Losing the paper loses the table: a bug upstream must cost a banner, not a
    // bill. Mirrors buildKotBase64's empty-ticket fallback.
    const out = buildSplitReceiptsBase64(WHOLE, []);
    expect(out).toHaveLength(1);
    expect(out[0]!.escBase64).toBe(buildReceiptBase64(WHOLE));
  });

  test("a bill printed without a split is untouched by any of this", () => {
    // The new fields are absent on every ordinary bill, and absent has to mean
    // "exactly what this renderer printed before they existed".
    const clean = buildReceiptBase64(WHOLE);
    expect(buildReceiptBase64({ ...WHOLE, splitPart: null, roundOff: null })).toBe(clean);
    expect(buildReceiptBase64({ ...WHOLE, splitPart: undefined, roundOff: undefined })).toBe(clean);
    expect(buildReceiptBase64({ ...WHOLE, roundOff: 0 })).toBe(clean);
  });
});

describe("buildSplitReceiptsBase64 — a comped dish", () => {
  /**
   * A non-chargeable weighs NOTHING (see computeSectionSplit's header): it drags
   * no money out of the sections that were paid for. But the food went to a
   * section and somebody ate it, so it is still listed on that section's slip —
   * a comped dish that vanished off the paper is a dish nobody can account for
   * at the end of service.
   */
  const WITH_NC: SectionSplitLine[] = [
    ...LINES,
    line("Mains", "Birthday Cake", 450, 1, { nc: true, nc_kind: "comp" }),
  ];
  const ncSplit = computeSectionSplit({ ...CHARGES }, WITH_NC);
  const ncOpts: ReceiptOptions = {
    ...WHOLE,
    items: WITH_NC.map((l) => ({ name: l.name, price: l.price, quantity: l.quantity })),
  };

  test("the comped dish appears on its own section's slip and on no other", () => {
    const out = buildSplitReceiptsBase64(ncOpts, ncSplit.parts);
    const carrying = out.filter((r) => printed(r.escBase64).includes("Birthday Cake"));
    expect(carrying).toHaveLength(1);
    expect(carrying[0]!.label).toBe("Mains");
  });

  test("the comped dish is charged to nobody", () => {
    // Identical fixture, identical bill, the comped line simply not there: every
    // part's printed total must be the SAME number. A comped dish that moved one
    // paisa moved it out of somebody's pocket.
    const withNc = buildSplitReceiptsBase64(ncOpts, ncSplit.parts).map((r) => printedGrandTotalPaisa(r.escBase64));
    const without = buildSplitReceiptsBase64(WHOLE, SPLIT.parts).map((r) => printedGrandTotalPaisa(r.escBase64));
    expect(withNc).toEqual(without);
    expect(withNc.reduce((s, x) => s + x, 0)).toBe(toPaisa(CHARGES.grand_total));
  });

  test("a fully comped section prints a slip that owes nothing", () => {
    const freebies = computeSectionSplit({ ...CHARGES }, [
      ...LINES,
      line("Desserts", "Birthday Cake", 450, 1, { nc: true, nc_kind: "comp" }),
    ]);
    const part = freebies.parts.find((p) => p.label === "Desserts")!;
    const receipt = buildSplitReceiptsBase64(WHOLE, freebies.parts).find((r) => r.label === "Desserts")!;
    expect(toPaisa(part.grand_total)).toBe(0);
    expect(printedGrandTotalPaisa(receipt.escBase64)).toBe(0);
    // Nothing was charged, so nothing on the slip claims it was: no discount
    // line, no service charge line, no tax lines.
    const page = printed(receipt.escBase64);
    expect(page).not.toContain("Service Charge");
    expect(page).not.toContain("CGST");
  });
});

describe("buildSplitReceiptsBase64 — the service charge on a part", () => {
  test("a waived charge stays waived, and says so, on every part", () => {
    const waived = computeBillCharges(SUBTOTAL, GST, 10, false, { type: "percent", value: 7 });
    const split = computeSectionSplit({ ...waived }, LINES);
    const out = buildSplitReceiptsBase64({
      ...WHOLE,
      total: waived.subtotal,
      discount: { amount: waived.discount, label: "Coupon SAVE7" },
      // What routes/bills.ts hands the renderer for a waived bill: the tenant's
      // configured percentage, nothing charged, and the word on the paper.
      serviceCharge: { percent: 10, amount: 0, optedOut: true },
      taxes: waived.taxes,
      grandTotal: waived.grand_total,
    }, split.parts);
    for (const receipt of out) {
      expect(printed(receipt.escBase64)).toMatch(/^Service Charge \(10%\) +Opted-out$/m);
    }
    expect(out.map((r) => printedGrandTotalPaisa(r.escBase64)).reduce((s, x) => s + x, 0))
      .toBe(toPaisa(waived.grand_total));
  });

  test("a part carrying no service charge does not carry the disclaimer either", () => {
    // "A Voluntary Service Charge is included" on a slip that includes none is a
    // false statement on a tax document, and it invites the guest holding it to
    // ask for the removal of something they were never charged.
    const noCharge = { label: "Bar", subtotal: 100, grand_total: 100, items: [{ name: "Soda", price: 100, quantity: 1 }] };
    const charged = { label: "Mains", subtotal: 100, service_charge: 10, grand_total: 110, items: [{ name: "Dal", price: 100, quantity: 1 }] };
    const out = buildSplitReceiptsBase64(WHOLE, [charged, noCharge]);
    expect(printed(out[0]!.escBase64)).toContain("A Voluntary Service Charge is included");
    expect(printed(out[1]!.escBase64)).not.toContain("A Voluntary Service Charge is included");
  });

  test("a part allocated none of a bill-wide discount prints no discount line", () => {
    // "- 0.00" is a statement that money came off, and none did.
    const out = buildSplitReceiptsBase64(WHOLE, [
      { label: "Bar", subtotal: 100, discount: 0, grand_total: 100, items: [{ name: "Soda", price: 100, quantity: 1 }] },
    ]);
    expect(printed(out[0]!.escBase64)).not.toContain("Coupon SAVE7");
  });
});
