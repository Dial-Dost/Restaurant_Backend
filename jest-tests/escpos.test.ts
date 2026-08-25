import { describe, test, expect } from "@jest/globals";
import {
  BILL_QR_NOTE_MAX,
  DEFAULT_BILL_QR_NOTE,
  buildReceiptBase64,
  buildKotBase64,
  groupKotItemsByStation,
  type ReceiptOptions,
} from "../escpos";

const decode = (b64: string) => Buffer.from(b64, "base64").toString("latin1");
const bytes = (b64: string) => Buffer.from(b64, "base64");

/**
 * The receipt as the PAPER shows it: ESC/POS command sequences removed, so an
 * assertion can talk about lines and their widths without the invisible mode
 * bytes that sit inside them.
 *
 * Needed because the command stream is interleaved with the text — `ESC ! 0x00`
 * (normal type) lands between the restaurant name's newline and the rule under
 * it, and `ESC E 0x01` (bold) prefixes the Grand Total line. Both make a naive
 * substring match miss and a naive `line.length` read three characters long.
 * Only the four fixed-length commands this renderer emits are stripped; the
 * logo and QR rasters are left alone.
 */
function printed(b64: string): string {
  return decode(b64)
    .replace(/\x1b@/g, "")            // ESC @   initialize
    .replace(/\x1b[a!E][\s\S]/g, "")  // ESC a/!/E n   align / mode / bold
    .replace(/\x1dV[\s\S]/g, "");     // GS V n  cut
}
const printedLines = (b64: string) => printed(b64).split("\n");

const baseBill: ReceiptOptions = {
  restaurantName: "Café Niçoise", // diacritics -> should be ASCII-folded
  address: "12 Main St",
  table: "5",
  covers: 2,
  customer: "Alice",
  billNo: "INV-1",
  cashier: "Bob",
  items: [{ name: "Tea — Earl Grey", quantity: 2, price: 50 }], // em-dash -> '-'
  total: 100, // gross subtotal
  currency: "₹",
  discount: { amount: 20, label: "Coupon SAVE20" },
  serviceCharge: { percent: 5, amount: 4 }, // 5% of discounted 80
  taxes: [{ name: "GST", percentage: 5, amount: 4.2 }], // 5% of 84
  kind: "bill",
};

describe("buildReceiptBase64 — bill", () => {
  test("returns valid base64 and ends with a cut command", () => {
    const b64 = buildReceiptBase64(baseBill);
    expect(typeof b64).toBe("string");
    const buf = bytes(b64);
    expect(buf.length).toBeGreaterThan(0);
    // GS V 0 (full cut) = 0x1d 0x56 0x00 near the end
    expect(buf.includes(Buffer.from([0x1d, 0x56, 0x00]))).toBe(true);
  });

  test("ASCII-folds non-Latin text and never emits control bytes from typography", () => {
    const out = decode(buildReceiptBase64(baseBill));
    expect(out).toContain("Cafe Nicoise"); // diacritics stripped
    expect(out).not.toContain("Café");
    expect(out).toContain("Tea - Earl Grey"); // em-dash folded to hyphen
    expect(out).not.toContain("—");
    // em-dash U+2014 truncated to latin1 would be byte 0x14 (DC4) — must NOT appear
    expect(bytes(buildReceiptBase64(baseBill)).includes(0x14)).toBe(false);
  });

  test("renders the full header + meta block", () => {
    const out = decode(buildReceiptBase64(baseBill));
    expect(out).toContain("Customer Name: Alice");
    expect(out).toContain("Bill No.: INV-1");
    expect(out).toContain("Cashier: Bob");
    expect(out).toContain("Dine In: 5");
  });

  test("totals: subtotal, discount, service charge, tax, and rounded grand total", () => {
    const out = decode(buildReceiptBase64(baseBill));
    // ₹ maps to the ASCII token "Rs"
    expect(out).toContain("Coupon SAVE20"); // discount label
    expect(out).toContain("Service Charge (5%)");
    expect(out).toContain("GST (5%)");
    // LEGACY PATH ONLY (no grandTotal supplied): grand = 100 - 20 + 4 + 4.2
    // = 88.2 -> rounded 88, with the round-off line disclosing the -0.20.
    expect(out).toContain("Grand Total:");
    expect(out).toContain("Rs 88.00");
    expect(out).toContain("Round off");
  });

  test("service charge waiver prints 'Opted-out'", () => {
    const out = decode(buildReceiptBase64({ ...baseBill, serviceCharge: { percent: 10, amount: 0, optedOut: true } }));
    expect(out).toContain("Service Charge (10%)");
    expect(out).toContain("Opted-out");
  });

  test("per-item note is printed under the item", () => {
    const out = decode(buildReceiptBase64({ ...baseBill, items: [{ name: "Soup", quantity: 1, price: 30, note: "no salt" }] }));
    expect(out).toContain("no salt");
  });
});

// --- Header block ----------------------------------------------------------
// The ask was "show the address and everything": logo, restaurant name, legal
// entity, address lines, GSTIN. The invariant that matters is not that a fully
// configured tenant prints all five — it is that a tenant missing any of them
// prints NOTHING in its place, never a stray label or a blank line.
describe("buildReceiptBase64 — bill header", () => {
  const fullHeader: ReceiptOptions = {
    ...baseBill,
    legalName: "NAVKRISH HOSPITALITY LLP",
    address: "12 Mantri Square\n2nd Floor, Sampige Road\nMalleshwaram, Bengaluru 560003",
    gstin: "29AAXFN2701Q1ZF",
    logo: Buffer.from([0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 0x01, 0x00, 0xff]),
  };

  test("prints logo, name, legal entity, every address line and the GSTIN", () => {
    const b64 = buildReceiptBase64(fullHeader);
    const out = decode(b64);
    expect(out).toContain("Cafe Nicoise");
    expect(out).toContain("NAVKRISH HOSPITALITY LLP");
    expect(out).toContain("12 Mantri Square");
    expect(out).toContain("2nd Floor, Sampige Road");
    expect(out).toContain("Malleshwaram, Bengaluru 560003");
    expect(out).toContain("GSTN : 29AAXFN2701Q1ZF");
    // The raster bytes are emitted verbatim, ahead of the name.
    const buf = bytes(b64);
    expect(buf.includes(fullHeader.logo as Buffer)).toBe(true);
    expect(buf.indexOf(fullHeader.logo as Buffer)).toBeLessThan(buf.indexOf(Buffer.from("Cafe Nicoise", "latin1")));
  });

  test("a stored address keeps the owner's own line breaks", () => {
    const out = decode(buildReceiptBase64(fullHeader));
    // Three separate lines, not one reflowed blob.
    expect(out).toContain("12 Mantri Square\n2nd Floor, Sampige Road\n");
  });

  test("minimal tenant — no gstin, address or logo — prints a clean receipt", () => {
    // `printed`, not `decode`: the renderer resets the type size (ESC ! 0x00)
    // between the name's newline and the rule under it, so the adjacency below
    // is only visible once the command bytes are out of the way.
    const out = printed(buildReceiptBase64({
      ...baseBill,
      legalName: null,
      address: null,
      gstin: null,
      logo: null,
    }));
    // No orphan label, and no half-written one either.
    expect(out).not.toContain("GSTN");
    expect(out).toContain("Cafe Nicoise");
    // The name is followed straight by the separator rule — no blank lines
    // standing in for the fields this tenant does not have.
    expect(out).toContain(`Cafe Nicoise\n${"-".repeat(48)}`);
  });

  test("blank-but-present fields are treated as absent, not as empty lines", () => {
    const out = printed(buildReceiptBase64({
      ...baseBill,
      legalName: "   ",
      address: "\n  \n",
      gstin: "  ",
    }));
    expect(out).not.toContain("GSTN");
    expect(out).toContain(`Cafe Nicoise\n${"-".repeat(48)}`);
  });

  test("a tenant with a GSTIN but no legal entity prints only the GSTIN", () => {
    const out = decode(buildReceiptBase64({ ...baseBill, legalName: null, gstin: "29AAXFN2701Q1ZF" }));
    expect(out).toContain("GSTN : 29AAXFN2701Q1ZF");
    expect(out).toContain("12 Main St");
  });

  test("the header block is a BILL concern — a KOT carries none of it", () => {
    const out = printed(buildReceiptBase64({ ...fullHeader, kind: "kot" }));
    // Anchored on the restaurant name so the negatives below cannot pass
    // vacuously on an empty render. Deliberately NOT anchored on the kitchen
    // ticket's own wording — that line is the KOT format's to define, and this
    // test is only about the tenant identity block staying off the kitchen copy.
    expect(out).toContain("Cafe Nicoise");
    // The legal entity and tax registration belong on the guest's invoice, not
    // on the docket that goes to the pass.
    expect(out).not.toContain("GSTN");
    expect(out).not.toContain("NAVKRISH HOSPITALITY LLP");
    expect(out).not.toContain("Malleshwaram, Bengaluru 560003");
  });
});

// --- Tax breakdown ---------------------------------------------------------
// The reference receipt splits SGST 2.5% / CGST 2.5% into two lines. That split
// is the TENANT'S configuration (Outlets.default_tax), carried on the bill —
// the renderer's only job is to print the lines it is handed.
describe("buildReceiptBase64 — tax breakdown", () => {
  test("prints one line per configured tax, each with its own label and percentage", () => {
    const out = decode(buildReceiptBase64({
      ...baseBill,
      discount: null,
      serviceCharge: null,
      total: 760,
      taxes: [
        { name: "SGST", percentage: 2.5, amount: 19 },
        { name: "CGST", percentage: 2.5, amount: 19 },
      ],
      grandTotal: 798,
    }));
    expect(out).toContain("SGST (2.5%)");
    expect(out).toContain("CGST (2.5%)");
    expect(out).toContain("Sub");           // subtotal line still present
    expect(out).toContain("760.00");
    expect(out).toContain("Rs 798.00");
  });

  test("does not invent a split the tenant has not configured", () => {
    const out = decode(buildReceiptBase64({
      ...baseBill,
      taxes: [{ name: "GST", percentage: 5, amount: 4.2 }],
    }));
    expect(out).toContain("GST (5%)");
    expect(out).not.toContain("SGST");
    expect(out).not.toContain("CGST");
  });

  test("a tenant with no taxes configured prints no tax lines at all", () => {
    const out = decode(buildReceiptBase64({ ...baseBill, taxes: [], discount: null, serviceCharge: null, grandTotal: 100 }));
    expect(out).not.toContain("%)");
    expect(out).toContain("Rs 100.00");
  });
});

// --- The renderer must not re-round money ----------------------------------
// THE POINT OF THIS BLOCK. computeBillCharges is the single authority on what
// the guest owes and it is what settle records; a second rounding here is
// exactly how a bill SETTLED at 797.55 came to be PRINTED as 798.
describe("buildReceiptBase64 — money is printed verbatim", () => {
  test("prints the supplied grand total to the paise, without rounding it", () => {
    const out = decode(buildReceiptBase64({
      ...baseBill,
      discount: null,
      serviceCharge: null,
      total: 760,
      taxes: [
        { name: "SGST", percentage: 2.5, amount: 18.89 },
        { name: "CGST", percentage: 2.5, amount: 18.66 },
      ],
      grandTotal: 797.55,
    }));
    expect(out).toContain("Rs 797.55");
    // The whole-rupee figure a re-round would have produced must NOT appear.
    expect(out).not.toContain("Rs 798.00");
  });

  test("no round-off line is printed when the total came from the billing layer", () => {
    const out = decode(buildReceiptBase64({ ...baseBill, grandTotal: 88.2 }));
    expect(out).toContain("Rs 88.20");
    // Nothing was rounded, so there is no correction to disclose.
    expect(out).not.toContain("Round off");
  });

  test("the supplied total is printed even when it disagrees with the line items", () => {
    // A deliberately inconsistent set: items sum to 100 and the taxes to 4.20,
    // but the bill says 61.00. The renderer is not the arbiter — if it silently
    // "corrected" this, a genuine settle-layer figure could never be trusted to
    // reach the paper.
    const out = decode(buildReceiptBase64({ ...baseBill, grandTotal: 61 }));
    expect(out).toContain("Rs 61.00");
    expect(out).not.toContain("Rs 88.00");
  });

  test("item prices and line totals are never re-rounded either", () => {
    const out = decode(buildReceiptBase64({
      ...baseBill,
      items: [{ name: "Filter Coffee", quantity: 3, price: 33.33 }],
      grandTotal: 99.99,
    }));
    expect(out).toContain("33.33");
    expect(out).toContain("99.99");
  });

  test("an absent grandTotal keeps the legacy rounded behaviour exactly", () => {
    const out = decode(buildReceiptBase64({ ...baseBill, grandTotal: null }));
    expect(out).toContain("Round off");
    expect(out).toContain("Rs 88.00");
  });
});

// --- Custom QR message -----------------------------------------------------
describe("buildReceiptBase64 — custom QR message", () => {
  const withQr: ReceiptOptions = { ...baseBill, feedbackUrl: "https://example.test/feedback?rid=r1" };

  test("falls back to the built-in valet line when the tenant has set none", () => {
    for (const note of [undefined, null, "", "   "]) {
      const out = decode(buildReceiptBase64({ ...withQr, qrNote: note as string | null | undefined }));
      expect(out).toContain(DEFAULT_BILL_QR_NOTE);
    }
  });

  test("prints the tenant's own sentence instead when one is set", () => {
    const out = decode(buildReceiptBase64({ ...withQr, qrNote: "Scan to rate us and call your valet" }));
    expect(out).toContain("Scan to rate us and call your valet");
    expect(out).not.toContain(DEFAULT_BILL_QR_NOTE);
  });

  test("is truncated to the documented cap rather than flooding the footer", () => {
    const long = "x".repeat(BILL_QR_NOTE_MAX + 50);
    const out = decode(buildReceiptBase64({ ...withQr, qrNote: long }));
    expect(out).not.toContain(long);
    expect(out).toContain("x".repeat(Math.min(BILL_QR_NOTE_MAX, 48)));
  });

  test("wraps to the paper width on 58mm without overflowing the column", () => {
    const note = "Scan the code below to rate your meal and to call the valet to the porch";
    // Everything up to the QR command block. The QR payload is the feedback URL
    // carried verbatim inside `GS ( k`, which is longer than the paper is wide
    // and contains no newline — measuring it as if it were a printed line would
    // fail this test for a reason that has nothing to do with text wrapping.
    // The note is emitted BEFORE the QR, so every wrapped note line is in here.
    const out = printed(buildReceiptBase64({ ...withQr, qrNote: note }, 32)).split("\x1d(k")[0] ?? "";
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(32);
    }
    expect(out).toContain("Scan the code below to rate");
    // …and it really did wrap rather than being cut short at the column.
    expect(out).toContain("the porch");
  });

  test("no QR, no note — the message never prints on a bill without a QR", () => {
    const out = decode(buildReceiptBase64({ ...baseBill, feedbackUrl: null, qrNote: "Follow us online" }));
    expect(out).not.toContain("Follow us online");
    expect(out).not.toContain(DEFAULT_BILL_QR_NOTE);
  });
});

// --- The kitchen ticket ----------------------------------------------------
// The reference thermal KOT reads, top to bottom: the order context ("Running
// Table"), a bold "KOT", the printing date AND time, the day's ticket number
// ("KOT - 26"), the service mode with its floor section, the table number, the
// head count, who the table is assigned to, then a numbered item list with a
// Qty column and a total.
//
// Every one of those values is PRE-RESOLVED BY THE CALLER. The renderer holds no
// clock, no timezone and no counter — so these tests assert placement and
// omission, and kot_numbering.test.ts asserts that the values themselves are
// right.
describe("buildReceiptBase64 — KOT", () => {
  const kotBase: ReceiptOptions = {
    ...baseBill,
    kind: "kot",
    kotNo: 26,
    printedAt: "25/08/26 15:23",
    orderContext: "Running Table",
    serviceMode: "Dine In",
    section: "FRONT",
    table: "12",
    covers: 2,
    assignedTo: "yadob",
    captain: "yadob",
    items: [
      { name: "Paneer Tikka", quantity: 2, price: 200 },
      { name: "Naan", quantity: 3, price: 40, note: "no butter" },
    ],
  };

  test("carries every field the reference KOT does", () => {
    const out = printed(buildReceiptBase64(kotBase));
    expect(out).toMatch(/^Running Table$/m);
    // A line of its own, so this cannot pass vacuously on "KOT - 26" below.
    expect(out).toMatch(/^KOT$/m);
    expect(out).toContain("25/08/26 15:23");   // date AND time of printing
    expect(out).toContain("KOT - 26");          // the day's ticket number
    expect(out).toContain("Dine In: FRONT");    // service mode + floor section
    expect(out).toContain("Table No: 12");
    expect(out).toContain("Persons - 2");       // the table's covers
    expect(out).toContain("Assign to: yadob");
    expect(out).toContain("Captain: yadob");
  });

  test("items are numbered, quantities are a right-aligned column, notes hang under the dish", () => {
    const out = printed(buildReceiptBase64(kotBase));
    expect(out).toContain("No. Item");
    // "1" in the No. column, the dish, then the qty flush to the 48th column.
    expect(out).toMatch(/^1 {3}Paneer Tikka +2$/m);
    expect(out).toMatch(/^2 {3}Naan +3$/m);
    // The note is indented past the No. column so the numbers stay a clean run.
    expect(out).toMatch(/^ {4}\* no butter$/m);
    // Total quantity, as the reference prints it: 2 + 3.
    expect(out).toMatch(/^Total Qty {2,}5$/m);
  });

  test("a KOT never carries money — not a price, not a total, not a currency", () => {
    const out = decode(buildReceiptBase64(kotBase));
    expect(out).not.toContain("Grand Total");
    expect(out).not.toContain("Subtotal");
    expect(out).not.toContain("Rs ");
    expect(out).not.toContain("200.00");
    expect(out).not.toContain("Service Charge");
  });

  test("the ticket number line is OMITTED, never faked, when numbering is unavailable", () => {
    // migration 029 unapplied -> allocateKotNumber returns null -> kotNo null.
    // A docket with no number is honest; one with a wrong number is not.
    const out = printed(buildReceiptBase64({ ...kotBase, kotNo: null }));
    expect(out).not.toContain("KOT - ");
    expect(out).not.toContain("KOT - 0");
    // Everything else still prints.
    expect(out).toContain("Table No: 12");
    expect(out).toContain("25/08/26 15:23");
  });

  test("an unassigned table prints neither staff line, and no empty rule", () => {
    const out = printed(buildReceiptBase64({ ...kotBase, assignedTo: null, captain: null }));
    expect(out).not.toContain("Assign to:");
    expect(out).not.toContain("Captain:");
    expect(out).toContain("Persons - 2");
  });

  test("a waiter who is not a captain gets one line, not the same name twice", () => {
    const out = printed(buildReceiptBase64({ ...kotBase, captain: null }));
    expect(out).toContain("Assign to: yadob");
    expect(out).not.toContain("Captain:");
  });

  test("with no floor section the service mode stands alone rather than repeating", () => {
    const out = printed(buildReceiptBase64({ ...kotBase, section: null }));
    expect(out).not.toContain("Dine In: Dine In");
    expect(out).toMatch(/^Dine In$/m);
  });

  test("a takeaway ticket announces its channel instead of claiming a running table", () => {
    const out = printed(buildReceiptBase64({
      ...kotBase, orderContext: "Takeaway", serviceMode: "Takeaway", section: null,
    }));
    expect(out).toContain("Takeaway");
    expect(out).not.toContain("Running Table");
    expect(out).not.toContain("Dine In");
  });

  test("a caller that resolved no stamp still prints a time rather than a blank line", () => {
    const out = printed(buildReceiptBase64({ ...kotBase, printedAt: null }));
    // The server-clock fallback — what every ticket printed before kotStamp.
    const stamp = out.split("\n")[out.split("\n").findIndex((l) => l.trim() === "KOT") + 1];
    expect(stamp.trim().length).toBeGreaterThan(0);
    expect(stamp).not.toMatch(/^-+$/);
    expect(out).toContain("KOT - 26");
  });

  test("the 58mm layout keeps every header field and the numbered columns", () => {
    const out = printed(buildReceiptBase64(kotBase, 32));
    expect(out).toContain("KOT - 26");
    expect(out).toContain("Table No: 12");
    expect(out).toContain("Persons - 2");
    expect(out).toContain("No. Item");
    expect(out).toMatch(/^1 {3}Paneer Tikka +2$/m);
    // Nothing overflows the narrow roll.
    for (const l of out.split("\n")) {expect(l.length).toBeLessThanOrEqual(32);}
  });
});

describe("buildKotBase64 — per-station split", () => {
  const mixed: ReceiptOptions = {
    ...baseBill,
    kind: "kot",
    items: [
      { name: "Paneer Tikka", quantity: 2, price: 200, station: "Tandoor" },
      { name: "Cold Coffee", quantity: 1, price: 120, station: "Beverages" },
      { name: "Naan", quantity: 3, price: 40, station: "Tandoor" },
      { name: "Water", quantity: 1, price: 20 }, // no station -> General
    ],
  };

  test("groups items by station in first-seen order, unstationed -> General", () => {
    const groups = groupKotItemsByStation(mixed.items);
    expect(groups.map((g) => g.station)).toEqual(["Tandoor", "Beverages", "General"]);
    expect(groups[0].items.map((i) => i.name)).toEqual(["Paneer Tikka", "Naan"]);
    expect(groups[2].items.map((i) => i.name)).toEqual(["Water"]);
  });

  test("emits one cut-terminated ticket per station, each headed with its name", () => {
    const tickets = buildKotBase64(mixed);
    expect(tickets.map((t) => t.station)).toEqual(["Tandoor", "Beverages", "General"]);
    const tandoor = decode(tickets[0].escBase64);
    expect(tandoor).toContain("KOT");
    expect(tandoor).toContain("[ TANDOOR ]");
    expect(tandoor).toContain("Paneer Tikka");
    expect(tandoor).toContain("Naan");
    // The Tandoor ticket must NOT carry the beverage item.
    expect(tandoor).not.toContain("Cold Coffee");
    // Each ticket ends with a full cut.
    expect(bytes(tickets[0].escBase64).includes(Buffer.from([0x1d, 0x56, 0x00]))).toBe(true);
    const bev = decode(tickets[1].escBase64);
    expect(bev).toContain("[ BEVERAGES ]");
    expect(bev).toContain("Cold Coffee");
    expect(bev).not.toContain("Paneer Tikka");
  });

  test("no items -> a single General ticket (never zero tickets)", () => {
    const tickets = buildKotBase64({ ...baseBill, kind: "kot", items: [] });
    expect(tickets.length).toBe(1);
    expect(tickets[0].station).toBe("General");
  });
});

describe("buildReceiptBase64 — widths", () => {
  test("produces output for both 80mm (48) and 58mm (32) layouts", () => {
    expect(buildReceiptBase64(baseBill, 48).length).toBeGreaterThan(0);
    expect(buildReceiptBase64(baseBill, 32).length).toBeGreaterThan(0);
  });
});
