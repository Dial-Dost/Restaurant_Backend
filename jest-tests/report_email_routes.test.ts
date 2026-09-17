// REPORT EMAIL, FROM THE ROUTES' SIDE (client item 9).
//
// The REAL handlers of routes/report_email.ts and the schedule routes of
// routes/accounting.ts run over a fake Express app; the data layer's calls are
// replaced and RECORDED, so each assertion is about what a route decided and
// what it asked the data layer to do — never about SQL (the sweep and money
// suites own that).
//
// What would be silent without each test:
//   * WHO: the book is a settings write; Send now is a reports right; the
//     all-outlets scope is an admin's or a manager's. A waiter holds none.
//   * THE ANSWERS a client branches on: 202 then a 200 replay for the same
//     client_request_id (no second email); 503 mail_not_configured,
//     schema_pending, send_now_disabled; 403 recipient_not_allowed; 429.
//   * NOTHING WAITS ON MAIL: the route inserts and kicks; it never sends.
//   * NO CREDENTIAL in the config, ever; the operator's reason only to someone
//     who can act on it.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";

const ACCOUNTING_PERM = "df75119b-e5f1-4f38-aba5-78a1cf182f56";
const PERM_SETTINGS = "6d0f3a94-8b21-4c67-9e53-1a4d7b2f8c60";
const RID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "6f9619ff-8b86-4011-b42d-00cf4fc964ff";

interface Calls { [name: string]: unknown[][] }
const mockCalls: Calls = {};
const mockState = {
  ready: true,
  book: [
    { id: "a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1", email: "owner@gaia.test", label: "Owner", status: "active" },
    { id: "b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2", email: "accounts@firm.test", label: null, status: "active" },
    { id: "c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3", email: "paused@firm.test", label: null, status: "suppressed" },
  ] as { id: string; email: string; label: string | null; status: string }[],
  existingAdhoc: null as string | null,
  recentEmails: 0,
  recentAdhoc: 0,
  recentTests: 0,
  store: new Map<string, number>(),
  addThrows: null as unknown,
  delivery: null as unknown,
  file: null as unknown,
  createThrows: null as unknown,
};
const record = (name: string, args: unknown[]) => { (mockCalls[name] ??= []).push(args); };

jest.mock("../auth/store", () => ({
  __esModule: true,
  getStore: async () => ({
    incr: async (key: string) => {
      const n = (mockState.store.get(key) ?? 0) + 1;
      mockState.store.set(key, n);
      return n;
    },
  }),
}));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: jest.fn() }));
jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: jest.fn(), emitOutlet: jest.fn() }));

jest.mock("../database_supabase", () => {
  const actual = jest.requireActual("../database_supabase") as Record<string, unknown>;
  const wrap = (name: string, impl: (...a: any[]) => unknown) => (...args: any[]) => { record(name, args); return Promise.resolve().then(() => impl(...args)); };
  return {
    __esModule: true,
    ...actual,
    reportEmailSchemaReady: wrap("reportEmailSchemaReady", () => mockState.ready),
    ListReportEmailRecipients: wrap("ListReportEmailRecipients", () => mockState.book.filter((r) => r.status === "active")),
    AddReportEmailRecipient: wrap("AddReportEmailRecipient", (_rid: string, body: { email: string; label?: string }) => {
      if (mockState.addThrows) {throw mockState.addThrows;}
      return { id: "d4d4d4d4-4444-4444-8444-d4d4d4d4d4d4", email: body.email, label: body.label ?? null, status: "active" };
    }),
    RemoveReportEmailRecipient: wrap("RemoveReportEmailRecipient", (_rid: string, id: string) => mockState.book.find((r) => r.id === id) ?? null),
    GetReportEmailRecipientsByIds: wrap("GetReportEmailRecipientsByIds", (_rid: string, ids: string[]) =>
      ids.map((id) => mockState.book.find((r) => r.id === id)).filter(Boolean)),
    FindAdhocDelivery: wrap("FindAdhocDelivery", () => mockState.existingAdhoc),
    CountRecentReportEmails: wrap("CountRecentReportEmails", () => mockState.recentEmails),
    CountRecentAdhocSends: wrap("CountRecentAdhocSends", (_r: string, _m: number, tests: boolean) => (tests ? mockState.recentTests : mockState.recentAdhoc)),
    ResolveReportEmailWindow: wrap("ResolveReportEmailWindow", (_rid: string, q: { from?: string; to?: string; day_close?: string }) => ({
      from: q.from ?? "2026-09-17", to: q.to ?? q.from ?? "2026-09-17", days: 1, clamped: [],
      day_close: q.day_close && q.day_close !== "00:00" ? q.day_close : null, day_shift_min: 0,
      window_start_at: "2026-09-15T20:30:00.000Z", window_end_at: "2026-09-16T20:30:00.000Z", timezone: "Asia/Kolkata",
    })),
    InsertAdhocReportDelivery: wrap("InsertAdhocReportDelivery", () => ({ id: "e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5", replayed: false })),
    GetReportDelivery: wrap("GetReportDelivery", () => mockState.delivery),
    GetReportDeliveryFile: wrap("GetReportDeliveryFile", () => mockState.file),
    GetReportSweepStatus: wrap("GetReportSweepStatus", () => ({ holder_is_me: false, leader_seen_at: new Date("2026-09-17T00:00:00Z"), lease_until: null, mail_ready: true, sent_today: 3 })),
    CreateReportSchedule: wrap("CreateReportSchedule", (_rid: string, input: Record<string, unknown>) => {
      if (mockState.createThrows) {throw mockState.createThrows;}
      return {
        id: "f6f6f6f6-6666-4666-8666-f6f6f6f6f6f6", outlet_id: "o1", name: String(input.name), report_key: "bundle",
        frequency: "daily", hour_local: 2, minute_local: 0, weekday: null, day_of_month: null, channel: "email",
        recipients: ["owner@gaia.test"], format: "xlsx", report_keys: ["sales_summary", "settlement_summary"],
        formats: ["xlsx"], window_mode: "trading_day", outlet_scope: "outlet", enabled: true,
        last_occurrence_key: null, last_status: null, last_error: null, last_run_at: null,
        consecutive_failures: 0, created_at: new Date(), updated_at: new Date(),
      };
    }),
    GetReportSchedule: wrap("GetReportSchedule", () => ({
      id: "f6f6f6f6-6666-4666-8666-f6f6f6f6f6f6", outlet_id: "o1", name: "Night", report_key: "bundle",
      frequency: "daily", hour_local: 2, minute_local: 0, weekday: null, day_of_month: null, channel: "email",
      recipients: ["owner@gaia.test"], format: "xlsx", report_keys: ["sales_summary", "settlement_summary"],
      formats: ["xlsx"], window_mode: "trading_day", outlet_scope: "outlet", enabled: true,
    })),
    GetTenantTimezone: wrap("GetTenantTimezone", () => "Asia/Kolkata"),
    GetEmployeeDetailsFromEmpID: () => Promise.resolve({ id: "emp-1", res_id: RID, outlet_id: "o1", username: "owner" }),
    AddAuditLogEntry: (...args: unknown[]) => { record("AddAuditLogEntry", args); return Promise.resolve(undefined); },
  };
});

jest.mock("../report_schedules", () => {
  const actual = jest.requireActual("../report_schedules") as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    kickReportDelivery: (...args: unknown[]) => { record("kickReportDelivery", args); return Promise.resolve(); },
    queueReportScheduleRun: (...args: unknown[]) => { record("queueReportScheduleRun", args); return Promise.resolve("a7a7a7a7-7777-4777-8777-a7a7a7a7a7a7"); },
  };
});

type Next = (err?: unknown) => void;
type Handler = (req: any, res: any, next: Next) => unknown;
interface Registered { method: string; path: string; handlers: Handler[] }
interface Answer { status: number; body: any; headers: Record<string, string> }

const registered: Registered[] = [];
const reg = (method: string) => (path: string, ...handlers: Handler[]): unknown => {
  registered.push({ method, path, handlers });
  return fakeApp;
};
const fakeApp = {
  get: reg("GET"), post: reg("POST"), put: reg("PUT"), patch: reg("PATCH"), delete: reg("DELETE"), use: (): unknown => fakeApp,
};

interface CallOpts { actions?: string[]; role?: string; body?: unknown; params?: Record<string, string>; query?: Record<string, string> }

async function call(method: string, path: string, opts: CallOpts = {}): Promise<Answer> {
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
    params: opts.params ?? {}, body: opts.body ?? {}, query: { restaurantId: RID, ...(opts.query ?? {}) }, headers: {},
    auth: {
      res_id: RID, outlet_id: "o1", employeeId: "3f3f3f3f-1111-4111-8111-3f3f3f3f3f3f",
      employeeUsername: "owner", role: opts.role ?? "admin", role_all: [opts.role ?? "admin"],
      actions: opts.actions ?? ["*"],
    },
  };
  for (const h of route.handlers) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (ended || !advanced) {break;}
  }
  return out;
}

const MAIL = { SMTP_HOST: "smtp.secret-host.test", SMTP_USER: "u@secret.test", SMTP_PASS: "hunter2", SMTP_FROM: "reports@secret.test" };
const mailOn = () => { Object.assign(process.env, MAIL); delete process.env.MAIL_TRANSPORT; };
const mailOff = () => { for (const k of [...Object.keys(MAIL), "MAIL_TRANSPORT"]) { delete process.env[k]; } };

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  const email = await import("../routes/report_email");
  const accounting = await import("../routes/accounting");
  accounting.registerAccountingRoutes(fakeApp as never);
  email.registerReportEmailRoutes(fakeApp as never);
});

beforeEach(() => {
  for (const k of Object.keys(mockCalls)) { delete mockCalls[k]; }
  mockState.ready = true;
  mockState.existingAdhoc = null;
  mockState.recentEmails = 0;
  mockState.recentAdhoc = 0;
  mockState.recentTests = 0;
  mockState.store.clear();
  mockState.addThrows = null;
  mockState.delivery = null;
  mockState.file = null;
  mockState.createThrows = null;
  delete process.env.REPORT_SEND_NOW;
  mailOn();
});

const sendBody = (over: Record<string, unknown> = {}) => ({
  client_request_id: REQUEST_ID,
  report_keys: ["settlement_summary", "sales_summary"],
  formats: ["xlsx"],
  window: { from: "2026-09-16", to: "2026-09-16", day_close: "02:00" },
  outlet_scope: "outlet",
  recipient_ids: ["a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1", "b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2"],
  ...over,
});

describe("GET /reports/email/config", () => {
  test("names the transport and whether it works — never a host, user, password or From", async () => {
    const r = await call("GET", "/reports/email/config");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ email_available: true, transport: "smtp", message: null, schema_ready: true, send_now_enabled: true, can_edit_recipients: true, can_use_all_outlets: true });
    expect(r.body.reports).toHaveLength(18);
    expect(r.body.limits).toMatchObject({ recipients_per_send: 10, address_book: 25, restaurant_daily: 200, platform_daily: 2000 });
    const text = JSON.stringify(r.body);
    for (const secret of ["secret-host", "hunter2", "u@secret", "reports@secret"]) {expect(text).not.toContain(secret);}
  });

  test("off: the sentence every client shows; the operator's reason only for the settings holder", async () => {
    mailOff();
    const owner = await call("GET", "/reports/email/config");
    expect(owner.body).toMatchObject({ email_available: false, transport: "off", message: "Email is not set up on this server" });
    expect(owner.body.reason).toMatch(/No mail transport is configured/);
    const accountant = await call("GET", "/reports/email/config", { actions: [ACCOUNTING_PERM], role: "custom" });
    expect(accountant.body.reason).toBeNull();
    expect(accountant.body.can_edit_recipients).toBe(false);
    expect(accountant.body.can_use_all_outlets).toBe(false);
  });

  test("a role without the reports permission gets the house 403", async () => {
    const r = await call("GET", "/reports/email/config", { actions: [], role: "waiter" });
    expect(r.status).toBe(403);
    expect(r.body.requiredPermission).toBe(ACCOUNTING_PERM);
  });
});

describe("the address book", () => {
  test("reading it is a reports right; changing it is a settings right", async () => {
    const read = await call("GET", "/reports/email/recipients", { actions: [ACCOUNTING_PERM], role: "custom" });
    expect(read.status).toBe(200);
    expect(read.body.recipients).toHaveLength(2);
    expect(read.body.can_edit).toBe(false);
    const write = await call("POST", "/reports/email/recipients", { actions: [ACCOUNTING_PERM], role: "custom", body: { email: "x@y.test" } });
    expect(write.status).toBe(403);
    expect(write.body.requiredPermission).toBe(PERM_SETTINGS);
    expect(mockCalls.AddReportEmailRecipient).toBeUndefined();
    const del = await call("DELETE", "/reports/email/recipients/:id", { actions: [ACCOUNTING_PERM], role: "custom", params: { id: "a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1" } });
    expect(del.status).toBe(403);
  });

  test("adding: 201, audited under its own label", async () => {
    const r = await call("POST", "/reports/email/recipients", { actions: [PERM_SETTINGS], role: "custom", body: { email: "new@firm.test", label: "CA" } });
    expect(r.status).toBe(201);
    expect(r.body.recipient.email).toBe("new@firm.test");
    const audit = mockCalls.AddAuditLogEntry?.[0] ?? [];
    expect(audit[3]).toBe("ffded2ef-a164-4acc-8c13-77f9c66e5c31");
    expect(String(audit[4])).toBe("Added new@firm.test to the report email address book");
  });

  test("a duplicate is the data layer's 409, passed through with its sentence and code", async () => {
    const db = await import("../database_supabase");
    mockState.addThrows = new db.ReportEmailRequestError("owner@gaia.test is already in the address book.", 409, "duplicate");
    const r = await call("POST", "/reports/email/recipients", { body: { email: "owner@gaia.test" } });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "owner@gaia.test is already in the address book.", code: "duplicate" });
  });

  test("on a database without 056-058 every write is a 503 with a sentence, and nothing is called", async () => {
    mockState.ready = false;
    const r = await call("POST", "/reports/email/recipients", { body: { email: "x@y.test" } });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("schema_pending");
    expect(mockCalls.AddReportEmailRecipient).toBeUndefined();
  });

  test("twenty changes a day, then 429", async () => {
    for (let i = 0; i < 20; i += 1) {
      expect((await call("POST", "/reports/email/recipients", { body: { email: `p${String(i)}@x.test` } })).status).toBe(201);
    }
    const r = await call("POST", "/reports/email/recipients", { body: { email: "p21@x.test" } });
    expect(r.status).toBe(429);
  });

  test("removing: 404 for a stranger, 200 and audited for a live one", async () => {
    expect((await call("DELETE", "/reports/email/recipients/:id", { params: { id: "99999999-9999-4999-8999-999999999999" } })).status).toBe(404);
    const r = await call("DELETE", "/reports/email/recipients/:id", { params: { id: "b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2" } });
    expect(r.status).toBe(200);
    expect(String(mockCalls.AddAuditLogEntry?.[0]?.[4])).toBe("Removed accounts@firm.test from the report email address book");
  });
});

describe("POST /reports/email/test", () => {
  test("queues a test delivery to that one address and kicks it — it never sends inline", async () => {
    const r = await call("POST", "/reports/email/test", { body: { recipient_id: "a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1" } });
    expect(r.status).toBe(202);
    const insert = mockCalls.InsertAdhocReportDelivery?.[0]?.[1] as Record<string, unknown>;
    expect(insert).toMatchObject({ report_keys: [], recipients: ["owner@gaia.test"], outlet_scope: "outlet" });
    expect(mockCalls.kickReportDelivery?.[0]).toEqual([RID, "e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5"]);
  });

  test("503 without a transport; 404 for an address not in the book; 403 for a paused one", async () => {
    mailOff();
    expect((await call("POST", "/reports/email/test", { body: { recipient_id: "a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1" } })).body.code).toBe("mail_not_configured");
    mailOn();
    expect((await call("POST", "/reports/email/test", { body: { recipient_id: "99999999-9999-4999-8999-999999999999" } })).status).toBe(404);
    expect((await call("POST", "/reports/email/test", { body: { recipient_id: "c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3" } })).status).toBe(403);
  });

  test("three an hour — counted in the store AND in the log, so a restart does not reset it", async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await call("POST", "/reports/email/test", { body: { recipient_id: "a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1" } })).status).toBe(202);
    }
    expect((await call("POST", "/reports/email/test", { body: { recipient_id: "a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1" } })).status).toBe(429);
    mockState.store.clear();
    mockState.recentTests = 3;
    expect((await call("POST", "/reports/email/test", { body: { recipient_id: "a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1" } })).status).toBe(429);
  });

  test("a settings right, not a reports one", async () => {
    const r = await call("POST", "/reports/email/test", { actions: [ACCOUNTING_PERM], role: "custom", body: { recipient_id: "a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1" } });
    expect(r.status).toBe(403);
  });
});

describe("POST /reports/email/send", () => {
  test("202: the delivery is recorded as asked, audited, and kicked", async () => {
    const r = await call("POST", "/reports/email/send", { actions: [ACCOUNTING_PERM], role: "manager", body: sendBody() });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ delivery_id: "e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5", replayed: false });
    const insert = mockCalls.InsertAdhocReportDelivery?.[0]?.[1] as Record<string, unknown>;
    expect(insert).toMatchObject({
      client_request_id: REQUEST_ID,
      report_keys: ["sales_summary", "settlement_summary"],
      formats: ["xlsx"],
      outlet_scope: "outlet",
      day_close: "02:00",
      recipients: ["owner@gaia.test", "accounts@firm.test"],
      period_from: "2026-09-16",
    });
    const audit = mockCalls.AddAuditLogEntry?.[0] ?? [];
    expect(audit[3]).toBe("f23fc314-7d12-41d7-af36-1cd57d8d3419");
    expect(String(audit[4])).toBe("Emailed Sales Summary and Settlement Summary for 2026-09-16 (trading day closing 02:00) to 2 addresses");
    expect(mockCalls.kickReportDelivery?.[0]?.[1]).toBe("e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5");
  });

  test("the same client_request_id again is a 200 REPLAY of the same delivery — no insert, no limit spent", async () => {
    mockState.existingAdhoc = "e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5";
    mockState.recentAdhoc = 99;
    const r = await call("POST", "/reports/email/send", { body: sendBody() });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ delivery_id: "e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5", replayed: true });
    expect(mockCalls.InsertAdhocReportDelivery).toBeUndefined();
    expect(mockCalls.AddAuditLogEntry).toBeUndefined();
  });

  test.each([
    ["no transport", () => { mailOff(); }, 503, "mail_not_configured"],
    ["a database behind", () => { mockState.ready = false; }, 503, "schema_pending"],
    ["switched off", () => { process.env.REPORT_SEND_NOW = "false"; }, 503, "send_now_disabled"],
  ])("%s: %i %s, nothing recorded", async (_name, arrange, status, code) => {
    (arrange as () => void)();
    const r = await call("POST", "/reports/email/send", { body: sendBody() });
    expect(r.status).toBe(status);
    expect(r.body.code).toBe(code);
    expect(mockCalls.InsertAdhocReportDelivery).toBeUndefined();
  });

  test.each([
    ["a missing client_request_id", { client_request_id: "" }, /client_request_id/],
    ["a time slot", { window: { from: "2026-09-16", to: "2026-09-16", slot: "lunch" } }, /whole days/],
    ["GST on a trading day", { report_keys: ["gst"] }, /calendar days/],
    ["PDF", { formats: ["pdf"] }, /PDF/],
    ["an unreadable close", { window: { from: "2026-09-16", to: "2026-09-16", day_close: "2am" } }, /HH:mm/],
    ["eleven addresses", { recipient_ids: Array.from({ length: 11 }, (_v, i) => `a1a1a1a1-1111-4111-8111-a1a1a1a1a1${String(i).padStart(2, "0")}`) }, /1 to 10/],
    ["no addresses", { recipient_ids: [] }, /1 to 10/],
  ])("400 for %s", async (_name, over, message) => {
    const r = await call("POST", "/reports/email/send", { body: sendBody(over as Record<string, unknown>) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(message as RegExp);
    expect(mockCalls.InsertAdhocReportDelivery).toBeUndefined();
  });

  test("GST on calendar days is fine", async () => {
    const r = await call("POST", "/reports/email/send", { body: sendBody({ report_keys: ["gst"], window: { from: "2026-08-01", to: "2026-08-31" } }) });
    expect(r.status).toBe(202);
  });

  test("403 for an address that is not an active entry of THIS restaurant's book", async () => {
    for (const id of ["99999999-9999-4999-8999-999999999999", "c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3"]) {
      const r = await call("POST", "/reports/email/send", { body: sendBody({ recipient_ids: ["a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1", id] }) });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("recipient_not_allowed");
    }
    expect(mockCalls.InsertAdhocReportDelivery).toBeUndefined();
  });

  test("all outlets combined: an admin or a manager, never anyone else", async () => {
    const custom = await call("POST", "/reports/email/send", { actions: [ACCOUNTING_PERM], role: "cashier", body: sendBody({ outlet_scope: "all" }) });
    expect(custom.status).toBe(403);
    expect(custom.body.code).toBe("all_outlets_not_allowed");
    const manager = await call("POST", "/reports/email/send", { actions: [ACCOUNTING_PERM], role: "manager", body: sendBody({ outlet_scope: "all" }) });
    expect(manager.status).toBe(202);
    expect((mockCalls.InsertAdhocReportDelivery?.[0]?.[1] as Record<string, unknown>).outlet_scope).toBe("all");
  });

  test("429: three a minute per person, ten an hour per restaurant (durably), and the daily cap", async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await call("POST", "/reports/email/send", { body: sendBody({ client_request_id: `6f9619ff-8b86-4011-b42d-00cf4fc964${String(10 + i)}` }) })).status).toBe(202);
    }
    expect((await call("POST", "/reports/email/send", { body: sendBody({ client_request_id: "6f9619ff-8b86-4011-b42d-00cf4fc96499" }) })).status).toBe(429);
    mockState.store.clear();
    mockState.recentAdhoc = 10;
    expect((await call("POST", "/reports/email/send", { body: sendBody() })).body.code).toBe("rate_limited");
    mockState.store.clear();
    mockState.recentAdhoc = 0;
    mockState.recentEmails = 199;
    const cap = await call("POST", "/reports/email/send", { body: sendBody() });
    expect(cap.status).toBe(429);
    expect(cap.body.code).toBe("daily_limit");
  });

  test("a waiter-shaped role cannot reach it at all", async () => {
    const r = await call("POST", "/reports/email/send", { actions: ["some-other-permission"], role: "waiter", body: sendBody() });
    expect(r.status).toBe(403);
    expect(r.body.requiredPermission).toBe(ACCOUNTING_PERM);
  });
});

describe("the delivery log's detail and files", () => {
  test("GET /reports/deliveries/:id: 404, then the delivery", async () => {
    expect((await call("GET", "/reports/deliveries/:id", { params: { id: "x" } })).status).toBe(404);
    mockState.delivery = { id: "d1", status: "sending" };
    const r = await call("GET", "/reports/deliveries/:id", { params: { id: "d1" } });
    expect(r.body).toEqual({ delivery: { id: "d1", status: "sending" } });
  });

  test("a file is served as itself, with a safe filename; a purged one is a 404 that says why", async () => {
    const miss = await call("GET", "/reports/deliveries/:id/files/:fileId", { params: { id: "d1", fileId: "f1" } });
    expect(miss.status).toBe(404);
    expect(miss.body.error).toMatch(/90 days/);
    mockState.file = { filename: "reports_Main Street\"_x.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: Buffer.from([1, 2, 3]) };
    const r = await call("GET", "/reports/deliveries/:id/files/:fileId", { params: { id: "d1", fileId: "f1" } });
    expect(r.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(r.headers["content-disposition"]).toBe("attachment; filename=\"reports_Main-Street-_x.xlsx\"");
    expect(Buffer.isBuffer(r.body)).toBe(true);
  });
});

describe("the schedule routes, since item 9", () => {
  test("a create carries next_run_at and the window that run will cover", async () => {
    jest.useFakeTimers({ doNotFake: ["setTimeout", "setImmediate", "nextTick", "queueMicrotask"] });
    jest.setSystemTime(new Date("2026-09-17T10:00:00.000Z"));
    try {
      const r = await call("POST", "/reports/schedules", { body: { name: "Night" } });
      expect(r.status).toBe(200);
      expect(r.body.next_run_at).toBe("2026-09-17T20:30:00.000Z");
      expect(r.body.next_window).toEqual({
        from: "2026-09-17", to: "2026-09-17", day_close: "02:00",
        start_at: "2026-09-16T20:30:00.000Z", end_at: "2026-09-17T20:30:00.000Z",
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test("the all-outlets flag follows the ROLE, and refusals keep their status", async () => {
    await call("POST", "/reports/schedules", { actions: [ACCOUNTING_PERM], role: "cashier", body: { name: "x" } });
    await call("POST", "/reports/schedules", { actions: [ACCOUNTING_PERM], role: "manager", body: { name: "x" } });
    expect((mockCalls.CreateReportSchedule?.[0]?.[3] as { allowAllOutlets: boolean }).allowAllOutlets).toBe(false);
    expect((mockCalls.CreateReportSchedule?.[1]?.[3] as { allowAllOutlets: boolean }).allowAllOutlets).toBe(true);
    const db = await import("../database_supabase");
    mockState.createThrows = new db.ReportEmailSchemaPendingError();
    expect((await call("POST", "/reports/schedules", { body: { name: "x" } })).status).toBe(503);
    mockState.createThrows = new db.ReportEmailRequestError("Only an admin or a manager can send reports for all outlets combined.", 403);
    const forbidden = await call("POST", "/reports/schedules", { body: { name: "x" } });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toMatch(/Only an admin or a manager/);
  });

  test("Run now takes a business date, and starts at once on a migrated database", async () => {
    const r = await call("POST", "/reports/schedules/:id/run-now", { params: { id: "f6f6f6f6-6666-4666-8666-f6f6f6f6f6f6" }, body: { business_date: "2026-09-15" } });
    expect(r.body).toEqual({ queued: true, delivery_id: "a7a7a7a7-7777-4777-8777-a7a7a7a7a7a7", started: true });
    expect((mockCalls.queueReportScheduleRun?.[0]?.[4] as { businessDate: string }).businessDate).toBe("2026-09-15");
    expect(mockCalls.kickReportDelivery?.[0]).toEqual([RID, "a7a7a7a7-7777-4777-8777-a7a7a7a7a7a7"]);
    mockState.ready = false;
    const old = await call("POST", "/reports/schedules/:id/run-now", { params: { id: "f6f6f6f6-6666-4666-8666-f6f6f6f6f6f6" }, body: { business_date: "15-09-2026" } });
    expect(old.body.started).toBe(false);
    expect((mockCalls.queueReportScheduleRun?.[1]?.[4] as { businessDate: string | null }).businessDate).toBeNull();
    expect(mockCalls.kickReportDelivery).toHaveLength(1);
  });
});
