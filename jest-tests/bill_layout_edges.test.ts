// THE BILL NEVER CUTS A VALUE TO MAKE A ROW FIT.
//
// The reference-layout bill (escpos.ts) narrowed the 80mm text area to 44
// columns inside its margins, and an adversarial pass over it found every place
// where a real value then came off the paper silently:
//
//   * "Date: 14/09/26 13 Dine In: ZOMATO-5123456789" — twoCol sliced the DATE to
//     fit the table name, so a GST invoice lost its minutes (and, past 19
//     characters, its date).
//   * "Cashier: Venkatesh Ramakris Bill No.: 123456" — the same slice.
//   * "Private Dining          1150000.00 150000.00" — padL never separates, so
//     a figure as wide as its column fused with the one before it and read as
//     a different price.
//   * "Compensation Cess on Aerated Beverag 1234.50" — a long ladder label fell
//     back to twoCol and lost its rate.
//   * "GSTN : 29ABCDE1234F1Z5 / 27ABCDE1234F1Z9 (MH)" ran past the print area.
//   * "Butter Naan 1?2" — asciiSafe lengthens text AFTER it was measured.
//
// Each case is driven through the real renderer on both rolls and read back
// with a stream reader that skips every command by its own length.

import { describe, test, expect } from "@jest/globals";
import { buildReceiptBase64, type ReceiptOptions } from "../escpos";

/** Text lines exactly as printed, one "<RASTER>" per image. Commands skipped by length. */
function printedLines(b64: string): string[] {
  const b = Buffer.from(b64, "base64");
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < b.length;) {
    const c = b[i]!;
    if (c === 0x1b) { i += b[i + 1] === 0x40 ? 2 : 3; continue; }
    if (c === 0x1d) {
      const n = b[i + 1];
      if (n === 0x76) {
        const wb = b[i + 4]! | (b[i + 5]! << 8);
        const h = b[i + 6]! | (b[i + 7]! << 8);
        if (cur) { out.push(cur); cur = ""; }
        out.push("<RASTER>");
        i += 8 + wb * h;
        continue;
      }
      if (n === 0x4c || n === 0x57) { i += 4; continue; }
      if (n === 0x56) { i += 3; continue; }
      if (n === 0x28) { i += 5 + (b[i + 3]! | (b[i + 4]! << 8)); continue; }
      throw new Error(`unexpected GS 0x${n!.toString(16)}`);
    }
    if (c === 0x0a) { out.push(cur); cur = ""; i++; continue; }
    cur += String.fromCharCode(c);
    i++;
  }
  if (cur) { out.push(cur); }
  return out;
}

const ROLLS = [{ cols: 48, W: 44 }, { cols: 32, W: 32 }] as const;

const hard: ReceiptOptions = {
  restaurantName: "Gaia - Global Vegetarian",
  table: "ZOMATO-5123456789",
  covers: 2,
  currency: "₹",
  kind: "bill",
  items: [
    { name: "Private Dining", quantity: 1, price: 150000 },
    { name: "Butter Naan ½", quantity: 2, price: 60 },
    { name: "Chef’s Special…", quantity: 1, price: 450 },
    { name: "Wine", quantity: 1, price: 12000.5 },
    { name: "Wedding Thali", quantity: 100, price: 10000 },
  ],
  total: 1162690.5,
  customer: "Guest",
  billNo: "123456",
  cashier: "Venkatesh Ramakrishnan",
  printedAt: "14/09/26 13:11",
  gstin: "29ABCDE1234F1Z5 / 27ABCDE1234F1Z9 (MH)",
  discount: { amount: 500, label: "Coupon SUPERSAVER2026EXTRA" },
  serviceCharge: { percent: 10, amount: 0, optedOut: true },
  taxes: [
    { name: "Compensation Cess on Aerated Beverages", percentage: 12, amount: 1234.5 },
    { name: "SGST", percentage: 2.5, amount: 118.63 },
  ],
  grandTotal: 1163543.63,
  feedbackUrl: "https://example.test/f?rid=a",
  serviceChargeNote: "A Voluntary Service Charge is included to support our staff. If you prefer not to contribute, please inform your server before payment and it will be removed.",
};

describe("no value is cut, and no line leaves the print area", () => {
  test.each(ROLLS)("every line fits W on the $cols-column roll", ({ cols, W }) => {
    const over = printedLines(buildReceiptBase64(hard, cols)).filter((l) => l !== "<RASTER>" && l.length > W);
    expect(over).toEqual([]);
  });

  test.each(ROLLS)("the date and the table both print whole ($cols cols)", ({ cols }) => {
    const text = printedLines(buildReceiptBase64(hard, cols)).join("\n");
    expect(text).toContain("Date: 14/09/26 13:11");
    expect(text).toContain("Dine In: ZOMATO-5123456789");
  });

  test("a short table still shares the row with the date, as on the client's bill", () => {
    const lines = printedLines(buildReceiptBase64({ ...hard, table: "15" }, 48));
    expect(lines).toContainEqual(expect.stringMatching(/^Date: 14\/09\/26 13:11 +Dine In: 15$/));
  });

  test.each(ROLLS)("the cashier and the bill number both print whole ($cols cols)", ({ cols }) => {
    const text = printedLines(buildReceiptBase64(hard, cols)).join("\n");
    expect(text).toContain("Cashier: Venkatesh Ramakrishnan");
    expect(text).toContain("Bill No.: 123456");
  });

  test.each(ROLLS)("figures never run into each other ($cols cols)", ({ cols }) => {
    const text = printedLines(buildReceiptBase64(hard, cols)).join("\n");
    // Each price and amount is bounded by a space or the line edge.
    for (const figure of ["150000.00", "12000.50", "10000.00", "1000000.00"]) {
      expect(text).toMatch(new RegExp(`(^|[ ])${figure.replace(".", "\\.")}($|[ \\n])`, "m"));
    }
    expect(text).not.toMatch(/\d\.\d\d\d/); // two figures glued: "…00.001000…"
    expect(text).not.toContain("1150000.00");
  });

  test("an ordinary line keeps its columns", () => {
    const lines = printedLines(buildReceiptBase64(hard, 48));
    expect(lines).toContain("Butter Naan 1?2         2    60.00    120.00");
  });

  test.each(ROLLS)("a long tax label wraps and keeps its rate ($cols cols)", ({ cols }) => {
    const lines = printedLines(buildReceiptBase64(hard, cols));
    const at = lines.findIndex((l) => l.trimEnd().endsWith("1234.50"));
    expect(at).toBeGreaterThan(0);
    const label = lines.slice(at - 3, at + 1).map((l) => l.trim()).join(" ");
    expect(label).toContain("Beverages 12% ");
    expect(label).toContain("Compensation Cess");
  });

  test.each(ROLLS)("every ladder label ends on one edge ($cols cols)", ({ cols }) => {
    const lines = printedLines(buildReceiptBase64(hard, cols));
    const ends = ["Sub Total", "Service Charge 10%", "SGST 2.5%", "Grand Total"].map((label) => {
      const row = lines.find((l) => l.includes(label))!;
      return row.indexOf(label) + label.length;
    });
    expect(new Set(ends).size).toBe(1);
  });

  test.each(ROLLS)("a two-state GSTIN wraps whole ($cols cols)", ({ cols }) => {
    const text = printedLines(buildReceiptBase64(hard, cols)).join(" ");
    expect(text).toContain("27ABCDE1234F1Z9 (MH)");
  });
});
