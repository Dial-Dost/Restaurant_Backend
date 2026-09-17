// Builds an ESC/POS thermal receipt and returns it base64-encoded — consumed by
// the printer agent (a standalone Windows app that listens for `bill:print`
// { billId, escBase64 } and sends the raw bytes to the default thermal printer
// via the Windows RAW spooler). The layout mirrors the web dashboard's printable
// bill (src/app/dashboard/orders/print/page.tsx `generateEscPos`) so the final
// bill looks the same whether printed from the web or pushed to the agent.

/**
 * THE ONE IMPORT THIS FILE HAS, and it is data rather than behaviour: a
 * generated table of 1-bit glyph bitmaps (scripts/build_kot_glyph_atlas.ts).
 * It has no logic to disagree with, no dependency of its own, and cannot form a
 * cycle — which is what keeps the rule this file has otherwise kept, that a
 * renderer must not be able to reach a database, a request or a clock.
 */
import { KOT_ATLAS, type KotFace, type KotGlyph } from "./kot_glyph_atlas.js";
// The banner a bill that REPLACES an out-of-date paper carries (client items 1 and 2).
import { UPDATED_BILL_MARKER } from "./bill_paper_digest.js";

const ESC = 0x1b;
const GS = 0x1d;

// `ESC ! n` print-mode bits (Epson ESC/POS). One command sets ALL of them, so a
// size change that leaves MODE_BOLD out also switches emphasis off — see `big`.
// Bit 0 (Font B) is never set: every line here is Font A, the larger font.
//
// ON A KITCHEN DOCKET TALL AND WIDE ONLY EVER TRAVEL TOGETHER. A cell doubled
// in one direction is a letter stretched out of shape — the classic docket's
// double-height body text is exactly what the client sent back as "elongated
// and stretched vertically". So every KOT size command is 1x1 or 2x2: 0x00,
// MODE_BOLD, MODE_BIG, or MODE_BIG | MODE_BOLD. escpos.test.ts scans every
// classic docket for anything else. (The bill keeps its tall bold Grand Total:
// that is the client's own bill, not a KOT.)
const MODE_BOLD = 0x08; // emphasized
const MODE_TALL = 0x10; // double height
const MODE_WIDE = 0x20; // double width
/** Double width AND height — the only enlarged size a KOT uses. */
const MODE_BIG = MODE_TALL | MODE_WIDE;

export interface ReceiptItem {
  name: string;
  quantity: number;
  price: number;
  note?: string;
  station?: string | null;
  /**
   * The price point sold, when the dish has any (migration 039) — "Half",
   * "Large", "Bottle". Absent on every line of every restaurant that has
   * configured no variations, which is what keeps their dockets and bills
   * byte-identical to the ones printed before the feature existed.
   *
   * It is the label SNAPSHOTTED ON THE ORDER LINE, not the live one: paper is a
   * record of what the guest was offered, and a variation renamed next month
   * must not rewrite last month's bill. (A report prefers the live label — a
   * different question, asked by a different reader. See attributeOrderLine.)
   */
  variation?: string | null;
  /**
   * BILL ONLY: this line was comped (migration 034) — served, and not charged.
   *
   * It prints as "<dish> (NC)" with its unit price and an Amount of 0.00, so the
   * Amount column adds up to the Sub Total the guest is charged. Before this
   * flag reached the renderer an NC line printed at full price, and a bill with
   * one comped dessert listed more money than its own Sub Total. The value given
   * away is disclosed once, under the total, as "NC value (not charged)".
   *
   * Absent/false on every line of a bill with no comps, which is what keeps
   * those bills byte-identical to the ones printed before it existed.
   */
  nc?: boolean;
  /**
   * KOT ONLY: this line is on COURSE HOLD and must not be cooked yet.
   *
   * Hold-and-fire has worked in the app since it shipped — a held line is dimmed
   * on the KDS and its prep timer does not start — but the paper said nothing,
   * so the kitchen cooked it anyway and the feature was defeated by its own
   * docket. A held line therefore prints an indented "[Hold]" line directly
   * UNDER the dish, in the slot a kitchen note uses, and is kept out of the
   * cook-now Total Qty (see the KOT item block below).
   *
   * Absent/false on every line of every restaurant that never holds a course,
   * which is what keeps their dockets identical to the ones printed before this
   * existed. The BILL ignores it completely: what the guest owes has nothing to
   * do with when the kitchen was told to start.
   */
  held?: boolean;
}

/**
 * What goes on the paper for one line: the dish, and the price point when there
 * is one. ONE helper so the kitchen docket and the customer bill can never
 * disagree about which thing was sold — a docket that says "Half" beside a bill
 * that says only "Paneer Tikka" is how a ₹150 line gets queried at the till.
 */
function itemLabel(it: ReceiptItem): string {
  const variation = String(it.variation ?? "").trim();
  return variation ? `${it.name} (${variation})` : it.name;
}

export interface ReceiptTax { name: string; percentage: number; amount: number }

/**
 * The sentence printed above the feedback/valet QR when the tenant has not set
 * their own. It is the EXACT text this renderer hardcoded before `qrNote`
 * existed, so a restaurant that never opens the setting sees no change at all.
 */
export const DEFAULT_BILL_QR_NOTE = "For calling Valet kindly scan the below QR code";

/**
 * Cap on a tenant's custom QR note.
 *
 * Chosen against the NARROW paper, not the wide one: 120 characters wraps to at
 * most 4 lines on 58mm/32-col and 3 inside the 44-column text area of the 80mm
 * bill. That is long enough for a real two-sentence instruction ("Scan to rate
 * us and call your valet — your feedback goes straight to the owner.") and
 * short enough that it cannot push the QR itself off a short tail of paper
 * below the service-charge disclaimer that precedes it.
 */
export const BILL_QR_NOTE_MAX = 120;

export interface ReceiptOptions {
  restaurantName: string;
  // Registered legal entity behind the trading name (e.g. "NAVKRISH
  // HOSPITALITY LLP"), printed under the restaurant name. Omitted entirely when
  // the tenant has not set one — never an empty line.
  legalName?: string | null;
  // Outlet address, printed under the name. Newlines in the stored value are
  // honoured as hard line breaks; each resulting line is then word-wrapped to
  // the paper width.
  address?: string | null;
  // Tax registration number, printed as "GSTN : <value>". A tenant with no
  // GSTIN prints a clean receipt — no label, no blank line.
  gstin?: string | null;
  // Outlet contact number ("Outlets".outlet_main_ph), printed as "Ph : <value>"
  // between the address and the GSTIN — where an Indian tax invoice carries it,
  // and the line a guest looks for to ring the restaurant back about the bill in
  // their hand. Same rule as every other identity field: absent when unset.
  phone?: string | null;
  table: string;
  covers: number;
  items: ReceiptItem[];
  total: number;
  currency: string;
  // Bill meta (bill view only) — printed in the header block like the web bill.
  customer?: string | null;
  /**
   * BILL ONLY (round 2 item 1): the corporate party's GSTIN, printed as
   * "Customer GSTIN: <value>" directly under the "Name:" slot that
   * sits between the restaurant header and the date block. Pre-normalized by the caller (customer_gstin.ts).
   * Absent prints NOTHING — the same rule `gstin` obeys for the restaurant's own.
   */
  customerGstin?: string | null;
  billNo?: string | null;
  cashier?: string | null;
  /**
   * BILL ONLY: every KOT number that fed this bill, in allocation order —
   * printed as "Token No.: 214, 218, 236, ..." under the Cashier/Bill No. line,
   * where the reference GAIA receipt carries it.
   *
   * A table's bill is the sum of SEVERAL orders, each fired on its own ticket,
   * and the number the kitchen called each ticket by is the only handle the
   * floor has on "which of these did we send at 8:40". Printing them on the
   * guest's copy is what lets a query at the till be answered from the paper in
   * the guest's hand instead of a dashboard search.
   *
   * PRE-RESOLVED BY THE CALLER, like every other number on this document: the
   * renderer does not know which orders fed the bill, and it does NOT dedupe
   * the list either — a caller that supplies the same ticket twice has a bug
   * that must stay visible rather than be tidied away behind the printer. Only
   * unusable values are dropped (a null, a zero, a NaN from an unapplied
   * migration 029), which is the same rule `kotNo` obeys on the docket.
   *
   * Absent or empty prints NOTHING — not a bare "Token No.:" label. A
   * restaurant whose bills have never carried tokens must see byte-identical
   * paper.
   */
  kotNumbers?: number[];
  // Optional discount line (off the subtotal), shown before service charge.
  discount?: { amount: number; label?: string } | null;
  // Optional service charge line (amount + percent), shown before taxes, and
  // ONLY when an amount above zero is charged. A charge that was removed (a
  // recorded waiver, a zero-amount part) prints no line at all — the client's
  // decision: "don't show service charge opted out when removed". The recorded
  // waiver, its audit line and the MIS report still say it happened; the guest's
  // bill reads like a bill with no charge, because it is one.
  serviceCharge?: { percent: number; amount: number } | null;
  // Optional tax breakdown. When present, the receipt shows a Sub Total line,
  // each tax line, and a tax-inclusive TOTAL (= total + service charge + taxes).
  taxes?: ReceiptTax[];
  /**
   * KOT ONLY: this docket is a CANCELLATION SLIP — the ticket it names is off,
   * and nothing on it is to be cooked.
   *
   * It prints "CANCELLED" in the largest type the printer has, as the first
   * thing under the restaurant name and ABOVE the context line, because that is
   * where a chef's eye lands on a docket pulled off a rail. Everything else on
   * the slip is deliberately the ORDINARY docket layout — the same ticket
   * number, the same table, the same dish names — because the whole job of this
   * piece of paper is to be matched against the one already on the rail, and a
   * differently-shaped document is harder to match, not easier.
   *
   * Absent or false prints nothing and renders byte-identically to any docket
   * printed before this field existed.
   */
  cancelled?: boolean;
  /**
   * KOT ONLY: WHICH DOCKET THIS IS, and the owner's escape hatch from the one
   * that needs a raster.
   *
   * "reference" (and absent) draws the client's reference docket. "classic"
   * prints the ESC/POS TEXT docket this renderer has always produced — which is
   * what a kitchen printer that ignores `GS v 0` needs, because such a printer
   * answers a raster docket with BLANK PAPER rather than an error, and a blank
   * ticket on the pass is an order nobody cooks.
   *
   * RESOLVED BY THE CALLER, never by this file: it is the restaurant's
   * "Restaurant".kot_print_style setting, read once per docket in
   * kot_print.ts:dispatchKot and handed down. Same division of labour as every
   * other pre-resolved field here — the renderer holds no clock, no counter and
   * no settings.
   *
   * THE UNION IS SPELLED OUT rather than imported, so the only thing this file
   * imports stays its glyph data; kot_print_style.ts is its other half
   * (KotPrintStyle), kotPrintStyleOf below reads it, and a source
   * guard in jest-tests/kot_print_style.test.ts fails if the two ever drift.
   * They must not: a renderer that stops recognising "classic" would put every
   * escape-hatch kitchen back on blank paper, silently.
   *
   * ABSENT IS THE REFERENCE DOCKET, the same answer a NULL column, a missing
   * column and an unrecognised value all get. A BILL IGNORES THIS FIELD.
   */
  kotPrintStyle?: "reference" | "classic";
  /**
   * KOT ONLY, REFERENCE DOCKET ONLY: HOW BIG ITS TYPE IS.
   *
   * "Restaurant".kot_text_size — 'small', 'standard' (the client's reference
   * ticket, and what absent means) or 'large'. Resolved once per docket by
   * kot_print.ts:dispatchKot, exactly like kotPrintStyle above, and read here
   * by kotTextSizeOf; the dots-per-em each word means is KOT_BODY_PPEM.
   *
   * THE CLASSIC TEXT DOCKET IGNORES IT, byte for byte: that docket is set in the
   * printer's own font, and the owner who switched to it did so because their
   * printer cannot draw ours. A BILL IGNORES IT TOO.
   *
   * Spelled out rather than imported for the reason kotPrintStyle is; the same
   * source guard in jest-tests/kot_print_style.test.ts holds this union against
   * KOT_TEXT_SIZES in kot_print_style.ts.
   */
  kotTextSize?: "small" | "standard" | "large";
  kind?: "bill" | "kot";
  // KOT only: the kitchen station/zone this ticket is for. When set, it is
  // printed in the header so a per-station split ticket is self-identifying.
  station?: string | null;
  /**
   * THIS PAPER IS A SECOND COPY OF A DOCUMENT THAT WAS ALREADY PRINTED.
   *
   * A reprint is indistinguishable from an original once it is off the roll,
   * and that is the whole problem: a reprinted docket that looks like a fresh
   * one gets cooked a second time, and a reprinted bill that looks like an
   * original gets paid a second time or filed as a second sale. So a reprint
   * says so, in the largest type the printer has, at the very top of the paper
   * — before the logo, because "at the top" of a bill with a tall raster logo
   * is not "below the logo".
   *
   * On a KOT it additionally enlarges the dish name (see `dishName` in the item
   * block). The other two things A7 asks to enlarge — the table number and the
   * KOT id — are ALREADY the biggest type on every docket, reprint or not.
   *
   * Absent/false renders exactly what this renderer rendered before the flag
   * existed, down to the byte.
   */
  reprint?: boolean;
  /**
   * THIS BILL REPLACES AN EARLIER PAPER THAT SAID SOMETHING ELSE (client items
   * 1 and 2, migration 055) — the pre-resolved line under the banner,
   * "Replaces the bill printed 13:32" (bill_paper_digest.ts replacesBillLine).
   *
   * A copy of a bill that has since grown is not a copy, and "** REPRINT **"
   * on it would tell a guest holding two papers that they are the same. So set,
   * it takes the REPRINT banner's place with "** UPDATED BILL **" and this line
   * under it. A BILL ONLY: a kitchen docket ignores it. Absent, null or "" is
   * byte-identical to a bill printed before the field existed.
   */
  revisedNote?: string | null;

  // --- KOT header (all optional; each line is omitted when unknown) ---------
  //
  // These are all PRE-RESOLVED by the caller and printed verbatim. The renderer
  // holds no clock, no timezone and no counter — same division of labour as the
  // money fields above, and for the same reason: a second, independent
  // derivation in the renderer is how a printed ticket comes to disagree with
  // the one the system thinks it issued.

  // The day-scoped Kitchen Order Ticket number, allocated by
  // kot_numbers.ts:allocateKotNumber. Null when numbering is unavailable
  // (migration 029 unapplied) — the ticket then prints with no "KOT - n" line
  // rather than a misleading one.
  kotNo?: number | null;
  // Printing date AND time, ALREADY FORMATTED IN THE RESTAURANT'S ZONE
  // ("DD/MM/YY HH:mm", from kot_numbers.ts:kotStamp). Falls back to the server
  // clock only when absent, which is what every ticket did before this field.
  printedAt?: string | null;
  // The top context line — "Running Table" for a physical table, the channel for
  // a virtual takeaway/delivery one (kot_numbers.ts:kotOrderContext).
  orderContext?: string | null;
  // "Dine In" / "Takeaway" / "Delivery (Swiggy)" … (kot_numbers.ts:serviceModeLabel).
  serviceMode?: string | null;
  // Floor section the table sits in ("Tables".section), printed as the value of
  // the service-mode line so the kitchen knows where the food is going.
  section?: string | null;
  // The waiter the table is assigned to, and the captain over it. Both come from
  // GetTableFeedbackContext; the captain line is printed only when that
  // employee's role actually is captain/manager, never as a duplicate label.
  assignedTo?: string | null;
  captain?: string | null;
  /**
   * KOT ONLY: the ORDER-LEVEL note — the whole-order instruction, as distinct
   * from the per-dish `ReceiptItem.note` beside each line.
   *
   * THIS IS A BUG FIX AND THE BUG WAS THAT IT PRINTED NOWHERE. Both clients
   * have offered this box since ordering existed, the owner app captions it
   * "Note for the kitchen (e.g. no onions)" and the guest QR menu's placeholder
   * reads "no onions, less spicy, allergies" — and the string went into
   * "Orders".food.note, was described in the writer as "kitchen + bill", and
   * was then read by no renderer on any path. A waiter typing an allergy into a
   * field captioned NOTE FOR THE KITCHEN was talking to nobody.
   *
   * PRINTED ABOVE THE ITEMS, NOT BESIDE THEM, because it qualifies all of them:
   * "no onions" on the order means every dish, and hanging it under one line
   * would say the opposite. It goes on EVERY station's docket of the ticket for
   * the same reason — an allergy is not the hot kitchen's business alone, and a
   * bar docket that omits it is the one that pours the wrong thing.
   *
   * NOT ON THE BILL, under the same rule as the item note (see the block in the
   * bill item loop): its reader is the chef. The bill branch never reads this
   * field, so a guest's copy cannot grow one.
   */
  orderNote?: string | null;
  // The bill's grand total, AS THE BILLING LAYER COMPUTED IT.
  //
  // When present it is printed verbatim and NOTHING is recomputed or rounded
  // here: the renderer's job is to show the number the guest is actually
  // charged, and a second rounding in the renderer is how a printed total comes
  // to disagree with the settled one. When absent the legacy path below still
  // derives and whole-rupee-rounds a total, so callers that predate this field
  // keep their exact present behaviour.
  grandTotal?: number | null;
  /**
   * THE ROUND-OFF THE BILLING LAYER ALREADY COMPUTED — disclosed, never created.
   *
   * Printed immediately above a SUPPLIED grand total, and only when it is
   * non-zero, so the rungs a guest can add up on the paper reach the number they
   * are asked to pay. The total itself is still printed verbatim and nothing
   * here is re-rounded: this line reports a difference, it does not make one.
   *
   * Since migration 048 a whole bill carries one: computeBillCharges rounds
   * the grand total to the rupee and hands back the adjustment, and /print/bill
   * and the settled reprint pass it straight through — "Round off -0.26" above
   * "Grand Total 4982.00", as on the client's own receipt. A bill that was
   * already whole (or was settled before rounding) passes 0 and prints exactly
   * what it always did. A SPLIT PART carries its own share, and a part that
   * silently swallowed it would be a slip whose own lines do not sum to its own
   * total.
   */
  roundOff?: number | null;
  /**
   * BILL ONLY: this slip is ONE PART OF A SPLIT BILL, not the whole thing.
   *
   * Two slips handed across the same table are the same document in every
   * respect a guest can see — same restaurant, same bill number, same date, same
   * table — so without this block they cannot be told apart, and "is this yours
   * or mine" has no answer on the paper. It says which part this is, of how
   * many, and which table they came from.
   *
   * Set ONLY when there is more than one part. A table whose whole bill is a
   * single section is not a split: it is that table's ordinary bill and must
   * print as one, byte for byte. See buildSplitReceiptsBase64, which owns that
   * rule so no caller has to remember it.
   */
  splitPart?: { index: number; of: number; label?: string | null } | null;
  /**
   * BILL ONLY: this bill was SETTLED AS NON-CHARGEABLE (payment_method 'NC',
   * migration 052). Printed under the total, which is 0.00, so the paper says
   * why it is 0.00 and on whose say-so: "Settled: Non-chargeable — <kind>" and
   * "Authorised by: <user>". `wouldHaveCharged` is what the guest would have
   * paid, service charge and tax included — information only, printed when the
   * caller knows it, never part of the ladder.
   *
   * Absent on every other bill. The reprint reads it back from the settled bill.
   */
  settlement?: { kind: string; authorisedBy: string; wouldHaveCharged?: number | null } | null;
  // When set (bill only), prints a "scan to rate" QR code linking to the
  // feedback form for the waiter who handled this table.
  feedbackUrl?: string | null;
  // Per-restaurant sentence printed above that QR. Blank/absent falls back to
  // DEFAULT_BILL_QR_NOTE; anything longer than BILL_QR_NOTE_MAX is truncated.
  qrNote?: string | null;
  // Raw ESC/POS bytes for a logo raster (GS v 0 …), prepended centered at the
  // top. Built server-side from the restaurant's PNG/SVG bill logo.
  logo?: Buffer | null;
  // Voluntary service-charge disclaimer printed in the footer (bill only).
  serviceChargeNote?: string | null;
}

// Native ESC/POS QR code (GS ( k). Works on virtually all modern thermal
// printers and avoids shipping a raster bitmap. `size` is the module (dot) size
// 1..16; 6 prints a comfortably scannable ~3cm code on 58/80mm paper.
function escposQr(data: string, size = 6): Buffer {
  const bytes = Buffer.from(data, "latin1"); // feedback URLs are ASCII
  const store = bytes.length + 3; // cn + fn + m bytes precede the data
  const pL = store & 0xff;
  const pH = (store >> 8) & 0xff;
  return Buffer.concat([
    Buffer.from([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]), // model 2
    Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, size]),       // module size
    Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]),       // error correction M
    Buffer.from([GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30]),           // store data
    bytes,
    Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]),       // print
  ]);
}

// ESC/POS text is emitted as single bytes (latin1). Anything outside ASCII would
// be truncated to a wrong/control byte (e.g. an em-dash U+2014 -> 0x14) and print
// as garbage or corrupt the command stream. Fold common typographic characters to
// ASCII, strip diacritics, and replace any remaining non-ASCII with '?' so output
// is predictable on every printer (handles Devanagari names, smart quotes, etc.).
function asciiSafe(s: string): string {
  return String(s ?? "")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/₹/g, "Rs")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "?"); // keep tab/LF/CR + printable ASCII
}

// ₹ and other symbols aren't in the default ESC/POS code page; render a safe
// ASCII fallback so amounts print correctly on any thermal printer.
function currencyToken(sym: string): string {
  const s = (sym ?? "").trim();
  if (s === "₹" || s.toLowerCase() === "inr") {return "Rs";}
  if (s === "€") {return "EUR";}
  if (s === "£") {return "GBP";}
  // Keep simple ASCII symbols ($), otherwise fall back to the code.
  return /^[\x20-\x7e]{1,4}$/.test(s) ? s : "";
}

// Left text + right text on one line, right-aligned within `width` columns.
function twoCol(left: string, right: string, width: number): string {
  const l = left.toString();
  const r = right.toString();
  if (l.length + r.length >= width) {
    const maxLeft = Math.max(0, width - r.length - 1);
    return l.slice(0, maxLeft) + " " + r;
  }
  return l + " ".repeat(width - l.length - r.length) + r;
}

// Word-wrap `text` to lines of at most `maxLen` chars (mirrors the web wrapText).
function wrapText(text: string, maxLen: number): string[] {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + (cur ? " " : "") + w).length > maxLen) {
      if (cur) {lines.push(cur);}
      // A single word longer than the column is hard-split.
      if (w.length > maxLen) {
        let rest = w;
        while (rest.length > maxLen) {
          lines.push(rest.slice(0, maxLen));
          rest = rest.slice(maxLen);
        }
        cur = rest;
      } else {
        cur = w;
      }
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) {lines.push(cur);}
  return lines.length ? lines : [""];
}

// A stored address is one text field that owners fill in with real line breaks
// ("12 Mantri Square\n2nd Floor\nMalleshwaram, Bengaluru 560003"). Honour those
// as hard breaks and word-wrap each resulting line to the paper width, so the
// printed address keeps the shape the owner typed instead of reflowing into one
// blob. Blank lines are dropped so a trailing newline never prints as a gap.
function addressLines(address: string, width: number): string[] {
  return String(address ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => wrapText(l, width));
}

/**
 * A header field prints only when the tenant actually has one.
 *
 * "null" AND "undefined" COUNT AS UNSET. A JS null that has been through a
 * template literal, a form field, a CSV import or an older client's JSON body
 * arrives here as the four-letter STRING "null" — and a `String(v ?? "")` guard
 * does not catch a string. The bill is a tax document: a receipt that reads
 * `GSTN : null` or `Ph : undefined` is worse than one that carries no such line
 * at all, because it looks like a filed value rather than a missing one. There
 * is no legitimate restaurant whose address, phone, GSTIN, waiter or floor
 * section is literally spelled "null", so the trade is free.
 */
function present(v: string | null | undefined): string {
  const s = String(v ?? "").trim();
  return s.toLowerCase() === "null" || s.toLowerCase() === "undefined" ? "" : s;
}

/** Printer dots per Font A column — 576 dots / 48 columns on the 80mm roll. */
export const DOTS_PER_COL = 12;

/**
 * Text columns of white kept either side of a CUSTOMER BILL, per roll.
 *
 * The client's printed bill sits inside visible margins — the rules and the
 * right-hand money column stop well short of the paper edge. Edge-to-edge text
 * on an 80mm roll reads as cramped and loses its last character to a printer
 * whose head is a dot or two narrower than nominal. The 58mm roll gets none:
 * at 32 columns every one is already spoken for by the item table.
 *
 * KOTs are untouched. A docket is read at arm's length on a rail, and its
 * layout was tuned column by column for that — see the KOT item block.
 */
export function billMarginCols(width: number): number {
  return width >= 48 ? 2 : 0;
}

/**
 * The bill's item-table columns for a text area of `textWidth` — Item, Qty.,
 * Price, Amount — summing exactly to it. The totals ladder right-aligns on the
 * same Amount column, so the figures of the ladder sit under the line amounts.
 */
export function billColumns(textWidth: number): { COL_ITEM: number; COL_QTY: number; COL_PRICE: number; COL_TOTAL: number } {
  const wide = textWidth >= 40;
  const COL_QTY = wide ? 5 : 4;
  const COL_PRICE = wide ? 9 : 8;
  const COL_TOTAL = wide ? 10 : 9;
  const COL_ITEM = Math.max(8, textWidth - COL_QTY - COL_PRICE - COL_TOTAL);
  return { COL_ITEM, COL_QTY, COL_PRICE, COL_TOTAL };
}

/**
 * A SOLID RULE, as a raster — the lines on the client's bill are continuous
 * strokes, not a row of hyphens.
 *
 * Why a raster and not a box-drawing character: 0xC4 is a line only in code
 * page 437, and a printer left on WPC1252 prints a row of "Ä" instead. A GS v 0
 * image prints the same on every printer that prints the logo.
 *
 * IT IS A NEW REQUIREMENT FOR A TENANT WITH NO LOGO, stated plainly: the logo
 * is optional, so a bill without one used to send no raster at all, and every
 * bill now sends these. A printer that cannot take GS v 0 would print the rule
 * bytes as garbage where the dashes used to be. Every ESC/POS printer this
 * product has been deployed on takes GS v 0 (the logo path has relied on it
 * for as long as bills have carried one), which is why this is a raster and not
 * a per-tenant choice — but it is a choice made, not a free one.
 *
 * `dots` is the width of the text area it underlines; the stroke is centred in
 * a little white above and below so it separates blocks the way the reference
 * does instead of touching the text.
 */
export function billRule(dots: number, thick = false): Buffer {
  const widthBytes = Math.ceil(dots / 8);
  const PAD = 4;
  const INK = thick ? 4 : 2;
  const height = PAD + INK + PAD;
  const header = Buffer.from([
    0x1d, 0x76, 0x30, 0x00,
    widthBytes & 0xff, (widthBytes >> 8) & 0xff,
    height & 0xff, (height >> 8) & 0xff,
  ]);
  const body = Buffer.alloc(widthBytes * height, 0x00);
  const tail = dots % 8;
  for (let y = PAD; y < PAD + INK; y++) {
    body.fill(0xff, y * widthBytes, (y + 1) * widthBytes);
    // Never ink past the requested width: a partial last byte keeps only its
    // leading bits.
    if (tail) { body[(y + 1) * widthBytes - 1] = (0xff << (8 - tail)) & 0xff; }
  }
  return Buffer.concat([header, body]);
}

/* ===========================================================================
 * THE KITCHEN DOCKET, SET IN TYPE
 *
 * Everything from here to buildReceiptBase64 builds the REFERENCE docket — the
 * one the client's own previous till printed, transcribed line for line. It is
 * a different document from the ESC/POS text docket below it, not a variation
 * of it, and it is built in two halves that never touch each other's concerns:
 *
 *   layoutKot(opts, profile)  -> KotRow[]   what is on the paper, in order.
 *                                           No bytes, no fonts, no widths.
 *   encodeKotRaster(rows, …)  -> Buffer     how it is drawn. No opinions about
 *                                           what a docket says.
 *
 * WHY A RASTER AND NOT PRINTER FONTS. The reference docket is set in a
 * PROPORTIONAL face — Tahoma, measured off the client's photograph. ESC/POS
 * built-in fonts are monospaced and come in integer multiples only, so the
 * closest the text renderer could get was double height — which stretches the
 * glyphs to a 1:4 aspect and reads as a different typeface, which is exactly
 * what the client reported. A proportional face reaches a thermal printer only
 * as a bitmap. So the text is drawn from kot_glyph_atlas.ts, a committed table
 * of 1-bit glyphs, and shipped as GS v 0 — the same raster command the bill's
 * logo and rules already use.
 *
 * THE FACE IS DEJAVU SANS CONDENSED, not Tahoma (which may not ship) and no
 * longer Liberation Sans (Arial's proportions, which the client read as "the
 * font style is wrong"). Of the faces we may ship it measures closest to the
 * photograph — same widths line for line, same capital and x-heights at the
 * same size. scripts/kot_atlas_build.ts has the numbers.
 *
 * AND WHY THE TEXT RENDERER STAYS. A printer that ignores GS v 0 prints a
 * BLANK ticket from this path — silent order loss, in the one document a
 * kitchen cooks from. No printer model is on record anywhere in production
 * ("PrintDevices" is empty), so the old docket is kept as a live fallback,
 * chosen per restaurant by "Restaurant".kot_print_style: 'classic' prints the
 * text docket, word for word as it always has, in the printer's own font at its
 * normal size (no longer stretched to double height — see `body`). See
 * ReceiptOptions.kotPrintStyle.
 * =========================================================================== */

/**
 * Which docket a restaurant prints.
 *
 * 'reference' — the raster docket transcribed from the client's own reference
 * ticket. THE DEFAULT, and what an unset column means.
 * 'classic'   — the ESC/POS text docket this file printed before, unchanged.
 */
export type KotPrintStyle = "reference" | "classic";

/** Read a stored setting. Anything that is not exactly 'classic' is the default. */
export function kotPrintStyleOf(value: unknown): KotPrintStyle {
  return String(value ?? "").trim().toLowerCase() === "classic" ? "classic" : "reference";
}

/**
 * How large a restaurant's reference docket is set — "Restaurant".kot_text_size.
 *
 * 'standard' is the client's reference ticket and the default; the other two
 * are a step either side of it. kot_print_style.ts holds the same three words
 * (KotTextSize) for the settings layer.
 */
export type KotTextSize = "small" | "standard" | "large";

/** Read a stored size. Anything that is not exactly 'small' or 'large' is 'standard'. */
export function kotTextSizeOf(value: unknown): KotTextSize {
  const token = String(value ?? "").trim().toLowerCase();
  return token === "small" || token === "large" ? token : "standard";
}

/**
 * THE BODY TYPE SIZE, in printer DOTS PER EM, for each roll and each setting.
 *
 * WHY THESE NUMBERS. The first reference docket set body type at 40 on the
 * 576-dot 80mm roll (30 on 58mm), because the client had asked for bigger type
 * twice. Having printed it, they asked for it smaller ("The font sizes must be
 * smaller in the KOT"). Their own reference photograph is Tahoma at 27 dots per
 * em, and fitting the docket's face to that photograph line by line lands on
 * 26.8 — so 27 IS 'standard', and a restaurant that never opens the setting
 * gets the photograph's type: capitals 20 dots tall, lowercase 15, a line every
 * 33 dots. (It was 28 while the face was Liberation Sans, whose capitals are
 * shorter per em; the size of the type on the paper is what was kept.)
 * 'small' and 'large' are the same steps either side of it they always were
 * (x0.86 and x1.21, rounded), and the 58mm roll steps down with its narrower
 * paper by the same ratios.
 *
 * The cost of the larger sizes is that a long dish name wraps to a second line,
 * which the encoder is built to render cleanly; nothing on the paper is ever
 * dropped to make type fit.
 *
 * EVERY NUMBER HERE IS BAKED INTO THE ATLAS — nothing is scaled at runtime.
 * scripts/kot_atlas_build.ts spells the resulting faces out in KOT_ATLAS_FACES,
 * and jest-tests/kot_raster.test.ts asserts that list is exactly kotAtlasFaces()
 * below: no face the renderer can ask for is missing, and none it cannot ask
 * for is shipped.
 */
export const KOT_BODY_PPEM: Readonly<Record<"80mm" | "58mm", Readonly<Record<KotTextSize, number>>>> = {
  "80mm": { small: 23, standard: 27, large: 33 },
  "58mm": { small: 21, standard: 23, large: 27 },
};

/**
 * The type sizes one docket is set in.
 *
 * TWO THINGS CHANGE SIZE ON A DOCKET, and only two. REPRINT and CANCELLED
 * print at 1.4x the body, in BOLD, so they are unmistakably the largest thing
 * on the paper whatever size the restaurant chose. A dish's "[Note]" prints a
 * step SMALLER and slanted, as the reference docket sets it — the one line on
 * the ticket that qualifies another rather than naming a dish. Everywhere else
 * emphasis is WEIGHT, exactly as the reference docket does it.
 */
export interface KotProfile {
  /** Printable width of the roll, in dots. */
  widthDots: number;
  /** The restaurant's setting this profile was resolved from. */
  textSize: KotTextSize;
  /** Body type size, dots per em. */
  ppem: number;
  /** REPRINT / CANCELLED size, dots per em — always set bold. */
  bannerPpem: number;
  /** A "[Note]" line's size, dots per em — always set in the slanted face. */
  notePpem: number;
}

/** REPRINT and CANCELLED, relative to body type. */
export const KOT_BANNER_SCALE = 1.4;

/**
 * A "[Note]" line, relative to body type.
 *
 * Measured, like the body size: the photograph's "[Note] Hold Dessert" is 207
 * dots of ink, which in the docket's face slanted as the photo slants it is
 * 23.1 dots per em against a 26.8 body — 0.86. 0.87 rounds to the same 23 at
 * standard and keeps the smaller sizes a readable step below their body.
 *
 * "[Hold]" is NOT a note and does not shrink: it is an instruction the kitchen
 * acts on, set upright at body size where a chef scans for it.
 */
export const KOT_NOTE_SCALE = 0.87;

/**
 * The profile for a roll `widthDots` wide at the restaurant's `textSize`
 * (anything unrecognised, including absent, is 'standard'). A roll of 576 dots
 * or more is set as 80mm, anything narrower as 58mm — the same split every
 * other paper decision in this file makes.
 */
export function kotProfile(widthDots: number, textSize?: unknown): KotProfile {
  const size = kotTextSizeOf(textSize);
  const ppem = KOT_BODY_PPEM[widthDots >= 576 ? "80mm" : "58mm"][size];
  return {
    widthDots,
    textSize: size,
    ppem,
    bannerPpem: Math.round(ppem * KOT_BANNER_SCALE),
    notePpem: Math.round(ppem * KOT_NOTE_SCALE),
  };
}

/**
 * EVERY FACE A DOCKET CAN BE SET IN, as atlas keys ("<ppem><r|b|o>"), sorted.
 *
 * Each body size regular and bold — a dish name is bold, the rest is not —
 * each banner size in bold only, and each note size in the slanted face only
 * ("o"), because planKotRaster never sets a banner or a note any other way.
 * This is the list the committed atlas must match exactly.
 */
export function kotAtlasFaces(): string[] {
  const keys = new Set<string>();
  for (const roll of Object.values(KOT_BODY_PPEM)) {
    for (const ppem of Object.values(roll)) {
      keys.add(`${ppem}r`);
      keys.add(`${ppem}b`);
      keys.add(`${Math.round(ppem * KOT_BANNER_SCALE)}b`);
      keys.add(`${Math.round(ppem * KOT_NOTE_SCALE)}o`);
    }
  }
  const order = (k: string) => "rbo".indexOf(k.slice(-1));
  return [...keys].sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || order(a) - order(b));
}

/**
 * Body text, a banner, or a note. There is no fourth size on a docket.
 *
 * A NOTE IS A SIZE AND A STYLE AT ONCE: smaller, and slanted, never bold. It is
 * one word because the two never come apart on the reference docket — and a
 * row cannot ask for "slanted body" or "upright note", which nobody designed.
 */
export type KotSize = "body" | "banner" | "note";

/**
 * The three columns of the item table. A cell says WHICH column it is in, never
 * where that column starts: the x positions are measured from the type, by the
 * encoder, against the roll it is printing on.
 */
export type KotColumn = "num" | "name" | "qty";

export interface KotCell {
  text: string;
  at: KotColumn;
  bold: boolean;
  size?: KotSize;
}

/**
 * One row of the docket.
 *
 * `line` is a whole-width line; `cols` is a row of the item table, whose `name`
 * cell is the only thing allowed to wrap (and whose continuations, and any
 * [Hold] or [Note] under it, hang under the name column). `rule` is the dashed
 * separator — a line of hyphens, as the reference prints it.
 */
export type KotRow =
  | { k: "line"; align: "center" | "left"; bold: boolean; size: KotSize; text: string }
  | { k: "cols"; cells: KotCell[] }
  | { k: "rule" };

/**
 * The line under a held dish — on BOTH dockets. One string, so paper and tests
 * cannot drift.
 *
 * JUST THE MARKER. It used to read "[Hold] Do not cook until fired"; the client:
 * "When an item is on hold, on the KOT it must only say 'hold'". The tag is what
 * a chef scans for, it sits exactly where a "[Note]" does, and the dish is
 * still kept out of Total Qty and totalled apart under Hold Qty — the sentence
 * after it was the one part of the line nobody needed.
 *
 * NOT the cancellation slip's "DO NOT COOK - THIS TICKET IS OFF", which is a
 * different message on a different document and stays word for word.
 */
export const KOT_HOLD_LINE = "[Hold]";

/**
 * WHAT IS ON THE PAPER, IN ORDER — the client's reference docket, transcribed.
 *
 *   Running Table                     centred
 *   KOT                               centred, BOLD
 *   08/09/26 14:13                    centred
 *   KOT - 21                          centred
 *   Dine In: DOME SECTION             centred, BOLD
 *   Table No: 33                      centred, BOLD
 *   Persons - 4                       centred
 *   ------------------------------
 *   Assign to: yado                   left
 *   Captain: TIYASHA                  left
 *   ------------------------------
 *   No.Item                      Qty
 *   1 Subz Tehri                   1  dish name BOLD, qty a bare right-aligned number
 *     [Note] Hold Dessert             indented to the name column, SMALLER and slanted
 *   ------------------------------
 *   Total Qty                      3
 *
 * NO RESTAURANT NAME, no logo, no station line, no "[ GENERAL ]", no dot
 * leaders, no "x" before the quantity: the reference has none of them, and every
 * one of those was our own addition rather than something a client asked for.
 * (No caller has ever passed `logo` for a KOT, so nothing is being taken away —
 * but a docket is read on a rail and a raster logo is centimetres of paper that
 * say what the kitchen already knows.)
 *
 * FOUR THINGS THE REFERENCE HAS NO EQUIVALENT FOR ARE KEPT ANYWAY, because each
 * of them stops the kitchen cooking the wrong thing:
 *   - the "[Hold]" line under a held dish, and the Hold Qty total apart from
 *     Total Qty, without which hold-and-fire is defeated by its own docket;
 *   - the ** REPRINT ** and ** CANCELLED ** banners (an unmarked second copy is
 *     cooked twice; an unmarked cancellation is cooked at all);
 *   - the "** NOTE **" block for an order-level instruction, which is where an
 *     allergy reaches the pass — dropping it to match a photo would be trading a
 *     safety line for a layout detail;
 *   - a LABELLED total row. The reference's own bottom row is cut off in the
 *     photo, and a bare number at the foot of a ticket is a number nobody can
 *     name.
 * The station line survives too, but only when the docket really is a
 * per-station split — never as "[ GENERAL ]" on every ticket, which is what
 * buildKotBase64's implicit bucket used to print.
 *
 * `profile` is passed in rather than read by the encoder alone because every
 * paper-dependent CONTENT decision belongs here. Today there are none: both
 * rolls and all three text sizes carry the same rows and differ only in how
 * large the type is, which is the encoder's business.
 *
 * FOLDED TO ASCII HERE, at the one door into the layout. The atlas is ASCII
 * 32..126, so a rupee sign or an accented letter must become 'Rs' or a plain
 * letter before it is measured — and anything left over becomes a VISIBLE '?'
 * rather than a silent gap, which is the same rule the text docket obeys.
 */
export function layoutKot(opts: ReceiptOptions, profile: KotProfile): KotRow[] {
  // `profile` is not read today: both rolls and all three text sizes carry the
  // same rows and differ only in how large the type is, which the encoder
  // measures. It is a parameter rather than a later refactor because the first
  // content decision that DOES depend on the paper belongs here, not in the
  // encoder.
  void profile;
  const rows: KotRow[] = [];
  const line = (text: string, align: "center" | "left", bold = false, size: KotSize = "body") => {
    const t = asciiSafe(text).replace(/\t/g, " ").trim();
    if (t) { rows.push({ k: "line", align, bold, size, text: t }); }
  };
  const rule = () => { rows.push({ k: "rule" }); };
  const cols = (cells: KotCell[]) => {
    rows.push({ k: "cols", cells: cells.map((c) => ({ ...c, text: asciiSafe(c.text).replace(/\t/g, " ") })) });
  };

  // --- The safety banners, above everything -------------------------------
  //
  // A reprint that looks like an original is cooked twice; a cancellation read
  // after the context line is read too late. Both go first, in the only type on
  // the docket that is larger than body text.
  if (opts.reprint === true) { line("** REPRINT **", "center", true, "banner"); }
  if (opts.cancelled === true) {
    line("** CANCELLED **", "center", true, "banner");
    line("DO NOT COOK - THIS TICKET IS OFF", "center", true, "body");
    rule();
  }

  // --- The centred header block, in the reference's order ------------------
  line(present(opts.orderContext), "center", false);
  line("KOT", "center", true);
  line(present(opts.printedAt) || new Date().toLocaleString(), "center", false);
  // OMITTED RATHER THAN FAKED when numbering is unavailable (migration 029
  // unapplied): the bold "KOT" above has already said what this is, so a ticket
  // with no number simply carries none. A ticket with the wrong number is worse
  // than a ticket with none.
  const numbered = typeof opts.kotNo === "number" && Number.isFinite(opts.kotNo) && opts.kotNo > 0;
  if (numbered) { line(`KOT - ${Math.round(opts.kotNo as number)}`, "center", false); }
  // ONLY A REAL SPLIT NAMES ITS STATION. groupKotItemsByStation buckets every
  // unrouted line under "General", so a station line taken straight from that
  // key printed "[ GENERAL ]" on every docket of every restaurant that has
  // never configured a station — a line that tells the kitchen nothing and cost
  // a row of the largest thing on the ticket.
  const station = present(opts.station);
  if (station && station.toLowerCase() !== "general") { line(`[ ${station.toUpperCase()} ]`, "center", true); }
  const mode = present(opts.serviceMode) || "Dine In";
  const section = present(opts.section);
  line(section ? `${mode}: ${section}` : mode, "center", true);
  line(`Table No: ${present(opts.table) || "N/A"}`, "center", true);
  // Covers, counted ONCE PER TABLE ("Tables".num_covers) — the number the bill
  // divides by for APC. Printed only when the table records one: defaulting an
  // unknown count to 1 told the kitchen a party size nobody entered.
  const covers = Math.round(Number(opts.covers) || 0);
  if (covers > 0) { line(`Persons - ${covers}`, "center", false); }
  rule();

  // --- Who is looking after it, LEFT aligned as the reference sets it ------
  const assignedTo = present(opts.assignedTo);
  const captain = present(opts.captain);
  if (assignedTo || captain) {
    if (assignedTo) { line(`Assign to: ${assignedTo}`, "left", false); }
    if (captain) { line(`Captain: ${captain}`, "left", false); }
    rule();
  }

  // --- The order-level instruction ----------------------------------------
  //
  // Above the item table, under its own banner, because it qualifies every line
  // below it. A per-dish hold is the opposite case and hangs under its dish.
  const orderNote = present(opts.orderNote);
  if (orderNote) {
    line("** NOTE **", "center", true);
    line(orderNote, "left", false);
    rule();
  }

  // --- The item table ------------------------------------------------------
  cols([
    { text: "No.Item", at: "num", bold: false },
    { text: "Qty", at: "qty", bold: false },
  ]);

  const qtyOf = (it: ReceiptItem) => Math.max(1, Math.round(Number(it.quantity) || 1));
  let totalQty = 0;
  let heldQty = 0;
  let heldLines = 0;
  for (const [idx, it] of opts.items.entries()) {
    const qty = qtyOf(it);
    if (it.held === true) { heldQty += qty; heldLines += 1; } else { totalQty += qty; }
    cols([
      { text: String(idx + 1), at: "num", bold: false },
      { text: itemLabel(it), at: "name", bold: true },
      { text: String(qty), at: "qty", bold: false },
    ]);
    // THE HOLD, WHERE A NOTE GOES — directly under the dish it holds, in the
    // slot a kitchen note uses. The client asked for exactly this placement
    // twice, and then for the line to say only "[Hold]" (see KOT_HOLD_LINE).
    // UPRIGHT AND AT BODY SIZE, unlike the note below it: "[Hold]" is an
    // instruction the pass acts on ("fire 3"), and it keeps the weight of one.
    if (it.held === true) { cols([{ text: KOT_HOLD_LINE, at: "name", bold: false }]); }
    // THE NOTE IS SET AS THE REFERENCE SETS IT: a step smaller and slanted
    // (KOT_NOTE_SCALE), never bold. It qualifies the dish above it, so it reads
    // as belonging to that dish rather than as the next line of the order —
    // and a docket on which everything is emphasised emphasises nothing. (It
    // was upright at body size until the client's "the font style is wrong".)
    const note = String(it.note ?? "").trim();
    if (note) { cols([{ text: `[Note] ${note}`, at: "name", bold: false, size: "note" }]); }
  }

  rule();
  // A docket whose every line is held has nothing to total — "Total Qty 0" above
  // the hold total invites the reading that the ticket is empty. Written so a
  // docket with NO held lines (including the deliberately empty one
  // buildKotBase64 emits for an item-less ticket) always prints the row.
  if (heldLines < opts.items.length || heldLines === 0) {
    cols([
      { text: "Total Qty", at: "num", bold: false },
      { text: String(totalQty), at: "qty", bold: false },
    ]);
  }
  if (heldLines > 0) {
    cols([
      { text: "Hold Qty", at: "num", bold: false },
      { text: String(heldQty), at: "qty", bold: false },
    ]);
  }
  rule();
  return rows;
}

/* --------------------------------------------------------------------------
 * The raster encoder. Synchronous, integer arithmetic, no native dependency.
 * -------------------------------------------------------------------------- */

/**
 * Rows of dots per GS v 0 block.
 *
 * THE SAME CAP THE BILL LOGO HAS OBEYED SINCE IT EXISTED (bill_logo.ts,
 * BILL_LOGO_MAX_HEIGHT): a single very tall raster overflows the image buffer
 * of a cheap thermal printer. A docket is ten to twenty times taller than a
 * logo, so it is sent as a run of blocks that print back to back with no gap —
 * the paper cannot tell where one ends. Repeated here rather than imported
 * because bill_logo.ts pulls in sharp and this file has no dependencies;
 * jest-tests/kot_raster.test.ts asserts the two numbers are still equal.
 */
export const KOT_RASTER_CHUNK_ROWS = 240;

/** Where the columns and the furniture of a docket sit, in dots. */
export interface KotGeometry {
  widthDots: number;
  ppem: number;
  bannerPpem: number;
  notePpem: number;
  /** White kept at each edge. */
  margin: number;
  /** Left edge of the No. column, and of every left-aligned line. */
  numX: number;
  /**
   * Left edge of the Item column — where wrapped names, [Hold] and [Note]
   * indent to. Sized from the widest row number on THIS docket, so a three-digit
   * number cannot be drawn over the first letter of a dish name.
   */
  nameX: number;
  /** The widest a name line may be before it wraps. */
  nameMax: number;
  /** The quantity column: right-aligned against qtyRight. */
  qtyLeft: number;
  qtyRight: number;
  /**
   * A rule is a row of hyphens, one to each `ruleCell` dots — see KOT_RULE_TEXT.
   */
  ruleDashes: number;
  ruleCell: number;
  /** White above and below a line of type. */
  leading: number;
}

/** One run of text, already placed. */
export interface KotDraw {
  face: KotFace;
  text: string;
  /** Pen position, in dots from the left edge of the roll. */
  x: number;
  /**
   * Set only on a rule: the run is MONOSPACED, one glyph centred in each cell
   * this many dots wide, instead of advancing by the face's own widths.
   */
  cell?: number;
  /** Ink extent of the run: [x0, x1). Nothing may fall outside [0, widthDots). */
  x0: number;
  x1: number;
}

/** One band of the docket: a line of type, or a rule. */
export interface KotOp {
  kind: "text" | "rule";
  /** Dot rows this band occupies. */
  height: number;
  /** Baseline, in dot rows from the top of the band. */
  baseline: number;
  draws: KotDraw[];
}

/**
 * THE RULE IS A LINE OF HYPHENS — the reference docket's own separator.
 *
 * The photograph's rules are 48 hyphens across the 80mm roll, printed on a line
 * of their own like any other line of type. They used to be drawn here as
 * geometric dashes in a band a third of a line tall, which is the one part of
 * the old docket that looked machine-drawn next to the photo. Now a rule is the
 * body face's own hyphen, one per printer column (DOTS_PER_COL): 48 on the 80mm
 * roll, 32 on 58mm — the same count the classic text docket's `sep` prints — on
 * a line exactly as tall as a line of text.
 */
export const KOT_RULE_TEXT = "-";

export interface KotRasterPlan {
  widthDots: number;
  heightDots: number;
  geometry: KotGeometry;
  ops: KotOp[];
}

/** A face, by size and weight. A missing one is a build error, not a blank docket. */
function kotFace(atlas: Record<string, KotFace>, ppem: number, bold: boolean): KotFace {
  const key = `${ppem}${bold ? "b" : "r"}`;
  const face = atlas[key];
  if (!face) { throw new Error(`kot glyph atlas has no face ${key} — re-run scripts/build_kot_glyph_atlas.ts`); }
  return face;
}

/**
 * The face one run of text is set in.
 *
 * A BANNER IS ALWAYS BOLD, whatever its row asks for. It is the loudest thing
 * on the paper, and it is the reason the atlas carries each banner size in bold
 * only (kotAtlasFaces) — so a banner row that one day arrived with bold: false
 * still prints, rather than throwing for a face nobody baked.
 *
 * A NOTE IS ALWAYS THE SLANTED FACE, never bold, for the same reason: the atlas
 * carries note sizes in that one style.
 */
function kotRunFace(
  atlas: Record<string, KotFace>,
  sizes: { ppem: number; bannerPpem: number; notePpem: number },
  size: KotSize | undefined,
  bold: boolean,
): KotFace {
  if (size === "banner") { return kotFace(atlas, sizes.bannerPpem, true); }
  if (size === "note") {
    const key = `${sizes.notePpem}o`;
    const face = atlas[key];
    if (!face) { throw new Error(`kot glyph atlas has no face ${key} — re-run scripts/build_kot_glyph_atlas.ts`); }
    return face;
  }
  return kotFace(atlas, sizes.ppem, bold);
}

/**
 * A glyph, or a VISIBLE '?' when the atlas has none.
 *
 * Text reaching here has been through asciiSafe, which already turns anything
 * outside printable ASCII into '?', so this is the second of two nets. It falls
 * back to a printed question mark rather than to zero width for the reason
 * asciiSafe does: a dish name that silently loses a character is a dish name
 * the kitchen misreads, and nobody ever finds out.
 */
function kotGlyph(face: KotFace, code: number): KotGlyph {
  return face.g[code] ?? face.g[63] ?? { a: 0, l: 0, t: 0, w: 0, h: 0, d: "" };
}

/** Width of `text` in SIXTEENTHS of a dot — advances are summed before rounding. */
function kotWidth16(face: KotFace, text: string): number {
  let w = 0;
  for (let i = 0; i < text.length; i++) { w += kotGlyph(face, text.charCodeAt(i)).a; }
  return w;
}

/** Width of `text` in whole dots. */
export function kotTextWidth(face: KotFace, text: string): number {
  return Math.round(kotWidth16(face, text) / 16);
}

/**
 * Where each glyph of a run starts, in SIXTEENTHS of a dot.
 *
 * ONE FUNCTION FOR THE PLAN AND THE BITMAP, so the ink extent a geometry
 * assertion checks is the ink the encoder lays down. An ordinary run advances
 * by the face's widths; a rule (`cell`) centres each glyph in its own cell.
 */
function kotPens(face: KotFace, text: string, x: number, cell?: number): number[] {
  const pens: number[] = [];
  let pen16 = Math.round(x * 16);
  for (let i = 0; i < text.length; i++) {
    const g = kotGlyph(face, text.charCodeAt(i));
    if (cell) { pens.push(pen16 + i * cell * 16 + ((cell * 16 - g.a) >> 1)); }
    else { pens.push(pen16); pen16 += g.a; }
  }
  return pens;
}

/**
 * The units kotWrap moves whole: the whitespace-separated words, with every
 * "#<digits>" token joined to the word before it by one space — the
 * `<root> #<n>` shape of a next-party table (next_party.ts). Exported for the
 * docket tests.
 */
export function kotWrapUnits(para: string): string[] {
  const units: string[] = [];
  for (const word of para.split(/\s+/).filter(Boolean)) {
    if (/^#\d+$/.test(word) && units.length > 0) { units[units.length - 1] += ` ${word}`; }
    else { units.push(word); }
  }
  return units;
}

/**
 * Word-wrap `text` to `maxDots`, BY MEASURED PIXEL WIDTH — the type is
 * proportional, so a character count means nothing here.
 *
 * A single token wider than the column is broken mid-word rather than allowed
 * to run off the roll: an unbroken 40-character dish name would otherwise print
 * over the quantity and past the paper edge, and a quantity the chef cannot
 * read is the one failure this column exists to prevent.
 *
 * A NEXT-PARTY NAME IS ONE WORD. "12 #2" has a space in it, and a break there
 * left "12" alone at the end of a line with "#2" below it — on the table-move
 * slip, "WAS 105" then "#2 ***", which names the ROOT's docket, the one the
 * pass must not pull. So a "#<n>" token is measured and moved with the word
 * before it (kotWrapUnits). A unit wider than the whole column still breaks
 * mid-word, as any over-long word does.
 */
export function kotWrap(face: KotFace, text: string, maxDots: number): string[] {
  const max16 = Math.max(1, maxDots) * 16;
  const out: string[] = [];
  const spaceW = kotGlyph(face, 32).a;
  for (const para of String(text ?? "").split(/\r?\n/)) {
    const words = kotWrapUnits(para);
    let cur = "";
    let cur16 = 0;
    const flush = () => { if (cur) { out.push(cur); } cur = ""; cur16 = 0; };
    for (const word of words) {
      const w16 = kotWidth16(face, word);
      if (w16 > max16) {
        flush();
        let piece = "";
        let piece16 = 0;
        for (const ch of word) {
          const g16 = kotGlyph(face, ch.charCodeAt(0)).a;
          if (piece16 + g16 > max16 && piece) { out.push(piece); piece = ""; piece16 = 0; }
          piece += ch;
          piece16 += g16;
        }
        cur = piece;
        cur16 = piece16;
        continue;
      }
      const add = cur ? spaceW + w16 : w16;
      if (cur && cur16 + add > max16) { flush(); cur = word; cur16 = w16; }
      else { cur = cur ? `${cur} ${word}` : word; cur16 += add; }
    }
    flush();
  }
  return out.length ? out : [""];
}

/**
 * Column arithmetic, derived from the type size rather than hardcoded, so both
 * rolls are laid out by one rule.
 */
function kotGeometry(rows: readonly KotRow[], atlas: Record<string, KotFace>, ppem: number, widthDots: number): KotGeometry {
  const sizes = {
    ppem,
    bannerPpem: Math.round(ppem * KOT_BANNER_SCALE),
    notePpem: Math.round(ppem * KOT_NOTE_SCALE),
  };
  const { bannerPpem, notePpem } = sizes;
  // WHITE AT BOTH EDGES, for the reason the bill sets printer margins: a roll
  // whose head is a dot or two narrower than nominal clips whatever touches the
  // edge, and on a docket the thing at the right edge is the quantity. 0.3em is
  // 6 to 10 dots at the docket's sizes, about a millimetre — visible, and cheap
  // in a column that only ever holds two or three digits.
  const margin = Math.round(ppem * 0.3);
  const numX = margin;
  const gutter = Math.round(ppem * 0.4);
  // THE No. COLUMN IS SIZED FROM THE WIDEST ROW NUMBER ACTUALLY ON THIS DOCKET,
  // for the same reason the quantity column below is sized from the widest
  // quantity. 1.45em is the reference docket's own gap and holds two digits; on
  // a ticket that reaches item 100 a fixed column draws the third digit straight
  // over the first letter of the dish name — no error, no clipping, just two
  // glyphs merged into one blob on the document the kitchen cooks from.
  //
  // Only a row carrying BOTH a number and a name can collide. "No.Item" and
  // "Total Qty" are wider than any column and sit alone on their side of the
  // paper, so measuring them would indent every dish name for nothing.
  let numW = 0;
  for (const row of rows) {
    if (row.k !== "cols" || !row.cells.some((c) => c.at === "name")) { continue; }
    for (const cell of row.cells) {
      if (cell.at !== "num") { continue; }
      const w = kotTextWidth(kotRunFace(atlas, sizes, cell.size, cell.bold), cell.text);
      if (w > numW) { numW = w; }
    }
  }
  // Grows from the reference's gap, never shrinks below it, and stops at a third
  // of the roll — the same ceiling the quantity column has, and for the same
  // reason: past that the No. column would be eating the dish name to make room
  // for a row number, and a name nobody can read is the worse trade.
  const nameX = Math.max(Math.round(ppem * 1.45), Math.min(numX + numW + gutter, Math.floor(widthDots / 3)));
  const qtyRight = widthDots - margin;
  // THE QUANTITY COLUMN IS SIZED FROM THE WIDEST QUANTITY ACTUALLY ON THIS
  // DOCKET, never from a guess. A fixed column fits "12" and a four-digit qty
  // then overruns the gutter into a full-width dish name.
  let qtyW = Math.round(ppem * 1.6);
  for (const row of rows) {
    if (row.k !== "cols") { continue; }
    for (const cell of row.cells) {
      if (cell.at !== "qty") { continue; }
      const w = kotTextWidth(kotRunFace(atlas, sizes, cell.size, cell.bold), cell.text);
      if (w > qtyW) { qtyW = w; }
    }
  }
  // …and never more than a third of the roll, so a nonsense quantity cannot eat
  // the dish name. Past that it grows leftward into the gutter, which is what
  // the gutter is for.
  qtyW = Math.min(qtyW, Math.floor(widthDots / 3));
  const qtyLeft = qtyRight - qtyW;
  const nameMax = Math.max(ppem, qtyLeft - nameX - gutter);
  return {
    widthDots,
    ppem,
    bannerPpem,
    notePpem,
    margin,
    numX,
    nameX,
    nameMax,
    qtyLeft,
    qtyRight,
    // One hyphen per printer column, each in a column-wide cell (KOT_RULE_TEXT).
    ruleDashes: Math.floor(widthDots / DOTS_PER_COL),
    ruleCell: DOTS_PER_COL,
    // 0.2em. With the face's own tallest and deepest ink that is a line every
    // 1.2em — 33 dots at standard, the photograph's line pitch (Tahoma's own
    // line height is 1.21em). It was 0.25em, which with DejaVu's taller
    // extents would print every docket a dot or two per line longer than the
    // ticket it copies.
    leading: Math.round(ppem * 0.2),
  };
}

/**
 * WHERE EVERY MARK GOES, before a byte is written.
 *
 * Exported because this, not the bitmap, is what a geometry assertion can talk
 * about: that nothing crosses the roll edge, that the quantity column is right
 * aligned, that the banner really is the largest face on the paper. Re-deriving
 * those from the finished bitmap would be measuring the answer with the answer.
 */
export function planKotRaster(
  rows: readonly KotRow[],
  atlas: Record<string, KotFace>,
  ppem: number,
  widthDots: number,
): KotRasterPlan {
  const G = kotGeometry(rows, atlas, ppem, widthDots);
  const faceFor = (size: KotSize | undefined, bold: boolean) => kotRunFace(atlas, G, size, bold);
  // ROW HEIGHT COMES FROM THE BOLD FACE OF THE SIZE, for every row of that size:
  // a bold line and a regular line have to sit on the same pitch or the docket
  // walks. Both are measured from the atlas's own per-face extremes, so the
  // pitch is a property of the type and not a number someone guessed. A note
  // row and a rule sit on the BODY pitch: on the reference they are lines of
  // the docket like any other, however small or light their type.
  const boxOf = (size: KotSize) => {
    const face = kotFace(atlas, size === "banner" ? G.bannerPpem : G.ppem, true);
    return { height: face.top + face.bottom + G.leading, baseline: face.top + Math.ceil(G.leading / 2) };
  };
  const place = (face: KotFace, text: string, x: number, cell?: number): KotDraw => {
    // The ink of a run starts at the first glyph's left bearing and ends at the
    // last one's right edge, which is not the same as [pen, pen + advance).
    const pens = kotPens(face, text, x, cell);
    let x0 = Infinity;
    let x1 = -Infinity;
    for (let i = 0; i < text.length; i++) {
      const g = kotGlyph(face, text.charCodeAt(i));
      if (g.w > 0) {
        const gx = (pens[i]! >> 4) + g.l;
        if (gx < x0) { x0 = gx; }
        if (gx + g.w > x1) { x1 = gx + g.w; }
      }
    }
    return { face, text, x, ...(cell ? { cell } : {}), x0: x0 === Infinity ? x : x0, x1: x1 === -Infinity ? x : x1 };
  };
  // A SLANTED LINE IS WRAPPED SHORT BY ITS OWN LEAN. Advances are upright, but
  // the top of the last letter leans right by slant x its height, and that ink
  // must still end inside the column it was measured for.
  const wrapWidth = (face: KotFace, maxDots: number) => maxDots - Math.ceil(face.slant * face.top);

  const ops: KotOp[] = [];
  for (const row of rows) {
    if (row.k === "rule") {
      const box = boxOf("body");
      const face = faceFor("body", false);
      const hyphens = KOT_RULE_TEXT.repeat(G.ruleDashes);
      // Centred as a block: on both rolls the cells fill the paper exactly
      // (576 = 48 x 12, 384 = 32 x 12), so this is 0 today and stays honest
      // for a roll that is not a whole number of columns.
      const x = Math.floor((G.widthDots - G.ruleDashes * G.ruleCell) / 2);
      ops.push({ kind: "rule", height: box.height, baseline: box.baseline, draws: [place(face, hyphens, x, G.ruleCell)] });
      continue;
    }
    if (row.k === "line") {
      // A BANNER THAT WILL NOT FIT STEPS DOWN TO BODY SIZE RATHER THAN BREAKING
      // IN HALF. "** CANCELLED **" at 1.4x is within a dot or two of the 58mm
      // roll, and the one line that had to be unmissable must not come out as
      // two ragged halves. Same rule the text docket's `big` obeys.
      let face = faceFor(row.size, row.bold);
      let size: KotSize = row.size;
      const room = G.widthDots - 2 * G.margin;
      if (size === "banner" && kotTextWidth(face, row.text) > room) {
        size = "body";
        face = faceFor("body", row.bold);
      }
      const box = boxOf(size === "banner" ? "banner" : "body");
      for (const text of kotWrap(face, row.text, wrapWidth(face, room))) {
        const w = kotTextWidth(face, text);
        const x = row.align === "center" ? Math.max(G.margin, Math.floor((G.widthDots - w) / 2)) : G.numX;
        ops.push({ kind: "text", height: box.height, baseline: box.baseline, draws: [place(face, text, x)] });
      }
      continue;
    }
    // An item row. Only the name wraps; the number and the quantity ride the
    // first visual line, so the No. and Qty columns stay a clean vertical run
    // down the docket however many lines a dish name takes.
    const box = boxOf("body");
    const nameCell = row.cells.find((c) => c.at === "name");
    const others = row.cells.filter((c) => c.at !== "name");
    const nameFace = nameCell ? faceFor(nameCell.size, nameCell.bold) : null;
    const nameLines = nameCell && nameFace
      ? kotWrap(nameFace, nameCell.text, wrapWidth(nameFace, G.nameMax))
      : [];
    const lines = Math.max(1, nameLines.length);
    for (let i = 0; i < lines; i++) {
      const draws: KotDraw[] = [];
      if (i === 0) {
        for (const cell of others) {
          const face = faceFor(cell.size, cell.bold);
          if (cell.at === "num") { draws.push(place(face, cell.text, G.numX)); }
          else { draws.push(place(face, cell.text, G.qtyRight - kotTextWidth(face, cell.text))); }
        }
      }
      const text = nameLines[i];
      if (nameFace && text !== undefined) {
        draws.push(place(nameFace, text, G.nameX));
      }
      ops.push({ kind: "text", height: box.height, baseline: box.baseline, draws });
    }
  }

  return { widthDots, heightDots: ops.reduce((s, op) => s + op.height, 0), geometry: G, ops };
}

/**
 * The docket as ESC/POS bytes: ESC @, the bitmap as GS v 0 blocks of at most
 * KOT_RASTER_CHUNK_ROWS rows, three line feeds and a full cut.
 *
 * ESC @ IS PART OF THE JOB. A docket that did not reset the printer would
 * inherit whatever bold, size or alignment the previous job left set, and on a
 * raster that shows up as a shifted or doubled image rather than as wrong text.
 */
export function encodeKotRaster(
  rows: readonly KotRow[],
  atlas: Record<string, KotFace>,
  ppem: number,
  widthDots: number,
): Buffer {
  const plan = planKotRaster(rows, atlas, ppem, widthDots);
  const stride = (widthDots + 7) >> 3;
  const bits = Buffer.alloc(stride * plan.heightDots, 0);
  const ink = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= widthDots || y >= plan.heightDots) { return; }
    bits[y * stride + (x >> 3)]! |= 0x80 >> (x & 7);
  };

  let y = 0;
  // A rule is drawn like any other line — its hyphens are glyphs, placed by
  // planKotRaster in cells of their own (KOT_RULE_TEXT).
  for (const op of plan.ops) {
    for (const draw of op.draws) {
      const pens = kotPens(draw.face, draw.text, draw.x, draw.cell);
      const baseline = y + op.baseline;
      for (let i = 0; i < draw.text.length; i++) {
        const g = kotGlyph(draw.face, draw.text.charCodeAt(i));
        if (g.w > 0 && g.h > 0) {
          const gx = (pens[i]! >> 4) + g.l;
          const gy = baseline - g.t;
          const src = Buffer.from(g.d, "base64");
          const gstride = (g.w + 7) >> 3;
          for (let ry = 0; ry < g.h; ry++) {
            for (let rx = 0; rx < g.w; rx++) {
              if (src[ry * gstride + (rx >> 3)]! & (0x80 >> (rx & 7))) { ink(gx + rx, gy + ry); }
            }
          }
        }
      }
    }
    y += op.height;
  }

  const out: Buffer[] = [Buffer.from([ESC, 0x40])];
  for (let row = 0; row < plan.heightDots; row += KOT_RASTER_CHUNK_ROWS) {
    const height = Math.min(KOT_RASTER_CHUNK_ROWS, plan.heightDots - row);
    out.push(Buffer.from([
      GS, 0x76, 0x30, 0x00,
      stride & 0xff, (stride >> 8) & 0xff,
      height & 0xff, (height >> 8) & 0xff,
    ]));
    out.push(bits.subarray(row * stride, (row + height) * stride));
  }
  out.push(Buffer.from([0x0a, 0x0a, 0x0a]));
  out.push(Buffer.from([GS, 0x56, 0x00])); // full cut
  return Buffer.concat(out);
}

// width defaults to 48 columns (80mm paper), matching the web printable bill.
// Pass 32 for 58mm printers.
export function buildReceiptBase64(opts: ReceiptOptions, width = 48): string {
  const cur = currencyToken(opts.currency);
  const money = (n: number, dec = 2) => `${cur}${cur ? " " : ""}${Number(n || 0).toFixed(dec)}`;
  const parts: Buffer[] = [];
  const raw = (...n: number[]) => parts.push(Buffer.from(n));
  const text = (s: string) => parts.push(Buffer.from(asciiSafe(s), "latin1"));
  const line = (s = "") => text(s + "\n");
  const sep = "-".repeat(width);
  const isKot = opts.kind === "kot";
  // THE REFERENCE DOCKET IS A DIFFERENT DOCUMENT, and it returns here — before
  // a byte of the text renderer runs — so the two can never half-mix. A bill,
  // and a KOT whose restaurant is on 'classic', falls through to everything
  // below unchanged.
  //
  // The caller counts COLUMNS (48 for 80mm, 32 for 58mm) because every other
  // door into this renderer does; the raster works in dots, and DOTS_PER_COL is
  // the conversion this file has always used. The restaurant's text size picks
  // the type from kotProfile's table — and is read nowhere below this line,
  // which is what keeps a 'classic' docket's bytes independent of it.
  if (isKot && kotPrintStyleOf(opts.kotPrintStyle) === "reference") {
    const profile = kotProfile(width * DOTS_PER_COL, opts.kotTextSize);
    return encodeKotRaster(layoutKot(opts, profile), KOT_ATLAS, profile.ppem, profile.widthDots).toString("base64");
  }
  // THE BILL'S TEXT AREA: the roll less its margins. Every bill line is laid
  // out against W; the margins themselves are the printer's (GS L / GS W,
  // below), so the text stream carries no padding a copy-paste would inherit.
  const marginCols = isKot ? 0 : billMarginCols(width);
  const W = width - 2 * marginCols;
  /**
   * The separator between blocks. A KOT keeps its dashed row, byte for byte; a
   * bill draws the solid stroke its reference carries, thicker around the item
   * table exactly where the client's bill thickens it.
   */
  const rule = (thick = false) => {
    if (isKot) { line(sep); return; }
    parts.push(billRule(W * DOTS_PER_COL, thick));
  };
  /** Bold, without touching size — `ESC E` alone, so a line keeps its columns. */
  const bold = (s: string) => { raw(ESC, 0x45, 0x01); text(s); raw(ESC, 0x45, 0x00); };

  /**
   * One line in the largest type the printer has: bold, double width AND height.
   *
   * A double-width character occupies TWO columns, so a string only fits when
   * `2 * length <= width`. Anything longer degrades to bold at normal size
   * rather than overflowing — a thermal printer wraps an over-wide line
   * mid-word, which turns the one line that had to be unmissable into two
   * ragged halves. A 21-character virtual-table name on 58mm paper is exactly
   * that case, and it is not hypothetical: takeaway tables are named for their
   * channel and their order id.
   */
  const big = (s: string, cols: number) => {
    const t = asciiSafe(s);
    const fits = t.length * 2 <= cols;
    raw(ESC, 0x45, 0x01);                 // bold
    // THE BOLD BIT RIDES IN THE SIZE COMMAND TOO. `ESC ! n` sets every print
    // mode at once, emphasis included, so on a printer that follows the Epson
    // spec an `ESC ! 0x30` sent after `ESC E 1` quietly turned bold back OFF —
    // the "large and bold" REPRINT banner came out large and thin. 0x38 is
    // double width + height + emphasized, which holds either way.
    if (fits) {raw(ESC, 0x21, MODE_BIG | MODE_BOLD);}
    line(t);
    if (fits) {raw(ESC, 0x21, 0x00);}
    raw(ESC, 0x45, 0x00);
  };

  /**
   * KOT body text: Font A at the printer's NORMAL size, 12x24 dots a cell.
   *
   * IT WAS DOUBLE HEIGHT (item 3, "the font of other items on the KOT should
   * also be increased slightly"), and double height is the one step up ESC/POS
   * has that keeps 48 columns — but a 12x48 cell is a letter pulled to twice its
   * height, and the client sent the result back: "the font looks elongated and
   * stretched vertically, which looks strange once printed ... reduce the font
   * size as well" (item 5). Font A has no size between 1x1 and a distorted 1x2,
   * so the classic docket prints 1x1 — capitals about 17 dots tall against the
   * reference photograph's 20, the closest undistorted size the printer's own
   * font has. The reference docket (the default) is where the photograph's
   * exact type lives; this is the fallback for a printer that cannot draw it.
   */
  const body = (s = "") => line(s);

  raw(ESC, 0x40); // initialize
  if (marginCols > 0) {
    // GS L (left margin) then GS W (print area), both in dots. Set straight
    // after ESC @, at the start of a line, where both are honoured. A printer
    // that ignores GS W still fits every line: W columns from the left margin
    // end inside the roll. The next job's ESC @ clears both.
    const left = marginCols * DOTS_PER_COL;
    const area = W * DOTS_PER_COL;
    raw(GS, 0x4c, left & 0xff, (left >> 8) & 0xff);
    raw(GS, 0x57, area & 0xff, (area >> 8) & 0xff);
  }

  // --- Header (centered): logo, restaurant name, address ---------------------
  raw(ESC, 0x61, 0x01); // center
  // THE FIRST THING ON A REPRINTED ROLL IS THAT IT IS A REPRINT.
  //
  // Above the logo, not under it: a bill carrying a tall raster logo would
  // otherwise put the word several centimetres down a slip that gets glanced at
  // and put in a till drawer. Thirteen characters survive double width on 58mm
  // paper (26 of 32 cells), so it prints at full size on both rolls rather than
  // degrading through `big`'s fallback.
  //
  // It goes on the kitchen docket too, for the harder version of the same
  // failure: an unmarked second copy of a ticket is cooked twice.
  const revisedNote = isKot ? "" : String(opts.revisedNote ?? "").trim();
  if (revisedNote) {
    big(UPDATED_BILL_MARKER, W);
    for (const l of wrapText(asciiSafe(revisedNote), W)) { line(l); }
  } else if (opts.reprint) {
    big("** REPRINT **", isKot ? width : W);
  }
  if (opts.logo && opts.logo.length > 0) {
    parts.push(opts.logo);
    line();
  }
  if (isKot) {
    // THE RESTAURANT NAME IS NOT THE BIGGEST THING ON A KITCHEN TICKET.
    //
    // It used to be — double width AND height, the largest type the printer has,
    // spent on the one fact the kitchen already knows, because they are standing
    // in it. The two things a chef actually has to read off a docket at arm's
    // length are WHICH TICKET this is and WHICH TABLE it feeds, and both were
    // printed in body text. The name stays (a shared printer serves more than one
    // outlet) but it prints bold at body size, and the big type is spent below.
    // Body size and bold, with the bold bit carried inside the size command for
    // the reason `big` gives (it was double height until item 5, see `body`).
    raw(ESC, 0x45, 0x01); // bold
    raw(ESC, 0x21, MODE_BOLD);
    line(opts.restaurantName || "Receipt");
    raw(ESC, 0x21, 0x00);
    raw(ESC, 0x45, 0x00);
  } else {
    // BOLD, AT THE SIZE OF THE ADDRESS UNDER IT — the client's bill. The name
    // used to print double width AND height, which on the 80mm roll is 22
    // characters before it wraps: "Gaia - Global Vegetarian" broke in two and
    // shouted over the logo that already names the restaurant.
    for (const l of wrapText(asciiSafe(opts.restaurantName || "Receipt"), W)) {
      raw(ESC, 0x45, 0x01);
      line(l);
      raw(ESC, 0x45, 0x00);
    }
  }
  if (isKot) {
    // THE CANCELLATION BANNER GOES FIRST, ABOVE EVERYTHING ELSE ON THE TICKET.
    //
    // A cancellation slip's entire job is to stop food being cooked, and it is
    // read in the same second and the same posture as forty ordinary dockets.
    // Anything below the context line is already too late: by then a chef has
    // read "Running Table 12" and started matching dishes. So the word is the
    // first thing under the restaurant name, in the biggest type the printer
    // has, and `big()` degrades it to normal width rather than letting it wrap
    // on a 58mm roll.
    if (opts.cancelled === true) {
      big("** CANCELLED **", width);
      body("DO NOT COOK — THIS TICKET IS OFF");
      line(sep);
    }
    // Context first, then the ticket's own identity — the order the reference
    // thermal KOT prints them in, and the order a chef reads them in: what kind
    // of order this is, which ticket it is, when it was fired, and which station
    // it belongs to.
    const context = present(opts.orderContext);
    if (context) {body(context);}
    // ONE IDENTITY LINE, IN THE BIGGEST TYPE ON THE DOCKET.
    //
    // This was two lines — a bold "KOT" and, under it, "KOT - 26" — which said
    // the word twice and printed the number, the thing the pass actually calls
    // out, in ordinary body text. Now the number IS the heading: "KOT - 26" at
    // double size, or a bare "KOT" when numbering is unavailable (migration 029
    // unapplied). Omitted rather than faked, as before: a ticket with no number
    // is honest, a ticket with the wrong number is not.
    const numbered = typeof opts.kotNo === "number" && Number.isFinite(opts.kotNo) && opts.kotNo > 0;
    big(numbered ? `KOT - ${Math.round(opts.kotNo as number)}` : "KOT", width);
    // Restaurant-zone stamp when the caller resolved one. The server-clock
    // fallback is what every ticket printed before kotStamp existed, kept so a
    // caller that has not been updated still prints a time rather than nothing.
    body(present(opts.printedAt) || new Date().toLocaleString());
    if (opts.station?.trim()) {body(`[ ${opts.station.trim().toUpperCase()} ]`);}
  }
  if (!isKot) {
    // Legal entity, address, tax registration — EACH ONLY WHEN THE TENANT HAS
    // ONE. A restaurant with no GSTIN must get a clean receipt, not a stray
    // "GSTN :" label with nothing after it, and no blank line where a field
    // would have been.
    const legalName = present(opts.legalName);
    // FOLDED TO ASCII BEFORE IT IS MEASURED. `line` folds anyway, and the
    // fold can LENGTHEN text ("…" is three characters, "½" is "1?2"), so a
    // wrap measured on the original can print past the text area.
    if (legalName) {
      for (const l of wrapText(asciiSafe(legalName), W)) {line(l);}
    }
    for (const l of addressLines(asciiSafe(present(opts.address)), W)) {line(l);}
    // The outlet's own number, in the place an Indian tax invoice carries it:
    // under the address, above the GST registration. It is wrapped like the
    // address rather than assumed short — a tenant who stores "080-4123 4567 /
    // +91 98765 43210" gets both numbers, not a truncated first one.
    const phone = present(opts.phone);
    if (phone) {for (const l of wrapText(asciiSafe(`Ph : ${phone}`), W)) {line(l);}}
    // Wrapped like the phone. A GSTIN is 15 characters, but the field is free
    // text, and a tenant registered in two states stores both.
    const gstin = present(opts.gstin);
    if (gstin) {for (const l of wrapText(asciiSafe(`GSTN : ${gstin}`), W)) {line(l);}}
  }
  rule();

  // --- Meta block (left aligned) --------------------------------------------
  raw(ESC, 0x61, 0x00); // left
  // WHICH SLIP THIS IS — BEFORE ANYTHING THAT LOOKS THE SAME ON BOTH OF THEM.
  //
  // The parts of a split bill are identical documents down to the bill number,
  // so this block is the only thing that tells two of them apart, and it is read
  // across a table, at arm's length, by someone deciding which one is theirs. It
  // goes FIRST and in the biggest type the printer has, above the customer and
  // date lines rather than among them: a part marker set in body text in a block
  // of body text is a marker that gets missed, and the failure is two guests
  // paying the same slip twice while the other one goes in a pocket.
  //
  // "** PART 1/3 **" is 14 characters, i.e. 28 of the 32 cells on 58mm paper, so
  // it prints at full size on the narrow roll as well as the wide one; a
  // two-digit split ("** PART 10/12 **") lands on exactly 32, and `big` degrades
  // anything past that to normal width rather than letting the printer wrap the
  // one line that had to be unmissable.
  //
  // THE TABLE IS REPEATED HERE even though the Dine In line below carries it:
  // that line is a date stamp with a table on the end of it, and the fact that
  // has to survive a glance at two slips is whose food this was.
  const splitPart = !isKot && opts.splitPart ? opts.splitPart : null;
  if (splitPart) {
    const of = Math.max(1, Math.round(Number(splitPart.of) || 1));
    const index = Math.min(of, Math.max(1, Math.round(Number(splitPart.index) || 1)));
    big(`** PART ${index}/${of} **`, W);
    // The section's own name, and the table, on one wrapped line. An unlabelled
    // part still says which table it belongs to rather than printing a bare
    // dash — same rule every header field in this file obeys.
    const label = present(splitPart.label);
    const where = `Table ${opts.table || "N/A"}`;
    for (const l of wrapText(asciiSafe(label ? `${label} - ${where}` : where), W)) {line(l);}
    rule();
  }
  if (!isKot) {
    // WHO THE BILL IS MADE OUT TO — the "Name:" slot the client's own printed
    // bill has, between the restaurant header and the date block, worded as it
    // is there. Round 2 item 1 adds the corporate party's GSTIN directly under
    // it, only when one is set.
    //
    // A WALK-IN LEAVES THE SLOT BLANK, as the client's bill does. "Guest" is the
    // placeholder the ordering flows store for "nobody gave a name"; printed, it
    // reads as a name somebody wrote down.
    const customer = present(opts.customer);
    const named = /^(qr )?guest$/i.test(customer) ? "" : customer;
    for (const l of wrapText(asciiSafe(named ? `Name: ${named}` : "Name:"), W)) {line(l);}
    const customerGstin = present(opts.customerGstin);
    if (customerGstin) {for (const l of wrapText(asciiSafe(`Customer GSTIN: ${customerGstin}`), W)) {line(l);}}
    rule();
  }
  const now = new Date().toLocaleString();
  if (isKot) {
    // THE TABLE, FIRST AND IN THE BIG TYPE. It is the answer to the only
    // question a chef asks a docket after "what do I cook" — where does it go —
    // and it used to sit third in a block of same-sized lines, below the
    // service mode. Reading it now costs a glance instead of a search.
    big(`Table No: ${opts.table || "N/A"}`, width);
    // WHERE the food is going. The service-mode line carries the floor section
    // as its value when there is one ("Dine In: FRONT"); with no section
    // configured the mode stands alone rather than repeating itself.
    const mode = present(opts.serviceMode) || "Dine In";
    const section = present(opts.section);
    body(section ? `${mode}: ${section}` : mode);
    // Covers, counted ONCE PER TABLE ("Tables".num_covers) — the same number the
    // bill divides by for APC, so the kitchen and the till never disagree about
    // how many people are sitting there. Printed only when the table actually
    // records covers: defaulting an unknown count to 1 told the kitchen a
    // party size nobody had entered.
    const covers = Math.round(Number(opts.covers) || 0);
    if (covers > 0) {body(`Persons - ${covers}`);}
    // WHO is looking after it. Each line only when that person is known; an
    // unassigned table prints neither, instead of two empty labels.
    const assignedTo = present(opts.assignedTo);
    const captain = present(opts.captain);
    if (assignedTo || captain) {
      line(sep);
      if (assignedTo) {body(`Assign to: ${assignedTo}`);}
      if (captain) {body(`Captain: ${captain}`);}
    }
  } else {
    // The SAME restaurant-zone stamp the KOT uses. This used to be
    // `new Date().toLocaleString()` — the SERVER's zone and locale, which on a
    // UTC host prints a US-format timestamp and, between 00:00 and 05:30 IST,
    // the WRONG CALENDAR DATE on a receipt that carries the tenant's GSTIN.
    // The table is BOLD on the client's bill: it is what a server matches the
    // slip to. Bold changes no cell widths, so the row is laid out as plain text
    // and only the right-hand run is emphasised.
    //
    // NEVER CUT A VALUE TO MAKE A ROW FIT. `twoCol` slices the left text when
    // both halves do not fit, and on this row the left text is the DATE: a table
    // named "ZOMATO-5123456789" printed "Date: 14/09/26 13 Dine In: ..." — the
    // minutes gone from a GST invoice, silently. When the two do not fit side by
    // side they print on two lines instead, each wrapped whole.
    {
      const dateText = asciiSafe(`Date: ${present(opts.printedAt) || now}`);
      const dineIn = asciiSafe(`Dine In: ${opts.table || "N/A"}`);
      if (dateText.length + 1 + dineIn.length <= W) {
        text(dateText + " ".repeat(W - dateText.length - dineIn.length));
        bold(dineIn);
        line();
      } else {
        for (const l of wrapText(dateText, W)) {line(l);}
        for (const l of wrapText(dineIn, W)) {bold(l); line();}
      }
    }
    // Each label only when its value is known — same rule the header block
    // obeys. A tenant with no bill series and no named cashier printed two
    // bare labels ("Bill No.:" / "Cashier:") with nothing after them.
    //
    // Cashier on the left, bill number on the right — the client's order.
    //
    // Same rule as the date: side by side when both fit whole, otherwise one
    // under the other. A long cashier name used to lose its tail to `twoCol`.
    const billNo = present(opts.billNo);
    const cashier = present(opts.cashier);
    const cashierText = cashier ? asciiSafe(`Cashier: ${cashier}`) : "";
    const billNoText = billNo ? asciiSafe(`Bill No.: ${billNo}`) : "";
    if (cashierText && billNoText && cashierText.length + 1 + billNoText.length <= W) {
      line(cashierText + " ".repeat(W - cashierText.length - billNoText.length) + billNoText);
    } else {
      for (const l of cashierText ? wrapText(cashierText, W) : []) {line(l);}
      for (const l of billNoText ? wrapText(billNoText, W) : []) {line(l);}
    }
    // EVERY KOT NUMBER THAT FED THIS BILL — see `kotNumbers` for why the guest's
    // copy carries them and why the renderer neither derives nor dedupes them.
    //
    // Wrapped, because the real receipt this mirrors listed NINE tokens: "Token
    // No.: 214, 218, 236, 241, 242, 257, 272, 277, 298" is 56 characters, which
    // is over even the wide roll and nearly twice the narrow one. wrapText
    // breaks on the spaces that already follow each comma, so a wrapped list
    // never splits a number in half.
    const tokens = (opts.kotNumbers ?? [])
      .map((n) => Math.round(Number(n)))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (tokens.length > 0) {
      for (const l of wrapText(`Token No.: ${tokens.join(", ")}`, W)) {line(l);}
    }
  }
  rule(true);

  // --- The order-level instruction (KOT only) --------------------------------
  //
  // Above the item table, under its own banner, because it qualifies every line
  // below it. The banner is what the eye catches across a pass; the wrapped
  // text underneath is what removes the doubt, because a docket is read
  // standing up, at a glance, and an instruction that has to be hunted for will
  // be missed. (A per-dish hold is the opposite case — it qualifies ONE line —
  // so it hangs under that dish like a note; see the item block.)
  //
  // A ticket with no order note prints EXACTLY what it printed before this
  // existed, down to the byte — which is what keeps every dockets-are-unchanged
  // assertion true for the restaurants that never type one.
  const orderNote = isKot ? present(opts.orderNote) : "";
  if (orderNote) {
    big("** NOTE **", width);
    for (const l of wrapText(orderNote, width)) {body(l);}
    line(sep);
  }

  // --- Items ----------------------------------------------------------------
  if (isKot) {
    // Kitchen ticket: a NUMBERED line per dish with the quantity right-aligned
    // in its own column, and never a price. The numbering is what lets the pass
    // call a line out loud ("hold 3 on 26") and what makes a short docket
    // countable at a glance; the qty column is what stops a long dish name
    // pushing the one number the chef needs off the end of the line.
    const COL_NO = 4;
    // WIDER THAN THE BILL'S QTY COLUMN, because this one prints double-width
    // characters: "x12" needs six cells, not three. At 48 columns eight cells
    // hold "x120" at double width; at 32 six cells hold "x12", and anything
    // larger degrades to normal width inside the same column rather than
    // spilling into the dish name.
    //
    // No. 4 + Item 36 + Qty 8 = 48, and No. 4 + Item 22 + Qty 6 = 32.
    const COL_QTY = width >= 48 ? 8 : 6;
    const COL_ITEM = Math.max(8, width - COL_NO - COL_QTY);
    const pad = (s: string, n: number) => s.length >= n ? s : s + " ".repeat(n - s.length);
    const padL = (s: string, n: number) => s.length >= n ? s : " ".repeat(n - s.length) + s;

    /**
     * ON A REPRINT THE DISH NAME IS ENLARGED AS WELL AS BOLD (A7).
     *
     * A7 asks for three things to be larger and bold on a reprint — the table
     * number, the dish name and the KOT id — and two of them ALREADY ARE on
     * every docket: `big()` prints "KOT - n" and "Table No: n" at double width
     * AND height at the top of the ticket, reprint or not. Enlarging them again
     * is not a thing the printer can do. So only the dish name changes here.
     *
     * The name is re-wrapped against HALF the item column, because a doubled
     * character eats two cells — a 21-character name on 58mm paper is 42 cells
     * of a 32-cell roll, i.e. the printer wrapping it mid-word, which is the
     * failure every width guard in this file exists to stop.
     */
    const wideName = opts.reprint === true;

    /**
     * THE DISH NAME, BOLD (A4) — and on a reprint, 2x2 as well (A7).
     *
     * Bold costs no cells — a bold character is the same width — so the row
     * keeps its exact column layout. The bold bit is set inside the `ESC !` size
     * command as well as by `ESC E`, because `ESC !` rewrites emphasis along with
     * size (see `big`): sending the size alone after `ESC E 1` would print the
     * one word that had to be bold in ordinary weight.
     *
     * It was bold AND double height (item 3) until item 5 took the height away
     * (see `body`). The run returns to normal size before the leaders, which are
     * deliberately left OUTSIDE the bold run: a bold dot leader reads as part of
     * the name rather than as the gap it is bridging.
     */
    const dishName = (s: string) => {
      raw(ESC, 0x45, 0x01); // bold
      raw(ESC, 0x21, MODE_BOLD | (wideName ? MODE_BIG : 0));
      text(s);
      raw(ESC, 0x21, 0x00);
      raw(ESC, 0x45, 0x00);
    };

    /**
     * One item row.
     *
     * THE QUANTITY. It used to be a bare digit set in body text at the far right
     * of a 48-column line — thirty blank columns away from the dish it belongs
     * to, and indistinguishable at a glance from the line number at the other
     * end of the row. So:
     *
     *   "x" prefix   — "x3" cannot be read as a line number, a table number or a
     *                  price; a lone "3" can be read as any of them.
     *   double size  — 2x2, twice the stroke of every other character on the
     *                  row, so the eye finds it without reading the row. Double
     *                  width AND height, never width alone: a letter doubled in
     *                  one direction is a distorted letter (see `body`).
     *   dot leaders  — the row is anchored end to end, so the number cannot be
     *                  read against the neighbouring dish. Leaders are dropped
     *                  when the name wraps, because a leader run that ends where
     *                  the name continues below reads as the end of the name.
     *
     * UNDER THE DISH, IN THIS ORDER: the rest of a wrapped name, then "[Hold]"
     * when the line is held, then "[Note] ..." when it carries a note. See the
     * list below for why the hold lives here.
     */
    const itemRow = (no: string, it: ReceiptItem, qty: number) => {
      const nameW = Math.max(4, wideName ? Math.floor((COL_ITEM - 1) / 2) : COL_ITEM - 1);
      const nameLines = wrapText(itemLabel(it), nameW);
      const first = nameLines[0] ?? "";
      const q = `x${qty}`;
      const double = q.length * 2 <= COL_QTY;
      // The number is set flush to the right edge and the leaders run all the
      // way UP TO IT, so the row is anchored end to end. Measured in CELLS: a
      // double-width "x12" eats six of them, not three, and leaders that stopped
      // at a fixed column would leave a gap exactly where the eye is travelling.
      // The NAME is measured in cells for the same reason — on a reprint it is
      // double width too, and a character count would run the row off the roll.
      const runway = COL_ITEM + COL_QTY - q.length * (double ? 2 : 1);
      const single = nameLines.length === 1;
      const gap = runway - first.length * (wideName ? 2 : 1);
      const leaders = single && gap >= 4
        ? ` ${".".repeat(gap - 2)} `
        : " ".repeat(Math.max(0, gap));
      text(pad(no, COL_NO));
      dishName(first);
      text(leaders);
      raw(ESC, 0x45, 0x01); // bold
      raw(ESC, 0x21, MODE_BOLD | (double ? MODE_BIG : 0));
      text(q);
      raw(ESC, 0x21, 0x00);
      raw(ESC, 0x45, 0x00);
      line();
      // Continuations, the hold and the note hang under the ITEM column, so the
      // No. and Qty columns stay a clean vertical run down the docket.
      const indent = " ".repeat(COL_NO);
      for (let i = 1; i < nameLines.length; i++) {
        text(indent);
        dishName(nameLines[i] ?? "");
        line();
      }
      // THE HOLD, WHERE A NOTE GOES — directly under the dish it holds. The
      // "[Hold]" tag is the same shape as the "[Note]" tag beneath it, and it is
      // the whole line: the client asked for the marker alone (KOT_HOLD_LINE).
      // The wrap is kept so the line obeys the column however it is worded.
      if (it.held === true) {
        for (const l of wrapText(KOT_HOLD_LINE, COL_ITEM - 1)) {body(indent + l);}
      }
      // Set apart by its "[Note]" tag and its indent and left out of the bold
      // run on purpose: a docket on which everything is emphasised emphasises
      // nothing.
      const note = String(it.note ?? "").trim();
      if (note) {
        for (const l of wrapText(`[Note] ${note}`, COL_ITEM - 1)) {body(indent + l);}
      }
    };

    /**
     * A HELD LINE STAYS IN ITS PLACE IN THE LIST, AND SAYS "[Hold]" UNDER ITSELF.
     *
     * Hold-and-fire exists so a course waits, and it used to be defeated by its
     * own docket: a held dish sat in the numbered list like everything else and
     * was cooked. The first fix lifted held lines out under a big "** HOLD **"
     * banner — and the kitchen then read the banner BEFORE the dish it applied
     * to, which the client reported as the hold printing in the wrong place.
     *
     * Client, item 2: "Hold order should come after the name of the dish which is
     * to be put on hold and not before. It should be in the same position like
     * the way a note appears on the food order." (1.5 said the same thing
     * earlier: dish name first, then hold.) So there is no banner and no second
     * list: the held dish prints in its own place, and the line directly under
     * it — the slot a "[Note]" uses on their reference docket — reads "[Hold]".
     * One numbering, so the pass calls "fire 3". (It said "[Hold] Do not cook
     * until fired" until the client asked for the marker alone.)
     *
     * WHAT STILL KEEPS IT OUT OF THE POT: Total Qty counts only what may be
     * cooked now, and the held quantity is totalled separately under it, so the
     * count the kitchen plates to never includes a waiting course.
     *
     * Absent/false on every line of every restaurant that never holds a course,
     * so their dockets carry no "[Hold]" line and no Hold Qty line.
     */
    const qtyOf = (it: ReceiptItem) => Math.max(1, Math.round(Number(it.quantity) || 1));

    body(pad("No.", COL_NO) + pad("Item", COL_ITEM) + padL("Qty", COL_QTY));
    line(sep);
    let totalQty = 0;
    let heldQty = 0;
    let heldLines = 0;
    for (const [idx, it] of opts.items.entries()) {
      const qty = qtyOf(it);
      if (it.held === true) {
        heldQty += qty;
        heldLines += 1;
      } else {
        totalQty += qty;
      }
      itemRow(String(idx + 1), it, qty);
    }
    // A docket whose every line is held has nothing to total — printing "Total
    // Qty 0" above the hold total invites the reading that there is nothing on
    // this ticket. The condition is written so that a docket with NO held lines
    // (every docket of every restaurant that does not use the feature, including
    // the deliberately empty one buildKotBase64 emits for an item-less ticket)
    // always prints the line exactly as it always has.
    line(sep);
    if (heldLines < opts.items.length || heldLines === 0) {
      body(twoCol("Total Qty", String(totalQty), width));
    }
    if (heldLines > 0) {
      body(twoCol("Hold Qty", String(heldQty), width));
    }
    line(sep);
  } else {
    // Column layout: Item | Qty. | Price | Amount, summing to the text area W —
    // the client's headings. 80mm (44 inside its margins): Item 20, Qty. 5,
    // Price 9, Amount 10. 58mm (32, no margins): Item 11, Qty. 4, Price 8,
    // Amount 9.
    const { COL_ITEM, COL_QTY, COL_PRICE, COL_TOTAL } = billColumns(W);
    const pad = (s: string, n: number) => s.length >= n ? s : s + " ".repeat(n - s.length);
    const padL = (s: string, n: number) => s.length >= n ? s : " ".repeat(n - s.length) + s;
    line(pad("Item", COL_ITEM) + padL("Qty.", COL_QTY) + padL("Price", COL_PRICE) + padL("Amount", COL_TOTAL));
    rule(true);
    for (const it of opts.items) {
      const qty = Math.max(1, Math.round(Number(it.quantity) || 1));
      const price = Number(it.price) || 0;
      const qtyText = String(qty);
      const priceText = price.toFixed(2);
      // A COMPED LINE IS CHARGED NOTHING, and its Amount says so: the column adds
      // up to the Sub Total below it only if the given-away dish reads 0.00.
      const amountText = it.nc === true ? (0).toFixed(2) : (price * qty).toFixed(2);
      // EVERY FIGURE KEEPS A SPACE IN FRONT OF IT. `padL` neither separates nor
      // trims, so a figure as wide as its column used to butt against the one
      // before it: qty 1 at 1,50,000.00 printed "1150000.00", which reads as a
      // different price. When any figure fills its column the numbers move to
      // their own right-aligned line under the dish, with a space between each.
      const fits = qtyText.length < COL_QTY && priceText.length < COL_PRICE && amountText.length < COL_TOTAL;
      const label = asciiSafe(it.nc === true ? `${itemLabel(it)} (NC)` : itemLabel(it));
      if (fits) {
        const nameLines = wrapText(label, COL_ITEM - 1);
        line(
          pad(nameLines[0] ?? "", COL_ITEM) +
          padL(qtyText, COL_QTY) +
          padL(priceText, COL_PRICE) +
          padL(amountText, COL_TOTAL),
        );
        for (let i = 1; i < nameLines.length; i++) {line(nameLines[i] ?? "");}
      } else {
        for (const l of wrapText(label, W)) {line(l);}
        const figures = `${qtyText} x ${priceText}  ${amountText}`;
        if (figures.length <= W) {
          line(padL(figures, W));
        } else {
          line(padL(`${qtyText} x ${priceText}`, W));
          line(padL(amountText, W));
        }
      }
      // THE ITEM NOTE IS DELIBERATELY NOT PRINTED HERE. It used to be, under the
      // line it belonged to, and it did not belong on this document at all.
      //
      // A note is an instruction to the kitchen — "no salt", "allergy: peanuts",
      // "extra spicy", "birthday, plate it last". Its reader is the chef, and it
      // reaches them on the KOT, where the renderer still prints it under the
      // dish. On the guest's bill it is at best noise on a tax document and at
      // worst a medical detail printed on a slip that is handed across a table,
      // left on it, or photographed for an expense claim. Nothing on the bill
      // depends on it: it carries no price, moves no total, and its absence
      // changes not one figure the guest is charged.
    }
    rule(true);
  }

  if (isKot) {
    text("\n\n\n");
    raw(GS, 0x56, 0x00); // full cut
    return Buffer.concat(parts).toString("base64");
  }

  // --- Totals ---------------------------------------------------------------
  const totalQty = opts.items.reduce((s, it) => s + Math.max(1, Math.round(Number(it.quantity) || 1)), 0);
  const taxLines = (opts.taxes ?? []).filter((t) => Number(t.amount) > 0);
  const sc = opts.serviceCharge && Number(opts.serviceCharge.amount) > 0 ? opts.serviceCharge : null;
  const discountAmt = opts.discount && Number(opts.discount.amount) > 0 ? Number(opts.discount.amount) : 0;

  // THE LADDER SITS IN THE RIGHT-HAND BLOCK, AS ON THE CLIENT'S BILL: every
  // label right-aligned against the Amount column, every figure in that column
  // under the item amounts it sums. "Total Qty: 19   Sub Total   4745.00" is
  // one row there, and is one row here whenever it fits the roll.
  //
  // ONE LABEL EDGE FOR THE WHOLE LADDER. Every figure is known before the first
  // row prints, so the amount column is sized once, to the widest of them
  // (never narrower than the item table's Amount column), and every label ends
  // on the same column. Sizing each row on its own value put "Grand Total" a
  // column left of the rows above it on every bill of Rs 1000 or more.
  const AMT = billColumns(W).COL_TOTAL;
  const subtotalText = Number(opts.total).toFixed(2);
  const discountText = discountAmt > 0 ? `-${discountAmt.toFixed(2)}` : "";
  const scText = sc ? Number(sc.amount).toFixed(2) : "";
  const taxTexts = taxLines.map((t) => Number(t.amount).toFixed(2));
  // WHAT WAS GIVEN AWAY, disclosed under the total and never added into it —
  // the same quantity and price each NC line printed at, before tax. A bill
  // with no comped line prints nothing here.
  const ncValue = opts.items.reduce(
    (s, it) => (it.nc === true ? s + (Number(it.price) || 0) * Math.max(1, Math.round(Number(it.quantity) || 1)) : s),
    0,
  );
  const ncText = Math.round(ncValue * 100) > 0 ? ncValue.toFixed(2) : "";
  const settlement = opts.settlement ?? null;
  const wouldHave = Number(settlement?.wouldHaveCharged);
  const wouldText = settlement && settlement.wouldHaveCharged != null && Number.isFinite(wouldHave) && Math.round(wouldHave * 100) > 0
    ? wouldHave.toFixed(2)
    : "";

  // THE GRAND TOTAL IS NOT COMPUTED HERE WHEN THE CALLER SUPPLIES ONE.
  //
  // The billing layer (computeBillCharges -> GetBillForTable.grand_total) is the
  // single authority on what the guest owes, and it is what settle records
  // against the bill. This renderer printing its own arithmetic on top of that —
  // in particular the whole-rupee Math.round below — is how a bill of 797.55
  // came to be SETTLED at 797.55 and PRINTED as 798. So when `grandTotal` is
  // given it is printed exactly as received, and the only round-off line beside
  // it is the one the billing layer supplies in `roundOff` — never one made here.
  //
  // The legacy branch is kept for callers that pass no grandTotal, so nothing
  // that has not been migrated changes its figures.
  const supplied = Number(opts.grandTotal);
  let roundOffText = "";
  let grandText: string;
  if (opts.grandTotal != null && Number.isFinite(supplied)) {
    // The one thing that IS printed alongside a supplied total: a round-off the
    // billing layer already computed, so the lines above add up to the total
    // below. It is reported, not derived — see `roundOff`. Absent, null or zero
    // prints nothing, which is every bill that was already whole rupees.
    const disclosed = Number(opts.roundOff);
    if (opts.roundOff != null && Number.isFinite(disclosed) && Math.round(disclosed * 100) !== 0) {
      roundOffText = (disclosed > 0 ? "+" : "") + disclosed.toFixed(2);
    }
    grandText = money(supplied);
  } else {
    const preRound = Number(opts.total) - discountAmt + (sc ? Number(sc.amount) : 0) + taxLines.reduce((s, t) => s + Number(t.amount || 0), 0);
    const grand = Math.round(preRound);
    roundOffText = ((grand - preRound) > 0 ? "+" : "") + (grand - preRound).toFixed(2);
    grandText = money(grand);
  }

  const amtW = Math.max(AMT, ...[subtotalText, discountText, scText, ...taxTexts, roundOffText, grandText, ncText, wouldText]
    .filter((v) => v.length > 0)
    .map((v) => v.length + 1));
  const labelW = Math.max(1, W - amtW);
  /**
   * One rung: the label right-aligned against the shared edge, the figure in
   * the amount column. A label too long for its side WRAPS, right-aligned, with
   * the figure on its last line — cutting it would drop the rate off a tax line
   * ("Compensation Cess on Aerated Beverag 1234.50") on a tax document.
   */
  const ladder = (label: string, value: string) => {
    // Only a label that does not fit is wrapped: wrapText rejoins words with
    // single spaces, and "Total Qty: 19   Sub Total" keeps its wider gap.
    const folded = asciiSafe(label);
    const parts = folded.length <= labelW ? [folded] : wrapText(folded, labelW);
    parts.forEach((part, i) => {
      const lead = " ".repeat(Math.max(0, labelW - part.length)) + part;
      line(i === parts.length - 1 && value ? lead + " ".repeat(amtW - value.length) + value : lead);
    });
  };
  const qtyAndSub = `Total Qty: ${totalQty}   Sub Total`;
  if (qtyAndSub.length <= labelW) {
    ladder(qtyAndSub, subtotalText);
  } else {
    // The 58mm roll: two rows rather than a row the printer wraps mid-word.
    ladder(`Total Qty: ${totalQty}`, "");
    ladder("Sub Total", subtotalText);
  }
  if (discountText) {ladder(opts.discount?.label || "Discount", discountText);}
  if (sc) {ladder(`Service Charge ${sc.percent}%`, scText);}
  taxLines.forEach((t, i) => { ladder(`${t.name} ${t.percentage}%`, taxTexts[i] ?? ""); });

  /**
   * The grand total: bold and DOUBLE HEIGHT, the one figure on the slip that is
   * bigger than the rest, as it is on the client's bill. Double height costs no
   * columns, so the row is laid out exactly as a ladder row is.
   */
  const grandRow = (amount: string) => {
    raw(ESC, 0x45, 0x01);
    raw(ESC, 0x21, MODE_TALL | MODE_BOLD);
    ladder("Grand Total", amount);
    raw(ESC, 0x21, 0x00);
    raw(ESC, 0x45, 0x00);
  };

  rule();
  if (roundOffText) {ladder("Round off", roundOffText);}
  grandRow(grandText);
  rule();

  // --- Beside the ladder, never in it: comps, and an NC settlement ----------
  if (ncText) {ladder("NC value (not charged)", ncText);}
  if (settlement) {
    const kind = present(settlement.kind);
    raw(ESC, 0x45, 0x01);
    for (const l of wrapText(asciiSafe(`Settled: Non-chargeable${kind ? ` — ${kind}` : ""}`), W)) {line(l);}
    raw(ESC, 0x45, 0x00);
    const by = present(settlement.authorisedBy);
    if (by) {for (const l of wrapText(asciiSafe(`Authorised by: ${by}`), W)) {line(l);}}
    if (wouldText) {ladder("Would have been (incl. tax)", wouldText);}
  }
  if (ncText || settlement) {rule();}

  // --- Footer (centered): disclaimer, then the valet/feedback QR ------------
  //
  // The disclaimer comes straight under the total, bold, as on the client's
  // bill: it is a statement about the charge in the figure just above it, and
  // a guest reads it before deciding what to pay. The QR is an invitation, so
  // it follows. The old "Thanks" line is gone — the client's bill has none.
  raw(ESC, 0x61, 0x01); // center
  if (opts.serviceChargeNote) {
    raw(ESC, 0x45, 0x01);
    for (const l of wrapText(asciiSafe(opts.serviceChargeNote), W)) {line(l);}
    raw(ESC, 0x45, 0x00);
  }
  if (opts.feedbackUrl) {
    if (opts.serviceChargeNote) {rule();}
    // The tenant's own sentence when they have set one, otherwise the valet
    // line this receipt has always carried.
    const note = present(opts.qrNote).slice(0, BILL_QR_NOTE_MAX) || DEFAULT_BILL_QR_NOTE;
    for (const l of wrapText(asciiSafe(note), W)) {line(l);}
    text("\n");
    parts.push(escposQr(opts.feedbackUrl, 6));
    text("\n");
  }
  text("\n\n\n");
  raw(GS, 0x56, 0x00); // full cut
  return Buffer.concat(parts).toString("base64");
}

// Group KOT items by their (upstream-enriched) kitchen station, preserving the
// order in which stations first appear. Items with no station fall under a
// shared "General" bucket so nothing is ever dropped from the kitchen.
//
// ONE DOCKET PER STATION, EVEN WHEN SEVERAL STATIONS SHARE A PRINTER — and that
// is a decision, not a limitation of the split.
//
// Once sections can be GROUPED onto one printer, the obvious-looking economy is
// to merge a group's lines onto a single ticket: one cut instead of three, less
// paper, less to pick up. It is the wrong trade, because a docket is not only
// paper — it is the unit the kitchen is measured in. Each station's ticket
// carries its own KOT header and prints at its own moment, so each station's
// prep clock starts when ITS ticket comes out. Merge them and Bar, Cocktails and
// Juice share one timestamp, and the question "how long did the bar take" stops
// having an answer.
//
// It would also make the ticket COUNT depend on the printer configuration:
// changing where something prints would change how many documents exist, which
// the per-station ticket identity and the KOT-number memo (migration 029) both
// key on. Where a thing prints must not change what it is.
//
// So a group of three sections produces three cut-terminated dockets, back to
// back on the same roll, in the order the stations first appear on the order.
export function groupKotItemsByStation(items: ReceiptItem[]): { station: string; items: ReceiptItem[] }[] {
  const groups = new Map<string, ReceiptItem[]>();
  const order: string[] = [];
  for (const it of items) {
    const key = String(it.station ?? "").trim() || "General";
    let bucket = groups.get(key);
    if (!bucket) { bucket = []; groups.set(key, bucket); order.push(key); }
    bucket.push(it);
  }
  return order.map((station) => ({ station, items: groups.get(station) ?? [] }));
}

// Per-station KOT split: build ONE standalone, cut-terminated kitchen ticket per
// station (each headed with the station name), so a multi-zone kitchen gets a
// separate ticket per station. Returns [{ station, escBase64 }, …] — the caller
// emits one print event per station. A printer agent that maps station→printer
// routes each ticket to its zone; a single-printer agent prints them back-to-back
// on one roll (same paper outcome as before, just split into labelled tickets).
export function buildKotBase64(opts: ReceiptOptions, width = 48): { station: string; escBase64: string }[] {
  const groups = groupKotItemsByStation(opts.items);
  // No items at all → still emit a single (empty) General ticket so the caller
  // has something to print, mirroring the pre-split single-ticket behavior.
  if (groups.length === 0) {
    return [{ station: "General", escBase64: buildReceiptBase64({ ...opts, kind: "kot", station: null, items: [] }, width) }];
  }
  return groups.map(({ station, items }) => ({
    station,
    escBase64: buildReceiptBase64({ ...opts, kind: "kot", station, items }, width),
  }));
}

/**
 * ONE PART OF A SPLIT BILL, as the renderer reads it.
 *
 * STRUCTURAL ON PURPOSE, so this file keeps its zero imports (billing_math.ts
 * has none either, and its header says why): `SectionSplitPart` — what
 * computeSectionSplit returns and what SplitBillForTableBySection hands back —
 * is assignable to this as it stands, field for field, with no adapter in
 * between for a future change to drift through.
 *
 * EVERY NUMBER HERE IS THE BILLING LAYER'S. Nothing in this shape is derived and
 * nothing in the renderer recomputes it.
 */
export interface SplitReceiptPart {
  /** Stable identity of the part (the section key). Echoed back to the caller. */
  key?: string;
  /** What this part is called on the paper — "Starters", "Bar". */
  label?: string | null;
  /** GROSS, pre-discount — the Sub Total line, exactly as a whole bill prints it. */
  subtotal: number;
  discount?: number;
  service_charge?: number;
  taxes?: ReceiptTax[];
  /** This part's share of a whole-bill round-off. Normally 0, and then unprinted. */
  round_off?: number;
  /** What this part is charged. PRINTED VERBATIM. */
  grand_total: number;
  items: ReceiptItem[];
}

/** One rendered part: the paper, plus the identity the caller needs to route it. */
export interface SplitReceipt {
  key: string;
  label: string;
  /** 1-based, and printed on the slip as "PART index/of". */
  index: number;
  of: number;
  /** The part's grand total, for the caller's log/response. NOT re-derived here. */
  grandTotal: number;
  escBase64: string;
}

/**
 * Render a split bill: ONE standalone, cut-terminated customer bill per part.
 *
 * The split ITSELF is not done here and must never be — computeSectionSplit
 * apportions every rung of the ladder (net, discount, service charge, each named
 * tax, unnamed tax, round-off) with a conserving allocator, and this function's
 * whole job is to put those numbers on paper without touching them.
 *
 * NO PART EVER INVENTS ITS OWN ROUNDING, and that is the entire risk of this
 * document. Each part's total goes in through `grandTotal`, which is the rule
 * buildReceiptBase64 already has for a caller-supplied total: print it exactly
 * as received and recompute nothing. Rendering a part the legacy way instead —
 * re-adding its lines and whole-rupee-rounding the result — would give three
 * parts of a 1,798.50 bill three totals summing to 1,799 or 1,797, and the
 * difference is money the guest pays or the drawer is short. The allocator's
 * guarantee is exact in paisa; this renderer's job is not to spend it.
 *
 * A ONE-PART SPLIT IS NOT A SPLIT. A table whose whole bill falls in one section
 * gets no part banner, its round-off is the bill's own, and every other field is
 * the bill's own — so what comes off the roll is byte-for-byte the bill that
 * table prints today. The rule lives here rather than in each caller, because a
 * caller that forgot it would quietly start printing a different document for
 * the commonest case there is.
 *
 * EACH SLIP CARRIES THE WHOLE BILL'S IDENTITY AND ONLY ITS OWN MONEY. The
 * restaurant, legal name, GSTIN, bill number, date, cashier, token list and
 * feedback QR all describe the BILL, and a part that dropped them would not be a
 * tax document. Only the item list and the ladder are the part's.
 */
export function buildSplitReceiptsBase64(
  opts: ReceiptOptions,
  parts: readonly SplitReceiptPart[],
  width = 48,
): SplitReceipt[] {
  const list = (Array.isArray(parts) ? parts : []).filter(Boolean);
  // NO PARTS STILL PRINTS THE BILL. computeSectionSplit never returns an empty
  // set — a bill with no classifiable lines comes back as one whole-bill bucket
  // — so an empty list means a bug upstream, and answering a bug with NO PAPER
  // is a table that never gets billed. Same fallback, for the same reason, as
  // buildKotBase64's empty-ticket case.
  if (list.length === 0) {
    return [{
      key: "whole",
      label: "",
      index: 1,
      of: 1,
      grandTotal: Number(opts.grandTotal ?? opts.total) || 0,
      // The bill's OWN round-off stays: since migration 048 a whole bill carries
      // one, and this fallback is the whole bill.
      escBase64: buildReceiptBase64({ ...opts, kind: "bill", splitPart: null }, width),
    }];
  }

  const of = list.length;
  // A split is a CUSTOMER document. The kitchen's split is a different one, cut
  // per station by buildKotBase64, so `kind` is pinned rather than inherited: a
  // caller that passed a KOT's options in here would otherwise get dockets with
  // no prices and no totals under a part banner.
  return list.map((part, i) => {
    const index = i + 1;
    const label = String(part.label ?? "").trim();
    const service = Number(part.service_charge) || 0;
    const discount = Number(part.discount) || 0;
    const grandTotal = Number(part.grand_total) || 0;
    const escBase64 = buildReceiptBase64({
      ...opts,
      kind: "bill",
      items: Array.isArray(part.items) ? part.items : [],
      total: Number(part.subtotal) || 0,
      // A part that was allocated nothing off a bill-wide discount prints no
      // discount line at all, rather than "-0.00": the line is a statement that
      // money came off, and none did. The LABEL is the bill's, because the
      // coupon was applied to the bill.
      discount: discount > 0 ? { amount: discount, label: opts.discount?.label } : null,
      // The PERCENTAGE is the bill's; the AMOUNT is this part's share of it. A
      // part charged nothing — a waived bill, or a section allocated no share —
      // prints no service-charge line, exactly as the whole bill does.
      serviceCharge: service > 0
        ? { percent: Number(opts.serviceCharge?.percent) || 0, amount: service }
        : null,
      taxes: Array.isArray(part.taxes) ? part.taxes : [],
      roundOff: Number(part.round_off) || 0,
      grandTotal,
      // THE DISCLAIMER IS A CLAIM ABOUT THE PIECE OF PAPER IT IS ON. "A
      // voluntary service charge is included to support our staff" printed on a
      // part that carries no such charge is a false statement on a tax document,
      // and it invites a guest to ask for the removal of something they were
      // never charged — and a waived bill's parts are charged none.
      serviceChargeNote: service > 0 ? opts.serviceChargeNote : null,
      splitPart: of > 1 ? { index, of, label } : null,
    }, width);
    return { key: String(part.key ?? "").trim() || String(index), label, index, of, grandTotal, escBase64 };
  });
}
