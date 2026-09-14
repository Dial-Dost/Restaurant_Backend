// 5.3 / round-2 item 4 — "Reprint has to mention reprint on top once the bill
// has been reprinted."
//
// ============================================================================
// THE DEFECT THIS PINS
// ============================================================================
// The renderer has carried a REPRINT banner for a while, and the ACCOUNTING
// reprint (POST /print/bill/settled) always set it. POST /print/bill did not:
// the open table's bill, printed a second time by a manager/cashier/captain
// (the only people C3 still lets reprint it), came off the roll looking exactly
// like the original. A second copy that looks like an original is the one that
// gets paid twice or filed as a second sale.
//
// So these tests drive the SHIPPED handlers with the REAL renderer (only the
// database, the router and the logo are stubbed) and decode the bytes that
// would have gone to the printer. For each reprint path the first non-blank
// printed line must be the banner, in bold double width+height; a first print
// must not carry it at all.

import { describe, test, expect, beforeAll, beforeEach } from "@jest/globals";
import { makeFakeApp, type FakeApp } from "./platform_fixtures";

const GetBillForTable = jest.fn();
const GetClosedBill = jest.fn();
const dispatchPrintJob = jest.fn();

jest.mock("../database_supabase", () => ({
  __esModule: true,
  Audit_log_category: { Bill: "Bill", Orders: "Orders", Tables: "Tables" },
  BILL_SECTION_AXES: ["course", "seat"],
  GetBillForTable: (...a: unknown[]) => GetBillForTable(...a),
  GetClosedBill: (...a: unknown[]) => GetClosedBill(...a),
  GetRestaurantSettings: jest.fn(async () => ({ currency: "₹", bill_paper_width: "80mm", timezone: "Asia/Kolkata" })),
  GetRestaurantProfile: jest.fn(async () => ({ outlet_name: "GAIA", outlet_add: "12 Main St", outlet_phone: null })),
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
  GetBillPaymentLedger: jest.fn(), GetBillTenderState: jest.fn(),
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
jest.mock("../kot_print", () => ({ __esModule: true, dispatchKot: jest.fn(), logKotDispatched: jest.fn() }));
jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: jest.fn(), emitOutlet: jest.fn() }));
jest.mock("../print_jobs", () => ({ __esModule: true, ackPrintJob: jest.fn() }));
jest.mock("../storage_bucket_supabase", () => ({ __esModule: true, uploadScreenshot: jest.fn() }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: jest.fn() }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

const ADD_ORDERS = "4ad474d4-5230-449c-874f-6a238b833bca";
const CLOSE_BILL = "a953d044-31ba-4e31-b96f-99304fe43dfa";
const ACCOUNTING = "df75119b-e5f1-4f38-aba5-78a1cf182f56";
const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";

const identity = (role: string, role_all: string[], actions: string[]) => ({
  res_id: RES, outlet_id: OUTLET, employeeId: "emp-1", role, role_all, actions,
});
const WAITER = identity("waiter", ["waiter"], [ADD_ORDERS]);
const MANAGER = identity("manager", ["manager"], [ADD_ORDERS, CLOSE_BILL, ACCOUNTING]);

const openBill = (printCount: number) => ({
  bill_id: "bill-1", table_id: "tbl-1", items: [{ name: "Paneer Tikka", price: 425, quantity: 10 }],
  subtotal: 4250, total_amt: 4250, covers: 4, discount_value: 0, discount_type: null,
  order_notes: [], order_ids: [], kot_nos: [], customer: null, bill_no: "B-1", coupon_code: null,
  print_count: printCount,
  bill_printed_at: printCount > 0 ? "2026-09-11T13:40:00.000Z" : null,
  printed_at: printCount > 0 ? "2026-09-11T13:40:00.000Z" : null,
});

const closedBill = {
  id: "bill-9", bill_no: "0421", table_name: "T7", covers: 2,
  items: [{ name: "Biryani", price: 390, quantity: 2, variation: null, note: null }],
  items_subtotal: 780, customer: "Alice", created_by: "JIM",
  discount_amount: 0, coupon_code: null,
  service_charge: 0, service_charge_percent: 0, taxes: [], grand_total: 780,
};

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
  GetClosedBill.mockReset();
  dispatchPrintJob.mockReset();
  dispatchPrintJob.mockResolvedValue({ jobId: "job-1", decision: { destinationName: "Front Till" }, assignedDeviceId: null });
});

/** The ESC/POS bytes the handler handed to the print router. */
const sentBytes = (): string => {
  expect(dispatchPrintJob).toHaveBeenCalledTimes(1);
  const job = dispatchPrintJob.mock.calls[0]![1] as { esc_base64: string };
  return Buffer.from(job.esc_base64, "base64").toString("latin1");
};

/**
 * The printed text of an ESC/POS stream, commands skipped BY THEIR OWN LENGTH.
 *
 * A regex strip is not enough since the bill gained solid raster rules: a
 * GS v 0 header carries its height as a byte, and a 10-dot rule's height IS
 * a newline, so a text split would cut a line in two inside a picture. Each image
 * becomes one "<RASTER>" line; GS L / GS W (the bill's margins) print nothing.
 */
const stripEscPos = (raw: string): string => {
  let out = "";
  for (let i = 0; i < raw.length;) {
    const c = raw.charCodeAt(i);
    if (c === 0x1b) { i += raw.charCodeAt(i + 1) === 0x40 ? 2 : 3; continue; }
    if (c === 0x1d) {
      const n = raw.charCodeAt(i + 1);
      if (n === 0x76) {
        const wb = raw.charCodeAt(i + 4) | (raw.charCodeAt(i + 5) << 8);
        const h = raw.charCodeAt(i + 6) | (raw.charCodeAt(i + 7) << 8);
        out += "\n<RASTER>\n";
        i += 8 + wb * h;
        continue;
      }
      if (n === 0x4c || n === 0x57) { i += 4; continue; }
      if (n === 0x28) { i += 5 + (raw.charCodeAt(i + 3) | (raw.charCodeAt(i + 4) << 8)); continue; }
      i += 3; // GS V n
      continue;
    }
    out += raw[i];
    i++;
  }
  return out;
};

/** Printed lines with every ESC/POS command removed, blanks dropped. */
const printedLines = (raw: string): string[] =>
  stripEscPos(raw)
    .split("\n")
    .filter((l) => l.trim());

/** Asserts REPRINT is the FIRST printed line, bold and double width+height. */
const expectReprintOnTop = (raw: string) => {
  expect(printedLines(raw)[0]).toBe("** REPRINT **");
  // Nothing printable precedes it: only init, the bill's margins (GS L 24 dots,
  // GS W 528 dots on the 80mm roll), alignment, then the bold+size run.
  expect(raw.startsWith("\x1b@\x1dL\x18\x00\x1dW\x10\x02\x1ba\x01\x1bE\x01\x1b!\x38** REPRINT **\n")).toBe(true);
};

describe("POST /print/bill — the open table's bill", () => {
  const print = (auth: unknown) =>
    harness.call("POST", "/print/bill", { body: { table_name: "T7" }, auth: auth as never });

  test("a FIRST print carries no REPRINT marker", async () => {
    GetBillForTable.mockResolvedValue(openBill(0));
    const r = await print(WAITER);
    expect(r.status).toBe(200);
    const raw = sentBytes();
    expect(raw).not.toContain("REPRINT");
    expect(printedLines(raw)[0]).toBe("GAIA");
  });

  test("…whoever makes it — a manager's first print is not a reprint either", async () => {
    GetBillForTable.mockResolvedValue(openBill(0));
    await print(MANAGER);
    expect(sentBytes()).not.toContain("REPRINT");
  });

  test("the senior reprint after C3 (print_count >= 1) puts REPRINT on the very first line", async () => {
    GetBillForTable.mockResolvedValue(openBill(1));
    const r = await print(MANAGER);
    expect(r.status).toBe(200);
    expectReprintOnTop(sentBytes());
  });

  test("…and on every later copy too", async () => {
    GetBillForTable.mockResolvedValue(openBill(5));
    await print(MANAGER);
    expectReprintOnTop(sentBytes());
  });
});

describe("POST /print/bill/settled — the accounting reprint", () => {
  test("REPRINT is the first printed line, bold and large", async () => {
    GetClosedBill.mockResolvedValue(closedBill);
    const r = await harness.call("POST", "/print/bill/settled", { body: { bill_id: "bill-9" }, auth: MANAGER as never });
    expect(r.status).toBe(200);
    expectReprintOnTop(sentBytes());
  });
});
