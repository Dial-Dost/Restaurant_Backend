// CLIENT ITEM 6 AT THE DOORS — the routes that print a bill, and the routes that
// add to one.
//
// ============================================================================
// WHAT THIS SUITE PINS
// ============================================================================
//   1. EVERY PRINT OPENS THE NEXT PARTY'S SEAT and says which: POST /print/bill,
//      POST /print/bill/claim and POST /print/bill/split answer
//      `next_party_table`, announce a new row as `table:added`, and a seat that
//      cannot be made never fails the print. A KOT is not a bill and opens
//      nothing.
//   2. THE MONEY GUARD on the three doors that add to a bill — POST /orders,
//      POST /orders/:id/items and the QR guest's POST /qr/:slug/order — and the
//      two doors that move food onto a table, POST /bills/merge and POST
//      /bills/move-item. Once the seating's bill is printed, a waiter-only login
//      and a QR guest get 423 `bill_printed` (never 409: that is "retry" to the
//      till's outbox) and NOTHING IS WRITTEN (the write is a mock and the
//      assertion is that it was never called); a senior role is allowed and told
//      `reprint_needed`, with the sentence and the table to reprint. The mirror
//      half is in every group: nothing printed, no print state, or 053 absent,
//      and the door is exactly what it was.
//   3. "12 #2" CANNOT BE MADE BY HAND on POST /add-table.
//   4. THE WIRING, from the source, so none of it is built and never called.
//
// The data layer is the REAL module with a handful of functions replaced: the
// question here is what each door does with the answers, and the answers
// themselves are next_party_tables.test.ts's business.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFakeApp, type FakeApp } from "./platform_fixtures";
import { BILL_PRINTED_CODE, BILL_PRINTED_STATUS, RESERVED_TABLE_NAME_ERROR } from "../next_party";
import { encodeTableToken } from "../qr_signing";

type AnyAsync = (...a: unknown[]) => Promise<unknown>;
const mockGuard = jest.fn<AnyAsync>();
const mockEnsure = jest.fn<AnyAsync>();
const mockAddOrder = jest.fn<AnyAsync>();
const mockGetOrders = jest.fn<AnyAsync>();
const mockUpdateSplit = jest.fn<AnyAsync>();
const mockGetBill = jest.fn<AnyAsync>();
const mockAddTable = jest.fn<AnyAsync>();
const mockEmit = jest.fn<(...a: unknown[]) => void>();
const mockDispatch = jest.fn<AnyAsync>();
const mockMerge = jest.fn<AnyAsync>();
const mockMoveItem = jest.fn<AnyAsync>();
const mockMoveParty = jest.fn<AnyAsync>();
const mockAudit = jest.fn<AnyAsync>();
const mockPaper = jest.fn<AnyAsync>();
const mockCopyPaper = jest.fn<AnyAsync>();

jest.mock("pg", () => {
  const query = async () => ({ rows: [] });
  class FakePool {
    on(): this { return this; }
    query() { return query(); }
    connect() { return Promise.resolve({ query, release: () => undefined }); }
    end() { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

jest.mock("../database_supabase", () => {
  const actual = jest.requireActual("../database_supabase") as Record<string, unknown>;
  return {
    ...actual,
    __esModule: true,
    GetOrderingPrintGuard: (...a: unknown[]) => mockGuard(...a),
    EnsureNextPartyTable: (...a: unknown[]) => mockEnsure(...a),
    AddOrder: (...a: unknown[]) => mockAddOrder(...a),
    GetOrders: (...a: unknown[]) => mockGetOrders(...a),
    UpdateOrderItemsSplit: (...a: unknown[]) => mockUpdateSplit(...a),
    applyMenuPriceFloor: async (_r: unknown, items: unknown[]) => items,
    GetBillForTable: (...a: unknown[]) => mockGetBill(...a),
    AddTable: (...a: unknown[]) => mockAddTable(...a),
    MergeTableBills: (...a: unknown[]) => mockMerge(...a),
    MoveBillItem: (...a: unknown[]) => mockMoveItem(...a),
    MoveTableParty: (...a: unknown[]) => mockMoveParty(...a),
    AddAuditLogEntry: (...a: unknown[]) => mockAudit(...a),
    RecordBillPrintPaper: (...a: unknown[]) => mockPaper(...a),
    CopyBillPrintPaper: (...a: unknown[]) => mockCopyPaper(...a),
    GetOutlets: async () => [{ id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb" }],
    GetRestaurantSettings: async () => ({ currency: "₹", bill_paper_width: "80mm", timezone: "Asia/Kolkata", auto_push_orders: true, bill_show_qr: false }),
    GetRestaurantProfile: async () => ({ outlet_name: "GGV", outlet_add: null, outlet_phone: null }),
    GetBillChargeConfigForTable: async () => ({
      taxConfig: {}, scPct: 0, includeServiceCharge: false, basis: "none",
      service_charge_removed: false, service_charge_applied: false, service_charge_percent: 0, waiver: null,
    }),
    // A resolvable actor, so an audit line can be written (and read back here).
    GetEmployeeDetailsFromEmpID: async () => ({ res_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", emp_Fname: "Atsu", emp_Lname: "" }),
    GetKotTableContext: async () => null,
    GetTableFeedbackContext: async () => null,
    RecordClientRenderedBillPrint: async () => ({ id: "job-claim", created_at: "2026-09-16T08:02:54.000Z" }),
    SplitBillForTable: async () => ({ parts: [{ label: "1 of 2", subtotal: 525, total: 525 }, { label: "2 of 2", subtotal: 525, total: 525 }] }),
    GetRestaurantAccountStatus: async () => "active",
    getRestaurantIdFromUsername: async () => "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    withTenant: async (_ctx: unknown, work: () => unknown) => work(),
    VerifyTableOtp: async () => ({ ok: true, required: false }),
    repriceFromMenu: async (_s: unknown, items: unknown[]) => items,
    AddNotification: async () => undefined,
  };
});
jest.mock("../print_routing", () => ({
  __esModule: true,
  dispatchPrintJob: (...a: unknown[]) => mockDispatch(...a),
}));
jest.mock("../kot_print", () => ({
  __esModule: true,
  dispatchKot: async () => ({ tickets: 1, stations: ["main"], kotNo: 7, businessDay: "2026-09-16", reprint: false }),
  logKotDispatched: () => undefined,
  autoPrintOrderKot: async () => ({ printed: true, kot_no: 11, tickets: 1 }),
  dispatchCancellationKot: async () => undefined,
}));
jest.mock("../escpos", () => ({
  __esModule: true,
  ...(jest.requireActual("../escpos") as Record<string, unknown>),
  buildReceiptBase64: () => "ZXNj",
  buildSplitReceiptsBase64: (_b: unknown, parts: { label: string; grand_total: number }[]) =>
    parts.map((p, i) => ({ index: i + 1, of: parts.length, label: p.label, grandTotal: p.grand_total, escBase64: "ZXNj" })),
}));
jest.mock("../realtime", () => ({
  __esModule: true,
  emitRestaurant: (...a: unknown[]) => mockEmit(...a),
  emitOutlet: () => undefined,
}));
jest.mock("../storage_bucket_supabase", () => ({ __esModule: true, uploadScreenshot: async () => null }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: async () => undefined }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

const ADD_ORDERS = "4ad474d4-5230-449c-874f-6a238b833bca";
const TABLE_ADDED = "194ce6ee-b867-4be3-b5f0-48c28ce0a81b";
const CLOSE_BILL = "a953d044-31ba-4e31-b96f-99304fe43dfa";
const RES = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OUTLET = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const identity = (role: string, role_all: string[], actions: string[]) => ({
  res_id: RES, outlet_id: OUTLET, employeeId: "emp-1", role, role_all, actions,
});
const WAITER = identity("waiter", ["waiter"], [ADD_ORDERS]);
const WAITER_WITH_CUSTOM_ROLE = identity("waiter", ["waiter", "d2b1f0c4-0000-4000-8000-000000000001"], [ADD_ORDERS]);
const SENIORS = [
  ["a manager", identity("manager", ["manager"], [ADD_ORDERS, CLOSE_BILL])],
  ["a cashier", identity("cashier", ["cashier"], [ADD_ORDERS, CLOSE_BILL])],
  ["a captain", identity("captain", ["captain"], [ADD_ORDERS])],
  ["an admin", identity("admin", ["admin"], ["*"])],
] as const;

const PRINTED = { table: "12", table_id: "t-12", parent_table: null, print_count: 1 };
const REPRINT_12 = {
  reprint_needed: true,
  reprint_message: "12's bill was already printed, so the paper no longer shows this. Reprint the bill before the guest pays.",
  reprint_table: "12",
};
const SEAT = { table_name: "12 #2", parent_table: "12", party_no: 2, created: true };

const bill = (printCount = 0) => ({
  bill_id: "bill-12", table_id: "t-12", items: [{ name: "Thali", price: 525, quantity: 2 }],
  subtotal: 1050, total_amt: 1050, grand_total: 1050, covers: 4, discount: 0, discount_value: 0, discount_type: null,
  service_charge: 0, service_charge_percent: 0, taxes: [], tax_total: 0, round_off: 0,
  order_notes: [], order_ids: ["o-1"], kot_nos: [], customer: null, customer_gstin: null, bill_no: "101", coupon_code: null,
  print_count: printCount, bill_printed_at: null, printed_at: null,
});

let harness: FakeApp;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  const bills = await import("../routes/bills");
  const orders = await import("../routes/orders");
  const guest = await import("../routes/guest");
  const tablesRoutes = await import("../routes/tables");
  harness = makeFakeApp();
  bills.registerBillPrintAndEditRoutes(harness.app as never);
  bills.registerBillOpsRoutes(harness.app as never);
  orders.registerOrderRoutes(harness.app as never);
  guest.registerGuestOrderingRoutes(harness.app as never);
  tablesRoutes.registerTableRoutes(harness.app as never);
});

beforeEach(() => {
  for (const m of [mockGuard, mockEnsure, mockAddOrder, mockGetOrders, mockUpdateSplit, mockGetBill, mockAddTable, mockEmit, mockDispatch, mockMerge, mockMoveItem, mockMoveParty, mockAudit, mockPaper, mockCopyPaper]) {
    m.mockReset();
  }
  mockAudit.mockResolvedValue(undefined);
  mockPaper.mockResolvedValue(true);
  mockCopyPaper.mockResolvedValue(true);
  mockMoveParty.mockResolvedValue({
    success: true, from_table: "12", to_table: "20", covers: 4, moved_orders: 2, total_amt: 1050,
    moved_bill: false, moved_session: true, moved_waiter: false, moved_prints: 1, printed: true, printed_as: "12",
  });
  mockGuard.mockResolvedValue({ table: "12", table_id: "t-12", parent_table: null, print_count: 0 });
  mockEnsure.mockResolvedValue(SEAT);
  mockAddOrder.mockResolvedValue({ id: "order-new" });
  mockMerge.mockResolvedValue({ success: true, total_amt: 1650, moved_orders: 1 });
  mockMoveItem.mockResolvedValue({ success: true, moved: { name: "Gulab Jamun" } });
  mockUpdateSplit.mockResolvedValue(undefined);
  mockGetBill.mockResolvedValue(bill());
  mockAddTable.mockResolvedValue({ _id: "t-new", table_name: "16", capacity: 4, max_capacity: 4, section: null });
  mockDispatch.mockResolvedValue({ jobId: "job-1", decision: { destinationName: "Front Till" }, assignedDeviceId: "dev-1" });
  mockGetOrders.mockResolvedValue([{
    id: "order-12", table: "12", items: [], items_split: [["Preparing", [{ id: "l1", name: "Thali", price: 525, quantity: 1 }]]],
  }]);
});

const tableAdded = () => mockEmit.mock.calls.filter((c) => c[1] === "table:added");
/** The audit descriptions written, in order (AddAuditLogEntry's fifth argument). */
const audited = (): string[] => mockAudit.mock.calls.map((c) => String(c[4]));

// ===========================================================================
describe("1. every bill print opens the next party's seat", () => {
  test("POST /print/bill answers next_party_table and announces the new row", async () => {
    const r = await harness.call("POST", "/print/bill", { body: { table_name: "12" }, auth: WAITER as never });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      success: true, next_party_table: "12 #2", next_party_message: "Seat the next party at 12 (next party).",
    });
    expect(mockEnsure).toHaveBeenCalledWith(RES, "12");
    expect(tableAdded()).toEqual([[RES, "table:added", { table_name: "12 #2", parent_table: "12", party_no: 2 }]]);
    // THE ORDER MATTERS: paper first, seat second.
    expect(mockDispatch.mock.invocationCallOrder[0]).toBeLessThan(mockEnsure.mock.invocationCallOrder[0]!);
  });

  test("a seat that already existed is named but not announced again", async () => {
    mockEnsure.mockResolvedValue({ ...SEAT, created: false });
    const r = await harness.call("POST", "/print/bill", { body: { table_name: "12" }, auth: SENIORS[0][1] as never });
    expect(r.body).toMatchObject({ next_party_table: "12 #2" });
    expect(tableAdded()).toEqual([]);
  });

  test.each([
    ["null (053 absent, or a takeaway)", async () => null],
    ["a throw", async () => { throw new Error("pool exhausted"); }],
  ])("a seat that cannot be made never fails the print — %s", async (_l, impl) => {
    mockEnsure.mockImplementation(impl);
    const r = await harness.call("POST", "/print/bill", { body: { table_name: "12" }, auth: WAITER as never });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, jobId: "job-1", next_party_table: null, next_party_message: null });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test("a KOT is not a bill: it opens nothing", async () => {
    const r = await harness.call("POST", "/print/bill", { body: { table_name: "12", kind: "kot" }, auth: WAITER as never });
    expect(r.status).toBe(200);
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  test("a waiter's REFUSED reprint opens nothing either", async () => {
    mockGetBill.mockResolvedValue(bill(1));
    const r = await harness.call("POST", "/print/bill", { body: { table_name: "12" }, auth: WAITER as never });
    expect(r.status).toBe(403);
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  test("POST /print/bill/claim (the web dashboard's print) answers it too", async () => {
    const r = await harness.call("POST", "/print/bill/claim", { body: { table_name: "12" }, auth: WAITER as never });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      success: true, recorded: true, next_party_table: "12 #2", next_party_message: "Seat the next party at 12 (next party).",
    });
  });

  test("POST /print/bill/split answers it too", async () => {
    const r = await harness.call("POST", "/print/bill/split", { body: { table_name: "12", parts: 2 }, auth: SENIORS[0][1] as never });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      success: true, parts: 2, next_party_table: "12 #2", next_party_message: "Seat the next party at 12 (next party).",
    });
  });
});

// ===========================================================================
describe("2a. POST /orders on a printed bill", () => {
  const order = { table: "12", items: [{ id: "i1", name: "Gulab Jamun", price: 120, quantity: 1 }], subtotal: 120, total: 120 };
  const place = (auth: unknown) => harness.call("POST", "/orders", { body: order, auth: auth as never });

  test.each([
    ["a waiter", WAITER],
    ["a waiter holding a custom role (the csrorganics shape)", WAITER_WITH_CUSTOM_ROLE],
  ])("%s is refused 423 bill_printed, pointed at '12 #2', and NOTHING is written", async (_l, who) => {
    mockGuard.mockResolvedValue(PRINTED);
    const r = await place(who);
    expect(r.status).toBe(423);
    expect(r.status).toBe(BILL_PRINTED_STATUS);
    expect(r.body).toEqual({
      error: "12's bill has already been printed, so nothing more can be added to it. Take a new party's order on 12 (next party), shown as \"12 #2\" on older apps. If it is for the same guests, ask a manager to add it and reprint the bill.",
      code: BILL_PRINTED_CODE,
      table: "12",
      next_party_table: "12 #2",
      next_party_action: "Take it on 12 (next party)",
      add_to_printed_action: "Add to 12's printed bill",
      add_to_printed_message: "12's bill has already been printed. Take a new party's order on 12 (next party), or, if it is for the same guests, add it to 12's printed bill and print the updated bill.",
      print_count: 1,
    });
    expect(mockAddOrder).not.toHaveBeenCalled();
    // The seat is made on the refusal path too, so the pointer is never dangling.
    expect(mockEnsure).toHaveBeenCalledWith(RES, "12");
  });

  test.each(SENIORS)("%s is allowed, and told the paper is now short (reprint_needed)", async (_l, who) => {
    mockGuard.mockResolvedValue(PRINTED);
    const r = await place(who);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: "order-new", ...REPRINT_12 });
    expect(mockAddOrder).toHaveBeenCalledTimes(1);
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  test.each([
    ["nothing printed yet", { ...PRINTED, print_count: 0 }],
    ["no print state (053 absent, a takeaway, an unknown table)", null],
  ])("the mirror half — %s: a waiter orders exactly as before", async (_l, state) => {
    mockGuard.mockResolvedValue(state);
    const r = await place(WAITER);
    expect(r.status).toBe(201);
    expect(r.body).not.toHaveProperty("reprint_needed");
    expect(r.body).not.toHaveProperty("reprint_message");
    expect(mockAddOrder).toHaveBeenCalledTimes(1);
  });

  test("a guard read that FAILS lets the order through (the order path is the one that must work)", async () => {
    mockGuard.mockRejectedValue(new Error("statement timeout"));
    const r = await place(WAITER);
    expect(r.status).toBe(201);
    expect(mockAddOrder).toHaveBeenCalledTimes(1);
  });

  // POST /orders IS ALSO THE DASHBOARD'S UPSERT: a status change resends the
  // order as it stands, and must not be refused on a printed table.
  test("a waiter's STATUS CHANGE on a printed table's order is not an addition: allowed, no reprint", async () => {
    const orderId = "0de70000-0000-4000-8000-000000000001";
    mockGuard.mockResolvedValue({ ...PRINTED, existing_lines: [{ id: "i1", quantity: 1 }] });
    const r = await harness.call("POST", "/orders", { body: { ...order, id: orderId, status: "Served" }, auth: WAITER as never });
    expect(r.status).toBe(201);
    expect(r.body).not.toHaveProperty("reprint_needed");
    expect(mockAddOrder).toHaveBeenCalledTimes(1);
    expect(mockGuard).toHaveBeenCalledWith(RES, "12", { orderId });
  });

  test("…but the same resend with a line ADDED is refused, and nothing is written", async () => {
    const orderId = "0de70000-0000-4000-8000-000000000001";
    mockGuard.mockResolvedValue({ ...PRINTED, existing_lines: [{ id: "i1", quantity: 1 }] });
    const grown = { ...order, id: orderId, items: [...order.items, { id: "i2", name: "Kulfi", price: 90, quantity: 1 }] };
    const r = await harness.call("POST", "/orders", { body: grown, auth: WAITER as never });
    expect(r.status).toBe(423);
    expect(r.body).toMatchObject({ code: BILL_PRINTED_CODE });
    expect(mockAddOrder).not.toHaveBeenCalled();
  });

  test("THE PARTIAL RESEND: the order's id and ONLY the new line — refused, though it is smaller by every total", async () => {
    // Stored: 4 x Thali (2,100). AddOrder keeps every stored line and appends
    // an unknown id, so this would have made the bill 2,220 against 2,100 paper.
    const orderId = "0de70000-0000-4000-8000-000000000001";
    mockGuard.mockResolvedValue({ ...PRINTED, existing_lines: [{ id: "thali", quantity: 4 }] });
    const r = await harness.call("POST", "/orders", {
      body: { table: "12", id: orderId, items: [{ id: "new-1", name: "Gulab Jamun", price: 120, quantity: 1 }] },
      auth: WAITER as never,
    });
    expect(r.status).toBe(423);
    expect(r.body).toMatchObject({ code: BILL_PRINTED_CODE, next_party_table: "12 #2" });
    expect(mockAddOrder).not.toHaveBeenCalled();
  });

  test("…and a same-size SWAP (one Thali fewer, one new 525 dish) is refused too", async () => {
    const orderId = "0de70000-0000-4000-8000-000000000001";
    mockGuard.mockResolvedValue({ ...PRINTED, existing_lines: [{ id: "thali", quantity: 4 }] });
    const r = await harness.call("POST", "/orders", {
      body: {
        table: "12", id: orderId,
        items: [{ id: "thali", name: "Thali", price: 525, quantity: 3 }, { id: "new-2", name: "Paneer Tikka", price: 525, quantity: 1 }],
      },
      auth: WAITER as never,
    });
    expect(r.status).toBe(423);
    expect(mockAddOrder).not.toHaveBeenCalled();
  });

  test("…and a manager's grown resend is allowed and told to reprint", async () => {
    const orderId = "0de70000-0000-4000-8000-000000000001";
    mockGuard.mockResolvedValue({ ...PRINTED, existing_lines: [{ id: "i1", quantity: 1 }] });
    const r = await harness.call("POST", "/orders", {
      body: { ...order, id: orderId, items: [{ ...order.items[0]!, quantity: 2 }] }, auth: SENIORS[0][1] as never,
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject(REPRINT_12);
  });

  test("an order on the SIBLING that is itself printed names its own next seat, in its root's words", async () => {
    mockGuard.mockResolvedValue({ table: "12 #2", table_id: "t-12-2", parent_table: "12", print_count: 1 });
    mockEnsure.mockResolvedValue({ table_name: "12 #3", parent_table: "12", party_no: 3, created: true });
    const r = await harness.call("POST", "/orders", { body: { ...order, table: "12 #2" }, auth: WAITER as never });
    expect(r.status).toBe(423);
    expect((r.body as { error: string }).error).toMatch(/^12 \(next party\)'s bill has already been printed/);
    expect(r.body).toMatchObject({ table: "12 #2", next_party_table: "12 #3", next_party_action: "Take it on 12 (next party)" });
  });
});

// ===========================================================================
describe("2b. POST /orders/:id/items on a printed bill", () => {
  const addItem = (auth: unknown) => harness.call("POST", "/orders/:id/items", {
    params: { id: "order-12" }, body: { name: "Gulab Jamun", price: 120, quantity: 1 }, auth: auth as never,
  });

  test("a waiter is refused on the ORDER's table, and the line is never written", async () => {
    mockGuard.mockResolvedValue(PRINTED);
    const r = await addItem(WAITER);
    expect(r.status).toBe(423);
    expect(r.body).toMatchObject({ code: BILL_PRINTED_CODE, table: "12", next_party_table: "12 #2" });
    expect(mockGuard).toHaveBeenCalledWith(RES, "12", { orderId: null });
    expect(mockUpdateSplit).not.toHaveBeenCalled();
  });

  test("a manager adds it and is told to reprint", async () => {
    mockGuard.mockResolvedValue(PRINTED);
    const r = await addItem(SENIORS[0][1]);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ success: true, ...REPRINT_12 });
    expect(mockUpdateSplit).toHaveBeenCalledTimes(1);
  });

  test("not printed: unchanged", async () => {
    const r = await addItem(WAITER);
    expect(r.status).toBe(201);
    expect(r.body).not.toHaveProperty("reprint_needed");
    expect(mockUpdateSplit).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
describe("2c. the QR guest on a printed bill", () => {
  const guestOrder = () => harness.call("POST", "/qr/:slug/order", {
    params: { slug: "ggv" },
    body: {
      t: encodeTableToken(RES, "12"),
      items: [{ id: "i1", name: "Gulab Jamun", price: 120, quantity: 1 }],
    },
    ip: `198.51.100.${String(Math.floor(Math.random() * 200) + 1)}`,
  });

  test("REFUSED, never rerouted: the scanner may be the next party", async () => {
    mockGuard.mockResolvedValue(PRINTED);
    const r = await guestOrder();
    expect(r.status).toBe(423);
    expect(r.body).toMatchObject({
      code: BILL_PRINTED_CODE,
      error: "This table's bill has already been printed, so nothing more can be ordered on it here. Please ask a member of staff.",
    });
    expect(mockAddOrder).not.toHaveBeenCalled();
    expect(mockGuard).toHaveBeenCalledWith("ggv", "12", { orderId: null });
  });

  test("a seat the refusal opens is announced in the res UUID's room — the one the dashboard joined — not the slug's", async () => {
    mockGuard.mockResolvedValue(PRINTED);
    await guestOrder();
    // The data layer is asked by slug, as the rest of this route is…
    expect(mockEnsure).toHaveBeenCalledWith("ggv", "12");
    // …and the floor hears about the new row where it is listening.
    expect(tableAdded()).toEqual([[RES, "table:added", { table_name: "12 #2", parent_table: "12", party_no: 2 }]]);
  });

  test("not printed: the guest's order is placed exactly as before", async () => {
    const r = await guestOrder();
    expect(r.status).toBe(201);
    expect(mockAddOrder).toHaveBeenCalledTimes(1);
    expect((mockAddOrder.mock.calls[0]![1] as { table: string }).table).toBe("12");
  });
});

// ===========================================================================
describe("2d. the two doors that move food ONTO a printed table", () => {
  const merge = (auth: unknown, to = "12") => harness.call("POST", "/bills/merge", {
    body: { from_table: "12 #2", to_table: to }, auth: auth as never,
  });
  const moveItem = (auth: unknown, to = "12") => harness.call("POST", "/bills/move-item", {
    body: { from_table: "15", to_table: to, item_name: "Gulab Jamun", price: 120 }, auth: auth as never,
  });

  test.each([
    ["POST /bills/merge", merge, "merge", () => mockMerge],
    ["POST /bills/move-item", moveItem, "move", () => mockMoveItem],
  ] as const)("%s: a waiter is refused 423 on the DESTINATION, no seat is made or offered, nothing is written", async (_l, call, verb, write) => {
    mockGuard.mockResolvedValue(PRINTED);
    const r = await call(WAITER);
    expect(r.status).toBe(423);
    expect(r.body).toEqual({
      error: `12's bill has already been printed, so nothing more can be added to it. Ask a manager to ${verb} it and reprint the bill.`,
      code: BILL_PRINTED_CODE,
      table: "12",
      next_party_table: null,
      next_party_action: null,
      add_to_printed_action: null,
      add_to_printed_message: null,
      print_count: 1,
    });
    expect(mockGuard).toHaveBeenCalledWith(RES, "12", { orderId: null });
    expect(write()).not.toHaveBeenCalled();
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(tableAdded()).toEqual([]);
  });

  test.each([
    ["POST /bills/merge", merge, () => mockMerge],
    ["POST /bills/move-item", moveItem, () => mockMoveItem],
  ] as const)("%s: a manager does it and is told to reprint 12", async (_l, call, write) => {
    mockGuard.mockResolvedValue(PRINTED);
    const r = await call(SENIORS[0][1]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, ...REPRINT_12 });
    expect(write()).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["POST /bills/merge", merge, () => mockMerge],
    ["POST /bills/move-item", moveItem, () => mockMoveItem],
  ] as const)("%s: the mirror half — onto an unprinted table, a waiter's answer is exactly what it was", async (_l, call, write) => {
    const r = await call(WAITER, "15");
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty("reprint_needed");
    expect(mockGuard).toHaveBeenCalledWith(RES, "15", { orderId: null });
    expect(write()).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
describe("2e. a waiter who CONFIRMED 'Add to printed bill' (2.0.2)", () => {
  const order = { table: "12", items: [{ id: "i1", name: "Gulab Jamun", price: 120, quantity: 1 }], subtotal: 120, total: 120 };

  test("POST /orders with add_to_printed_bill: allowed, told to print the updated bill, and audited AFTER the write", async () => {
    mockGuard.mockResolvedValue(PRINTED);
    const r = await harness.call("POST", "/orders", { body: { ...order, add_to_printed_bill: true }, auth: WAITER as never });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: "order-new", ...REPRINT_12 });
    expect(mockAddOrder).toHaveBeenCalledTimes(1);
    // No next-party seat: these are the same guests.
    expect(mockEnsure).not.toHaveBeenCalled();
    const line = audited().find((d) => d.startsWith("ADDED"));
    expect(line).toBe("ADDED an order on the printed bill of table 12 (printed 1 time(s))");
    const call = mockAudit.mock.calls.find((c) => String(c[4]).startsWith("ADDED"))!;
    expect(call[6]).toMatchObject({ table: "12", after_print: true, confirmed: true, waiter_only: true, print_count: 1 });
    expect(mockAudit.mock.invocationCallOrder[mockAudit.mock.calls.indexOf(call)]).toBeGreaterThan(mockAddOrder.mock.invocationCallOrder[0]!);
  });

  test("a write that FAILS files no addition line", async () => {
    mockGuard.mockResolvedValue(PRINTED);
    mockAddOrder.mockRejectedValue(new Error("Cannot add order to unoccupied table."));
    const r = await harness.call("POST", "/orders", { body: { ...order, add_to_printed_bill: true }, auth: WAITER as never });
    expect(r.status).toBe(400);
    expect(audited().filter((d) => d.startsWith("ADDED"))).toEqual([]);
  });

  test.each([
    ["the string \"true\"", "true"],
    ["1", 1],
    ["false", false],
  ])("anything but a literal true is no confirmation — %s is refused 423", async (_l, flag) => {
    mockGuard.mockResolvedValue(PRINTED);
    const r = await harness.call("POST", "/orders", { body: { ...order, add_to_printed_bill: flag }, auth: WAITER as never });
    expect(r.status).toBe(423);
    expect(mockAddOrder).not.toHaveBeenCalled();
  });

  test("POST /orders/:id/items with the flag: the line lands and the answer says reprint", async () => {
    mockGuard.mockResolvedValue(PRINTED);
    const r = await harness.call("POST", "/orders/:id/items", {
      params: { id: "order-12" }, body: { name: "Gulab Jamun", price: 120, quantity: 1, add_to_printed_bill: true }, auth: WAITER as never,
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ success: true, ...REPRINT_12 });
    expect(mockUpdateSplit).toHaveBeenCalledTimes(1);
    expect(audited()).toContain("ADDED an order on the printed bill of table 12 (printed 1 time(s))");
  });

  test.each([
    ["POST /bills/merge", "/bills/merge", { from_table: "12 #2", to_table: "12" }, () => mockMerge, "a merge into"],
    ["POST /bills/move-item", "/bills/move-item", { from_table: "15", to_table: "12", item_name: "Gulab Jamun", price: 120 }, () => mockMoveItem, "an item moved onto"],
  ] as const)("%s with the flag is STILL refused for a waiter: a merge or a moved item stays a manager's act", async (_l, path, body, write, what) => {
    mockGuard.mockResolvedValue(PRINTED);
    const r = await harness.call("POST", path, { body: { ...body, add_to_printed_bill: true }, auth: WAITER as never });
    expect(r.status).toBe(423);
    expect(r.body).toMatchObject({ code: "bill_printed", table: "12", add_to_printed_action: null, next_party_table: null });
    expect(write()).not.toHaveBeenCalled();
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(audited().filter((d) => d.startsWith("ADDED"))).toEqual([]);
    expect(audited()).toContain(`REFUSED ${what} table 12 — its bill was already printed 1 time(s)`);
  });

  test.each([
    ["POST /bills/merge", "/bills/merge", { from_table: "12 #2", to_table: "12" }, () => mockMerge, "a merge into"],
    ["POST /bills/move-item", "/bills/move-item", { from_table: "15", to_table: "12", item_name: "Gulab Jamun", price: 120 }, () => mockMoveItem, "an item moved onto"],
  ] as const)("%s by a SENIOR lands as before, flag or not, and is audited as not confirmed", async (_l, path, body, write, what) => {
    mockGuard.mockResolvedValue(PRINTED);
    const r = await harness.call("POST", path, { body: { ...body, add_to_printed_bill: true }, auth: SENIORS[0][1] as never });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject(REPRINT_12);
    expect(write()).toHaveBeenCalledTimes(1);
    expect(audited()).toContain(`ADDED ${what} the printed bill of table 12 (printed 1 time(s))`);
    const call = mockAudit.mock.calls.find((c) => String(c[4]).startsWith("ADDED"))!;
    expect(call[6]).toMatchObject({ confirmed: false, waiter_only: false });
  });

  test("a SENIOR's addition is audited too — confirmed: false, waiter_only: false", async () => {
    mockGuard.mockResolvedValue(PRINTED);
    const r = await harness.call("POST", "/orders", { body: order, auth: SENIORS[0][1] as never });
    expect(r.status).toBe(201);
    const call = mockAudit.mock.calls.find((c) => String(c[4]).startsWith("ADDED"))!;
    expect(call[6]).toMatchObject({ confirmed: false, waiter_only: false });
  });

  test("an unprinted table files no addition line, flag or not", async () => {
    const r = await harness.call("POST", "/orders", { body: { ...order, add_to_printed_bill: true }, auth: WAITER as never });
    expect(r.status).toBe(201);
    expect(r.body).not.toHaveProperty("reprint_needed");
    expect(audited().filter((d) => d.startsWith("ADDED"))).toEqual([]);
  });

  test("the QR GUEST is refused even when the body carries the flag", async () => {
    mockGuard.mockResolvedValue(PRINTED);
    const r = await harness.call("POST", "/qr/:slug/order", {
      params: { slug: "ggv" },
      body: { t: encodeTableToken(RES, "12"), items: [{ id: "i1", name: "Gulab Jamun", price: 120, quantity: 1 }], add_to_printed_bill: true },
      ip: "198.51.100.250",
    });
    expect(r.status).toBe(423);
    expect(mockAddOrder).not.toHaveBeenCalled();
    expect(r.body).toMatchObject({ add_to_printed_action: null });
  });
});

// ===========================================================================
describe("2f. moving a PRINTED party opens the green seat at the destination", () => {
  const MOVER = identity("waiter", ["waiter"], ["090ea8d4-e348-4e1b-9723-11131a73a085"]);
  const move = () => harness.call("POST", "/tables/move", { body: { from_table: "12", to_table: "20" }, auth: MOVER as never });

  test("printed: the destination's next-party seat is made and named, after the move", async () => {
    mockEnsure.mockResolvedValue({ table_name: "20 #2", parent_table: "20", party_no: 2, created: true });
    const r = await move();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      to_table: "20", printed: true, printed_as: "12",
      next_party_table: "20 #2", next_party_message: "Seat the next party at 20 (next party).",
    });
    expect(mockEnsure).toHaveBeenCalledWith(RES, "20");
    expect(mockEnsure.mock.invocationCallOrder[0]).toBeGreaterThan(mockMoveParty.mock.invocationCallOrder[0]!);
    expect(tableAdded()).toEqual([[RES, "table:added", { table_name: "20 #2", parent_table: "20", party_no: 2 }]]);
    expect(audited().find((d) => d.startsWith("Moved the party"))).toBe(
      "Moved the party at 12 to 20 (4 covers, 2 orders, no bill yet, printed bill carried — the paper says 12)",
    );
  });

  test("not printed: no seat, and the answer is the move's own", async () => {
    mockMoveParty.mockResolvedValue({
      success: true, from_table: "12", to_table: "20", covers: 2, moved_orders: 1, total_amt: 300,
      moved_bill: true, moved_session: true, moved_waiter: true, moved_prints: 0, printed: false, printed_as: null,
    });
    const r = await move();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ printed: false, next_party_table: null, next_party_message: null });
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  test("a seat that cannot be made never fails the move", async () => {
    mockEnsure.mockRejectedValue(new Error("pool exhausted"));
    const r = await move();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ printed: true, next_party_table: null });
  });

  test("the data layer's refusal (the same family) is the 400 the till shows", async () => {
    mockMoveParty.mockRejectedValue(new Error("12 (next party) is the same table as 12 — pick a different table to move to."));
    const r = await harness.call("POST", "/tables/move", { body: { from_table: "12", to_table: "12 #2" }, auth: MOVER as never });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "12 (next party) is the same table as 12 — pick a different table to move to." });
    expect(mockEnsure).not.toHaveBeenCalled();
  });
});

// ===========================================================================
describe("2g. GET /bill-for-table says whether the paper is out of date", () => {
  const READ = identity("manager", ["manager"], ["98b10bde-802d-4a5b-a726-53a826424f79", CLOSE_BILL]);
  const WAITER_READ = identity("waiter", ["waiter"], ["98b10bde-802d-4a5b-a726-53a826424f79"]);
  const read = (auth: unknown) => harness.call("GET", "/bill-for-table", { query: { table_name: "12" }, auth: auth as never });
  const printedWith = async (digest: string | null) => ({ ...bill(1), last_paper_digest: digest, printed_total: 1050, printed_as: null });
  // The fingerprint of bill(1) as printOpenTableBill would print it under this
  // harness's charge config (no taxes, no service charge).
  const sameDigest = async (): Promise<string> => {
    const { billPaperDigest } = await import("../bill_paper_digest");
    const { computeBillCharges } = await import("../billing_math");
    return billPaperDigest({ items: bill(1).items, charges: computeBillCharges(1050, {}, 0, false, undefined), customerGstin: null });
  };

  test("unchanged since the print -> paper_stale false; the fingerprint itself is never sent", async () => {
    mockGetBill.mockResolvedValue(await printedWith(await sameDigest()));
    const r = await read(READ);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ paper_stale: false, printed_total: 1050 });
    expect(r.body).not.toHaveProperty("last_paper_digest");
  });

  test("changed since the print -> paper_stale true", async () => {
    mockGetBill.mockResolvedValue(await printedWith("0".repeat(64)));
    expect((await read(READ)).body).toMatchObject({ paper_stale: true });
  });

  test("printed before 055 (nothing recorded) -> null, and never printed -> null", async () => {
    mockGetBill.mockResolvedValue(await printedWith(null));
    expect((await read(READ)).body).toMatchObject({ paper_stale: null });
    mockGetBill.mockResolvedValue({ ...bill(0), last_paper_digest: null, printed_total: null, printed_as: null });
    expect((await read(READ)).body).toMatchObject({ paper_stale: null });
  });

  test("a waiter is told the paper is stale, but not the total it said", async () => {
    mockGetBill.mockResolvedValue(await printedWith("0".repeat(64)));
    const body = (await read(WAITER_READ)).body as Record<string, unknown>;
    expect(body.paper_stale).toBe(true);
    expect(body).not.toHaveProperty("printed_total");
    expect(body).not.toHaveProperty("last_paper_digest");
  });

  // The claim hands the browser the PRICED bill to print (C4's one exception),
  // and a waiter may now make that claim on stale paper. The old paper's record
  // is not part of the receipt, for them or anyone.
  test.each([
    ["a waiter's updated print", () => WAITER],
    ["a senior's print", () => SENIORS[0][1]],
  ])("POST /print/bill/claim — %s: printable_bill carries the amounts, never the old paper's digest or total", async (_l, who) => {
    mockGetBill.mockResolvedValue(await printedWith("0".repeat(64)));
    const r = await harness.call("POST", "/print/bill/claim", { body: { table_name: "12" }, auth: who() as never });
    expect(r.status).toBe(200);
    const printable = (r.body as { printable_bill: Record<string, unknown> }).printable_bill;
    expect(printable).toMatchObject({ bill_id: "bill-12", grand_total: 1050, subtotal: 1050, items: bill(1).items });
    expect(printable).not.toHaveProperty("last_paper_digest");
    expect(printable).not.toHaveProperty("printed_total");
    expect(r.body).toMatchObject({ revised: true });
    expect(JSON.stringify(r.body)).not.toContain("0".repeat(64));
  });
});

// ===========================================================================
// A SPLIT-PRINTED TABLE KEEPS ITS STALE-PAPER TRACKING. Every part is a counted
// print of this seating, and whichever part is the latest job is "the paper",
// so every part must carry the whole bill's record — or the tile reads unknown
// and a waiter can never print the updated bill. (Review of 2.0.2: disabling
// this record left every suite green.)
describe("2h. POST /print/bill/split files what its paper said, on every part", () => {
  const split = () => harness.call("POST", "/print/bill/split", { body: { table_name: "12", parts: 2 }, auth: SENIORS[0][1] as never });

  test("RecordBillPrintPaper gets EVERY part's job id and the WHOLE bill's record, after the parts are out", async () => {
    mockDispatch
      .mockResolvedValueOnce({ jobId: "job-part-1", decision: { destinationName: "Front Till" }, assignedDeviceId: "dev-1" })
      .mockResolvedValueOnce({ jobId: "job-part-2", decision: { destinationName: "Front Till" }, assignedDeviceId: "dev-1" });
    const r = await split();
    expect(r.status).toBe(200);
    expect(mockDispatch).toHaveBeenCalledTimes(2);
    expect(mockPaper).toHaveBeenCalledTimes(1);
    const { billPaperDigest, billLinesDigest } = await import("../bill_paper_digest");
    const { computeBillCharges } = await import("../billing_math");
    expect(mockPaper).toHaveBeenCalledWith(RES, ["job-part-1", "job-part-2"], {
      bill_digest: billPaperDigest({ items: bill(0).items, charges: computeBillCharges(1050, {}, 0, false, undefined), customerGstin: null }),
      lines_digest: billLinesDigest(bill(0).items),
      bill_grand_total: 1050,
      table_name: "12",
    });
    expect(mockPaper.mock.invocationCallOrder[0]).toBeGreaterThan(mockDispatch.mock.invocationCallOrder[1]!);
  });

  test("a record that cannot be written never fails the split print", async () => {
    mockPaper.mockRejectedValue(new Error("pool exhausted"));
    const r = await split();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, parts: 2 });
  });
});

// ===========================================================================
// THE WEB PRINT PAGE'S "Print ESC/POS" sends the claim's paper to a till as a
// NEWER counted job of the same bill. It names the claim's job, and the publish
// takes that job's record — or the seating's paper reads unknown from then on.
describe("2i. POST /publish/bill carries the claim's paper record", () => {
  const PUBLISH = "2ae797d9-2bef-4419-a33d-ab09590dbef9";
  const PRINTER = identity("waiter", ["waiter"], [ADD_ORDERS, PUBLISH]);
  const CLAIM_JOB = "9a000000-0000-4000-8000-000000000001";
  const publish = (extra: Record<string, unknown>) => harness.call("POST", "/publish/bill", {
    body: { billId: "bill-12", escBase64: "ZXNj", ...extra }, auth: PRINTER as never,
  });

  test("with the claim's job id: the new job takes that record, after it is dispatched", async () => {
    const r = await publish({ paperJobId: CLAIM_JOB });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, jobId: "job-1", destination: "Front Till", device: "dev-1" });
    expect(mockDispatch).toHaveBeenCalledWith(RES, expect.objectContaining({ bill_id: "bill-12", kind: "bill" }));
    expect(mockCopyPaper).toHaveBeenCalledWith(RES, CLAIM_JOB, "job-1");
    expect(mockCopyPaper.mock.invocationCallOrder[0]).toBeGreaterThan(mockDispatch.mock.invocationCallOrder[0]!);
  });

  test("without one (an older page, or no claim): published exactly as before, nothing copied", async () => {
    const r = await publish({});
    expect(r.status).toBe(200);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockCopyPaper).not.toHaveBeenCalled();
  });

  test("no durable job (027 absent): nothing to copy onto", async () => {
    mockDispatch.mockResolvedValue({ jobId: null, decision: { destinationName: null }, assignedDeviceId: null });
    const r = await publish({ paperJobId: CLAIM_JOB });
    expect(r.status).toBe(200);
    expect(mockCopyPaper).not.toHaveBeenCalled();
  });
});

// ===========================================================================
describe("3. '12 #2' cannot be made by hand", () => {
  test.each(["12 #2", "Patio 4 #13", " 7 #2 "])("POST /add-table refuses %p in words, before anything is written", async (name) => {
    const r = await harness.call("POST", "/add-table", {
      body: { table: { name, capacity: 4 } }, auth: identity("admin", ["admin"], ["*"]) as never,
    });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: RESERVED_TABLE_NAME_ERROR, code: "reserved_table_name" });
    expect(mockAddTable).not.toHaveBeenCalled();
  });

  test("an ordinary name is added as before", async () => {
    const r = await harness.call("POST", "/add-table", {
      body: { table: { name: "16", capacity: 4 } }, auth: identity("admin", ["admin"], [TABLE_ADDED]) as never,
    });
    expect(r.status).toBe(200);
    expect(mockAddTable).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
describe("4. the wiring — nothing here is built and never called", () => {
  const ROOT = join(__dirname, "..");
  const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
  const DB = read("database_supabase.ts");
  const chunk = (src: string, name: string): string => {
    const at = src.search(new RegExp(`^(?:export )?async function ${name}\\(`, "m"));
    expect({ name, found: at > -1 }).toEqual({ name, found: true });
    const next = src.slice(at + 1).search(/^(?:export )?(?:async )?function /m);
    return src.slice(at, next < 0 ? undefined : at + 1 + next);
  };
  const handler = (src: string, start: string): string => {
    const at = src.indexOf(start);
    expect({ start, found: at > -1 }).toEqual({ start, found: true });
    const end = src.indexOf("\napp.", at + 1);
    return src.slice(at, end < 0 ? undefined : end);
  };

  test.each([
    ["printOpenTableBill", "routes/bills.ts"],
    ["claimClientRenderedBillPrint", "routes/bills.ts"],
  ])("%s asks for the next party's seat AFTER it prints", (name, file) => {
    const body = chunk(read(file), name);
    const seat = body.indexOf("await nextPartyAfterPrint(");
    expect(seat).toBeGreaterThan(-1);
    const paper = Math.max(body.indexOf("await dispatchPrintJob("), body.indexOf("await RecordClientRenderedBillPrint("));
    expect(seat).toBeGreaterThan(paper);
    expect(body).toMatch(/next_party_table: nextPartyTable/);
  });

  test("the split print and the waiver print carry it; /print/bill answers it", () => {
    const bills = read("routes/bills.ts");
    expect(handler(bills, "app.post('/print/bill/split'")).toMatch(/await nextPartyAfterPrint\(req, restaurantId, tableName\)[\s\S]*next_party_table: nextPartyTable/);
    expect(handler(bills, "app.post('/print/bill',")).toMatch(/next_party_table: printed\.next_party_table/);
    expect(read("routes/mis_capture.ts")).toMatch(/next_party_table: out\.next_party_table/);
  });

  test("POST /orders passes the order it may be upserting to the guard", () => {
    expect(handler(read("routes/orders.ts"), 'app.post("/orders",'))
      .toMatch(/upsert: \{ orderId: typeof body\.id === "string" \? body\.id : null, items: body\.items \}/);
    // …and the other two doors never do: a new line and a guest order always add.
    expect(handler(read("routes/orders.ts"), "app.post('/orders/:id/items'")).not.toMatch(/upsert:/);
    expect(handler(read("routes/guest.ts"), 'app.post("/qr/:slug/order"')).not.toMatch(/upsert:/);
  });

  test.each([
    ["routes/orders.ts", 'app.post("/orders",', "await AddOrder("],
    ["routes/orders.ts", "app.post('/orders/:id/items'", "await UpdateOrderItemsSplit("],
    ["routes/guest.ts", 'app.post("/qr/:slug/order"', "await AddOrder("],
    ["routes/bills.ts", "app.post('/bills/merge'", "await MergeTableBills("],
    ["routes/bills.ts", "app.post('/bills/move-item'", "await MoveBillItem("],
  ])("%s %s refuses BEFORE it writes", (file, start, write) => {
    const body = handler(read(file), start);
    const guard = body.indexOf("refuseOrderOnPrintedBill(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf(write));
    expect(body).toMatch(/if \(guard\.refused\) \{return;\}/);
  });

  test("the merge and the move are judged on the DESTINATION, as what they are, and answer the reprint", () => {
    const bills = read("routes/bills.ts");
    expect(handler(bills, "app.post('/bills/merge'")).toMatch(/tableName: toTable, guest: false, write: "merge"/);
    expect(handler(bills, "app.post('/bills/move-item'")).toMatch(/tableName: toTable, guest: false, write: "move"/);
    for (const start of ["app.post('/bills/merge'", "app.post('/bills/move-item'"]) {
      expect(handler(bills, start)).toMatch(/res\.json\(\{ \.\.\.result, \.\.\.reprintNeededFields\(guard\) \}\)/);
    }
    for (const start of ['app.post("/orders",', "app.post('/orders/:id/items'"]) {
      expect(handler(read("routes/orders.ts"), start)).toMatch(/\.\.\.reprintNeededFields\(guard\),/);
    }
    // The QR route announces in the res UUID's room.
    expect(handler(read("routes/guest.ts"), 'app.post("/qr/:slug/order"')).toMatch(/emitRestaurantId: roomId/);
    // The refusal's status is the constant, never a literal 409.
    const shared = read("routes/_shared.ts");
    expect(shared).toMatch(/res\.status\(BILL_PRINTED_STATUS\)\.json\(billPrintedRefusal\(/);
    expect(shared).not.toMatch(/res\.status\(409\)\.json\(billPrintedRefusal/);
  });

  test("the guard reads the stored LINES and judges the upsert line by line", () => {
    expect(read("routes/_shared.ts")).toMatch(/orderUpsertAddsToBill\(upsert\.items, state\.existing_lines \?\? null\)/);
    expect(chunk(DB, "GetOrderingPrintGuard")).toMatch(/existingLines = storedOrderLines\(parseJsonObject\(orderRows\[0\]\.food\) \?\? \{\}\)/);
  });

  test.each([
    "ReleaseTable", "ApproveBillPaymentByAdmin", "CloseBillByOrder",
    "FinalizeOnlinePayment", "MergeTableBills", "MoveTableParty",
  ])("%s tidies the family of the table it freed", (name) => {
    expect(chunk(DB, name)).toMatch(/await (?:retireIdleNextPartyTables\(context, tableId\)|afterTableFreed\(freed\))/);
  });

  test.each([
    "ApproveBillPaymentByAdmin", "CloseBillByOrder", "FinalizeOnlinePayment", "MergeTableBills", "MoveTableParty",
  ])("%s tidies AFTER its transaction, never inside the settle", (name) => {
    const body = chunk(DB, name);
    const txnEnd = body.lastIndexOf("  });");
    expect(body.indexOf("await afterTableFreed(freed)")).toBeGreaterThan(txnEnd);
  });

  test("a booking is for a ROOM table, and un-seating one tidies the family it freed", () => {
    expect(chunk(DB, "AssignTableToBooking")).toMatch(/const onlyRooms = await roomTableOnlySql\(\);[\s\S]*\$\{onlyRooms\}/);
    expect(chunk(DB, "resolveCombinedTables")).toMatch(/const onlyRooms = await roomTableOnlySql\(\);[\s\S]*\$\{onlyRooms\}/);
    expect(chunk(DB, "AddTable")).toMatch(/const onlyRooms = await roomTableOnlySql\(\);/);
    const unseat = chunk(DB, "UpdateBookingStatus");
    // After the release statement, outside its try: a tidy-up never throws.
    expect(unseat.indexOf("await retireIdleNextPartyTables(context, releasedId)"))
      .toBeGreaterThan(unseat.indexOf("release_table_on_unseat_failed"));
  });

  test("table-wise labels fold to the root; the seating key, money and covers do not", () => {
    const apc = chunk(DB, "GetMonthlyApcInsights");
    expect(apc).toMatch(/table_label: row\.parent_table_name \|\| row\.table_name/);
    expect(apc).toMatch(/left join "Tables" pt\s+on pt\.id = t\.parent_table_id/);
    // THE KEY stays the row's own bill / own name: folding it would add "12 #2"'s
    // money and covers into 12's seating.
    expect(apc).toMatch(/const key = o\.bill_id \?\? `open:\$\{o\.table_name \|\| o\.order_id\}`;/);
    expect(apc).not.toMatch(/const key = [^\n]*table_label/);
  });

  test("RemoveTable and OccupyTable carry the delete guard and the offline revive", () => {
    expect(chunk(DB, "RemoveTable")).toMatch(/await nextPartyDeleteGuard\(context, table\.id\)/);
    expect(chunk(DB, "OccupyTable")).toMatch(/await reviveRetiredNextPartyTable\(context, normalized\)/);
    expect(chunk(DB, "AddTable")).toMatch(/isReservedPartyName\(normalized\)/);
  });

  test("the seating start is the same helper on both payloads", () => {
    expect(chunk(DB, "GetBillForTable")).toMatch(/seatingStartOf\(bill\?\.created_at \?\? null, orderRows\[0\]\?\.created_at \?\? null\)/);
    expect(chunk(DB, "GetTables")).toMatch(/seatingStartOf\(bill\?\.created_at \?\? null, firstOrderAtByTable\.get\(row\.id\) \?\? null\)/);
    // The order guard and the move share ONE seating read, and it bounds with the helper.
    expect(chunk(DB, "GetOrderingPrintGuard")).toMatch(/await currentSeatingPrintState\(context, table\)/);
    expect(chunk(DB, "currentSeatingPrintState")).toMatch(/seatingStartOf\(billRows\[0\]\?\.created_at \?\? null, firstOrder\[0\]\?\.first_at \?\? null\)/);
    expect(chunk(DB, "MoveTableParty")).toMatch(/await currentSeatingPrintState\(freed\.context, \{ id: dstId, table_name: moved\.to_table \}\)/);
    expect(chunk(DB, "rekeyMovedPartyPrints")).toMatch(/seatingStartOf\(startRows\[0\]\?\.bill_created_at \?\? null, startRows\[0\]\?\.first_order_at \?\? null\)/);
  });

  test.each([
    ["routes/orders.ts", 'app.post("/orders",', "await AddOrder("],
    ["routes/orders.ts", "app.post('/orders/:id/items'", "await UpdateOrderItemsSplit("],
    ["routes/bills.ts", "app.post('/bills/merge'", "await MergeTableBills("],
    ["routes/bills.ts", "app.post('/bills/move-item'", "await MoveBillItem("],
  ])("%s %s files the printed-bill addition AFTER its write lands", (file, start, write) => {
    const body = handler(read(file), start);
    const note = body.indexOf("await noteAdditionToPrintedBill(req, guard)");
    expect(note).toBeGreaterThan(body.indexOf(write));
  });

  test("the QR route never reads the intent flag — a guest is refused whatever the body says", () => {
    expect(handler(read("routes/guest.ts"), 'app.post("/qr/:slug/order"')).not.toMatch(/confirmedPrinted|add_to_printed_bill/);
    // ...and the staff guard honours it for an ORDER only (a merge or a moved item never).
    expect(read("routes/_shared.ts")).toMatch(/const confirmedPrinted = write === "order" && \(target\.confirmedPrinted \?\? addToPrintedBillFlag\(req\.body\)\);/);
  });

  test("every bill print files what its paper said, AFTER the paper is out", () => {
    const bills = read("routes/bills.ts");
    const print = chunk(bills, "printOpenTableBill");
    expect(print.indexOf("await recordPaper(restaurantId, [dispatched.jobId]")).toBeGreaterThan(print.indexOf("await dispatchPrintJob("));
    const claim = chunk(bills, "claimClientRenderedBillPrint");
    expect(claim.indexOf("await recordPaper(restaurantId, [recorded.id], paper)")).toBeGreaterThan(claim.indexOf("await RecordClientRenderedBillPrint("));
    const split = handler(bills, "app.post('/print/bill/split'");
    expect(split.indexOf("await recordPaper(restaurantId, jobs.map((j) => j.jobId)")).toBeGreaterThan(split.indexOf("await dispatchPrintJob("));
    // ...as a statement of its own: nothing in front of it on its line (2h drives it).
    expect(split).toMatch(/\n[ \t]*await recordPaper\(restaurantId, jobs\.map\(\(j\) => j\.jobId\)/);
    // The recorder is the data layer's, and the three gate callers pass the tenant.
    expect(bills).toMatch(/await RecordBillPrintPaper\(restaurantId, jobIds, paper\)/);
    expect(handler(bills, "app.post('/print/bill',")).toMatch(/refuseWaiterBillReprint\(req, res, tableName, bill, restaurantId\)/);
    expect(handler(bills, "app.post('/print/bill/claim'")).toMatch(/refuseWaiterBillReprint\(req, res, tableName, bill, restaurantId\)/);
    expect(read("routes/mis_capture.ts")).toMatch(/refuseWaiterBillReprint\(req, res, tableName, bill, restaurantId\)/);
  });

  test("the bill read and the gate compare through ONE fingerprint", () => {
    const bills = read("routes/bills.ts");
    expect(chunk(bills, "billPaperStale")).toMatch(/paperStale\(await currentPaperDigest\(restaurantId, tableName, bill\), bill\.last_paper_digest\)/);
    expect(chunk(bills, "refuseWaiterBillReprint")).toMatch(/await billPaperStale\(restaurantId, tableName, bill\)/);
    expect(handler(read("routes/tables.ts"), 'app.get("/bill-for-table"')).toMatch(/paper_stale: await billPaperStale\(restaurantId, tableName, result\)/);
    // And the floor tile compares the lines through the data layer's own read.
    expect(chunk(DB, "GetTables")).toMatch(/paperStale\(billLinesDigest\(paperLinesByTable\.get\(row\.id\) \?\? \[\]\), prints\.paper\?\.lines_digest\)/);
    expect(chunk(DB, "RecordBillPrintPaper")).toMatch(/update "PrintJobs"/);
  });

  test("the boot step issues 055 before the server listens", () => {
    const index = read("index.ts");
    const boot = index.indexOf("await InitPrintJobPaperSchema()");
    expect(boot).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(index.indexOf("httpServer.listen("));
  });

  test("the boot step issues 053 before the server listens", () => {
    const index = read("index.ts");
    const boot = index.indexOf("await InitTableNextPartySchema()");
    expect(boot).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(index.indexOf("httpServer.listen("));
  });

  test("every new data-layer export has a shipping caller", () => {
    const shipping = ["routes/_shared.ts", "routes/bills.ts", "routes/orders.ts", "routes/guest.ts", "routes/tables.ts", "index.ts"]
      .map(read).join("\n");
    for (const name of ["EnsureNextPartyTable", "GetOrderingPrintGuard", "InitTableNextPartySchema"]) {
      expect({ name, called: new RegExp(`\\b${name}\\(`).test(shipping) }).toEqual({ name, called: true });
    }
    for (const name of ["nextPartyAfterPrint", "refuseOrderOnPrintedBill"]) {
      const callers = ["routes/bills.ts", "routes/orders.ts", "routes/guest.ts"].filter((f) => read(f).includes(`${name}(`));
      expect({ name, callers: callers.length > 0 }).toEqual({ name, callers: true });
    }
  });
});
