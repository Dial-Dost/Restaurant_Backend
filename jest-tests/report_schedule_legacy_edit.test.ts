// AN INSTALLED 2.0.1 APP EDITING A SCHEDULE IT CANNOT SHOW (client item 9).
//
// The 2.0.1 owner app's Scheduled reports card knows three report keys. It
// opens any other row with its dropdown reset to "Sales (accounting)" and
// PATCHes {name, report_key, frequency, hour_local, minute_local} — no
// report_keys, no channel, no window. So an owner who only moved the send time
// of an "Item Wise" schedule from that app sent report_key 'sales', and the
// server, reading a report_key alone as authoritative for any single-key row,
// quietly turned the schedule into a Sales (accounting) one.
//
// The REAL UpdateReportSchedule runs here over a fake pool that serves the
// stored row and records the UPDATE — the rule is observed in the write, not
// read back from the source.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";

const RES_ID = "11111111-1111-4111-8111-111111111111";
const OUTLET_ID = "22222222-2222-4222-8222-222222222222";
const SCHEDULE_ID = "33333333-3333-4333-8333-333333333333";

interface StoredRow {
  report_key: string; report_keys: string[]; formats: string[]; format: string;
  window_mode: string; outlet_scope: string; channel: string; recipients: string[];
  frequency: string; hour_local: number; minute_local: number;
}

const fx: { row: StoredRow; updates: unknown[][] } = { row: null as unknown as StoredRow, updates: [] };

jest.mock("pg", () => {
  const query = async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    // The transaction and the tenant GUCs withTenant sets.
    if (/^(begin|commit|rollback)$/i.test(q) || /^select set_config\(/i.test(q) || /^(set|reset) /i.test(q)) {return { rows: [] };}
    if (/from "Restaurant" r/i.test(q)) {
      return { rows: [{
        res_id: RES_ID, outlet_id: OUTLET_ID, restaurant_slug: "gaia", restaurant_name: "Gaia",
        restaurant_main_office_add: null, restaurant_logo_url: null, timezone: "Asia/Kolkata",
      }] };
    }
    if (/to_regclass\('"ReportEmailRecipients"'\) is not null as m056/i.test(q)) {
      return { rows: [{ m056: true, m057: true, m058: true }] };
    }
    if (/^select .* from "ReportSchedules" where id = \$3/i.test(q)) {
      return { rows: [{
        id: SCHEDULE_ID, outlet_id: OUTLET_ID, name: "Night", weekday: null, day_of_month: null,
        enabled: true, last_occurrence_key: null, last_status: null, last_error: null, last_run_at: null,
        consecutive_failures: 0, created_at: new Date("2026-09-01T00:00:00Z"), updated_at: new Date("2026-09-01T00:00:00Z"),
        ...fx.row,
      }] };
    }
    if (/^update "ReportSchedules" set name = \$4/i.test(q)) {
      fx.updates.push(params);
      const p = params;
      return { rows: [{
        id: SCHEDULE_ID, outlet_id: OUTLET_ID, name: p[3], report_key: p[4], frequency: p[5],
        hour_local: p[6], minute_local: p[7], weekday: p[8], day_of_month: p[9], channel: p[10],
        recipients: p[11], format: p[12], enabled: p[13], last_occurrence_key: null, last_status: null,
        last_error: null, last_run_at: null, consecutive_failures: 0,
        created_at: new Date("2026-09-01T00:00:00Z"), updated_at: new Date(),
        ...(p.length > 16 ? { report_keys: p[16], formats: p[17], window_mode: p[18], outlet_scope: p[19] } : {}),
      }] };
    }
    if (/from "ReportSchedules" where res_id = \$1 and outlet_id = \$2 and channel = 'email'/i.test(q)) {
      return { rows: [{ n: 0 }] };
    }
    throw new Error(`legacy-edit fixture: unstubbed SQL — ${q.slice(0, 160)}`);
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
  fx.updates = [];
  db.resetReportEmailSchemaCache();
});

/** Exactly what the 2.0.1 app's Edit sends for a daily schedule (origin/main modules.dart). */
const APP_201_EDIT = { name: "Night", report_key: "sales", frequency: "daily", hour_local: 3, minute_local: 0 };

const edit = (row: StoredRow, body: Record<string, unknown>) => {
  fx.row = row;
  return db.withTenant({ res_id: RES_ID, outlet_id: OUTLET_ID, employeeId: "e", role: "admin" }, () =>
    db.UpdateReportSchedule(RES_ID, SCHEDULE_ID, body, "e", { allowAllOutlets: true }));
};

const ONE_MIS: StoredRow = {
  report_key: "item_wise", report_keys: ["item_wise"], formats: ["xlsx"], format: "xlsx",
  window_mode: "trading_day", outlet_scope: "outlet", channel: "inbox", recipients: [],
  frequency: "daily", hour_local: 2, minute_local: 0,
};

describe("a 2.0.1 Edit never changes what a schedule sends behind the owner's back", () => {
  test("ONE MIS report (Item Wise): the reset 'sales' is ignored; the new time is kept", async () => {
    const saved = await edit(ONE_MIS, APP_201_EDIT);
    expect(saved.report_keys).toEqual(["item_wise"]);
    expect(saved.report_key).toBe("item_wise");
    expect(saved.window_mode).toBe("trading_day");
    expect(saved.formats).toEqual(["xlsx"]);
    expect([saved.hour_local, saved.minute_local]).toEqual([3, 0]);
    expect(fx.updates).toHaveLength(1);
    expect(fx.updates[0][16]).toEqual(["item_wise"]);
  });

  test("a BUNDLE (two reports, emailed): its reports, format, channel and addresses stay", async () => {
    const saved = await edit({
      report_key: "bundle", report_keys: ["sales_summary", "settlement_summary"], formats: ["xlsx", "csv"], format: "xlsx",
      window_mode: "trading_day", outlet_scope: "outlet", channel: "email", recipients: ["owner@gaia.test"],
      frequency: "daily", hour_local: 23, minute_local: 30,
    }, APP_201_EDIT);
    expect(saved.report_keys).toEqual(["sales_summary", "settlement_summary"]);
    expect(saved.report_key).toBe("bundle");
    expect(saved.channel).toBe("email");
    expect(saved.recipients).toEqual(["owner@gaia.test"]);
    expect(saved.formats).toEqual(["xlsx", "csv"]);
  });

  test("a row the 2.0.1 form CAN show (one accounting report) still takes the key it chose", async () => {
    const calendarEmail: StoredRow = {
      report_key: "sales", report_keys: ["sales"], formats: ["xlsx"], format: "xlsx",
      window_mode: "calendar", outlet_scope: "outlet", channel: "email", recipients: ["owner@gaia.test"],
      frequency: "daily", hour_local: 8, minute_local: 0,
    };
    const saved = await edit(calendarEmail, { ...APP_201_EDIT, report_key: "pnl" });
    expect(saved.report_keys).toEqual(["pnl"]);
    expect(saved.report_key).toBe("pnl");
    // …and a choice that cannot be sent on that row's kind of day is refused
    // out loud, never stored or silently swapped.
    const tradingSales: StoredRow = { ...calendarEmail, window_mode: "trading_day" };
    await expect(edit(tradingSales, { ...APP_201_EDIT, report_key: "gst" })).rejects.toThrow(/GST can only be sent for calendar days/);
  });

  test("a current client's report_keys always wins, on any row", async () => {
    const saved = await edit(ONE_MIS, { ...APP_201_EDIT, report_keys: ["discount", "void_kot"] });
    expect(saved.report_keys).toEqual(["discount", "void_kot"]);
    expect(saved.report_key).toBe("bundle");
  });
});
