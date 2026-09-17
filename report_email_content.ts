/**
 * WHAT A REPORT EMAIL SAYS — subject, text, HTML, the bell line.
 *
 * PURE module: every word an outside accountant reads is decided here by value
 * and pinned by jest, with no transport and no database.
 *
 * NO OPEN RELAY. The server writes every sentence. The only text a restaurant
 * controls is its own name, its outlet's name and a schedule's name — each
 * stripped of control characters and cut to a length — and there is no
 * free-form message field anywhere. An address book that could carry a
 * message of the tenant's choosing to any address would be a spam cannon with
 * our domain's reputation on it.
 *
 * NO ADDRESSES OUTSIDE THE MESSAGE ITSELF. The bell line names how many, never
 * who: GET /notifications is readable by every signed-in employee.
 */

import { catalogueEntry, reportListPhrase } from "./report_catalogue.js";

/** The headline an email body carries — the Sales Summary's own totals. */
export interface ReportHeadline {
  gross: number;
  net: number;
  service_charge: number;
  tax: number;
  round_off: number;
  bills: number;
  covers: number;
  apc: number | null;
  nc_value: number;
  voids: number | null;
  payments: { label: string; bills: number; amount: number }[];
}

export interface ReportFileSummary {
  report_key: string;
  filename: string;
  format: string;
  rows: number;
  truncated: boolean;
}

export interface ReportEmailInput {
  restaurantName: string;
  outletName: string | null;
  scope: "outlet" | "all";
  scheduleName: string | null;
  kind: "scheduled" | "manual" | "adhoc";
  reportKeys: readonly string[];
  from: string;
  to: string;
  dayClose: string | null;
  windowStartAt: string;
  windowEndAt: string;
  timezone: string;
  currency: string | null;
  headline: ReportHeadline | null;
  files: readonly ReportFileSummary[];
  /** Filled per recipient, for the footer. */
  recipient: string;
  generatedAt: Date;
}

export interface ReportEmailContent {
  subject: string;
  text: string;
  html: string;
}

/** Restaurant-controlled text, made safe to place in a subject or a body. */
export function cleanTenantText(raw: unknown, max = 60): string {
  let out = "";
  for (const ch of String(raw ?? "")) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 32 || code === 127 ? " " : ch;
  }
  return [...out.replace(/\s+/g, " ").trim()].slice(0, max).join("");
}

export function escapeHtml(raw: string): string {
  return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Wed 17 Sep 2026" for a YYYY-MM-DD key — calendar arithmetic, no zone. */
export function dayLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) {return key;}
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${WEEKDAYS[d.getUTCDay()]} ${String(Number(m[3]))} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** "Wed 17 Sep 2026", or "1 Sep – 15 Sep 2026", or across years in full. */
export function periodLabel(from: string, to: string): string {
  if (from === to) {return dayLabel(from);}
  const a = dayLabel(from).split(" ");
  const b = dayLabel(to).split(" ");
  return a[3] === b[3] ? `${a[1]} ${a[2]} – ${b[1]} ${b[2]} ${b[3]}` : `${a.slice(1).join(" ")} – ${b.slice(1).join(" ")}`;
}

/** An instant as the restaurant's wall clock: "18 Sep 2026, 02:00". */
export function wallClock(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {return iso;}
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")}`;
}

/** Money in the Indian grouping the rest of the product prints: ₹1,23,456.00. */
export function money(n: number, currency: string | null): string {
  const code = String(currency ?? "INR").trim().toUpperCase() || "INR";
  const symbol = code === "INR" ? "₹" : `${code} `;
  const value = Number.isFinite(n) ? n : 0;
  const sign = value < 0 ? "-" : "";
  return `${sign}${symbol}${new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(value))}`;
}

const count = (n: number) => new Intl.NumberFormat("en-IN").format(Number.isFinite(n) ? n : 0);

/** The subject: who, what, which day. Never a figure. */
export function reportEmailSubject(i: Pick<ReportEmailInput, "restaurantName" | "outletName" | "scope" | "from" | "to" | "reportKeys">): string {
  const who = cleanTenantText(i.restaurantName) || "Your restaurant";
  const where = i.scope === "all" ? "All outlets" : cleanTenantText(i.outletName ?? "");
  const what = i.from === i.to ? (i.reportKeys.length === 1 ? reportListPhrase(i.reportKeys) : "Daily reports") : (i.reportKeys.length === 1 ? reportListPhrase(i.reportKeys) : "Reports");
  return `${who}${where ? ` · ${where}` : ""} — ${what} — ${periodLabel(i.from, i.to)}`;
}

function headlineLines(h: ReportHeadline, currency: string | null): [string, string][] {
  const lines: [string, string][] = [
    ["Gross (grand total)", money(h.gross, currency)],
    ["Net (items less discounts)", money(h.net, currency)],
    ["Service charge", money(h.service_charge, currency)],
    ["Tax", money(h.tax, currency)],
    ["Round off", money(h.round_off, currency)],
    ["Bills", count(h.bills)],
    ["Covers", count(h.covers)],
    ["APC (pre-tax)", h.apc === null ? "—" : money(h.apc, currency)],
    ["Non-chargeable given away", money(h.nc_value, currency)],
  ];
  if (h.voids !== null) {lines.push(["Voided KOTs", count(h.voids)]);}
  return lines;
}

function fileLine(f: ReportFileSummary): string {
  const what = f.report_key === "bundle" ? "all reports in one workbook" : (catalogueEntry(f.report_key)?.title ?? f.report_key);
  return `${f.filename} — ${what}${f.report_key === "bundle" ? "" : `, ${count(f.rows)} row${f.rows === 1 ? "" : "s"}`}${f.truncated ? " (cut short — the file says where)" : ""}`;
}

/** The whole message for one recipient. */
export function buildReportEmail(i: ReportEmailInput): ReportEmailContent {
  const who = cleanTenantText(i.restaurantName) || "Your restaurant";
  const where = i.scope === "all" ? "All outlets (combined)" : (cleanTenantText(i.outletName ?? "") || "This outlet");
  const period = periodLabel(i.from, i.to);
  const zone = i.timezone;
  const windowLine = i.dayClose
    ? `Trading day closing at ${i.dayClose}: from ${wallClock(i.windowStartAt, zone)} up to ${wallClock(i.windowEndAt, zone)} (${zone}).`
    : `Calendar ${i.from === i.to ? "day" : "days"}: from ${wallClock(i.windowStartAt, zone)} up to ${wallClock(i.windowEndAt, zone)} (${zone}).`;
  const noBills = i.headline !== null && i.headline.bills === 0;
  const scheduleName = cleanTenantText(i.scheduleName ?? "");
  const origin = i.kind === "adhoc"
    ? "Sent on request from the Reports screen."
    : `Sent by the schedule "${scheduleName || "Scheduled reports"}"${i.kind === "manual" ? " (run by hand)" : ""}.`;

  const text: string[] = [];
  text.push(`${who} — ${where}`);
  text.push(`${reportListPhrase(i.reportKeys, 3)} for ${period}`);
  text.push(windowLine);
  text.push("");
  if (i.headline) {
    if (noBills) {
      text.push("No bills were settled in this window. The attached reports are empty on purpose — this is not a failed report.");
    } else {
      for (const [label, value] of headlineLines(i.headline, i.currency)) {text.push(`${label}: ${value}`);}
      if (i.headline.payments.length > 0) {
        text.push("");
        text.push("Collected by payment mode:");
        for (const p of i.headline.payments) {text.push(`  ${cleanTenantText(p.label, 40)}: ${money(p.amount, i.currency)} (${count(p.bills)} bill${p.bills === 1 ? "" : "s"})`);}
      }
    }
    text.push("");
  }
  text.push("Attached:");
  for (const f of i.files) {text.push(`  ${fileLine(f)}`);}
  text.push("");
  if (i.dayClose) {
    text.push("Bills settled after midnight count on the trading day they belong to; the printed bill keeps its calendar date.");
  }
  text.push("Gross is the grand total (net + service charge + tax + round off). Net is the item total less discounts.");
  text.push(origin);
  text.push("");
  text.push(`You are receiving this because ${who} added ${i.recipient} to its report address book. To stop these emails, ask them to remove it.`);
  text.push(`Generated ${wallClock(i.generatedAt.toISOString(), zone)} (${zone}).`);

  const rows = (pairs: [string, string][]) => pairs
    .map(([k, v]) => `<tr><td style="padding:2px 16px 2px 0;color:#555">${escapeHtml(k)}</td><td style="padding:2px 0;text-align:right;font-variant-numeric:tabular-nums">${escapeHtml(v)}</td></tr>`)
    .join("");
  const html: string[] = [];
  html.push("<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;line-height:1.45\">");
  html.push(`<p style="margin:0 0 4px;font-size:16px"><strong>${escapeHtml(who)}</strong> — ${escapeHtml(where)}</p>`);
  html.push(`<p style="margin:0 0 4px">${escapeHtml(reportListPhrase(i.reportKeys, 3))} for <strong>${escapeHtml(period)}</strong></p>`);
  html.push(`<p style="margin:0 0 12px;color:#555">${escapeHtml(windowLine)}</p>`);
  if (i.headline) {
    if (noBills) {
      html.push("<p style=\"margin:0 0 12px\"><strong>No bills were settled in this window.</strong> The attached reports are empty on purpose — this is not a failed report.</p>");
    } else {
      html.push(`<table style="border-collapse:collapse;margin:0 0 12px">${rows(headlineLines(i.headline, i.currency))}</table>`);
      if (i.headline.payments.length > 0) {
        html.push("<p style=\"margin:0 0 4px\"><strong>Collected by payment mode</strong></p>");
        html.push(`<table style="border-collapse:collapse;margin:0 0 12px">${rows(i.headline.payments.map((p) => [`${cleanTenantText(p.label, 40)} (${count(p.bills)} bill${p.bills === 1 ? "" : "s"})`, money(p.amount, i.currency)]))}</table>`);
      }
    }
  }
  html.push(`<p style="margin:0 0 4px"><strong>Attached</strong></p><ul style="margin:0 0 12px;padding-left:18px">${i.files.map((f) => `<li>${escapeHtml(fileLine(f))}</li>`).join("")}</ul>`);
  if (i.dayClose) {
    html.push("<p style=\"margin:0 0 4px;color:#555\">Bills settled after midnight count on the trading day they belong to; the printed bill keeps its calendar date.</p>");
  }
  html.push("<p style=\"margin:0 0 4px;color:#555\">Gross is the grand total (net + service charge + tax + round off). Net is the item total less discounts.</p>");
  html.push(`<p style="margin:0 0 12px;color:#555">${escapeHtml(origin)}</p>`);
  html.push(`<p style="margin:0;color:#777;font-size:12px">You are receiving this because ${escapeHtml(who)} added ${escapeHtml(i.recipient)} to its report address book. To stop these emails, ask them to remove it. Generated ${escapeHtml(wallClock(i.generatedAt.toISOString(), zone))} (${escapeHtml(zone)}).</p>`);
  html.push("</div>");

  return { subject: reportEmailSubject(i), text: `${text.join("\n")}\n`, html: html.join("") };
}

/** A test message: proves the path, carries no figures and no attachment. */
export function buildTestEmail(i: { restaurantName: string; recipient: string; generatedAt: Date; timezone: string }): ReportEmailContent {
  const who = cleanTenantText(i.restaurantName) || "Your restaurant";
  const when = `${wallClock(i.generatedAt.toISOString(), i.timezone)} (${i.timezone})`;
  const lines = [
    `This is a test email from ${who}'s reports.`,
    "",
    "If you can read this, reports emailed to this address will arrive. It contains no figures and no attachment.",
    "If it arrived in spam, mark it as not spam so the daily reports do not end up there too.",
    "",
    `You are receiving this because ${who} added ${i.recipient} to its report address book. To stop these emails, ask them to remove it.`,
    `Sent ${when}.`,
  ];
  return {
    subject: `${who} — Test email from Reports`,
    text: `${lines.join("\n")}\n`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;line-height:1.45">${lines.map((l) => (l ? `<p style="margin:0 0 8px">${escapeHtml(l)}</p>` : "")).join("")}</div>`,
  };
}

/** The bell line after a send: how many, never who, never a figure. */
export function sentBellTitle(i: { from: string; to: string; kind: "scheduled" | "manual" | "adhoc"; accepted: number; reportKeys: readonly string[] }): string {
  const what = i.reportKeys.length === 0 ? "Test email" : i.from === i.to ? "Daily reports" : "Reports";
  const day = i.from === i.to ? dayLabel(i.from).split(" ").slice(0, 3).join(" ") : periodLabel(i.from, i.to);
  if (i.reportKeys.length === 0) {return `Test email sent (${String(i.accepted)} recipient${i.accepted === 1 ? "" : "s"})`;}
  return `${what} sent — ${day} (${String(i.accepted)} recipient${i.accepted === 1 ? "" : "s"})`;
}

export function sentBellBody(i: { refused: number; skipped: number; maybeDuplicate: boolean }): string {
  const parts = ["Open Reports → Email reports to see where it went and download the files."];
  if (i.refused > 0) {parts.push(`${String(i.refused)} address${i.refused === 1 ? " was" : "es were"} refused by the mail service.`);}
  if (i.skipped > 0) {parts.push(`${String(i.skipped)} address${i.skipped === 1 ? " was" : "es were"} skipped (no longer in the address book, or a daily limit was reached).`);}
  if (i.maybeDuplicate) {parts.push("The server restarted while sending, so someone may have received it twice.");}
  return parts.join(" ");
}
