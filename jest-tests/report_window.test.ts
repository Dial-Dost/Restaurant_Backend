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
  DEFAULT_TIME_SLOTS,
  MAX_REPORT_DAYS,
  OUTSIDE_SESSIONS_LABEL,
  addDaysToKey,
  countDays,
  dateKeyInZone,
  fixedTimeBuckets,
  formatClock,
  hourOfDayLabel,
  isDateKey,
  parseClockMinutes,
  parseStoredTimeSlots,
  resolveReportWindow,
  resolveTimeSlot,
  serviceDayKey,
  sessionBucketLabel,
  sessionOf,
  slotBounds,
  slotContains,
  slotDayBounds,
  timeBucketKey,
  timeBucketMode,
  timeBucketOrder,
  timeSlotFileSuffix,
  timeSlotMeta,
  timeSlotNeedsPresets,
  timeSlotNote,
  timeSlotPresetWire,
  timeSlotsForStorage,
  validateTimeSlotPresets,
  type TimeSlot,
  type TimeSlotPreset,
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

// =============================================================================
// TIME SLOTS — a part of each day, laid over the days above
// =============================================================================
//
// The three assertions an owner would notice and no aggregate would flag:
//
//   1. HALF-OPEN. A bill at exactly 17:00 is not Lunch (12:00-17:00). A closed
//      end counts it twice the moment Dinner starts at 17:00.
//   2. A SLOT THAT CROSSES MIDNIGHT BELONGS TO THE DAY IT STARTS ON. 01:30 on
//      the 16th under 22:00-02:00 is the 15th's late night.
//   3. ALL DAY IS NO SLOT. Absent, "all" and 00:00-24:00 all resolve to null, so
//      every report shipped before slots existed is unchanged.

const LUNCH = DEFAULT_TIME_SLOTS[0];
const DINNER = DEFAULT_TIME_SLOTS[1];
const PRESETS: TimeSlotPreset[] = [...DEFAULT_TIME_SLOTS];

/** Resolve a query that must produce a slot, and return it. */
function slotFor(q: Record<string, unknown>, presets: readonly TimeSlotPreset[] = PRESETS): TimeSlot {
  const { slot, clamped } = resolveTimeSlot(q, presets);
  expect(clamped).toEqual([]);
  if (!slot) {throw new Error(`expected a slot for ${JSON.stringify(q)}`);}
  return slot;
}

/** Local calendar day and minute of an instant in `tz` — what the readers compute. */
function wallOf(iso: string, tz: string): { day: string; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string): number => Number(parts.find((x) => x.type === t)?.value ?? 0);
  return { day: dateKeyInZone(iso, tz), minute: (get("hour") % 24) * 60 + get("minute") };
}

describe("time slots: reading a clock", () => {
  test("HH:mm is minutes past midnight; 24:00 only as an end", () => {
    expect(parseClockMinutes("00:00")).toBe(0);
    expect(parseClockMinutes("12:00")).toBe(720);
    expect(parseClockMinutes("23:59")).toBe(1439);
    expect(parseClockMinutes("9:30")).toBe(570);
    expect(parseClockMinutes("24:00")).toBeNull();
    expect(parseClockMinutes("24:00", { allow24: true })).toBe(1440);
    for (const bad of ["24:01", "25:00", "12:60", "noon", "12", "12:5", "", null, undefined, {}, "12:00:00"]) {
      expect(parseClockMinutes(bad, { allow24: true })).toBeNull();
    }
  });

  test("formatClock writes HH:mm back, and 1440 as 24:00", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(570)).toBe("09:30");
    expect(formatClock(1440)).toBe("24:00");
  });
});

describe("time slots: resolving a request", () => {
  test("no slot, slot=all and 00:00-24:00 are ALL DAY, with nothing clamped", () => {
    for (const q of [{}, { slot: "" }, { slot: "all" }, { slot: "ALL" }, { time_from: "00:00", time_to: "24:00" }, { time_from: "00:00", time_to: "00:00" }]) {
      expect(resolveTimeSlot(q, PRESETS)).toEqual({ slot: null, clamped: [] });
    }
  });

  test("a preset id resolves to its minutes, labelled and sourced", () => {
    expect(slotFor({ slot: "lunch" })).toEqual({
      id: "lunch", label: "Lunch", start: 720, end: 1020, crosses_midnight: false, source: "preset",
    });
    // Dinner 18:00-24:00 ends AT midnight. It does not cross it.
    expect(slotFor({ slot: "Dinner" })).toMatchObject({ id: "dinner", start: 1080, end: 1440, crosses_midnight: false });
  });

  test("custom times WIN over a preset, the way from/to win over days", () => {
    expect(slotFor({ slot: "lunch", time_from: "13:00", time_to: "14:30" })).toEqual({
      id: null, label: "Custom", start: 780, end: 870, crosses_midnight: false, source: "custom",
    });
  });

  test("either custom end alone is enough: from 00:00, until 24:00", () => {
    expect(slotFor({ time_from: "18:00" })).toMatchObject({ start: 1080, end: 1440 });
    expect(slotFor({ time_to: "11:00" })).toMatchObject({ start: 0, end: 660 });
  });

  test("an end of 00:00 is midnight at the END of the day, not an empty slot", () => {
    expect(slotFor({ time_from: "22:00", time_to: "00:00" })).toMatchObject({ start: 1320, end: 1440, crosses_midnight: false });
  });

  test("a slot running past midnight says so", () => {
    expect(slotFor({ time_from: "22:00", time_to: "02:00" })).toMatchObject({ start: 1320, end: 120, crosses_midnight: true });
  });

  test("a request that cannot be honoured is ALL DAY, and names why", () => {
    expect(resolveTimeSlot({ slot: "brunch" }, PRESETS)).toEqual({ slot: null, clamped: ["slot_unknown"] });
    expect(resolveTimeSlot({ time_from: "25:00", time_to: "26:00" }, PRESETS)).toEqual({ slot: null, clamped: ["time_unparseable"] });
    expect(resolveTimeSlot({ slot: "lunch", time_from: "noon" }, PRESETS)).toEqual({ slot: null, clamped: ["time_unparseable"] });
    expect(resolveTimeSlot({ time_from: "12:00", time_to: "12:00" }, PRESETS)).toEqual({ slot: null, clamped: ["time_empty"] });
    // A preset id against a restaurant that has no such preset.
    expect(resolveTimeSlot({ slot: "lunch" }, [])).toEqual({ slot: null, clamped: ["slot_unknown"] });
  });

  test("Express arrays take their first value, like the dates", () => {
    expect(slotFor({ slot: ["dinner", "lunch"] })).toMatchObject({ id: "dinner" });
  });

  test("only a preset id needs the presets read", () => {
    expect(timeSlotNeedsPresets({ slot: "lunch" })).toBe(true);
    expect(timeSlotNeedsPresets({})).toBe(false);
    expect(timeSlotNeedsPresets({ slot: "all" })).toBe(false);
    expect(timeSlotNeedsPresets({ slot: "lunch", time_from: "12:00", time_to: "13:00" })).toBe(false);
  });
});

describe("time slots: which instants, which day", () => {
  test("the half-open minute: 17:00 is not Lunch, 16:59 is, 12:00 is", () => {
    const lunch = slotFor({ slot: "lunch" });
    expect(slotContains(lunch, 720)).toBe(true);
    expect(slotContains(lunch, 1019)).toBe(true);
    expect(slotContains(lunch, 1020)).toBe(false);
    expect(slotContains(lunch, 719)).toBe(false);
    const dinner = slotFor({ slot: "dinner" });
    expect(slotContains(dinner, 1439)).toBe(true);
    expect(slotContains(dinner, 30)).toBe(false);
  });

  test("a crossing slot holds both sides of midnight", () => {
    const late = slotFor({ time_from: "22:00", time_to: "02:00" });
    expect(slotContains(late, 1380)).toBe(true);
    expect(slotContains(late, 90)).toBe(true);
    expect(slotContains(late, 120)).toBe(false);
    expect(slotContains(late, 1319)).toBe(false);
  });

  test("outer bounds: Lunch ends on the LAST day; Dinner and a crossing slot end the day after", () => {
    const w = { from: "2026-08-01", to: "2026-08-15" };
    expect(slotBounds(w, slotFor({ slot: "lunch" }))).toEqual({ fromKey: "2026-08-01", fromMin: 720, toKey: "2026-08-15", toMin: 1020 });
    expect(slotBounds(w, slotFor({ slot: "dinner" }))).toEqual({ fromKey: "2026-08-01", fromMin: 1080, toKey: "2026-08-16", toMin: 0 });
    expect(slotBounds(w, slotFor({ time_from: "22:00", time_to: "02:00" }))).toEqual({ fromKey: "2026-08-01", fromMin: 1320, toKey: "2026-08-16", toMin: 120 });
  });

  // The hull is exact for an instant and wrong for a SPAN: a cash session from
  // 18:00 to 23:30 on the 1st lies inside Lunch's hull over 1-3 August without
  // ever meeting Lunch. The per-day intervals are what a span is tested against.
  test("per-day bounds: one interval per day, each the slot on that day alone", () => {
    const w = { from: "2026-08-01", to: "2026-08-03" };
    expect(slotDayBounds(w, slotFor({ slot: "lunch" }))).toEqual([
      { fromKey: "2026-08-01", fromMin: 720, toKey: "2026-08-01", toMin: 1020 },
      { fromKey: "2026-08-02", fromMin: 720, toKey: "2026-08-02", toMin: 1020 },
      { fromKey: "2026-08-03", fromMin: 720, toKey: "2026-08-03", toMin: 1020 },
    ]);
    // Dinner runs to 24:00, the start of the NEXT day; it does not cross midnight.
    expect(slotDayBounds(w, slotFor({ slot: "dinner" }))).toEqual([
      { fromKey: "2026-08-01", fromMin: 1080, toKey: "2026-08-02", toMin: 0 },
      { fromKey: "2026-08-02", fromMin: 1080, toKey: "2026-08-03", toMin: 0 },
      { fromKey: "2026-08-03", fromMin: 1080, toKey: "2026-08-04", toMin: 0 },
    ]);
    // A crossing slot's night belongs to the day it STARTED, month boundary included.
    expect(slotDayBounds({ from: "2026-07-31", to: "2026-08-01" }, slotFor({ time_from: "22:00", time_to: "02:00" }))).toEqual([
      { fromKey: "2026-07-31", fromMin: 1320, toKey: "2026-08-01", toMin: 120 },
      { fromKey: "2026-08-01", fromMin: 1320, toKey: "2026-08-02", toMin: 120 },
    ]);
  });

  test("per-day bounds: a dinner-only span meets Dinner's days and none of Lunch's, though Lunch's hull holds it", () => {
    const w = { from: "2026-08-01", to: "2026-08-03" };
    // Minutes from 1 Aug 00:00, so the three days can be compared on one line.
    const at = (key: string, minute: number): number => (countDays(w.from, key) - 1) * 1440 + minute;
    const meets = (bounds: ReturnType<typeof slotDayBounds>, open: number, close: number): boolean =>
      bounds.some((b) => open < at(b.toKey, b.toMin) && close >= at(b.fromKey, b.fromMin));
    const hullMeets = (slot: TimeSlot, open: number, close: number): boolean => {
      const h = slotBounds(w, slot);
      return open < at(h.toKey, h.toMin) && close >= at(h.fromKey, h.fromMin);
    };
    const lunch = slotFor({ slot: "lunch" }), dinner = slotFor({ slot: "dinner" });
    const dinnerShift = [at("2026-08-01", 1080), at("2026-08-01", 1410)] as const;
    expect(hullMeets(lunch, ...dinnerShift)).toBe(true);
    expect(meets(slotDayBounds(w, lunch), ...dinnerShift)).toBe(false);
    expect(meets(slotDayBounds(w, dinner), ...dinnerShift)).toBe(true);
    // An all-day shift on the 2nd meets both.
    const allDay = [at("2026-08-02", 660), at("2026-08-02", 1380)] as const;
    expect(meets(slotDayBounds(w, lunch), ...allDay)).toBe(true);
    expect(meets(slotDayBounds(w, dinner), ...allDay)).toBe(true);
  });

  test("per-day bounds share the hull's ends exactly, and one day is the hull", () => {
    const w = { from: "2026-07-30", to: "2026-08-02" };
    for (const q of [{ slot: "lunch" }, { slot: "dinner" }, { time_from: "22:00", time_to: "02:00" }, { time_from: "00:00", time_to: "12:00" }]) {
      const slot = slotFor(q);
      const days = slotDayBounds(w, slot);
      const hull = slotBounds(w, slot);
      expect(days).toHaveLength(4);
      expect({ fromKey: days[0]?.fromKey, fromMin: days[0]?.fromMin }).toEqual({ fromKey: hull.fromKey, fromMin: hull.fromMin });
      expect({ toKey: days[3]?.toKey, toMin: days[3]?.toMin }).toEqual({ toKey: hull.toKey, toMin: hull.toMin });
      expect(slotDayBounds({ from: "2026-08-02", to: "2026-08-02" }, slot)).toEqual([slotBounds({ from: "2026-08-02", to: "2026-08-02" }, slot)]);
    }
  });

  test("per-day bounds: a reversed or unreadable window has no days, and a window no report can have is refused", () => {
    const lunch = slotFor({ slot: "lunch" });
    expect(slotDayBounds({ from: "2026-08-03", to: "2026-08-01" }, lunch)).toEqual([]);
    expect(slotDayBounds({ from: "garbage", to: "2026-08-01" }, lunch)).toEqual([]);
    const widest = { from: addDaysToKey("2026-08-01", -(MAX_REPORT_DAYS - 1)), to: "2026-08-01" };
    expect(slotDayBounds(widest, lunch)).toHaveLength(MAX_REPORT_DAYS);
    expect(() => slotDayBounds({ from: addDaysToKey(widest.from, -1), to: "2026-08-01" }, lunch)).toThrow(RangeError);
  });

  test("a crossing slot's after-midnight hours belong to the day it STARTED", () => {
    const late = slotFor({ time_from: "22:00", time_to: "02:00" });
    expect(serviceDayKey("2026-08-16", 90, late)).toBe("2026-08-15");
    expect(serviceDayKey("2026-08-15", 1380, late)).toBe("2026-08-15");
    // A month boundary is not a special case.
    expect(serviceDayKey("2026-09-01", 30, late)).toBe("2026-08-31");
    // No slot, or one that stays inside the day, is the calendar day.
    expect(serviceDayKey("2026-08-16", 90, null)).toBe("2026-08-16");
    expect(serviceDayKey("2026-08-16", 90, slotFor({ slot: "dinner" }))).toBe("2026-08-16");
  });

  test("in Kolkata (+5:30): 20:00Z on the 15th is 01:30 on the 16th, and it is the 15th's late night", () => {
    // The fractional offset is the whole trap: rounding it to +5 or +6 moves
    // this instant across the 02:00 edge one way or the other.
    const late = slotFor({ time_from: "22:00", time_to: "02:00" });
    const at = wallOf("2026-08-15T20:00:00.000Z", IST);
    expect(at).toEqual({ day: "2026-08-16", minute: 90 });
    expect(slotContains(late, at.minute)).toBe(true);
    expect(serviceDayKey(at.day, at.minute, late)).toBe("2026-08-15");
    // 20:31Z is 02:01 IST — outside the slot.
    expect(slotContains(late, wallOf("2026-08-15T20:31:00.000Z", IST).minute)).toBe(false);
    // Kathmandu (+5:45) reads the same instant fifteen minutes later.
    expect(wallOf("2026-08-15T20:00:00.000Z", "Asia/Kathmandu").minute).toBe(105);
  });
});

describe("time slots: the time-wise cut", () => {
  const at = (day: string, minute: number) => ({ serviceDay: day, calendarDay: day, minute });

  test("?bucket reads the four modes and nothing else", () => {
    expect(timeBucketMode("hour_of_day")).toBe("hour_of_day");
    expect(timeBucketMode("SESSION")).toBe("session");
    expect(timeBucketMode("hour")).toBe("hour");
    expect(timeBucketMode("week")).toBe("day");
    expect(timeBucketMode(undefined)).toBe("day");
  });

  test("day and date x hour keys are exactly what they always were", () => {
    expect(timeBucketKey("day", at("2026-08-02", 810), PRESETS)).toBe("2026-08-02");
    expect(timeBucketKey("hour", at("2026-08-02", 810), PRESETS)).toBe("2026-08-02T13");
  });

  test("the DAY cut uses the service day; the DATE x HOUR cut keeps the calendar hour", () => {
    const moment = { serviceDay: "2026-08-15", calendarDay: "2026-08-16", minute: 90 };
    expect(timeBucketKey("day", moment, PRESETS)).toBe("2026-08-15");
    expect(timeBucketKey("hour", moment, PRESETS)).toBe("2026-08-16T01");
  });

  test("hour of day: 'HH:00-HH:00', the last hour ends at 24:00", () => {
    expect(timeBucketKey("hour_of_day", at("2026-08-02", 810), PRESETS)).toBe("13:00-14:00");
    expect(hourOfDayLabel(0)).toBe("00:00-01:00");
    expect(hourOfDayLabel(23)).toBe("23:00-24:00");
  });

  test("session: the preset holding the minute, or Outside sessions — edges half-open", () => {
    expect(timeBucketKey("session", at("2026-08-02", 720), PRESETS)).toBe("Lunch (12:00-17:00)");
    expect(timeBucketKey("session", at("2026-08-02", 1020), PRESETS)).toBe(OUTSIDE_SESSIONS_LABEL);
    expect(timeBucketKey("session", at("2026-08-02", 1080), PRESETS)).toBe("Dinner (18:00-24:00)");
    expect(timeBucketKey("session", at("2026-08-02", 30), PRESETS)).toBe(OUTSIDE_SESSIONS_LABEL);
    expect(sessionOf(PRESETS, 1439)?.id).toBe("dinner");
    expect(sessionBucketLabel(LUNCH)).toBe("Lunch (12:00-17:00)");
  });

  test("session rows follow the PRESET order, Outside last, whatever the labels spell", () => {
    // "Zebra" sorts after "Outside" as text; it is the owner's first session.
    const presets: TimeSlotPreset[] = [
      { id: "zebra", label: "Zebra", start: "07:00", end: "11:00" },
      { id: "aardvark", label: "Aardvark", start: "19:00", end: "23:00" },
    ];
    const keys = [OUTSIDE_SESSIONS_LABEL, "Aardvark (19:00-23:00)", "Zebra (07:00-11:00)"];
    expect([...keys].sort(timeBucketOrder("session", presets))).toEqual(["Zebra (07:00-11:00)", "Aardvark (19:00-23:00)", OUTSIDE_SESSIONS_LABEL]);
    expect(fixedTimeBuckets("session", presets)).toEqual(["Zebra (07:00-11:00)", "Aardvark (19:00-23:00)"]);
    expect(fixedTimeBuckets("hour_of_day", presets)).toEqual([]);
    expect(["13:00-14:00", "09:00-10:00", "23:00-24:00"].sort(timeBucketOrder("hour_of_day", presets)))
      .toEqual(["09:00-10:00", "13:00-14:00", "23:00-24:00"]);
  });
});

describe("time slots: saving presets", () => {
  const ok = (raw: unknown): TimeSlotPreset[] => {
    const v = validateTimeSlotPresets(raw);
    if (!v.ok) {throw new Error(v.error);}
    return v.slots;
  };
  const refusal = (raw: unknown): string => {
    const v = validateTimeSlotPresets(raw);
    if (v.ok) {throw new Error("expected a refusal");}
    return v.error;
  };

  test("the defaults are the client's two sessions, and they validate", () => {
    expect(DEFAULT_TIME_SLOTS).toEqual([
      { id: "lunch", label: "Lunch", start: "12:00", end: "17:00" },
      { id: "dinner", label: "Dinner", start: "18:00", end: "24:00" },
    ]);
    expect(ok(DEFAULT_TIME_SLOTS)).toEqual(DEFAULT_TIME_SLOTS);
  });

  test("ids are derived from labels, kept unique, and never 'all'", () => {
    expect(ok([
      { label: "Late Night", start: "22:00", end: "02:00" },
      { label: "late night!", start: "06:00", end: "08:00" },
      { label: "All", start: "12:00", end: "13:00" },
      { label: "॥", start: "14:00", end: "15:00" },
    ]).map((s) => s.id)).toEqual(["late-night", "late-night-2", "all-2", "slot-4"]);
  });

  test("times are normalised to HH:mm, and an end of 00:00 is stored as 24:00", () => {
    expect(ok([{ id: "Brunch", label: "  Brunch \t ", start: "9:00", end: "00:00" }]))
      .toEqual([{ id: "brunch", label: "Brunch", start: "09:00", end: "24:00" }]);
  });

  test("an empty list is valid — the route reads it as 'back to the defaults'", () => {
    expect(ok([])).toEqual([]);
    expect(timeSlotsForStorage([])).toBeNull();
  });

  test("each refusal is one plain sentence naming the slot", () => {
    expect(refusal({ slots: [] })).toBe("Send the time slots as a list.");
    expect(refusal(Array.from({ length: 9 }, (_, i) => ({ label: `S${String(i)}`, start: `${String(i).padStart(2, "0")}:00`, end: `${String(i).padStart(2, "0")}:30` }))))
      .toBe("You can save at most 8 time slots.");
    expect(refusal([{ label: "", start: "12:00", end: "13:00" }])).toBe("Every time slot needs a name of 1 to 24 characters.");
    expect(refusal([{ label: "x".repeat(25), start: "12:00", end: "13:00" }])).toBe("Every time slot needs a name of 1 to 24 characters.");
    expect(refusal([{ label: "Lunch", start: "24:00", end: "13:00" }])).toBe('"Lunch" needs a start time between 00:00 and 23:59, written as HH:mm.');
    expect(refusal([{ label: "Lunch", start: "12:00", end: "noon" }])).toBe('"Lunch" needs an end time between 00:01 and 24:00, written as HH:mm.');
    expect(refusal([{ label: "Lunch", start: "12:00", end: "12:00" }])).toBe('"Lunch" starts and ends at the same time.');
    expect(refusal([{ id: "Lunch Time", label: "Lunch", start: "12:00", end: "13:00" }])).toBe('"Lunch" has an id that is not 1 to 32 lowercase letters, digits, - or _.');
    expect(refusal([{ id: "all", label: "Everything", start: "12:00", end: "13:00" }])).toBe('"Everything" cannot use the id "all", which already means the whole day.');
    expect(refusal([
      { id: "a", label: "One", start: "12:00", end: "13:00" },
      { id: "a", label: "Two", start: "14:00", end: "15:00" },
    ])).toBe('Two time slots use the id "a".');
  });

  test("OVERLAP is refused, on the 24-hour circle — including across midnight", () => {
    expect(refusal([
      { label: "Lunch", start: "12:00", end: "17:00" },
      { label: "Brunch", start: "11:00", end: "12:30" },
    ])).toBe('"Lunch" (12:00-17:00) overlaps "Brunch" (11:00-12:30); a time of day can belong to only one time slot.');
    expect(refusal([
      { label: "Dinner", start: "18:00", end: "02:00" },
      { label: "Breakfast", start: "01:00", end: "10:00" },
    ])).toBe('"Dinner" (18:00-02:00) overlaps "Breakfast" (01:00-10:00); a time of day can belong to only one time slot.');
    expect(refusal([
      { label: "All day", start: "00:00", end: "24:00" },
      { label: "Lunch", start: "12:00", end: "13:00" },
    ])).toContain("overlaps");
    // Touching is not overlapping: [12, 17) and [17, 18) share no minute.
    expect(ok([
      { label: "Lunch", start: "12:00", end: "17:00" },
      { label: "Tea", start: "17:00", end: "18:00" },
      { label: "Late", start: "22:00", end: "12:00" },
    ])).toHaveLength(3);
  });

  test("stored values are read defensively: NULL, junk or an invalid list is the defaults (null)", () => {
    const saved = timeSlotsForStorage([{ id: "late", label: "Late", start: "22:00", end: "02:00" }]);
    expect(saved).toEqual({ version: 1, slots: [{ id: "late", label: "Late", start: "22:00", end: "02:00" }] });
    expect(parseStoredTimeSlots(saved)).toEqual(saved?.slots);
    expect(parseStoredTimeSlots(JSON.stringify(saved))).toEqual(saved?.slots);
    expect(parseStoredTimeSlots([{ label: "Lunch", start: "12:00", end: "17:00" }])).toEqual([{ id: "lunch", label: "Lunch", start: "12:00", end: "17:00" }]);
    for (const junk of [null, undefined, "", "{not json", 42, { slots: [] }, { slots: [{ label: "A", start: "12:00", end: "12:00" }] }]) {
      expect(parseStoredTimeSlots(junk)).toBeNull();
    }
  });
});

describe("time slots: what travels with a report", () => {
  test("meta.time_slot is null for all day, and HH:mm strings otherwise", () => {
    expect(timeSlotMeta(null)).toBeNull();
    expect(timeSlotMeta(slotFor({ slot: "dinner" }))).toEqual({
      id: "dinner", label: "Dinner", start: "18:00", end: "24:00", crosses_midnight: false, source: "preset",
    });
    expect(timeSlotPresetWire({ id: "late", label: "Late", start: "22:00", end: "02:00" })).toEqual({
      id: "late", label: "Late", start: "22:00", end: "02:00", crosses_midnight: true,
    });
    expect(timeSlotPresetWire(DINNER).crosses_midnight).toBe(false);
  });

  test("the filename suffix appears ONLY when a slot is set", () => {
    expect(timeSlotFileSuffix(null)).toBe("");
    expect(timeSlotFileSuffix(undefined)).toBe("");
    expect(timeSlotFileSuffix(timeSlotMeta(slotFor({ slot: "lunch" })))).toBe("_lunch-1200-1700");
    expect(timeSlotFileSuffix(timeSlotMeta(slotFor({ slot: "dinner" })))).toBe("_dinner-1800-2400");
    expect(timeSlotFileSuffix(timeSlotMeta(slotFor({ time_from: "22:00", time_to: "02:00" })))).toBe("_custom-2200-0200");
    expect(timeSlotFileSuffix({ label: "Late Night / Bar", start: "22:00", end: "02:00" })).toBe("_late-night-bar-2200-0200");
  });

  test("the note names the slot, the clock's subject and the midnight rule when it applies", () => {
    expect(timeSlotNote(slotFor({ slot: "lunch" }), "bills SETTLED"))
      .toBe("Time slot Lunch (12:00-17:00): only bills SETTLED from 12:00 up to 17:00 restaurant time on each day of the range are counted, and any figure here on another clock is cut by the same hours on that clock.");
    const late = timeSlotNote(slotFor({ time_from: "22:00", time_to: "02:00" }), "orders PLACED");
    expect(late).toMatch(/^Time slot 22:00-02:00: only orders PLACED from 22:00 up to 02:00/);
    expect(late).toMatch(/belong to the day it started on\.$/);
  });
});
