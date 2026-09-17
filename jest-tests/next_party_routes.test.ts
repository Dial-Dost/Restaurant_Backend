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
    GetRestaurantSettings: async () => ({ currency: "₹", bill_paper_width: "80mm", timezone: "Asia/Kolkata", auto_push_orders: true, bill_show_qr: false }),
    GetRestaurantProfile: async () => ({ outlet_name: "GGV", outlet_add: null, outlet_phone: null }),
    GetBillChargeConfigForTable: async () => ({
      taxConfig: {}, scPct: 0, includeServiceCharge: false, basis: "none",
      service_charge_removed: false, service_charge_applied: false, service_charge_percent: 0, waiver: null,
    }),
    GetEmployeeDetailsFromEmpID: async () => null,
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
  for (const m of [mockGuard, mockEnsure, mockAddOrder, mockGetOrders, mockUpdateSplit, mockGetBill, mockAddTable, mockEmit, mockDispatch, mockMerge, mockMoveItem]) {
    m.mockReset();
  }
  mockGuard.mockResolvedValue({ table: "12", table_id: "t-12", parent_table: null, print_count: 0 });
  mockEnsure.mockResolvedValue(SEAT);
  mockAddOrder.mockResolvedValue({ id: "order-new" });
  mockMerge.mockResolvedValue({ success: true, total_amt: 1650, moved_orders: 1 });
  mockMoveItem.mockResolvedValue({
    success: true,
    moved: { name: "Gulab Jamun", price: 120, quantity: 1, lines: [], value: 120 },
    items: [{ name: "Gulab Jamun", variation: null, quantity: 1 }],
    destinations: [],
  });
  mockUpdateSplit.mockResolvedValue(undefined);
  mockGetBill.mockResolvedValue(bill());
  mockAddTable.mockResolvedValue({ _id: "t-new", table_name: "16", capacity: 4, max_capacity: 4, section: null });
  mockDispatch.mockResolvedValue({ jobId: "job-1", decision: { destinationName: "Front Till" }, assignedDeviceId: "dev-1" });
  mockGetOrders.mockResolvedValue([{
    id: "order-12", table: "12", items: [], items_split: [["Preparing", [{ id: "l1", name: "Thali", price: 525, quantity: 1 }]]],
  }]);
});

const tableAdded = () => mockEmit.mock.calls.filter((c) => c[1] === "table:added");

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

  // CLIENT ITEM 4 — A MOVE CHANGES TWO BILLS. The SOURCE of a moved dish is held
  // to the same rule: its paper would go on charging for food that has left.
  const sourcePrinted = (): void => {
    mockGuard.mockImplementation(async (_r: unknown, table: unknown) => (String(table) === "15"
      ? { table: "15", table_id: "t-15", parent_table: null, print_count: 2 }
      : { table: String(table), table_id: "t-x", parent_table: null, print_count: 0 }));
  };

  test("POST /bills/move-item: a waiter is refused 423 when the SOURCE's bill is printed, and nothing is written", async () => {
    sourcePrinted();
    const r = await moveItem(WAITER, "12");
    expect(r.status).toBe(423);
    expect(r.body).toEqual({
      error: "15's bill has already been printed, so nothing can be moved off it. Ask a manager to move it and reprint the bill.",
      code: BILL_PRINTED_CODE,
      table: "15",
      next_party_table: null,
      next_party_action: null,
      print_count: 2,
    });
    expect(mockGuard).toHaveBeenCalledWith(RES, "15", { orderId: null });
    expect(mockMoveItem).not.toHaveBeenCalled();
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  test("POST /bills/move-item: a manager moves it off a printed source and is told to reprint THAT table", async () => {
    sourcePrinted();
    const r = await moveItem(SENIORS[0][1], "12");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, reprint_needed: true, reprint_table: "15" });
    expect(r.body).not.toHaveProperty("also_reprint_needed");
    expect(mockMoveItem).toHaveBeenCalledTimes(1);
  });

  test("POST /bills/move-item: both papers printed — the destination first, the source as also_reprint", async () => {
    mockGuard.mockImplementation(async (_r: unknown, table: unknown) => ({ table: String(table), table_id: `t-${String(table)}`, parent_table: null, print_count: 1 }));
    const r = await moveItem(SENIORS[1][1], "12");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ reprint_needed: true, reprint_table: "12", also_reprint_needed: true, also_reprint_table: "15" });
    expect(String((r.body as Record<string, unknown>).also_reprint_message)).toMatch(/^15's bill was already printed/);
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
    // Client item 4: a move is judged on its SOURCE too, and answers both reprints.
    expect(handler(bills, "app.post('/bills/move-item'")).toMatch(/tableName: fromTable, guest: false, write: "move_off"/);
    expect(handler(bills, "app.post('/bills/merge'")).toMatch(/res\.json\(\{ \.\.\.result, \.\.\.reprintNeededFields\(guard\) \}\)/);
    expect(handler(bills, "app.post('/bills/move-item'")).toMatch(/\.\.\.moveReprintFields\(guard, sourceGuard\) \}\)/);
    const tablesRoutes = read("routes/tables.ts");
    expect(handler(tablesRoutes, 'app.post("/tables/move-order"')).toMatch(/tableName: toTable, guest: false, write: "move"/);
    expect(handler(tablesRoutes, 'app.post("/tables/move-order"')).toMatch(/tableName: sourceTable, guest: false, write: "move_off"/);
    expect(handler(tablesRoutes, 'app.post("/tables/move-order"')).toMatch(/\.\.\.moveReprintFields\(destinationGuard, sourceGuard\)/);
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
    expect(chunk(DB, "GetOrderingPrintGuard")).toMatch(/seatingStartOf\(/);
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
