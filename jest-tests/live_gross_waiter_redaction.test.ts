// 6.4 x C4 — THE LIVE GROSS IS THE WHOLE FLOOR'S MONEY, AND A WAITER HOLDS VIEW BILL.
//
// GET /bills/open is gated on 98b10bde "View Bill", which the core waiter role
// holds (so it can read the table it is standing at). The route handed that same
// waiter every open bill's grand total, `outstanding_total`, and now 6.4's
// `running_total` — the restaurant's takings across every table at once, which
// is strictly more than the single table bill price_scope.ts already refuses them.
//
// So, as on the other three surfaces: a waiter-only session is told HOW MANY
// tables are running and which bills are open, never what any of it is worth; and
// every senior role gets the payload byte-for-byte as before.

import { describe, test, expect, beforeAll, beforeEach } from "@jest/globals";
import { makeFakeApp, type FakeApp } from "./platform_fixtures";
import { REDACTED_OPEN_BILL_ROW_MONEY_KEYS, REDACTED_OPEN_BILLS_MONEY_KEYS, redactOpenBillPage } from "../price_scope";

const ListOpenBills = jest.fn();

jest.mock("../database_supabase", () => ({
  __esModule: true,
  Audit_log_category: { Bill: "Bill", Orders: "Orders", Tables: "Tables" },
  BILL_SECTION_AXES: ["course", "seat"],
  GetBillForTable: jest.fn(), RecordClientRenderedBillPrint: jest.fn(),
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
  GetTipLedger: jest.fn(),
  // Returns a real record rather than null: log_audit refuses to file a line
  // it cannot attribute, so a null here would make every audit assertion below
  // pass vacuously against a route that never logged anything.
  GetEmployeeDetailsFromEmpID: jest.fn(async () => ({
    res_id: "11111111-1111-1111-1111-111111111111", emp_Fname: "Ana", emp_Lname: "K",
  })),
  GetKotTableContext: jest.fn(async () => null),
  GetOrderKotContext: jest.fn(), GetOutlets: jest.fn(), GetRestaurantRazorpayKeys: jest.fn(),
  GetTableFeedbackContext: jest.fn(async () => null), ListBillingCounters: jest.fn(), ListClosedBills: jest.fn(),
  ListOpenBills: (...a: unknown[]) => ListOpenBills(...a), MergeTableBills: jest.fn(), MoveBillItem: jest.fn(),
  RecordBillTenders: jest.fn(), RefundBill: jest.fn(), RemoveBillItem: jest.fn(),
  ReopenBill: jest.fn(), ReplaceBill: jest.fn(), SetBillCounter: jest.fn(),
  SetBillCustomerName: jest.fn(),
  SetBillDiscountWithApproval: jest.fn(), SetBillItemNote: jest.fn(), SetBillRefundRef: jest.fn(),
  SplitBillForTable: jest.fn(), SplitBillForTableBySection: jest.fn(),
  UpdateBillStatusByOrder: jest.fn(), UpdateOrderItemsSplit: jest.fn(),
  UpsertBillingCounter: jest.fn(), VoidBillTender: jest.fn(),
  // routes/_shared.ts's own imports.
  AddAuditLogEntry: jest.fn(),
  AddCustomer: jest.fn(), AddEmailToCustomer: jest.fn(),
  GetCustomerId: jest.fn(), GetDueBookingReminders: jest.fn(), GetMessagingConfig: jest.fn(),
  GetRestaurantLogoRaw: jest.fn(async () => null), GetRestaurantAccountStatus: jest.fn(),
  GetSuperadminEmployeeId: jest.fn(), MarkBookingReminderSent: jest.fn(),
  RecordOutboundMessage: jest.fn(), SetOrderCustomerId: jest.fn(),
  UpdateCustomerDemographics: jest.fn(), sanitizeTimezone: (t: unknown) => t,
  withTenant: jest.fn(), zonedWallToUtc: jest.fn(),
}));
jest.mock("../print_routing", () => ({
  __esModule: true,
  dispatchPrintJob: jest.fn(),
}));
jest.mock("../kot_print", () => ({
  __esModule: true,
  dispatchKot: jest.fn(),
  logKotDispatched: jest.fn(),
}));
jest.mock("../escpos", () => ({ __esModule: true, buildReceiptBase64: () => "ZXNj" }));
jest.mock("../realtime", () => ({
  __esModule: true,
  emitRestaurant: jest.fn(),
  emitOutlet: jest.fn(),
}));
jest.mock("../print_jobs", () => ({
  __esModule: true,
  ackPrintJob: jest.fn(),
  isSchemaMissing: (err: unknown) => {
    const code = (err as { code?: unknown } | null)?.code;
    return code === "42P01" || code === "42501";
  },
  warnSchemaMissing: jest.fn(),
}));
jest.mock("../storage_bucket_supabase", () => ({ __esModule: true, uploadScreenshot: jest.fn() }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: jest.fn() }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

const VIEW_BILL = "98b10bde-802d-4a5b-a726-53a826424f79";
const CLOSE_BILL = "a953d044-31ba-4e31-b96f-99304fe43dfa";
const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";

const identity = (role: string, role_all: string[], actions: string[] = [VIEW_BILL]) => ({
  res_id: RES, outlet_id: OUTLET, employeeId: "emp-1", role, role_all, actions,
});

const WAITER = identity("waiter", ["waiter"]);
/** The csrorganics shape — a waiter carrying a custom role UUID. */
const WAITER_WITH_CUSTOM_ROLE = identity("waiter", ["waiter", "d2b1f0c4-0000-4000-8000-000000000001"]);

const SENIORS = [
  ["a manager", identity("manager", ["manager"], [VIEW_BILL, CLOSE_BILL])],
  ["a cashier", identity("cashier", ["cashier"], [VIEW_BILL, CLOSE_BILL])],
  ["an admin", identity("admin", ["admin"], ["*"])],
] as const;

const PAGE = () => ({
  bills: [{
    id: "bill-2", bill_no: "B-2", status: 1, table_id: "tbl-2", table_name: "T2", covers: 2, order_count: 1,
    grand_total: 2079, taxable_base: 1980, service_charge: 180, service_charge_percent: 10,
    taxes: [{ name: "CGST", percentage: 2.5, amount: 49.5 }, { name: "SGST", percentage: 2.5, amount: 49.5 }],
    tax_total: 99, discount_type: "flat", discount_value: 200, coupon_code: null, apc: 990,
    stage: "running", totals_snapshotted: false, payment_method: null, opened_by: "Ana",
    opened_at: "2026-09-11T12:00:00.000Z", opened_at_local: "2026-09-11 17:30", age_minutes: 10,
  }],
  total: 1, limit: 1, offset: 0, has_more: false,
  outstanding_total: 2079,
  running_tables: 3,
  running_total: 5890.25,
  timezone: "Asia/Kolkata",
});

let harness: FakeApp;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  const bills = await import("../routes/bills");
  harness = makeFakeApp();
  bills.registerBillRoutes(harness.app as never);
});

beforeEach(() => {
  ListOpenBills.mockReset();
  ListOpenBills.mockResolvedValue(PAGE());
});

const openBillsFor = (auth: unknown) => harness.call("GET", "/bills/open", { query: { limit: "1" }, auth: auth as never });
const asMap = (body: unknown): Record<string, unknown> => body as Record<string, unknown>;
const has = (o: unknown, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

describe("GET /bills/open — a waiter is told the floor is running, not what it is worth", () => {
  for (const [who, auth] of [["a waiter", WAITER], ["a waiter with a custom role", WAITER_WITH_CUSTOM_ROLE]] as const) {
    test(`${who}: the floor-wide sums are gone, the counts are not`, async () => {
      const r = await openBillsFor(auth);
      expect(r.status).toBe(200);
      const body = asMap(r.body);
      for (const key of REDACTED_OPEN_BILLS_MONEY_KEYS) { expect([key, has(body, key)]).toEqual([key, false]); }
      expect(body.running_tables).toBe(3);
      expect(body.total).toBe(1);
    });

    test(`${who}: every bill row loses its amounts and keeps its rates and facts`, async () => {
      const row = (asMap((await openBillsFor(auth)).body).bills as Record<string, unknown>[])[0];
      for (const key of REDACTED_OPEN_BILL_ROW_MONEY_KEYS) { expect([key, has(row, key)]).toEqual([key, false]); }
      expect(row.taxes).toEqual([{ name: "CGST", percentage: 2.5 }, { name: "SGST", percentage: 2.5 }]);
      expect(row.table_name).toBe("T2");
      expect(row.stage).toBe("running");
      expect(row.service_charge_percent).toBe(10);
    });
  }

  for (const [who, auth] of SENIORS) {
    test(`${who} gets the payload byte-for-byte`, async () => {
      expect((await openBillsFor(auth)).body).toEqual(PAGE());
    });
  }

  test("the redactor COPIES — the page the data layer returned is untouched", () => {
    const page = PAGE();
    redactOpenBillPage(page);
    expect(page).toEqual(PAGE());
  });
});
