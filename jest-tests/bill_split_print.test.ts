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
  computeBillSplit,
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

/** Printer dots per Font A cell: 576 dots / 48 cells on the 80mm roll. */
const DOTS_PER_CELL = 12;

/**
 * A GS v 0 raster, named by what it draws. The bill's rules are a raster whose
 * every row is either blank or inked edge to edge — two inked rows for a thin
 * rule, four for the thick one around the item table. Anything else (the logo)
 * is just an image.
 */
function rasterMarker(body: Buffer, widthBytes: number, height: number): string {
  let ink = 0;
  let inkEnded = false;
  for (let y = 0; y < height; y++) {
    const row = body.subarray(y * widthBytes, (y + 1) * widthBytes);
    if (row.every((b) => b === 0x00)) { if (ink > 0) { inkEnded = true; } continue; }
    // A solid row: every byte full, bar a last byte that keeps only its leading
    // bits when the stroke's width is not a whole number of bytes.
    const solid = row.subarray(0, widthBytes - 1).every((b) => b === 0xff) && row[widthBytes - 1] !== 0x00;
    if (!solid || inkEnded) { return "<IMAGE>"; }
    ink++;
  }
  return ink === 2 ? "<RULE>" : ink === 4 ? "<RULE:THICK>" : "<IMAGE>";
}

interface Paper {
  /** The slip as the paper reads: text, with each raster standing as one marker line. */
  text: string;
  /** Each printed line's width in CELLS — a double-width run eats two each, a raster its dot width. */
  cells: number[];
  /** GS L — the left margin the slip set, in dots; 0 when it set none. */
  leftDots: number;
  /** GS W — the print area the slip set, in dots; null when it set none. */
  areaDots: number | null;
}

/**
 * The receipt as the PAPER shows it, walked command by command.
 *
 * The ESC/POS mode bytes are interleaved with the text, so a naive substring
 * match misses "Grand Total" (which is prefixed by ESC E 1 and ESC ! 0x18) and
 * a naive length read comes out several characters long. And the bill's rules
 * are GS v 0 rasters now, whose header carries a height byte of 0x0a — the same
 * byte as "\n" — so a latin1 decode split on newlines breaks a line inside every
 * thin rule. A raster is therefore skipped by the length its own header states
 * (8 + widthBytes x height), never by pattern, and replaced by a marker line.
 */
function paper(b64: string): Paper {
  const buf = Buffer.from(b64, "base64");
  let text = "";
  const cells: number[] = [];
  let cur = 0;
  let scale = 1;
  let leftDots = 0;
  let areaDots: number | null = null;
  const u16 = (at: number) => buf[at]! | (buf[at + 1]! << 8);
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    const cmd = buf[i + 1];
    if (b === 0x1b) {
      if (cmd === 0x40) { scale = 1; i += 1; continue; }                              // ESC @    initialize
      if (cmd === 0x21) { scale = (buf[i + 2]! & 0x20) ? 2 : 1; i += 2; continue; }   // ESC ! n  mode
      if (cmd === 0x61 || cmd === 0x45) { i += 2; continue; }                         // ESC a/E n  align / bold
    }
    if (b === 0x1d) {
      if (cmd === 0x56) { i += 2; continue; }                                         // GS V n   cut
      if (cmd === 0x4c) { leftDots = u16(i + 2); i += 3; continue; }                  // GS L nL nH  left margin
      if (cmd === 0x57) { areaDots = u16(i + 2); i += 3; continue; }                  // GS W nL nH  print area
      if (cmd === 0x76 && buf[i + 2] === 0x30) {                                      // GS v 0 m xL xH yL yH d...
        const widthBytes = u16(i + 4);
        const height = u16(i + 6);
        const body = buf.subarray(i + 8, i + 8 + widthBytes * height);
        if (cur > 0) { text += "\n"; cells.push(cur); cur = 0; }
        text += `${rasterMarker(body, widthBytes, height)}\n`;
        cells.push(Math.ceil((widthBytes * 8) / DOTS_PER_CELL));
        i += 7 + widthBytes * height;
        continue;
      }
    }
    if (b === 0x0a) { text += "\n"; cells.push(cur); cur = 0; continue; }
    text += String.fromCharCode(b);
    cur += scale;
  }
  if (cur > 0) { cells.push(cur); }
  return { text, cells, leftDots, areaDots };
}

const printed = (b64: string): string => paper(b64).text;

/** Printed width in CELLS, not characters — a doubled banner eats two each. */
const cellWidths = (b64: string): number[] => paper(b64).cells;

/**
 * WHERE ON THE ROLL THE SLIP PUTS ITS TEXT, in cells, read off the commands the
 * slip itself sent: the left margin (GS L) and the columns a line may occupy
 * there — the print area (GS W) where one is set, and never more than the roll
 * has left to the right of the margin.
 */
function textArea(b64: string, rollCols: number): { left: number; cols: number } {
  const { leftDots, areaDots } = paper(b64);
  const rollDots = rollCols * DOTS_PER_CELL;
  const area = Math.min(areaDots ?? rollDots, rollDots - leftDots);
  return { left: leftDots / DOTS_PER_CELL, cols: Math.floor(area / DOTS_PER_CELL) };
}

/**
 * The text area each roll's bill is laid out in: 80mm keeps two cells of white
 * either side (48 - 2 - 2 = 44), 58mm keeps none — every one of its 32 cells is
 * already spoken for by the item table.
 */
const BILL_AREA: Record<number, { left: number; cols: number }> = {
  48: { left: 2, cols: 44 },
  32: { left: 0, cols: 32 },
};

/** A totals-ladder row: label and figure right-aligned into the Amount column. */
const rung = (label: string, figure: string) => new RegExp(`^ *${label} +${figure}$`, "m");

/**
 * THE NUMBER OFF THE PAPER, IN PAISA. Read back out of the printed characters
 * rather than off the part object — that round trip is the whole point of this
 * file, because the paper is the only place a second rounding could hide.
 *
 * Exactly one line of the slip may mention the grand total, and it must be the
 * whole "Grand Total  Rs 1234.56" row: a second total, or a figure with anything
 * stuck to it, is a slip a guest could pay the wrong number off.
 */
function printedGrandTotalPaisa(b64: string): number {
  const page = printed(b64);
  const rows = page.split("\n").filter((l) => l.includes("Grand Total"));
  const match = rows.length === 1 ? /^ *Grand Total +Rs ([0-9]+\.[0-9]{2})$/.exec(rows[0]!) : null;
  if (!match) { throw new Error(`expected exactly one whole Grand Total line on this receipt:\n${page}`); }
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
/**
 * The same bill as a ladder that was NEVER rounded to the rupee — a total built
 * before migration 048, or by hand. Its parts are apportioned by weight and land
 * on paise, which is what the "no part invents its own rounding" guards need:
 * against whole-rupee parts, a renderer that whole-rupee-rounded on its own
 * would pass them without ever being tested.
 */
const UNROUNDED = { ...CHARGES, grand_total: CHARGES.pre_round_total };
const SPLIT_UNROUNDED = computeSectionSplit(UNROUNDED, LINES);

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
  // What /print/bill hands the renderer since migration 048.
  roundOff: CHARGES.round_off,
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
      expect(printed(receipt.escBase64)).toMatch(rung("Grand Total", "Rs [0-9]+\\.[0-9]{2}"));
    }
  });

  test("each part carries its own ladder, not the whole bill's", () => {
    const out = buildSplitReceiptsBase64(WHOLE, SPLIT.parts);
    out.forEach((receipt, i) => {
      const part = SPLIT.parts[i]!;
      const page = printed(receipt.escBase64);
      // The client's first rung: the part's own unit count and its own subtotal,
      // on one row.
      expect(page).toMatch(rung(`Total Qty: ${part.qty} +Sub Total`, part.subtotal.toFixed(2)));
      expect(page).toMatch(rung("Service Charge 10%", part.service_charge.toFixed(2)));
      for (const tax of part.taxes) {
        expect(page).toMatch(rung(`${tax.name} 2\\.5%`, tax.amount.toFixed(2)));
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
    const unrounded = { ...WHOLE, grandTotal: UNROUNDED.grand_total, roundOff: null };
    const out = buildSplitReceiptsBase64(unrounded, SPLIT_UNROUNDED.parts);
    out.forEach((receipt, i) => {
      expect(printedGrandTotalPaisa(receipt.escBase64)).toBe(toPaisa(SPLIT_UNROUNDED.parts[i]!.grand_total));
    });
    // The guard is only worth anything if a part's total is NOT a whole rupee:
    // the legacy branch of buildReceiptBase64 whole-rupee-rounds, and against a
    // fixture that happened to land on round numbers this suite would pass while
    // the guest was being overcharged. Hence the unrounded ladder.
    expect(out.some((r) => printedGrandTotalPaisa(r.escBase64) % 100 !== 0)).toBe(true);
  });

  test("a part never prints a round-off it made up", () => {
    // Every part of a ladder that reconciles and was never rounded has
    // round_off 0, and the supplied-total rule leaves nothing to disclose. A
    // "Round off" line on one of these slips would mean the renderer had gone
    // back to deriving.
    for (const part of SPLIT_UNROUNDED.parts) { expect(toPaisa(part.round_off)).toBe(0); }
    const unrounded = { ...WHOLE, grandTotal: UNROUNDED.grand_total, roundOff: null };
    for (const receipt of buildSplitReceiptsBase64(unrounded, SPLIT_UNROUNDED.parts)) {
      expect(printed(receipt.escBase64)).not.toContain("Round off");
    }
  });

  test("on a whole-rupee bill every slip is whole rupees, and discloses the round-off that made it so", () => {
    // Migration 048: the bill is rupee-rounded, so its parts are too. Each slip
    // prints its OWN round-off — the allocator's number, never the renderer's —
    // and those lines add up to the bill's own "Round off".
    const out = buildSplitReceiptsBase64(WHOLE, SPLIT.parts);
    let disclosed = 0;
    out.forEach((receipt, i) => {
      const part = SPLIT.parts[i]!;
      const page = printed(receipt.escBase64);
      expect(printedGrandTotalPaisa(receipt.escBase64) % 100).toBe(0);
      expect(printedGrandTotalPaisa(receipt.escBase64)).toBe(toPaisa(part.grand_total));
      const m = rung("Round off", "([+-]?[0-9]+\\.[0-9]{2})").exec(page);
      if (toPaisa(part.round_off) === 0) {
        expect(m).toBeNull();
      } else {
        expect(m).not.toBeNull();
        expect(toPaisa(Number(m![1]))).toBe(toPaisa(part.round_off));
        disclosed += toPaisa(Number(m![1]));
      }
    });
    expect(disclosed).toBe(toPaisa(CHARGES.round_off));
  });

  test("a round-off the billing layer DID allocate is disclosed on the slip", () => {
    // A ladder handed in that does not add up (a grand total one rupee above its
    // own rungs, and not whole rupees) is apportioned as a visible round_off
    // rather than quietly lost — and a part that swallowed its share would be a
    // slip whose printed lines do not reach its own printed total.
    const skewed = computeSectionSplit({ ...UNROUNDED, grand_total: UNROUNDED.grand_total + 1 }, LINES);
    const out = buildSplitReceiptsBase64(WHOLE, skewed.parts);
    const disclosed = out
      .map((r) => rung("Round off", "([+-]?[0-9]+\\.[0-9]{2})").exec(printed(r.escBase64)))
      .filter((m): m is RegExpExecArray => m !== null)
      .reduce((s, m) => s + toPaisa(Number(m[1])), 0);
    expect(disclosed).toBe(100);
    // And the slips still sum to the (skewed) bill, which is the point.
    expect(out.map((r) => printedGrandTotalPaisa(r.escBase64)).reduce((s, x) => s + x, 0))
      .toBe(toPaisa(UNROUNDED.grand_total + 1));
  });

  test("every rung a slip prints adds up to the total it prints", () => {
    // The ROW invariant, read off the paper. A part IS a bill in miniature and
    // the guest handed one can check it with the calculator on their phone.
    for (const receipt of buildSplitReceiptsBase64(WHOLE, SPLIT.parts)) {
      const page = printed(receipt.escBase64);
      const FIGURE = "([0-9]+\\.[0-9]{2})";
      const read = (re: RegExp) => { const m = re.exec(page); return m ? toPaisa(Number(m[1])) : 0; };
      // The subtotal shares its row with the unit count; on a roll too narrow
      // for both it stands on its own row under it.
      const subtotal = read(rung("(?:Total Qty: [0-9]+ +)?Sub Total", FIGURE));
      const discount = read(rung("Coupon SAVE7", `-${FIGURE}`));
      const service = read(rung("Service Charge 10%", FIGURE));
      const taxes = [...page.matchAll(new RegExp(`^ *[CS]GST 2\\.5% +${FIGURE}$`, "gm"))]
        .reduce((s, m) => s + toPaisa(Number(m[1])), 0);
      // Signed, and absent on a part that needed none (migration 048).
      const roundOff = read(rung("Round off", "([+-]?[0-9]+\\.[0-9]{2})"));
      // Every rung this fixture charges is on every slip — a rung the reader
      // silently failed to find would otherwise read as zero.
      expect(subtotal).toBeGreaterThan(0);
      expect(discount).toBeGreaterThan(0);
      expect(service).toBeGreaterThan(0);
      expect(taxes).toBeGreaterThan(0);
      expect(subtotal - discount + service + taxes + roundOff).toBe(printedGrandTotalPaisa(receipt.escBase64));
    }
  });
});

describe("buildSplitReceiptsBase64 — the EVEN split, the one both clients print", () => {
  /** Exactly the mapping /print/bill/split's even branch makes from computeBillSplit. */
  const evenParts = (grand: number, n: number) => computeBillSplit(grand, "even", { parts: n }).parts
    .map((pt) => ({ label: pt.label, subtotal: pt.subtotal, grand_total: pt.total, items: [] }));
  // The client's receipt: 4745 + SGST 118.63 + CGST 118.63 = 4982.26, rounded to 4982.00.
  const GAIA: ReceiptOptions = {
    ...WHOLE, serviceCharge: null, discount: null, serviceChargeNote: null,
    taxes: [{ name: "SGST", percentage: 2.5, amount: 118.63 }, { name: "CGST", percentage: 2.5, amount: 118.63 }],
    total: 4745, grandTotal: 4982, roundOff: -0.26,
  };

  test("a whole-rupee bill three ways prints whole-rupee slips that sum to the bill", () => {
    // Floored to the paisa these were 1660.66 / 1660.66 / 1660.68: a rounded bill
    // handed back to its guests in paise.
    const out = buildSplitReceiptsBase64(GAIA, evenParts(4982, 3));
    const totals = out.map((r) => printedGrandTotalPaisa(r.escBase64));
    expect(totals).toEqual([166100, 166100, 166000]);
    expect(totals.reduce((s, x) => s + x, 0)).toBe(toPaisa(4982));
  });

  test("an even slip prints one figure twice and nothing between: no Round off, no tax, no charge", () => {
    for (const r of buildSplitReceiptsBase64(GAIA, evenParts(4982, 3))) {
      const page = printed(r.escBase64);
      expect(page).not.toContain("Round off");
      expect(page).not.toMatch(/[CS]GST [0-9]/);
      expect(page).not.toContain("Service Charge");
      const sub = /Sub Total +([0-9]+\.[0-9]{2})$/m.exec(page);
      expect(sub).not.toBeNull();
      expect(toPaisa(Number(sub![1]))).toBe(printedGrandTotalPaisa(r.escBase64));
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
    const nameSlot = page.search(/^Name: Alice$/m);
    expect(nameSlot).toBeGreaterThan(-1);
    expect(page.indexOf("** PART 1/3 **")).toBeLessThan(nameSlot);
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
        // Measured against the text area the slip actually has — inside its
        // margins on 80mm — not against the bare roll.
        const area = textArea(receipt.escBase64, cols);
        expect(area).toEqual(BILL_AREA[cols]);
        for (const w of cellWidths(receipt.escBase64)) { expect(w).toBeLessThanOrEqual(area.cols); }
      }
    }
    expect(printed(buildSplitReceiptsBase64(WHOLE, many, 32)[9]!.escBase64)).toContain("** PART 10/12 **");
  });

  test("every line of every slip fits the roll it is printed on", () => {
    // On 80mm a line must fit the 44 cells between the margins, not the 48 of
    // the roll: the printer starts it two cells in, and a 48-cell line from there
    // wraps its last four characters — the right-hand end of every money row.
    // The margins are checked to be symmetric so the area cannot quietly slide
    // off the right edge of the paper either.
    for (const cols of [32, 48]) {
      for (const receipt of buildSplitReceiptsBase64(WHOLE, SPLIT.parts, cols)) {
        const area = textArea(receipt.escBase64, cols);
        expect(area).toEqual(BILL_AREA[cols]);
        expect(area.left * 2 + area.cols).toBe(cols);
        for (const w of cellWidths(receipt.escBase64)) { expect(w).toBeLessThanOrEqual(area.cols); }
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
    const beforeRounding: ReceiptOptions = { ...WHOLE, grandTotal: UNROUNDED.grand_total };
    delete beforeRounding.roundOff;
    const clean = buildReceiptBase64(beforeRounding);
    expect(buildReceiptBase64({ ...beforeRounding, splitPart: null, roundOff: null })).toBe(clean);
    expect(buildReceiptBase64({ ...beforeRounding, splitPart: undefined, roundOff: undefined })).toBe(clean);
    expect(buildReceiptBase64({ ...beforeRounding, roundOff: 0 })).toBe(clean);
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
  test("a waived charge prints no service-charge line on any part, and the parts still sum to the bill", () => {
    const waived = computeBillCharges(SUBTOTAL, GST, 10, false, { type: "percent", value: 7 });
    const split = computeSectionSplit({ ...waived }, LINES);
    const out = buildSplitReceiptsBase64({
      ...WHOLE,
      total: waived.subtotal,
      discount: { amount: waived.discount, label: "Coupon SAVE7" },
      // Even handed the percentage with nothing charged, no part prints a line:
      // a removed charge is not shown (the client's decision), on the whole bill
      // or on any slip of it. routes/bills.ts hands the renderer null here.
      serviceCharge: { percent: 10, amount: 0 },
      taxes: waived.taxes,
      roundOff: waived.round_off,
      grandTotal: waived.grand_total,
    }, split.parts);
    for (const receipt of out) {
      const page = printed(receipt.escBase64);
      expect(page).not.toContain("Service Charge");
      expect(page).not.toContain("Opted-out");
      // Nor the disclaimer: nothing on the slip is a charge to contribute to.
      expect(page.replace(/\s+/g, " ")).not.toContain("A Voluntary Service Charge");
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
    // The disclaimer wraps to the text area, so the sentence is read with its
    // line breaks folded back into spaces: wherever the wrap happens to fall, the
    // negative check cannot pass merely because the words landed on two lines.
    const flowed = (b64: string) => printed(b64).replace(/\s+/g, " ");
    expect(flowed(out[0]!.escBase64)).toContain(WHOLE.serviceChargeNote);
    expect(flowed(out[1]!.escBase64)).not.toContain("A Voluntary Service Charge");
  });

  test("a part allocated none of a bill-wide discount prints no discount line", () => {
    // "-0.00" is a statement that money came off, and none did.
    const out = buildSplitReceiptsBase64(WHOLE, [
      { label: "Bar", subtotal: 100, discount: 0, grand_total: 100, items: [{ name: "Soda", price: 100, quantity: 1 }] },
    ]);
    expect(printed(out[0]!.escBase64)).not.toContain("Coupon SAVE7");
  });
});
