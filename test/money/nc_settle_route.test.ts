// POST /bills/order/:orderId/settle-nc — THE ROUTE (routes/nc_settle.ts).
//
// The transaction is pinned in nc_settle_transaction.test.ts. What is pinned
// here is everything around it, driving the REAL handler over a fake Express
// app with only the data layer's far side stubbed:
//
//   * two gates — the comp permission in registration position, then Close
//     Bill — and a waiter, who holds neither, never reaches the data layer;
//   * a partial NC (an amount, tenders, splits) is refused with the sentence;
//   * the actor is the SESSION; a body field cannot name one;
//   * the authoriser is resolved against the comp permission;
//   * the data layer's refusals keep their status and code; a missing
//     migration is a 503 with a plain sentence; a race is a 409;
//   * a replay is 200 `already` with no audit, no emit and no paper;
//   * the audit line is filed under the comp permission with `scope: 'bill'`
//     and the would-have-charged figure — the one place it lives;
//   * the paper is the ORIGINAL (no REPRINT banner), Grand Total 0.00, the
//     settlement block with the kind and the authoriser, the dishes at 0.00;
//     a failed print is a 200 with printed:false; print:false prints nothing.

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyBillEdit } from "../../mis_report_math";

const PERM_NC = "b4e7a1c9-2d58-4f36-9a07-5c81e3b0d472";
const PERM_CLOSE_BILL = "a953d044-31ba-4e31-b96f-99304fe43dfa";
const ORDER = "11111111-1111-4111-8111-111111111111";
const BILL = "44444444-4444-4444-8444-444444444444";

const mockCalls: { fn: string; args: unknown[] }[] = [];
const mockAudit: unknown[][] = [];
const mockReceipts: string[] = [];
const mockNext: {
  settle: (() => Promise<unknown>) | null;
  authoriser: "ok" | "not_found" | "not_permitted";
  dispatchFails: boolean;
  counters: { id: string }[];
} = { settle: null, authoriser: "ok", dispatchFails: false, counters: [] };

jest.mock("pg", () => {
  class FakePool {
    on(): this { return this; }
    query(): Promise<never> { return Promise.reject(new Error("settle-nc route fixture: no query is stubbed")); }
    connect(): Promise<never> { return Promise.reject(new Error("settle-nc route fixture: pool.connect() is not stubbed")); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

jest.mock("../../realtime", () => ({
  __esModule: true,
  emitRestaurant: (...args: unknown[]) => { mockCalls.push({ fn: "emitRestaurant", args }); },
  emitOutlet: jest.fn(),
}));

jest.mock("../../print_routing", () => ({
  __esModule: true,
  dispatchPrintJob: (...args: unknown[]) => {
    mockCalls.push({ fn: "dispatchPrintJob", args });
    const job = args[1] as { esc_base64: string };
    mockReceipts.push(Buffer.from(job.esc_base64, "base64").toString("latin1"));
    if (mockNext.dispatchFails) { return Promise.reject(new Error("printer offline")); }
    return Promise.resolve({ jobId: "job-1", decision: { destinationName: "Bar" }, assignedDeviceId: null });
  },
}));

jest.mock("../../database_supabase", () => {
  const actual = jest.requireActual("../../database_supabase") as Record<string, any>;
  const record = (fn: string, args: unknown[]): void => { mockCalls.push({ fn, args }); };
  return {
    __esModule: true,
    ...actual,
    SettleBillAsNonChargeable: (...args: unknown[]) => {
      record("SettleBillAsNonChargeable", args);
      return mockNext.settle ? mockNext.settle() : Promise.reject(new Error("no settle stubbed"));
    },
    ResolveAuthoriser: (...args: unknown[]) => {
      record("ResolveAuthoriser", args);
      if (mockNext.authoriser === "ok") {
        return Promise.resolve({ ok: true, identity: { employee_id: "emp-2", username: "manager01", display_name: "Manager One" } });
      }
      return Promise.resolve({ ok: false, reason: mockNext.authoriser });
    },
    ListBillingCounters: (...args: unknown[]) => { record("ListBillingCounters", args); return Promise.resolve(mockNext.counters); },
    SetBillCounter: (...args: unknown[]) => { record("SetBillCounter", args); return Promise.resolve(true); },
    GetEmployeeDetailsFromEmpID: () => Promise.resolve({ id: "emp-1", res_id: "res-1", outlet_id: "out-1", username: "cashier1" }),
    AddAuditLogEntry: (...args: unknown[]) => { mockAudit.push(args); return Promise.resolve(); },
    GetRestaurantLogoRaw: () => Promise.resolve(null),
    GetRestaurantSettings: () => Promise.resolve({ currency: "₹", bill_paper_width: "80mm", timezone: "Asia/Kolkata" }),
    GetRestaurantProfile: () => Promise.resolve({ outlet_name: "Gaia", outlet_add: null, outlet_phone: null }),
    GetClosedBill: (...args: unknown[]) => {
      record("GetClosedBill", args);
      return Promise.resolve({
        id: BILL, bill_no: "2002", table_name: "T2", covers: 6, created_at: "2026-09-16T08:00:00.000Z",
        items: [
          { name: "Thali", price: 400, quantity: 3, note: null, line_total: 0, nc: true },
          { name: "Lassi", price: 100, quantity: 2, note: null, line_total: 0, nc: true },
        ],
        items_subtotal: 0, customer: null, customer_gstin: null, created_by: "Cashier One",
        discount_amount: 0, coupon_code: null, service_charge: 0, service_charge_percent: 0,
        taxes: [], grand_total: 0, round_off: 0, nc_total: 1400,
        nc_settlement: { kind: "complimentary", kind_label: "Complimentary", authorised_by: "manager01", marked_by: "cashier1", reason: "x", lines: 2, value: 1400, would_have_charged: null },
      });
    },
  };
});

type Next = (err?: unknown) => void;
type Handler = (req: any, res: any, next: Next) => unknown;
const registered: { method: string; path: string; handlers: Handler[] }[] = [];
const fakeApp = {
  get: (p: string, ...h: Handler[]) => { registered.push({ method: "GET", path: p, handlers: h }); return fakeApp; },
  post: (p: string, ...h: Handler[]) => { registered.push({ method: "POST", path: p, handlers: h }); return fakeApp; },
  put: () => fakeApp, patch: () => fakeApp, delete: () => fakeApp, use: () => fakeApp,
};

const SESSION = {
  res_id: "res-1", outlet_id: "out-1", employeeId: "3f3f3f3f-1111-4111-8111-3f3f3f3f3f3f",
  employeeUsername: "cashier1", role: "manager", actions: [PERM_NC, PERM_CLOSE_BILL],
};
const BODY = { nc_kind: "complimentary", reason: "Owner's family", authorised_by: "manager01", expected_value: 1400 };

async function call(body: Record<string, unknown> = BODY, auth: Record<string, unknown> = SESSION): Promise<{ status: number; body: any }> {
  const route = registered.find((r) => r.method === "POST" && r.path === "/bills/order/:orderId/settle-nc");
  if (!route) { throw new Error("settle-nc is not registered"); }
  const out = { status: 200, body: undefined as any };
  let ended = false;
  const res = {
    status(code: number) { out.status = code; return res; },
    json(payload: unknown) { if (!ended) { out.body = payload; ended = true; } return res; },
    send(payload: unknown) { if (!ended) { out.body = payload; ended = true; } return res; },
    setHeader() { return res; },
    end() { ended = true; return res; },
  };
  const req = { params: { orderId: ORDER }, query: {}, headers: {}, auth, body };
  for (const h of route.handlers) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (ended || !advanced) { break; }
  }
  return out;
}

const settled = (over: Record<string, unknown> = {}) => ({
  success: true, bill_id: BILL, bill_no: "2002", table_id: "t2", table_name: "T2",
  payment_method: "NC", total_amt: 0, nc_value: 1400, nc_lines: 2, would_have_charged: 1624,
  settle_group: "g-1", non_chargeables: [], ...over,
});

const called = (fn: string) => mockCalls.filter((c) => c.fn === fn);

beforeEach(async () => {
  if (registered.length === 0) {
    process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
    const routes = await import("../../routes/nc_settle");
    routes.registerNcSettleRoutes(fakeApp as never);
  }
  mockCalls.length = 0;
  mockAudit.length = 0;
  mockReceipts.length = 0;
  mockNext.settle = () => Promise.resolve(settled());
  mockNext.authoriser = "ok";
  mockNext.dispatchFails = false;
  mockNext.counters = [];
});

describe("the two gates", () => {
  test("the comp permission is in registration position — the manifest shows it", () => {
    const route = registered.find((r) => r.path === "/bills/order/:orderId/settle-nc");
    expect(route?.handlers).toHaveLength(2);
    const src = readFileSync(join(__dirname, "..", "..", "routes", "nc_settle.ts"), "utf8");
    expect(src).toMatch(/app\.post\("\/bills\/order\/:orderId\/settle-nc", validateAction\(PERM_NON_CHARGEABLE\), async/);
  });

  test("a waiter (neither permission) is refused and nothing is called", async () => {
    const answer = await call(BODY, { ...SESSION, role: "waiter", actions: ["4ad474d4-5230-449c-874f-6a238b833bca"] });
    expect(answer.status).toBe(403);
    expect(answer.body.requiredPermission).toBe(PERM_NC);
    expect(mockCalls).toEqual([]);
  });

  test("a cashier (Close Bill, no comp permission) is refused", async () => {
    const answer = await call(BODY, { ...SESSION, role: "cashier", actions: [PERM_CLOSE_BILL] });
    expect(answer.status).toBe(403);
    expect(answer.body.requiredPermission).toBe(PERM_NC);
    expect(called("SettleBillAsNonChargeable")).toEqual([]);
  });

  test("the comp permission alone (no Close Bill) is refused by the settle gate, naming Close Bill", async () => {
    const answer = await call(BODY, { ...SESSION, actions: [PERM_NC] });
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ requiredPermission: PERM_CLOSE_BILL });
    expect(answer.body.details).toMatch(/Close Bill/);
    expect(called("SettleBillAsNonChargeable")).toEqual([]);
  });

  test("an admin passes both", async () => {
    expect((await call(BODY, { ...SESSION, role: "admin", actions: ["*"] })).status).toBe(200);
  });
});

describe("the request", () => {
  test("a partial NC is refused with the sentence both clients show", async () => {
    for (const extra of [{ amount: 400 }, { tenders: [{ method: "Cash", amount: 100 }] }, { splits: [] }]) {
      const answer = await call({ ...BODY, ...extra });
      expect(answer.status).toBe(400);
      expect(answer.body).toEqual({
        error: "Settle as NC covers the whole bill. To give part of it away, comp dishes individually, then take the rest.",
        whole_bill_only: true,
      });
    }
    expect(called("SettleBillAsNonChargeable")).toEqual([]);
  });

  test("kind, reason and authoriser are required; the reason stays required", async () => {
    for (const body of [
      { ...BODY, nc_kind: "birthday" },
      { ...BODY, reason: "" },
      { ...BODY, reason: "   " },
      { nc_kind: "complimentary", authorised_by: "manager01" },
      { ...BODY, authorised_by: "" },
      { ...BODY, reason: "x".repeat(401) },
      { ...BODY, expected_value: -1 },
    ]) {
      const answer = await call(body);
      expect(answer.status).toBe(400);
      expect(answer.body.error).toBe("Invalid request body.");
    }
    expect(called("SettleBillAsNonChargeable")).toEqual([]);
  });

  test("an unknown till is refused before anything moves", async () => {
    const answer = await call({ ...BODY, counter_id: "till-9" });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toMatch(/No billing counter with id till-9/);
    expect(called("SettleBillAsNonChargeable")).toEqual([]);
  });

  test("the authoriser is resolved against the COMP permission: unknown 400, not permitted 403", async () => {
    mockNext.authoriser = "not_found";
    expect((await call()).status).toBe(400);
    mockNext.authoriser = "not_permitted";
    const answer = await call();
    expect(answer.status).toBe(403);
    expect(answer.body.error).toBe("'manager01' is not permitted to authorise a non-chargeable bill.");
    expect(called("ResolveAuthoriser")[0]?.args[2]).toBe(PERM_NC);
    expect(called("SettleBillAsNonChargeable")).toEqual([]);
  });

  test("the actor is the SESSION; body fields that try to name one are ignored", async () => {
    await call({ ...BODY, marked_by: "manager01", username: "owner", actor: { username: "owner" } });
    const input = called("SettleBillAsNonChargeable")[0]?.args[1] as Record<string, any>;
    expect(input).toMatchObject({
      order_id: ORDER, nc_kind: "complimentary", reason: "Owner's family", expected_value: 1400,
      actor: { username: "cashier1", employee_id: SESSION.employeeId, authorised_by_username: "manager01", authorised_by_employee_id: "emp-2" },
    });
  });
});

describe("the answers", () => {
  test("the data layer's refusals keep their status, sentence and code", async () => {
    const db = await import("../../database_supabase");
    mockNext.settle = () => Promise.reject(new db.BillNonChargeableRefusedError({ status: 409, code: "tenders_recorded", error: "₹200.00 is already recorded as paid on this bill." }));
    expect(await call()).toEqual({ status: 409, body: { error: "₹200.00 is already recorded as paid on this bill.", code: "tenders_recorded" } });
    mockNext.settle = () => Promise.reject(new db.BillNonChargeableRefusedError({ status: 400, code: "quote_moved", error: "The bill changed." }));
    expect((await call()).status).toBe(400);
    expect(called("dispatchPrintJob")).toEqual([]);
    expect(mockAudit).toEqual([]);
  });

  test("migration 052 missing: 503 and a sentence a person at a till can read", async () => {
    const db = await import("../../database_supabase");
    mockNext.settle = () => Promise.reject(new db.BillNonChargeableSchemaMissingError());
    const answer = await call();
    expect(answer.status).toBe(503);
    expect(answer.body.error).toBe("Settling a bill as non-chargeable is not available yet on this server — an administrator has to finish an update (migration 052). Comp the dishes individually in the meantime.");
  });

  test("a race on a line (23505) is a 409; anything else is a 400 with the message", async () => {
    mockNext.settle = () => Promise.reject(Object.assign(new Error("duplicate key"), { code: "23505" }));
    expect((await call()).status).toBe(409);
    mockNext.settle = () => Promise.reject(new Error("This order's bill is already settled and locked — its status can no longer be changed."));
    expect(await call()).toEqual({ status: 400, body: { error: "This order's bill is already settled and locked — its status can no longer be changed." } });
  });

  test("a replay is 200 `already`: no audit, no emit, no paper", async () => {
    mockNext.settle = () => Promise.resolve(settled({ already: true, would_have_charged: 0 }));
    const answer = await call();
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ already: true, printed: false, bill_id: BILL });
    expect(mockAudit).toEqual([]);
    expect(called("emitRestaurant")).toEqual([]);
    expect(called("dispatchPrintJob")).toEqual([]);
  });
});

describe("a settled NC bill: the record and the paper", () => {
  test("the audit line: the comp permission's id, scope 'bill', and the would-have-charged figure", async () => {
    const answer = await call({ ...BODY, counter_id: "till-1" }).catch(() => null);
    expect(answer?.status).toBe(400); // till-1 is not configured
    mockNext.counters = [{ id: "till-1" }];
    await call({ ...BODY, counter_id: "till-1" });
    expect(mockAudit).toHaveLength(1);
    const [, , , action, sentence, , details] = mockAudit[0] as [unknown, unknown, unknown, string, string, unknown, Record<string, unknown>];
    expect(action).toBe(PERM_NC);
    expect(sentence).toBe("Settled bill 2002 (table T2) as non-chargeable (2 line(s), ₹1400.00 given away before tax) — authorised by manager01");
    expect(details).toMatchObject({
      scope: "bill", bill_id: BILL, bill_no: "2002", order_id: ORDER, table: "T2", settle_group: "g-1",
      nc_kind: "complimentary", reason: "Owner's family", authorised_by: "manager01",
      nc_value: 1400, nc_lines: 2, would_have_charged: 1624, counter_id: "till-1",
    });
    // The Bill Edit report reads that line as the bill NC it is.
    expect(classifyBillEdit(action, sentence, details)?.kind).toBe("bill_non_chargeable");
    expect(called("SetBillCounter")[0]?.args).toEqual(["res-1", BILL, "till-1"]);
  });

  test("the floor is told: the bill closed, the table's bill changed, the order changed", async () => {
    await call();
    expect(called("emitRestaurant").map((c) => c.args[1])).toEqual(["bill:closed", "bill:updated", "order:updated"]);
    expect(called("emitRestaurant")[1]?.args[2]).toEqual({ table: "T2" });
  });

  test("the paper is the ORIGINAL: 0.00, the dishes marked NC, the settlement and who authorised it", async () => {
    const answer = await call();
    expect(answer.body).toMatchObject({ success: true, printed: true, payment_method: "NC", total_amt: 0, would_have_charged: 1624 });
    expect(answer.body.print_error).toBeUndefined();
    expect(called("GetClosedBill")[0]?.args[1]).toBe(BILL);
    const job = called("dispatchPrintJob")[0]?.args[1] as Record<string, unknown>;
    expect(job).toMatchObject({ outlet_id: "out-1", bill_id: BILL, kind: "bill", station: null });
    const paper = mockReceipts[0] ?? "";
    expect(paper).not.toContain("REPRINT");
    expect(paper).toMatch(/Thali \(NC\)\s+3\s+400\.00\s+0\.00/);
    expect(paper).toMatch(/Grand Total\s+Rs 0\.00/);
    expect(paper).toMatch(/NC value \(not charged\)\s+1400\.00/);
    expect(paper).toContain("Settled: Non-chargeable - Complimentary");
    expect(paper).toContain("Authorised by: manager01");
    // The figure the settle knew first-hand; the stored settlement had none.
    expect(paper).toMatch(/Would have been \(incl\. tax\)\s+1624\.00/);
    // An NC bill carries no feedback QR and no service-charge sentence.
    expect(paper).not.toContain("Voluntary Service Charge");
  });

  test("a failed print is still a 200 — the bill IS closed — with printed:false and the reason", async () => {
    mockNext.dispatchFails = true;
    const answer = await call();
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ success: true, printed: false, print_error: "printer offline", bill_id: BILL });
    expect(mockAudit).toHaveLength(1);
  });

  test("print:false prints nothing", async () => {
    const answer = await call({ ...BODY, print: false });
    expect(answer.body).toMatchObject({ success: true, printed: false });
    expect(called("dispatchPrintJob")).toEqual([]);
    expect(called("GetClosedBill")).toEqual([]);
  });
});

describe("the settled reprint reads the settlement back off the bill (POST /print/bill/settled passes no override)", () => {
  const settings = { currency: "₹", bill_paper_width: "80mm", timezone: "Asia/Kolkata" } as never;
  const profile = { outlet_name: "Gaia", outlet_add: null, outlet_phone: null } as never;
  const reprint = async (patch: Record<string, unknown>, override?: { settlement: null }): Promise<string> => {
    const { settledBillReceiptOptions } = await import("../../routes/bills");
    const { buildReceiptBase64 } = await import("../../escpos");
    const db = await import("../../database_supabase");
    const bill = { ...(await db.GetClosedBill("res-1", BILL))!, ...patch };
    const options = settledBillReceiptOptions(bill, { settings, profile, logo: null, reprint: true, ...(override ?? {}) });
    return Buffer.from(buildReceiptBase64(options, 48), "base64").toString("latin1");
  };
  const settlement = {
    kind: "complimentary", kind_label: "Complimentary", authorised_by: "manager01", marked_by: "cashier1",
    reason: "Owner's family", lines: 2, value: 1400, would_have_charged: 1624,
  };

  test("an NC bill's reprint: the REPRINT banner, the dishes at 0.00, the settlement and who authorised it", async () => {
    const paper = await reprint({ nc_settlement: settlement });
    expect(paper).toContain("REPRINT");
    expect(paper).toMatch(/Thali \(NC\)\s+3\s+400\.00\s+0\.00/);
    expect(paper).toMatch(/Lassi \(NC\)\s+2\s+100\.00\s+0\.00/);
    expect(paper).toMatch(/Grand Total\s+Rs 0\.00/);
    expect(paper).toMatch(/NC value \(not charged\)\s+1400\.00/);
    expect(paper).toContain("Settled: Non-chargeable - Complimentary");
    expect(paper).toContain("Authorised by: manager01");
    expect(paper).toMatch(/Would have been \(incl\. tax\)\s+1624\.00/);
  });

  test("an unknown would-have figure prints no line; a bill with no settlement prints no block", async () => {
    const unknown = await reprint({ nc_settlement: { ...settlement, would_have_charged: null } });
    expect(unknown).toContain("Settled: Non-chargeable - Complimentary");
    expect(unknown).not.toContain("Would have been");
    const paid = await reprint({ payment_method: "Cash", nc_settlement: null });
    expect(paid).not.toContain("Settled: Non-chargeable");
    expect(paid).not.toContain("Authorised by:");
    // The comped lines still print as comps.
    expect(paid).toMatch(/Thali \(NC\)\s+3\s+400\.00\s+0\.00/);
  });

  test("an explicit override wins over the bill's own settlement", async () => {
    const paper = await reprint({ nc_settlement: settlement }, { settlement: null });
    expect(paper).not.toContain("Settled: Non-chargeable");
  });
});
