// "REMOVE SERVICE CHARGE & PRINT" — THE WAIVER AND THE PAPER AS ONE ACT.
//
// The client: "reprint without service charge and waive service charge should
// be merged as one option instead of being 2 separate steps." POST
// /bills/service-charge-waiver/print is that option, and it sits exactly on the
// seam this money suite exists for: it WRITES a reduction to what the guest owes
// and then PRINTS it. Everything that can go wrong goes wrong in money:
//
//   * THE PAPER DISAGREES WITH THE DRAWER. The print must be the one /print/bill
//     makes, from the state AFTER the waiver committed, through the resolver the
//     settle paths use. So this drives the REAL route over the REAL
//     printOpenTableBill, the REAL GetBillChargeConfigForTable and the REAL
//     computeBillCharges — in every charge shape the fleet runs — and compares
//     the grand total handed to the renderer with the drawer's.
//   * A REFUSAL AFTER THE MONEY MOVED. C3's reprint rule, an empty table, a bill
//     with no charge and a missing permission must all answer BEFORE the waiver
//     is written; a refused print on top of a recorded waiver leaves the guest
//     holding the old, higher paper while the till has already dropped.
//   * THE WAIVER COUNTED TWICE. A reprint of a bill that already carries a
//     waiver, and a lost race to another device, must write no second row and
//     no second audit line — the Service Charge Deny report sums those rows.
//   * A COMMITTED WAIVER HIDDEN BY A 5xx. When the printer path fails after the
//     commit, the answer is a 200 that says so.
//   * TWO AUDIT LINES FOR ONE FACT. The waiver line must be byte-identical to
//     the one POST /bills/service-charge-waiver files, because the Bill Edit
//     report classifies on it.
//
// Same harness as paper_equals_drawer.test.ts: a fixture `pg` that THROWS on any
// query it does not recognise, and stubs only for the reads either side of the
// code under test. WaiveServiceCharge is stubbed (its transaction is pinned in
// the data-layer suites); what it does to the database — make a live waiver row
// visible to the resolver — is modelled by setting that row, and the quote it
// records is the REAL quoteServiceChargeWaiver.

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quoteServiceChargeWaiver } from "../../billing_math";
import { classifyBillEdit } from "../../mis_report_math";

const mockIds = {
  res: "11111111-1111-4111-8111-111111111111",
  outlet: "22222222-2222-4222-8222-222222222222",
  table: "33333333-3333-4333-8333-333333333333",
  bill: "44444444-4444-4444-8444-444444444444",
};

const mockDb: {
  taxConfig: Record<string, number> | null;
  scPct: number;
  /** A LIVE "ServiceChargeWaivers" row for the open bill, or none. */
  waiver: Record<string, unknown> | null;
  subtotal: number;
  items: number;
  printCount: number;
  /** The open bill's row and invoice number — null until something mints them. */
  billId: string | null;
  billNo: string | null;
} = { taxConfig: null, scPct: 0, waiver: null, subtotal: 0, items: 1, printCount: 0, billId: null, billNo: null };

/** Every AddAuditLogEntry(res, outlet, emp, action, description, category, details). */
const mockAudit: unknown[][] = [];
/** Every ReceiptOptions handed to the ESC/POS renderer. THIS IS THE PAPER. */
const mockReceipts: Record<string, unknown>[] = [];
const mockCalls: { fn: string; args: unknown[] }[] = [];
const mockNext: {
  waive: ((...a: unknown[]) => Promise<unknown>) | null;
  dispatchFails: boolean;
  /** What ResolveAuthoriser answers for the named authoriser. */
  authoriser: "ok" | "not_found" | "not_permitted";
  /** Every audit write rejects (the database refusing the insert). */
  auditFails: boolean;
} = { waive: null, dispatchFails: false, authoriser: "ok", auditFails: false };

jest.mock("pg", () => {
  const answer = (sql: string): unknown[] => {
    const q = String(sql);
    if (q.includes('select default_tax from "Outlets"')) { return [{ default_tax: mockDb.taxConfig }]; }
    if (q.includes('select service_charge from "Restaurant"')) { return [{ service_charge: mockDb.scPct }]; }
    if (q.includes('from "Restaurant" r')) {
      return [{
        res_id: mockIds.res, outlet_id: mockIds.outlet,
        restaurant_slug: "fixture", restaurant_name: "Fixture Diner",
        restaurant_main_office_add: null, restaurant_logo_url: null, timezone: "Asia/Kolkata",
      }];
    }
    if (q.includes('from "Tables"')) { return [{ id: mockIds.table }]; }
    if (q.includes('from "Bills"')) { return [{ id: mockIds.bill }]; }
    if (q.includes('from "ServiceChargeWaivers"')) { return mockDb.waiver ? [mockDb.waiver] : []; }
    throw new Error(`remove_service_charge_and_print fixture: no answer for: ${q.replace(/\s+/g, " ").trim().slice(0, 140)}`);
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string): Promise<{ rows: unknown[] }> { return Promise.resolve({ rows: answer(sql) }); }
    connect(): Promise<never> { return Promise.reject(new Error("fixture: pool.connect() is not stubbed")); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

jest.mock("../../realtime", () => ({
  __esModule: true,
  // Recorded in call order with everything else, so "after the commit" is checkable.
  emitRestaurant: (...args: unknown[]) => { mockCalls.push({ fn: "emitRestaurant", args }); },
  emitOutlet: jest.fn(),
}));

jest.mock("../../database_supabase", () => {
  const actual = jest.requireActual("../../database_supabase") as Record<string, any>;
  const record = (fn: string, args: unknown[]): void => { mockCalls.push({ fn, args }); };
  return {
    __esModule: true,
    ...actual,
    // GetBillChargeConfigForTable and computeBillCharges are NOT overridden.
    // The bill view prices itself through them too, exactly as GetBillForTable
    // does, so the web's `printable_bill` is the drawer's by construction here
    // as it is in production.
    GetBillForTable: async (...args: unknown[]) => {
      record("GetBillForTable", args);
      if (mockDb.items === 0) { return null; }
      const cfg = await actual.GetBillChargeConfigForTable(mockIds.res, "T1");
      const charges = actual.computeBillCharges(mockDb.subtotal, cfg.taxConfig, cfg.scPct, cfg.includeServiceCharge);
      return {
        bill_id: mockDb.billId, table_id: mockIds.table,
        total_amt: mockDb.subtotal, subtotal: mockDb.subtotal,
        discount: 0, discount_type: null, discount_value: 0,
        service_charge: charges.service_charge, service_charge_percent: charges.service_charge_percent,
        service_charge_waived: cfg.waiver !== null, service_charge_waiver: cfg.waiver,
        service_charge_basis: cfg.basis, service_charge_applied: cfg.service_charge_applied,
        taxes: charges.taxes, tax_total: charges.tax_total, round_off: charges.round_off, grand_total: charges.grand_total,
        items: [{ name: "Dal Makhani", price: mockDb.subtotal, quantity: 1 }],
        covers: 2, customer: null, customer_gstin: null, bill_no: mockDb.billNo, coupon_code: null,
        order_notes: [] as string[], order_ids: [], kot_nos: [],
        print_count: mockDb.printCount,
        bill_printed_at: mockDb.printCount > 0 ? "2026-09-15T10:00:00.000Z" : null,
        printed_at: mockDb.printCount > 0 ? "2026-09-15T10:00:00.000Z" : null,
      };
    },
    GetRestaurantSettings: () => Promise.resolve({ currency: "₹", bill_paper_width: "80mm", timezone: "Asia/Kolkata" }),
    GetRestaurantProfile: () => Promise.resolve({ outlet_name: "Fixture Diner", outlet_add: null, outlet_phone: null }),
    GetTableFeedbackContext: () => Promise.resolve(null),
    GetRestaurantLogoRaw: () => Promise.resolve(null),
    GetEmployeeDetailsFromEmpID: () => Promise.resolve({
      id: "emp-1", res_id: mockIds.res, outlet_id: mockIds.outlet, username: "cashier1", emp_Fname: "Cashier", emp_Lname: "One",
    }),
    AddAuditLogEntry: (...args: unknown[]) => {
      if (mockNext.auditFails) { return Promise.reject(new Error("fixture: Audit_logs insert refused")); }
      mockAudit.push(args);
      return Promise.resolve(undefined);
    },
    ResolveAuthoriser: (...args: unknown[]) => {
      record("ResolveAuthoriser", args);
      if (mockNext.authoriser !== "ok") { return Promise.resolve({ ok: false, reason: mockNext.authoriser }); }
      return Promise.resolve({ ok: true, identity: { employee_id: "emp-2", username: "manager01", display_name: "Manager One" } });
    },
    WaiveServiceCharge: (...args: unknown[]) => {
      record("WaiveServiceCharge", args);
      if (!mockNext.waive) { return Promise.reject(new Error("fixture: WaiveServiceCharge was not expected")); }
      return mockNext.waive(...args);
    },
    RecordClientRenderedBillPrint: (...args: unknown[]) => {
      record("RecordClientRenderedBillPrint", args);
      return Promise.resolve({ id: "claim-1", created_at: "2026-09-15T11:00:00.000Z" });
    },
  };
});

jest.mock("../../escpos", () => {
  const actual = jest.requireActual("../../escpos") as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    buildReceiptBase64: (opts: Record<string, unknown>) => { mockReceipts.push(opts); return "RVND"; },
  };
});

jest.mock("../../print_routing", () => ({
  __esModule: true,
  dispatchPrintJob: (...args: unknown[]) => {
    mockCalls.push({ fn: "dispatchPrintJob", args });
    if (mockNext.dispatchFails) { return Promise.reject(new Error("printer routing table unreadable")); }
    return Promise.resolve({ jobId: "job-1", decision: { destinationName: "Counter" }, assignedDeviceId: null });
  },
}));

// --- the fake Express app ------------------------------------------------------

type Next = (err?: unknown) => void;
type Handler = (req: any, res: any, next: Next) => unknown;
interface Registered { method: string; path: string; handlers: Handler[] }
interface Answer { status: number; body: any }

const registered: Registered[] = [];
const recordRoute = (method: string) => (path: string, ...handlers: Handler[]): unknown => {
  registered.push({ method, path, handlers });
  return fakeApp;
};
const fakeApp = {
  get: recordRoute("GET"), post: recordRoute("POST"), put: recordRoute("PUT"),
  patch: recordRoute("PATCH"), delete: recordRoute("DELETE"), use: (): unknown => fakeApp,
};

const ADD_ORDERS = "4ad474d4-5230-449c-874f-6a238b833bca";
const WAIVE = "d5a06e73-9c41-4b28-8f6a-1b74d3e08c95";

const identity = (role: string, actions: string[]) => ({
  res_id: mockIds.res, outlet_id: mockIds.outlet, employeeId: "3f3f3f3f-1111-4111-8111-3f3f3f3f3f3f",
  employeeUsername: "cashier1", role, role_all: [role], actions,
});
const ADMIN = identity("admin", ["*"]);
const MANAGER = identity("manager", [ADD_ORDERS, WAIVE]);
const CASHIER = identity("cashier", [ADD_ORDERS]);
/** A waiter the tenant HAS granted the waiver — C3 still holds them to one print. */
const GRANTED_WAITER = identity("waiter", [ADD_ORDERS, WAIVE]);
/** A session minted before the username was carried: it cannot sign a waiver. */
const UNSIGNED_MANAGER = { ...MANAGER, employeeUsername: undefined };

const ROUTE = "/bills/service-charge-waiver/print";
const WAIVER_FORM = { waiver_kind: "guest_request", reason: "Guest asked", authorised_by: "manager01" };

async function call(path: string, body: unknown, auth: unknown = ADMIN): Promise<Answer> {
  const route = registered.find((r) => r.method === "POST" && r.path === path);
  if (!route) { throw new Error(`no route registered for POST ${path}`); }
  const out: Answer = { status: 200, body: undefined };
  let ended = false;
  const res = {
    status(code: number) { out.status = code; return res; },
    json(payload: unknown) { if (!ended) { out.body = payload; ended = true; } return res; },
    send(payload: unknown) { if (!ended) { out.body = payload; ended = true; } return res; },
    setHeader() { return res; },
    end() { ended = true; return res; },
  };
  const req = { params: {}, body: body ?? {}, query: {}, headers: {}, auth };
  for (const h of route.handlers) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (ended || !advanced) { break; }
  }
  return out;
}

/** The drawer — the four-argument call the settle paths make off the same resolver. */
async function drawer(): Promise<{ grand_total: number; round_off: number; pre_round_total: number }> {
  const db = await import("../../database_supabase");
  const cfg = await db.GetBillChargeConfigForTable(mockIds.res, "T1");
  return db.computeBillCharges(mockDb.subtotal, cfg.taxConfig, cfg.scPct, cfg.includeServiceCharge);
}

/** A live waiver row as liveServiceChargeWaiver reads it back. */
function waiverRow(id: string, quote?: ReturnType<typeof quoteServiceChargeWaiver>): Record<string, unknown> {
  return {
    id, created_at: new Date("2026-09-15T10:30:00Z"),
    outlet_id: mockIds.outlet, bill_id: mockIds.bill, table_id: mockIds.table,
    waived_at: new Date("2026-09-15T10:30:00Z"),
    basis: quote?.basis ?? "tax_line", basis_percent: quote?.basis_percent ?? 10, basis_amount: quote?.basis_amount ?? 0,
    amount_waived: quote?.amount_waived ?? 0, tax_on_waived: quote?.tax_on_waived ?? 0,
    grand_total_reduction: quote?.grand_total_reduction ?? 0,
    waiver_kind: "guest_request", reason: "Guest asked",
    waived_by_username: "cashier1", authorised_by_username: "manager01",
    reversed_at: null, reversed_by_username: null, reversal_reason: null,
  };
}

/**
 * WaiveServiceCharge as the data layer behaves: price the waiver with the REAL
 * quote, COMMIT it (the row becomes visible to every later read), and return
 * the record and the two payable totals.
 */
function commitsAWaiver(): (...a: unknown[]) => Promise<unknown> {
  return async () => {
    const quote = quoteServiceChargeWaiver(mockDb.subtotal, mockDb.taxConfig, mockDb.scPct);
    // ensureOpenBillIdForTable: a table with no "Bills" row gets one, and with
    // it an invoice number, inside the waiver's transaction.
    if (mockDb.billId === null) {
      mockDb.billId = mockIds.bill;
      mockDb.billNo = "B-42";
    }
    mockDb.waiver = waiverRow("w-new", quote);
    return {
      record: {
        id: "w-new", bill_id: mockIds.bill, table_id: mockIds.table, waiver_kind: "guest_request", reason: "Guest asked",
        basis: quote.basis, basis_percent: quote.basis_percent, basis_amount: quote.basis_amount,
        amount_waived: quote.amount_waived, tax_on_waived: quote.tax_on_waived,
        grand_total_reduction: quote.grand_total_reduction,
        waived_by_username: "cashier1", authorised_by_username: "manager01",
      },
      grand_total_before: quote.grand_total_with,
      grand_total_after: quote.grand_total_without,
    };
  };
}

const called = (fn: string): number => mockCalls.filter((c) => c.fn === fn).length;
const auditsUnder = (actionId: string): unknown[][] => mockAudit.filter((a) => a[3] === actionId);
/** Index into mockCalls of each "bill:updated" announcement, with its payload. */
const billAnnouncements = (): { at: number; payload: unknown }[] =>
  mockCalls.flatMap((c, at) => (c.fn === "emitRestaurant" && c.args[1] === "bill:updated" ? [{ at, payload: c.args[2] }] : []));
const nothingWritten = (): void => {
  expect(called("WaiveServiceCharge")).toBe(0);
  expect(called("dispatchPrintJob")).toBe(0);
  expect(called("RecordClientRenderedBillPrint")).toBe(0);
  expect(mockReceipts).toHaveLength(0);
  expect(auditsUnder(WAIVE)).toHaveLength(0);
  expect(billAnnouncements()).toHaveLength(0);
};

beforeEach(async () => {
  if (registered.length === 0) {
    process.env.SUPABASE_DIRECT_URL =
      process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
    const capture = await import("../../routes/mis_capture");
    capture.registerMisCaptureRoutes(fakeApp as never);
  }
  mockDb.taxConfig = { SGST: 2.5, CGST: 2.5, "Service Charge": 10 };
  mockDb.scPct = 0;
  mockDb.waiver = null;
  mockDb.subtotal = 5499;
  mockDb.items = 1;
  mockDb.printCount = 0;
  mockDb.billId = mockIds.bill;
  mockDb.billNo = "B-1";
  mockAudit.length = 0;
  mockReceipts.length = 0;
  mockCalls.length = 0;
  mockNext.waive = commitsAWaiver();
  mockNext.dispatchFails = false;
  mockNext.authoriser = "ok";
  mockNext.auditFails = false;
});

// ============================================================================
// THE PAPER IS THE DRAWER, AFTER THE WAIVER, IN EVERY SHAPE
// ============================================================================

const SHAPES: { name: string; taxConfig: Record<string, number>; scPct: number }[] = [
  { name: "restaurant_percent (GST rides on the charge)", taxConfig: { SGST: 2.5, CGST: 2.5 }, scPct: 10 },
  { name: "tax_line (the charge IS a tax line)", taxConfig: { SGST: 2.5, CGST: 2.5, "Service Charge": 10 }, scPct: 0 },
  { name: "both shapes at once", taxConfig: { SGST: 2.5, CGST: 2.5, "Service Charge": 10 }, scPct: 10 },
];

describe("one request records the waiver and prints the bill without the charge — paper == drawer", () => {
  for (const shape of SHAPES) {
    test.each([333.33, 1234.56, 5499, 87654.32])(`${shape.name}: subtotal %p`, async (subtotal) => {
      mockDb.taxConfig = shape.taxConfig;
      mockDb.scPct = shape.scPct;
      mockDb.subtotal = subtotal;
      const withCharge = await drawer();

      const answer = await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, MANAGER);

      expect(answer.status).toBe(200);
      expect(called("WaiveServiceCharge")).toBe(1);
      expect(mockReceipts).toHaveLength(1);
      const after = await drawer();
      // THE INVARIANT: the paper's total and rungs are the till's.
      expect(Number(mockReceipts[0]!.grandTotal)).toBe(after.grand_total);
      expect(Number(mockReceipts[0]!.roundOff ?? 0)).toBe(after.round_off);
      // ...and the reduction is REAL, not merely consistent.
      expect(after.pre_round_total).toBeLessThan(withCharge.pre_round_total);
      expect(mockReceipts[0]!.serviceCharge).toBeNull();
      expect(mockReceipts[0]!.serviceChargeNote).toBeNull();
      // The reply says what the guest now pays — the paper's own figure.
      expect(answer.body).toMatchObject({
        success: true, printed: true, waiver_created: true, service_charge_removed: true, render: "thermal",
        grand_total_after: after.grand_total, billId: mockIds.bill, jobId: "job-1",
      });
      expect(answer.body.grand_total_before).toBe(
        quoteServiceChargeWaiver(subtotal, shape.taxConfig, shape.scPct).grand_total_with,
      );
    });
  }

  test("the client's own bill: 5499 on the seeded tax shape prints 5774.00, not 6324.00", async () => {
    const answer = await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, MANAGER);
    expect(Number(mockReceipts[0]!.grandTotal)).toBe(5774);
    expect(answer.body.grand_total_before).toBe(6324);
    expect(answer.body.grand_total_after).toBe(5774);
  });

  test("the print is the WAIVER'S: the print audit line names it, under the print's own action", async () => {
    await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, MANAGER);
    const prints = auditsUnder(ADD_ORDERS);
    expect(prints).toHaveLength(1);
    expect(String(prints[0]![4])).toBe("Printed bill for table T1 (no service charge — waiver by manager01)");
    expect(prints[0]![6]).toMatchObject({ kind: "bill", service_charge_removed: true, service_charge_waiver_required: false, service_charge_waiver_id: "w-new" });
  });
});

// ============================================================================
// ONE FACT, ONE ROW, ONE LINE
// ============================================================================

describe("the waiver is written once, and described the way the waiver route describes it", () => {
  test("the waiver audit line is byte-identical to POST /bills/service-charge-waiver's", async () => {
    await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, MANAGER);
    const composite = auditsUnder(WAIVE);
    expect(composite).toHaveLength(1);

    mockAudit.length = 0;
    mockDb.waiver = null;
    const plain = await call("/bills/service-charge-waiver", { table_name: "T1", ...WAIVER_FORM }, MANAGER);
    expect(plain.status).toBe(201);
    const original = auditsUnder(WAIVE);
    expect(original).toHaveLength(1);

    // action id, sentence, category and every structured detail the Bill Edit
    // and Service Charge Deny reports read.
    expect(composite[0]!.slice(3)).toEqual(original[0]!.slice(3));
    // The tax-line shape: the charge is itself the tax line, so charge == charge + tax.
    expect(String(composite[0]![4])).toContain("Waived the service charge (₹549.90; ₹549.90 with its tax, before round-off; grand total ₹6324.00 → ₹5774.00) on bill");
  });

  test("the waiver is the unchanged WaiveServiceCharge, signed by the session and the resolved authoriser", async () => {
    await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, MANAGER);
    const [resId, input] = mockCalls.find((c) => c.fn === "WaiveServiceCharge")!.args as [string, Record<string, any>];
    expect(resId).toBe(mockIds.res);
    expect(input).toMatchObject({
      table_name: "T1", waiver_kind: "guest_request", reason: "Guest asked",
      actor: { username: "cashier1", authorised_by_username: "manager01", authorised_by_employee_id: "emp-2" },
    });
  });

  test("a bill that ALREADY carries a waiver is reprinted: no second row, no second waiver line, no form, no waive permission", async () => {
    mockDb.waiver = waiverRow("w-live", quoteServiceChargeWaiver(5499, mockDb.taxConfig, 0));
    // A cashier: may print, may NOT waive. No kind, no reason, no authoriser.
    const answer = await call(ROUTE, { table_name: "T1" }, CASHIER);
    expect(answer.status).toBe(200);
    expect(called("WaiveServiceCharge")).toBe(0);
    expect(called("ResolveAuthoriser")).toBe(0);
    expect(auditsUnder(WAIVE)).toHaveLength(0);
    expect(auditsUnder(ADD_ORDERS)).toHaveLength(1);
    expect(Number(mockReceipts[0]!.grandTotal)).toBe((await drawer()).grand_total);
    expect(answer.body).toMatchObject({
      printed: true, waiver_created: false, grand_total_before: null, grand_total_after: 5774,
      waiver: { id: "w-live" },
    });
  });

  test("a lost race (23505 — another device waived first) prints THAT waiver and records nothing", async () => {
    mockNext.waive = async () => {
      mockDb.waiver = waiverRow("w-other-device", quoteServiceChargeWaiver(5499, mockDb.taxConfig, 0));
      throw Object.assign(new Error("duplicate key value violates unique constraint \"scwaivers_live_bill_uidx\""), { code: "23505" });
    };
    const answer = await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, MANAGER);
    expect(answer.status).toBe(200);
    expect(auditsUnder(WAIVE)).toHaveLength(0);
    expect(mockReceipts).toHaveLength(1);
    expect(Number(mockReceipts[0]!.grandTotal)).toBe(5774);
    expect(answer.body).toMatchObject({ printed: true, waiver_created: false, waiver: { id: "w-other-device" } });
  });

  test("any OTHER waiver failure is the waiver route's 400, and nothing prints", async () => {
    mockNext.waive = () => Promise.reject(new Error("This bill is already settled — a service charge cannot be waived on it. Refund it instead."));
    const answer = await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, MANAGER);
    expect(answer.status).toBe(400);
    expect(answer.body.error).toContain("already settled");
    expect(mockReceipts).toHaveLength(0);
    expect(called("dispatchPrintJob")).toBe(0);
  });
});

// ============================================================================
// EVERY REFUSAL COMES BEFORE THE MONEY MOVES
// ============================================================================

describe("refusals are answered before any waiver is written", () => {
  test("no waive permission -> 403 naming it; nothing inserted, nothing printed", async () => {
    const answer = await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, CASHIER);
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ waiver_required: true, requiredPermission: WAIVE });
    expect(String(answer.body.details)).toContain("Waive Service Charge");
    nothingWritten();
    expect(called("ResolveAuthoriser")).toBe(0);
  });

  test("a waiter's SECOND print -> C3's 403, before the waiver — even with the waiver granted", async () => {
    mockDb.printCount = 1;
    const answer = await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, GRANTED_WAITER);
    expect(answer.status).toBe(403);
    expect(answer.body.reprint_needs_senior).toBe(true);
    nothingWritten();
    expect(called("ResolveAuthoriser")).toBe(0);
  });

  test("the same waiter's FIRST print goes through, and it is their one print", async () => {
    const answer = await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, GRANTED_WAITER);
    expect(answer.status).toBe(200);
    expect(answer.body.printed).toBe(true);
  });

  test("a bill with no service charge -> 400 nothing_to_remove, and NO ordinary print instead", async () => {
    mockDb.taxConfig = { SGST: 2.5, CGST: 2.5 };
    mockDb.scPct = 0;
    const answer = await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, MANAGER);
    expect(answer.status).toBe(400);
    expect(answer.body.nothing_to_remove).toBe(true);
    nothingWritten();
  });

  test("an empty table -> /print/bill's 400 and sentence", async () => {
    mockDb.items = 0;
    const answer = await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, MANAGER);
    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe("Nothing to print for this table");
    nothingWritten();
  });

  test.each([
    ["no kind", { reason: "Guest asked", authorised_by: "manager01" }],
    ["no reason", { waiver_kind: "guest_request", authorised_by: "manager01" }],
    ["no authoriser", { waiver_kind: "guest_request", reason: "Guest asked" }],
  ])("%s -> 400, nothing inserted", async (_label, form) => {
    const answer = await call(ROUTE, { table_name: "T1", ...form }, MANAGER);
    expect(answer.status).toBe(400);
    nothingWritten();
  });

  test("a kind outside the vocabulary is the schema's 400", async () => {
    const answer = await call(ROUTE, { table_name: "T1", ...WAIVER_FORM, waiver_kind: "because" }, MANAGER);
    expect(answer.status).toBe(400);
    nothingWritten();
  });

  test("the route's own guard is the print's (Add Orders); the waive permission is checked inside", async () => {
    const answer = await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, identity("manager", [WAIVE]));
    expect(answer.status).toBe(403);
    expect(answer.body.requiredPermission).toBe(ADD_ORDERS);
    nothingWritten();
  });
});

// ============================================================================
// A REFUSED REMOVAL IS ON THE RECORD
// ============================================================================
//
// Before 2.0.0 the till asked POST /print/bill for no_service_charge:true, and
// with no waiver on the bill that print left "asked WITHOUT the service charge;
// no waiver is recorded" in the audit log — production has these. Both clients
// now call this route instead, and a refusal prints nothing, so unless the
// refusal files its own line the attempt is simply gone from the log.

const REFUSED_PREFIX = "REFUSED removal of the service charge on table T1 — ";
const refusalLines = (): unknown[][] => auditsUnder(ADD_ORDERS).filter((a) => String(a[4]).startsWith("REFUSED removal of the service charge"));

describe("a refused removal of a charge that is on the bill files exactly one REFUSED line", () => {
  test.each([
    {
      label: "no waive permission (403)", auth: CASHIER, body: WAIVER_FORM, status: 403,
      refusal: "waiver_required", authorised_by: null,
      sentence: "the caller does not hold the 'Waive Service Charge' permission",
    },
    {
      label: "no kind (400)", auth: MANAGER, body: { reason: "Guest asked", authorised_by: "manager01" }, status: 400,
      refusal: "reason_required", authorised_by: null, sentence: "no waiver kind or reason was given",
    },
    {
      label: "no reason (400)", auth: MANAGER, body: { waiver_kind: "guest_request", authorised_by: "manager01" }, status: 400,
      refusal: "reason_required", authorised_by: null, sentence: "no waiver kind or reason was given",
    },
    {
      label: "no authoriser (400)", auth: MANAGER, body: { waiver_kind: "guest_request", reason: "Guest asked" }, status: 400,
      refusal: "authoriser_missing", authorised_by: null, sentence: "no authoriser was named",
    },
    {
      label: "a session with no username (400)", auth: UNSIGNED_MANAGER, body: WAIVER_FORM, status: 400,
      refusal: "no_username", authorised_by: null, sentence: "the session carries no username to sign a waiver with",
    },
  ])("$label", async ({ auth, body, status, refusal, authorised_by, sentence }) => {
    const answer = await call(ROUTE, { table_name: "T1", ...body }, auth);
    expect(answer.status).toBe(status);
    expect(mockAudit).toHaveLength(1);
    const [line] = refusalLines();
    expect(line![4]).toBe(`${REFUSED_PREFIX}${sentence}; nothing was waived or printed`);
    expect(line![5]).toBe("Bill");
    expect(line![6]).toEqual({
      table: "T1", refused: true, refusal,
      service_charge_basis: "tax_line", service_charge_waiver_required: true, authorised_by,
    });
    nothingWritten();
  });

  test.each([
    ["not_found", 400, "the named authoriser is not a staff member of this outlet"],
    ["not_permitted", 403, "the named authoriser may not authorise a service-charge waiver"],
  ] as const)("an authoriser the lookup refuses (%s) -> %i, one line naming them in the details only", async (reason, status, sentence) => {
    mockNext.authoriser = reason;
    const answer = await call(ROUTE, { table_name: "T1", ...WAIVER_FORM, authorised_by: "note on dessert" }, MANAGER);
    expect(answer.status).toBe(status);
    expect(mockAudit).toHaveLength(1);
    const [line] = refusalLines();
    expect(line![4]).toBe(`${REFUSED_PREFIX}${sentence}; nothing was waived or printed`);
    expect(line![6]).toMatchObject({ refusal: `authoriser_${reason}`, authorised_by: "note on dessert" });
    // Typed text stays out of the sentence the Bill Edit classifier pattern-matches.
    expect(String(line![4])).not.toContain("note on dessert");
    nothingWritten();
  });

  test("every refusal line is a control record, not a bill edit", async () => {
    const cases: [unknown, Record<string, unknown>][] = [
      [CASHIER, WAIVER_FORM],
      [MANAGER, { reason: "Guest asked", authorised_by: "manager01" }],
      [MANAGER, { waiver_kind: "guest_request", reason: "Guest asked" }],
      [UNSIGNED_MANAGER, WAIVER_FORM],
    ];
    for (const [auth, body] of cases) { await call(ROUTE, { table_name: "T1", ...body }, auth); }
    mockNext.authoriser = "not_found";
    await call(ROUTE, { table_name: "T1", ...WAIVER_FORM, authorised_by: "note on dessert" }, MANAGER);
    mockNext.authoriser = "not_permitted";
    await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, MANAGER);

    const lines = refusalLines();
    expect(lines).toHaveLength(6);
    for (const line of lines) {
      expect(classifyBillEdit(String(line[3]), String(line[4]), line[6] as Record<string, unknown>)).toBeNull();
    }
  });

  test("a failed audit write never turns the refusal into a 500", async () => {
    mockNext.auditFails = true;
    expect((await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, CASHIER)).status).toBe(403);
    expect((await call(ROUTE, { table_name: "T1", waiver_kind: "guest_request", authorised_by: "manager01" }, MANAGER)).status).toBe(400);
    mockNext.authoriser = "not_permitted";
    expect((await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, MANAGER)).status).toBe(403);
    nothingWritten();
  });

  test("not attempts on a charge: an empty table and a bill with no charge file nothing; C3 files only its own line", async () => {
    mockDb.items = 0;
    expect((await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, CASHIER)).status).toBe(400);
    expect(mockAudit).toHaveLength(0);

    mockDb.items = 1;
    mockDb.taxConfig = { SGST: 2.5, CGST: 2.5 };
    expect((await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, CASHIER)).body.nothing_to_remove).toBe(true);
    expect(mockAudit).toHaveLength(0);

    mockDb.taxConfig = { SGST: 2.5, CGST: 2.5, "Service Charge": 10 };
    mockDb.printCount = 1;
    expect((await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, identity("waiter", [ADD_ORDERS]))).body.reprint_needs_senior).toBe(true);
    expect(mockAudit.map((a) => String(a[4]))).toEqual(["REFUSED reprint of table T1's bill — already printed 1 time(s); reprints need a senior role"]);
    nothingWritten();
  });

  test("a removal that goes through files no REFUSED line", async () => {
    expect((await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, MANAGER)).status).toBe(200);
    expect(refusalLines()).toHaveLength(0);
  });
});

// ============================================================================
// WHAT THE ROUTE'S NOTES PROMISE, PINNED
// ============================================================================

describe("the paper and the floor see the state AFTER the commit", () => {
  test("a bill number the waiver MINTED is on the thermal paper", async () => {
    mockDb.billId = null;
    mockDb.billNo = null;
    const answer = await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, MANAGER);
    expect(answer.status).toBe(200);
    // The first read saw a table with no bill; the waiver minted it.
    expect(mockDb.billNo).toBe("B-42");
    expect(mockReceipts).toHaveLength(1);
    expect(mockReceipts[0]!.billNo).toBe("B-42");
    expect(answer.body.billId).toBe(mockIds.bill);
  });

  test("...and in the web dashboard's printable_bill", async () => {
    mockDb.billId = null;
    mockDb.billNo = null;
    const answer = await call(ROUTE, { table_name: "T1", ...WAIVER_FORM, render: "client" }, MANAGER);
    expect(answer.body.printable_bill.bill_no).toBe("B-42");
    expect(answer.body.billId).toBe(mockIds.bill);
  });

  test("other tills are told the bill changed — once, after the waiver commits", async () => {
    await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, MANAGER);
    const told = billAnnouncements();
    expect(told).toHaveLength(1);
    expect(told[0]!.payload).toEqual({ table: "T1" });
    expect(mockCalls[told[0]!.at]!.args[0]).toBe(mockIds.res);
    const waived = mockCalls.findIndex((c) => c.fn === "WaiveServiceCharge");
    expect(waived).toBeGreaterThanOrEqual(0);
    expect(told[0]!.at).toBeGreaterThan(waived);
  });

  test("a reprint of an existing waiver changes nothing, so it announces nothing", async () => {
    mockDb.waiver = waiverRow("w-live", quoteServiceChargeWaiver(5499, mockDb.taxConfig, 0));
    expect((await call(ROUTE, { table_name: "T1" }, CASHIER)).status).toBe(200);
    expect(billAnnouncements()).toHaveLength(0);
  });

  test("a 23505 with no waiver to re-read -> 409, and nothing prints", async () => {
    mockNext.waive = () => Promise.reject(Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }));
    const answer = await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, MANAGER);
    expect(answer.status).toBe(409);
    expect(answer.body.error).toBe("This bill's service charge has already been waived.");
    expect(mockReceipts).toHaveLength(0);
    expect(called("dispatchPrintJob")).toBe(0);
    expect(called("RecordClientRenderedBillPrint")).toBe(0);
    expect(auditsUnder(WAIVE)).toHaveLength(0);
  });

  /** The waiver commits and is gone again (reversed on another till) before the paper is read. */
  const commitsThenVanishes = (): (() => Promise<unknown>) => {
    const commit = commitsAWaiver();
    return async () => {
      const result = await commit();
      mockDb.waiver = null;
      return result;
    };
  };

  test("render client: the reply reports the RE-READ bill — charge still on, and its total", async () => {
    mockNext.waive = commitsThenVanishes();
    const answer = await call(ROUTE, { table_name: "T1", ...WAIVER_FORM, render: "client" }, MANAGER);
    expect(answer.status).toBe(200);
    expect(answer.body.printable_bill.service_charge_waived).toBe(false);
    expect(answer.body).toMatchObject({
      printed: true, waiver_created: true, service_charge_removed: false,
      grand_total_before: 6324, grand_total_after: 6324,
    });
  });

  test("thermal: the paper, the reply and the print's audit line all say the charge is ON", async () => {
    mockNext.waive = commitsThenVanishes();
    const answer = await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, MANAGER);
    expect(answer.status).toBe(200);
    expect(Number(mockReceipts[0]!.grandTotal)).toBe(6324);
    expect(answer.body).toMatchObject({ printed: true, service_charge_removed: false, grand_total_after: 6324 });
    const prints = auditsUnder(ADD_ORDERS);
    expect(prints.map((a) => String(a[4]))).toEqual([
      "Printed bill for table T1 (asked WITHOUT the service charge; no waiver is recorded, so the charge is ON this bill)",
    ]);
    expect(prints[0]![6]).toMatchObject({ no_service_charge: true, service_charge_removed: false, service_charge_waiver_required: true });
  });
});

// ============================================================================
// A FAILED PRINT AFTER THE COMMIT IS SAID, NEVER HIDDEN
// ============================================================================

describe("the printer path fails after the waiver committed", () => {
  test("200 printed:false with the error and the committed waiver — never a 5xx", async () => {
    mockNext.dispatchFails = true;
    const answer = await call(ROUTE, { table_name: "T1", ...WAIVER_FORM }, MANAGER);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      success: true, printed: false, print_error: "printer routing table unreadable",
      waiver_created: true, waiver: { id: "w-new" }, grand_total_before: 6324, grand_total_after: 5774,
    });
    // The waiver's line is filed: it happened.
    expect(auditsUnder(WAIVE)).toHaveLength(1);
  });
});

// ============================================================================
// THE WEB DASHBOARD: render "client" is the claim, not a thermal copy
// ============================================================================

describe("render: client — the browser draws the paper, the server records it", () => {
  test("claims the print, dispatches nothing, and hands back the waived, priced bill", async () => {
    const answer = await call(ROUTE, { table_name: "T1", ...WAIVER_FORM, render: "client" }, MANAGER);
    expect(answer.status).toBe(200);
    expect(called("RecordClientRenderedBillPrint")).toBe(1);
    expect(called("dispatchPrintJob")).toBe(0);
    expect(mockReceipts).toHaveLength(0);
    const after = await drawer();
    expect(answer.body.printable_bill.grand_total).toBe(after.grand_total);
    expect(answer.body.printable_bill.service_charge_waived).toBe(true);
    expect(answer.body).toMatchObject({
      printed: true, render: "client", recorded: true, jobId: "claim-1", print_count: 1,
      grand_total_after: after.grand_total, waiver_created: true,
    });
    // The claim's audit line, exactly as /print/bill/claim files it.
    expect(auditsUnder(ADD_ORDERS).map((a) => a[4])).toEqual([
      "Printed bill for table T1 from the web dashboard (browser print — no thermal copy)",
    ]);
  });

  test("printable_bill carries the PRE-claim print state, so the page stamps REPRINT only on a reprint", async () => {
    const answer = await call(ROUTE, { table_name: "T1", ...WAIVER_FORM, render: "client" }, MANAGER);
    expect(answer.body.printable_bill.print_count).toBe(0);
    expect(answer.body.print_count).toBe(1);
  });
});

// ============================================================================
// WIRING — nothing here is built but never called
// ============================================================================

describe("wiring", () => {
  const BACKEND = join(__dirname, "..", "..");
  const src = (file: string): string => readFileSync(join(BACKEND, file), "utf8").replace(/\r\n/g, "\n");

  test("the route is registered once, under /bills so an offline till refuses it with the billing sentence", () => {
    expect(registered.filter((r) => r.path === ROUTE)).toHaveLength(1);
  });

  test("POST /print/bill and /print/bill/claim print through the helpers this route prints through", () => {
    const bills = src("routes/bills.ts");
    const printBill = bills.slice(bills.indexOf("app.post('/print/bill',"), bills.indexOf("app.post('/print/bill/claim',"));
    expect(printBill).toContain("await printOpenTableBill(req, {");
    const claim = bills.slice(bills.indexOf("app.post('/print/bill/claim',"), bills.indexOf("app.post('/print/bill/settled',"));
    expect(claim).toContain("await claimClientRenderedBillPrint(req, {");
    // One renderer call for the open table's guest bill, inside the helper.
    const helper = bills.slice(bills.indexOf("export async function printOpenTableBill("), bills.indexOf("export async function claimClientRenderedBillPrint("));
    expect(helper).toContain("buildReceiptBase64({");
    expect(printBill).not.toContain("buildReceiptBase64(");
  });

  test("both waiver routes file their audit line through the one helper", () => {
    const capture = src("routes/mis_capture.ts");
    expect(capture.match(/await auditServiceChargeWaiver\(/g) ?? []).toHaveLength(2);
    expect(capture.match(/`Waived the service charge \(/g) ?? []).toHaveLength(1);
  });

  test("GetBillForTable tells the clients which shape carries the charge", () => {
    const db = src("database_supabase.ts");
    const fn = db.slice(db.indexOf("export async function GetBillForTable("), db.indexOf("export async function GetBillForTable(") + 40000);
    expect(fn).toContain("service_charge_basis: chargeCfg.basis,");
    expect(fn).toContain("service_charge_applied: chargeCfg.service_charge_applied,");
  });
});
