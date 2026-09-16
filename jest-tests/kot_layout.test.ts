/**
 * WHAT IS ON THE KITCHEN DOCKET — asserted against layoutKot, the pure model,
 * not against bytes.
 *
 * These are the docket's content tests, moved here from escpos.test.ts when the
 * reference docket became a raster. The move is the point: "does the ticket say
 * Table No: 33, and is [Hold] the line directly under the dish it holds" is a
 * question about the DOCUMENT, and it stayed answerable only because the
 * renderer was split into a layout model that decides what is on the paper and
 * an encoder that decides how it is drawn. Byte-level questions live in
 * kot_raster.test.ts (the reference docket) and escpos.test.ts (the classic one).
 *
 * The reference docket is the client's own previous till's ticket, transcribed
 * line for line; REFERENCE_ROWS below is that transcription, and it is the one
 * assertion in this file that fails if anything at all moves.
 */
import { describe, test, expect } from "@jest/globals";
import {
  KOT_HOLD_LINE,
  kotProfile,
  layoutKot,
  type KotRow,
  type ReceiptOptions,
} from "../escpos";

const P80 = kotProfile(576);
const P58 = kotProfile(384);

/** The docket behind the client's reference photo. */
const reference: ReceiptOptions = {
  restaurantName: "Gaia - Global Vegetarian",
  table: "33",
  covers: 4,
  currency: "₹",
  total: 0,
  kind: "kot",
  kotNo: 21,
  printedAt: "08/09/26 14:13",
  orderContext: "Running Table",
  serviceMode: "Dine In",
  section: "DOME SECTION",
  assignedTo: "yado",
  captain: "TIYASHA",
  items: [
    { name: "Subz Tehri", quantity: 1, price: 0 },
    { name: "Ghewar Berry Mousse", quantity: 1, price: 0 },
    { name: "Gaia Rose Cookies", quantity: 1, price: 0, note: "Hold Dessert" },
  ],
};

const rows = (opts: Partial<ReceiptOptions> = {}, profile = P80): KotRow[] =>
  layoutKot({ ...reference, ...opts }, profile);

/**
 * One row as a single readable string: alignment, weight and size for a whole
 * line; column and weight per cell for an item row. A `*` marks bold and a `!`
 * a banner, so "is the dish name bold" and "is CANCELLED the big type" are
 * visible in the expected value rather than hidden behind a matcher.
 */
function shape(row: KotRow): string {
  if (row.k === "rule") { return "<RULE>"; }
  if (row.k === "line") {
    return `${row.align === "center" ? "C" : "L"}${row.bold ? "*" : " "}${row.size === "banner" ? "!" : " "} ${row.text}`;
  }
  return row.cells.map((c) => `${c.at}${c.bold ? "*" : ""}=${c.text}`).join("  ");
}
const shapes = (r: KotRow[]) => r.map(shape);
/** Just the words, for a "does the docket mention this at all" question. */
const words = (r: KotRow[]) =>
  r.map((row) => (row.k === "rule" ? "<RULE>" : row.k === "line" ? row.text : row.cells.map((c) => c.text).join(" "))).join("\n");

describe("layoutKot — the client's reference docket, line for line", () => {
  const REFERENCE_ROWS = [
    "C   Running Table",
    "C*  KOT",
    "C   08/09/26 14:13",
    "C   KOT - 21",
    "C*  Dine In: DOME SECTION",
    "C*  Table No: 33",
    "C   Persons - 4",
    "<RULE>",
    "L   Assign to: yado",
    "L   Captain: TIYASHA",
    "<RULE>",
    "num=No.Item  qty=Qty",
    "num=1  name*=Subz Tehri  qty=1",
    "num=2  name*=Ghewar Berry Mousse  qty=1",
    "num=3  name*=Gaia Rose Cookies  qty=1",
    "name=[Note] Hold Dessert",
    "<RULE>",
    "num=Total Qty  qty=3",
    "<RULE>",
  ];

  test("every line, in the reference's order, with the reference's emphasis", () => {
    expect(shapes(rows())).toEqual(REFERENCE_ROWS);
  });

  test("the 58mm roll carries the SAME rows — only the type gets narrower", () => {
    expect(shapes(rows({}, P58))).toEqual(REFERENCE_ROWS);
  });

  test("no restaurant name: the kitchen is standing in it", () => {
    expect(words(rows())).not.toContain("Global Vegetarian");
  });

  test("the quantity is a bare right-hand number — no 'x', no dot leaders", () => {
    const qty = rows().flatMap((r) => (r.k === "cols" ? r.cells.filter((c) => c.at === "qty") : []));
    expect(qty.map((c) => c.text)).toEqual(["Qty", "1", "1", "1", "3"]);
    expect(words(rows())).not.toContain("x1");
    expect(words(rows())).not.toContain("..");
  });

  test("emphasis is WEIGHT, never size: the only non-body row on an ordinary docket is none", () => {
    expect(rows().filter((r) => r.k === "line" && r.size !== "body")).toEqual([]);
  });

  test("the model is pure — the same options lay out the same rows", () => {
    expect(layoutKot(reference, P80)).toEqual(layoutKot(reference, P80));
  });
});

describe("layoutKot — the docket's own identity", () => {
  test("the ticket number line is OMITTED, never faked, when numbering is unavailable", () => {
    for (const kotNo of [null, undefined, 0, Number.NaN]) {
      const out = words(rows({ kotNo: kotNo as number | null }));
      expect(out).toContain("KOT");            // the bold heading survives
      expect(out).not.toContain("KOT - ");     // the number does not
    }
  });

  test("a takeaway ticket announces its channel instead of claiming a running table", () => {
    const out = shapes(rows({ orderContext: "Swiggy", table: "Swiggy-88214", section: null }));
    expect(out[0]).toBe("C   Swiggy");
    expect(out).toContain("C*  Table No: Swiggy-88214");
    expect(out).not.toContain("C   Running Table");
  });

  test("a caller that resolved no stamp still prints a time rather than a blank line", () => {
    const out = rows({ printedAt: null });
    const stamp = out[2];
    expect(stamp?.k).toBe("line");
    expect((stamp as { text: string }).text.length).toBeGreaterThan(0);
  });

  test("with no floor section the service mode stands alone rather than repeating", () => {
    expect(shapes(rows({ section: null }))).toContain("C*  Dine In");
    expect(words(rows({ section: null }))).not.toContain("Dine In: Dine In");
  });

  test("a table with no covers recorded prints no Persons line", () => {
    expect(words(rows({ covers: 0 }))).not.toContain("Persons");
  });

  test("an unassigned table prints neither staff line, and no empty rule", () => {
    const out = shapes(rows({ assignedTo: null, captain: null }));
    expect(out.join("\n")).not.toContain("Assign to");
    expect(out.join("\n")).not.toContain("Captain");
    // One rule closes the header and opens the item table — not two with
    // nothing between them.
    expect(out.filter((l) => l === "<RULE>").length).toBe(3);
  });

  test("a waiter who is not a captain gets one line, not the same name twice", () => {
    const out = words(rows({ captain: null }));
    expect(out).toContain("Assign to: yado");
    expect(out).not.toContain("Captain");
  });

  test("the literal strings 'null' and 'undefined' are treated as unset", () => {
    const out = words(rows({ section: "null", assignedTo: "null", captain: "undefined", orderContext: "null" }));
    expect(out).not.toContain("null");
    expect(out).not.toContain("undefined");
  });
});

describe("layoutKot — the station line", () => {
  test("names the station when the docket really is a per-station split", () => {
    expect(shapes(rows({ station: "Tandoor" }))).toContain("C*  [ TANDOOR ]");
  });

  test("NEVER prints '[ GENERAL ]' — the implicit bucket is not a station", () => {
    for (const station of ["General", "general", "GENERAL"]) {
      expect(words(rows({ station }))).not.toContain("[ GENERAL ]");
    }
  });

  test("no station at all prints no line", () => {
    for (const station of [null, undefined, "  "]) {
      expect(words(rows({ station }))).not.toContain("[ ");
    }
  });

  test("it sits under the ticket id, where a chef looks for which pass this is", () => {
    const out = shapes(rows({ station: "Bar" }));
    expect(out.indexOf("C*  [ BAR ]")).toBe(out.indexOf("C   KOT - 21") + 1);
  });
});

describe("layoutKot — items", () => {
  test("lines are numbered in order and the dish name is the bold cell", () => {
    const item = rows()[13];
    expect(item).toEqual({
      k: "cols",
      cells: [
        { text: "2", at: "num", bold: false },
        { text: "Ghewar Berry Mousse", at: "name", bold: true },
        { text: "1", at: "qty", bold: false },
      ],
    });
  });

  test("the price point sold rides on the dish name, as it does on the bill", () => {
    const out = words(rows({ items: [{ name: "Paneer Tikka", quantity: 2, price: 200, variation: "Half" }] }));
    expect(out).toContain("Paneer Tikka (Half)");
  });

  test("a quantity is normalised the way the classic docket normalises it", () => {
    const out = rows({ items: [
      { name: "A", quantity: 0, price: 0 },
      { name: "B", quantity: 2.4, price: 0 },
      { name: "C", quantity: Number.NaN, price: 0 },
    ] });
    const qty = out.flatMap((r) => (r.k === "cols" ? r.cells.filter((c) => c.at === "qty") : [])).map((c) => c.text);
    expect(qty).toEqual(["Qty", "1", "2", "1", "4"]);
  });

  test("a KOT never carries money — not a price, not a total, not a currency", () => {
    const out = words(rows({ total: 4982, grandTotal: 4982 }));
    expect(out).not.toMatch(/\d+\.\d{2}/);
    expect(out).not.toContain("Rs");
    expect(out).not.toContain("Total:");
    expect(out).not.toContain("Grand");
  });

  test("the item note hangs under its dish, indented to the name column and upright", () => {
    const out = shapes(rows());
    const dish = out.indexOf("num=3  name*=Gaia Rose Cookies  qty=1");
    expect(out[dish + 1]).toBe("name=[Note] Hold Dessert");
  });
});

describe("layoutKot — a hold prints where a note does", () => {
  const held: ReceiptOptions = {
    ...reference,
    items: [
      { name: "Paneer Tikka", quantity: 2, price: 0 },
      { name: "Gulab Jamun", quantity: 3, price: 0, held: true },
      { name: "Roti", quantity: 4, price: 0 },
    ],
  };
  const heldRows = (extra: Partial<ReceiptOptions> = {}) => layoutKot({ ...held, ...extra }, P80);

  test("THE HOLD LINE IS THE MARKER ALONE: '[Hold]', and nothing after it", () => {
    // Client: "When an item is on hold, on the KOT it must only say 'hold' and
    // NOT 'hold do not cook until fired'."
    expect(KOT_HOLD_LINE).toBe("[Hold]");
    const out = shapes(heldRows());
    const dish = out.indexOf("num=2  name*=Gulab Jamun  qty=3");
    expect(out[dish + 1]).toBe("name=[Hold]");
    expect(words(heldRows())).not.toMatch(/do not cook|until fired/i);
    // …and it is the same line at every text size.
    for (const size of ["small", "standard", "large"]) {
      expect(shapes(layoutKot(held, kotProfile(576, size)))).toEqual(out);
    }
  });

  test("a CANCELLED slip keeps its own 'DO NOT COOK' line — a different message, untouched", () => {
    // The hold marker lost its sentence; the cancellation did not. That line
    // tells a kitchen to stop cooking a whole ticket, and it stays word for word.
    const out = shapes(heldRows({ cancelled: true }));
    expect(out[1]).toBe("C*  DO NOT COOK - THIS TICKET IS OFF");
    expect(out).toContain("name=[Hold]");
  });

  test("the held dish keeps its place and number, and [Hold] is the line directly under it", () => {
    const out = shapes(heldRows());
    const dish = out.indexOf("num=2  name*=Gulab Jamun  qty=3");
    expect(dish).toBeGreaterThan(-1);
    expect(out[dish + 1]).toBe(`name=${KOT_HOLD_LINE}`);
  });

  test("NOTHING about the hold prints before the dish — no banner, no prefix, no H-number", () => {
    const out = shapes(heldRows());
    const dish = out.indexOf("num=2  name*=Gulab Jamun  qty=3");
    expect(out.slice(0, dish).join("\n")).not.toMatch(/hold/i);
  });

  test("the [Hold] line is styled exactly like the [Note] line: same column, not bold", () => {
    const out = heldRows({ items: [{ name: "Gulab Jamun", quantity: 3, price: 0, held: true, note: "fire with dessert" }] });
    const cells = out.flatMap((r) => (r.k === "cols" ? r.cells : [])).filter((c) => c.text.startsWith("["));
    expect(cells).toEqual([
      { text: KOT_HOLD_LINE, at: "name", bold: false },
      { text: "[Note] fire with dessert", at: "name", bold: false },
    ]);
  });

  test("an item with a hold AND a note prints both under the dish, hold first", () => {
    const out = shapes(heldRows({ items: [{ name: "Gulab Jamun", quantity: 3, price: 0, held: true, note: "fire with dessert" }] }));
    const dish = out.indexOf("num=1  name*=Gulab Jamun  qty=3");
    expect(out.slice(dish + 1, dish + 3)).toEqual([`name=${KOT_HOLD_LINE}`, "name=[Note] fire with dessert"]);
  });

  test("Total Qty counts only what the kitchen may cook, and the hold is totalled apart", () => {
    const out = shapes(heldRows());
    expect(out).toContain("num=Total Qty  qty=6");
    expect(out).toContain("num=Hold Qty  qty=3");
  });

  test("a wholly held docket does not claim a total of nothing", () => {
    const out = shapes(heldRows({ items: [{ name: "Gulab Jamun", quantity: 3, price: 0, held: true }] }));
    expect(out).not.toContain("num=Total Qty  qty=0");
    expect(out).toContain("num=Hold Qty  qty=3");
  });

  test("a docket with nothing held carries no hold wording anywhere", () => {
    const out = words(rows({ items: [{ name: "Subz Tehri", quantity: 1, price: 0 }] }));
    expect(out).not.toMatch(/hold/i);
  });

  test("an empty ticket still prints its total line", () => {
    expect(shapes(rows({ items: [] }))).toContain("num=Total Qty  qty=0");
  });
});

describe("layoutKot — the order-level note", () => {
  test("prints under its own banner, ABOVE the item table it qualifies", () => {
    const out = shapes(rows({ orderNote: "allergy: peanuts, no onions in anything" }));
    const banner = out.indexOf("C*  ** NOTE **");
    expect(banner).toBeGreaterThan(-1);
    expect(out[banner + 1]).toBe("L   allergy: peanuts, no onions in anything");
    expect(banner).toBeLessThan(out.indexOf("num=No.Item  qty=Qty"));
  });

  test("a docket with no order note carries no banner and no empty line", () => {
    for (const orderNote of [null, undefined, "   ", "null"]) {
      expect(words(rows({ orderNote }))).not.toContain("** NOTE **");
    }
  });
});

describe("layoutKot — the safety banners", () => {
  test("a reprint says so before anything else on the roll, in the one larger size", () => {
    const out = shapes(rows({ reprint: true }));
    expect(out[0]).toBe("C*! ** REPRINT **");
  });

  test("a cancellation says CANCELLED first, then what to do about it", () => {
    const out = shapes(rows({ cancelled: true }));
    expect(out.slice(0, 4)).toEqual([
      "C*! ** CANCELLED **",
      "C*  DO NOT COOK - THIS TICKET IS OFF",
      "<RULE>",
      "C   Running Table",
    ]);
  });

  test("the banner is the ONLY thing on the docket set larger than body text", () => {
    const out = rows({ reprint: true, cancelled: true });
    const banners = out.filter((r) => r.k === "line" && r.size === "banner");
    expect(banners.map((r) => (r as { text: string }).text)).toEqual(["** REPRINT **", "** CANCELLED **"]);
  });

  test("an ordinary docket carries neither word", () => {
    const out = words(rows({ reprint: false, cancelled: false }));
    expect(out).not.toContain("REPRINT");
    expect(out).not.toContain("CANCELLED");
  });

  test("a cancellation slip still names the ticket, the table and the dishes", () => {
    const out = words(rows({ cancelled: true }));
    expect(out).toContain("KOT - 21");
    expect(out).toContain("Table No: 33");
    expect(out).toContain("Subz Tehri");
  });
});

describe("layoutKot — folded to ASCII at the door", () => {
  test("a rupee sign and an accented letter become printable ASCII, not a gap", () => {
    const out = words(rows({ items: [{ name: "Café Niçoise ₹250 — Thé", quantity: 1, price: 0 }] }));
    expect(out).toContain("Cafe Nicoise Rs250 - The");
  });

  test("a character with no ASCII at all becomes a VISIBLE '?', never nothing", () => {
    const out = words(rows({ items: [{ name: "पनीर Tikka", quantity: 1, price: 0 }] }));
    expect(out).toMatch(/\?+ Tikka/);
  });

  test("nothing outside printable ASCII survives into a row", () => {
    const out = words(rows({
      orderContext: "Running\tTable",
      orderNote: "smart “quotes” and an em—dash…",
      items: [{ name: "Tea — Earl Grey ½", quantity: 1, price: 0 }],
    }));
    expect(out).toMatch(/^[\x20-\x7e\n]*$/);
  });
});

describe("layoutKot — a bill's fields are not a docket's", () => {
  test("nothing from the bill header reaches the kitchen", () => {
    const out = words(rows({
      legalName: "NAVKRISH HOSPITALITY LLP",
      address: "12 Mantri Square",
      phone: "080-4123 4567",
      gstin: "29AAXFN2701Q1ZF",
      customer: "Alice",
      customerGstin: "29ABCDE1234F1Z5",
      kotNumbers: [214, 218],
      splitPart: { index: 1, of: 2, label: "Bar" },
      feedbackUrl: "https://example.test/feedback",
      qrNote: "Scan to rate us",
      serviceChargeNote: "A voluntary service charge is included",
    }));
    for (const leak of ["NAVKRISH", "Mantri", "4123", "29AAXFN", "Alice", "Token", "PART", "feedback", "service charge"]) {
      expect(out).not.toContain(leak);
    }
  });

  test("a docket that sets every bill field lays out the same rows as one that sets none", () => {
    expect(layoutKot({ ...reference, gstin: "29AAXFN2701Q1ZF", grandTotal: 4982 }, P80)).toEqual(layoutKot(reference, P80));
  });
});
