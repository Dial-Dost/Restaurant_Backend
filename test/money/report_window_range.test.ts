// THE RANGE, ON REAL MONEY.
//
// jest-tests/report_window.test.ts proves the window arithmetic in isolation.
// This suite proves the thing that actually matters: that the window a calendar
// picker sends decides WHICH BILLS a money report adds up, through the real,
// shipped GetSalesReport over a stubbed pg pool (bill_fixtures.ts explains why a
// fixture and not a live DB).
//
// Three bills, chosen so every failure mode is separable:
//
//   EARLY  00:30 IST on 1 June   (2026-05-31T19:00Z) — the first day, before the
//                                 UTC day has even turned over.
//   LATE   23:30 IST on 15 June  (2026-06-15T18:00Z) — the last day, late on.
//   AFTER  00:30 IST on 16 June  (2026-06-15T19:00Z) — the next day, and still
//                                 the 15th in UTC.
//
// A request for 1-15 June must take EARLY and LATE and leave AFTER. Getting the
// upper bound wrong by one day drops LATE (the "numbers are short" bug); getting
// the zone wrong takes AFTER instead (revenue booked to the wrong day, which is
// what makes a Tally export refuse to reconcile).

import { describe, test, expect, beforeAll, jest } from "@jest/globals";
import { makeDb, useFixtureDb, type FixtureBill } from "./bill_fixtures";

jest.mock("pg", () => {
  interface FixtureGlobal {
    __moneyFixtureQuery?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  }
  class FakePool {
    on(): this {
      return this;
    }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
      const run = (globalThis as unknown as FixtureGlobal).__moneyFixtureQuery;
      if (!run) {throw new Error("money fixture harness was not loaded");}
      return run(sql, params);
    }
    connect(): Promise<never> {
      return Promise.reject(new Error("money fixture: pool.connect() is not stubbed"));
    }
    end(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

type Readers = typeof import("../../database_supabase");
let db: Readers;

const RID = "zztest-window";
const IST = "Asia/Kolkata";
const AHEAD = "Pacific/Kiritimati"; // UTC+14
const BEHIND = "Pacific/Midway";    // UTC-11

const EARLY = "2026-05-31T19:00:00.000Z"; // 01 Jun 00:30 IST
const LATE = "2026-06-15T18:00:00.000Z";  // 15 Jun 23:30 IST
const AFTER = "2026-06-15T19:00:00.000Z"; // 16 Jun 00:30 IST

const bill = (id: string, settled_at: string, total_amt: number): FixtureBill => ({
  id,
  bill_no: id,
  settled_at,
  total_amt,
  // No tax lines: this suite is about WHICH bills are summed, not how a bill is
  // decomposed — report_agreement.test.ts owns that and would catch a change here.
  tax_breakdown: [],
  payment_method: "Cash",
});

const BILLS = [bill("early", EARLY, 1000), bill("late", LATE, 2000), bill("after", AFTER, 4000)];

const seed = (timezone: string) => useFixtureDb(makeDb({ timezone, bills: BILLS }));

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../../database_supabase");
});

describe("both ends of the range are inclusive", () => {
  test("1-15 June takes the 1st's small hours AND the 15th's late trade", async () => {
    seed(IST);
    const r = await db.GetSalesReport(RID, "2026-06-01", "2026-06-15");
    expect(r.from).toBe("2026-06-01");
    expect(r.to).toBe("2026-06-15");
    expect(r.total_sales).toBe(3000);
    expect(r.by_day.map((d) => d.date).sort()).toEqual(["2026-06-01", "2026-06-15"]);
  });

  test("the day AFTER `to` is excluded even though it shares `to`'s UTC day", async () => {
    seed(IST);
    const r = await db.GetSalesReport(RID, "2026-06-16", "2026-06-16");
    expect(r.total_sales).toBe(4000);
    expect(r.by_day.map((d) => d.date)).toEqual(["2026-06-16"]);
  });

  test("a one-day range is one day", async () => {
    seed(IST);
    expect((await db.GetSalesReport(RID, "2026-06-15", "2026-06-15")).total_sales).toBe(2000);
    expect((await db.GetSalesReport(RID, "2026-06-02", "2026-06-02")).total_sales).toBe(0);
  });
});

describe("the days are the RESTAURANT's days", () => {
  // The same three instants and the same requested calendar range give three
  // different answers, because 1-15 June is a different fifteen days in each
  // zone. Any of these coming out equal means a day boundary is being taken
  // from the server or from UTC instead of from the tenant.
  test("Kolkata (+5:30) sees 3000 over 1-15 June", async () => {
    seed(IST);
    expect((await db.GetSalesReport(RID, "2026-06-01", "2026-06-15")).total_sales).toBe(3000);
  });

  test("Kiritimati (+14) sees only the early bill — its 15th ended sooner", async () => {
    seed(AHEAD);
    // LATE and AFTER are both already 16 June there.
    expect((await db.GetSalesReport(RID, "2026-06-01", "2026-06-15")).total_sales).toBe(1000);
  });

  test("Midway (-11) sees the other two — its 1st had not started yet", async () => {
    seed(BEHIND);
    // EARLY is still 31 May there; LATE and AFTER are both the 15th.
    expect((await db.GetSalesReport(RID, "2026-06-01", "2026-06-15")).total_sales).toBe(6000);
  });
});

describe("bad input is clamped to a documented rule, never to a table scan", () => {
  test("a reversed range reports the same money as the forward one", async () => {
    seed(IST);
    const forward = await db.GetSalesReport(RID, "2026-06-01", "2026-06-15");
    const backward = await db.GetSalesReport(RID, "2026-06-15", "2026-06-01");
    expect(backward.from).toBe(forward.from);
    expect(backward.to).toBe(forward.to);
    expect(backward.total_sales).toBe(forward.total_sales);
  });

  test("an absurd span is capped at MAX_REPORT_DAYS, keeping the recent end", async () => {
    seed(IST);
    const r = await db.GetSalesReport(RID, "2015-01-01", "2026-06-15");
    expect(r.to).toBe("2026-06-15");
    expect(db.countDays(r.from, r.to)).toBe(db.MAX_REPORT_DAYS);
  });

  test("a future range is pulled back to today rather than rendering as zeros", async () => {
    seed(IST);
    const r = await db.GetSalesReport(RID, "2030-01-01", "2030-01-31");
    const today = db.dayKeyOf(new Date(), IST);
    expect(r.to).toBe(today);
    expect(r.from).toBe(today);
  });

  test("an unreadable date falls back to the default window, not to everything", async () => {
    seed(IST);
    const r = await db.GetSalesReport(RID, "whenever", "2026-06-15");
    expect(r.to).toBe("2026-06-15");
    expect(db.countDays(r.from, r.to)).toBe(db.DEFAULT_REPORT_DAYS);
  });
});

describe("an equivalent window reports identical money", () => {
  // The figures must not depend on HOW the window was expressed — only on which
  // days it covers. This is the invariant that lets `days` and from/to coexist.
  test("the default window restated explicitly gives the same totals", async () => {
    seed(IST);
    const implicit = await db.GetSalesReport(RID);
    const explicit = await db.GetSalesReport(RID, implicit.from, implicit.to);
    expect(explicit.total_sales).toBe(implicit.total_sales);
    expect(explicit.total_tax).toBe(implicit.total_tax);
    expect(explicit.total_service_charge).toBe(implicit.total_service_charge);
    expect(explicit.bill_count).toBe(implicit.bill_count);
    expect(explicit.by_day).toEqual(implicit.by_day);
  });

  test("splitting a range in two and adding it up reproduces the whole", async () => {
    seed(IST);
    const whole = await db.GetSalesReport(RID, "2026-06-01", "2026-06-16");
    const a = await db.GetSalesReport(RID, "2026-06-01", "2026-06-08");
    const b = await db.GetSalesReport(RID, "2026-06-09", "2026-06-16");
    // No bill may fall in both halves or in neither — the seam is exactly where
    // an off-by-one at either end would double-count or drop a day's takings.
    expect(a.total_sales + b.total_sales).toBe(whole.total_sales);
    expect(a.bill_count + b.bill_count).toBe(whole.bill_count);
    expect(whole.total_sales).toBe(7000);
  });
});
