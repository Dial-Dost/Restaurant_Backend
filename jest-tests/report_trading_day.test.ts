// THE TRADING DAY — "the end of each day, at a time I choose".
//
// Pure rules from report_window.ts, proved by value. The money under a trading
// day is driven through the real readers in
// test/money/mis_trading_day_agreement.test.ts; this file pins the arithmetic
// every one of those readers leans on.

import { describe, test, expect } from "@jest/globals";
import {
  addDaysToKey,
  dayCloseOfShift,
  dayShiftForClose,
  parseDayClose,
  serviceDayKey,
  tradingBusinessDate,
  tradingDayBounds,
  tradingDayFileSuffix,
  tradingDayNote,
  type TimeSlot,
} from "../report_window";
import {
  CALENDAR_ONLY_KEYS,
  MIS_REPORT_KEYS,
  REPORT_CATALOGUE,
  REPORT_KEYS,
  legacyReportKey,
  reportKeysOfRow,
  reportListPhrase,
  validateReportFormats,
  validateReportSelection,
} from "../report_catalogue";

const hm = (h: number, m = 0) => h * 60 + m;

describe("the close and its shift", () => {
  test("a morning close shifts forward, an evening close shifts back, 12:00 is the pivot", () => {
    expect(dayShiftForClose(hm(0))).toBe(0);
    expect(dayShiftForClose(hm(2))).toBe(120);
    expect(dayShiftForClose(hm(4, 30))).toBe(270);
    expect(dayShiftForClose(hm(12))).toBe(720);
    expect(dayShiftForClose(hm(12, 1))).toBe(-719);
    expect(dayShiftForClose(hm(23, 30))).toBe(-30);
    expect(dayShiftForClose(hm(23, 59))).toBe(-1);
  });

  test("the shift gives its close back, for every minute of the day", () => {
    for (let m = 0; m < 1440; m += 1) {expect(dayCloseOfShift(dayShiftForClose(m))).toBe(m);}
  });

  test("?day_close= is read as HH:mm; 24:00 is midnight; anything else is null", () => {
    expect(parseDayClose("02:00")).toBe(120);
    expect(parseDayClose("2:05")).toBe(125);
    expect(parseDayClose("24:00")).toBe(0);
    expect(parseDayClose("00:00")).toBe(0);
    for (const bad of ["", "25:00", "12:60", "noon", null, undefined, {}, ["a"]]) {expect(parseDayClose(bad)).toBeNull();}
  });
});

describe("which business date a run reports", () => {
  test("02:00 on the 18th reports the 17th; 23:30 on the 17th reports the 17th", () => {
    expect(tradingBusinessDate("2026-09-18", hm(2))).toBe("2026-09-17");
    expect(tradingBusinessDate("2026-09-17", hm(23, 30))).toBe("2026-09-17");
  });

  test("12:00 still reports yesterday; 12:01 reports today", () => {
    expect(tradingBusinessDate("2026-09-18", hm(12))).toBe("2026-09-17");
    expect(tradingBusinessDate("2026-09-18", hm(12, 1))).toBe("2026-09-18");
  });

  test("a midnight close is the previous calendar day — the calendar schedule's own answer", () => {
    expect(tradingBusinessDate("2026-03-01", hm(0))).toBe("2026-02-28");
  });
});

describe("the window of a business date is the 24 hours ending at the close", () => {
  test("a 02:00 close: [K 02:00, K+1 02:00)", () => {
    expect(tradingDayBounds({ from: "2026-09-17", to: "2026-09-17" }, 120))
      .toEqual({ fromKey: "2026-09-17", fromMin: 120, toKey: "2026-09-18", toMin: 120 });
  });

  test("a 23:30 close: [K-1 23:30, K 23:30)", () => {
    expect(tradingDayBounds({ from: "2026-09-17", to: "2026-09-17" }, -30))
      .toEqual({ fromKey: "2026-09-16", fromMin: 1410, toKey: "2026-09-17", toMin: 1410 });
  });

  test("a zero shift is exactly the calendar window", () => {
    expect(tradingDayBounds({ from: "2026-09-01", to: "2026-09-15" }, 0))
      .toEqual({ fromKey: "2026-09-01", fromMin: 0, toKey: "2026-09-16", toMin: 0 });
  });

  test("consecutive business dates TILE — each ends where the next begins, across a month and a year", () => {
    for (const shift of [120, 720, -1, -30, -719]) {
      let day = "2026-12-28";
      for (let i = 0; i < 7; i += 1) {
        const a = tradingDayBounds({ from: day, to: day }, shift);
        const next = addDaysToKey(day, 1);
        const b = tradingDayBounds({ from: next, to: next }, shift);
        expect({ key: a.toKey, min: a.toMin }).toEqual({ key: b.fromKey, min: b.fromMin });
        day = next;
      }
      // …and a seven-day window is the hull of the seven days.
      const week = tradingDayBounds({ from: "2026-12-28", to: "2027-01-03" }, shift);
      expect(week.fromKey).toBe(tradingDayBounds({ from: "2026-12-28", to: "2026-12-28" }, shift).fromKey);
      expect(week.toKey).toBe(tradingDayBounds({ from: "2027-01-03", to: "2027-01-03" }, shift).toKey);
    }
  });
});

describe("which business date an instant counts on", () => {
  const K = "2026-09-17";
  test("02:00 close: 01:59 is yesterday's, 02:00 and 02:01 are today's (half-open)", () => {
    expect(serviceDayKey(K, hm(1, 59), null, 120)).toBe("2026-09-16");
    expect(serviceDayKey(K, hm(2), null, 120)).toBe(K);
    expect(serviceDayKey(K, hm(2, 1), null, 120)).toBe(K);
    expect(serviceDayKey(K, 0, null, 120)).toBe("2026-09-16");
    expect(serviceDayKey(K, hm(23, 59), null, 120)).toBe(K);
  });

  test("23:30 close: 23:29 is today's, 23:30 is tomorrow's", () => {
    expect(serviceDayKey(K, hm(23, 29), null, -30)).toBe(K);
    expect(serviceDayKey(K, hm(23, 30), null, -30)).toBe("2026-09-18");
    expect(serviceDayKey(K, 0, null, -30)).toBe(K);
  });

  test("no shift, no slot: the calendar day — every all-day report unchanged", () => {
    for (let m = 0; m < 1440; m += 37) {expect(serviceDayKey(K, m, null)).toBe(K);}
    for (let m = 0; m < 1440; m += 37) {expect(serviceDayKey(K, m, null, 0)).toBe(K);}
  });

  test("the crossing-slot rule is untouched when no shift is asked", () => {
    const late: TimeSlot = { id: null, label: "Late", start: hm(22), end: hm(2), crosses_midnight: true, source: "custom" };
    expect(serviceDayKey(K, hm(1, 30), late)).toBe("2026-09-16");
    expect(serviceDayKey(K, hm(22, 30), late)).toBe(K);
  });

  test("an instant lands inside the window of the business date it is bucketed on — for every minute", () => {
    // The two halves of the contract (bounds and bucketing) are separate code;
    // this is the property that ties them together.
    for (const shift of [120, 270, 720, -30, -719]) {
      for (let minute = 0; minute < 1440; minute += 1) {
        const k = serviceDayKey(K, minute, null, shift);
        const b = tradingDayBounds({ from: k, to: k }, shift);
        const at = `${K}T${String(minute).padStart(4, "0")}`;
        const lo = `${b.fromKey}T${String(b.fromMin).padStart(4, "0")}`;
        const hi = `${b.toKey}T${String(b.toMin).padStart(4, "0")}`;
        expect(at >= lo && at < hi).toBe(true);
      }
    }
  });
});

describe("what a trading day says about itself", () => {
  test("the note names the close and which way the midnight bills go", () => {
    expect(tradingDayNote(hm(2))).toMatch(/closing at 02:00.*after midnight and before 02:00 count on the previous trading day.*printed bill keeps its calendar date/);
    expect(tradingDayNote(hm(23, 30))).toMatch(/closing at 23:30.*from 23:30 onwards count on the next trading day/);
    expect(tradingDayNote(0)).toBe("");
  });

  test("the file suffix only exists when there is a shift", () => {
    expect(tradingDayFileSuffix(hm(2))).toBe("_close-0200");
    expect(tradingDayFileSuffix(hm(23, 30))).toBe("_close-2330");
    expect(tradingDayFileSuffix(0)).toBe("");
    expect(tradingDayFileSuffix(null)).toBe("");
  });
});

describe("the catalogue of emailable reports", () => {
  test("eighteen keys: the fifteen MIS tabs in order, then sales, gst, pnl — no payroll, no balance sheet", () => {
    expect(REPORT_KEYS).toEqual([
      "item_wise", "discount", "void_kot", "bill_edit", "sales_summary", "order_summary",
      "executive_summary", "cover_size_summary", "settlement_summary", "nc_summary",
      "service_charge_deny", "group_summary", "variation_summary", "tip_summary", "counter_summary",
      "sales", "gst", "pnl",
    ]);
    expect(MIS_REPORT_KEYS).toHaveLength(15);
    expect(REPORT_KEYS).not.toContain("payroll");
    expect(REPORT_KEYS).not.toContain("balance_sheet");
  });

  test("only GST and P&L are calendar-only", () => {
    expect(CALENDAR_ONLY_KEYS).toEqual(["gst", "pnl"]);
    expect(REPORT_CATALOGUE.find((e) => e.key === "sales")?.windowModes).toContain("trading_day");
  });

  test("a selection comes back in catalogue order, de-duplicated", () => {
    expect(validateReportSelection(["pnl", "Sales_Summary", "item_wise", "item_wise"], "calendar"))
      .toEqual({ ok: true, keys: ["item_wise", "sales_summary", "pnl"] });
    expect(validateReportSelection("settlement_summary", "trading_day")).toEqual({ ok: true, keys: ["settlement_summary"] });
  });

  test("unknown, empty and GST/P&L-on-a-trading-day are refused in one sentence", () => {
    expect(validateReportSelection([], "calendar")).toEqual({ ok: false, error: "Pick at least one report to send." });
    expect(validateReportSelection(["payroll"], "calendar")).toMatchObject({ ok: false, error: expect.stringContaining("payroll") });
    const r = validateReportSelection(["sales_summary", "gst", "pnl"], "trading_day");
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.error).toMatch(/^GST and Profit & Loss can only be sent for calendar days/);
    expect(validateReportSelection(["sales", "sales_summary"], "trading_day").ok).toBe(true);
  });

  test("formats: Excel by default, CSV allowed, PDF refused until something renders it", () => {
    expect(validateReportFormats(undefined)).toEqual({ ok: true, formats: ["xlsx"] });
    expect(validateReportFormats(["csv", "XLSX", "csv"])).toEqual({ ok: true, formats: ["xlsx", "csv"] });
    expect(validateReportFormats(["pdf"])).toMatchObject({ ok: false, error: expect.stringMatching(/PDF/) });
    expect(validateReportFormats([])).toMatchObject({ ok: false });
    expect(validateReportFormats("docx")).toMatchObject({ ok: false });
  });

  test("the legacy report_key column: the one key, or 'bundle'; rows read report_keys first", () => {
    expect(legacyReportKey(["sales"])).toBe("sales");
    expect(legacyReportKey(["sales", "gst"])).toBe("bundle");
    expect(reportKeysOfRow({ report_keys: [], report_key: "gst" })).toEqual(["gst"]);
    expect(reportKeysOfRow({ report_keys: ["item_wise", "nope"], report_key: "bundle" })).toEqual(["item_wise"]);
    expect(reportKeysOfRow({ report_key: "bundle" })).toEqual([]);
  });

  test("a list reads as words", () => {
    expect(reportListPhrase(["sales_summary"])).toBe("Sales Summary");
    expect(reportListPhrase(["sales_summary", "settlement_summary"])).toBe("Sales Summary and Settlement Summary");
    expect(reportListPhrase(["item_wise", "discount", "void_kot", "bill_edit"])).toBe("Item Wise, Discount and 2 more");
    // Up to `max`, every title is named and the last joined with "and" — three
    // under max=3 once ran together as "Item WiseDiscountVoid KOT".
    expect(reportListPhrase(["item_wise", "discount", "void_kot"], 3)).toBe("Item Wise, Discount and Void KOT");
    expect(reportListPhrase(["item_wise", "discount"], 3)).toBe("Item Wise and Discount");
    expect(reportListPhrase(["item_wise"], 3)).toBe("Item Wise");
    expect(reportListPhrase([], 3)).toBe("");
    expect(reportListPhrase(["item_wise", "discount", "void_kot", "bill_edit"], 3)).toBe("Item Wise, Discount, Void KOT and 1 more");
    expect(reportListPhrase([...MIS_REPORT_KEYS])).toBe("All 15 MIS reports");
    expect(reportListPhrase([...REPORT_KEYS])).toBe("All reports");
  });
});
