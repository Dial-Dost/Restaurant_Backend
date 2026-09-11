// C3 — "A waiter may execute Print Bill ONCE; reprints are restricted."
//
// ============================================================================
// WHY THIS SUITE EXISTS: THE RULE HAD NO SERVER HALF
// ============================================================================
// The clients implemented C3 by hiding the button and remembering the press in
// the DEVICE. POST /print/bill was gated on "Add Orders" (4ad474d4…) — the
// everyday action every waiter holds — so the "once" survived a
// back-navigation and an app restart and survived NOTHING ELSE: not a
// reinstall, not a second tablet, not a bare curl. A rule each device answers
// privately is a rule that means something different on each of them.
//
// A HIDDEN CONTROL MUST BE UNREACHABLE, NOT MERELY UNDRAWN. Every case here
// drives the shipped handler and asserts on the DISPATCH: the print is a mock,
// and `expect(dispatchPrintJob).not.toHaveBeenCalled()` is what proves no paper
// came out. A 403 body alone would prove only that a message was sent.
//
// AND THE MIRROR HALF, in every case: the first print still works, a KOT
// reprint still works, and a manager, cashier, captain or admin reprints as
// many times as they ever could. "Super Admin" in the requirement names who a
// WAITER escalates to — not a new ceiling on the people who run the floor.

import { describe, test, expect, beforeAll, beforeEach } from "@jest/globals";
import { makeFakeApp, type FakeApp } from "./platform_fixtures";

const GetBillForTable = jest.fn();
const dispatchPrintJob = jest.fn();
const dispatchKot = jest.fn();

jest.mock("../database_supabase", () => ({
  __esModule: true,
  Audit_log_category: { Bill: "Bill", Orders: "Orders", Tables: "Tables" },
  BILL_SECTION_AXES: ["course", "seat"],
  GetBillForTable: (...a: unknown[]) => GetBillForTable(...a),
  GetRestaurantSettings: jest.fn(async () => ({ currency: "₹", bill_paper_width: "80mm", timezone: "Asia/Kolkata" })),
  GetRestaurantProfile: jest.fn(async () => ({ outlet_name: "Fixture", outlet_add: null, outlet_phone: null })),
  GetBillChargeConfigForTable: jest.fn(async () => ({
    taxConfig: [], scPct: 0, includeServiceCharge: false, basis: "none",
    service_charge_removed: false, service_charge_applied: false,
    service_charge_percent: 0, waiver: null,
  })),
  computeBillCharges: jest.fn(() => ({
    subtotal: 4250, discount: 0, service_charge: 0, service_charge_percent: 0,
    taxes: [], tax_total: 0, grand_total: 4250,
  })),
  AddBill: jest.fn(), AddNotification: jest.fn(), ApplyCouponToBill: jest.fn(),
  ApproveBillPaymentByAdmin: jest.fn(), CloseBillByOrder: jest.fn(),
  ConfirmBillPaymentByWaiter: jest.fn(), GetBillByOrder: jest.fn(),
  GetBillPaymentLedger: jest.fn(), GetBillTenderState: jest.fn(), GetClosedBill: jest.fn(),
  GetTipLedger: jest.fn(), GetEmployeeDetailsFromEmpID: jest.fn(async () => null), GetKotTableContext: jest.fn(async () => null),
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
  AddAuditLogEntry: jest.fn(), AddCustomer: jest.fn(), AddEmailToCustomer: jest.fn(),
  GetCustomerId: jest.fn(), GetDueBookingReminders: jest.fn(), GetMessagingConfig: jest.fn(),
  GetRestaurantLogoRaw: jest.fn(async () => null), GetRestaurantAccountStatus: jest.fn(),
  GetSuperadminEmployeeId: jest.fn(), MarkBookingReminderSent: jest.fn(),
  RecordOutboundMessage: jest.fn(), SetOrderCustomerId: jest.fn(),
  UpdateCustomerDemographics: jest.fn(), sanitizeTimezone: (t: unknown) => t,
  withTenant: jest.fn(), zonedWallToUtc: jest.fn(),
}));
jest.mock("../print_routing", () => ({
  __esModule: true,
  dispatchPrintJob: (...a: unknown[]) => dispatchPrintJob(...a),
}));
jest.mock("../kot_print", () => ({
  __esModule: true,
  dispatchKot: (...a: unknown[]) => dispatchKot(...a),
  logKotDispatched: jest.fn(),
}));
jest.mock("../escpos", () => ({ __esModule: true, buildReceiptBase64: () => "ZXNj" }));
jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: jest.fn(), emitOutlet: jest.fn() }));
jest.mock("../print_jobs", () => ({ __esModule: true, ackPrintJob: jest.fn() }));
jest.mock("../storage_bucket_supabase", () => ({ __esModule: true, uploadScreenshot: jest.fn() }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: jest.fn() }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

const ADD_ORDERS = "4ad474d4-5230-449c-874f-6a238b833bca";
const CLOSE_BILL = "a953d044-31ba-4e31-b96f-99304fe43dfa";
const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";

const identity = (role: string, role_all: string[], actions: string[] = [ADD_ORDERS]) => ({
  res_id: RES, outlet_id: OUTLET, employeeId: "emp-1", role, role_all, actions,
});

/** A plain waiter — the only identity C3 narrows. */
const WAITER = identity("waiter", ["waiter"]);
/**
 * THE csrorganics SHAPE, and the reason the gate asks isWaiterOnly rather than
 * `role === "waiter"`: a waiter granted any custom role carries a UUID in
 * role_all. Under the old client-side `roles.every(r => r == 'waiter')` test
 * every restriction evaporated for exactly this person.
 */
const WAITER_WITH_CUSTOM_ROLE = identity("waiter", ["waiter", "d2b1f0c4-0000-4000-8000-000000000001"]);
/** The "employee" placeholder parseEmployeeRoles falls back to. Still a waiter. */
const WAITER_WITH_PLACEHOLDER = identity("employee", ["employee", "waiter"]);

const SENIORS = [
  ["a manager", identity("manager", ["manager"], [ADD_ORDERS, CLOSE_BILL])],
  ["a cashier", identity("cashier", ["cashier"], [ADD_ORDERS, CLOSE_BILL])],
  ["a captain", identity("captain", ["captain"], [ADD_ORDERS, CLOSE_BILL])],
  ["a waiter who is ALSO a manager", identity("waiter", ["waiter", "manager"], [ADD_ORDERS])],
  ["an admin", identity("admin", ["admin"], ["*"])],
] as const;

const billWith = (printCount: number) => ({
  bill_id: "bill-1", table_id: "tbl-1", items: [{ name: "Paneer Tikka", price: 425, quantity: 10 }],
  subtotal: 4250, total_amt: 4250, covers: 4, discount_value: 0, discount_type: null,
  order_notes: [], order_ids: [], kot_nos: [], customer: null, bill_no: "B-1", coupon_code: null,
  print_count: printCount,
  bill_printed_at: printCount > 0 ? "2026-09-11T13:40:00.000Z" : null,
  printed_at: printCount > 0 ? "2026-09-11T13:40:00.000Z" : null,
});

let harness: FakeApp;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  const bills = await import("../routes/bills");
  harness = makeFakeApp();
  bills.registerBillPrintAndEditRoutes(harness.app as never);
});

beforeEach(() => {
  GetBillForTable.mockReset();
  dispatchPrintJob.mockReset();
  dispatchKot.mockReset();
  dispatchPrintJob.mockResolvedValue({ jobId: "job-1", decision: { destinationName: "Front Till" }, assignedDeviceId: "dev-1" });
  dispatchKot.mockResolvedValue({ tickets: 1, stations: ["main"], kotNo: 7, businessDay: "2026-09-11", reprint: false });
});

const print = (auth: unknown, body: Record<string, unknown> = { table_name: "T7" }) =>
  harness.call("POST", "/print/bill", { body, auth: auth as never });

const isReprintRefusal = (r: { status: number; body: unknown }): boolean =>
  r.status === 403 && (r.body as { reprint_needs_senior?: boolean })?.reprint_needs_senior === true;

// ---------------------------------------------------------------------------
describe("a waiter gets one print, and the SERVER is what says so", () => {
  test("the FIRST print goes through — the rule restricts the reprint, not the print", async () => {
    GetBillForTable.mockResolvedValue(billWith(0));
    const r = await print(WAITER);
    expect(isReprintRefusal(r)).toBe(false);
    expect(r.status).toBe(200);
    expect(dispatchPrintJob).toHaveBeenCalledTimes(1);
  });

  test("the SECOND print is refused and NO PAPER COMES OUT", async () => {
    GetBillForTable.mockResolvedValue(billWith(1));
    const r = await print(WAITER);
    expect(isReprintRefusal(r)).toBe(true);
    // The assertion that matters — a 403 proves a message, this proves the
    // printer never heard about it.
    expect(dispatchPrintJob).not.toHaveBeenCalled();
  });

  test("the refusal SAYS WHO CAN DO IT INSTEAD", async () => {
    // A waiter handed a blank space where a control was will press it again on
    // the next device they find. A waiter told "ask a manager" walks to the pass.
    GetBillForTable.mockResolvedValue(billWith(2));
    const r = await print(WAITER);
    const body = r.body as { details?: string; allowed_roles?: string[]; print_count?: number; bill_printed_at?: string };
    expect(body.details).toContain("manager");
    expect(body.allowed_roles).toEqual(expect.arrayContaining(["manager", "cashier", "captain", "admin"]));
    expect(body.print_count).toBe(2);
    expect(body.bill_printed_at).toBe("2026-09-11T13:40:00.000Z");
  });

  test("A CUSTOM ROLE DOES NOT UN-SCOPE A WAITER — the csrorganics shape", async () => {
    // THE REGRESSION THIS PINS. If the gate ever goes back to asking whether
    // every role string is literally "waiter", this identity walks straight
    // through it — and it is the identity a tenant using the RBAC feature
    // actually has.
    GetBillForTable.mockResolvedValue(billWith(1));
    const r = await print(WAITER_WITH_CUSTOM_ROLE);
    expect(isReprintRefusal(r)).toBe(true);
    expect(dispatchPrintJob).not.toHaveBeenCalled();
  });

  test("the 'employee' placeholder does not un-scope a waiter either", async () => {
    GetBillForTable.mockResolvedValue(billWith(1));
    const r = await print(WAITER_WITH_PLACEHOLDER);
    expect(isReprintRefusal(r)).toBe(true);
    expect(dispatchPrintJob).not.toHaveBeenCalled();
  });

  test("a KITCHEN docket is not a bill — a waiter reprints KOTs all shift", async () => {
    GetBillForTable.mockResolvedValue(billWith(3));
    const r = await print(WAITER, { table_name: "T7", kind: "kot" });
    expect(isReprintRefusal(r)).toBe(false);
    expect(dispatchKot).toHaveBeenCalledTimes(1);
  });

  test("a table with nothing on it answers 'nothing to print', not a permission verdict", async () => {
    GetBillForTable.mockResolvedValue(null);
    const r = await print(WAITER);
    expect(r.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe("nobody senior loses a reprint they have today", () => {
  for (const [who, auth] of SENIORS) {
    test(`${who} reprints a bill that has already been printed five times`, async () => {
      GetBillForTable.mockResolvedValue(billWith(5));
      const r = await print(auth);
      expect(isReprintRefusal(r)).toBe(false);
      expect(r.status).toBe(200);
      expect(dispatchPrintJob).toHaveBeenCalledTimes(1);
    });
  }
});

// ---------------------------------------------------------------------------
describe("the count is a SERVER fact, not a device's memory", () => {
  test("a fresh device with no memory at all is still refused the second print", async () => {
    // The whole point. The harness has no client state of any kind — this is the
    // curl, the reinstall and the second tablet, and all three now answer the
    // same because the count comes off the "PrintJobs" ledger.
    GetBillForTable.mockResolvedValue(billWith(1));
    const r = await print(WAITER);
    expect(isReprintRefusal(r)).toBe(true);
  });

  test("a bill whose print_count the server reports as 0 is printable — a jam does not burn the attempt", async () => {
    // billPrintHistoryForTable counts only jobs that printed or are still on
    // their way; 'failed' and 'expired' are non-events. A print the printer
    // refused is a print the waiter still has to make.
    GetBillForTable.mockResolvedValue(billWith(0));
    const r = await print(WAITER);
    expect(r.status).toBe(200);
    expect(dispatchPrintJob).toHaveBeenCalledTimes(1);
  });
});
