// Builds an ESC/POS thermal receipt and returns it base64-encoded — consumed by
// the printer agent (a standalone Windows app that listens for `bill:print`
// { billId, escBase64 } and sends the raw bytes to the default thermal printer
// via the Windows RAW spooler). The layout mirrors the web dashboard's printable
// bill (src/app/dashboard/orders/print/page.tsx `generateEscPos`) so the final
// bill looks the same whether printed from the web or pushed to the agent.

const ESC = 0x1b;
const GS = 0x1d;

export type ReceiptItem = { name: string; quantity: number; price: number; note?: string; station?: string | null };
export type ReceiptTax = { name: string; percentage: number; amount: number };
export type ReceiptOptions = {
  restaurantName: string;
  // Outlet address line, printed under the name.
  address?: string | null;
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
  // When set (bill only), prints a "scan to rate" QR code linking to the
  // feedback form for the waiter who handled this table.
  feedbackUrl?: string | null;
  // Raw ESC/POS bytes for a logo raster (GS v 0 …), prepended centered at the
  // top. Built server-side from the restaurant's PNG/SVG bill logo.
  logo?: Buffer | null;
  // Voluntary service-charge disclaimer printed in the footer (bill only).
  serviceChargeNote?: string | null;
};

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
  if (s === "₹" || s.toLowerCase() === "inr") return "Rs";
  if (s === "€") return "EUR";
  if (s === "£") return "GBP";
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
      if (cur) lines.push(cur);
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
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
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
  if (isKot) line("** KITCHEN ORDER **");
  if (isKot && opts.station && opts.station.trim()) line(`[ ${opts.station.trim().toUpperCase()} ]`);
  if (!isKot && opts.address) {
    for (const l of wrapText(opts.address, width)) line(l);
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
    line(twoCol(`Table: ${opts.table}`, `${opts.covers} cover(s)`, width));
    line(now);
  } else {
    line(twoCol(`Date: ${now}`, `Dine In: ${opts.table || "N/A"}`, width));
    line(twoCol(`Bill No.: ${opts.billNo ?? ""}`, `Cashier: ${opts.cashier ?? ""}`, width));
  }
  line(sep);

  // --- Items ----------------------------------------------------------------
  if (isKot) {
    // Kitchen ticket: quantity + name (+ note), no prices.
    for (const it of opts.items) {
      const qty = Math.max(1, Math.round(Number(it.quantity) || 1));
      for (const [i, l] of wrapText(`${qty} x ${it.name}`, width).entries()) line(i === 0 ? l : `   ${l}`);
      const note = String(it.note ?? "").trim();
      if (note) line(`  * ${note}`);
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
      const nameLines = wrapText(it.name, COL_ITEM - 1);
      line(
        pad(nameLines[0] ?? "", COL_ITEM) +
        padL(String(qty), COL_QTY) +
        padL(price.toFixed(2), COL_PRICE) +
        padL((price * qty).toFixed(2), COL_TOTAL),
      );
      for (let i = 1; i < nameLines.length; i++) line(nameLines[i] ?? "");
      const note = String(it.note ?? "").trim();
      if (note) line(`  * ${note}`);
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
  if (discountAmt > 0) line(twoCol(opts.discount?.label || "Discount", `- ${discountAmt.toFixed(2)}`, width));
  if (sc) line(twoCol(`Service Charge (${sc.percent}%)`, sc.optedOut ? "Opted-out" : Number(sc.amount).toFixed(2), width));
  for (const t of taxLines) line(twoCol(`${t.name} (${t.percentage}%)`, Number(t.amount).toFixed(2), width));

  // Grand total = subtotal − discount + service charge + taxes, then round to the
  // nearest whole unit (round-off shown explicitly), matching the web bill.
  const preRound = Number(opts.total) - discountAmt + (sc ? Number(sc.amount) : 0) + taxLines.reduce((s, t) => s + Number(t.amount || 0), 0);
  const grand = Math.round(preRound);
  const roundOff = grand - preRound;

  line(sep);
  line(twoCol("Round off", (roundOff > 0 ? "+" : "") + roundOff.toFixed(2), width));
  raw(ESC, 0x45, 0x01); // bold
  line(twoCol("Grand Total:", money(grand), width));
  raw(ESC, 0x45, 0x00);
  line(sep);

  // --- Footer (centered): thanks, valet/feedback QR, disclaimer -------------
  raw(ESC, 0x61, 0x01); // center
  line("Thanks");
  if (opts.feedbackUrl) {
    line(sep);
    line("For calling Valet kindly scan the below QR code");
    text("\n");
    parts.push(escposQr(opts.feedbackUrl, 6));
    text("\n");
  }
  if (opts.serviceChargeNote) {
    for (const l of wrapText(opts.serviceChargeNote, width)) line(l);
  }
  text("\n\n\n");
  raw(GS, 0x56, 0x00); // full cut
  return Buffer.concat(parts).toString("base64");
}

// Group KOT items by their (upstream-enriched) kitchen station, preserving the
// order in which stations first appear. Items with no station fall under a
// shared "General" bucket so nothing is ever dropped from the kitchen.
export function groupKotItemsByStation(items: ReceiptItem[]): Array<{ station: string; items: ReceiptItem[] }> {
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
export function buildKotBase64(opts: ReceiptOptions, width = 48): Array<{ station: string; escBase64: string }> {
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
