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

/** A header field prints only when the tenant actually has one. */
function present(v: string | null | undefined): string {
  return String(v ?? "").trim();
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

  raw(ESC, 0x40); // initialize

  // --- Header (centered): logo, restaurant name, address ---------------------
  raw(ESC, 0x61, 0x01); // center
  if (opts.logo && opts.logo.length > 0) {
    parts.push(opts.logo);
    line();
  }
  raw(ESC, 0x21, 0x30); // double width + height
  line(opts.restaurantName || "Receipt");
  raw(ESC, 0x21, 0x00); // normal
  if (isKot) {
    // Context first, then the ticket's own identity — the order the reference
    // thermal KOT prints them in, and the order a chef reads them in: what kind
    // of order this is, that it IS a kitchen ticket, when it was fired, and
    // which number to call it by.
    const context = present(opts.orderContext);
    if (context) {line(context);}
    raw(ESC, 0x45, 0x01); // bold
    line("KOT");
    raw(ESC, 0x45, 0x00);
    // Restaurant-zone stamp when the caller resolved one. The server-clock
    // fallback is what every ticket printed before kotStamp existed, kept so a
    // caller that has not been updated still prints a time rather than nothing.
    line(present(opts.printedAt) || new Date().toLocaleString());
    // Omitted rather than faked when numbering is unavailable — a ticket with no
    // number is honest, a ticket with the wrong number is not.
    if (typeof opts.kotNo === "number" && Number.isFinite(opts.kotNo) && opts.kotNo > 0) {
      line(`KOT - ${Math.round(opts.kotNo)}`);
    }
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
    const gstin = present(opts.gstin);
    if (gstin) {line(`GSTN : ${gstin}`);}
  }
  line(sep);

  // --- Meta block (left aligned) --------------------------------------------
  raw(ESC, 0x61, 0x00); // left
  if (!isKot) {
    line(`Customer Name: ${opts.customer?.trim() || "Guest"}`);
    line(sep);
  }
  const now = new Date().toLocaleString();
  if (isKot) {
    // WHERE the food is going. The service-mode line carries the floor section
    // as its value when there is one ("Dine In: FRONT"); with no section
    // configured the mode stands alone rather than repeating itself.
    const mode = present(opts.serviceMode) || "Dine In";
    const section = present(opts.section);
    line(section ? `${mode}: ${section}` : mode);
    line(`Table No: ${opts.table || "N/A"}`);
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

  // --- Items ----------------------------------------------------------------
  if (isKot) {
    // Kitchen ticket: a NUMBERED line per dish with the quantity right-aligned
    // in its own column, and never a price. The numbering is what lets the pass
    // call a line out loud ("hold 3 on 26") and what makes a short docket
    // countable at a glance; the qty column is what stops a long dish name
    // pushing the one number the chef needs off the end of the line.
    const COL_NO = 4;
    const COL_QTY = width >= 48 ? 6 : 4;
    const COL_ITEM = Math.max(8, width - COL_NO - COL_QTY);
    const pad = (s: string, n: number) => s.length >= n ? s : s + " ".repeat(n - s.length);
    const padL = (s: string, n: number) => s.length >= n ? s : " ".repeat(n - s.length) + s;
    line(pad("No.", COL_NO) + pad("Item", COL_ITEM) + padL("Qty", COL_QTY));
    line(sep);
    let totalQty = 0;
    for (const [idx, it] of opts.items.entries()) {
      const qty = Math.max(1, Math.round(Number(it.quantity) || 1));
      totalQty += qty;
      const nameLines = wrapText(itemLabel(it), COL_ITEM - 1);
      line(pad(`${idx + 1}`, COL_NO) + pad(nameLines[0] ?? "", COL_ITEM) + padL(String(qty), COL_QTY));
      // Continuations and notes hang under the ITEM column, so the No. and Qty
      // columns stay a clean vertical run down the docket.
      for (let i = 1; i < nameLines.length; i++) {line(" ".repeat(COL_NO) + (nameLines[i] ?? ""));}
      // The one thing on a KOT that is more important than the dish name.
      const note = String(it.note ?? "").trim();
      if (note) {
        for (const l of wrapText(`* ${note}`, COL_ITEM - 1)) {line(" ".repeat(COL_NO) + l);}
      }
    }
    line(sep);
    line(twoCol("Total Qty", String(totalQty), width));
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
      const note = String(it.note ?? "").trim();
      if (note) {line(`  * ${note}`);}
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
