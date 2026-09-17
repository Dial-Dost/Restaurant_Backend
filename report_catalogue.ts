/**
 * THE REPORTS THAT CAN BE EMAILED, and what each one may be asked for.
 *
 * PURE module — no database, no network — for the reason report_window.ts is:
 * the rules below decide what an owner can put in a schedule, and they are
 * proved by value.
 *
 * EIGHTEEN KEYS, and no more. The fifteen MIS / control documents of Insights →
 * Reports (routes/reports_mis.ts), in their tab order, then the three accounting
 * reports migration 026 could already schedule. Payroll and the balance sheet
 * are NOT here: a payroll period is a calendar month by GetPayroll's own
 * signature and a balance sheet is a point in time, so neither has a daily
 * form — migration 026's period-shape tripwire exists to keep them out.
 *
 * WHICH DAYS EACH MAY BE READ ON. Every MIS report and the accounting Sales
 * report take a trading day (report_window.ts). GST and P&L do not: they are
 * statutory, month-based documents, and a GST return filed off a 02:00-to-02:00
 * day would not agree with the invoices it summarises. The schedule CHECK
 * (migration 057) says the same thing, so no client can store the pair.
 *
 * `rows` names the array of the payload that IS the table — the same fact the
 * GET /reports/mis catalogue publishes — so the file an accountant opens has
 * the rows the screen shows.
 */

export type ReportFamily = "mis" | "accounting";
export type ReportWindowMode = "calendar" | "trading_day";

export interface ReportCatalogueEntry {
  key: string;
  title: string;
  family: ReportFamily;
  /** The payload array that is the table. */
  rows: "rows" | "series" | "by_outlet" | "by_day" | "by_rate" | "lines";
  /** The server pages this report (limit/offset); an email reads every page. */
  paged: boolean;
  /** The windows this report may be read on. */
  windowModes: readonly ReportWindowMode[];
}

const BOTH: readonly ReportWindowMode[] = Object.freeze(["calendar", "trading_day"]);
const CALENDAR_ONLY: readonly ReportWindowMode[] = Object.freeze(["calendar"]);

const CATALOGUE_ROWS: ReportCatalogueEntry[] = [
  { key: "item_wise", title: "Item Wise", family: "mis", rows: "rows", paged: true, windowModes: BOTH },
  { key: "discount", title: "Discount", family: "mis", rows: "rows", paged: true, windowModes: BOTH },
  { key: "void_kot", title: "Void KOT", family: "mis", rows: "rows", paged: true, windowModes: BOTH },
  { key: "bill_edit", title: "Bill Edit", family: "mis", rows: "rows", paged: true, windowModes: BOTH },
  { key: "sales_summary", title: "Sales Summary", family: "mis", rows: "series", paged: false, windowModes: BOTH },
  { key: "order_summary", title: "Order Summary", family: "mis", rows: "rows", paged: true, windowModes: BOTH },
  { key: "executive_summary", title: "Executive Summary", family: "mis", rows: "by_outlet", paged: false, windowModes: BOTH },
  { key: "cover_size_summary", title: "Cover Size Summary", family: "mis", rows: "rows", paged: false, windowModes: BOTH },
  { key: "settlement_summary", title: "Settlement Summary", family: "mis", rows: "rows", paged: false, windowModes: BOTH },
  { key: "nc_summary", title: "NC Summary", family: "mis", rows: "rows", paged: true, windowModes: BOTH },
  { key: "service_charge_deny", title: "Service Charge Deny", family: "mis", rows: "rows", paged: true, windowModes: BOTH },
  { key: "group_summary", title: "Group Summary", family: "mis", rows: "rows", paged: false, windowModes: BOTH },
  { key: "variation_summary", title: "Variation Summary", family: "mis", rows: "rows", paged: false, windowModes: BOTH },
  { key: "tip_summary", title: "Tip Summary", family: "mis", rows: "rows", paged: true, windowModes: BOTH },
  { key: "counter_summary", title: "Counter Summary", family: "mis", rows: "rows", paged: false, windowModes: BOTH },
  { key: "sales", title: "Sales (accounting)", family: "accounting", rows: "by_day", paged: false, windowModes: BOTH },
  { key: "gst", title: "GST", family: "accounting", rows: "by_rate", paged: false, windowModes: CALENDAR_ONLY },
  { key: "pnl", title: "Profit & Loss", family: "accounting", rows: "lines", paged: false, windowModes: CALENDAR_ONLY },
];

export const REPORT_CATALOGUE: readonly ReportCatalogueEntry[] = Object.freeze(CATALOGUE_ROWS.map((e) => Object.freeze(e)));

export const REPORT_KEYS: readonly string[] = Object.freeze(REPORT_CATALOGUE.map((e) => e.key));
export const MIS_REPORT_KEYS: readonly string[] = Object.freeze(REPORT_CATALOGUE.filter((e) => e.family === "mis").map((e) => e.key));
/** The keys a trading day refuses. Migration 057's CHECK names the same two. */
export const CALENDAR_ONLY_KEYS: readonly string[] = Object.freeze(
  REPORT_CATALOGUE.filter((e) => !e.windowModes.includes("trading_day")).map((e) => e.key),
);

/** The attachment formats phase 1 can actually build. PDF is phase 2, and 026's
 *  rule holds: nothing is storable before something renders it. */
export const REPORT_EMAIL_FORMATS = ["xlsx", "csv"] as const;
export type ReportEmailFormat = (typeof REPORT_EMAIL_FORMATS)[number];

export const REPORT_WINDOW_MODES: readonly ReportWindowMode[] = BOTH;

/** At most this many recipients on one schedule or one send. */
export const MAX_REPORT_RECIPIENTS = 10;
/** At most this many live addresses in one restaurant's address book. */
export const MAX_ADDRESS_BOOK = 25;
/** At most this many email schedules on one outlet. */
export const MAX_EMAIL_SCHEDULES_PER_OUTLET = 20;
/** The widest window Send now will build. */
export const MAX_SEND_WINDOW_DAYS = 92;
/** Rows per report in one attachment, before it is cut and says so. */
export const MAX_ROWS_PER_REPORT = 20_000;

export function catalogueEntry(key: string): ReportCatalogueEntry | null {
  return REPORT_CATALOGUE.find((e) => e.key === key) ?? null;
}

export function isReportKey(key: unknown): key is string {
  return typeof key === "string" && REPORT_KEYS.includes(key);
}

export type ReportSelection =
  | { ok: true; keys: string[] }
  | { ok: false; error: string };

/**
 * A client's list of report keys, checked and put in CATALOGUE order.
 *
 * Refused out loud, one sentence: an unknown key, an empty list, and — on a
 * trading day — GST or P&L. De-duplicated silently, because ticking the same box
 * twice is not a mistake worth a refusal.
 */
export function validateReportSelection(raw: unknown, windowMode: ReportWindowMode): ReportSelection {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" && raw.trim() ? [raw] : [];
  if (list.length === 0) {return { ok: false, error: "Pick at least one report to send." };}
  const wanted = new Set<string>();
  for (const k of list) {
    const key = String(k ?? "").trim().toLowerCase();
    if (!isReportKey(key)) {return { ok: false, error: `"${String(k)}" is not a report that can be emailed.` };}
    wanted.add(key);
  }
  if (windowMode === "trading_day") {
    const blocked = CALENDAR_ONLY_KEYS.filter((k) => wanted.has(k));
    if (blocked.length > 0) {
      const names = blocked.map((k) => catalogueEntry(k)?.title ?? k).join(" and ");
      return { ok: false, error: `${names} can only be sent for calendar days. Choose "previous calendar day", or leave ${blocked.length > 1 ? "them" : "it"} out.` };
    }
  }
  return { ok: true, keys: REPORT_KEYS.filter((k) => wanted.has(k)) };
}

/** The formats a client asked for, checked; defaults to the workbook. */
export function validateReportFormats(raw: unknown): { ok: true; formats: ReportEmailFormat[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {return { ok: true, formats: ["xlsx"] };}
  const list = Array.isArray(raw) ? raw : [raw];
  const wanted = new Set<string>();
  for (const f of list) {
    const v = String(f ?? "").trim().toLowerCase();
    if (v === "pdf") {return { ok: false, error: "PDF attachments are not available yet. Choose Excel or CSV." };}
    if (!(REPORT_EMAIL_FORMATS as readonly string[]).includes(v)) {return { ok: false, error: `"${String(f)}" is not an attachment format. Choose Excel or CSV.` };}
    wanted.add(v);
  }
  if (wanted.size === 0) {return { ok: false, error: "Choose Excel, CSV or both." };}
  return { ok: true, formats: REPORT_EMAIL_FORMATS.filter((f) => wanted.has(f)) };
}

export function isWindowMode(v: unknown): v is ReportWindowMode {
  return v === "calendar" || v === "trading_day";
}

/**
 * The legacy single-key column a bundle row also carries (migration 026's
 * report_key): the one key, or 'bundle'. Code reads `report_keys` first and
 * falls back to `[report_key]`, so a row written before migration 057 still
 * reads as the one report it always was.
 */
export function legacyReportKey(keys: readonly string[]): string {
  return keys.length === 1 ? keys[0] : "bundle";
}

/** The keys a stored row stands for: `report_keys` when set, else `[report_key]`. */
export function reportKeysOfRow(row: { report_keys?: unknown; report_key?: unknown }): string[] {
  const keys = Array.isArray(row.report_keys) ? row.report_keys.map((k) => String(k)).filter(isReportKey) : [];
  if (keys.length > 0) {return keys;}
  const one = String(row.report_key ?? "");
  return isReportKey(one) ? [one] : [];
}

/**
 * "Sales Summary, Settlement Summary and 3 more" — for a subject line or a bell.
 * Up to `max` titles are all named, the last joined with "and": the email's
 * own opening line asks for three, and joining three with nothing once printed
 * "Item WiseDiscountVoid KOT".
 */
export function reportListPhrase(keys: readonly string[], max = 2): string {
  const titles = keys.map((k) => catalogueEntry(k)?.title ?? k);
  if (titles.length === REPORT_KEYS.length) {return "All reports";}
  if (titles.length === MIS_REPORT_KEYS.length && keys.every((k) => MIS_REPORT_KEYS.includes(k))) {return "All 15 MIS reports";}
  if (titles.length <= max) {return namedList(titles);}
  return `${titles.slice(0, max).join(", ")} and ${String(titles.length - max)} more`;
}

/** "A", "A and B", "A, B and C". */
function namedList(titles: readonly string[]): string {
  if (titles.length <= 1) {return titles[0] ?? "";}
  return `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
}
