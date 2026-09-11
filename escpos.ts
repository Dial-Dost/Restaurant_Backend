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
  // Optional discount line (off the subtotal), shown before service charge.
  discount?: { amount: number; label?: string } | null;
  // Optional service charge line (amount + percent), shown before taxes. When
  // optedOut is true the line prints "Opted-out" instead of an amount (matches
  // the web bill when the guest waives the voluntary charge).
  serviceCharge?: { percent: number; amount: number; optedOut?: boolean } | null;
  // Optional tax breakdown. When present, the receipt shows a Subtotal line,
  // each tax line, and a tax-inclusive TOTAL (= total + service charge + taxes).
  taxes?: ReceiptTax[];
  kind?: "bill" | "kot";
  // KOT only: the kitchen station/zone this ticket is for. When set, it is
  // printed in the header so a per-station split ticket is self-identifying.
  station?: string | null;

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
    const itemRow = (no: string, it: ReceiptItem, qty: number) => {
      const nameLines = wrapText(itemLabel(it), COL_ITEM - 1);
      const first = nameLines[0] ?? "";
      const q = `x${qty}`;
      const double = q.length * 2 <= COL_QTY;
      // The number is set flush to the right edge and the leaders run all the
      // way UP TO IT, so the row is anchored end to end. Measured in CELLS: a
      // double-width "x12" eats six of them, not three, and leaders that stopped
      // at a fixed column would leave a gap exactly where the eye is travelling.
      const runway = COL_ITEM + COL_QTY - q.length * (double ? 2 : 1);
      const gap = runway - first.length;
      const itemCell = nameLines.length === 1 && gap >= 4
        ? `${first} ${".".repeat(gap - 2)} `
        : pad(first, runway);
      text(pad(no, COL_NO) + itemCell);
      raw(ESC, 0x45, 0x01);               // bold
      if (double) {raw(ESC, 0x21, 0x20);} // double width (NOT height)
      text(q);
      if (double) {raw(ESC, 0x21, 0x00);}
      raw(ESC, 0x45, 0x00);
      line();
      // Continuations and notes hang under the ITEM column, so the No. and Qty
      // columns stay a clean vertical run down the docket.
      for (let i = 1; i < nameLines.length; i++) {line(" ".repeat(COL_NO) + (nameLines[i] ?? ""));}
      // The one thing on a KOT that is more important than the dish name.
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
        itemRow(`H${idx + 1}`, it, qty);
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
