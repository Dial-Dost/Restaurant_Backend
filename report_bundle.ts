// A REPORT BUNDLE — the files one email carries, built from the same readers the
// screen reads.
//
// THE ONE RULE: every figure in an emailed report comes from the SAME reader,
// with the SAME query, that GET /reports/mis/<report> (or /reports/sales) runs.
// A second query written for email would be a second definition of the
// restaurant's money, and the day it drifted the accountant's sheet and the
// owner's screen would disagree about the same night. So:
//
//   * the MIS reports go through GetXReport(resId, { from, to, day_close,
//     limit, offset }) — misContext and all — and a paged report is read page
//     by page (500 at a time) until the server says there is no more, or the
//     per-report row cap is reached, which the file then says;
//   * a CSV attachment is renderMisCsv / renderSalesCsv / renderGstCsv /
//     renderPnlCsv of that payload — byte for byte the .csv route's body for
//     the same window when every row fits one page;
//   * the TOTALS row is always the payload's own `totals`, never a re-sum.
//
// EACH READ IS ITS OWN SHORT TRANSACTION, bound to the delivery's outlet (and to
// ALL-OUTLETS for an 'all' scope), with a 20-second statement timeout, and no
// read is nested in another. withTenant is re-entrant: nested inside a request
// or a pass-A transaction it would silently hand back that context's outlet —
// the reason report_schedules.ts's header exists. Files are rendered after the
// last read commits, so no connection is held while a workbook is zipped or an
// email is sent.

import {
  GetBillEditReport,
  GetCounterSummaryReport,
  GetCoverSizeSummaryReport,
  GetDiscountReport,
  GetExecutiveSummaryReport,
  GetGroupSummaryReport,
  GetGstReport,
  GetItemWiseReport,
  GetNcSummaryReport,
  GetOrderSummaryReport,
  GetProfitAndLoss,
  GetReportEmailIdentity,
  GetSalesReport,
  GetSalesSummaryReport,
  GetServiceChargeDenyReport,
  GetSettlementSummaryReport,
  GetTipSummaryReport,
  GetVariationSummaryReport,
  GetVoidKotReport,
  SetLocalStatementTimeout,
  withTenant,
  type GstReport,
  type MisColumn,
  type MisReportQuery,
  type ProfitAndLoss,
  type RenderedReportFile,
  type SalesReport,
  type SalesSummaryReport,
  type SettlementSummaryReport,
} from "./database_supabase.js";
import { catalogueEntry, MAX_ROWS_PER_REPORT, reportListPhrase } from "./report_catalogue.js";
import { renderGstCsv, renderMisCsv, renderPnlCsv, renderSalesCsv } from "./report_render.js";
import { dayShiftForClose, parseDayClose, tradingDayFileSuffix, tradingDayNote } from "./report_window.js";
import { buildXlsx, XLSX_MIME, type Cell, type CellKind, type SheetSpec } from "./xlsx_writer.js";
import { periodLabel, wallClock, type ReportHeadline } from "./report_email_content.js";

/** The page size a bundle reads at — the server's own ceiling (MIS_MAX_PAGE). */
const PAGE = 500;
/** A safety stop on the page loop, far past the row cap. */
const MAX_PAGES = 200;
const STATEMENT_TIMEOUT_MS = 20_000;

export interface BundleRequest {
  resId: string;
  /** The delivery's outlet: the one the schedule belongs to, or the Send now caller's. */
  outletId: string;
  scope: "outlet" | "all";
  keys: readonly string[];
  formats: readonly ("xlsx" | "csv")[];
  /** Business dates, inclusive. */
  from: string;
  to: string;
  /** "HH:mm" for a trading day, null for calendar days. */
  dayClose: string | null;
  windowStartAt: string;
  windowEndAt: string;
  /** Rows per report before the file is cut (default MAX_ROWS_PER_REPORT). */
  maxRows?: number;
  /** All attachments together, before encoding. */
  maxBytes: number;
  generatedAt?: Date;
}

/** One report, read in full (up to the cap), shaped as a table. */
export interface LoadedReport {
  key: string;
  title: string;
  columns: MisColumn[];
  rows: object[];
  totals: object | null;
  notes: string[];
  /** Rows the server said the window holds (the full count, even when cut). */
  totalRows: number;
  truncated: boolean;
  /** The CSV body — the .csv route's, for the rows read. */
  csv: string;
}

export interface BundleIdentity {
  restaurantName: string;
  outletName: string | null;
  currency: string | null;
  timezone: string;
}

export interface RenderedBundle {
  files: RenderedReportFile[];
  reports: { key: string; title: string; rows: number; truncated: boolean }[];
  headline: ReportHeadline | null;
  identity: BundleIdentity;
}

/** A refusal no retry can fix — the sweep records it as final. */
export class BundleTooLargeError extends Error {
  readonly permanent = true;
  constructor(bytes: number, max: number) {
    super(`These reports come to ${(bytes / 1_048_576).toFixed(1)} MB, over the ${(max / 1_048_576).toFixed(1)} MB an email may carry. Choose fewer reports or a shorter window.`);
    this.name = "BundleTooLargeError";
  }
}

type MisReader = (restaurantId: string, q: MisReportQuery) => Promise<{ meta: { notes: string[] }; columns: MisColumn[]; totals?: object; page?: { total: number; has_more: boolean } }>;

/** The fifteen, by key, and the payload array each one's table is. */
const MIS_READERS: Record<string, { read: MisReader; rows: (p: any) => object[] }> = {
  item_wise: { read: GetItemWiseReport, rows: (p) => p.rows },
  discount: { read: GetDiscountReport, rows: (p) => p.rows },
  void_kot: { read: GetVoidKotReport, rows: (p) => p.rows },
  bill_edit: { read: GetBillEditReport, rows: (p) => p.rows },
  sales_summary: { read: GetSalesSummaryReport, rows: (p) => p.series },
  order_summary: { read: GetOrderSummaryReport, rows: (p) => p.rows },
  executive_summary: { read: GetExecutiveSummaryReport, rows: (p) => p.by_outlet },
  cover_size_summary: { read: GetCoverSizeSummaryReport, rows: (p) => p.rows },
  settlement_summary: { read: GetSettlementSummaryReport, rows: (p) => p.rows },
  nc_summary: { read: GetNcSummaryReport, rows: (p) => p.rows },
  service_charge_deny: { read: GetServiceChargeDenyReport, rows: (p) => p.rows },
  group_summary: { read: GetGroupSummaryReport, rows: (p) => p.rows },
  variation_summary: { read: GetVariationSummaryReport, rows: (p) => p.rows },
  tip_summary: { read: GetTipSummaryReport, rows: (p) => p.rows },
  counter_summary: { read: GetCounterSummaryReport, rows: (p) => p.rows },
};

/** Exported for the wiring test: every catalogue MIS key has a reader. */
export const BUNDLE_MIS_KEYS: readonly string[] = Object.freeze(Object.keys(MIS_READERS));

/** One short transaction, bound to the delivery's outlet and scope. */
function readInTenant<T>(req: Pick<BundleRequest, "resId" | "outletId" | "scope">, work: () => Promise<T>): Promise<T> {
  return withTenant(
    { res_id: req.resId, outlet_id: req.outletId, employeeId: "", role: "", allOutlets: req.scope === "all" },
    async () => {
      await SetLocalStatementTimeout(STATEMENT_TIMEOUT_MS);
      return work();
    },
  );
}

const SALES_COLUMNS: MisColumn[] = [
  { key: "date", label: "Date", type: "date" },
  { key: "bills", label: "Bills", type: "int", total: true },
  { key: "sales", label: "Gross sales", type: "money", total: true },
  { key: "tax", label: "Tax", type: "money", total: true },
  { key: "service_charge", label: "Service Charge", type: "money", total: true },
  { key: "refund", label: "Refunds", type: "money", total: true },
  { key: "net", label: "Net sales", type: "money", total: true },
];
const GST_COLUMNS: MisColumn[] = [
  { key: "name", label: "Tax", type: "text" },
  { key: "percentage", label: "Rate %", type: "percent" },
  { key: "taxable", label: "Taxable", type: "money", total: true },
  { key: "tax", label: "Tax", type: "money", total: true },
];
const PNL_COLUMNS: MisColumn[] = [
  { key: "line", label: "Line", type: "text" },
  { key: "amount", label: "Amount", type: "money" },
];

const ACCOUNTING_NOTE = "Accounting report: bills are counted on the day they were settled, in the restaurant's own timezone.";

/** Read ONE report in full, up to the row cap. */
export async function loadReport(req: BundleRequest, key: string): Promise<LoadedReport> {
  const title = catalogueEntry(key)?.title ?? key;
  const maxRows = Math.max(1, Math.floor(req.maxRows ?? MAX_ROWS_PER_REPORT));
  const shift = req.dayClose ? dayShiftForClose(parseDayClose(req.dayClose) ?? 0) : 0;

  if (key === "sales") {
    const p: SalesReport = await readInTenant(req, () => GetSalesReport(req.resId, req.from, req.to, { dayShiftMin: shift }));
    const totals = { bills: p.bill_count, sales: p.total_sales, tax: p.total_tax, service_charge: p.total_service_charge, refund: p.total_refund, net: p.total_net };
    return {
      key, title, columns: SALES_COLUMNS, rows: p.by_day, totals,
      notes: shift ? [ACCOUNTING_NOTE, tradingDayNote(parseDayClose(req.dayClose) ?? 0)] : [ACCOUNTING_NOTE],
      totalRows: p.by_day.length, truncated: false, csv: renderSalesCsv(p),
    };
  }
  if (key === "gst") {
    const p: GstReport = await readInTenant(req, () => GetGstReport(req.resId, req.from, req.to));
    return {
      key, title, columns: GST_COLUMNS, rows: p.by_rate, totals: { taxable: p.total_taxable, tax: p.total_tax },
      notes: [ACCOUNTING_NOTE, "Taxable is turnover ex-tax and ex-round-off; service charge is part of turnover."],
      totalRows: p.by_rate.length, truncated: false, csv: renderGstCsv(p),
    };
  }
  if (key === "pnl") {
    const p: ProfitAndLoss = await readInTenant(req, () => GetProfitAndLoss(req.resId, req.from, req.to));
    const lines = [
      { line: "Gross sales", amount: p.gross_sales },
      { line: "Refunds", amount: p.refunds },
      { line: "Tax collected", amount: p.tax_collected },
      { line: "Service charge", amount: p.service_charge },
      { line: "Revenue ex-tax (after refunds)", amount: p.net_revenue },
      { line: "Total expenses", amount: p.total_expenses },
      { line: "Net profit", amount: p.net_profit },
      ...p.expenses_by_category.map((e) => ({ line: `Expense — ${e.category}`, amount: e.amount })),
    ];
    return {
      key, title, columns: PNL_COLUMNS, rows: lines, totals: null,
      notes: [ACCOUNTING_NOTE, "Expenses are counted on the day they were spent."],
      totalRows: lines.length, truncated: false, csv: renderPnlCsv(p),
    };
  }

  const reader = MIS_READERS[key];
  if (!reader) {throw new Error(`Unsupported report_key: ${key}`);}
  const base: MisReportQuery = { from: req.from, to: req.to, ...(req.dayClose ? { day_close: req.dayClose } : {}) };
  const entry = catalogueEntry(key);
  if (!entry?.paged) {
    const p = await readInTenant(req, () => reader.read(req.resId, base));
    const rows = reader.rows(p) ?? [];
    return {
      key, title, columns: p.columns, rows, totals: p.totals ?? null, notes: p.meta.notes,
      totalRows: rows.length, truncated: false, csv: renderMisCsv(p.columns, rows, p.totals ?? null),
    };
  }
  const rows: object[] = [];
  let last: Awaited<ReturnType<MisReader>> | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const offset = page * PAGE;
    const p = await readInTenant(req, () => reader.read(req.resId, { ...base, limit: PAGE, offset }));
    last = p;
    const batch = reader.rows(p) ?? [];
    rows.push(...batch);
    if (!p.page?.has_more || batch.length === 0 || rows.length >= maxRows) {break;}
  }
  if (!last) {throw new Error(`No payload for ${key}`);}
  const total = last.page?.total ?? rows.length;
  const kept = rows.slice(0, maxRows);
  const truncated = total > kept.length;
  const csv = renderMisCsv(last.columns, kept, last.totals ?? null);
  return {
    key, title, columns: last.columns, rows: kept, totals: last.totals ?? null, notes: last.meta.notes,
    totalRows: total, truncated,
    // A cut file SAYS it is cut, in a row as wide as the report (report_render's rule).
    csv: truncated ? `${csv}\n${truncationMarker(last.columns.length, kept.length, total)}` : csv,
  };
}

function truncationMarker(width: number, kept: number, total: number): string {
  return `TRUNCATED - ${String(kept)} of ${String(total)} rows${",".repeat(Math.max(0, width - 1))}`;
}

/** The headline a body carries. Best-effort: a failed read costs the headline, not the email. */
export async function loadHeadline(req: BundleRequest, loaded: ReadonlyMap<string, LoadedReport>): Promise<ReportHeadline | null> {
  try {
    const base: MisReportQuery = { from: req.from, to: req.to, ...(req.dayClose ? { day_close: req.dayClose } : {}) };
    const sales = await readInTenant(req, () => GetSalesSummaryReport(req.resId, base)) as SalesSummaryReport;
    const settlement = await readInTenant(req, () => GetSettlementSummaryReport(req.resId, base)) as SettlementSummaryReport;
    const voidTotals = loaded.get("void_kot")?.totals as { voids?: number } | undefined
      ?? (await readInTenant(req, () => GetVoidKotReport(req.resId, { ...base, limit: 1, offset: 0 }))).totals;
    const t = sales.totals;
    return {
      gross: t.grand_total,
      net: t.net,
      service_charge: t.service_charge,
      tax: t.tax,
      round_off: t.round_off,
      bills: t.bills,
      covers: t.covers,
      apc: t.apc,
      nc_value: t.nc_value,
      voids: typeof voidTotals?.voids === "number" ? voidTotals.voids : null,
      payments: settlement.rows
        .filter((r) => Number(r.amount) !== 0 || Number(r.bills) !== 0)
        .map((r) => ({ label: String(r.label ?? r.method), bills: Number(r.bills) || 0, amount: Number(r.amount) || 0 })),
    };
  } catch {
    return null;
  }
}

const kindOf = (t: MisColumn["type"]): CellKind => (t === "money" ? "money" : t === "int" ? "int" : t === "percent" ? "percent" : t === "datetime" ? "datetime" : t === "date" ? "date" : "text");

/** A table cell as a typed spreadsheet cell. Datetimes read as the restaurant's wall clock. */
function cellOf(value: unknown, col: MisColumn, tz: string, bold = false): Cell {
  if (value === null || value === undefined || value === "") {return bold ? { v: "", bold } : null;}
  const kind = kindOf(col.type);
  if (kind === "money" || kind === "int" || kind === "percent" || kind === "decimal") {
    const n = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(n)) {return { v: n, kind, bold };}
    return { v: String(value), bold };
  }
  if (kind === "datetime" && typeof value === "string") {return { v: wallClock(value, tz), bold };}
  if (typeof value === "boolean") {return { v: value ? "Yes" : "No", bold };}
  return { v: typeof value === "string" ? value : typeof value === "number" ? value : "", bold };
}

const at = (o: object, key: string): unknown => (o as Record<string, unknown>)[key];

/** One report as a sheet: bold header, typed rows, the payload's own totals row. */
export function reportSheet(r: LoadedReport, tz: string): SheetSpec {
  const header: Cell[] = r.columns.map((c) => ({ v: c.label, bold: true }));
  const body: Cell[][] = r.rows.map((row) => r.columns.map((c) => cellOf(at(row, c.key), c, tz)));
  if (r.totals) {
    const t = r.totals;
    const cells: Cell[] = r.columns.map((c, i) => (i === 0 ? { v: "Total", bold: true } : cellOf(at(t, c.key), c, tz, true)));
    if (cells.some((c, i) => i > 0 && c !== null && typeof c === "object" && c.v !== "" && c.v !== null && c.v !== undefined)) {body.push(cells);}
  }
  if (r.truncated) {
    body.push([{ v: `Cut at ${r.rows.length.toLocaleString("en-IN")} rows — the full report has ${r.totalRows.toLocaleString("en-IN")}. Download it from Reports for the rest.`, bold: true }]);
  }
  const widths = r.columns.map((c) => Math.min(48, Math.max(10, c.label.length + 2, c.type === "datetime" ? 20 : c.type === "text" ? 18 : 12)));
  return { name: r.title, rows: [header, ...body], widths, freezeRows: 1 };
}

function summarySheet(req: BundleRequest, reports: readonly LoadedReport[], headline: ReportHeadline | null, id: BundleIdentity, generatedAt: Date): SheetSpec {
  const tz = id.timezone;
  const rows: Cell[][] = [
    [{ v: id.restaurantName, bold: true }],
    ["Outlet", req.scope === "all" ? "All outlets (combined)" : (id.outletName ?? "This outlet")],
    ["Reports for", periodLabel(req.from, req.to)],
  ];
  if (req.dayClose) {rows.push(["Trading day closes at", req.dayClose]);}
  rows.push(["From", `${wallClock(req.windowStartAt, tz)} (${tz})`]);
  rows.push(["Up to (not included)", `${wallClock(req.windowEndAt, tz)} (${tz})`]);
  rows.push(["Generated", `${wallClock(generatedAt.toISOString(), tz)} (${tz})`]);
  rows.push([]);
  if (headline) {
    rows.push([{ v: "Headline", bold: true }]);
    const money = (label: string, v: number | null) => rows.push([label, v === null ? "—" : { v, kind: "money" }]);
    money("Gross (grand total)", headline.gross);
    money("Net (items less discounts)", headline.net);
    money("Service charge", headline.service_charge);
    money("Tax", headline.tax);
    money("Round off", headline.round_off);
    rows.push(["Bills", { v: headline.bills, kind: "int" }]);
    rows.push(["Covers", { v: headline.covers, kind: "int" }]);
    money("APC (pre-tax)", headline.apc);
    money("Non-chargeable given away", headline.nc_value);
    if (headline.voids !== null) {rows.push(["Voided KOTs", { v: headline.voids, kind: "int" }]);}
    rows.push([]);
    if (headline.payments.length > 0) {
      rows.push([{ v: "Payment mode", bold: true }, { v: "Bills", bold: true }, { v: "Collected", bold: true }]);
      for (const p of headline.payments) {rows.push([p.label, { v: p.bills, kind: "int" }, { v: p.amount, kind: "money" }]);}
      rows.push([]);
    }
  }
  rows.push([{ v: "Report", bold: true }, { v: "Rows", bold: true }, { v: "Note", bold: true }]);
  for (const r of reports) {
    rows.push([r.title, { v: r.rows.length, kind: "int" }, r.truncated ? `Cut at ${String(r.rows.length)} of ${String(r.totalRows)} rows` : ""]);
  }
  return { name: "Summary", rows, widths: [28, 22, 34] };
}

function notesSheet(req: BundleRequest, reports: readonly LoadedReport[], id: BundleIdentity): SheetSpec {
  const rows: Cell[][] = [
    [{ v: "How these numbers are counted", bold: true }],
    [{ v: `Every time in this workbook is restaurant time (${id.timezone}). Money is in ${id.currency || "INR"}.`, wrap: true }],
    [{ v: "Gross is the grand total of the bills: net + service charge + tax + round off. Net is the item total less discounts.", wrap: true }],
  ];
  if (req.dayClose) {rows.push([{ v: tradingDayNote(parseDayClose(req.dayClose) ?? 0), wrap: true }]);}
  for (const r of reports) {
    rows.push([]);
    rows.push([{ v: r.title, bold: true }]);
    for (const n of r.notes) {rows.push([{ v: n, wrap: true }]);}
  }
  return { name: "Notes", rows, widths: [110] };
}

/** "all-outlets" or the outlet's name as a filename-safe slug. */
export function scopeSlug(scope: "outlet" | "all", outletName: string | null): string {
  return scope === "all" ? "all-outlets" : (outletName ?? "outlet").replace(/[^A-Za-z0-9._-]+/g, "-");
}

/** Build every file for one delivery. Reads first (each its own transaction), renders after. */
export async function renderReportBundle(req: BundleRequest): Promise<RenderedBundle> {
  const generatedAt = req.generatedAt ?? new Date();
  const identity: BundleIdentity = await withTenant(
    { res_id: req.resId, outlet_id: req.outletId, employeeId: "", role: "" },
    async () => {
      const i = await GetReportEmailIdentity(req.resId, req.outletId);
      return { restaurantName: i.restaurant_name, outletName: i.outlet_name, currency: i.currency, timezone: i.timezone };
    },
  );
  const loaded = new Map<string, LoadedReport>();
  for (const key of req.keys) {loaded.set(key, await loadReport(req, key));}
  const headline = req.keys.length > 0 ? await loadHeadline(req, loaded) : null;
  const reports = req.keys.map((k) => loaded.get(k) as LoadedReport);
  const slug = scopeSlug(req.scope, identity.outletName);
  const suffix = tradingDayFileSuffix(req.dayClose ? parseDayClose(req.dayClose) : null);

  const render = (cap: number | null): RenderedReportFile[] => {
    const view = reports.map((r) => (cap === null || r.rows.length <= cap ? r : {
      ...r,
      rows: r.rows.slice(0, cap),
      truncated: true,
      csv: renderCut(r, cap),
    }));
    const files: RenderedReportFile[] = [];
    if (req.formats.includes("xlsx")) {
      const sheets = [summarySheet(req, view, headline, identity, generatedAt), ...view.map((r) => reportSheet(r, identity.timezone)), notesSheet(req, view, identity)];
      files.push({
        report_key: "bundle",
        format: "xlsx",
        filename: `reports_${slug}_${req.from}_to_${req.to}${suffix}.xlsx`,
        mime: XLSX_MIME,
        body: buildXlsx(sheets),
        rows: view.reduce((n, r) => n + r.rows.length, 0),
        truncated: view.some((r) => r.truncated),
      });
    }
    if (req.formats.includes("csv")) {
      for (const r of view) {
        files.push({
          report_key: r.key,
          format: "csv",
          filename: `${r.key}_${slug}_${req.from}_to_${req.to}${suffix}.csv`,
          mime: "text/csv; charset=utf-8",
          body: Buffer.from(r.csv, "utf8"),
          rows: r.rows.length,
          truncated: r.truncated,
        });
      }
    }
    return files;
  };

  // WITHIN THE ATTACHMENT LIMIT, OR SAY WHY NOT. Halve the rows per report and
  // try again, a few times; a bundle that still does not fit is refused out
  // loud rather than mailed as something the provider will bounce.
  let files = render(null);
  let size = files.reduce((n, f) => n + f.body.length, 0);
  let cap = Math.max(...reports.map((r) => r.rows.length), 0);
  for (let i = 0; size > req.maxBytes && i < 6 && cap > 50; i += 1) {
    cap = Math.floor(cap / 2);
    files = render(cap);
    size = files.reduce((n, f) => n + f.body.length, 0);
  }
  if (size > req.maxBytes) {throw new BundleTooLargeError(size, req.maxBytes);}

  const finalRows = new Map(files.filter((f) => f.format === "csv").map((f) => [f.report_key, f]));
  return {
    files,
    reports: reports.map((r) => ({
      key: r.key,
      title: r.title,
      rows: finalRows.get(r.key)?.rows ?? Math.min(r.rows.length, cap || r.rows.length),
      truncated: finalRows.get(r.key)?.truncated ?? (r.truncated || (cap > 0 && r.rows.length > cap)),
    })),
    headline,
    identity,
  };
}

/** A CSV cut to `cap` rows, with a marker row as wide as the report (report_render's rule). */
function renderCut(r: LoadedReport, cap: number): string {
  return `${renderMisCsv(r.columns, r.rows.slice(0, cap), r.totals)}\n${truncationMarker(r.columns.length, cap, r.totalRows)}`;
}

/** What a bundle's email says the reports are, for logs and the bell. */
export function bundleLabel(keys: readonly string[]): string {
  return reportListPhrase(keys);
}
