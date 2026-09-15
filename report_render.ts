// CSV rendering for the accounting reports — NO database, network or native
// dependencies, so it can be unit-tested without loading the database_supabase.ts
// graph (pg/sharp/argon2/supabase). Same posture as billing_math.ts.
//
// `toCsv` LIVES HERE rather than in index.ts because the scheduled reports and the
// interactive /reports/*.csv exports must produce byte-identical files. Two
// independent escaping implementations is how a comma in a vendor name turns into
// a corrupted column six months later.

import type { SalesReport, GstReport, ProfitAndLoss, MisColumn } from "./database_supabase.js";

export function toCsv(headers: string[], rows: (string | number)[][]): string {
  const esc = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}

// SalesReport.by_day carries service_charge, and the interactive export dropped
// it — so the owner's own income was missing from the sheet they reconcile with.
// Both callers now come through here, which is what stops the two diverging again.
//
// GROSS AND NET, in the client's words: "Gross sales" is the grand total (service
// charge, tax and round off in), "Net sales" the item total less discounts. Net
// is APPENDED as the last column, never inserted: scheduled deliveries are read
// by position, and every column a reader already knows stays where it was.
export function renderSalesCsv(r: SalesReport): string {
  const rows: (string | number)[][] = r.by_day.map((d) => [d.date, d.bills, d.sales, d.tax, d.service_charge, d.refund, d.net]);
  rows.push(["Total", r.bill_count, r.total_sales, r.total_tax, r.total_service_charge, r.total_refund, r.total_net]);
  return toCsv(["Date", "Bills", "Gross sales", "Tax", "Service Charge", "Refunds", "Net sales"], rows);
}

export function renderGstCsv(r: GstReport): string {
  const rows: (string | number)[][] = r.by_rate.map((t) => [t.name, t.percentage, t.taxable, t.tax]);
  rows.push(["Total", "", r.total_taxable, r.total_tax]);
  return toCsv(["Tax", "Rate %", "Taxable", "Tax"], rows);
}

// A P&L has no natural row set, so it renders as a labelled two-column statement
// with the expense breakdown appended — the same shape the on-screen card reads.
export function renderPnlCsv(r: ProfitAndLoss): string {
  const rows: (string | number)[][] = [
    ["Gross sales", r.gross_sales],
    ["Refunds", r.refunds],
    ["Tax collected", r.tax_collected],
    ["Service charge", r.service_charge],
    // Not the client's Net (that is pre-service-charge): tax out, refunds out,
    // service charge and round off still in. Named for what it is.
    ["Revenue ex-tax (after refunds)", r.net_revenue],
    ["Total expenses", r.total_expenses],
    ["Net profit", r.net_profit],
  ];
  for (const e of r.expenses_by_category) {rows.push([`Expense — ${e.category}`, e.amount]);}
  return toCsv(["Line", "Amount"], rows);
}

/**
 * THE CSV FOR THE MIS / CONTROL REPORTS — one renderer for all nine.
 *
 * Driven by the SAME `columns` descriptor the API hands the screen, so the sheet
 * an auditor opens has exactly the columns, the order and the TOTALS row they
 * were looking at. Nine hand-written renderers would be nine chances for the
 * export to drift from the screen, and an export that disagrees with the screen
 * is the reason people stop trusting the export.
 *
 * THE TOTALS ROW IS DRIVEN BY THE PAYLOAD'S OWN `totals` OBJECT, not by summing
 * the rows: a cell is filled when that object carries a value under the column's
 * key, and left blank when it does not. That is the rule that gets both halves
 * right at once —
 *   * a column that must NEVER be summed ("% contribution", "Avg selling price",
 *     "Spend per cover") has no key on the totals object, so it stays blank
 *     instead of carrying a meaningless figure; and
 *   * a column whose window-level value is real but is NOT a sum (ABV, APC,
 *     covers — counted once per seating, so adding the rows would double a
 *     split-billed party) is filled with the figure the report actually
 *     computed, rather than being blanked for not looking summable.
 * A totals row where nothing resolves is omitted entirely rather than emitted as
 * a lone "Total,,,,,,". The first column holds the word "Total" because that is
 * where a reader's eye goes.
 *
 * `null` / `undefined` render as an EMPTY field, never as the strings "null" or
 * "0": a blank cell reads as "not recorded", which is what it means everywhere
 * these reports use one (an unresolvable seating, a discount with no approver, a
 * KOT number that cannot be tied to an order).
 */
export function renderMisCsv(
  columns: readonly MisColumn[],
  // `readonly object[]` rather than Record<string, unknown>[]: a TypeScript
  // interface has no implicit index signature, so every one of the nine row
  // types would need one (or a cast at every call site) to satisfy the stricter
  // shape. The key lookup below is the single cast instead.
  rows: readonly object[],
  totals?: object | null,
): string {
  const cell = (v: unknown): string | number => {
    if (v === null || v === undefined) {return "";}
    if (typeof v === "number") {return Number.isFinite(v) ? v : "";}
    if (typeof v === "boolean") {return v ? "Yes" : "No";}
    // Only the primitives above are expected; anything else would stringify as
    // "[object Object]" in a spreadsheet cell, which is worse than a blank.
    return typeof v === "string" ? v : "";
  };
  const at = (o: object, key: string): unknown => (o as Record<string, unknown>)[key];
  const body: (string | number)[][] = rows.map((r) => columns.map((c) => cell(at(r, c.key))));
  if (totals) {
    const t = totals;
    const cells = columns.map((c, i) => (i === 0 ? "Total" : cell(at(t, c.key))));
    // Nothing resolved: a lone "Total,,,,,," is noise on a sheet, not a total.
    if (cells.some((v, i) => i > 0 && v !== "")) {body.push(cells);}
  }
  return toCsv(columns.map((c) => c.label), body);
}

export interface ReportArtifact {
  filename: string;
  mime: string;
  body: string;
  bytes: number;
  /** Size of the FULL render, before any truncation — equal to `bytes` when
   *  nothing was cut. `bytes` is what reaches ReportDeliveries.artifact_bytes, and
   *  that is the POST-cut size, so without this the question a truncated file
   *  raises ("how much was dropped?") has no answer anywhere. */
  bytes_before_truncation: number;
  truncated: boolean;
}

export type ReportKey = "sales" | "pnl" | "gst";
export type ReportFormat = "csv";

export const REPORT_LABELS: Record<ReportKey, string> = {
  sales: "Sales report",
  pnl: "Profit & loss",
  gst: "GST report",
};

/**
 * How many fields one rendered CSV line holds, honouring toCsv's quoting so a
 * header that ever contains a comma still counts as one field.
 *
 * Derived from the rendered header rather than a per-report constant: a constant
 * drifts the moment a column is added, which is how the truncation marker came to
 * be six fields wide for a two-field P&L.
 */
function csvFieldCount(line: string): number {
  let fields = 1;
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === "," && !inQuotes) { fields += 1; }
  }
  return fields;
}

/**
 * Render one report payload to a stored artifact.
 *
 * `maxBytes` bounds a pathological range (GetSalesReport has no range cap and the
 * owner app already offers 365-day windows), not a normal one — a month of by_day
 * rows is a few KB. Truncation is RECORDED rather than silent: a short file the
 * owner cannot tell is short is worse than no file.
 */
export function renderReport(
  reportKey: ReportKey,
  format: ReportFormat,
  payload: SalesReport | GstReport | ProfitAndLoss,
  meta: { periodFrom: string; periodTo: string },
  maxBytes: number,
): ReportArtifact {
  let body: string;
  switch (reportKey) {
    case "sales": body = renderSalesCsv(payload as SalesReport); break;
    case "gst":   body = renderGstCsv(payload as GstReport); break;
    case "pnl":   body = renderPnlCsv(payload as ProfitAndLoss); break;
  }
  const limit = Math.max(1024, Math.floor(maxBytes));
  const full = Buffer.byteLength(body, "utf8");
  let truncated = false;
  if (full > limit) {
    // Cut on a LINE boundary: a CSV chopped mid-row parses as a corrupt final
    // record in every spreadsheet, which reads as bad data rather than a cut file.
    const cut = Buffer.from(body, "utf8").subarray(0, limit).toString("utf8");
    const nl = body.indexOf("\n");
    // The marker is itself a ROW, so it has to be as wide as THIS report. A
    // hard-coded `TRUNCATED,,,,,` is six fields — right for sales, and in the
    // four-field GST export and the two-field P&L it is exactly the corrupt final
    // record the line above exists to prevent. The size rides in the first field
    // (comma-free by construction, so it needs no escaping) because artifact_bytes
    // stores the post-cut size and nothing else records the original.
    const pad = ",".repeat(csvFieldCount(nl === -1 ? body : body.slice(0, nl)) - 1);
    body = `${cut.slice(0, cut.lastIndexOf("\n") + 1)}TRUNCATED - full report was ${String(full)} bytes${pad}\n`;
    truncated = true;
  }
  return {
    filename: `${reportKey}_${meta.periodFrom}_to_${meta.periodTo}.${format}`,
    mime: "text/csv; charset=utf-8",
    body,
    bytes: Buffer.byteLength(body, "utf8"),
    bytes_before_truncation: full,
    truncated,
  };
}
