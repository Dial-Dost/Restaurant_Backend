// THE OWNER'S SWITCH FOR THE QR ON THE BILL (the bill_show_qr column).
//
// "Add an option in settings to disable and enable qr code from the bill."
//
// The QR block on a customer bill — the sentence above it and the code itself —
// is printed by escpos.ts only when it is handed a `feedbackUrl`. So the switch
// is entirely a question of what POST /print/bill hands the renderer, and that
// is what this file drives: the REAL handler from routes/bills.ts, the REAL
// feedbackUrlForTable, with the reads either side of them stubbed and the
// renderer captured.
//
// Three things are pinned, each for a failure that would be silent:
//   * OFF prints no QR — the point of the switch.
//   * ON, and a settings shape with NO key at all (a tenant from before the column existed),
//     both print the QR — the default must be the behaviour everyone already had.
//   * The switch is wired through the settings WRITE path and the data layer
//     reads NULL as on — a switch the settings screen cannot save, or that turns
//     itself off for every tenant the moment the column appears, is worse than
//     none. Those two are source guards, because database_supabase.ts cannot run
//     its SQL under jest.

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mockIds = {
  res: "11111111-1111-4111-8111-111111111111",
  outlet: "22222222-2222-4222-8222-222222222222",
  table: "33333333-3333-4333-8333-333333333333",
  bill: "44444444-4444-4444-8444-444444444444",
  waiter: "55555555-5555-4555-8555-555555555555",
};

/** What GetRestaurantSettings answers. `bill_show_qr` absent = a shape from before the column existed. */
const mockSettings: { value: Record<string, unknown> } = { value: {} };
/** Every ReceiptOptions handed to the ESC/POS renderer. THIS IS THE PAPER. */
const mockReceipts: Record<string, unknown>[] = [];
/** How many times the table's feedback context was looked up. */
const mockFeedbackLookups: { n: number } = { n: 0 };

jest.mock("pg", () => {
  const answer = (sql: string): unknown[] => {
    const q = String(sql);
    if (q.includes('select default_tax from "Outlets"')) { return [{ default_tax: null }]; }
    if (q.includes('select service_charge from "Restaurant"')) { return [{ service_charge: 0 }]; }
    if (q.includes('from "Restaurant" r')) {
      return [{
        res_id: mockIds.res, outlet_id: mockIds.outlet,
        restaurant_slug: "fixture", restaurant_name: "Fixture Diner",
        restaurant_main_office_add: null, restaurant_logo_url: null,
        timezone: "Asia/Kolkata",
      }];
    }
    if (q.includes('from "Tables"')) { return [{ id: mockIds.table }]; }
    if (q.includes('from "Bills"')) { return [{ id: mockIds.bill }]; }
    if (q.includes('from "ServiceChargeWaivers"')) { return []; }
    throw new Error(`bill_show_qr fixture: no answer for: ${q.replace(/\s+/g, " ").trim().slice(0, 140)}`);
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string): Promise<{ rows: unknown[] }> { return Promise.resolve({ rows: answer(sql) }); }
    connect(): Promise<never> { return Promise.reject(new Error("bill_show_qr fixture: pool.connect() is not stubbed")); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

jest.mock("../database_supabase", () => {
  const actual = jest.requireActual("../database_supabase") as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    GetBillForTable: () => Promise.resolve({
      bill_id: mockIds.bill, table_id: mockIds.table,
      total_amt: 500, subtotal: 500, discount_type: null, discount_value: 0,
      items: [{ name: "Dal Makhani", price: 500, quantity: 1 }],
      covers: 2, customer: null, bill_no: "B-1", coupon_code: null, order_notes: [] as string[],
    }),
    GetRestaurantSettings: () => Promise.resolve({
      currency: "₹", bill_paper_width: "80mm", timezone: "Asia/Kolkata",
      ...mockSettings.value,
    }),
    GetRestaurantProfile: () => Promise.resolve({ outlet_name: "Fixture Diner", outlet_add: null, outlet_phone: null }),
    // A table that HAS a feedback context, so the only thing that can keep the
    // QR off the paper is the switch.
    GetTableFeedbackContext: () => {
      mockFeedbackLookups.n += 1;
      return Promise.resolve({ outlet_id: mockIds.outlet, employee_id: mockIds.waiter });
    },
    GetRestaurantLogoRaw: () => Promise.resolve(null),
    GetEmployeeDetailsFromEmpID: () => Promise.resolve({
      id: "emp-1", res_id: mockIds.res, outlet_id: mockIds.outlet,
      username: "cashier1", emp_Fname: "Cashier", emp_Lname: "One",
    }),
    AddAuditLogEntry: () => Promise.resolve(undefined),
  };
});

jest.mock("../escpos", () => {
  const actual = jest.requireActual("../escpos") as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    buildReceiptBase64: (opts: Record<string, unknown>) => { mockReceipts.push(opts); return "RVND"; },
  };
});

jest.mock("../print_routing", () => ({
  __esModule: true,
  dispatchPrintJob: () => Promise.resolve({ jobId: "job-1", decision: { destinationName: "Counter" }, assignedDeviceId: null }),
}));

type Next = (err?: unknown) => void;
type Handler = (req: any, res: any, next: Next) => unknown;
interface Registered { method: string; path: string; handlers: Handler[] }

const registered: Registered[] = [];
const record = (method: string) => (path: string, ...handlers: Handler[]): unknown => {
  registered.push({ method, path, handlers });
  return fakeApp;
};
const fakeApp = {
  get: record("GET"), post: record("POST"), put: record("PUT"),
  patch: record("PATCH"), delete: record("DELETE"), use: (): unknown => fakeApp,
};

const AUTH = {
  res_id: mockIds.res, outlet_id: mockIds.outlet,
  employeeId: "3f3f3f3f-1111-4111-8111-3f3f3f3f3f3f",
  employeeUsername: "cashier1", role: "admin", actions: ["*"],
};

/** Drive the real POST /print/bill and return what the renderer was handed. */
async function printBill(): Promise<Record<string, unknown>> {
  mockReceipts.length = 0;
  const route = registered.find((r) => r.method === "POST" && r.path === "/print/bill");
  if (!route) { throw new Error("no route registered for POST /print/bill"); }
  const out: { status: number; body: unknown } = { status: 200, body: undefined };
  let ended = false;
  const res = {
    status(code: number) { out.status = code; return res; },
    json(payload: unknown) { if (!ended) { out.body = payload; ended = true; } return res; },
    send(payload: unknown) { if (!ended) { out.body = payload; ended = true; } return res; },
    setHeader() { return res; },
    end() { ended = true; return res; },
  };
  const req = { params: {}, body: { table_name: "T1" }, query: {}, headers: {}, auth: AUTH };
  for (const h of route.handlers) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (ended || !advanced) { break; }
  }
  if (out.status !== 200) { throw new Error(`/print/bill refused: ${out.status} ${JSON.stringify(out.body)}`); }
  const receipt = mockReceipts[0];
  if (!receipt) { throw new Error("/print/bill rendered no receipt"); }
  return receipt;
}

beforeEach(async () => {
  if (registered.length === 0) {
    process.env.SUPABASE_DIRECT_URL =
      process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
    const bills = await import("../routes/bills");
    bills.registerBillPrintAndEditRoutes(fakeApp as never);
  }
  mockSettings.value = {};
  mockReceipts.length = 0;
  mockFeedbackLookups.n = 0;
});

describe("POST /print/bill honours the bill QR switch", () => {
  test("OFF: the bill carries no QR, and the table's feedback context is not even looked up", async () => {
    mockSettings.value = { bill_show_qr: false };
    const receipt = await printBill();
    expect(receipt.feedbackUrl).toBeNull();
    expect(mockFeedbackLookups.n).toBe(0);
  });

  test("ON: the bill carries the table's feedback QR", async () => {
    mockSettings.value = { bill_show_qr: true };
    const receipt = await printBill();
    expect(typeof receipt.feedbackUrl).toBe("string");
    expect(String(receipt.feedbackUrl)).toContain(`eid=${mockIds.waiter}`);
  });

  test("a settings shape with no switch at all (a tenant from before the column existed) keeps the QR", async () => {
    mockSettings.value = {};
    const receipt = await printBill();
    expect(typeof receipt.feedbackUrl).toBe("string");
  });

  test("the switch does not touch the rest of the bill", async () => {
    mockSettings.value = { bill_show_qr: false };
    const off = await printBill();
    mockSettings.value = { bill_show_qr: true };
    const on = await printBill();
    const { feedbackUrl: _a, ...offRest } = off;
    const { feedbackUrl: _b, ...onRest } = on;
    expect(offRest).toEqual(onRest);
  });
});

describe("the renderer prints no QR block without a URL", () => {
  test("no QR command and no QR sentence when feedbackUrl is null", async () => {
    const { buildReceiptBase64 } = jest.requireActual("../escpos") as typeof import("../escpos");
    const base = {
      restaurantName: "Fixture Diner", table: "T1", covers: 2,
      items: [{ name: "Dal Makhani", price: 500, quantity: 1 }],
      total: 500, grandTotal: 500, currency: "₹", kind: "bill" as const,
    };
    const without = Buffer.from(buildReceiptBase64({ ...base, feedbackUrl: null }), "base64").toString("latin1");
    const withQr = Buffer.from(buildReceiptBase64({ ...base, feedbackUrl: "https://example.test/feedback?rid=x" }), "base64").toString("latin1");
    // GS ( k — the QR command family.
    expect(withQr).toContain("\x1d(k");
    expect(without).not.toContain("\x1d(k");
    expect(without).not.toContain("For calling Valet");
  });
});

describe("the switch is wired end to end", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

  test("POST /restaurant/settings passes an explicit boolean through, and nothing else", () => {
    expect(read("routes/settings.ts")).toContain(
      'bill_show_qr: typeof body.bill_show_qr === "boolean" ? body.bill_show_qr : undefined,',
    );
  });

  test("the data layer reads NULL as ON, writes only an explicit boolean, and returns it", () => {
    const db = read("database_supabase.ts");
    expect(db.match(/bill_show_qr: rows\[0\]\?\.bill_show_qr !== false,/g)?.length).toBe(2);
    expect(db).toContain("bill_show_qr = coalesce($34, bill_show_qr)");
    expect(db).toContain('const billShowQr = typeof opts.bill_show_qr === "boolean" ? opts.bill_show_qr : null;');
    expect(db).toContain('add column if not exists bill_show_qr boolean default true');
  });

  test("the migration that records the column defaults it to true, like the runtime DDL", () => {
    const sql = read("migrations/047_bill_show_qr.sql");
    expect(sql).toMatch(/add column if not exists bill_show_qr boolean default true/i);
  });
});
