// Builds an ESC/POS thermal receipt and returns it base64-encoded — consumed by
// the printer agent (a standalone Windows app that listens for `bill:print`
// { billId, escBase64 } and sends the raw bytes to the default thermal printer
// via the Windows RAW spooler). The layout mirrors the web dashboard's printable
// bill (src/app/dashboard/orders/print/page.tsx `generateEscPos`) so the final
// bill looks the same whether printed from the web or pushed to the agent.

const ESC = 0x1b;
const GS = 0x1d;

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
   * KOT ONLY: this line is on COURSE HOLD and must not be cooked yet.
   *
   * Hold-and-fire has worked in the app since it shipped — a held line is dimmed
   * on the KDS and its prep timer does not start — but the paper said nothing,
   * so the kitchen cooked it anyway and the feature was defeated by its own
   * docket. A held line is therefore not merely annotated here: it is lifted out
   * of the cook-now list entirely and reprinted under its own banner (see the
   * KOT item block below).
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
 * most 4 lines on 58mm/32-col and 3 on 80mm/48-col. That is long enough for a
 * real two-sentence instruction ("Scan to rate us and call your valet — your
 * feedback goes straight to the owner.") and short enough that it cannot push
 * the QR itself off a short tail of paper or bury the service-charge
 * disclaimer that follows it.
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
  billNo?: string | null;
  cashier?: string | null;
  /**
   * BILL ONLY: every KOT number that fed this bill, in allocation order —
   * printed as "Token No.: 214, 218, 236, ..." under the Bill No./Cashier line,
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
  // Optional service charge line (amount + percent), shown before taxes. When
  // optedOut is true the line prints "Opted-out" instead of an amount (matches
  // the web bill when the guest waives the voluntary charge).
  serviceCharge?: { percent: number; amount: number; optedOut?: boolean } | null;
  // Optional tax breakdown. When present, the receipt shows a Subtotal line,
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
   * A whole bill never carries one. computeBillCharges rounds every rung to 2dp,
   * so discounted_subtotal + service_charge + tax_total IS the grand total and
   * there is nothing to disclose — which is why every receipt printed before
   * this field existed stays byte-identical. It exists for a SPLIT PART, where
   * a whole bill's round-off is apportioned between the parts, and a part that
   * silently swallowed its share would be a slip whose own lines do not sum to
   * its own total.
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
    if (fits) {raw(ESC, 0x21, 0x30);}     // double width + height
    line(t);
    if (fits) {raw(ESC, 0x21, 0x00);}
    raw(ESC, 0x45, 0x00);
  };

  raw(ESC, 0x40); // initialize

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
  if (opts.reprint) {
    big("** REPRINT **", width);
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
    // outlet) but it prints bold at normal size, and the big type is spent below.
    raw(ESC, 0x45, 0x01); // bold
    line(opts.restaurantName || "Receipt");
    raw(ESC, 0x45, 0x00);
  } else {
    raw(ESC, 0x21, 0x30); // double width + height
    line(opts.restaurantName || "Receipt");
    raw(ESC, 0x21, 0x00); // normal
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
      line("DO NOT COOK — THIS TICKET IS OFF");
      line(sep);
    }
    // Context first, then the ticket's own identity — the order the reference
    // thermal KOT prints them in, and the order a chef reads them in: what kind
    // of order this is, which ticket it is, when it was fired, and which station
    // it belongs to.
    const context = present(opts.orderContext);
    if (context) {line(context);}
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
    line(present(opts.printedAt) || new Date().toLocaleString());
    if (opts.station?.trim()) {line(`[ ${opts.station.trim().toUpperCase()} ]`);}
  }
  if (!isKot) {
    // Legal entity, address, tax registration — EACH ONLY WHEN THE TENANT HAS
    // ONE. A restaurant with no GSTIN must get a clean receipt, not a stray
    // "GSTN :" label with nothing after it, and no blank line where a field
    // would have been.
    const legalName = present(opts.legalName);
    if (legalName) {
      for (const l of wrapText(legalName, width)) {line(l);}
    }
    for (const l of addressLines(present(opts.address), width)) {line(l);}
    // The outlet's own number, in the place an Indian tax invoice carries it:
    // under the address, above the GST registration. It is wrapped like the
    // address rather than assumed short — a tenant who stores "080-4123 4567 /
    // +91 98765 43210" gets both numbers, not a truncated first one.
    const phone = present(opts.phone);
    if (phone) {for (const l of wrapText(`Ph : ${phone}`, width)) {line(l);}}
    const gstin = present(opts.gstin);
    if (gstin) {line(`GSTN : ${gstin}`);}
  }
  line(sep);

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
    big(`** PART ${index}/${of} **`, width);
    // The section's own name, and the table, on one wrapped line. An unlabelled
    // part still says which table it belongs to rather than printing a bare
    // dash — same rule every header field in this file obeys.
    const label = present(splitPart.label);
    const where = `Table ${opts.table || "N/A"}`;
    for (const l of wrapText(label ? `${label} - ${where}` : where, width)) {line(l);}
    line(sep);
  }
  if (!isKot) {
    line(`Customer Name: ${present(opts.customer) || "Guest"}`);
    line(sep);
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
    line(section ? `${mode}: ${section}` : mode);
    // Covers, counted ONCE PER TABLE ("Tables".num_covers) — the same number the
    // bill divides by for APC, so the kitchen and the till never disagree about
    // how many people are sitting there. Printed only when the table actually
    // records covers: defaulting an unknown count to 1 told the kitchen a
    // party size nobody had entered.
    const covers = Math.round(Number(opts.covers) || 0);
    if (covers > 0) {line(`Persons - ${covers}`);}
    // WHO is looking after it. Each line only when that person is known; an
    // unassigned table prints neither, instead of two empty labels.
    const assignedTo = present(opts.assignedTo);
    const captain = present(opts.captain);
    if (assignedTo || captain) {
      line(sep);
      if (assignedTo) {line(`Assign to: ${assignedTo}`);}
      if (captain) {line(`Captain: ${captain}`);}
    }
  } else {
    // The SAME restaurant-zone stamp the KOT uses. This used to be
    // `new Date().toLocaleString()` — the SERVER's zone and locale, which on a
    // UTC host prints a US-format timestamp and, between 00:00 and 05:30 IST,
    // the WRONG CALENDAR DATE on a receipt that carries the tenant's GSTIN.
    line(twoCol(`Date: ${present(opts.printedAt) || now}`, `Dine In: ${opts.table || "N/A"}`, width));
    // Each label only when its value is known — same rule the header block
    // obeys. A tenant with no bill series and no named cashier printed two
    // bare labels ("Bill No.:" / "Cashier:") with nothing after them.
    const billNo = present(opts.billNo);
    const cashier = present(opts.cashier);
    if (billNo && cashier) {
      line(twoCol(`Bill No.: ${billNo}`, `Cashier: ${cashier}`, width));
    } else if (billNo) {
      line(`Bill No.: ${billNo}`);
    } else if (cashier) {
      line(`Cashier: ${cashier}`);
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
      for (const l of wrapText(`Token No.: ${tokens.join(", ")}`, width)) {line(l);}
    }
  }
  line(sep);

  // --- The order-level instruction (KOT only) --------------------------------
  //
  // Above the item table, under its own banner, because it qualifies every line
  // below it. The banner is what the eye catches across a pass; the wrapped
  // text underneath is what removes the doubt — the same division the HOLD
  // block uses, and for the same reason: a docket is read standing up, at a
  // glance, and an instruction that has to be hunted for will be missed.
  //
  // A ticket with no order note prints EXACTLY what it printed before this
  // existed, down to the byte — which is what keeps every dockets-are-unchanged
  // assertion true for the restaurants that never type one.
  const orderNote = isKot ? present(opts.orderNote) : "";
  if (orderNote) {
    big("** NOTE **", width);
    for (const l of wrapText(orderNote, width)) {line(l);}
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
     * Double WIDTH, never height, for the reason the quantity gives below:
     * double height re-pitches every row and doubles the length of a
     * fifteen-item docket. And the name is re-wrapped against HALF the item
     * column, because a doubled character eats two cells — a 21-character name
     * on 58mm paper is 42 cells of a 32-cell roll, i.e. the printer wrapping it
     * mid-word, which is the failure every width guard in this file exists to
     * stop.
     */
    const wideName = opts.reprint === true;

    /**
     * THE DISH NAME, BOLD (A4).
     *
     * It was the only thing on the row set in ordinary type: the line number,
     * the quantity and the two headings all carried weight, and the words the
     * chef is actually cooking from did not. Bold costs no cells and no paper —
     * a bold character is the same width — so the row keeps its exact layout and
     * every column assertion in the tests still measures the same numbers.
     *
     * The leaders are deliberately left OUTSIDE this run: a bold dot leader
     * reads as part of the name rather than as the gap it is bridging.
     */
    const dishName = (s: string) => {
      raw(ESC, 0x45, 0x01);                  // bold
      if (wideName) {raw(ESC, 0x21, 0x20);}  // double width (reprints only)
      text(s);
      if (wideName) {raw(ESC, 0x21, 0x00);}
      raw(ESC, 0x45, 0x00);
    };

    /**
     * One item row.
     *
     * THE QUANTITY IS THE POINT OF THIS FUNCTION. It used to be a bare digit set
     * in body text at the far right of a 48-column line — thirty blank columns
     * away from the dish it belongs to, the same size and weight as everything
     * else on the ticket, and indistinguishable at a glance from the line number
     * at the other end of the row. Three changes, each fixing one way that fails
     * in a hot kitchen:
     *
     *   "x" prefix   — "x3" cannot be read as a line number, a table number or a
     *                  price; a lone "3" can be read as any of them.
     *   double width — twice the stroke width of every other character on the
     *                  docket, so the eye finds it without reading the row. Width
     *                  only, never height: double height would re-pitch every
     *                  line and double the length of a fifteen-item docket.
     *   dot leaders  — the row is anchored end to end, so the number cannot be
     *                  read against the neighbouring dish. Leaders are dropped
     *                  when the name wraps, because a leader run that ends where
     *                  the name continues below reads as the end of the name.
     */
    const itemRow = (no: string, it: ReceiptItem, qty: number, suffix = "") => {
      // `suffix` is the word that must follow the dish name — today only "hold"
      // (see the hold block below). It rides on the LAST line of the name, and
      // the name is wrapped against a column shortened by its length, so the
      // word sits immediately after the dish it qualifies even when the name
      // wraps, and can never be pushed off the end of the row.
      const tail = suffix ? ` ${suffix}` : "";
      const nameW = Math.max(4, wideName
        ? Math.floor((COL_ITEM - 1 - tail.length) / 2)
        : COL_ITEM - 1 - tail.length);
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
      const headCells = first.length * (wideName ? 2 : 1) + (single ? tail.length : 0);
      const gap = runway - headCells;
      const leaders = single && gap >= 4
        ? ` ${".".repeat(gap - 2)} `
        : " ".repeat(Math.max(0, gap));
      text(pad(no, COL_NO));
      dishName(first);
      if (single && tail) {text(tail);}
      text(leaders);
      raw(ESC, 0x45, 0x01);               // bold
      if (double) {raw(ESC, 0x21, 0x20);} // double width (NOT height)
      text(q);
      if (double) {raw(ESC, 0x21, 0x00);}
      raw(ESC, 0x45, 0x00);
      line();
      // Continuations and notes hang under the ITEM column, so the No. and Qty
      // columns stay a clean vertical run down the docket.
      for (let i = 1; i < nameLines.length; i++) {
        text(" ".repeat(COL_NO));
        dishName(nameLines[i] ?? "");
        if (tail && i === nameLines.length - 1) {text(tail);}
        line();
      }
      // The one thing on a KOT that is more important than the dish name. Left
      // in body text on purpose: it is already set apart by its "*" and its
      // indent, and a docket on which everything is emphasised emphasises
      // nothing.
      const note = String(it.note ?? "").trim();
      if (note) {
        for (const l of wrapText(`* ${note}`, COL_ITEM - 1)) {line(" ".repeat(COL_NO) + l);}
      }
    };

    /**
     * HELD LINES ARE LIFTED OUT OF THE COOK-NOW LIST, NOT DECORATED INSIDE IT.
     *
     * The hold/fire feature exists so a course waits. It worked everywhere
     * except on the paper the kitchen actually cooks from, where a held dish sat
     * in the same numbered list as everything else — so it was cooked, and the
     * feature was defeated by its own docket. A marker beside the name would not
     * have been enough either: a docket is read standing up, at a glance, under
     * a pass light, and a line that has to be READ to be excluded will be cooked
     * by the third ticket of a busy service.
     *
     * So the list splits. Everything above "Total Qty" is cook it now, and that
     * total counts only those lines. Everything below the banner is not yours
     * yet. Held lines keep their own H-numbering so the pass can still call one
     * out ("fire H2") without colliding with the cook-now numbers.
     *
     * AND EACH HELD LINE ALSO READS "Gulab Jamun hold" — DELIBERATELY BOTH.
     *
     * The client asked for exactly one thing: "when an item is placed on hold,
     * the dish name must appear first, followed by the word hold". Read
     * literally that is a marker beside the name, which is precisely the
     * treatment this block exists because it is NOT enough — a line that has to
     * be read to be excluded gets cooked. Read as a replacement it would undo
     * the fix. So the word is printed where they asked for it, ON the line,
     * after the dish, INSIDE the banner that keeps the line out of the cook-now
     * list: the wording the client wants and the separation the kitchen needs,
     * neither standing in for the other.
     *
     * Lower case and unemphasised, unlike the banner above it, because it is a
     * confirmation of what the block already says rather than a second alarm.
     */
    const fire: ReceiptItem[] = [];
    const held: ReceiptItem[] = [];
    for (const it of opts.items) {(it.held ? held : fire).push(it);}
    const qtyOf = (it: ReceiptItem) => Math.max(1, Math.round(Number(it.quantity) || 1));

    line(pad("No.", COL_NO) + pad("Item", COL_ITEM) + padL("Qty", COL_QTY));
    line(sep);
    let totalQty = 0;
    for (const [idx, it] of fire.entries()) {
      const qty = qtyOf(it);
      totalQty += qty;
      itemRow(String(idx + 1), it, qty);
    }
    // A docket whose every line is held has nothing to total — printing
    // "Total Qty 0" above a full hold block invites the reading that there is
    // nothing on this ticket. The condition is written so that a docket with NO
    // held lines (every docket of every restaurant that does not use the
    // feature, including the deliberately empty one buildKotBase64 emits for an
    // item-less ticket) always prints the line exactly as it always has.
    if (fire.length > 0 || held.length === 0) {
      line(sep);
      line(twoCol("Total Qty", String(totalQty), width));
    }
    if (held.length > 0) {
      line(sep);
      // Short enough to survive double width on 58mm paper (10 chars = 20 of 32
      // cells), with the instruction spelled out underneath in body text — the
      // banner is what the eye catches, the sentence is what removes the doubt.
      big("** HOLD **", width);
      line("DO NOT COOK UNTIL FIRED");
      let heldQty = 0;
      for (const [idx, it] of held.entries()) {
        const qty = qtyOf(it);
        heldQty += qty;
        itemRow(`H${idx + 1}`, it, qty, "hold");
      }
      line(sep);
      line(twoCol("Hold Qty", String(heldQty), width));
    }
    line(sep);
  } else {
    // Column layout: Item | Qty | Price | Total (sums to `width`). At 80mm/48-col
    // these match the web bill exactly (Item 20, Qty 6, Price 10, Total 12);
    // narrower for 58mm/32-col.
    const COL_QTY = width >= 48 ? 6 : 4;
    const COL_PRICE = width >= 48 ? 10 : 8;
    const COL_TOTAL = width >= 48 ? 12 : 9;
    const COL_ITEM = Math.max(8, width - COL_QTY - COL_PRICE - COL_TOTAL);
    const pad = (s: string, n: number) => s.length >= n ? s : s + " ".repeat(n - s.length);
    const padL = (s: string, n: number) => s.length >= n ? s : " ".repeat(n - s.length) + s;
    line(pad("Item", COL_ITEM) + padL("Qty", COL_QTY) + padL("Price", COL_PRICE) + padL("Total", COL_TOTAL));
    line(sep);
    for (const it of opts.items) {
      const qty = Math.max(1, Math.round(Number(it.quantity) || 1));
      const price = Number(it.price) || 0;
      const nameLines = wrapText(itemLabel(it), COL_ITEM - 1);
      line(
        pad(nameLines[0] ?? "", COL_ITEM) +
        padL(String(qty), COL_QTY) +
        padL(price.toFixed(2), COL_PRICE) +
        padL((price * qty).toFixed(2), COL_TOTAL),
      );
      for (let i = 1; i < nameLines.length; i++) {line(nameLines[i] ?? "");}
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
    line(sep);
  }

  if (isKot) {
    text("\n\n\n");
    raw(GS, 0x56, 0x00); // full cut
    return Buffer.concat(parts).toString("base64");
  }

  // --- Totals ---------------------------------------------------------------
  const totalQty = opts.items.reduce((s, it) => s + Math.max(1, Math.round(Number(it.quantity) || 1)), 0);
  const taxLines = (opts.taxes ?? []).filter((t) => Number(t.amount) > 0);
  const sc = opts.serviceCharge && (Number(opts.serviceCharge.amount) > 0 || opts.serviceCharge.optedOut) ? opts.serviceCharge : null;
  const discountAmt = opts.discount && Number(opts.discount.amount) > 0 ? Number(opts.discount.amount) : 0;

  line(twoCol("Subtotal", Number(opts.total).toFixed(2), width));
  line(twoCol("Total Qty", String(totalQty), width));
  if (discountAmt > 0) {line(twoCol(opts.discount?.label || "Discount", `- ${discountAmt.toFixed(2)}`, width));}
  if (sc) {line(twoCol(`Service Charge (${sc.percent}%)`, sc.optedOut ? "Opted-out" : Number(sc.amount).toFixed(2), width));}
  for (const t of taxLines) {line(twoCol(`${t.name} (${t.percentage}%)`, Number(t.amount).toFixed(2), width));}

  // THE GRAND TOTAL IS NOT COMPUTED HERE WHEN THE CALLER SUPPLIES ONE.
  //
  // The billing layer (computeBillCharges -> GetBillForTable.grand_total) is the
  // single authority on what the guest owes, and it is what settle records
  // against the bill. This renderer printing its own arithmetic on top of that —
  // in particular the whole-rupee Math.round below — is how a bill of 797.55
  // came to be SETTLED at 797.55 and PRINTED as 798. So when `grandTotal` is
  // given it is printed exactly as received, with no round-off line, because
  // there is no rounding left to disclose.
  //
  // The legacy branch is kept verbatim for callers that pass no grandTotal, so
  // nothing that has not been migrated changes behaviour.
  line(sep);
  const supplied = Number(opts.grandTotal);
  if (opts.grandTotal != null && Number.isFinite(supplied)) {
    // The one thing that IS printed alongside a supplied total: a round-off the
    // billing layer already computed, so the lines above add up to the total
    // below. It is reported, not derived — see `roundOff`. Absent, null or zero
    // prints nothing, which is every whole bill.
    const disclosed = Number(opts.roundOff);
    if (opts.roundOff != null && Number.isFinite(disclosed) && Math.round(disclosed * 100) !== 0) {
      line(twoCol("Round off", (disclosed > 0 ? "+" : "") + disclosed.toFixed(2), width));
    }
    raw(ESC, 0x45, 0x01); // bold
    line(twoCol("Grand Total:", money(supplied), width));
    raw(ESC, 0x45, 0x00);
  } else {
    const preRound = Number(opts.total) - discountAmt + (sc ? Number(sc.amount) : 0) + taxLines.reduce((s, t) => s + Number(t.amount || 0), 0);
    const grand = Math.round(preRound);
    const roundOff = grand - preRound;
    line(twoCol("Round off", (roundOff > 0 ? "+" : "") + roundOff.toFixed(2), width));
    raw(ESC, 0x45, 0x01); // bold
    line(twoCol("Grand Total:", money(grand), width));
    raw(ESC, 0x45, 0x00);
  }
  line(sep);

  // --- Footer (centered): thanks, valet/feedback QR, disclaimer -------------
  raw(ESC, 0x61, 0x01); // center
  line("Thanks");
  if (opts.feedbackUrl) {
    line(sep);
    // The tenant's own sentence when they have set one, otherwise the valet
    // line this receipt has always carried.
    const note = present(opts.qrNote).slice(0, BILL_QR_NOTE_MAX) || DEFAULT_BILL_QR_NOTE;
    for (const l of wrapText(note, width)) {line(l);}
    text("\n");
    parts.push(escposQr(opts.feedbackUrl, 6));
    text("\n");
  }
  if (opts.serviceChargeNote) {
    for (const l of wrapText(opts.serviceChargeNote, width)) {line(l);}
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
  /** GROSS, pre-discount — the Subtotal line, exactly as a whole bill prints it. */
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
 * gets no part banner, its round-off is zero, and every other field is the
 * bill's own — so what comes off the roll is byte-for-byte the bill that table
 * prints today. The rule lives here rather than in each caller, because a
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
      escBase64: buildReceiptBase64({ ...opts, kind: "bill", splitPart: null, roundOff: null }, width),
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
    const optedOut = opts.serviceCharge?.optedOut === true;
    const grandTotal = Number(part.grand_total) || 0;
    const escBase64 = buildReceiptBase64({
      ...opts,
      kind: "bill",
      items: Array.isArray(part.items) ? part.items : [],
      total: Number(part.subtotal) || 0,
      // A part that was allocated nothing off a bill-wide discount prints no
      // discount line at all, rather than "- 0.00": the line is a statement that
      // money came off, and none did. The LABEL is the bill's, because the
      // coupon was applied to the bill.
      discount: discount > 0 ? { amount: discount, label: opts.discount?.label } : null,
      // The PERCENTAGE is the bill's; the AMOUNT is this part's share of it. A
      // waived charge stays waived on every part — `optedOut` prints the word
      // instead of a figure, which is the whole point of a waiver being visible
      // on the paper rather than inferred from a missing line.
      serviceCharge: service > 0 || optedOut
        ? { percent: Number(opts.serviceCharge?.percent) || 0, amount: service, ...(optedOut ? { optedOut: true } : {}) }
        : null,
      taxes: Array.isArray(part.taxes) ? part.taxes : [],
      roundOff: Number(part.round_off) || 0,
      grandTotal,
      // THE DISCLAIMER IS A CLAIM ABOUT THE PIECE OF PAPER IT IS ON. "A
      // voluntary service charge is included to support our staff" printed on a
      // part that carries no such charge is a false statement on a tax document,
      // and it invites a guest to ask for the removal of something they were
      // never charged. A waived part keeps it: there the sentence is exactly
      // what explains the "Opted-out" line above it.
      serviceChargeNote: service > 0 || optedOut ? opts.serviceChargeNote : null,
      splitPart: of > 1 ? { index, of, label } : null,
    }, width);
    return { key: String(part.key ?? "").trim() || String(index), label, index, of, grandTotal, escBase64 };
  });
}
