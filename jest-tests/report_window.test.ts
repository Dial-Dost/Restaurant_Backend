// THE DATE-WINDOW CONTRACT, asserted.
//
// report_window.ts decides what "1-15 August" and what "the last 7 days" mean
// for every reporting endpoint in the product — accounting and analytics alike.
// It is pure and takes its clock as an argument, so all of that is provable here
// without a database, a live clock, or a server whose timezone matters.
//
// The two assertions worth stating up front, because they are the ones an owner
// would notice and no aggregate would flag:
//
//   1. BOTH ENDS ARE INCLUSIVE. 1-15 August is fifteen days and includes the
//      15th's trade. An exclusive end silently drops the last day of every range
//      an owner ever picks, which reads as "the numbers are short" and looks
//      exactly like missing sales.
//   2. THE DAYS ARE THE RESTAURANT'S. "1 August" means 1 August where the
//      restaurant is. The two-zone test below gives two tenants the SAME instant
//      and requires them to disagree about which day it is — the same technique
//      posters.test.ts uses, for the same reason.

import { describe, test, expect } from "@jest/globals";
import {
  DEFAULT_REPORT_DAYS,
  MAX_REPORT_DAYS,
  addDaysToKey,
  countDays,
  dateKeyInZone,
  isDateKey,
  resolveReportWindow,
} from "../report_window";

const IST = "Asia/Kolkata";
// UTC+14 and UTC-11 — 25 hours apart, so there is always an instant they place
// on different calendar days. Neither observes DST, so the gap never moves.
const AHEAD = "Pacific/Kiritimati";
const BEHIND = "Pacific/Midway";

// A fixed clock. Every default-window assertion below is relative to it, so the
// suite cannot start failing merely because the calendar rolled over.
const NOW = new Date("2026-08-27T10:00:00.000Z");

const win = (q: Record<string, unknown>, tz = IST, limits: Record<string, unknown> = {}) =>
  resolveReportWindow(q, tz, { defaultDays: DEFAULT_REPORT_DAYS, now: NOW, ...limits } as never);

describe("day-key arithmetic", () => {
  test("countDays is INCLUSIVE of both ends", () => {
    expect(countDays("2026-08-01", "2026-08-15")).toBe(15);
    expect(countDays("2026-08-01", "2026-08-01")).toBe(1);
    // A month boundary is not a special case — the keys are UTC-anchored.
    expect(countDays("2026-07-31", "2026-08-01")).toBe(2);
  });

  test("countDays is unmoved by a DST transition inside the range", () => {
    // 29 March 2026 is the European spring-forward. The keys name days, and a
    // day is a day however long its wall clock ran.
    expect(countDays("2026-03-28", "2026-03-30")).toBe(3);
  });

  test("addDaysToKey crosses months, years and leap days", () => {
    expect(addDaysToKey("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDaysToKey("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDaysToKey("2024-02-28", 1)).toBe("2024-02-29");
  });

  test("isDateKey accepts only YYYY-MM-DD", () => {
    expect(isDateKey("2026-08-01")).toBe(true);
    expect(isDateKey("2026-8-1")).toBe(false);
    expect(isDateKey("2026-08-01T00:00:00Z")).toBe(false);
    expect(isDateKey(20260801)).toBe(false);
  });
});

describe("an explicit range", () => {
  test("1-15 August is fifteen days, both ends included", () => {
    const w = win({ from: "2026-08-01", to: "2026-08-15" });
    expect(w).toMatchObject({ from: "2026-08-01", to: "2026-08-15", days: 15, source: "range", clamped: [] });
  });

  test("a single day is honoured as one day, whatever the endpoint's floor", () => {
    // minDays exists so a rolling KPI window is not read over three days of
    // noise. It must NOT widen a day the owner clicked on: that would answer a
    // question nobody asked, with numbers they could not reconcile.
    const w = win({ from: "2026-08-10", to: "2026-08-10" }, IST, { minDays: 7 });
    expect(w).toMatchObject({ from: "2026-08-10", to: "2026-08-10", days: 1, clamped: [] });
  });

  test("from alone reads as 'since then'", () => {
    expect(win({ from: "2026-08-20" })).toMatchObject({ from: "2026-08-20", to: "2026-08-27", days: 8 });
  });

  test("to alone anchors the rolling span somewhere other than today", () => {
    expect(win({ to: "2026-08-15", days: "7" })).toMatchObject({ from: "2026-08-09", to: "2026-08-15", days: 7 });
  });

  test("an ISO instant is converted THROUGH the tenant zone, never sliced", () => {
    // 20:00 UTC on 1 August is already the 2nd in Kolkata. Slicing the string
    // would name the 1st and quietly shift the whole report by a day.
    expect(win({ from: "2026-08-01T20:00:00Z", to: "2026-08-15" }).from).toBe("2026-08-02");
    expect(win({ from: "2026-08-01T20:00:00Z", to: "2026-08-15" }, BEHIND).from).toBe("2026-08-01");
  });
});

describe("the days shorthand still means what it always meant", () => {
  test("the last N calendar days ENDING TODAY", () => {
    // The formula every reader used before this contract existed was
    // addDaysToKey(todayKey, -(days - 1)) .. todayKey. Same window, same money.
    const w = win({ days: "30" });
    expect(w).toMatchObject({ from: "2026-07-29", to: "2026-08-27", days: 30, source: "days" });
    expect(w.from).toBe(addDaysToKey(dateKeyInZone(NOW, IST), -29));
  });

  test("a numeric days is accepted as well as a query string", () => {
    expect(win({ days: 7 })).toMatchObject({ from: "2026-08-21", to: "2026-08-27", days: 7 });
  });

  test("nothing at all is the endpoint's default span", () => {
    expect(win({}, IST, { defaultDays: 14 })).toMatchObject({ days: 14, source: "days" });
  });

  test("days is clamped to the endpoint's own floor and cap, and says so", () => {
    expect(win({ days: "1" }, IST, { minDays: 7 })).toMatchObject({ days: 7, clamped: ["days_clamped"] });
    expect(win({ days: "9999" }, IST, { maxDays: 365 })).toMatchObject({ days: 365, clamped: ["days_clamped"] });
  });

  test("from/to WIN over days when both are sent", () => {
    const w = win({ from: "2026-08-01", to: "2026-08-15", days: "90" });
    expect(w).toMatchObject({ from: "2026-08-01", to: "2026-08-15", days: 15, source: "range" });
  });
});

describe("the clamps are rules, not accidents", () => {
  test("a reversed range is swapped, not emptied", () => {
    // Dragging a calendar right-to-left means the same fortnight. Returning an
    // empty report instead would look like a fortnight with no trade in it.
    const w = win({ from: "2026-08-15", to: "2026-08-01" });
    expect(w).toMatchObject({ from: "2026-08-01", to: "2026-08-15", days: 15, clamped: ["reversed"] });
  });

  test("a future end is pulled back to today", () => {
    const w = win({ from: "2026-08-01", to: "2026-12-31" });
    expect(w).toMatchObject({ from: "2026-08-01", to: "2026-08-27", clamped: ["future_to"] });
  });

  test("a wholly future range collapses onto today rather than reporting zeros", () => {
    const w = win({ from: "2027-01-01", to: "2027-01-31" });
    expect(w).toMatchObject({ from: "2026-08-27", to: "2026-08-27", days: 1 });
    expect(w.clamped).toEqual(expect.arrayContaining(["future_to", "future_from"]));
  });

  test("an absurd span is capped at the RECENT end", () => {
    // The owner is looking at the recent end, so `to` is kept and `from` slides
    // forward. Uncapped, this is a full scan of "Bills" wearing a date filter.
    const w = win({ from: "2015-01-01", to: "2026-08-15" }, IST, { maxDays: MAX_REPORT_DAYS });
    expect(w.to).toBe("2026-08-15");
    expect(w.days).toBe(MAX_REPORT_DAYS);
    expect(countDays(w.from, w.to)).toBe(MAX_REPORT_DAYS);
    expect(w.clamped).toContain("span_capped");
  });

  test("unreadable dates are ignored and reported, never guessed at", () => {
    const w = win({ from: "not-a-date", to: "2026-08-15", days: "7" });
    expect(w).toMatchObject({ from: "2026-08-09", to: "2026-08-15", clamped: ["from_unparseable"] });
    expect(win({ days: "many" })).toMatchObject({ days: DEFAULT_REPORT_DAYS, clamped: ["days_unparseable"] });
  });

  test("the resolved window is ALWAYS an ordered, non-empty pair", () => {
    const nasty: Record<string, unknown>[] = [
      { from: "2027-05-05", to: "2019-01-01" },
      { from: "", to: "" },
      { days: "-40" },
      { days: "0" },
      { from: ["2026-08-01", "2026-08-09"], to: "2026-08-15" },
      { to: "2026-08-15", days: "1e9" },
    ];
    for (const q of nasty) {
      const w = win(q);
      expect(isDateKey(w.from)).toBe(true);
      expect(isDateKey(w.to)).toBe(true);
      expect(w.from <= w.to).toBe(true);
      expect(w.days).toBeGreaterThanOrEqual(1);
      expect(w.days).toBeLessThanOrEqual(MAX_REPORT_DAYS);
      expect(countDays(w.from, w.to)).toBe(w.days);
    }
  });
});

describe("the days belong to the restaurant, not to the server", () => {
  test("one instant, two tenants, two different 'today's", () => {
    // 2026-08-27T10:00Z is the 28th in Kiritimati (+14) and still the 26th in
    // Midway (-11). A tenant asking for "the last 7 days" must be given ITS
    // seven days: bucketing by the server's clock would post a whole evening's
    // covers to the wrong day for one of them.
    expect(dateKeyInZone(NOW, AHEAD)).toBe("2026-08-28");
    expect(dateKeyInZone(NOW, BEHIND)).toBe("2026-08-26");

    expect(win({ days: "7" }, AHEAD)).toMatchObject({ from: "2026-08-22", to: "2026-08-28" });
    expect(win({ days: "7" }, BEHIND)).toMatchObject({ from: "2026-08-20", to: "2026-08-26" });
  });

  test("'today' is the tenant's today when it clamps a future date", () => {
    // The same requested end date is in the future for one tenant and already
    // past for the other, so only one of them is clamped.
    expect(win({ from: "2026-08-01", to: "2026-08-27" }, AHEAD).clamped).toEqual([]);
    expect(win({ from: "2026-08-01", to: "2026-08-27" }, BEHIND)).toMatchObject({
      to: "2026-08-26",
      clamped: ["future_to"],
    });
  });

  test("a zone with a fractional offset is not rounded to a whole hour", () => {
    // Kathmandu is UTC+5:45. 18:30Z is 00:15 the NEXT day there and 00:00 in
    // Kolkata (+5:30) — fifteen minutes apart, one day different from UTC.
    const at = new Date("2026-08-27T18:30:00.000Z");
    expect(dateKeyInZone(at, "Asia/Kathmandu")).toBe("2026-08-28");
    expect(dateKeyInZone(at, IST)).toBe("2026-08-28");
    expect(dateKeyInZone(at, "UTC")).toBe("2026-08-27");
  });
});
