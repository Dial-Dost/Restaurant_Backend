// CLIENT ITEM 7 — THE GUEST'S ADDRESS ON A BILL, the HTTP half.
//
//   POST /bills/customer-name              { table_name, customer, customer_gstin?, customer_address? }
//   POST /bills/:billId/customer-details   { customer, customer_gstin?, customer_address? }
//
// The contract both clients are built against:
//
//   * `customer_address` omitted is UNDEFINED all the way to the data layer —
//     every installed 2.0.1 till omits it, and must not clear an address a
//     newer till saved;
//   * null, "" and whitespace clear it; the value is normalised (line breaks
//     kept) before the data layer sees it;
//   * over 5 lines, over 250 characters or not a string is the ONE 400 sentence,
//     and nothing is called — refused, never cut;
//   * before migration 054 an address write is the "not finished updating" 503;
//   * the gates do not move: Add Orders for the live table, the accounting
//     permission for a settled bill (a waiter is refused 403 before the data
//     layer is asked);
//   * the answers gain `customer_address`; the audit SENTENCE says the address
//     changed, and only the entry's details carry the text.

import { describe, test, expect, beforeAll, beforeEach } from "@jest/globals";
import { makeFakeApp, type FakeApp } from "./platform_fixtures";
import { CustomerAddressSchemaPendingError } from "../customer_address";

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
const ADDRESS = "4th Floor, Prestige Tower\n12 Residency Road\nBengaluru 560025";
const ADDRESS_400 = { error: "Address can be at most 5 lines and 250 characters" };
const PENDING_503 = { error: "This server has not finished updating — try again shortly" };

const identity = (role: string, role_all: string[], actions: string[]) => ({
  res_id: RES, outlet_id: OUTLET, employeeId: "emp-1", role, role_all, actions,
});
const WAITER = identity("waiter", ["waiter"], [ADD_ORDERS, "98b10bde-802d-4a5b-a726-53a826424f79"]);
const CAPTAIN_WITHOUT_ACCOUNTING = identity("captain", ["captain"], [ADD_ORDERS, CLOSE_BILL]);
const ACCOUNTANT = identity("manager", ["manager"], [ADD_ORDERS, CLOSE_BILL, ACCOUNTING]);
const NO_ADD_ORDERS = identity("host", ["host"], ["98b10bde-802d-4a5b-a726-53a826424f79"]);

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
  SetBillCustomerName.mockImplementation(async (_r: unknown, _t: unknown, name: unknown, gstin: unknown, address: unknown) => ({
    success: true, customer: String(name ?? "").trim() || null,
    customer_gstin: gstin === undefined ? null : gstin,
    customer_address: address === undefined ? "Stored Street" : address,
    orders_updated: 2,
  }));
  SetClosedBillCustomerDetails.mockImplementation(async (_r: unknown, id: unknown, name: unknown, gstin: unknown, address: unknown) => ({
    success: true, bill_id: id, bill_no: "5910", table_name: "T7",
    customer: String(name ?? "").trim() || null,
    customer_gstin: gstin === undefined ? null : gstin,
    customer_address: address === undefined ? "Stored Street" : address,
    orders_updated: 1,
  }));
});

const live = (body: Record<string, unknown>, auth: unknown = WAITER) =>
  harness.call("POST", "/bills/customer-name", { body, auth: auth as never });
const past = (body: Record<string, unknown>, auth: unknown = ACCOUNTANT, billId = BILL_ID) =>
  harness.call("POST", "/bills/:billId/customer-details", { params: { billId }, body, auth: auth as never });

/** [description, details] of the one audit entry filed. */
const audit = (): [string, Record<string, unknown>] => {
  expect(AddAuditLogEntry).toHaveBeenCalledTimes(1);
  const call = AddAuditLogEntry.mock.calls[0] as unknown[];
  return [String(call[4]), call[6] as Record<string, unknown>];
};

const OVER_LIMIT: [string, unknown][] = [
  ["six lines", "1\n2\n3\n4\n5\n6"],
  ["251 characters", "x".repeat(251)],
  ["a number", 560025],
  ["an object", { line1: "12 MG Road" }],
  ["an array", ["12 MG Road", "Bengaluru"]],
];

// ---------------------------------------------------------------------------
describe("POST /bills/customer-name — the running table", () => {
  test("OMITTED (every 2.0.1 till) reaches the data layer as undefined, and the answer carries the stored address", async () => {
    const r = await live({ table_name: "T7", customer: "Acme", customer_gstin: GSTIN });
    expect(r.status).toBe(200);
    expect(SetBillCustomerName).toHaveBeenCalledWith(RES, "T7", "Acme", GSTIN, undefined);
    expect(r.body).toEqual({ success: true, customer: "Acme", customer_gstin: GSTIN, customer_address: "Stored Street", orders_updated: 2 });
    const [line, details] = audit();
    expect(line).not.toMatch(/address/i);
    expect(details).not.toHaveProperty("customer_address");
  });

  test("an address is passed NORMALISED — CRLF to LF, lines trimmed, blank lines dropped — with the break kept", async () => {
    const r = await live({ table_name: "T7", customer: "Acme", customer_address: "  4th Floor,  Prestige Tower \r\n\r\n12 Residency Road\r\nBengaluru 560025\r\n" });
    expect(r.status).toBe(200);
    expect(SetBillCustomerName).toHaveBeenCalledWith(RES, "T7", "Acme", undefined, ADDRESS);
    expect((r.body as Record<string, unknown>).customer_address).toBe(ADDRESS);
  });

  test.each([[null], [""], ["   \n  "]])("customer_address %p CLEARS (null reaches the data layer)", async (value) => {
    const r = await live({ table_name: "T7", customer: "Acme", customer_address: value });
    expect(r.status).toBe(200);
    expect(SetBillCustomerName).toHaveBeenCalledWith(RES, "T7", "Acme", undefined, null);
  });

  test.each(OVER_LIMIT)("%s -> 400 with the contract sentence; nothing written, nothing audited", async (_label, value) => {
    const r = await live({ table_name: "T7", customer: "Acme", customer_address: value });
    expect(r.status).toBe(400);
    expect(r.body).toEqual(ADDRESS_400);
    expect(SetBillCustomerName).not.toHaveBeenCalled();
    expect(AddAuditLogEntry).not.toHaveBeenCalled();
    expect(emitRestaurant).not.toHaveBeenCalled();
  });

  test("migration 054 not there -> 503 with the contract sentence", async () => {
    SetBillCustomerName.mockRejectedValueOnce(new CustomerAddressSchemaPendingError());
    const r = await live({ table_name: "T7", customer: "Acme", customer_address: ADDRESS });
    expect(r.status).toBe(503);
    expect(r.body).toEqual(PENDING_503);
  });

  test("…and a refusal that crossed a module boundary (matched by name) is still the 503", async () => {
    SetBillCustomerName.mockRejectedValueOnce(Object.assign(new Error(PENDING_503.error), { name: "CustomerAddressSchemaPendingError" }));
    expect((await live({ table_name: "T7", customer: "Acme", customer_address: ADDRESS })).status).toBe(503);
  });

  test("the audit SENTENCE says the address changed; only the details carry the text", async () => {
    await live({ table_name: "T7", customer: "Acme", customer_address: ADDRESS });
    let [line, details] = audit();
    expect(line).toBe('Set the bill name on table T7 to "Acme" (address updated)');
    expect(line).not.toContain("Prestige");
    expect(details).toMatchObject({ table: "T7", customer: "Acme", customer_address: ADDRESS });

    AddAuditLogEntry.mockReset();
    await live({ table_name: "T7", customer: "Acme", customer_gstin: GSTIN, customer_address: null });
    [line, details] = audit();
    expect(line).toBe(`Set the bill name on table T7 to "Acme" (GSTIN ${GSTIN}) (address cleared)`);
    expect(details).toMatchObject({ customer_address: null });
  });

  test("still the waiter's door (Add Orders), and still closed to a login without it", async () => {
    expect((await live({ table_name: "T7", customer: "Acme", customer_address: ADDRESS }, WAITER)).status).toBe(200);
    SetBillCustomerName.mockClear();
    const refused = await live({ table_name: "T7", customer: "Acme", customer_address: ADDRESS }, NO_ADD_ORDERS);
    expect(refused.status).toBe(403);
    expect(SetBillCustomerName).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("POST /bills/:billId/customer-details — a past (settled) bill", () => {
  test("an accountant sets all three; the answer is exactly the contract's shape, and carries no money", async () => {
    const r = await past({ customer: "Acme Pvt Ltd", customer_gstin: GSTIN, customer_address: ADDRESS });
    expect(r.status).toBe(200);
    expect(SetClosedBillCustomerDetails).toHaveBeenCalledWith(RES, BILL_ID, "Acme Pvt Ltd", GSTIN, ADDRESS);
    expect(r.body).toEqual({ success: true, bill_id: BILL_ID, customer: "Acme Pvt Ltd", customer_gstin: GSTIN, customer_address: ADDRESS });
  });

  test("omitted leaves it unchanged (a 2.0.1 app's name/GSTIN edit, or an edit from a list row that never saw it)", async () => {
    const r = await past({ customer: "Acme", customer_gstin: GSTIN });
    expect(SetClosedBillCustomerDetails).toHaveBeenLastCalledWith(RES, BILL_ID, "Acme", GSTIN, undefined);
    expect((r.body as Record<string, unknown>).customer_address).toBe("Stored Street");
  });

  test("\"\" and null clear", async () => {
    await past({ customer: "Acme", customer_address: "" });
    expect(SetClosedBillCustomerDetails).toHaveBeenLastCalledWith(RES, BILL_ID, "Acme", undefined, null);
    await past({ customer: "Acme", customer_address: null });
    expect(SetClosedBillCustomerDetails).toHaveBeenLastCalledWith(RES, BILL_ID, "Acme", undefined, null);
  });

  test.each([["a waiter", WAITER], ["a captain without the accounting permission", CAPTAIN_WITHOUT_ACCOUNTING]])(
    "%s is refused 403 and the data layer is never asked",
    async (_who, auth) => {
      const r = await past({ customer: "Acme", customer_address: ADDRESS }, auth);
      expect(r.status).toBe(403);
      expect((r.body as Record<string, unknown>).requiredPermission).toBe(ACCOUNTING);
      expect(SetClosedBillCustomerDetails).not.toHaveBeenCalled();
    },
  );

  test.each(OVER_LIMIT)("%s -> 400 with the contract sentence; nothing written", async (_label, value) => {
    const r = await past({ customer: "Acme", customer_address: value });
    expect(r.status).toBe(400);
    expect(r.body).toEqual(ADDRESS_400);
    expect(SetClosedBillCustomerDetails).not.toHaveBeenCalled();
  });

  test("migration 054 not there -> 503 with the contract sentence", async () => {
    SetClosedBillCustomerDetails.mockRejectedValueOnce(new CustomerAddressSchemaPendingError());
    const r = await past({ customer: "Acme", customer_address: ADDRESS });
    expect(r.status).toBe(503);
    expect(r.body).toEqual(PENDING_503);
  });

  test("no such settled bill -> 404 { error: 'Bill not found' }, nothing audited", async () => {
    SetClosedBillCustomerDetails.mockResolvedValueOnce(null);
    const r = await past({ customer: "Acme", customer_address: ADDRESS });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "Bill not found" });
    expect(AddAuditLogEntry).not.toHaveBeenCalled();
  });

  test("the audit line names what changed — name/GSTIN/address, name/address, name — never the address text", async () => {
    await past({ customer: "Acme Pvt Ltd", customer_gstin: GSTIN, customer_address: ADDRESS });
    let [line, details] = audit();
    expect(line).toBe(`Changed the name/GSTIN/address on bill #5910 (table T7) — name "Acme Pvt Ltd", GSTIN ${GSTIN} (address updated)`);
    expect(details).toMatchObject({ bill_id: BILL_ID, customer_gstin: GSTIN, customer_address: ADDRESS, settled_bill_edit: true });

    AddAuditLogEntry.mockReset();
    await past({ customer: "Acme", customer_address: "" });
    [line, details] = audit();
    expect(line).toBe('Changed the name/address on bill #5910 (table T7) — name "Acme" (address cleared)');
    expect(details).toMatchObject({ customer_address: null });
    expect(details).not.toHaveProperty("customer_gstin");

    AddAuditLogEntry.mockReset();
    await past({ customer: "Acme" });
    [line, details] = audit();
    expect(line).toBe('Changed the name on bill #5910 (table T7) — name "Acme"');
    expect(details).not.toHaveProperty("customer_address");
  });
});
