// Scheduled report delivery.
//
// The suite that matters is "at-most-once across replicas". Two independent
// guards have to hold together, and the reviewed design shipped only one of them:
//
//   (a) an attempt in flight holds a LEASE, not a retry backoff, so a row a worker
//       is still rendering is not eligible for another replica's retry scan;
//   (b) the terminal write is a compare-and-swap in the SAME transaction as the
//       bell notification, and zero rows throws, so a superseded worker rolls its
//       notification back instead of committing a duplicate.
//
// With only (a), a genuinely slow render still double-sends once the lease lapses.
// With only (b), the loser wastes a full report run every five minutes. Both are
// tested here, separately and together.

import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from "@jest/globals";
import {
  RES_ID,
  OUTLET_ID,
  FIRST_OUTLET_ID,
  resetStore,
  addSchedule,
  addDelivery,
  deliveries,
  notifications,
  schedules,
  billsReads,
  gateBillsRead,
  breakBillsRead,
  breakDeliveredOutcomeWrite,
} from "./report_fixtures";

jest.mock("pg", () => {
  interface FixtureGlobal {
    __reportFixtureConnect?: () => { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; release: () => void };
  }
  const conn = () => {
    const make = (globalThis as unknown as FixtureGlobal).__reportFixtureConnect;
    if (!make) {throw new Error("report fixture harness was not loaded");}
    return make();
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> { return conn().query(sql, params); }
    connect(): Promise<unknown> { return Promise.resolve(conn()); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

type Sweep = typeof import("../report_schedules");
let mod: Sweep;

const IST = "Asia/Kolkata";
const MIN = 60_000;

beforeAll(async () => {
  // A connection string is required at import time; the pool is faked, so the
  // value is never dialled.
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  mod = await import("../report_schedules");
});

// Only the clock is faked. Timer functions stay real, or the awaits inside the
// sweep would never resolve.
beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval",
      "setImmediate", "clearImmediate", "nextTick", "queueMicrotask"],
  });
  resetStore();
});
afterEach(() => { jest.useRealTimers(); });

const at = (iso: string): Date => new Date(iso);

// ---------------------------------------------------------------------------
describe("occursOn", () => {
  const daily = { frequency: "daily", weekday: null, day_of_month: null };
  const weekly = { frequency: "weekly", weekday: 1, day_of_month: null };   // Monday
  const monthly = { frequency: "monthly", weekday: null, day_of_month: 28 };

  test("daily fires on every calendar day", () => {
    expect(mod.occursOn(daily, "2026-02-28")).toBe(true);
    expect(mod.occursOn(daily, "2026-03-01")).toBe(true);
  });

  test("weekly fires only on its weekday (0 = Sunday)", () => {
    expect(mod.occursOn(weekly, "2026-08-10")).toBe(true);   // Monday
    expect(mod.occursOn(weekly, "2026-08-11")).toBe(false);  // Tuesday
    expect(mod.occursOn({ ...weekly, weekday: 0 }, "2026-08-09")).toBe(true); // Sunday
  });

  test("monthly on the 28th fires in February, including a leap year", () => {
    expect(mod.occursOn(monthly, "2026-02-28")).toBe(true);
    expect(mod.occursOn(monthly, "2028-02-28")).toBe(true);  // leap year
    expect(mod.occursOn(monthly, "2026-02-27")).toBe(false);
  });
});

describe("periodFor — always closed days, never the day in progress", () => {
  test("daily covers yesterday", () => {
    expect(mod.periodFor("daily", "2026-08-11")).toEqual({ from: "2026-08-10", to: "2026-08-10" });
  });

  test("weekly covers the 7 days ending yesterday", () => {
    expect(mod.periodFor("weekly", "2026-08-11")).toEqual({ from: "2026-08-04", to: "2026-08-10" });
  });

  test("monthly covers the whole previous calendar month", () => {
    expect(mod.periodFor("monthly", "2026-08-01")).toEqual({ from: "2026-07-01", to: "2026-07-31" });
  });

  test("monthly across a year boundary", () => {
    expect(mod.periodFor("monthly", "2026-01-05")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  test("monthly picks up leap February's 29th", () => {
    expect(mod.periodFor("monthly", "2028-03-03")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(mod.periodFor("monthly", "2026-03-03")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  test("daily rolls the month and the year backwards", () => {
    expect(mod.periodFor("daily", "2026-03-01")).toEqual({ from: "2026-02-28", to: "2026-02-28" });
    expect(mod.periodFor("daily", "2026-01-01")).toEqual({ from: "2025-12-31", to: "2025-12-31" });
  });
});

describe("fireInstant — 1-indexed month and DST", () => {
  test("the month is passed 1-INDEXED (zonedWallToUtc does the -1 itself)", () => {
    // A 0-indexed month here would land in February and shift every report back
    // by a whole month — the bug zoneMidnightUtc's comment records.
    expect(mod.fireInstant("2026-03-15", 8, 0, IST).toISOString()).toBe("2026-03-15T02:30:00.000Z");
  });

  test("spring-forward gap: a local time that does not exist takes the LATER instant", () => {
    // Santiago jumps 00:00 -> 01:00 on 2026-09-06, so 00:30 local is skipped.
    const fired = mod.fireInstant("2026-09-06", 0, 30, "America/Santiago");
    expect(fired.toISOString()).toBe("2026-09-06T04:30:00.000Z");
    expect(localClock(fired, "America/Santiago")).toBe("2026-09-06, 01:30");
    // The day before, the same wall time exists and is taken literally.
    expect(mod.fireInstant("2026-09-05", 0, 30, "America/Santiago").toISOString())
      .toBe("2026-09-05T04:30:00.000Z");
  });

  test("spring-forward gap, northern hemisphere", () => {
    const fired = mod.fireInstant("2026-03-08", 2, 30, "America/New_York");
    expect(fired.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(localClock(fired, "America/New_York")).toBe("2026-03-08, 03:30");
  });

  test("fall-back repeated hour resolves to one instant, and reads back correctly", () => {
    // 02:30 happens twice in Sydney on 2026-04-05. One instant is chosen, and the
    // (schedule_id, occurrence_key) unique index means the day fires once whichever
    // pass the sweep observes — this is the case that double-sends under any
    // instant-based dedup.
    const fired = mod.fireInstant("2026-04-05", 2, 30, "Australia/Sydney");
    expect(fired.toISOString()).toBe("2026-04-04T16:30:00.000Z");
    expect(localClock(fired, "Australia/Sydney")).toBe("2026-04-05, 02:30");
  });

  test("a malformed day key yields an invalid date rather than a wrong one", () => {
    expect(Number.isNaN(mod.fireInstant("not-a-day", 8, 0, IST).getTime())).toBe(true);
  });
});

describe("dueOccurrences — the created_at floor", () => {
  const daily8 = (createdAt: string) => ({
    frequency: "daily", hour_local: 8, minute_local: 0,
    weekday: null, day_of_month: null, created_at: at(createdAt),
  });
  const CATCHUP = 6 * 60 * MIN;

  test("a schedule created AFTER today's fire time claims nothing", () => {
    // Created 09:00 IST, i.e. 03:30Z. Today's 08:00 IST (02:30Z) and yesterday's
    // are both already past — without the floor this reports a missed delivery for
    // a period during which the schedule did not exist.
    const due = mod.dueOccurrences(daily8("2026-08-11T03:30:00Z"), IST, at("2026-08-11T04:00:00Z"), CATCHUP);
    expect(due).toHaveLength(0);
  });

  test("the same schedule fires normally the NEXT day", () => {
    const due = mod.dueOccurrences(daily8("2026-08-11T03:30:00Z"), IST, at("2026-08-12T02:35:00Z"), CATCHUP);
    expect(due.map((d) => d.occurrence_key)).toEqual(["2026-08-12"]);
    expect(due[0].status).toBe("claimed");
    expect(due[0].period_from).toBe("2026-08-11");
  });

  test("an old schedule claims today, and records yesterday rather than running it", () => {
    // A schedule with no delivery history yields BOTH candidate days: today's is
    // live, yesterday's 08:00 is 18.5h ago and so outside the catch-up window.
    const due = mod.dueOccurrences(daily8("2020-01-01T00:00:00Z"), IST, at("2026-08-11T02:35:00Z"), CATCHUP);
    expect(due.map((d) => [d.occurrence_key, d.status])).toEqual([
      ["2026-08-11", "claimed"],
      ["2026-08-10", "abandoned"],
    ]);
  });

  test("nothing is due before the local fire time", () => {
    // 07:00 IST = 01:30Z, before the 08:00 IST fire time. Yesterday's occurrence is
    // outside the catch-up window and is recorded as abandoned, not run.
    const due = mod.dueOccurrences(daily8("2020-01-01T00:00:00Z"), IST, at("2026-08-11T01:30:00Z"), CATCHUP);
    expect(due.map((d) => d.occurrence_key)).toEqual(["2026-08-10"]);
    expect(due[0].status).toBe("abandoned");
  });

  test("both candidate day keys are scanned, for a late-night fire time far from UTC", () => {
    // 23:30 IST on the 10th is 18:00Z on the 10th; at 19:00Z it is already the 11th
    // in IST, so scanning only "today" would drop last night's report silently.
    const late = {
      frequency: "daily", hour_local: 23, minute_local: 30,
      weekday: null, day_of_month: null, created_at: at("2020-01-01T00:00:00Z"),
    };
    const due = mod.dueOccurrences(late, IST, at("2026-08-10T19:00:00Z"), CATCHUP);
    expect(due.map((d) => d.occurrence_key)).toEqual(["2026-08-10"]);
    expect(due[0].fire_at.toISOString()).toBe("2026-08-10T18:00:00.000Z");
  });

  test("an occurrence past the catch-up window is recorded as abandoned, not delivered late", () => {
    // 17:30 IST — 9.5h after the 08:00 fire time, so even today's is abandoned.
    const due = mod.dueOccurrences(daily8("2020-01-01T00:00:00Z"), IST, at("2026-08-11T12:00:00Z"), CATCHUP);
    expect(due.map((d) => [d.occurrence_key, d.status])).toEqual([
      ["2026-08-11", "abandoned"],
      ["2026-08-10", "abandoned"],
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("at-most-once across replicas", () => {
  // 08:00 IST on 2026-08-11 == 02:30Z. Every clock below is relative to that.
  const FIRE = "2026-08-11T02:30:00.000Z";
  const t = (offsetMin: number): Date => new Date(Date.parse(FIRE) + offsetMin * MIN);

  /** Created after the PREVIOUS day's fire time, so the created_at floor leaves
   *  exactly one occurrence in play and every assertion below is about one row. */
  const oneDaySchedule = (over: Record<string, unknown> = {}) =>
    addSchedule({ created_at: at("2026-08-10T04:00:00Z"), ...over });

  test("a second tick at the same instant claims nothing — the partial unique index", async () => {
    oneDaySchedule();
    jest.setSystemTime(t(1));
    await mod.runReportScheduleSweep(t(1));
    await mod.runReportScheduleSweep(t(1));

    expect(deliveries()).toHaveLength(1);
    expect(deliveries()[0].occurrence_key).toBe("2026-08-11");
    expect(deliveries()[0].status).toBe("delivered");
    expect(notifications()).toHaveLength(1);
  });

  test("(a) an attempt in flight holds a LEASE, so a mid-render row is not retryable", async () => {
    oneDaySchedule();
    jest.setSystemTime(t(1));

    // Hold the first render open inside TX3.
    const { reached, release } = gateBillsRead();
    const slow = mod.runReportScheduleSweep(t(1));
    await reached;

    expect(deliveries()).toHaveLength(1);
    expect(deliveries()[0].attempts).toBe(1);

    // THE BEHAVIOUR, asserted before the stored value it comes from: five minutes
    // in, another replica's tick must not touch a row this worker is still
    // rendering. If TX2 wrote the 5-minute retry backoff instead of the lease,
    // the retry scan matches here, attempt 2 is taken, and the occurrence is
    // rendered and delivered a second time.
    jest.setSystemTime(t(6));
    await mod.runReportScheduleSweep(t(6));
    expect(deliveries()[0].attempts).toBe(1);   // untouched
    expect(notifications()).toHaveLength(0);
    // ...and the stored value that produces it: a lease (default 10 min from the
    // attempt), never a backoff.
    expect(deliveries()[0].next_attempt_at.getTime()).toBe(t(11).getTime());

    release();
    await slow;
    expect(deliveries()[0].status).toBe("delivered");
    expect(notifications()).toHaveLength(1);
  });

  test("(b) once the lease lapses, the superseded worker's delivery is rolled back", async () => {
    oneDaySchedule();
    jest.setSystemTime(t(1));

    // Replica A claims, takes attempt 1, and stalls inside TX3.
    const { reached, release } = gateBillsRead();
    const replicaA = mod.runReportScheduleSweep(t(1));
    await reached;
    expect(deliveries()[0].attempts).toBe(1);

    // The lease lapses. Replica B legitimately takes attempt 2 and delivers.
    jest.setSystemTime(t(12));
    await mod.runReportScheduleSweep(t(12));
    expect(deliveries()[0].attempts).toBe(2);
    expect(deliveries()[0].status).toBe("delivered");
    expect(notifications()).toHaveLength(1);

    // A now finishes. Its terminal CAS still carries attempts=1, matches nothing,
    // throws, and takes its own notification down with it in the same transaction.
    release();
    await replicaA;

    expect(notifications()).toHaveLength(1);          // NOT two
    expect(deliveries()).toHaveLength(1);
    expect(deliveries()[0].status).toBe("delivered");
    expect(deliveries()[0].attempts).toBe(2);
  });

  test("the loser's stale artifact never overwrites the winner's row", async () => {
    oneDaySchedule();
    jest.setSystemTime(t(1));
    const { reached, release } = gateBillsRead();
    const replicaA = mod.runReportScheduleSweep(t(1));
    await reached;

    jest.setSystemTime(t(12));
    await mod.runReportScheduleSweep(t(12));
    const winnerArtifact = deliveries()[0].artifact_body;
    expect(winnerArtifact).not.toBeNull();

    release();
    await replicaA;
    expect(deliveries()[0].artifact_body).toBe(winnerArtifact);
    expect(deliveries()[0].delivered_at).not.toBeNull();
  });

  test("a suspended tenant is skipped entirely", async () => {
    resetStore({ account_status: "suspended" });
    oneDaySchedule();
    jest.setSystemTime(t(1));
    await mod.runReportScheduleSweep(t(1));
    expect(deliveries()).toHaveLength(0);
  });

  test("a disabled schedule never claims", async () => {
    oneDaySchedule({ enabled: false });
    jest.setSystemTime(t(1));
    await mod.runReportScheduleSweep(t(1));
    expect(deliveries()).toHaveLength(0);
  });

  test("the delivered occurrence records the resolved zone and the outlet it ran on", async () => {
    resetStore({ timezone: "America/New_York" });
    oneDaySchedule({ outlet_id: OUTLET_ID });
    // 08:00 New York on 2026-08-11 is 12:00Z.
    jest.setSystemTime(at("2026-08-11T12:05:00Z"));
    await mod.runReportScheduleSweep(at("2026-08-11T12:05:00Z"));

    const d = deliveries()[0];
    expect(d.timezone).toBe("America/New_York");
    expect(d.res_id).toBe(RES_ID);
    expect(d.outlet_id).toBe(OUTLET_ID);
    expect(d.occurrence_key).toBe("2026-08-11");
    expect(d.period_from).toBe("2026-08-10");
    expect(d.status).toBe("delivered");
  });

  test("the bell notification carries no money — every employee can read it", async () => {
    oneDaySchedule();
    jest.setSystemTime(t(1));
    await mod.runReportScheduleSweep(t(1));

    const n = notifications()[0];
    expect(n.type).toBe("report");
    expect(n.meta.module).toBe("Accounting");
    expect(`${n.title} ${n.body ?? ""}`).not.toMatch(/[₹$]|\d+\.\d{2}/);
    // The schedule card mirrors the outcome; the guard stays the delivery row.
    expect(schedules()[0].last_status).toBe("delivered");
    expect(schedules()[0].consecutive_failures).toBe(0);
  });

  test("an abandoned occurrence is claimed and recorded, never delivered late", async () => {
    oneDaySchedule();
    // Seven hours late, past the 6h catch-up window. The row is still CLAIMED —
    // recorded so a missed report is a visible artifact rather than silence — but
    // never rendered, so nobody receives half-day-old numbers as if they were new.
    jest.setSystemTime(t(420));
    await mod.runReportScheduleSweep(t(420));

    expect(deliveries().map((d) => [d.occurrence_key, d.status])).toEqual([["2026-08-11", "abandoned"]]);
    expect(deliveries()[0].artifact_body).toBeNull();
    expect(notifications()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The occurrence is claimed under an empty outlet's PASS A, and rendered under
// the schedule's own. Nothing in the delivery row can tell those apart — the row
// is stamped from the claim — so the proof has to be the read the report itself
// issued.
describe("the render is bound to the schedule's own outlet and the tenant's zone", () => {
  test("the Bills read carries the schedule's outlet and that zone's day bounds", async () => {
    resetStore({ timezone: "America/New_York" });
    addSchedule({ created_at: at("2026-08-10T04:00:00Z"), outlet_id: OUTLET_ID });
    const now = at("2026-08-11T12:05:00Z");   // 08:05 New York
    jest.setSystemTime(now);
    await mod.runReportScheduleSweep(now);

    expect(billsReads()).toHaveLength(1);
    // The schedule's own outlet — NOT the oldest one, which is what
    // resolveRestaurantContext's default branch hands back when no real outlet is
    // bound. This is what goes red if runOccurrence binds outlet_id "".
    expect(billsReads()[0].outlet_id).toBe(OUTLET_ID);
    expect(billsReads()[0].outlet_id).not.toBe(FIRST_OUTLET_ID);
    // ...and the window is New York midnight-to-midnight (EDT, UTC-4) for
    // 2026-08-10. The default branch selects no r.timezone at all, so the same
    // mis-binding also silently moves this to IST — 2026-08-09T18:30:00.000Z.
    expect(billsReads()[0].from).toBe("2026-08-10T04:00:00.000Z");
    expect(billsReads()[0].to).toBe("2026-08-11T04:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
describe("\"Run now\" is deduplicated by the same partial index", () => {
  const newSchedule = () => addSchedule({ created_at: at("2026-08-10T04:00:00Z") });
  // 07:00 IST — after the previous day's 08:00 (which the created_at floor
  // excludes) and before today's, so NO scheduled occurrence is due and every row
  // below is a manual one.
  const NOW = at("2026-08-11T01:30:00Z");

  test("five rapid clicks queue exactly one delivery, and it delivers once", async () => {
    const schedule = newSchedule();
    jest.setSystemTime(NOW);

    const ids: (string | null)[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(await mod.queueReportScheduleRun(RES_ID, schedule, IST, NOW));
    }
    // Four of the five conflict on (schedule_id, occurrence_key) and come back
    // null — which is the 409 the route serves. A null occurrence_key is outside
    // the partial index and would have queued five full report renders.
    expect(ids.filter((id) => id !== null)).toHaveLength(1);
    expect(deliveries()).toHaveLength(1);
    expect(deliveries()[0].occurrence_key).toBe("manual:2026-08-11T07:00");

    await mod.runReportScheduleSweep(NOW);
    expect(deliveries()).toHaveLength(1);
    expect(deliveries()[0].status).toBe("delivered");
    expect(notifications()).toHaveLength(1);
  });

  test("a deliberate re-run one minute later is a new occurrence", async () => {
    const schedule = newSchedule();
    jest.setSystemTime(NOW);
    await mod.queueReportScheduleRun(RES_ID, schedule, IST, NOW);
    const later = new Date(NOW.getTime() + MIN);
    expect(await mod.queueReportScheduleRun(RES_ID, schedule, IST, later)).not.toBeNull();
    expect(deliveries().map((d) => d.occurrence_key))
      .toEqual(["manual:2026-08-11T07:00", "manual:2026-08-11T07:01"]);
  });

  test("the bucket is the TENANT's minute, not the server's", async () => {
    // The same instant, two zones: 01:30Z is 07:00 in Kolkata and 21:30 the
    // previous day in New York.
    expect(mod.manualOccurrenceKey(NOW, IST)).toBe("manual:2026-08-11T07:00");
    expect(mod.manualOccurrenceKey(NOW, "America/New_York")).toBe("manual:2026-08-10T21:30");
  });

  test("a manual run neither collides with nor consumes the day's scheduled occurrence", async () => {
    const schedule = newSchedule();
    const fire = at("2026-08-11T02:35:00Z");   // 08:05 IST
    jest.setSystemTime(fire);
    await mod.runReportScheduleSweep(fire);
    expect(deliveries().map((d) => d.occurrence_key)).toEqual(["2026-08-11"]);

    expect(await mod.queueReportScheduleRun(RES_ID, schedule, IST, fire)).not.toBeNull();
    expect(deliveries().map((d) => d.occurrence_key))
      .toEqual(["2026-08-11", "manual:2026-08-11T08:05"]);
  });
});

// ---------------------------------------------------------------------------
describe("an unresolvable tenant timezone", () => {
  test("a zero-row \"Restaurant\" read skips the sweep rather than running it on IST", async () => {
    // The tenant runs on New York time, and its row cannot be read — a pooled
    // client carrying another tenant's app.res_id makes the fail-open policy
    // close. Defaulting to Asia/Kolkata here would claim 2026-08-11 as 9.5h late
    // and record it 'abandoned', i.e. report a missed delivery for a day that had
    // not reached its fire time yet.
    resetStore({ timezone: "America/New_York", restaurantRowReadable: false });
    addSchedule({ created_at: at("2026-08-10T04:00:00Z") });
    const now = at("2026-08-11T12:05:00Z");   // 08:05 New York
    jest.setSystemTime(now);

    await mod.runReportScheduleSweep(now);   // one tenant's failure ends nothing
    expect(deliveries()).toHaveLength(0);
    expect(notifications()).toHaveLength(0);
    expect(schedules()[0].last_status).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("failure handling", () => {
  const FIRE = "2026-08-11T02:30:00.000Z";
  const t = (offsetMin: number): Date => new Date(Date.parse(FIRE) + offsetMin * MIN);
  const newSchedule = () => addSchedule({ created_at: at("2026-08-10T04:00:00Z") });

  test("each failed attempt takes the next backoff, and only the last one rings the bell", async () => {
    newSchedule();
    breakBillsRead();

    jest.setSystemTime(t(1));
    await mod.runReportScheduleSweep(t(1));
    expect(deliveries()[0].status).toBe("failed");
    expect(deliveries()[0].attempts).toBe(1);
    expect(deliveries()[0].error).toMatch(/bills read failed/);
    expect(deliveries()[0].next_attempt_at.getTime()).toBe(t(1 + 5).getTime());
    expect(notifications()).toHaveLength(0);

    jest.setSystemTime(t(6));
    await mod.runReportScheduleSweep(t(6));
    expect(deliveries()[0].attempts).toBe(2);
    expect(deliveries()[0].next_attempt_at.getTime()).toBe(t(6 + 30).getTime());
    expect(notifications()).toHaveLength(0);

    // Attempt 3 is REPORT_MAX_ATTEMPTS: the backoff saturates at 120 and NOW the
    // owner is told, once, about a report that is not coming.
    jest.setSystemTime(t(36));
    await mod.runReportScheduleSweep(t(36));
    expect(deliveries()[0].attempts).toBe(3);
    expect(deliveries()[0].next_attempt_at.getTime()).toBe(t(36 + 120).getTime());
    expect(notifications()).toHaveLength(1);
    expect(notifications()[0].title).toMatch(/could not be delivered/);
    expect(notifications()[0].body ?? "").not.toMatch(/switched off/);
    expect(schedules()[0].last_status).toBe("failed");
    expect(schedules()[0].consecutive_failures).toBe(1);
    // ONE bad morning must not switch a paying tenant's schedule off.
    expect(schedules()[0].enabled).toBe(true);

    // Attempts are spent, so no later tick may take a fourth.
    jest.setSystemTime(t(200));
    await mod.runReportScheduleSweep(t(200));
    expect(deliveries()[0].attempts).toBe(3);
    expect(notifications()).toHaveLength(1);
  });

  test("ReapExhaustedReportDeliveries fails a row a dead worker left mid-flight", async () => {
    const schedule = newSchedule();
    // A worker that took the last attempt and died: still 'claimed', attempts
    // spent, lease lapsed. `attempts < REPORT_MAX_ATTEMPTS` excludes it from the
    // retry scan, so without the reaper it is invisible rather than failed.
    addDelivery({ schedule_id: schedule.id, attempts: 3, status: "claimed", next_attempt_at: t(-60) });
    jest.setSystemTime(t(1));
    await mod.runReportScheduleSweep(t(1));

    expect(deliveries()).toHaveLength(1);
    expect(deliveries()[0].status).toBe("failed");
    expect(deliveries()[0].error).toBe("Retries exhausted");
  });

  test("auto-disable fires at five consecutive failures, not before", async () => {
    const schedule = newSchedule();
    breakBillsRead();
    // Five occurrences each already on their last attempt, so one tick exhausts
    // five deliveries in a row against one schedule.
    for (let i = 1; i <= 5; i += 1) {
      addDelivery({
        schedule_id: schedule.id,
        attempts: 2,
        occurrence_key: `2026-08-0${String(i)}`,
        next_attempt_at: t(-60),
      });
    }
    jest.setSystemTime(t(1));
    await mod.runReportScheduleSweep(t(1));

    expect(schedules()[0].consecutive_failures).toBe(5);
    expect(schedules()[0].enabled).toBe(false);
    expect(notifications()).toHaveLength(5);
    // Only the one that actually switched it off says so.
    expect(notifications()[3].body ?? "").not.toMatch(/switched off/);
    expect(notifications()[4].body ?? "").toMatch(/switched off/);
  });

  test("an owner's explicit pause is not undone by an in-flight retry failing", async () => {
    // The owner pauses a schedule while one of its deliveries is already in
    // flight. The retry is still eligible — the retry scan is keyed on the
    // delivery, not on whether its schedule is currently enabled — so its
    // failure reaches the outcome write. That write recomputes `enabled`, and
    // recomputing it from the failure count ALONE turns the pause back on.
    const schedule = addSchedule({ created_at: at("2026-08-10T04:00:00Z"), enabled: false });
    breakBillsRead();
    addDelivery({
      schedule_id: schedule.id,
      attempts: 2,
      occurrence_key: "2026-08-01",
      next_attempt_at: t(-60),
    });
    jest.setSystemTime(t(1));
    await mod.runReportScheduleSweep(t(1));

    expect(deliveries()[0].status).toBe("failed");
    expect(schedules()[0].consecutive_failures).toBe(1);
    expect(schedules()[0].enabled).toBe(false);
  });

  test("a bookkeeping failure AFTER the delivery committed is not a delivery failure", async () => {
    const schedule = newSchedule();
    // On its last attempt, so a mis-handled bookkeeping error would take the
    // owner-facing "could not be delivered" branch.
    addDelivery({ schedule_id: schedule.id, attempts: 2 });
    breakDeliveredOutcomeWrite();
    jest.setSystemTime(t(5));
    await mod.runReportScheduleSweep(t(5));

    // TX4 committed: the report WAS delivered and the bell WAS raised.
    expect(deliveries()).toHaveLength(1);
    expect(deliveries()[0].status).toBe("delivered");
    expect(deliveries()[0].error).toBeNull();
    expect(notifications()).toHaveLength(1);
    expect(notifications()[0].title).toMatch(/ready —/);
    // The unmirrored card is the ONLY casualty. It must not become a failure
    // streak that switches the schedule off after five, nor a second bell telling
    // the owner a delivered report never arrived.
    expect(schedules()[0].last_status).toBeNull();
    expect(schedules()[0].consecutive_failures).toBe(0);
    expect(schedules()[0].enabled).toBe(true);
  });

  test("an unroutable channel fails loudly instead of defaulting to the inbox", async () => {
    const schedule = newSchedule();
    // What widening migration 026's channel CHECK without adding a sender looks
    // like from here.
    addDelivery({ schedule_id: schedule.id, channel: "sms" });
    jest.setSystemTime(t(5));
    await mod.runReportScheduleSweep(t(5));

    expect(deliveries()[0].status).toBe("failed");
    expect(deliveries()[0].error).toMatch(/Unsupported report channel: sms/);
    expect(notifications()).toHaveLength(0);
  });
});

function localClock(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(d);
}
