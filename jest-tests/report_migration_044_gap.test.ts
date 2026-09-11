// THE WINDOW BETWEEN THE CODE LANDING AND MIGRATION 044 BEING APPLIED.
//
// ============================================================================
// WHY THIS WINDOW EXISTS AT ALL
// ============================================================================
// It is not hypothetical on this deployment. Two known gaps make it the DEFAULT
// outcome of a push that carries a migration:
//
//   1. `check-migrations` runs BEFORE the working tree moves, so a migration
//      arriving in the same push is invisible to the pre-flight — it reports on
//      the OLD commit and says "all migrations already applied".
//   2. The box's installed `rd-entry` has no `migrate` verb, so the automatic
//      apply comes back "exit 64 — unknown verb 'migrate'" and stops.
//
// So the code ships first and somebody applies 044 by hand afterwards. In
// between, every select naming `ReportSchedules.recipients` raises 42703.
//
// ============================================================================
// WHAT THAT WOULD HAVE COST, AND WHAT IT COSTS NOW
// ============================================================================
// `recipients` is in SCHEDULE_COLS, which the schedule list, the single-schedule
// read AND the sweep's due-list all share. Unguarded, an unapplied 044 takes out
// the whole Scheduled Reports card on a LIVE restaurant's accounting page and
// stops the sweep — so the inbox reports that were already working stop too.
//
// A feature that has not arrived yet is one nobody misses. A feature that breaks
// the one already there is an outage. These tests pin the difference.
//
// The fake pool below raises 42703 for exactly the selects that name the column,
// which is what Postgres does, and nothing else is faked.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";

const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";

interface Fx {
  /** Simulate migration 044 being unapplied on this deployment. */
  missing044: boolean;
  /** Every statement the data layer issued, normalised. */
  sql: string[];
  /** The stored schedule rows, as a pre-044 table would return them. */
  rows: Record<string, unknown>[];
  /** Make the next insert fail with this, to prove the guard is not a catch-all. */
  failInsertWith?: Error;
}

const fx: Fx = { missing044: true, sql: [], rows: [] };

const undefinedColumn = (): Error => {
  const err = new Error('column "recipients" does not exist') as Error & { code?: string };
  err.code = "42703";
  return err;
};

jest.mock("pg", () => {
  const query = async (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    fx.sql.push(q);
    if (/from "Restaurant" r/i.test(q)) {
      return { rows: [{
        res_id: RES, outlet_id: OUTLET, restaurant_slug: "gaia", restaurant_name: "Gaia",
        restaurant_main_office_add: null, restaurant_logo_url: null, timezone: null,
      }] };
    }
    // Postgres raises on the STATEMENT, so anything naming the column fails.
    if (fx.missing044 && /\brecipients\b/i.test(q)) { throw undefinedColumn(); }
    if (/from "ReportSchedules"/i.test(q)) {
      // The single-schedule read filters on id; the fixture answers it only when
      // the id actually matches, so a passing test cannot be one that matched
      // any row at all.
      const wanted = (params ?? []).find((v) => typeof v === "string" && /^3{8}-/.test(v));
      if (wanted !== undefined) { return { rows: fx.rows.filter((r) => r.id === wanted) }; }
      return { rows: fx.rows };
    }
    if (/^insert into "ReportSchedules"/i.test(q)) {
      if (fx.failInsertWith) { throw fx.failInsertWith; }
      const p = (params ?? []) as unknown[];
      return { rows: [{ ...fx.rows[0], channel: p[9] }] };
    }
    return { rows: [] };
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> { return query(sql, params); }
    connect(): Promise<unknown> { return Promise.resolve({ query, release: () => undefined }); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: jest.fn(), emitOutlet: jest.fn() }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: jest.fn() }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

let db: typeof import("../database_supabase");

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
});

beforeEach(() => {
  fx.missing044 = true;
  fx.failInsertWith = undefined;
  fx.sql = [];
  fx.rows = [{
    id: "33333333-3333-4333-8333-333333333333",
    outlet_id: OUTLET, name: "Morning sales", report_key: "sales", frequency: "daily",
    hour_local: 8, minute_local: 0, weekday: null, day_of_month: null,
    channel: "inbox", format: "csv", enabled: true,
    last_occurrence_key: null, last_status: null, last_error: null, last_run_at: null,
    consecutive_failures: 0, created_at: new Date(), updated_at: new Date(),
  }];
});

describe("an unapplied 044 does not take the accounting page down", () => {
  test("the schedule list still loads", async () => {
    const list = await db.ListReportSchedules(RES);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Morning sales");
  });

  test("…and reports an empty recipient list rather than undefined", async () => {
    // mapReportSchedule must not hand a client `undefined` here: the form joins
    // this array, and a join on undefined is a crash in the browser.
    const [s] = await db.ListReportSchedules(RES);
    expect(s.recipients).toEqual([]);
  });

  test("it RETRIED without the column rather than swallowing the error", async () => {
    // The distinction that matters: a catch-all that returned [] would ALSO make
    // the page load, by showing a restaurant zero schedules when it has four.
    await db.ListReportSchedules(RES);
    const selects = fx.sql.filter((q) => /from "ReportSchedules"/i.test(q));
    expect(selects.length).toBeGreaterThanOrEqual(2);
    expect(selects.some((q) => /\brecipients\b/.test(q))).toBe(true);
    expect(selects.some((q) => !/\brecipients\b/.test(q))).toBe(true);
  });

  test("a single schedule reads too", async () => {
    const one = await db.GetReportSchedule(RES, "33333333-3333-4333-8333-333333333333");
    expect(one?.name).toBe("Morning sales");
    expect(one?.recipients).toEqual([]);
  });

  test("the SWEEP's due-list still runs, so inbox reports keep being delivered", async () => {
    const due = await db.ListDueReportSchedules(RES);
    expect(due).toHaveLength(1);
    expect(due[0].recipients).toEqual([]);
  });

  test("once 044 IS applied the first select succeeds and there is no second one", async () => {
    // Self-healing, with no memo: a cached "missing" would keep the feature dark
    // until the next restart.
    fx.missing044 = false;
    fx.rows[0].recipients = ["owner@gaia.test"];
    fx.sql = [];
    const [s] = await db.ListReportSchedules(RES);
    expect(s.recipients).toEqual(["owner@gaia.test"]);
    expect(fx.sql.filter((q) => /from "ReportSchedules"/i.test(q))).toHaveLength(1);
  });
});

describe("a WRITE fails, and says what to do about it", () => {
  test("creating a schedule refuses with the migration named", async () => {
    // There is no degraded form of this write: a schedule stored without its
    // recipients is an email schedule with nowhere to send, which 044's own
    // CHECK exists to refuse.
    await expect(db.CreateReportSchedule(RES, { name: "x", report_key: "sales" }))
      .rejects.toThrow(/migration 044/i);
  });

  test("the message says the existing schedules keep running", async () => {
    // Because they do — and an owner who reads "database update needed" without
    // that sentence will reasonably assume their morning report has stopped.
    const err = await db.CreateReportSchedule(RES, { name: "x", report_key: "sales" })
      .then(() => null, (e: unknown) => e);
    expect(String((err as Error)?.message)).toMatch(/keep running/i);
  });

  test("it does NOT leak the raw Postgres error to the person creating a report", async () => {
    const err = await db.CreateReportSchedule(RES, { name: "x", report_key: "sales" })
      .then(() => null, (e: unknown) => e);
    expect(String((err as Error)?.message)).not.toMatch(/column .* does not exist/i);
  });

  test("and once 044 is applied the write goes through", async () => {
    fx.missing044 = false;
    await expect(db.CreateReportSchedule(RES, { name: "x", report_key: "sales" })).resolves.toBeTruthy();
  });

  test("an unrelated failure is NOT dressed up as a missing migration", async () => {
    // The guard keys on 42703 / 42P01 / 42501. A genuine fault must keep its own
    // message, or the next real failure here is misdiagnosed for a week as "the
    // migration has not been applied" and nobody looks at the database.
    fx.missing044 = false;
    fx.failInsertWith = Object.assign(new Error("connection terminated unexpectedly"), { code: "57P01" });
    const err = await db.CreateReportSchedule(RES, { name: "x", report_key: "sales" })
      .then(() => null, (e: unknown) => e);
    expect(String((err as Error)?.message)).toMatch(/connection terminated/i);
    expect(String((err as Error)?.message)).not.toMatch(/migration 044/i);
  });
});
