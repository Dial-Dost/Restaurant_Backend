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

/**
 * How wide each line actually comes out, IN PRINTER CELLS.
 *
 * `printed(...).length` counts characters, and characters are not cells: the KOT
 * sets `ESC ! 0x20` (double width) around a quantity and `ESC ! 0x30` around the
 * ticket number and the table, and every character inside those runs occupies
 * TWO columns of the roll. A width assertion that counted characters would call
 * a 58mm docket safe while the printer was wrapping it mid-word — the exact
 * failure the size guards in `big` and the quantity column exist to prevent.
 *
 * Only the four fixed-length commands this renderer emits are interpreted;
 * everything else is a printed cell.
 */
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

  // --- The item note is a KITCHEN instruction, and only the kitchen gets it ---
  //
  // It used to print under the line on the guest's bill as well. "no salt" is
  // merely noise on a tax document; "allergy: peanuts" on a slip that is handed
  // across a table, left on it, or photographed for an expense claim is not.
  // Either way it is an instruction to a chef, addressed to a reader who has
  // already done their part by the time this paper exists.
  test("a per-item note NEVER reaches the guest's bill", () => {
    const soup: ReceiptOptions = {
      ...baseBill,
      items: [{ name: "Soup", quantity: 1, price: 30, note: "allergy: peanuts" }],
    };
    const out = decode(buildReceiptBase64(soup));
    expect(out).not.toContain("allergy: peanuts");
    expect(out).not.toContain("peanuts");
    // Anchored, so this cannot pass because the whole item block vanished: the
    // dish, its quantity and its money are all still on the bill.
    expect(out).toContain("Soup");
    expect(out).toContain("30.00");
  });

  test("the SAME line still carries its note to the kitchen", () => {
    // The note did not become unprintable — it moved to the only document whose
    // reader can act on it.
    const out = printed(buildReceiptBase64({
      ...baseBill,
      kind: "kot",
      items: [{ name: "Soup", quantity: 1, price: 30, note: "allergy: peanuts" }],
    }));
    expect(out).toContain("[Note] allergy: peanuts");
  });

  test("dropping the note changes no figure on the bill", () => {
    // The strongest form of "safe to remove": the paper is byte-identical to the
    // same bill with no note at all. Nothing about a note was load-bearing.
    const withNote = buildReceiptBase64({
      ...baseBill, items: [{ name: "Soup", quantity: 1, price: 30, note: "no salt" }], printedAt: "25/08/26 15:23",
    });
    const without = buildReceiptBase64({
      ...baseBill, items: [{ name: "Soup", quantity: 1, price: 30 }], printedAt: "25/08/26 15:23",
    });
    expect(withNote).toBe(without);
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
    phone: "080-4123 4567",
    gstin: "29AAXFN2701Q1ZF",
    logo: Buffer.from([0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 0x01, 0x00, 0xff]),
  };

  test("prints logo, name, legal entity, every address line, the phone and the GSTIN", () => {
    const b64 = buildReceiptBase64(fullHeader);
    const out = decode(b64);
    expect(out).toContain("Cafe Nicoise");
    expect(out).toContain("NAVKRISH HOSPITALITY LLP");
    expect(out).toContain("12 Mantri Square");
    expect(out).toContain("2nd Floor, Sampige Road");
    expect(out).toContain("Malleshwaram, Bengaluru 560003");
    expect(out).toContain("Ph : 080-4123 4567");
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

  // --- The statutory header, in the order a tax invoice carries it ----------
  // A printed bill in India is the document a guest is expected to keep, query
  // and claim against. Address and GSTIN were already on it; the phone — the one
  // line that lets a guest ring the restaurant about the bill in their hand —
  // was not, even though every outlet already stores one.
  test("the phone sits between the address and the tax registration", () => {
    const out = printed(buildReceiptBase64(fullHeader));
    const at = (s: string) => out.indexOf(s);
    expect(at("Malleshwaram, Bengaluru 560003")).toBeGreaterThan(-1);
    expect(at("Ph : 080-4123 4567")).toBeGreaterThan(at("Malleshwaram, Bengaluru 560003"));
    expect(at("GSTN : 29AAXFN2701Q1ZF")).toBeGreaterThan(at("Ph : 080-4123 4567"));
  });

  test("an outlet with no phone prints no phone line — not an orphan label", () => {
    for (const phone of [undefined, null, "", "   "]) {
      const out = printed(buildReceiptBase64({ ...fullHeader, phone: phone as string | null | undefined }));
      expect(out).not.toContain("Ph :");
      // The fields it DOES have are untouched by the one it lacks.
      expect(out).toContain("GSTN : 29AAXFN2701Q1ZF");
      expect(out).toContain("12 Mantri Square");
    }
  });

  test("two stored numbers wrap instead of losing the second one", () => {
    const out = printed(buildReceiptBase64({
      ...fullHeader, phone: "080-4123 4567 / +91 98765 43210 / +91 91234 56789",
    }, 32));
    expect(out).toContain("Ph : 080-4123 4567");
    expect(out).toContain("91234 56789");
    for (const w of cellWidths(buildReceiptBase64({
      ...fullHeader, phone: "080-4123 4567 / +91 98765 43210 / +91 91234 56789",
    }, 32))) { expect(w).toBeLessThanOrEqual(32); }
  });

  // --- "null" is not a value ------------------------------------------------
  // A JS null that has been through a template literal, a form field or an older
  // client's JSON body arrives as the four-letter STRING. On a tax document
  // `GSTN : null` reads as a filed registration rather than a missing one, and
  // `Ph : undefined` is a phone number a guest may actually try to dial.
  test("the literal strings 'null' and 'undefined' are treated as unset", () => {
    const out = printed(buildReceiptBase64({
      ...baseBill,
      legalName: "null",
      address: "undefined",
      phone: "NULL",
      gstin: "null",
      customer: "null",
      billNo: "undefined",
      cashier: "null",
    }));
    expect(out.toLowerCase()).not.toContain("null");
    expect(out.toLowerCase()).not.toContain("undefined");
    expect(out).not.toContain("GSTN");
    expect(out).not.toContain("Ph :");
    expect(out).not.toContain("Bill No.");
    expect(out).not.toContain("Cashier:");
    // An unnamed guest is still a guest, not a blank.
    expect(out).toContain("Customer Name: Guest");
  });

  test("a KOT's header fields obey the same rule", () => {
    const out = printed(buildReceiptBase64({
      ...baseBill, kind: "kot", section: "null", assignedTo: "null", captain: "undefined", printedAt: "25/08/26 15:23",
    }));
    expect(out).not.toContain("Assign to:");
    expect(out).not.toContain("Captain:");
    expect(out).not.toContain("null");
    // With the section unset the service mode stands alone, exactly as it does
    // for an outlet that never configured one.
    expect(out).toMatch(/^Dine In$/m);
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
    // The legal entity, address, phone and tax registration belong on the
    // guest's invoice, not on the docket that goes to the pass.
    expect(out).not.toContain("GSTN");
    expect(out).not.toContain("NAVKRISH HOSPITALITY LLP");
    expect(out).not.toContain("Malleshwaram, Bengaluru 560003");
    expect(out).not.toContain("Ph :");
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
    expect(out).toContain("25/08/26 15:23");   // date AND time of printing
    expect(out).toContain("KOT - 26");          // the day's ticket number
    expect(out).toContain("Dine In: FRONT");    // service mode + floor section
    expect(out).toContain("Table No: 12");
    expect(out).toContain("Persons - 2");       // the table's covers
    expect(out).toContain("Assign to: yadob");
    expect(out).toContain("Captain: yadob");
  });

  // --- What the big type is spent on ----------------------------------------
  // A docket is read standing up, at arm's length, under a pass light. The two
  // things that have to survive that are WHICH TICKET and WHICH TABLE, and both
  // used to be body text while the largest type on the roll went to the
  // restaurant's own name — the one fact the kitchen already has, being stood
  // in. So the name drops to normal size and the ticket and the table take the
  // double-width-and-height slots.
  describe("the docket's own identity", () => {
    /** Every substring the renderer printed at double size, in order. */
    const doubled = (b64: string): string[] => {
      const raw = decode(b64);
      const out: string[] = [];
      for (const m of raw.matchAll(/\x1b!([\s\S])([^\x1b\x1d]*)/g)) {
        if ((m[1]!.charCodeAt(0) & 0x30) === 0x30) { out.push(m[2]!.trim()); }
      }
      // A quantity ("x2") is also double width AND height now that the item row
      // it sits on is tall (item 3) — it is the row's type, not a heading.
      return out.filter(Boolean).filter((t) => !/^x\d+$/.test(t));
    };

    test("the ticket number and the table are the big type; the name is not", () => {
      expect(doubled(buildReceiptBase64(kotBase))).toEqual(["KOT - 26", "Table No: 12"]);
    });

    test("the word KOT is printed once, not twice", () => {
      // It used to be a bold "KOT" line and then a separate "KOT - 26" under it:
      // the word said twice, and the number — the thing the pass calls out —
      // demoted to body text beneath it.
      const out = printed(buildReceiptBase64(kotBase));
      expect(out).not.toMatch(/^KOT$/m);
      expect(out).toMatch(/^KOT - 26$/m);
    });

    test("an unnumbered ticket still gets a heading, just without a number", () => {
      const b64 = buildReceiptBase64({ ...kotBase, kotNo: null });
      expect(doubled(b64)).toEqual(["KOT", "Table No: 12"]);
      expect(printed(b64)).not.toContain("KOT - ");
    });

    test("a table name too long for the paper degrades instead of wrapping mid-word", () => {
      // Takeaway tables are named for their channel and their order id, and a
      // double-width line only fits when 2 x length <= width. Wrapping the one
      // line that had to be unmissable into two ragged halves is worse than
      // printing it at normal size, so the renderer chooses normal size.
      // 20 characters: 40 of the 48 cells on 80mm paper, but 40 of 32 on 58mm.
      const wide = { ...kotBase, table: "Terrace-04" };
      expect(doubled(buildReceiptBase64(wide, 48))).toEqual(["KOT - 26", "Table No: Terrace-04"]);
      expect(doubled(buildReceiptBase64(wide, 32))).toEqual(["KOT - 26"]);
      // Degraded, NOT dropped or truncated — the table is still on the ticket.
      expect(printed(buildReceiptBase64(wide, 32))).toContain("Table No: Terrace-04");

      // A takeaway table named for its channel and order id overflows even the
      // wide roll, and degrades there too.
      const long = { ...kotBase, table: "Swiggy-88214-Delivery" };
      expect(doubled(buildReceiptBase64(long, 48))).toEqual(["KOT - 26"]);
      expect(printed(buildReceiptBase64(long, 48))).toContain("Table No: Swiggy-88214-Delivery");
      for (const cols of [48, 32]) {
        for (const w of cellWidths(buildReceiptBase64(long, cols))) { expect(w).toBeLessThanOrEqual(cols); }
      }
    });
  });

  // --- The quantity ---------------------------------------------------------
  // It was a bare digit in body text at the far right of a 48-column line:
  // thirty blank columns from the dish it belonged to, the same weight as every
  // other character on the ticket, and shaped exactly like the line number at
  // the other end of the same row.
  test("items are numbered, quantities are an anchored double-width column, notes hang under the dish", () => {
    const b64 = buildReceiptBase64(kotBase);
    const out = printed(b64);
    expect(out).toContain("No. Item");
    // "1" in the No. column, the dish, dot leaders across the gap, then "x2".
    expect(out).toMatch(/^1 {3}Paneer Tikka \.+ x2$/m);
    expect(out).toMatch(/^2 {3}Naan \.+ x3$/m);
    // The note is indented past the No. column so the numbers stay a clean run,
    // tagged "[Note]" as on the client's reference docket.
    expect(out).toMatch(/^ {4}\[Note\] no butter$/m);
    // Total quantity, as the reference prints it: 2 + 3.
    expect(out).toMatch(/^Total Qty {2,}5$/m);
    // …and every quantity really is emitted bold and double width, which is what
    // makes it findable without reading the row. `x2` as plain text would
    // satisfy the regex above and none of the point of the change.
    const raw = decode(b64);
    // 0x38 = bold bit + double height (the row is tall) + double width.
    expect(raw).toContain("\x1bE\x01\x1b!\x38x2\x1b!\x10\x1bE\x00");
    expect(raw).toContain("\x1bE\x01\x1b!\x38x3\x1b!\x10\x1bE\x00");
  });

  test("a quantity too wide to double stays inside its column instead of eating the dish name", () => {
    // "x120" is eight cells doubled and the column is eight wide at 48; at 32
    // the column is six, so it degrades to normal width rather than pushing
    // into the item column.
    const big = { ...kotBase, items: [{ name: "Roti", quantity: 120, price: 10 }] };
    for (const cols of [48, 32]) {
      const out = printed(buildReceiptBase64(big, cols));
      expect(out).toMatch(/^1 {3}Roti \.+ x120$/m);
      for (const w of cellWidths(buildReceiptBase64(big, cols))) { expect(w).toBeLessThanOrEqual(cols); }
    }
  });

  test("a dish name that wraps drops the leaders rather than ending the name in dots", () => {
    const out = printed(buildReceiptBase64({
      ...kotBase,
      items: [{ name: "Slow Cooked Lamb Shank Rogan Josh With Saffron Pulao And Raita", quantity: 1, price: 500 }],
    }));
    // A leader run that ends where the name continues below reads as the end of
    // the name, so the wrapped line gets plain padding.
    expect(out).not.toMatch(/^1 {3}Slow Cooked[^\n]*\.\.\./m);
    expect(out).toContain("Saffron Pulao And");
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
    const lines = out.split("\n");
    const stamp = lines[lines.findIndex((l) => l.trim() === "KOT - 26") + 1];
    expect(stamp.trim().length).toBeGreaterThan(0);
    expect(stamp).not.toMatch(/^-+$/);
    expect(out).toContain("KOT - 26");
  });

  test("the 58mm layout keeps every header field and the numbered columns", () => {
    const b64 = buildReceiptBase64(kotBase, 32);
    const out = printed(b64);
    expect(out).toContain("KOT - 26");
    expect(out).toContain("Table No: 12");
    expect(out).toContain("Persons - 2");
    expect(out).toContain("No. Item");
    expect(out).toMatch(/^1 {3}Paneer Tikka \.+ x2$/m);
    // Nothing overflows the narrow roll — measured in CELLS, because the ticket
    // number, the table and every quantity are printed double width.
    for (const w of cellWidths(b64)) {expect(w).toBeLessThanOrEqual(32);}
  });
});

// --- Held courses ----------------------------------------------------------
// ITEM 2: "Hold order should come after the name of the dish which is to be put
// on hold and not before. It should be in the same position like the way a note
// appears on the food order." (1.5 is the older wording of the same thing.)
//
// The previous docket lifted held lines under a big "** HOLD **" banner, so the
// kitchen read HOLD before the dish it applied to. A held dish now prints in its
// own place in the list, and the line directly under it — the slot a "[Note]"
// takes — reads "[Hold] ...". What still keeps it out of the pot is the totals:
// Total Qty counts only the cook-now lines and the hold is totalled apart.
describe("buildReceiptBase64 — KOT, a hold prints where a note does", () => {
  const kot: ReceiptOptions = {
    ...baseBill,
    kind: "kot",
    kotNo: 26,
    printedAt: "25/08/26 15:23",
    orderContext: "Running Table",
    serviceMode: "Dine In",
    section: null,
    table: "12",
    covers: 2,
    assignedTo: null,
    captain: null,
    items: [
      { name: "Paneer Tikka", quantity: 2, price: 200 },
      { name: "Gulab Jamun", quantity: 3, price: 90, held: true },
      { name: "Naan", quantity: 1, price: 40 },
    ],
  };

  /** Index of the first printed line matching `re`, asserted present. */
  const at = (lines: string[], re: RegExp): number => {
    const i = lines.findIndex((l) => re.test(l));
    expect(i).toBeGreaterThanOrEqual(0);
    return i;
  };

  test("the held dish keeps its place and number, and [Hold] is the indented line directly under it", () => {
    const lines = printedLines(buildReceiptBase64(kot));
    const dish = at(lines, /^2 {3}Gulab Jamun \.+ x3$/);
    expect(lines[dish + 1]).toBe("    [Hold] Do not cook until fired");
    // In list order, between the dishes either side of it.
    expect(at(lines, /^1 {3}Paneer Tikka /)).toBeLessThan(dish);
    expect(at(lines, /^3 {3}Naan /)).toBeGreaterThan(dish);
  });

  test("NOTHING about the hold prints before the dish — no banner, no prefix, no H-number", () => {
    const lines = printedLines(buildReceiptBase64(kot));
    const dish = at(lines, /Gulab Jamun/);
    expect(lines.slice(0, dish).join("\n")).not.toMatch(/hold/i);
    const out = lines.join("\n");
    expect(out).not.toContain("** HOLD **");
    expect(out).not.toContain("DO NOT COOK UNTIL FIRED");
    expect(out).not.toMatch(/^H\d/m);
    // …and the dish row itself carries no trailing "hold" word either: the
    // requirement puts the hold on the NOTE line, not on the dish line.
    expect(lines[dish]).not.toMatch(/hold/i);
  });

  test("the [Hold] line is styled exactly like the [Note] line: same indent, same size, not bold", () => {
    const b64 = buildReceiptBase64({
      ...kot, items: [{ name: "Souffle", quantity: 1, price: 300, held: true, note: "no sugar" }],
    });
    const raw = decode(b64);
    expect(raw).toContain("\x1b!\x10    [Hold] Do not cook until fired\n\x1b!\x00");
    expect(raw).toContain("\x1b!\x10    [Note] no sugar\n\x1b!\x00");
    expect(raw).not.toMatch(/\x1bE\x01[^\n]*\[Hold\]/);
  });

  test("an item with a hold AND a note prints both under the dish, hold first", () => {
    const lines = printedLines(buildReceiptBase64({
      ...kot,
      items: [
        { name: "Souffle", quantity: 1, price: 300, held: true, note: "fire with dessert course" },
        { name: "Naan", quantity: 1, price: 40 },
      ],
    }));
    const dish = at(lines, /^1 {3}Souffle \.+ x1$/);
    expect(lines[dish + 1]).toBe("    [Hold] Do not cook until fired");
    expect(lines[dish + 2]).toBe("    [Note] fire with dessert course");
    expect(lines[dish + 3]).toMatch(/^2 {3}Naan /);
  });

  test("a wrapped dish name finishes first — the hold hangs under the LAST line of the name", () => {
    for (const cols of [48, 32]) {
      const lines = printedLines(buildReceiptBase64({
        ...kot,
        items: [{ name: "Slow Cooked Lamb Shank Rogan Josh With Saffron Pulao", quantity: 1, price: 500, held: true }],
      }, cols));
      const hold = at(lines, /\[Hold\]/);
      expect(lines[hold - 1]).toMatch(/Pulao$/);
      expect(lines.slice(0, hold).join("\n")).not.toMatch(/hold/i);
    }
  });

  test("Total Qty counts only what the kitchen may cook, and the hold is totalled apart", () => {
    const out = printed(buildReceiptBase64(kot));
    // 2 Paneer + 1 Naan. The three Gulab Jamun are NOT in it — a total that
    // included them would have the kitchen plating for a course that is waiting.
    expect(out).toMatch(/^Total Qty {2,}3$/m);
    expect(out).toMatch(/^Hold Qty {2,}3$/m);
  });

  test("a wholly held docket does not claim a total of nothing", () => {
    const out = printed(buildReceiptBase64({
      ...kot, items: [{ name: "Gulab Jamun", quantity: 3, price: 90, held: true }],
    }));
    expect(out).not.toContain("Total Qty");
    expect(out).toMatch(/^Hold Qty {2,}3$/m);
    expect(out).toContain("[Hold]");
  });

  test("a docket with nothing held carries no hold wording anywhere", () => {
    const none: ReceiptOptions = {
      ...kot, items: [{ name: "Paneer Tikka", quantity: 2, price: 200 }, { name: "Naan", quantity: 1, price: 40 }],
    };
    const explicit: ReceiptOptions = {
      ...kot,
      items: [
        { name: "Paneer Tikka", quantity: 2, price: 200, held: false },
        { name: "Naan", quantity: 1, price: 40, held: false },
      ],
    };
    expect(buildReceiptBase64(none)).toBe(buildReceiptBase64(explicit));
    const out = printed(buildReceiptBase64(none));
    expect(out).not.toMatch(/hold/i);
    expect(out).toMatch(/^Total Qty {2,}3$/m);
  });

  test("an empty ticket still prints its total line", () => {
    const out = printed(buildReceiptBase64({ ...kot, items: [] }));
    expect(out).toMatch(/^Total Qty {2,}0$/m);
    expect(out).not.toMatch(/hold/i);
  });

  test("the hold line fits both rolls", () => {
    for (const cols of [48, 32]) {
      const b64 = buildReceiptBase64(kot, cols);
      expect(printed(b64).replace(/\n\s*/g, " ")).toContain("[Hold] Do not cook until fired");
      for (const w of cellWidths(b64)) { expect(w).toBeLessThanOrEqual(cols); }
    }
  });

  test("the hold follows its dish onto the right station's docket", () => {
    const tickets = buildKotBase64({
      ...kot,
      items: [
        { name: "Paneer Tikka", quantity: 2, price: 200, station: "Tandoor" },
        { name: "Gulab Jamun", quantity: 3, price: 90, station: "Sweets", held: true },
        { name: "Naan", quantity: 1, price: 40, station: "Tandoor" },
      ],
    });
    expect(tickets.map((t) => t.station)).toEqual(["Tandoor", "Sweets"]);
    expect(printed(tickets[0]!.escBase64)).not.toMatch(/hold/i);
    expect(printed(tickets[0]!.escBase64)).toMatch(/^Total Qty {2,}3$/m);
    expect(printed(tickets[1]!.escBase64)).toMatch(/^1 {3}Gulab Jamun \.+ x3\n {4}\[Hold\]/m);
    expect(printed(tickets[1]!.escBase64)).toMatch(/^Hold Qty {2,}3$/m);
  });

  test("a reprinted or cancelled docket uses the same under-the-dish hold line", () => {
    for (const variant of [{ reprint: true }, { cancelled: true }]) {
      const lines = printedLines(buildReceiptBase64({ ...kot, ...variant }));
      const dish = at(lines, /Gulab Jamun/);
      expect(lines.slice(0, dish).join("\n")).not.toMatch(/hold/i);
      expect(lines[dish + 1]).toMatch(/^ {4}\[Hold\]/);
    }
  });

  test("a hold is a KITCHEN state and never reaches the guest's bill", () => {
    const bill = printed(buildReceiptBase64({
      ...baseBill, items: [{ name: "Gulab Jamun", quantity: 3, price: 90, held: true }],
    }));
    expect(bill).not.toMatch(/hold/i);
    expect(bill).toContain("Gulab Jamun");
    // And the flag moves no money: the line is charged exactly as it would be.
    expect(bill).toContain("270.00");
  });
});

// --- Type size (item 3) ----------------------------------------------------
// "Dish names should come in bold on KOT, and the font of other items on the
// KOT should also be increased slightly." ESC/POS has no fractional sizes and
// this renderer already uses Font A, so the smallest step up is double HEIGHT
// (ESC ! 0x10), which leaves every cell exactly as wide as before — the column
// arithmetic, and so the qty column, cannot move.
describe("buildReceiptBase64 — KOT, type size", () => {
  const kot: ReceiptOptions = {
    ...baseBill,
    kind: "kot",
    kotNo: 21,
    printedAt: "08/09/26 14:13",
    orderContext: "Running Table",
    serviceMode: "Dine In",
    section: "DOME SECTION",
    table: "33",
    covers: 4,
    assignedTo: "yado",
    captain: "TIYASHA",
    orderNote: "birthday table",
    items: [
      { name: "Subz Tehri", quantity: 1, price: 300 },
      { name: "Ghewar Berry Mousse", quantity: 1, price: 300 },
      { name: "Gaia Rose Cookies", quantity: 1, price: 300, note: "Hold Dessert" },
    ],
  };

  /**
   * Every text run with the `ESC !` mode it was printed in. A run is the text
   * between two commands, so a line split by bold/size switches yields several.
   */
  const runs = (b64: string): { mode: number; bold: boolean; text: string }[] => {
    const raw = decode(b64);
    const out: { mode: number; bold: boolean; text: string }[] = [];
    let mode = 0;
    let bold = false;
    let buf = "";
    const flush = () => { if (buf) { out.push({ mode, bold, text: buf }); buf = ""; } };
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c === "\x1b" && raw[i + 1] === "!") { flush(); mode = raw.charCodeAt(i + 2); i += 2; continue; }
      if (c === "\x1b" && raw[i + 1] === "E") { flush(); bold = raw.charCodeAt(i + 2) === 1; i += 2; continue; }
      if (c === "\x1b" && raw[i + 1] === "a") { flush(); i += 2; continue; }
      if (c === "\x1b" && raw[i + 1] === "@") { flush(); mode = 0; bold = false; i += 1; continue; }
      if (c === "\x1d" && raw[i + 1] === "V") { flush(); i += 2; continue; }
      buf += c;
    }
    flush();
    return out;
  };
  const runOf = (b64: string, needle: string) => {
    const r = runs(b64).find((x) => x.text.includes(needle));
    expect(r).toBeTruthy();
    return r!;
  };

  test("every dish name is wrapped in bold AND the size command, with the bold bit inside it", () => {
    const raw = decode(buildReceiptBase64(kot));
    for (const name of ["Subz Tehri", "Ghewar Berry Mousse", "Gaia Rose Cookies"]) {
      // ESC E 1, ESC ! (tall|bold), name, ESC ! tall, ESC E 0.
      expect(raw).toContain(`\x1bE\x01\x1b!\x18${name}\x1b!\x10\x1bE\x00`);
    }
  });

  test("the other KOT lines print one step larger (double height), not in body size", () => {
    const b64 = buildReceiptBase64(kot);
    for (const needle of [
      "Running Table", "08/09/26 14:13", "Dine In: DOME SECTION", "Persons - 4",
      "Assign to: yado", "Captain: TIYASHA", "birthday table", "No. Item", "[Note] Hold Dessert", "Total Qty",
    ]) {
      const r = runOf(b64, needle);
      expect({ needle, tall: (r.mode & 0x10) === 0x10 }).toEqual({ needle, tall: true });
      // Never double WIDTH — that would halve the columns.
      expect({ needle, wide: (r.mode & 0x20) === 0x20 }).toEqual({ needle, wide: false });
    }
    // The line number rides the same tall row as its dish.
    expect(runOf(b64, "1   ").mode & 0x10).toBe(0x10);
  });

  test("quantities stay bold and double width, and are now double height to match the row", () => {
    const r = runOf(buildReceiptBase64(kot), "x1");
    expect(r.bold).toBe(true);
    expect(r.mode).toBe(0x38);
  });

  test("rules stay at normal height — a doubled rule is just a thicker gap", () => {
    const rules = runs(buildReceiptBase64(kot)).filter((x) => /^-{10,}\n$/.test(x.text));
    expect(rules.length).toBeGreaterThan(2);
    for (const r of rules) { expect(r.mode & 0x10).toBe(0); }
  });

  test("the GUEST's bill does not change size", () => {
    const b64 = buildReceiptBase64(baseBill);
    for (const needle of ["Tea - Earl Grey", "Subtotal", "Total Qty"]) {
      expect(runOf(b64, needle).mode).toBe(0);
    }
  });

  test("no qty-column overflow at 48 or 32 columns, even with long names and big quantities", () => {
    const heavy: ReceiptOptions = {
      ...kot,
      items: [
        { name: "Slow Cooked Lamb Shank Rogan Josh With Saffron Pulao", quantity: 12, price: 500, note: "extra gravy on the side please" },
        { name: "Roti", quantity: 120, price: 10, held: true },
        { name: "Paneer Tikka Butter Masala", quantity: 3, price: 250 },
      ],
    };
    for (const cols of [48, 32]) {
      for (const reprint of [false, true]) {
        const b64 = buildReceiptBase64({ ...heavy, reprint }, cols);
        for (const w of cellWidths(b64)) { expect(w).toBeLessThanOrEqual(cols); }
        // And every qty is flush to the right edge, i.e. in its own column.
        const qtyCol = cols >= 48 ? 8 : 6;
        const rows = printedLines(b64).filter((l) => /x\d+$/.test(l));
        expect(rows).toHaveLength(3);
        const widths = cellWidths(b64);
        const lines = printedLines(b64);
        for (const row of rows) {
          const q = row.match(/x\d+$/)![0];
          expect(widths[lines.indexOf(row)]).toBe(cols);
          expect(row.slice(0, row.length - q.length)).toMatch(/[ .]$/); // a gap before the qty
          expect(q.length * 2 <= qtyCol ? q.length * 2 : q.length).toBeLessThanOrEqual(qtyCol);
        }
      }
    }
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

// ---------------------------------------------------------------------------
// THE ORDER-LEVEL NOTE.
//
// Distinct from ReceiptItem.note, which hangs under one dish. This one is the
// whole-order instruction — the box the owner app captions "Note for the
// kitchen" and the guest QR menu fills with the placeholder "no onions, less
// spicy, allergies" — and until this change it was written to
// "Orders".food.note and then read by NO renderer on ANY path. A waiter typing
// an allergy into a field captioned NOTE FOR THE KITCHEN was talking to nobody.
//
// Two properties are pinned here and they pull in opposite directions, which is
// exactly why both are written down: the note MUST reach the kitchen, on every
// station's docket, and it MUST NOT reach the guest's bill.
describe("buildReceiptBase64 — the order-level note", () => {
  const kotWithNote: ReceiptOptions = {
    ...baseBill,
    kind: "kot",
    kotNo: 26,
    printedAt: "25/08/26 15:23",
    orderContext: "Running Table",
    serviceMode: "Dine In",
    table: "12",
    covers: 2,
    orderNote: "allergy: peanuts",
  };

  test("prints on the kitchen docket, under a banner", () => {
    const out = printed(buildReceiptBase64(kotWithNote));
    expect(out).toContain("** NOTE **");
    expect(out).toContain("allergy: peanuts");
  });

  test("sits ABOVE the item table, because it qualifies every line below it", () => {
    const out = printed(buildReceiptBase64(kotWithNote));
    // "No." heads the numbered item column; the banner must precede it. Hung
    // under a single dish, "no onions" would say the opposite of what it means.
    expect(out.indexOf("allergy: peanuts")).toBeLessThan(out.indexOf("No."));
  });

  test("NEVER prints on the guest bill, even when the field is set", () => {
    // The bill branch does not read the field at all, so this is not a matter
    // of a caller remembering to omit it. Set it and the paper is unchanged.
    const clean = buildReceiptBase64({ ...baseBill, orderNote: null });
    const noted = buildReceiptBase64({ ...baseBill, orderNote: "allergy: peanuts" });
    expect(noted).toBe(clean);
    expect(printed(noted)).not.toContain("allergy");
  });

  test("a docket with no order note is byte-identical to one printed before the field existed", () => {
    const withoutKey = buildReceiptBase64({ ...kotWithNote, orderNote: undefined });
    const withNull = buildReceiptBase64({ ...kotWithNote, orderNote: null });
    const withBlank = buildReceiptBase64({ ...kotWithNote, orderNote: "   " });
    expect(withNull).toBe(withoutKey);
    expect(withBlank).toBe(withoutKey);
    expect(printed(withoutKey)).not.toContain("** NOTE **");
  });

  test("a long note wraps to the paper instead of running off it", () => {
    const long = "no onions no garlic no coriander and the guest is allergic to shellfish please double check every dish";
    for (const cols of [48, 32]) {
      const b64 = buildReceiptBase64({ ...kotWithNote, orderNote: long }, cols);
      for (const w of cellWidths(b64)) { expect(w).toBeLessThanOrEqual(cols); }
      expect(printed(b64).replace(/\n/g, " ")).toContain("shellfish");
    }
  });

  test("rides on EVERY station's docket, not just the first", () => {
    // An allergy is not the hot kitchen's business alone. A bar docket that
    // omits it is the one that pours the wrong thing.
    const tickets = buildKotBase64({
      ...kotWithNote,
      items: [
        { name: "Paneer Tikka", quantity: 1, price: 250, station: "TANDOOR" },
        { name: "Mojito", quantity: 2, price: 180, station: "BAR" },
      ],
    });
    expect(tickets).toHaveLength(2);
    for (const t of tickets) {
      expect(printed(t.escBase64)).toContain("allergy: peanuts");
    }
  });
});

// ---------------------------------------------------------------------------
// THE DISH NAME (A4).
//
// It was the only thing on an item row set in ordinary type: the line number
// had its own column, the quantity was bold AND double width, the headings were
// there to be found — and the words the chef actually cooks from were the
// lightest marks on the row. Bold costs no cells (a bold character is the same
// width), so every column assertion above still measures the same numbers; what
// changes is which part of the row the eye lands on first.
describe("buildReceiptBase64 — KOT, bold dish names", () => {
  const kot: ReceiptOptions = {
    ...baseBill,
    kind: "kot",
    kotNo: 26,
    printedAt: "25/08/26 15:23",
    orderContext: "Running Table",
    serviceMode: "Dine In",
    section: null,
    table: "12",
    covers: 2,
    assignedTo: null,
    captain: null,
    items: [
      { name: "Paneer Tikka", quantity: 2, price: 200 },
      { name: "Naan", quantity: 3, price: 40, note: "no butter" },
    ],
  };

  /**
   * Every substring the renderer emitted inside a bold run, in order, with the
   * `ESC ! n` size commands inside the run removed — a dish name's run is now
   * `ESC ! 0x18 name ESC ! 0x10` (item 3), and those are not printed text.
   */
  const boldRuns = (b64: string): string[] =>
    [...decode(b64).matchAll(/\x1bE\x01([\s\S]*?)\x1bE\x00/g)].map((m) => m[1]!.replace(/\x1b![\s\S]/g, ""));

  test("every dish name is emitted bold", () => {
    const raw = decode(buildReceiptBase64(kot));
    // ESC E 1, then the size command WITH the bold bit (0x18 = tall + bold),
    // because `ESC !` rewrites emphasis — see `big` in escpos.ts.
    expect(raw).toContain("\x1bE\x01\x1b!\x18Paneer Tikka\x1b!\x10\x1bE\x00");
    expect(raw).toContain("\x1bE\x01\x1b!\x18Naan\x1b!\x10\x1bE\x00");
  });

  test("bold costs no cells, so the row keeps the exact layout it always had", () => {
    // The leaders, the qty column and the wrap width are all unchanged — the
    // change is invisible to `printed()`, which is the point: nothing moved.
    for (const cols of [48, 32]) {
      const b64 = buildReceiptBase64(kot, cols);
      expect(printed(b64)).toMatch(/^1 {3}Paneer Tikka \.+ x2$/m);
      for (const w of cellWidths(b64)) { expect(w).toBeLessThanOrEqual(cols); }
    }
  });

  test("the dot leaders are NOT bold — they bridge the gap, they are not the name", () => {
    // A bold leader run reads as part of the dish rather than as the space
    // between the dish and its quantity.
    const runs = boldRuns(buildReceiptBase64(kot));
    expect(runs).toContain("Paneer Tikka");
    expect(runs.join("|")).not.toMatch(/\.{3}/);
  });

  test("a name that wraps is bold on its continuation line too", () => {
    const b64 = buildReceiptBase64({
      ...kot,
      items: [{ name: "Slow Cooked Lamb Shank Rogan Josh With Saffron Pulao", quantity: 1, price: 500 }],
    });
    // The continuation hangs under the item column: four spaces, then the rest
    // of the name. However the wrap fell, it must have been emitted bold — half
    // a bold dish name is worse than none.
    const cont = printedLines(b64).find((l) => /^ {4}[A-Za-z]/.test(l));
    expect(cont).toBeTruthy();
    expect(boldRuns(b64)).toContain(cont!.trim());
  });

  test("a held line's name is bold as well — it is the same row builder", () => {
    const raw = decode(buildReceiptBase64({
      ...kot, items: [{ name: "Gulab Jamun", quantity: 3, price: 90, held: true }],
    }));
    expect(raw).toContain("\x1bE\x01\x1b!\x18Gulab Jamun\x1b!\x10\x1bE\x00");
  });

  test("the kitchen note stays in body text — a docket that shouts everything shouts nothing", () => {
    expect(boldRuns(buildReceiptBase64(kot)).join("|")).not.toContain("no butter");
    expect(printed(buildReceiptBase64(kot))).toMatch(/^ {4}\[Note\] no butter$/m);
  });

  test("the GUEST's bill is untouched — this is a kitchen-legibility change", () => {
    const raw = decode(buildReceiptBase64(baseBill));
    expect(raw).not.toContain("\x1bE\x01Tea - Earl Grey");
    // The only bold run on a bill is still the Grand Total.
    expect(boldRuns(buildReceiptBase64(baseBill)).map((s) => s.trim())).toEqual([
      expect.stringContaining("Grand Total:"),
    ]);
  });
});

// ---------------------------------------------------------------------------
// REPRINTS (A7, G3).
//
// A reprint is indistinguishable from an original once it is off the roll, and
// that is the whole problem: an unmarked second copy of a docket is cooked
// twice, and an unmarked second copy of a bill is paid twice or filed as a
// second sale. A7 asks for the table number, the dish name and the KOT id to be
// larger and bold on a reprinted docket; G3 asks for the word "Reprint" at the
// top of a reprinted bill. Two of A7's three were ALREADY the biggest type the
// printer has, so the only thing that grows is the dish name.
describe("buildReceiptBase64 — reprints", () => {
  const kot: ReceiptOptions = {
    ...baseBill,
    kind: "kot",
    kotNo: 26,
    printedAt: "25/08/26 15:23",
    orderContext: "Running Table",
    serviceMode: "Dine In",
    section: null,
    table: "12",
    covers: 2,
    assignedTo: null,
    captain: null,
    items: [{ name: "Paneer Tikka", quantity: 2, price: 200 }],
  };

  /** Every substring emitted at double WIDTH, whether or not also double height. */
  const widened = (b64: string): string[] =>
    [...decode(b64).matchAll(/\x1b!([\s\S])([^\x1b\x1d]*)/g)]
      .filter((m) => (m[1]!.charCodeAt(0) & 0x20) === 0x20)
      .map((m) => m[2]!.trim())
      .filter(Boolean);

  /** …and at double width AND height, the largest type the printer has. */
  const doubled = (b64: string): string[] =>
    [...decode(b64).matchAll(/\x1b!([\s\S])([^\x1b\x1d]*)/g)]
      .filter((m) => (m[1]!.charCodeAt(0) & 0x30) === 0x30)
      .map((m) => m[2]!.trim())
      .filter(Boolean)
      // Quantities ride a tall row at double width, i.e. the same bits; they are
      // row type, not headings, and a reprinted dish name is the same case.
      .filter((t) => !/^x\d+$/.test(t) && t !== "Paneer Tikka");

  test("G3: a reprinted bill says so before anything else on the roll", () => {
    const lines = printedLines(buildReceiptBase64({ ...baseBill, reprint: true })).filter((l) => l.trim());
    expect(lines[0]).toBe("** REPRINT **");
    expect(lines[1]).toBe("Cafe Nicoise");
  });

  test("G3: the word is the biggest type the printer has, on both rolls", () => {
    for (const cols of [48, 32]) {
      const b64 = buildReceiptBase64({ ...baseBill, reprint: true }, cols);
      // Bold AND double width+height — 13 characters is 26 of the narrow roll's
      // 32 cells, so it survives `big`'s fit guard instead of degrading.
      // 0x38 = double width + height + the bold bit, so bold survives `ESC !`.
      expect(decode(b64)).toContain("\x1bE\x01\x1b!8** REPRINT **");
      for (const w of cellWidths(b64)) { expect(w).toBeLessThanOrEqual(cols); }
    }
  });

  test("G3: it sits ABOVE the logo, because 'the top' of a bill with a tall raster is not below it", () => {
    const logo = Buffer.from([0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 0x01, 0x00, 0xff]);
    const buf = bytes(buildReceiptBase64({ ...baseBill, reprint: true, logo }));
    expect(buf.indexOf(Buffer.from("** REPRINT **", "latin1"))).toBeLessThan(buf.indexOf(logo));
  });

  test("A7: a reprinted docket enlarges the dish name — the one thing not already big", () => {
    const b64 = buildReceiptBase64({ ...kot, reprint: true });
    expect(decode(b64)).toContain("\x1bE\x01\x1b!\x38Paneer Tikka\x1b!\x10\x1bE\x00");
    // All three of A7's fields, large, on the same ticket.
    expect(widened(b64)).toEqual(expect.arrayContaining(["KOT - 26", "Table No: 12", "Paneer Tikka"]));
  });

  test("A7: the table and the KOT id were ALREADY the big type, and still are", () => {
    // `big()` has printed them at double width AND height since the identity
    // block was written. There is no larger type to promote them to.
    expect(doubled(buildReceiptBase64(kot))).toEqual(["KOT - 26", "Table No: 12"]);
    expect(doubled(buildReceiptBase64({ ...kot, reprint: true })))
      .toEqual(["** REPRINT **", "KOT - 26", "Table No: 12"]);
  });

  test("A7: an ordinary docket's dish name is bold but NOT enlarged", () => {
    expect(widened(buildReceiptBase64(kot))).not.toContain("Paneer Tikka");
  });

  test("A7: a doubled name is re-wrapped against half the column, so nothing runs off the roll", () => {
    const long: ReceiptOptions = {
      ...kot,
      reprint: true,
      items: [
        { name: "Slow Cooked Lamb Shank Rogan Josh With Saffron Pulao", quantity: 12, price: 500 },
        { name: "Gulab Jamun With Rabri", quantity: 3, price: 90, held: true },
      ],
    };
    for (const cols of [48, 32]) {
      const b64 = buildReceiptBase64(long, cols);
      // A doubled character eats TWO cells: a character-count guard would call
      // this docket safe while the printer wrapped it mid-word.
      for (const w of cellWidths(b64)) { expect(w).toBeLessThanOrEqual(cols); }
      // Nothing is dropped or truncated to achieve that — it wraps.
      expect(printed(b64).replace(/\n\s*/g, " ")).toContain("Saffron Pulao");
      expect(printed(b64)).toContain("[Hold]");
    }
  });

  test("a docket that is not a reprint is byte-identical to one printed before the flag existed", () => {
    const withoutKey = buildReceiptBase64(kot);
    expect(buildReceiptBase64({ ...kot, reprint: undefined })).toBe(withoutKey);
    expect(buildReceiptBase64({ ...kot, reprint: false })).toBe(withoutKey);
    expect(printed(withoutKey)).not.toContain("REPRINT");
  });

  test("a bill that is not a reprint is byte-identical too", () => {
    const withoutKey = buildReceiptBase64(baseBill);
    expect(buildReceiptBase64({ ...baseBill, reprint: undefined })).toBe(withoutKey);
    expect(buildReceiptBase64({ ...baseBill, reprint: false })).toBe(withoutKey);
    expect(printed(withoutKey)).not.toContain("REPRINT");
  });

  test("every station's copy of a reprinted ticket is marked, not just the first", () => {
    const tickets = buildKotBase64({
      ...kot,
      reprint: true,
      items: [
        { name: "Paneer Tikka", quantity: 1, price: 250, station: "TANDOOR" },
        { name: "Mojito", quantity: 2, price: 180, station: "BAR" },
      ],
    });
    expect(tickets).toHaveLength(2);
    for (const t of tickets) { expect(printed(t.escBase64)).toContain("** REPRINT **"); }
  });
});

// ---------------------------------------------------------------------------
// TOKEN NO. — EVERY KOT NUMBER THAT FED THIS BILL.
//
// From the reference GAIA receipt: "Token No.: 214, 218, 236, 241, 242, 257,
// 272, 277, 298". A table's bill is the sum of several orders, each fired on
// its own ticket, and the number the kitchen called each ticket by is the only
// handle the floor has on "which of these did we send at 8:40" — so the guest's
// copy carries them, and a query at the till is answered from the paper in the
// guest's hand instead of a dashboard search.
describe("buildReceiptBase64 — Token No.", () => {
  const nine = [214, 218, 236, 241, 242, 257, 272, 277, 298];

  /** The Token No. line plus its wrapped continuations, rejoined. */
  const tokenLine = (b64: string): string | null => {
    const lines = printedLines(b64);
    const start = lines.findIndex((l) => l.startsWith("Token No.:"));
    if (start < 0) { return null; }
    let joined = lines[start]!;
    for (let i = start + 1; i < lines.length && /^\d/.test(lines[i]!); i++) { joined += ` ${lines[i]}`; }
    return joined;
  };

  test("lists every ticket, under the Bill No. / Cashier line and above the items", () => {
    const b64 = buildReceiptBase64({ ...baseBill, kotNumbers: [214, 218, 236] });
    const lines = printedLines(b64);
    const at = lines.findIndex((l) => l.startsWith("Token No.:"));
    expect(lines[at]).toBe("Token No.: 214, 218, 236");
    expect(lines.findIndex((l) => l.includes("Bill No.: INV-1"))).toBeLessThan(at);
    expect(lines.findIndex((l) => l.startsWith("Item"))).toBeGreaterThan(at);
  });

  test("nine tokens wrap to the roll, and a wrap never splits a number", () => {
    for (const cols of [48, 32]) {
      const b64 = buildReceiptBase64({ ...baseBill, kotNumbers: nine }, cols);
      for (const w of cellWidths(b64)) { expect(w).toBeLessThanOrEqual(cols); }
      // Rejoined on the single spaces wrapText broke at: exactly the list given.
      expect(tokenLine(b64)).toBe(`Token No.: ${nine.join(", ")}`);
    }
  });

  test("absent, empty, or unusable prints NOTHING — not a bare label", () => {
    // The guarantee every restaurant whose bills have never carried tokens
    // depends on: the paper is byte-identical to what it printed before.
    const clean = buildReceiptBase64(baseBill);
    expect(buildReceiptBase64({ ...baseBill, kotNumbers: undefined })).toBe(clean);
    expect(buildReceiptBase64({ ...baseBill, kotNumbers: [] })).toBe(clean);
    // migration 029 unapplied -> allocateKotNumber returned null, which reaches
    // a JSON round trip as 0 or NaN. "Token No.:" with nothing after it is
    // worse than no line at all, exactly as it is for GSTN and Ph.
    expect(buildReceiptBase64({ ...baseBill, kotNumbers: [0, NaN] })).toBe(clean);
    expect(printed(clean)).not.toContain("Token No.");
  });

  test("one unusable value is dropped from the list, not printed as a hole in it", () => {
    expect(tokenLine(buildReceiptBase64({ ...baseBill, kotNumbers: [214, 0, 236] })))
      .toBe("Token No.: 214, 236");
  });

  test("the renderer does not dedupe — a caller that repeats a ticket has a bug worth seeing", () => {
    // Distinctness is the caller's job: it is the side that knows which orders
    // fed the bill. Tidying a duplicate away here would hide the day a bill
    // double-counted a ticket.
    expect(tokenLine(buildReceiptBase64({ ...baseBill, kotNumbers: [214, 214] })))
      .toBe("Token No.: 214, 214");
  });

  test("the KOT carries no list — the docket IS one of those tickets", () => {
    const kot: ReceiptOptions = { ...baseBill, kind: "kot", kotNo: 26, table: "12" };
    expect(buildReceiptBase64({ ...kot, kotNumbers: nine })).toBe(buildReceiptBase64(kot));
    expect(printed(buildReceiptBase64({ ...kot, kotNumbers: nine }))).not.toContain("Token No.");
  });
});

// ---------------------------------------------------------------------------
// THE CANCELLATION SLIP.
//
// A docket whose job is to STOP food being cooked, read in the same second and
// the same posture as forty ordinary ones. Everything about it is the ordinary
// docket layout on purpose — same ticket number, same table, same dishes —
// because the slip has to be MATCHED against the paper already on the rail, and
// a differently-shaped document is harder to match, not easier. The one
// difference is the word, and it has to be the first thing the eye lands on.
describe("buildReceiptBase64 — a cancelled docket", () => {
  const slip: ReceiptOptions = {
    ...baseBill,
    kind: "kot",
    kotNo: 26,
    table: "12",
    orderContext: "*** REASON: GUEST LEFT ***",
    cancelled: true,
  };

  test("says CANCELLED, in the biggest type on the ticket", () => {
    const out = printed(buildReceiptBase64(slip));
    expect(out).toContain("** CANCELLED **");
    // `big()` doubles the type; on 48 columns the banner fits and stays doubled.
    const raw = decode(buildReceiptBase64(slip));
    expect(raw).toContain("\x1bE\x01\x1b!\x38** CANCELLED **");
  });

  test("the word is ABOVE the context line — below it is already too late", () => {
    // By the time a chef has read "Running Table 12" they are matching dishes.
    const out = printed(buildReceiptBase64(slip));
    const banner = out.indexOf("CANCELLED");
    const context = out.indexOf("REASON");
    // BOTH MUST BE PRESENT BEFORE THEY CAN BE ORDERED. indexOf returns -1 for a
    // missing needle, and -1 is less than every real index — so a bare
    // `toBeLessThan` here PASSES when the banner is absent, which is precisely
    // the regression this test exists to catch. Proven: suppressing the banner
    // left this assertion green.
    expect(banner).toBeGreaterThanOrEqual(0);
    expect(context).toBeGreaterThanOrEqual(0);
    expect(banner).toBeLessThan(context);
  });

  test("and still names the ticket, the table and the dishes", () => {
    // The slip is matched against the docket on the rail. Strip its identity and
    // it becomes a piece of paper saying something is cancelled, somewhere.
    const out = printed(buildReceiptBase64({ ...slip, items: [{ name: "Paneer Tikka", quantity: 2, price: 0 }] }));
    expect(out).toContain("26");
    expect(out).toContain("12");
    expect(out).toContain("Paneer Tikka");
  });

  test("absent, false and undefined are byte-identical to a docket printed before the field existed", () => {
    const withoutKey = buildReceiptBase64({ ...slip, cancelled: undefined });
    expect(buildReceiptBase64({ ...slip, cancelled: false })).toBe(withoutKey);
    expect(printed(withoutKey)).not.toContain("CANCELLED");
  });

  test("a BILL ignores it completely", () => {
    // Cancelling a kitchen ticket is not a thing that happens to a guest's bill,
    // and a CANCELLED banner on a tax document would be read as a refund.
    const clean = buildReceiptBase64({ ...baseBill, cancelled: undefined });
    expect(buildReceiptBase64({ ...baseBill, cancelled: true })).toBe(clean);
  });

  test("it fits the narrow roll", () => {
    for (const cols of [48, 32]) {
      for (const w of cellWidths(buildReceiptBase64(slip, cols))) {
        expect(w).toBeLessThanOrEqual(cols);
      }
    }
  });
});
