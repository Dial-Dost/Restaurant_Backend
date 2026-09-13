// ROUND 2 ITEM 1 — THE CUSTOMER'S NAME AND GSTIN ON A BILL, the HTTP half.
//
//   POST /bills/customer-name              { table_name, customer, customer_gstin? }
//   POST /bills/:billId/customer-details   { customer, customer_gstin }
//
// The web dashboard and the app are built against these two bodies and their
// answers, so the cases below pin the CONTRACT rather than the implementation:
//
//   * `customer_gstin` omitted is UNDEFINED all the way to the data layer — an
//     old client must never clear a GSTIN by not knowing the field exists;
//   * an invalid GSTIN is the one 400 sentence, and nothing is called;
//   * the past-bill route is gated on EXACTLY what /print/bill/settled is gated
//     on, and a waiter is refused 403 without the data layer ever being asked;
//   * 404 is `{ error: "Bill not found" }` and 503 is the "not finished updating"
//     sentence, byte for byte;
//   * the audit line says what changed, on which bill.

import { describe, test, expect, beforeAll, beforeEach } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFakeApp, type FakeApp } from "./platform_fixtures";
import { CustomerGstinSchemaPendingError } from "../customer_gstin";

const SetBillCustomerName = jest.fn();
const SetClosedBillCustomerDetails = jest.fn();
const AddAuditLogEntry = jest.fn();
const emitRestaurant = jest.fn();

jest.mock("../database_supabase", () => ({
  __esModule: true,
  Audit_log_category: { Bill: "Bill", Orders: "Orders", Tables: "Tables" },
  BILL_SECTION_AXES: ["course", "seat"],
  SetBillCustomerName: (...a: unknown[]) => SetBillCustomerName(...a),
  SetClosedBillCustomerDetails: (...a: unknown[]) => SetClosedBillCustomerDetails(...a),
  GetBillForTable: jest.fn(), RecordClientRenderedBillPrint: jest.fn(),
  GetRestaurantSettings: jest.fn(async () => ({ currency: "₹", bill_paper_width: "80mm", timezone: "Asia/Kolkata" })),
  GetRestaurantProfile: jest.fn(async () => ({ outlet_name: "Fixture", outlet_add: null, outlet_phone: null })),
  GetBillChargeConfigForTable: jest.fn(), computeBillCharges: jest.fn(),
  AddBill: jest.fn(), AddNotification: jest.fn(), ApplyCouponToBill: jest.fn(),
  ApproveBillPaymentByAdmin: jest.fn(), CloseBillByOrder: jest.fn(),
  ConfirmBillPaymentByWaiter: jest.fn(), GetBillByOrder: jest.fn(),
  GetBillPaymentLedger: jest.fn(), GetBillTenderState: jest.fn(), GetClosedBill: jest.fn(),
  GetTipLedger: jest.fn(),
  // A real record, so log_audit files the line instead of refusing an
  // unattributable one (which would make the audit assertions vacuous).
  GetEmployeeDetailsFromEmpID: jest.fn(async () => ({
    res_id: "11111111-1111-1111-1111-111111111111", emp_Fname: "Ana", emp_Lname: "K",
  })),
  GetKotTableContext: jest.fn(async () => null),
  GetOrderKotContext: jest.fn(), GetOutlets: jest.fn(), GetRestaurantRazorpayKeys: jest.fn(),
  GetTableFeedbackContext: jest.fn(async () => null), ListBillingCounters: jest.fn(), ListClosedBills: jest.fn(),
  ListOpenBills: jest.fn(), MergeTableBills: jest.fn(), MoveBillItem: jest.fn(),
  RecordBillTenders: jest.fn(), RefundBill: jest.fn(), RemoveBillItem: jest.fn(),
  ReopenBill: jest.fn(), ReplaceBill: jest.fn(), SetBillCounter: jest.fn(),
  SetBillDiscountWithApproval: jest.fn(), SetBillItemNote: jest.fn(), SetBillRefundRef: jest.fn(),
  SplitBillForTable: jest.fn(), SplitBillForTableBySection: jest.fn(),
  UpdateBillStatusByOrder: jest.fn(), UpdateOrderItemsSplit: jest.fn(),
  UpsertBillingCounter: jest.fn(), VoidBillTender: jest.fn(),
  // routes/_shared.ts's own imports.
  AddAuditLogEntry: (...a: unknown[]) => AddAuditLogEntry(...a),
  AddCustomer: jest.fn(), AddEmailToCustomer: jest.fn(),
  GetCustomerId: jest.fn(), GetDueBookingReminders: jest.fn(), GetMessagingConfig: jest.fn(),
  GetRestaurantLogoRaw: jest.fn(async () => null), GetRestaurantAccountStatus: jest.fn(),
  GetSuperadminEmployeeId: jest.fn(), MarkBookingReminderSent: jest.fn(),
  RecordOutboundMessage: jest.fn(), SetOrderCustomerId: jest.fn(),
  UpdateCustomerDemographics: jest.fn(), sanitizeTimezone: (t: unknown) => t,
  withTenant: jest.fn(), zonedWallToUtc: jest.fn(),
}));
jest.mock("../print_routing", () => ({ __esModule: true, dispatchPrintJob: jest.fn() }));
jest.mock("../kot_print", () => ({ __esModule: true, dispatchKot: jest.fn(), logKotDispatched: jest.fn() }));
jest.mock("../escpos", () => ({ __esModule: true, buildReceiptBase64: () => "ZXNj", buildSplitReceiptsBase64: () => [] }));
jest.mock("../realtime", () => ({
  __esModule: true,
  emitRestaurant: (...a: unknown[]) => emitRestaurant(...a),
  emitOutlet: jest.fn(),
}));
jest.mock("../print_jobs", () => ({
  __esModule: true, ackPrintJob: jest.fn(), isSchemaMissing: () => false, warnSchemaMissing: jest.fn(),
}));
jest.mock("../storage_bucket_supabase", () => ({ __esModule: true, uploadScreenshot: jest.fn() }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: jest.fn() }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

const ADD_ORDERS = "4ad474d4-5230-449c-874f-6a238b833bca";
const CLOSE_BILL = "a953d044-31ba-4e31-b96f-99304fe43dfa";
const ACCOUNTING = "df75119b-e5f1-4f38-aba5-78a1cf182f56";
const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";
const BILL_ID = "55555555-5555-4555-8555-555555555555";
const GSTIN = "29ABCDE1234F1Z5";
const GSTIN_400 = { error: "GSTIN must be 15 characters, e.g. 29ABCDE1234F1Z5" };
const PENDING_503 = { error: "This server has not finished updating — try again shortly" };

const identity = (role: string, role_all: string[], actions: string[]) => ({
  res_id: RES, outlet_id: OUTLET, employeeId: "emp-1", role, role_all, actions,
});
const WAITER = identity("waiter", ["waiter"], [ADD_ORDERS, "98b10bde-802d-4a5b-a726-53a826424f79"]);
const CAPTAIN_WITHOUT_ACCOUNTING = identity("captain", ["captain"], [ADD_ORDERS, CLOSE_BILL]);
const ACCOUNTANT = identity("manager", ["manager"], [ADD_ORDERS, CLOSE_BILL, ACCOUNTING]);
const ADMIN = identity("admin", ["admin"], ["*"]);

let harness: FakeApp;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  const bills = await import("../routes/bills");
  harness = makeFakeApp();
  bills.registerBillOpsRoutes(harness.app as never);
  bills.registerBillPrintAndEditRoutes(harness.app as never);
});

beforeEach(() => {
  SetBillCustomerName.mockReset();
  SetClosedBillCustomerDetails.mockReset();
  AddAuditLogEntry.mockReset();
  emitRestaurant.mockReset();
  SetBillCustomerName.mockImplementation(async (_r: unknown, _t: unknown, name: unknown, gstin: unknown) => ({
    success: true, customer: String(name ?? "").trim() || null,
    customer_gstin: gstin === undefined ? "27AAAAA0000A1Z5" : gstin, orders_updated: 2,
  }));
  SetClosedBillCustomerDetails.mockImplementation(async (_r: unknown, id: unknown, name: unknown, gstin: unknown) => ({
    success: true, bill_id: id, bill_no: "5910", table_name: "T7",
    customer: String(name ?? "").trim() || null, customer_gstin: gstin === undefined ? null : gstin, orders_updated: 1,
  }));
});

const live = (body: Record<string, unknown>, auth: unknown = WAITER) =>
  harness.call("POST", "/bills/customer-name", { body, auth: auth as never });
const past = (body: Record<string, unknown>, auth: unknown = ACCOUNTANT, billId = BILL_ID) =>
  harness.call("POST", "/bills/:billId/customer-details", { params: { billId }, body, auth: auth as never });

// ---------------------------------------------------------------------------
describe("POST /bills/customer-name — the running table", () => {
  test("OMITTED customer_gstin reaches the data layer as undefined (unchanged), and old clients see the same result plus the field", async () => {
    const r = await live({ table_name: "T7", customer: "Acme" });
    expect(r.status).toBe(200);
    expect(SetBillCustomerName).toHaveBeenCalledWith(RES, "T7", "Acme", undefined);
    expect(SetBillCustomerName.mock.calls[0]).toHaveLength(4);
    expect(r.body).toEqual({ success: true, customer: "Acme", customer_gstin: "27AAAAA0000A1Z5", orders_updated: 2 });
  });

  test("a valid GSTIN is passed normalized (lowercase + spaces)", async () => {
    const r = await live({ table_name: "T7", customer: "Acme", customer_gstin: " 29abcde 1234 f1z5 " });
    expect(r.status).toBe(200);
    expect(SetBillCustomerName).toHaveBeenCalledWith(RES, "T7", "Acme", GSTIN);
    expect((r.body as Record<string, unknown>).customer_gstin).toBe(GSTIN);
  });

  test.each([[null], [""], ["   "]])("customer_gstin %p CLEARS (null reaches the data layer)", async (value) => {
    const r = await live({ table_name: "T7", customer: "Acme", customer_gstin: value });
    expect(r.status).toBe(200);
    expect(SetBillCustomerName).toHaveBeenCalledWith(RES, "T7", "Acme", null);
  });

  test.each([["29ABCDE1234F1Z"], ["hello"], [12345], [{ gstin: GSTIN }]])("invalid %p -> 400 with the contract sentence; nothing written", async (value) => {
    const r = await live({ table_name: "T7", customer: "Acme", customer_gstin: value });
    expect(r.status).toBe(400);
    expect(r.body).toEqual(GSTIN_400);
    expect(SetBillCustomerName).not.toHaveBeenCalled();
  });

  test("migration 046 not applied -> 503 with the contract sentence", async () => {
    SetBillCustomerName.mockRejectedValueOnce(new CustomerGstinSchemaPendingError());
    const r = await live({ table_name: "T7", customer: "Acme", customer_gstin: GSTIN });
    expect(r.status).toBe(503);
    expect(r.body).toEqual(PENDING_503);
  });

  test("the audit line names the GSTIN when one was written, and stays as it was when none was sent", async () => {
    await live({ table_name: "T7", customer: "Acme", customer_gstin: GSTIN });
    expect(JSON.stringify(AddAuditLogEntry.mock.calls[0])).toContain(`Set the bill name on table T7 to \\"Acme\\" (GSTIN ${GSTIN})`);
    AddAuditLogEntry.mockReset();
    await live({ table_name: "T7", customer: "Acme" });
    const line = JSON.stringify(AddAuditLogEntry.mock.calls[0]);
    expect(line).toContain("Set the bill name on table T7 to \\\"Acme\\\"\"");
    expect(line).not.toContain("GSTIN");
  });

  test("still the waiter's door: Add Orders is enough", async () => {
    expect((await live({ table_name: "T7", customer: "Acme", customer_gstin: GSTIN }, WAITER)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe("POST /bills/:billId/customer-details — a past (settled) bill", () => {
  test("an accountant changes both; the response is exactly the contract's shape", async () => {
    const r = await past({ customer: "Acme Pvt Ltd", customer_gstin: "29abcde1234f1z5" });
    expect(r.status).toBe(200);
    expect(SetClosedBillCustomerDetails).toHaveBeenCalledWith(RES, BILL_ID, "Acme Pvt Ltd", GSTIN);
    expect(r.body).toEqual({ success: true, bill_id: BILL_ID, customer: "Acme Pvt Ltd", customer_gstin: GSTIN });
  });

  test("an admin ('*') may too", async () => {
    expect((await past({ customer: "Acme", customer_gstin: GSTIN }, ADMIN)).status).toBe(200);
  });

  test.each([["a waiter", WAITER], ["a captain without the accounting permission", CAPTAIN_WITHOUT_ACCOUNTING]])(
    "%s is refused 403 and the data layer is never asked",
    async (_who, auth) => {
      const r = await past({ customer: "Acme", customer_gstin: GSTIN }, auth);
      expect(r.status).toBe(403);
      expect((r.body as Record<string, unknown>).requiredPermission).toBe(ACCOUNTING);
      expect(SetClosedBillCustomerDetails).not.toHaveBeenCalled();
      expect(AddAuditLogEntry).not.toHaveBeenCalled();
    },
  );

  test("no such settled bill -> 404 { error: 'Bill not found' }", async () => {
    SetClosedBillCustomerDetails.mockResolvedValueOnce(null);
    const r = await past({ customer: "Acme", customer_gstin: GSTIN });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "Bill not found" });
    expect(AddAuditLogEntry).not.toHaveBeenCalled();
  });

  test("invalid GSTIN -> 400 with the contract sentence; nothing written", async () => {
    const r = await past({ customer: "Acme", customer_gstin: "29ABCDE1234F1Z" });
    expect(r.status).toBe(400);
    expect(r.body).toEqual(GSTIN_400);
    expect(SetClosedBillCustomerDetails).not.toHaveBeenCalled();
  });

  test("\"\" and null clear; omitted leaves it unchanged", async () => {
    await past({ customer: "Acme", customer_gstin: "" });
    expect(SetClosedBillCustomerDetails).toHaveBeenLastCalledWith(RES, BILL_ID, "Acme", null);
    await past({ customer: "Acme", customer_gstin: null });
    expect(SetClosedBillCustomerDetails).toHaveBeenLastCalledWith(RES, BILL_ID, "Acme", null);
    await past({ customer: "Acme" });
    expect(SetClosedBillCustomerDetails).toHaveBeenLastCalledWith(RES, BILL_ID, "Acme", undefined);
  });

  test("migration 046 not applied -> 503 with the contract sentence", async () => {
    SetClosedBillCustomerDetails.mockRejectedValueOnce(new CustomerGstinSchemaPendingError());
    const r = await past({ customer: "Acme", customer_gstin: GSTIN });
    expect(r.status).toBe(503);
    expect(r.body).toEqual(PENDING_503);
  });

  test("the audit line: \"Changed the name/GSTIN on bill #N …\" under the accounting action", async () => {
    await past({ customer: "Acme Pvt Ltd", customer_gstin: GSTIN });
    expect(AddAuditLogEntry).toHaveBeenCalledTimes(1);
    const [, , , actionId, description, category, details] = AddAuditLogEntry.mock.calls[0] as unknown[];
    expect(actionId).toBe(ACCOUNTING);
    expect(category).toBe("Bill");
    expect(String(description)).toMatch(/^Changed the name\/GSTIN on bill #5910 \(table T7\) /);
    expect(String(description)).toContain(`GSTIN ${GSTIN}`);
    expect(details).toMatchObject({ bill_id: BILL_ID, bill_no: "5910", customer: "Acme Pvt Ltd", customer_gstin: GSTIN });
  });

  test("the response carries no money", async () => {
    const r = await past({ customer: "Acme", customer_gstin: GSTIN });
    expect(Object.keys(r.body as object).sort()).toEqual(["bill_id", "customer", "customer_gstin", "success"]);
  });
});

// ---------------------------------------------------------------------------
describe("the past-bill edit is gated exactly like the settled-bill reprint", () => {
  const src = (): string => {
    for (const base of [process.cwd(), join(__dirname, "..")]) {
      try { return readFileSync(join(base, "routes", "bills.ts"), "utf8"); } catch { /* try the next base */ }
    }
    throw new Error("routes/bills.ts not found");
  };
  const guardOf = (text: string, path: string): string => {
    const at = text.indexOf(`app.post('${path}',`);
    expect(at).toBeGreaterThan(-1);
    return text.slice(at, text.indexOf("async (req", at));
  };

  test("same validateAction(...) guard chain as /print/bill/settled", () => {
    const text = src();
    const settled = guardOf(text, "/print/bill/settled").replace("'/print/bill/settled'", "PATH");
    const details = guardOf(text, "/bills/:billId/customer-details").replace("'/bills/:billId/customer-details'", "PATH");
    expect(details).toBe(settled);
    expect(details).toMatch(/validateAction\(ACCOUNTING_PERM\)/);
  });
});
