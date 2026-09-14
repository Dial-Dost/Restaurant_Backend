import { createHash } from "node:crypto";
import { describe, test, expect } from "@jest/globals";
import {
  BILL_QR_NOTE_MAX,
  DEFAULT_BILL_QR_NOTE,
  billColumns,
  billMarginCols,
  buildReceiptBase64,
  buildKotBase64,
  groupKotItemsByStation,
  type ReceiptOptions,
} from "../escpos";

const decode = (b64: string) => Buffer.from(b64, "base64").toString("latin1");
const bytes = (b64: string) => Buffer.from(b64, "base64");

/**
 * The columns a CUSTOMER BILL's lines are laid out on, per roll.
 *
 * Not the roll width. The 80mm bill sets a two-column margin either side in the
 * printer itself (GS L / GS W), so its print area is 44 of the 48 cells: a
 * 46-character line fits the paper and still wraps, because it does not fit the
 * area the printer was told to print in. The 58mm roll has no margin. KOTs have
 * none either and are measured against the full roll.
 */
const BILL_COLS: Record<number, number> = { 48: 44, 32: 32 };

/** Dots per Font A cell: 576 dots across the 80mm roll's 48 cells. */
const CELL_DOTS = 12;

/**
 * One piece of the ESC/POS stream, in the order the printer reads it.
 *
 * THE STREAM IS PARSED, NOT PATTERN-MATCHED, because a customer bill carries
 * binary images between its lines. Every separator on it is a GS v 0 raster (a
 * solid rule, see billRule in escpos.ts), and a raster's header and body are
 * arbitrary bytes: the height byte of a thin rule is 10, which is "\n", so a
 * latin1 decode split on newlines breaks a "line" in the middle of a rule and
 * leaves hundreds of bytes of ink printed on it. So every command is consumed
 * by its own length — a raster by the width and height in its header, a QR
 * function by its pL pH, GS L / GS W by their two parameter bytes — and nothing
 * inside one can be read as text.
 *
 * A command this parser does not know THROWS rather than being counted as
 * printed cells: an unrecognised parameter byte can be a newline, and a width
 * assertion that silently measured it would pass or fail for the wrong reason.
 * Text reaching the printer is already ASCII-folded (asciiSafe), so an ESC or
 * GS byte is always a command.
 */
type Piece =
  | { kind: "text"; text: string }
  | { kind: "cmd"; op: "ESC @" | "ESC a" | "ESC !" | "ESC E" | "GS V" | "GS L" | "GS W"; n: number }
  | {
    kind: "raster";
    mark: "<RULE>" | "<RULE:THICK>" | "<IMAGE>";
    widthDots: number;
    height: number;
    inkRows: number;
    /** One character per dot row, top to bottom: "." blank, "#" solid, "?" anything else. */
    rows: string;
    /** The eight header bytes, GS v 0 m xL xH yL yH. */
    header: Buffer;
  }
  | { kind: "qr" };
type Raster = Extract<Piece, { kind: "raster" }>;

function pieces(b64: string): Piece[] {
  const buf = bytes(b64);
  const out: Piece[] = [];
  let run = "";
  const flush = () => { if (run) { out.push({ kind: "text", text: run }); run = ""; } };
  const u16 = (at: number) => (buf[at] ?? 0) | ((buf[at + 1] ?? 0) << 8);
  for (let i = 0; i < buf.length;) {
    const b = buf[i]!;
    const op = String.fromCharCode(buf[i + 1] ?? 0);
    if (b === 0x1b) {
      flush();
      if (op === "@") { out.push({ kind: "cmd", op: "ESC @", n: 0 }); i += 2; continue; }
      if (op === "a" || op === "!" || op === "E") { out.push({ kind: "cmd", op: `ESC ${op}`, n: buf[i + 2] ?? 0 }); i += 3; continue; }
      throw new Error(`unparsed command ESC ${JSON.stringify(op)} at byte ${i}`);
    }
    if (b === 0x1d) {
      flush();
      if (op === "V") { out.push({ kind: "cmd", op: "GS V", n: buf[i + 2] ?? 0 }); i += 3; continue; }
      if (op === "L" || op === "W") { out.push({ kind: "cmd", op: `GS ${op}`, n: u16(i + 2) }); i += 4; continue; }
      if (op === "v" && buf[i + 2] === 0x30) {
        // GS v 0 m xL xH yL yH d1...dk, k = widthBytes * height.
        const widthBytes = u16(i + 4);
        const height = u16(i + 6);
        const start = i + 8;
        const end = start + widthBytes * height;
        if (end > buf.length) { throw new Error(`raster at byte ${i} runs past the end of the stream`); }
        // A RULE IS RECOGNISED BY ITS SHAPE, not by asking the renderer's own
        // billRule what one looks like: blank rows, then rows inked solid across
        // the whole width (a partial last byte keeps only its leading bits), then
        // blank rows. Two ink rows is the thin rule and four the thick one;
        // anything else — the logo included — is an image.
        const LEADING_BITS = [0x80, 0xc0, 0xe0, 0xf0, 0xf8, 0xfc, 0xfe, 0xff];
        let rows = "";
        for (let y = 0; y < height; y++) {
          const row = buf.subarray(start + y * widthBytes, start + (y + 1) * widthBytes);
          const blank = row.every((v) => v === 0x00);
          const solid = row.length > 0 && row.subarray(0, -1).every((v) => v === 0xff) && LEADING_BITS.includes(row[row.length - 1]!);
          rows += blank ? "." : solid ? "#" : "?";
        }
        const m = /^\.+(#+)\.+$/.exec(rows);
        const inkRows = m ? m[1]!.length : 0;
        const mark = inkRows === 2 ? "<RULE>" : inkRows === 4 ? "<RULE:THICK>" : "<IMAGE>";
        out.push({ kind: "raster", mark, widthDots: widthBytes * 8, height, inkRows, rows, header: buf.subarray(i, start) });
        i = end;
        continue;
      }
      if (op === "(" && buf[i + 2] === 0x6b) {
        // GS ( k pL pH + (pL + 256 * pH) bytes. A QR is five of these back to
        // back (model, size, error level, data, print): one symbol, one piece.
        if (out[out.length - 1]?.kind !== "qr") { out.push({ kind: "qr" }); }
        i += 5 + u16(i + 3);
        continue;
      }
      throw new Error(`unparsed command GS ${JSON.stringify(op)} at byte ${i}`);
    }
    run += String.fromCharCode(b);
    i += 1;
  }
  flush();
  return out;
}

/** Every raster on the slip, in print order — the logo and each rule. */
const rasters = (b64: string): Raster[] => pieces(b64).flatMap((p) => (p.kind === "raster" ? [p] : []));

/**
 * The receipt as the PAPER shows it: commands removed, so an assertion can talk
 * about lines and their widths without the invisible mode bytes that sit inside
 * them.
 *
 * Needed because the command stream is interleaved with the text — `ESC E 0x00`
 * (bold off) lands between the restaurant name's newline and the rule under it,
 * and `ESC E 0x01` + `ESC ! 0x18` prefix the Grand Total line. Both make a naive
 * substring match miss and a naive `line.length` read too long.
 *
 * Each image prints as ONE MARKER LINE, because on paper it is a band of its
 * own that the next text starts under: "<RULE>" for a thin solid rule,
 * "<RULE:THICK>" for the heavy one around the item table, "<IMAGE>" for any
 * other raster (the logo), and "<QR>" for a QR symbol.
 */
function printed(b64: string): string {
  return pieces(b64).map((p) => {
    if (p.kind === "text") { return p.text; }
    if (p.kind === "raster") { return `${p.mark}\n`; }
    if (p.kind === "qr") { return "<QR>\n"; }
    return "";
  }).join("");
}
const printedLines = (b64: string) => printed(b64).split("\n");

/**
 * How wide each line actually comes out, IN PRINTER CELLS — one entry per line
 * of `printedLines`, so the two can be indexed together.
 *
 * `printed(...).length` counts characters, and characters are not cells: the KOT
 * sets `ESC ! 0x20` (double width) around a quantity and `ESC ! 0x30` around the
 * ticket number and the table, and every character inside those runs occupies
 * TWO columns of the roll. A width assertion that counted characters would call
 * a 58mm docket safe while the printer was wrapping it mid-word — the exact
 * failure the size guards in `big` and the quantity column exist to prevent.
 *
 * A raster's line is as wide as the raster, in cells of CELL_DOTS: a rule drawn
 * wider than the print area runs into the margin exactly as an over-long line
 * does. A QR's line counts nothing — it is sized in modules, and no text shares
 * its line.
 */
function cellWidths(b64: string): number[] {
  const widths: number[] = [];
  let cur = 0;
  let scale = 1;
  for (const p of pieces(b64)) {
    if (p.kind === "cmd") {
      if (p.op === "ESC !") { scale = (p.n & 0x20) ? 2 : 1; }
      if (p.op === "ESC @") { scale = 1; }
      continue;
    }
    if (p.kind === "raster") { widths.push(cur + Math.ceil(p.widthDots / CELL_DOTS)); cur = 0; continue; }
    if (p.kind === "qr") { widths.push(cur); cur = 0; continue; }
    for (const c of p.text) {
      if (c === "\n") { widths.push(cur); cur = 0; } else { cur += scale; }
    }
  }
  if (cur > 0) { widths.push(cur); }
  return widths;
}

/**
 * Every text run with the `ESC !` mode and the `ESC E` emphasis it was printed
 * in. A run is the text between two commands (or images), so a line split by
 * bold/size switches yields several. Built on `pieces`, so a bill's raster
 * rules never leak their bytes into the run of text that follows them.
 */
function runs(b64: string): { mode: number; bold: boolean; text: string }[] {
  const out: { mode: number; bold: boolean; text: string }[] = [];
  let mode = 0;
  let bold = false;
  for (const p of pieces(b64)) {
    if (p.kind === "text") { out.push({ mode, bold, text: p.text }); continue; }
    if (p.kind !== "cmd") { continue; }
    if (p.op === "ESC !") { mode = p.n; }
    if (p.op === "ESC E") { bold = p.n === 1; }
    if (p.op === "ESC @") { mode = 0; bold = false; }
  }
  return out;
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
    // `printed`, not `decode`: the table on the Date row is emitted bold, so an
    // `ESC E` pair sits inside that line.
    const out = printed(buildReceiptBase64(baseBill));
    // "Name:", the client's own wording for the slot — not "Customer Name:".
    expect(out).toMatch(/^Name: Alice$/m);
    expect(out).not.toContain("Customer Name");
    expect(out).toContain("Bill No.: INV-1");
    expect(out).toContain("Cashier: Bob");
    expect(out).toContain("Dine In: 5");
  });

  test("totals: subtotal, discount, service charge, tax, and rounded grand total", () => {
    const out = printed(buildReceiptBase64(baseBill));
    // ₹ maps to the ASCII token "Rs"
    expect(out).toContain("Coupon SAVE20"); // discount label
    expect(out).toMatch(/Coupon SAVE20 +-20\.00$/m);
    // The client's ladder wording: the rate follows the name bare, with no
    // parentheses round it.
    expect(out).toMatch(/Service Charge 5% +4\.00$/m);
    expect(out).toMatch(/GST 5% +4\.20$/m);
    // LEGACY PATH ONLY (no grandTotal supplied): grand = 100 - 20 + 4 + 4.2
    // = 88.2 -> rounded 88, with the round-off line disclosing the -0.20.
    expect(out).toMatch(/Grand Total +Rs 88\.00$/m);
    expect(out).not.toContain("Grand Total:");
    expect(out).toMatch(/Round off +-0\.20$/m);
  });

  test("service charge waiver prints 'Opted-out'", () => {
    const out = printed(buildReceiptBase64({ ...baseBill, serviceCharge: { percent: 10, amount: 0, optedOut: true } }));
    expect(out).toMatch(/Service Charge 10% +Opted-out$/m);
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
    const phone = "080-4123 4567 / +91 98765 43210 / +91 91234 56789";
    for (const cols of [48, 32]) {
      const b64 = buildReceiptBase64({ ...fullHeader, phone }, cols);
      const out = printed(b64);
      expect(out).toContain("Ph : 080-4123 4567");
      expect(out).toContain("91234 56789");
      // Against the bill's print area, not the roll: on 80mm that is 44 cells
      // inside the margins, and 48 characters there would still wrap.
      for (const w of cellWidths(b64)) { expect(w).toBeLessThanOrEqual(BILL_COLS[cols]!); }
    }
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
    // An unnamed guest gets the client's blank "Name:" slot — the label with
    // nothing written after it, exactly as for a walk-in — never the word
    // "null" and never a stand-in name.
    expect(out).toMatch(/^Name:$/m);
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
    // `printed`, not `decode`: the renderer turns bold off (ESC E 0) between the
    // name's newline and the rule under it, and the rule itself is a raster, so
    // the adjacency below is only visible once the command bytes are out of the
    // way and the rule reads as its marker line.
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
    expect(out).toContain("Cafe Nicoise\n<RULE>\n");
  });

  test("blank-but-present fields are treated as absent, not as empty lines", () => {
    const out = printed(buildReceiptBase64({
      ...baseBill,
      legalName: "   ",
      address: "\n  \n",
      gstin: "  ",
    }));
    expect(out).not.toContain("GSTN");
    expect(out).toContain("Cafe Nicoise\n<RULE>\n");
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
    const out = printed(buildReceiptBase64({
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
    expect(out).toMatch(/SGST 2\.5% +19\.00$/m);
    expect(out).toMatch(/CGST 2\.5% +19\.00$/m);
    expect(out).toMatch(/Sub Total +760\.00$/m); // subtotal line still present
    expect(out).toContain("Rs 798.00");
  });

  test("does not invent a split the tenant has not configured", () => {
    const out = printed(buildReceiptBase64({
      ...baseBill,
      taxes: [{ name: "GST", percentage: 5, amount: 4.2 }],
    }));
    expect(out).toMatch(/GST 5% +4\.20$/m);
    expect(out).not.toContain("SGST");
    expect(out).not.toContain("CGST");
  });

  test("a tenant with no taxes configured prints no tax lines at all", () => {
    const out = printed(buildReceiptBase64({ ...baseBill, taxes: [], discount: null, serviceCharge: null, grandTotal: 100 }));
    // No rate anywhere on the slip. (This used to look for "%)", which the
    // ladder no longer prints for anything — a check that could not fail.)
    expect(out).not.toContain("%");
    expect(out).not.toContain("GST");
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

  /**
   * The footer as one run of words. The note is wrapped to the bill's print
   * area, and the built-in valet line (47 characters) is longer than the 44 the
   * 80mm bill prints inside its margins, so it is two lines on BOTH rolls now; a
   * whole-sentence substring check on the raw stream would miss it — and, worse,
   * a NEGATIVE check for it would pass whether or not it printed.
   */
  const words = (b64: string) => printed(b64).replace(/\s+/g, " ");

  test("falls back to the built-in valet line when the tenant has set none", () => {
    for (const note of [undefined, null, "", "   "]) {
      const b64 = buildReceiptBase64({ ...withQr, qrNote: note as string | null | undefined });
      expect(words(b64)).toContain(DEFAULT_BILL_QR_NOTE);
    }
  });

  test("prints the tenant's own sentence instead when one is set", () => {
    const b64 = buildReceiptBase64({ ...withQr, qrNote: "Scan to rate us and call your valet" });
    expect(words(b64)).toContain("Scan to rate us and call your valet");
    expect(words(b64)).not.toContain(DEFAULT_BILL_QR_NOTE);
  });

  test("is truncated to the documented cap rather than flooding the footer", () => {
    const long = "x".repeat(BILL_QR_NOTE_MAX + 50);
    const lines = printedLines(buildReceiptBase64({ ...withQr, qrNote: long }));
    // One unbroken word, so wrapText hard-splits it at the print area. Rejoined,
    // exactly the cap survives — not a character more, not a character less.
    const xs = lines.filter((l) => /^x+$/.test(l));
    expect(xs.join("")).toBe("x".repeat(BILL_QR_NOTE_MAX));
    for (const l of xs) { expect(l.length).toBeLessThanOrEqual(BILL_COLS[48]!); }
  });

  test("wraps to the paper width on 58mm without overflowing the column", () => {
    const note = "Scan the code below to rate your meal and to call the valet to the porch";
    const b64 = buildReceiptBase64({ ...withQr, qrNote: note }, 32);
    // Everything up to the QR. The note is emitted BEFORE it, so every wrapped
    // note line is in here.
    const out = printed(b64).split("<QR>")[0] ?? "";
    // Measured over the WHOLE slip: `cellWidths` steps over the QR's GS ( k
    // payload by its own length, so the feedback URL inside it — longer than the
    // paper is wide — is not mistaken for a printed line.
    for (const w of cellWidths(b64)) {
      expect(w).toBeLessThanOrEqual(32);
    }
    expect(out).toContain("Scan the code below to rate");
    // …and it really did wrap rather than being cut short at the column.
    expect(out).toContain("the porch");
  });

  test("no QR, no note — the message never prints on a bill without a QR", () => {
    const b64 = buildReceiptBase64({ ...baseBill, feedbackUrl: null, qrNote: "Follow us online" });
    expect(words(b64)).not.toContain("Follow us online");
    expect(words(b64)).not.toContain("For calling Valet");
    expect(printed(b64)).not.toContain("<QR>");
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
    expect(out).not.toContain("Sub Total"); // the bill ladder's wording now
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
    // Item 3 is a kitchen change: a bill's lines and its ladder stay body size.
    // (The one tall line a bill has is its Grand Total, which is the client's
    // own layout and is pinned in "the client's reference bill layout".)
    const b64 = buildReceiptBase64(baseBill);
    for (const needle of ["Tea - Earl Grey", "Sub Total", "Total Qty", "Round off"]) {
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
    // A bill spends bold where the client's own bill does — the restaurant
    // name, the table on the Date row, the Grand Total — and never on a dish.
    expect(boldRuns(buildReceiptBase64(baseBill)).map((s) => s.trim())).toEqual([
      "Cafe Nicoise",
      "Dine In: 5",
      expect.stringMatching(/^Grand Total +Rs 88\.00$/),
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
      for (const w of cellWidths(b64)) { expect(w).toBeLessThanOrEqual(BILL_COLS[cols]!); }
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

  test("lists every ticket, under the Cashier / Bill No. line and above the items", () => {
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
      for (const w of cellWidths(b64)) { expect(w).toBeLessThanOrEqual(BILL_COLS[cols]!); }
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

// ---------------------------------------------------------------------------
// THE CLIENT'S REFERENCE BILL.
//
// The owner photographed a real "Gaia - Global Vegetarian" bill and said this is
// how the bill should look — "see the margins and the lines and everything".
// Every block above pins a BEHAVIOUR (no orphan labels, money printed verbatim,
// notes kept off the guest's copy). This one pins the SHAPE, on a slip built
// from that bill's own figures: fifteen lines including its two long dish names,
// a total quantity of 19, a 4745.00 subtotal, SGST and CGST at 2.5% (118.63
// each), a -0.26 round-off and 4982.00 to pay.
//
// What the reference looks like, top to bottom: the logo and a bold restaurant
// name at body size over the address block; a thin rule; the "Name:" slot; a
// thin rule; Date with the table in bold, then Cashier and Bill No., then the
// token list; a THICK rule; "Item Qty. Price Amount"; a THICK rule; the lines; a
// THICK rule; a right-hand ladder whose figures stand under the line amounts; a
// thin rule; the round-off and a tall bold Grand Total; a thin rule; the bold
// service-charge disclaimer; and inside margins on the wide roll throughout.
// ---------------------------------------------------------------------------
describe("the client's reference bill layout", () => {
  const ROLLS = [48, 32];

  /** Per roll: the print area W, the Amount column's width, and the heading row. */
  const LAYOUT: Record<number, { W: number; AMT: number; heading: string }> = {
    48: { W: 44, AMT: 10, heading: `Item${" ".repeat(17)}Qty.${" ".repeat(4)}Price${" ".repeat(4)}Amount` },
    32: { W: 32, AMT: 9, heading: `Item${" ".repeat(7)}Qty.${" ".repeat(3)}Price${" ".repeat(3)}Amount` },
  };

  const items = [
    { name: "Southern Enokii Tempura", quantity: 1, price: 425 },
    { name: "Malabar Parotta - HSN:129", quantity: 3, price: 95 },
    { name: "Burrata & Heirloom Tomato", quantity: 1, price: 495 },
    { name: "Truffle Mushroom Dimsum", quantity: 1, price: 395 },
    { name: "Paneer Tikka", quantity: 2, price: 325 },
    { name: "Dal Makhani", quantity: 1, price: 345 },
    { name: "Jeera Rice", quantity: 1, price: 195 },
    { name: "Avocado Sushi Roll", quantity: 1, price: 425 },
    { name: "Thai Green Curry", quantity: 1, price: 375 },
    { name: "Butter Naan", quantity: 2, price: 75 },
    { name: "Fresh Lime Soda", quantity: 1, price: 125 },
    { name: "Masala Chaas", quantity: 1, price: 95 },
    { name: "Gaia Rose Cookies", quantity: 1, price: 245 },
    { name: "Ghewar Berry Mousse", quantity: 1, price: 295 },
    { name: "Tiramisu", quantity: 1, price: 245 },
  ];
  const disclaimer = "Service charge is voluntary. Please ask your server to remove it if you do not wish to pay it.";
  /**
   * A logo the size bill_logo.ts produces for the 80mm roll (two thirds of 576
   * dots = 384 across), ten rows tall on purpose: its height byte is 0x0a, the
   * newline, so any helper that found lines by splitting the raw stream would
   * break this image in half.
   */
  const logo = Buffer.concat([Buffer.from([0x1d, 0x76, 0x30, 0x00, 48, 0, 10, 0]), Buffer.alloc(48 * 10, 0x55)]);
  const gaia: ReceiptOptions = {
    restaurantName: "Gaia - Global Vegetarian",
    legalName: "NAVKRISH HOSPITALITY LLP",
    address: "12 Mantri Square, 2nd Floor, Sampige Road\nMalleshwaram, Bengaluru 560003",
    phone: "080-4123 4567",
    gstin: "29AAXFN2701Q1ZF",
    logo,
    table: "33",
    covers: 4,
    customer: "Guest",
    billNo: "G-2345",
    cashier: "Riya",
    printedAt: "14/09/26 21:43",
    kotNumbers: [214, 218, 236, 241, 242, 257, 272, 277, 298],
    items,
    total: 4745,
    currency: "₹",
    serviceCharge: { percent: 10, amount: 0, optedOut: true },
    taxes: [
      { name: "SGST", percentage: 2.5, amount: 118.63 },
      { name: "CGST", percentage: 2.5, amount: 118.63 },
    ],
    roundOff: -0.26,
    grandTotal: 4982,
    serviceChargeNote: disclaimer,
    feedbackUrl: "https://example.test/feedback?rid=r1&eid=e1",
    kind: "bill",
  };

  /** For every rule on the slip: [the nearest printed line above, the rule, the nearest below]. */
  const aroundRules = (lines: string[]) => lines.flatMap((l, i) => {
    if (!l.startsWith("<RULE")) { return []; }
    let above = i - 1;
    while (above >= 0 && !lines[above]!.trim()) { above--; }
    let below = i + 1;
    while (below < lines.length && !lines[below]!.trim()) { below++; }
    return [[lines[above] ?? "", l, lines[below] ?? ""]];
  });

  test("the fixture carries the reference bill's own arithmetic", () => {
    // So a failure below is the renderer's, never a typo in the fixture.
    expect(items).toHaveLength(15);
    expect(items.reduce((s, it) => s + it.quantity, 0)).toBe(19);
    expect(items.reduce((s, it) => s + it.quantity * it.price, 0)).toBe(4745);
    const paise = (n: number) => Math.round(n * 100);
    const taxes = (gaia.taxes ?? []).reduce((s, t) => s + paise(t.amount), 0);
    expect(paise(gaia.total) + taxes + paise(gaia.roundOff ?? 0)).toBe(paise(gaia.grandTotal ?? 0));
  });

  test("the 80mm bill sets its margins in the printer; the 58mm bill sets none", () => {
    const marginCmds = (b64: string) => pieces(b64)
      .flatMap((p) => (p.kind === "cmd" && (p.op === "GS L" || p.op === "GS W") ? [`${p.op} ${p.n}`] : []));
    // ESC @, then GS L 24 dots (two cells) and GS W 528 dots (44 cells), before
    // anything prints — at the start of a line, where both are honoured.
    const wide = buildReceiptBase64(gaia, 48);
    expect([...bytes(wide).subarray(0, 10)]).toEqual([0x1b, 0x40, 0x1d, 0x4c, 24, 0, 0x1d, 0x57, 0x10, 0x02]);
    expect(marginCmds(wide)).toEqual(["GS L 24", "GS W 528"]);
    // The narrow roll has no column to spare: straight from ESC @ to centring.
    const narrow = buildReceiptBase64(gaia, 32);
    expect([...bytes(narrow).subarray(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x61, 0x01]);
    expect(marginCmds(narrow)).toEqual([]);
    // The kitchen docket keeps the whole roll, bill fields or not.
    expect(marginCmds(buildReceiptBase64({ ...gaia, kind: "kot" }, 48))).toEqual([]);
    // The exported helpers say the same thing as the bytes.
    expect(billMarginCols(48)).toBe(2);
    expect(billMarginCols(32)).toBe(0);
    expect(billColumns(44)).toEqual({ COL_ITEM: 20, COL_QTY: 5, COL_PRICE: 9, COL_TOTAL: 10 });
    expect(billColumns(32)).toEqual({ COL_ITEM: 11, COL_QTY: 4, COL_PRICE: 8, COL_TOTAL: 9 });
  });

  test("every separator is a solid rule across the print area — never a row of hyphens", () => {
    for (const cols of ROLLS) {
      const { W } = LAYOUT[cols]!;
      for (const opts of [gaia, baseBill, { ...gaia, splitPart: { index: 1, of: 2, label: "Bar" } }]) {
        // Hyphens survive only where they are words: "Gaia - Global", "-0.26".
        expect(printed(buildReceiptBase64(opts, cols))).not.toMatch(/-{3,}/);
      }
      const [first, ...rules] = rasters(buildReceiptBase64(gaia, cols));
      // The logo passes through untouched, and is not mistaken for a rule.
      expect(first).toMatchObject({ mark: "<IMAGE>", widthDots: 384, height: 10 });
      expect(rules.map((r) => r.mark)).toEqual([
        "<RULE>", "<RULE>", "<RULE:THICK>", "<RULE:THICK>", "<RULE:THICK>", "<RULE>", "<RULE>", "<RULE>",
      ]);
      for (const r of rules) {
        // Exactly the print area across: W cells of 12 dots, so it lines up with
        // the text above it and stops at the margin, not the paper edge...
        expect(r.widthDots).toBe(W * CELL_DOTS);
        // ...ink centred in four blank rows either side: two rows thin, four thick.
        expect(r.rows).toBe(r.mark === "<RULE>" ? "....##...." : "....####....");
        expect([...r.header]).toEqual([0x1d, 0x76, 0x30, 0x00, (W * CELL_DOTS) / 8, 0, r.rows.length, 0]);
      }
    }
  });

  test("the rules fall exactly where the client's bill draws them", () => {
    for (const cols of ROLLS) {
      const { heading } = LAYOUT[cols]!;
      const lines = printedLines(buildReceiptBase64(gaia, cols));
      // The logo first, then the name under it.
      expect(lines.filter((l) => l.trim()).slice(0, 2)).toEqual(["<IMAGE>", "Gaia - Global Vegetarian"]);
      expect(aroundRules(lines)).toEqual([
        // thin: the header block closes
        ["GSTN : 29AAXFN2701Q1ZF", "<RULE>", "Name:"],
        // thin: the Name slot is boxed on its own
        ["Name:", "<RULE>", expect.stringMatching(/^Date: /)],
        // THICK: the meta block closes and the item table opens...
        [expect.stringMatching(/277, 298$/), "<RULE:THICK>", heading],
        // THICK: ...under its headings...
        [heading, "<RULE:THICK>", expect.stringMatching(/^Southern /)],
        // THICK: ...and closes under the last line
        [expect.stringMatching(/^Tiramisu +1 +245\.00 +245\.00$/), "<RULE:THICK>", expect.stringMatching(/Total Qty: 19/)],
        // thin: the ladder closes above the round-off
        [expect.stringMatching(/CGST 2\.5% +118\.63$/), "<RULE>", expect.stringMatching(/Round off +-0\.26$/)],
        // thin: the Grand Total is boxed off from the footer
        [expect.stringMatching(/Grand Total +Rs 4982\.00$/), "<RULE>", expect.stringMatching(/^Service charge is voluntary/)],
        // thin: the disclaimer and the QR invitation are two statements
        [expect.stringMatching(/pay it\.$/), "<RULE>", expect.stringMatching(/^For calling Valet/)],
      ]);

      // A split part's banner is boxed between the header rule and the Name slot.
      const part = printedLines(buildReceiptBase64({ ...gaia, splitPart: { index: 1, of: 2, label: "Bar" } }, cols));
      expect(aroundRules(part).slice(0, 3)).toEqual([
        ["GSTN : 29AAXFN2701Q1ZF", "<RULE>", "** PART 1/2 **"],
        ["Bar - Table 33", "<RULE>", "Name:"],
        ["Name:", "<RULE>", expect.stringMatching(/^Date: /)],
      ]);

      // No disclaimer, no rule under nothing: the QR note follows the Grand
      // Total's rule directly.
      const plain = aroundRules(printedLines(buildReceiptBase64({ ...gaia, serviceChargeNote: null }, cols)));
      expect(plain).toHaveLength(7);
      expect(plain[6]).toEqual([expect.stringMatching(/Grand Total/), "<RULE>", expect.stringMatching(/^For calling Valet/)]);
    }
  });

  test("the item table carries the client's headings, each figure right-aligned under its own", () => {
    for (const cols of ROLLS) {
      const { W, AMT, heading } = LAYOUT[cols]!;
      const { COL_ITEM } = billColumns(W);
      const lines = printedLines(buildReceiptBase64(gaia, cols));
      expect(heading).toHaveLength(W);
      expect(lines).toContain(heading);
      // Not the old "Item Qty Price Total".
      expect(lines.join("\n")).not.toMatch(/^Item +Qty +Price +Total$/m);

      // Fifteen rows with figures, each exactly the print area wide, their
      // amounts in order.
      const top = lines.indexOf(heading) + 2;
      const bottom = lines.indexOf("<RULE:THICK>", top);
      const rows = lines.slice(top, bottom).filter((l) => /\d\.\d\d$/.test(l));
      expect(rows.map((r) => r.slice(-AMT).trim())).toEqual(items.map((it) => (it.price * it.quantity).toFixed(2)));
      for (const r of rows) { expect(r).toHaveLength(W); }

      // The quantity ends where "Qty." ends, the price where "Price" ends.
      const endOf = (needle: string) => heading.indexOf(needle) + needle.length;
      const malabar = rows.find((r) => r.startsWith("Malabar"))!;
      expect(malabar.slice(0, endOf("Qty."))).toMatch(/ 3$/);
      expect(malabar.slice(0, endOf("Price"))).toMatch(/ 95\.00$/);
      expect(malabar).toMatch(/ 285\.00$/);

      // The two long names wrap INSIDE the Item column and continue under it —
      // whole, and without pushing a figure along.
      for (const name of ["Southern Enokii Tempura", "Malabar Parotta - HSN:129"]) {
        const at = lines.findIndex((l) => l.startsWith(name.split(" ")[0]!));
        const parts = [lines[at]!.slice(0, COL_ITEM).trim()];
        for (let i = at + 1; !/\d\.\d\d$/.test(lines[i]!) && !lines[i]!.startsWith("<"); i++) {
          expect(lines[i]!.length).toBeLessThan(COL_ITEM);
          parts.push(lines[i]!);
        }
        expect(parts.length).toBeGreaterThan(1);
        expect(parts.join(" ")).toBe(name);
      }
    }
  });

  test("Date left with the table bold on the right; Cashier left with Bill No. right", () => {
    for (const cols of ROLLS) {
      const { W } = LAYOUT[cols]!;
      const b64 = buildReceiptBase64(gaia, cols);
      const lines = printedLines(b64);
      const date = lines.findIndex((l) => l.startsWith("Date: "));
      expect(lines[date]).toMatch(/^Date: 14\/09\/26 21:43 +Dine In: 33$/);
      expect(lines[date]).toHaveLength(W);
      // Bold is ESC E alone — no size change, so the row keeps its columns.
      expect(decode(b64)).toContain("\x1bE\x01Dine In: 33\x1bE\x00");
      // The client's order: who took the money on the left, the bill on the right.
      expect(lines[date + 1]).toMatch(/^Cashier: Riya +Bill No\.: G-2345$/);
      expect(lines[date + 1]).toHaveLength(W);
    }
    // Either one alone prints alone, with no bare label for the other.
    const billOnly = printed(buildReceiptBase64({ ...gaia, cashier: null }));
    expect(billOnly).toMatch(/^Bill No\.: G-2345$/m);
    expect(billOnly).not.toContain("Cashier");
    const cashierOnly = printed(buildReceiptBase64({ ...gaia, billNo: null }));
    expect(cashierOnly).toMatch(/^Cashier: Riya$/m);
    expect(cashierOnly).not.toContain("Bill No");
  });

  test("a walk-in's Name slot is left blank; a name the guest gave fills it", () => {
    // "Guest" is the ordering flows' placeholder for nobody-gave-a-name. On the
    // client's bill that slot is an empty "Name:", so it is here.
    for (const customer of ["Guest", "QR Guest", "guest", "", "   ", null, undefined, "null"]) {
      const lines = printedLines(buildReceiptBase64({ ...gaia, customer }));
      const at = lines.findIndex((l) => l.startsWith("Name:"));
      expect({ customer, slot: lines[at], next: lines[at + 1] }).toEqual({ customer, slot: "Name:", next: "<RULE>" });
    }
    // Only the placeholder is blanked: a party whose name merely starts with the
    // word keeps it.
    expect(printedLines(buildReceiptBase64({ ...gaia, customer: "Aarav Mehta" }))).toContain("Name: Aarav Mehta");
    expect(printedLines(buildReceiptBase64({ ...gaia, customer: "Guest House Pvt Ltd" }))).toContain("Name: Guest House Pvt Ltd");
    // A corporate party's GSTIN sits directly under the name, inside the same box.
    const corporate = printedLines(buildReceiptBase64({ ...gaia, customer: "Acme Foods", customerGstin: "29ABCDE1234F1Z5" }));
    const at = corporate.indexOf("Name: Acme Foods");
    expect(corporate.slice(at, at + 3)).toEqual(["Name: Acme Foods", "Customer GSTIN: 29ABCDE1234F1Z5", "<RULE>"]);
    expect(corporate.join("\n")).not.toContain("Customer Name");
  });

  test("the restaurant name is bold at body size — the logo above it already names the restaurant", () => {
    for (const cols of ROLLS) {
      const b64 = buildReceiptBase64(gaia, cols);
      expect(decode(b64)).toContain("\x1bE\x01Gaia - Global Vegetarian\n\x1bE\x00");
      expect(runs(b64).find((r) => r.text.includes("Gaia - Global Vegetarian"))).toEqual({
        mode: 0, bold: true, text: "Gaia - Global Vegetarian\n",
      });
      // Nothing on an ordinary bill is double WIDTH: every `ESC !` is body size
      // or the Grand Total's tall-and-bold 0x18.
      const sizes = pieces(b64).flatMap((p) => (p.kind === "cmd" && p.op === "ESC !" ? [p.n] : []));
      expect([...new Set(sizes)].sort((a, b) => a - b)).toEqual([0x00, 0x18]);

      // A name too long for one line wraps to the print area, bold on every line.
      const long = "Gaia - Global Vegetarian Kitchen, Rooftop Bar and Private Dining";
      const wrapped = buildReceiptBase64({ ...gaia, restaurantName: long, logo: null }, cols);
      const nameRuns: string[] = [];
      for (const r of runs(wrapped)) { if (!r.bold) { break; } nameRuns.push(r.text); }
      expect(nameRuns.length).toBeGreaterThan(1);
      expect(nameRuns.join("").replace(/\n/g, " ").trim()).toBe(long);
      for (const r of nameRuns) { expect(r.trimEnd().length).toBeLessThanOrEqual(LAYOUT[cols]!.W); }
    }
  });

  test("the ladder: ONE label edge for every rung, figures ending under the item amounts", () => {
    for (const cols of ROLLS) {
      const { W, AMT } = LAYOUT[cols]!;
      const lines = printedLines(buildReceiptBase64(gaia, cols));
      // The amount column is sized ONCE, to the widest figure on the ladder
      // (never narrower than the item table's Amount column), so every label
      // ends on the same column. On this bill the widest is "Rs 4982.00".
      const EDGE = W - Math.max(AMT, "Rs 4982.00".length + 1);
      /** The rung carrying `label` and ending in `figure`: where its label ends, where its figure starts and ends. */
      const rung = (label: string, figure: string) => {
        const row = lines.find((l) => l.includes(label) && l.trimEnd().endsWith(figure));
        expect({ label, figure, found: row !== undefined }).toEqual({ label, figure, found: true });
        const r = row!.trimEnd();
        return { labelEnd: r.indexOf(label) + label.length, figureStart: r.length - figure.length, figureEnd: r.length };
      };
      // The item amounts end at the print area's right edge (pinned above)...
      for (const [label, figure] of [["Sub Total", "4745.00"], ["SGST 2.5%", "118.63"], ["CGST 2.5%", "118.63"], ["Round off", "-0.26"], ["Grand Total", "Rs 4982.00"]] as const) {
        const r = rung(label, figure);
        // ...so every figure of the ladder ends in that same column,
        expect({ label, figureEnd: r.figureEnd }).toEqual({ label, figureEnd: W });
        // ...right of the shared label edge, with a space between (a figure
        // wider than the Amount column, like the grand total, widens it for
        // every rung rather than touching its label),
        expect(r.figureStart).toBeGreaterThanOrEqual(EDGE + 1);
        // ...and its label ends on the ONE shared edge — Grand Total included,
        // which sizing each row on its own figure used to push a column left.
        expect({ label, labelEnd: r.labelEnd }).toEqual({ label, labelEnd: EDGE });
      }
      // A word wider than a figure ("Opted-out" is nine characters, the narrow
      // roll's whole Amount column) still ends at the edge, and keeps a space
      // before it rather than running into its label.
      const sc = rung("Service Charge 10%", "Opted-out");
      expect(sc.figureEnd).toBe(W);
      expect(sc.figureStart - sc.labelEnd).toBeGreaterThanOrEqual(1);
      // No parentheses round a rate any more.
      expect(lines.join("\n")).not.toMatch(/\(\d/);
    }
  });

  test("Total Qty shares the Sub Total row where it fits, and takes its own row where it does not", () => {
    // 80mm: one row, as on the client's bill.
    expect(printedLines(buildReceiptBase64(gaia, 48))).toContainEqual(
      expect.stringMatching(/^ +Total Qty: 19 {3}Sub Total +4745\.00$/),
    );
    // 58mm: "Total Qty: 19   Sub Total" and a figure do not fit 32 columns, so
    // the quantity takes the row above — right-aligned against the Amount
    // column like every other label — instead of being wrapped by the printer.
    const { W, AMT } = LAYOUT[32]!;
    const narrow = printedLines(buildReceiptBase64(gaia, 32));
    const q = narrow.findIndex((l) => l.trim() === "Total Qty: 19");
    expect(q).toBeGreaterThanOrEqual(0);
    // On the shared ladder edge (see the ladder test): the widest figure here
    // is the grand total, "Rs 4982.00".
    expect(narrow[q]!.trimEnd()).toHaveLength(W - Math.max(AMT, "Rs 4982.00".length + 1));
    expect(narrow[q + 1]).toMatch(/^ +Sub Total +4745\.00$/);
  });

  test("a discount is a rung like the others, its minus sign against the figure", () => {
    for (const cols of ROLLS) {
      const { W } = LAYOUT[cols]!;
      const out = printed(buildReceiptBase64({ ...gaia, discount: { amount: 500, label: "Loyalty 10%" } }, cols));
      expect(out).toMatch(/^ +Loyalty 10% +-500\.00$/m);
      expect(out).not.toContain("- 500.00");
      const row = out.split("\n").find((l) => l.includes("Loyalty"))!;
      expect(row).toHaveLength(W);
      // Between the subtotal and the service charge, where it comes off.
      expect(out.indexOf("Sub Total")).toBeGreaterThanOrEqual(0);
      expect(out.indexOf("Loyalty")).toBeGreaterThan(out.indexOf("Sub Total"));
      expect(out.indexOf("Service Charge")).toBeGreaterThan(out.indexOf("Loyalty"));
    }
  });

  test("Grand Total: no colon, bold and double HEIGHT, its figure at the right edge", () => {
    for (const cols of ROLLS) {
      const { W } = LAYOUT[cols]!;
      const b64 = buildReceiptBase64(gaia, cols);
      const row = printedLines(b64).find((l) => l.includes("Grand Total"))!;
      expect(row).toMatch(/^ +Grand Total +Rs 4982\.00$/);
      expect(row).toHaveLength(W);
      expect(printed(b64)).not.toContain("Grand Total:");
      // ESC E 1, then ESC ! 0x18 — double height with the bold bit inside it,
      // and never double width, which would halve the columns — then the row,
      // and both reset straight after it.
      expect(decode(b64)).toContain(`\x1bE\x01\x1b!\x18${row}\n\x1b!\x00\x1bE\x00`);
      // It is the one tall line on the slip.
      expect(runs(b64).filter((r) => r.mode !== 0).map((r) => r.text.trim())).toEqual([row.trim()]);
    }
  });

  test("the footer: the disclaimer first and bold, then the QR note, then the QR — and no Thanks", () => {
    for (const cols of ROLLS) {
      const b64 = buildReceiptBase64(gaia, cols);
      const flat = printed(b64).replace(/\s+/g, " ");
      const at = (s: string) => {
        const i = flat.indexOf(s);
        // Present before ordered: -1 is less than every real index.
        expect({ s, present: i >= 0 }).toEqual({ s, present: true });
        return i;
      };
      expect(at("Rs 4982.00")).toBeLessThan(at(disclaimer));
      expect(at(disclaimer)).toBeLessThan(at("For calling Valet kindly scan the below QR code"));
      expect(at("For calling Valet kindly scan the below QR code")).toBeLessThan(at("<QR>"));
      // The disclaimer is emphasised; the invitation under it is not.
      const boldText = runs(b64).filter((r) => r.bold).map((r) => r.text).join("").replace(/\s+/g, " ");
      expect(boldText).toContain(disclaimer);
      expect(boldText).not.toContain("For calling Valet");
      // The client's bill has no sign-off line.
      expect(flat).not.toMatch(/thank/i);
    }
    // With no QR the disclaimer is the last thing printed, under the Grand
    // Total's rule, with no rule dangling after it.
    const noQr = printedLines(buildReceiptBase64({ ...gaia, feedbackUrl: null }));
    const last = noQr.lastIndexOf("<RULE>");
    expect(noQr[last - 1]).toMatch(/Grand Total/);
    expect(noQr.slice(last + 1).join(" ").replace(/\s+/g, " ").trim()).toBe(disclaimer);
    expect(noQr).not.toContain("<QR>");
  });

  test("every line of the reference bill fits the print area on both rolls", () => {
    // The reference slip, and a harder one: a reprint of a two-digit split part
    // for a long corporate name, with a discount and a custom QR note.
    const heavy: ReceiptOptions = {
      ...gaia,
      reprint: true,
      splitPart: { index: 10, of: 12, label: "Rooftop Bar" },
      customer: "Aarav Mehta for Northwind Traders Private Limited",
      customerGstin: "29ABCDE1234F1Z5",
      discount: { amount: 500, label: "Corporate discount 10%" },
      qrNote: "Scan to rate your meal and to call the valet to the porch",
    };
    for (const cols of ROLLS) {
      const { W } = LAYOUT[cols]!;
      for (const opts of [gaia, heavy]) {
        const widths = cellWidths(buildReceiptBase64(opts, cols));
        // In CELLS, so the double-size REPRINT and PART banners count double.
        for (const w of widths) { expect(w).toBeLessThanOrEqual(W); }
        // And laid out TO the print area rather than short of it: the rules and
        // the item rows are exactly W.
        expect(Math.max(...widths)).toBe(W);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// THE KITCHEN DOCKET DID NOT MOVE.
//
// The reference-bill change reworked the separators, the margins, the name's
// size and half the labels — all behind `isKot` checks inside the one renderer
// the docket shares, where a slip of a condition changes the kitchen's paper
// too. A docket is matched against the rail by its shape, and a kitchen that has
// learned where to look should not have to learn again because the guest's bill
// was redesigned. So the docket is pinned to the BYTE.
//
// The digests below were produced by rendering these exact fixtures with the
// escpos.ts committed before the bill change (067cb12), NOT with the renderer
// under test — a golden taken from the code it guards only agrees with itself.
// Each is "<byte length>:<sha256>". When the docket is changed ON PURPOSE,
// compare the printed output of the old and new renderer for these fixtures,
// and only then re-pin the digests from the new one.
// ---------------------------------------------------------------------------
describe("buildReceiptBase64 — the KOT is byte-identical to the docket before the bill layout changed", () => {
  const docket: ReceiptOptions = {
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
    captain: "TIYASHA",
    items: [
      { name: "Paneer Tikka", quantity: 2, price: 200, variation: "Half" },
      { name: "Slow Cooked Lamb Shank Rogan Josh With Saffron Pulao", quantity: 12, price: 500, note: "extra gravy on the side please" },
      { name: "Gulab Jamun", quantity: 3, price: 90, held: true, note: "fire with dessert course" },
      { name: "Roti", quantity: 120, price: 10 },
    ],
  };
  /** Every bill-only field set, so a docket that started reading one would show. */
  const billFields: Partial<ReceiptOptions> = {
    legalName: "NAVKRISH HOSPITALITY LLP",
    address: "12 Mantri Square\n2nd Floor, Sampige Road",
    phone: "080-4123 4567",
    gstin: "29AAXFN2701Q1ZF",
    customer: "Guest",
    customerGstin: "29ABCDE1234F1Z5",
    kotNumbers: [214, 218, 236],
    splitPart: { index: 1, of: 2, label: "Bar" },
    grandTotal: 4982,
    roundOff: -0.26,
    feedbackUrl: "https://example.test/feedback?rid=r1",
    qrNote: "Scan to rate us",
    serviceChargeNote: "A voluntary service charge is included to support our staff",
  };
  const logo = Buffer.from([0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 0x01, 0x00, 0xff]);
  const variants: [string, ReceiptOptions, number][] = [
    ["the ordinary docket, 80mm", docket, 48],
    ["the ordinary docket, 58mm", docket, 32],
    ["a reprint with an order note, 80mm", { ...docket, reprint: true, orderNote: "allergy: peanuts, no onions in anything" }, 48],
    ["a reprint with an order note, 58mm", { ...docket, reprint: true, orderNote: "allergy: peanuts, no onions in anything" }, 32],
    ["a cancellation slip for a takeaway table", { ...docket, cancelled: true, table: "Swiggy-88214-Delivery", section: null, orderContext: "*** REASON: GUEST LEFT ***" }, 32],
    ["an unnumbered, unassigned, empty ticket with a logo", { ...docket, kotNo: null, assignedTo: null, captain: null, section: null, items: [], logo }, 48],
    ["a docket carrying every bill-only field", { ...docket, ...billFields }, 48],
    ["a docket carrying every bill-only field, 58mm", { ...docket, ...billFields, reprint: true }, 32],
  ];
  const stations: ReceiptOptions = {
    ...docket,
    items: [
      { name: "Paneer Tikka", quantity: 2, price: 200, station: "Tandoor" },
      { name: "Mojito", quantity: 2, price: 180, station: "BAR" },
      { name: "Gulab Jamun", quantity: 3, price: 90, station: "Sweets", held: true },
    ],
  };

  const GOLDEN: Record<string, string> = {
    "the ordinary docket, 80mm": "1157:17637d426f2b3cc1c2024e49034c98b119355593f7863a17418aa584a09ed7cd",
    "the ordinary docket, 58mm": "1012:2884bcc98935a7fa3e7bc6a630824809423e68eb11161133d84703114088dc14",
    "a reprint with an order note, 80mm": "1348:7b12d90862f7c1ea6f47a00a16f139bdd25ef1d6c70e1ea53b35155216e2bc2c",
    "a reprint with an order note, 58mm": "1312:70cb3eb42ee058356b5ab565134fe463fd0ac8809d0c940e91f628bdc0b25c55",
    "a cancellation slip for a takeaway table": "1131:0fcdad49884d4a6cca63a9ede91dc079ab2fe146e2eaa768dda2bc02ac80bdbf",
    "an unnumbered, unassigned, empty ticket with a logo": "518:1255fb20bd25735d1d3d50b69d4cd87d3742a1836a414bf18ccf2e9f53fb15e4",
    "a docket carrying every bill-only field": "1157:17637d426f2b3cc1c2024e49034c98b119355593f7863a17418aa584a09ed7cd",
    "a docket carrying every bill-only field, 58mm": "1204:5f1061a226a7c9dd86abf461f2354f863319b291632aa7e095ccbef645e7b96b",
    "per-station Tandoor, 48 columns": "710:5d0c567d42a6455ff9878d895ef2a767423c2ff45e5d8d68d521eed9cb5d9923",
    "per-station BAR, 48 columns": "706:076170af2362911dd3c3dae8a6b9dbee47fa3386114ce670c93246b0bcb3a85d",
    "per-station Sweets, 48 columns": "750:5ba29a23495fff9cac1c875cebdc424906c281ff28ac5b5b6834686198cf93ca",
    "per-station Tandoor, 32 columns": "566:6f626540f1fafe62ba940907e45d6fca00bf3d2f171380c8a6333f3e8e3d5e0a",
    "per-station BAR, 32 columns": "562:6d3413f4645b38dcc4334ea0ef3a5b60f1006494d77b848c206f12b877f5672e",
    "per-station Sweets, 32 columns": "616:1127f6fc781d66130eb08c14f066dec303a2107c4bca640b091937cad7733436",
  };

  const digest = (b64: string) => {
    const buf = bytes(b64);
    return `${buf.length}:${createHash("sha256").update(buf).digest("hex")}`;
  };

  test("every docket variant matches the committed renderer's bytes", () => {
    const actual: Record<string, string> = {};
    for (const [name, opts, cols] of variants) { actual[name] = digest(buildReceiptBase64(opts, cols)); }
    for (const cols of [48, 32]) {
      for (const t of buildKotBase64(stations, cols)) { actual[`per-station ${t.station}, ${cols} columns`] = digest(t.escBase64); }
    }
    // One object, so a failure names every variant that moved at once.
    expect(actual).toEqual(GOLDEN);
  });

  test("a docket reads no bill-only field, on either roll", () => {
    for (const cols of [48, 32]) {
      expect(buildReceiptBase64({ ...docket, ...billFields }, cols)).toBe(buildReceiptBase64(docket, cols));
    }
  });

  test("a docket carries none of the bill's new printer furniture", () => {
    for (const [name, opts, cols] of variants) {
      const ps = pieces(buildReceiptBase64(opts, cols));
      // No margins, no rules: its separators are still its dashed rows...
      expect({ name, margins: ps.some((p) => p.kind === "cmd" && (p.op === "GS L" || p.op === "GS W")) }).toEqual({ name, margins: false });
      expect({ name, rules: ps.some((p) => p.kind === "raster" && p.mark !== "<IMAGE>") }).toEqual({ name, rules: false });
      expect(printed(buildReceiptBase64(opts, cols))).toMatch(new RegExp(`^-{${cols}}$`, "m"));
    }
  });
});
