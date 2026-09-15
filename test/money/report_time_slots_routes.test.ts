// REPORT TIME SLOTS, FROM THE ROUTES' SIDE.
//
// The REAL handlers from routes/reports_mis.ts run over a fake Express app, and
// the REAL data layer runs over the MIS fixture's fake pg (mis_fixtures.ts) — so
// a preset saved through PUT is the preset a report is then cut by. Only the
// audit writer's two lookups are replaced, and recorded.
//
// What is pinned here, each for a failure that would be silent:
//   * WHO. Reading the presets is a report reader's right (ACCOUNTING_PERM) and
//     `can_edit` tells the toolbar whether to offer Manage; changing them is a
//     settings write (PERM_SETTINGS). A read on the wrong gate hides the picker
//     from every accountant; a write on the wrong gate lets any of them redefine
//     Lunch for the whole restaurant.
//   * REFUSALS ARE 400s WITH ONE SENTENCE, and write nothing — an overlap above
//     all, because two presets claiming one minute double-count a bill.
//   * AN EMPTY LIST RESETS to the defaults, and every save is audited with the
//     list it replaced.
//   * THE SHELL: ?slot= reaches the reader, the catalogue advertises it for all
//     fifteen, and the CSV name carries the slot only when one was applied.

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { makeDb, useFixtureDb, type FixtureDb } from "./mis_fixtures";

jest.mock("pg", () => {
  interface FixtureGlobal {
    __misFixtureQuery?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  }
  const run = (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const q = (globalThis as unknown as FixtureGlobal).__misFixtureQuery;
    if (!q) {throw new Error("mis fixture harness was not loaded");}
    return q(sql, params);
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> { return run(sql, params); }
    connect(): Promise<{ query: typeof run; release: () => void }> {
      return Promise.resolve({ query: run, release: () => { /* pooled */ } });
    }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

const mockAudits: unknown[][] = [];

jest.mock("../../database_supabase", () => {
  const actual = jest.requireActual("../../database_supabase") as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    GetEmployeeDetailsFromEmpID: () => Promise.resolve({ id: "emp-1", res_id: "zztest-mis", outlet_id: "out-1", username: "owner" }),
    AddAuditLogEntry: (...args: unknown[]) => { mockAudits.push(args); return Promise.resolve(undefined); },
  };
});

const ACCOUNTING_PERM = "df75119b-e5f1-4f38-aba5-78a1cf182f56";
const PERM_SETTINGS = "6d0f3a94-8b21-4c67-9e53-1a4d7b2f8c60";

type Next = (err?: unknown) => void;
type Handler = (req: any, res: any, next: Next) => unknown;
interface Registered { method: string; path: string; handlers: Handler[] }
interface Answer { status: number; body: any; headers: Record<string, string> }

const registered: Registered[] = [];
const record = (method: string) => (path: string, ...handlers: Handler[]): unknown => {
  registered.push({ method, path, handlers });
  return fakeApp;
};
const fakeApp = {
  get: record("GET"), post: record("POST"), put: record("PUT"),
  patch: record("PATCH"), delete: record("DELETE"), use: (): unknown => fakeApp,
};

async function call(
  method: string,
  path: string,
  opts: { actions?: string[]; body?: unknown; query?: Record<string, string> } = {},
): Promise<Answer> {
  const route = registered.find((r) => r.method === method && r.path === path);
  if (!route) {throw new Error(`no route registered for ${method} ${path}`);}
  const out: Answer = { status: 200, body: undefined, headers: {} };
  let ended = false;
  const res = {
    status(code: number) { out.status = code; return res; },
    json(payload: unknown) { if (!ended) { out.body = payload; ended = true; } return res; },
    send(payload: unknown) { if (!ended) { out.body = payload; ended = true; } return res; },
    setHeader(name: string, value: string) { out.headers[name.toLowerCase()] = value; return res; },
    end() { ended = true; return res; },
  };
  const req = {
    params: {}, body: opts.body ?? {}, query: opts.query ?? {}, headers: {},
    auth: {
      res_id: "zztest-mis", outlet_id: "out-1", employeeId: "3f3f3f3f-1111-4111-8111-3f3f3f3f3f3f",
      employeeUsername: "owner", role: "custom", actions: opts.actions ?? ["*"],
    },
  };
  for (const h of route.handlers) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (ended || !advanced) {break;}
  }
  return out;
}

let fixture: FixtureDb;

beforeEach(async () => {
  if (registered.length === 0) {
    process.env.SUPABASE_DIRECT_URL =
      process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
    const mis = await import("../../routes/reports_mis");
    mis.registerMisReportRoutes(fakeApp as never);
  }
  mockAudits.length = 0;
  fixture = makeDb({
    timezone: "Asia/Kolkata",
    bills: [
      // 13:00 IST and 20:00 IST on 2 June.
      { id: "l1", bill_no: "1", settled_at: "2026-06-02T07:30:00.000Z", total_amt: 1000, tax_breakdown: [], payment_method: "Cash" },
      { id: "d1", bill_no: "2", settled_at: "2026-06-02T14:30:00.000Z", total_amt: 2000, tax_breakdown: [], payment_method: "Cash" },
    ],
  });
  useFixtureDb(fixture);
});

const LATE = [
  { label: "Lunch", start: "12:00", end: "17:00" },
  { id: "dinner", label: "Dinner", start: "18:00", end: "02:00" },
];

describe("GET /reports/mis/time-slots", () => {
  test("a report reader gets the defaults, and cannot edit them", async () => {
    const answer = await call("GET", "/reports/mis/time-slots", { actions: [ACCOUNTING_PERM] });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      slots: [
        { id: "lunch", label: "Lunch", start: "12:00", end: "17:00", crosses_midnight: false },
        { id: "dinner", label: "Dinner", start: "18:00", end: "24:00", crosses_midnight: false },
      ],
      can_edit: false,
      is_default: true,
    });
  });

  test("a reader who also holds the settings permission is told they can edit", async () => {
    const answer = await call("GET", "/reports/mis/time-slots", { actions: [ACCOUNTING_PERM, PERM_SETTINGS] });
    expect(answer.body.can_edit).toBe(true);
  });

  test("without the report permission it is the house 403", async () => {
    const answer = await call("GET", "/reports/mis/time-slots", { actions: [PERM_SETTINGS] });
    expect(answer.status).toBe(403);
    expect(answer.body.requiredPermission).toBe(ACCOUNTING_PERM);
  });
});

describe("PUT /reports/mis/time-slots", () => {
  test("a settings holder replaces the list; the report then cuts by it; the save is audited with what it replaced", async () => {
    const answer = await call("PUT", "/reports/mis/time-slots", { actions: [PERM_SETTINGS], body: { slots: LATE } });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      slots: [
        { id: "lunch", label: "Lunch", start: "12:00", end: "17:00", crosses_midnight: false },
        { id: "dinner", label: "Dinner", start: "18:00", end: "02:00", crosses_midnight: true },
      ],
      can_edit: true,
      is_default: false,
    });
    expect(fixture.report_time_slots).toEqual({ version: 1, slots: [{ id: "lunch", label: "Lunch", start: "12:00", end: "17:00" }, { id: "dinner", label: "Dinner", start: "18:00", end: "02:00" }] });

    expect(mockAudits).toHaveLength(1);
    const [, , , actionId, description, , details] = mockAudits[0] as [unknown, unknown, unknown, string, string, unknown, { report_time_slots: { before: unknown; after: unknown } }];
    expect(actionId).toBe("60d14e9c-45cc-4dc2-b017-56058cc3ae33");
    expect(description).toBe("Updated report time slots: Lunch 12:00-17:00, Dinner 18:00-02:00");
    expect(details.report_time_slots.before).toBeNull();
    expect(details.report_time_slots.after).toEqual((fixture.report_time_slots as { slots: unknown }).slots);

    // Built AND called: the saved Dinner is what ?slot=dinner now means.
    const sales = await call("GET", "/reports/mis/sales-summary", { query: { from: "2026-06-01", to: "2026-06-15", slot: "dinner" } });
    expect(sales.body.meta.time_slot).toMatchObject({ id: "dinner", start: "18:00", end: "02:00", crosses_midnight: true });
    expect(sales.body.totals.grand_total).toBe(2000);
  });

  test("an empty list resets to the defaults and says so", async () => {
    fixture.report_time_slots = { version: 1, slots: [{ id: "brunch", label: "Brunch", start: "10:00", end: "14:00" }] };
    const answer = await call("PUT", "/reports/mis/time-slots", { body: { slots: [] } });
    expect(answer.status).toBe(200);
    expect(answer.body.is_default).toBe(true);
    expect(answer.body.slots.map((s: { id: string }) => s.id)).toEqual(["lunch", "dinner"]);
    expect(fixture.report_time_slots).toBeNull();
    const details = (mockAudits[0] as unknown[])[6] as { report_time_slots: { before: unknown; after: unknown } };
    expect((mockAudits[0] as unknown[])[4]).toBe("Reset report time slots to the defaults");
    expect(details.report_time_slots).toEqual({ before: [{ id: "brunch", label: "Brunch", start: "10:00", end: "14:00" }], after: null });
  });

  test.each([
    ["an overlap", { slots: [{ label: "Lunch", start: "12:00", end: "17:00" }, { label: "Siesta", start: "16:30", end: "18:00" }] },
      '"Lunch" (12:00-17:00) overlaps "Siesta" (16:30-18:00); a time of day can belong to only one time slot.'],
    ["an overlap across midnight", { slots: [{ label: "Dinner", start: "18:00", end: "02:00" }, { label: "Night", start: "01:00", end: "03:00" }] },
      '"Dinner" (18:00-02:00) overlaps "Night" (01:00-03:00); a time of day can belong to only one time slot.'],
    ["a bad time", { slots: [{ label: "Lunch", start: "12", end: "17:00" }] },
      '"Lunch" needs a start time between 00:00 and 23:59, written as HH:mm.'],
    ["no list at all", {}, "Send the time slots as a list."],
    ["too many", { slots: Array.from({ length: 9 }, (_, i) => ({ label: `S${String(i)}`, start: `0${String(i)}:00`, end: `0${String(i)}:30` })) },
      "You can save at most 8 time slots."],
  ])("%s is a 400 with one sentence, and nothing is written", async (_name, body, sentence) => {
    const before = { version: 1, slots: [{ id: "brunch", label: "Brunch", start: "10:00", end: "14:00" }] };
    fixture.report_time_slots = before;
    const answer = await call("PUT", "/reports/mis/time-slots", { actions: [PERM_SETTINGS], body });
    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ error: "Invalid time slots", details: sentence });
    expect(fixture.report_time_slots).toEqual(before);
    expect(mockAudits).toHaveLength(0);
  });

  test("a report reader without the settings permission cannot save", async () => {
    const answer = await call("PUT", "/reports/mis/time-slots", { actions: [ACCOUNTING_PERM], body: { slots: LATE } });
    expect(answer.status).toBe(403);
    expect(answer.body.requiredPermission).toBe(PERM_SETTINGS);
    expect(fixture.report_time_slots).toBeUndefined();
  });
});

describe("the report shell carries the slot", () => {
  test("the catalogue advertises the slot for all fifteen, and the four time-wise cuts", async () => {
    const answer = await call("GET", "/reports/mis", { actions: [ACCOUNTING_PERM] });
    const keys = (answer.body.reports as { key: string }[]).map((r) => r.key);
    expect(keys).toHaveLength(15);
    expect(answer.body.shell.time_slot).toEqual({ params: ["slot", "time_from", "time_to"], presets_path: "/reports/mis/time-slots", applies_to: keys });
    expect(answer.body.shell.time_wise).toEqual({ param: "bucket", values: ["day", "hour", "hour_of_day", "session"], applies_to: ["sales_summary"] });
  });

  test("?slot= and custom times reach the reader, and win in that order", async () => {
    const q = { from: "2026-06-01", to: "2026-06-15" };
    const lunch = await call("GET", "/reports/mis/sales-summary", { query: { ...q, slot: "lunch" } });
    expect(lunch.body.totals.grand_total).toBe(1000);
    const custom = await call("GET", "/reports/mis/sales-summary", { query: { ...q, slot: "lunch", time_from: "19:00", time_to: "21:00" } });
    expect(custom.body.meta.time_slot).toMatchObject({ source: "custom", start: "19:00", end: "21:00" });
    expect(custom.body.totals.grand_total).toBe(2000);
    const session = await call("GET", "/reports/mis/sales-summary", { query: { ...q, bucket: "session" } });
    expect(session.body.series.map((s: { bucket: string }) => s.bucket)).toEqual(["Lunch (12:00-17:00)", "Dinner (18:00-24:00)"]);
  });

  test("the CSV name carries the slot ONLY when one was applied", async () => {
    const q = { from: "2026-06-01", to: "2026-06-15" };
    const plain = await call("GET", "/reports/mis/sales-summary.csv", { query: q });
    expect(plain.headers["content-disposition"]).toBe('attachment; filename="sales_summary_Main_2026-06-01_to_2026-06-15.csv"');
    const lunch = await call("GET", "/reports/mis/order-summary.csv", { query: { ...q, slot: "lunch" } });
    expect(lunch.headers["content-disposition"]).toBe('attachment; filename="order_summary_Main_2026-06-01_to_2026-06-15_lunch-1200-1700.csv"');
    const custom = await call("GET", "/reports/mis/tip-summary.csv", { query: { ...q, time_from: "22:00", time_to: "02:00" } });
    expect(custom.headers["content-disposition"]).toBe('attachment; filename="tip_summary_Main_2026-06-01_to_2026-06-15_custom-2200-0200.csv"');
    // slot=all is all day, and all day keeps the name it always had.
    const all = await call("GET", "/reports/mis/sales-summary.csv", { query: { ...q, slot: "all" } });
    expect(all.headers["content-disposition"]).toBe(plain.headers["content-disposition"]);
  });
});
