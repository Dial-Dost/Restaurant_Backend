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
    expect(out).toContain("* allergy: peanuts");
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
      return out.filter(Boolean);
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
    // The note is indented past the No. column so the numbers stay a clean run.
    expect(out).toMatch(/^ {4}\* no butter$/m);
    // Total quantity, as the reference prints it: 2 + 3.
    expect(out).toMatch(/^Total Qty {2,}5$/m);
    // …and every quantity really is emitted bold and double width, which is what
    // makes it findable without reading the row. `x2` as plain text would
    // satisfy the regex above and none of the point of the change.
    const raw = decode(b64);
    expect(raw).toContain("\x1bE\x01\x1b!\x20x2\x1b!\x00\x1bE\x00");
    expect(raw).toContain("\x1bE\x01\x1b!\x20x3\x1b!\x00\x1bE\x00");
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
// THE DEFECT THIS CLOSES. Hold-and-fire worked everywhere except on the paper
// the kitchen cooks from: a held dish sat in the same numbered list as
// everything else, so it was cooked, and the feature was defeated by its own
// docket. A marker beside the name would not have been enough either — a docket
// is read at a glance, and a line that has to be READ to be excluded gets cooked
// by the third ticket of a busy service.
describe("buildReceiptBase64 — KOT, held courses", () => {
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

  test("held lines are lifted out of the cook-now list entirely", () => {
    const out = printed(buildReceiptBase64(kot));
    const lines = out.split("\n");
    const banner = lines.findIndex((l) => l.includes("** HOLD **"));
    expect(banner).toBeGreaterThan(-1);
    const above = lines.slice(0, banner).join("\n");
    const below = lines.slice(banner).join("\n");
    // Everything above the banner is cook it now.
    expect(above).toContain("Paneer Tikka");
    expect(above).toContain("Naan");
    expect(above).not.toContain("Gulab Jamun");
    // Everything below it is not the kitchen's yet.
    expect(below).toContain("Gulab Jamun");
    expect(below).toContain("DO NOT COOK UNTIL FIRED");
  });

  test("the banner is the biggest type on the ticket, alongside the ticket and table", () => {
    // Bold and double size, so it is caught by the eye rather than read.
    expect(decode(buildReceiptBase64(kot))).toContain("\x1bE\x01\x1b!0** HOLD **\n\x1b!\x00\x1bE\x00");
  });

  test("Total Qty counts only what the kitchen may cook, and the hold is totalled apart", () => {
    const out = printed(buildReceiptBase64(kot));
    // 2 Paneer + 1 Naan. The three Gulab Jamun are NOT in it — a total that
    // included them would have the kitchen plating for a course that is waiting.
    expect(out).toMatch(/^Total Qty {2,}3$/m);
    expect(out).toMatch(/^Hold Qty {2,}3$/m);
  });

  test("held lines carry their own H-numbering so the pass can call one out", () => {
    const out = printed(buildReceiptBase64({
      ...kot,
      items: [
        { name: "Paneer Tikka", quantity: 2, price: 200 },
        { name: "Gulab Jamun", quantity: 3, price: 90, held: true },
        { name: "Ice Cream", quantity: 1, price: 80, held: true },
      ],
    }));
    // The cook-now list numbers from 1; the hold list numbers from H1, so
    // "fire H2" cannot be heard as "fire 2".
    expect(out).toMatch(/^1 {3}Paneer Tikka \.+ x2$/m);
    expect(out).toMatch(/^H1 {2}Gulab Jamun \.+ x3$/m);
    expect(out).toMatch(/^H2 {2}Ice Cream \.+ x1$/m);
  });

  test("a held line keeps its kitchen note — that is the reader it was written for", () => {
    const out = printed(buildReceiptBase64({
      ...kot,
      items: [{ name: "Souffle", quantity: 1, price: 300, held: true, note: "fire with dessert course" }],
    }));
    expect(out).toContain("* fire with dessert course");
  });

  test("a wholly held docket does not claim a total of nothing", () => {
    const out = printed(buildReceiptBase64({
      ...kot, items: [{ name: "Gulab Jamun", quantity: 3, price: 90, held: true }],
    }));
    // "Total Qty 0" above a full hold block invites the reading that there is
    // nothing on this ticket at all.
    expect(out).not.toContain("Total Qty");
    expect(out).toMatch(/^Hold Qty {2,}3$/m);
    expect(out).toContain("** HOLD **");
  });

  test("a docket with nothing held is exactly the docket it was before the feature", () => {
    // The guarantee every restaurant that does not hold courses depends on:
    // the `held` key is the ONLY thing that can produce a hold block, and its
    // absence produces paper byte-identical to an explicit `held: false`.
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
    expect(out).not.toContain("HOLD");
    expect(out).not.toContain("Hold Qty");
    expect(out).toMatch(/^Total Qty {2,}3$/m);
  });

  test("an empty ticket still prints its total line, exactly as it always did", () => {
    // buildKotBase64 emits a deliberately item-less General docket when there is
    // nothing to print. Suppressing "Total Qty" there would change paper that
    // has nothing to do with holds.
    const out = printed(buildReceiptBase64({ ...kot, items: [] }));
    expect(out).toMatch(/^Total Qty {2,}0$/m);
    expect(out).not.toContain("HOLD");
  });

  test("the hold block fits the narrow roll too", () => {
    const b64 = buildReceiptBase64(kot, 32);
    const out = printed(b64);
    expect(out).toContain("** HOLD **");
    expect(out).toContain("DO NOT COOK UNTIL FIRED");
    // 10 characters at double width is 20 of the 32 cells — it survives the
    // narrow paper at full size rather than degrading like a longer phrase.
    expect(decode(b64)).toContain("\x1b!0** HOLD **");
    for (const w of cellWidths(b64)) {expect(w).toBeLessThanOrEqual(32);}
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
    // The tandoor is cooking; only the sweets section is holding.
    expect(printed(tickets[0]!.escBase64)).not.toContain("HOLD");
    expect(printed(tickets[0]!.escBase64)).toMatch(/^Total Qty {2,}3$/m);
    expect(printed(tickets[1]!.escBase64)).toContain("** HOLD **");
    expect(printed(tickets[1]!.escBase64)).toMatch(/^Hold Qty {2,}3$/m);
  });

  test("a hold is a KITCHEN state and never reaches the guest's bill", () => {
    const bill = printed(buildReceiptBase64({
      ...baseBill, items: [{ name: "Gulab Jamun", quantity: 3, price: 90, held: true }],
    }));
    expect(bill).not.toContain("HOLD");
    expect(bill).not.toContain("Hold Qty");
    expect(bill).toContain("Gulab Jamun");
    // And the flag moves no money: the line is charged exactly as it would be.
    expect(bill).toContain("270.00");
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
