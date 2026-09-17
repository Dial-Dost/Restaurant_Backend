// WHAT A REPORT EMAIL SAYS (report_email_content.ts) — pure, by value.
//
// An outside accountant reads these words with no login and no context, so
// every one is pinned: who it is from, which day, the exact instants of a
// trading day, the headline, what is attached, why they got it. And the three
// things that must NEVER be in one: a tenant-written message (no open relay),
// another recipient's address, and — in the bell — any address or figure.

import { describe, test, expect } from "@jest/globals";
import {
  buildReportEmail,
  buildTestEmail,
  cleanTenantText,
  dayLabel,
  escapeHtml,
  money,
  periodLabel,
  readMessageMeta,
  reportEmailSubject,
  sentBellBody,
  sentBellTitle,
  wallClock,
  type ReportEmailInput,
} from "../report_email_content";

const base: ReportEmailInput = {
  restaurantName: "Gaia Global Vegetarian",
  outletName: "Koramangala",
  scope: "outlet",
  scheduleName: "Night pack",
  kind: "scheduled",
  reportKeys: ["sales_summary", "settlement_summary", "void_kot"],
  from: "2026-09-16",
  to: "2026-09-16",
  dayClose: "02:00",
  windowStartAt: "2026-09-15T20:30:00.000Z",
  windowEndAt: "2026-09-16T20:30:00.000Z",
  timezone: "Asia/Kolkata",
  currency: "INR",
  headline: {
    gross: 123456.5, net: 110000, service_charge: 1100, tax: 5555.5, round_off: -0.2,
    bills: 49, covers: 120, apc: 916.67, nc_value: 300, voids: 2,
    payments: [{ label: "Cash", bills: 20, amount: 50000 }, { label: "UPI", bills: 29, amount: 73456.5 }],
  },
  files: [
    { report_key: "bundle", filename: "reports_Koramangala_2026-09-16_to_2026-09-16_close-0200.xlsx", format: "xlsx", rows: 57, truncated: false },
    { report_key: "void_kot", filename: "void_kot_Koramangala_2026-09-16_to_2026-09-16_close-0200.csv", format: "csv", rows: 1, truncated: true },
  ],
  recipient: "accounts@firm.test",
  generatedAt: new Date("2026-09-16T20:31:00.000Z"),
};

describe("what a retry builds its body from (readMessageMeta)", () => {
  const stored = {
    v: 1, generated_at: "2026-09-16T20:31:00.000Z", headline: base.headline,
    restaurant_name: "Gaia Global Vegetarian", outlet_name: "Koramangala", currency: "INR", timezone: "Asia/Kolkata",
  };

  test("round-trips through JSON (jsonb), as an object or as text", () => {
    expect(readMessageMeta(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    expect(readMessageMeta(JSON.stringify(stored))).toEqual(stored);
    // The same body, byte for byte, from what was stored.
    const again = readMessageMeta(JSON.parse(JSON.stringify(stored)));
    expect(buildReportEmail({ ...base, headline: again?.headline ?? null, generatedAt: new Date(String(again?.generated_at)) }))
      .toEqual(buildReportEmail(base));
  });

  test("anything it cannot trust reads as nothing stored (the caller builds its own once)", () => {
    for (const bad of [null, undefined, "", "not json", 7, [], { ...stored, v: 2 }, { ...stored, generated_at: "yesterday" },
      { ...stored, restaurant_name: 5 }, { ...stored, timezone: "" }]) {
      expect(readMessageMeta(bad)).toBeNull();
    }
  });

  test("a headline with any part the body cannot print is dropped, not half-printed", () => {
    expect(readMessageMeta({ ...stored, headline: { ...base.headline, gross: "12" } })?.headline).toBeNull();
    expect(readMessageMeta({ ...stored, headline: { ...base.headline, payments: [{ label: "Cash", bills: 1 }] } })?.headline).toBeNull();
    expect(readMessageMeta({ ...stored, headline: null })?.headline).toBeNull();
    expect(readMessageMeta({ ...stored, outlet_name: null, currency: null })).toMatchObject({ outlet_name: null, currency: null });
  });
});

describe("the words", () => {
  test("labels: a day, a range, a wall clock in the restaurant's zone", () => {
    expect(dayLabel("2026-09-17")).toBe("Thu 17 Sep 2026");
    expect(periodLabel("2026-09-01", "2026-09-15")).toBe("1 Sep – 15 Sep 2026");
    expect(periodLabel("2025-12-25", "2026-01-02")).toBe("25 Dec 2025 – 2 Jan 2026");
    expect(wallClock("2026-09-16T20:30:00.000Z", "Asia/Kolkata")).toBe("17 Sep 2026, 02:00");
  });

  test("money in the Indian grouping, with the sign in front", () => {
    expect(money(123456.5, "INR")).toBe("₹1,23,456.50");
    expect(money(-0.2, null)).toBe("-₹0.20");
    expect(money(10, "USD")).toBe("USD 10.00");
    expect(money(Number.NaN, "INR")).toBe("₹0.00");
  });

  test("the subject: who · where — what — which day; never a figure", () => {
    expect(reportEmailSubject(base)).toBe("Gaia Global Vegetarian · Koramangala — Daily reports — Wed 16 Sep 2026");
    expect(reportEmailSubject({ ...base, reportKeys: ["gst"], from: "2026-08-01", to: "2026-08-31", scope: "all" }))
      .toBe("Gaia Global Vegetarian · All outlets — GST — 1 Aug – 31 Aug 2026");
    expect(reportEmailSubject(base)).not.toMatch(/\d+\.\d{2}|₹/);
  });

  test("restaurant-controlled text is stripped of control characters and cut", () => {
    expect(cleanTenantText("Gaia\r\nBcc: x@y.test")).toBe("Gaia Bcc: x@y.test");
    expect([...cleanTenantText("x".repeat(100))]).toHaveLength(60);
    expect(reportEmailSubject({ ...base, restaurantName: "Evil\nSubject: spoof" })).not.toContain("\n");
  });
});

describe("the body", () => {
  const mail = buildReportEmail(base);

  test("opens with who, where, and every report by name — three of them read as a list", () => {
    const lines = mail.text.split("\n");
    expect(lines[0]).toBe("Gaia Global Vegetarian — Koramangala");
    expect(lines[1]).toBe("Sales Summary, Settlement Summary and Void KOT for Wed 16 Sep 2026");
    expect(mail.html).toContain("Sales Summary, Settlement Summary and Void KOT for <strong>Wed 16 Sep 2026</strong>");
    const four = buildReportEmail({ ...base, reportKeys: ["item_wise", "discount", "void_kot", "bill_edit"] });
    expect(four.text.split("\n")[1]).toBe("Item Wise, Discount, Void KOT and 1 more for Wed 16 Sep 2026");
  });

  test("says the trading day with its exact instants and zone", () => {
    expect(mail.text).toContain("Trading day closing at 02:00: from 16 Sep 2026, 02:00 up to 17 Sep 2026, 02:00 (Asia/Kolkata).");
    expect(mail.text).toContain("Bills settled after midnight count on the trading day they belong to");
  });

  test("carries the headline and the payment split, in money", () => {
    for (const line of ["Gross (grand total): ₹1,23,456.50", "Net (items less discounts): ₹1,10,000.00", "Round off: -₹0.20", "Bills: 49", "Covers: 120", "APC (pre-tax): ₹916.67", "Voided KOTs: 2", "  UPI: ₹73,456.50 (29 bills)"]) {
      expect(mail.text).toContain(line);
    }
  });

  test("lists the attachments, with rows and a cut file flagged", () => {
    expect(mail.text).toContain("reports_Koramangala_2026-09-16_to_2026-09-16_close-0200.xlsx — all reports in one workbook");
    expect(mail.text).toContain("void_kot_Koramangala_2026-09-16_to_2026-09-16_close-0200.csv — Void KOT, 1 row (cut short — the file says where)");
  });

  test("says why THIS address got it, and names no other", () => {
    expect(mail.text).toContain("because Gaia Global Vegetarian added accounts@firm.test to its report address book");
    expect(mail.text.match(/@/g)).toHaveLength(1);
    expect(mail.html.match(/@/g)).toHaveLength(1);
    expect(mail.text).toContain('Sent by the schedule "Night pack".');
  });

  test("a day with no bills says so, instead of looking like a failed report", () => {
    const empty = buildReportEmail({ ...base, headline: { ...base.headline!, bills: 0, gross: 0, payments: [] } });
    expect(empty.text).toContain("No bills were settled in this window. The attached reports are empty on purpose");
    expect(empty.text).not.toContain("Gross (grand total)");
  });

  test("a calendar day says calendar day; Send now says it was on request", () => {
    const cal = buildReportEmail({ ...base, dayClose: null, kind: "adhoc", windowStartAt: "2026-09-15T18:30:00.000Z", windowEndAt: "2026-09-16T18:30:00.000Z" });
    expect(cal.text).toContain("Calendar day: from 16 Sep 2026, 00:00 up to 17 Sep 2026, 00:00 (Asia/Kolkata).");
    expect(cal.text).not.toContain("Trading day");
    expect(cal.text).toContain("Sent on request from the Reports screen.");
  });

  test("the HTML escapes everything the restaurant controls", () => {
    const x = buildReportEmail({ ...base, restaurantName: "<script>alert(1)</script>", scheduleName: "\"><img>", headline: { ...base.headline!, payments: [{ label: "<b>UPI</b>", bills: 1, amount: 1 }] } });
    expect(x.html).not.toMatch(/<script>|<img>|<b>UPI/);
    expect(x.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(escapeHtml("a&b<c>\"'")).toBe("a&amp;b&lt;c&gt;&quot;&#39;");
  });

  test("no field lets a tenant write a message of their own", () => {
    // The input type has no free text beyond names — asserted by value: every
    // sentence of the body comes from this module.
    const keys = Object.keys(base).sort();
    expect(keys).toEqual([
      "currency", "dayClose", "files", "from", "generatedAt", "headline", "kind", "outletName",
      "recipient", "reportKeys", "restaurantName", "scheduleName", "scope", "timezone", "to",
      "windowEndAt", "windowStartAt",
    ]);
  });
});

describe("the test email and the bell", () => {
  test("a test email has no figure and no attachment line", () => {
    const t = buildTestEmail({ restaurantName: "Gaia", recipient: "owner@gaia.test", generatedAt: new Date("2026-09-17T04:00:00Z"), timezone: "Asia/Kolkata" });
    expect(t.subject).toBe("Gaia — Test email from Reports");
    expect(t.text).not.toMatch(/₹|\d+\.\d{2}|Attached/);
    expect(t.text).toContain("Sent 17 Sep 2026, 09:30 (Asia/Kolkata).");
  });

  test("the bell names how many, never who and never a figure", () => {
    const title = sentBellTitle({ from: "2026-09-16", to: "2026-09-16", kind: "scheduled", accepted: 2, reportKeys: ["sales_summary"] });
    expect(title).toBe("Daily reports sent — Wed 16 Sep (2 recipients)");
    expect(sentBellTitle({ from: "2026-09-01", to: "2026-09-15", kind: "adhoc", accepted: 1, reportKeys: ["gst"] })).toBe("Reports sent — 1 Sep – 15 Sep 2026 (1 recipient)");
    expect(sentBellTitle({ from: "2026-09-16", to: "2026-09-16", kind: "adhoc", accepted: 1, reportKeys: [] })).toBe("Test email sent (1 recipient)");
    const body = sentBellBody({ refused: 1, skipped: 2, maybeDuplicate: true });
    expect(body).toBe("Open Reports → Email reports to see where it went and download the files. 1 address was refused by the mail service. 2 addresses were skipped (no longer in the address book, or a daily limit was reached). The server restarted while sending, so someone may have received it twice.");
    expect(`${title} ${body}`).not.toMatch(/@|₹|\d+\.\d{2}/);
  });
});
