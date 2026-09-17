// CLIENT ITEM 4 AT THE DOORS — POST /tables/move-order, POST /tables/move and
// POST /bills/move-item, the REAL handlers over a fake app with the data
// layer's writes and the printers replaced (move_names.test.ts drives the real
// writers; kot_item_move.test.ts the real printers).
//
// Production's audit line for GGV's KOT-65 read "Moved order
// 5a4099ef-98c9-4310-9237-f44b98dc7bac from 12 to 15 (correction docket KOT-65
// printed)", and Bill Edit dropped it. What is pinned here: the line names the
// ticket and its dishes and Bill Edit reads it; the answer carries the dishes
// and the KOT for both clients; both tables' printed bills are judged before
// anything moves; a dish move asks for the KOT numbers BEFORE it moves, prints
// the moved dish under them after, and names all of it on the record.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { makeFakeApp, type FakeApp } from "./platform_fixtures";
import { classifyBillEdit } from "../mis_report_math";

type AnyAsync = (...a: unknown[]) => Promise<unknown>;
const mockAudit = jest.fn<AnyAsync>();
const mockMoveOrder = jest.fn<AnyAsync>();
const mockMoveParty = jest.fn<AnyAsync>();
const mockMoveItem = jest.fn<AnyAsync>();
const mockCtx = jest.fn<AnyAsync>();
const mockKotNos = jest.fn<AnyAsync>();
const mockGuard = jest.fn<AnyAsync>();
const mockSources = jest.fn<AnyAsync>();
const mockMoveSlip = jest.fn<AnyAsync>();
const mockResolveKots = jest.fn<AnyAsync>();
const mockItemSlip = jest.fn<AnyAsync>();
const mockEmit = jest.fn<(...a: unknown[]) => void>();

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
    AddAuditLogEntry: (...a: unknown[]) => mockAudit(...a),
    GetEmployeeDetailsFromEmpID: async () => ({ res_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" }),
    MoveOrderToTable: (...a: unknown[]) => mockMoveOrder(...a),
    MoveTableParty: (...a: unknown[]) => mockMoveParty(...a),
    MoveBillItem: (...a: unknown[]) => mockMoveItem(...a),
    GetOrderKotContext: (...a: unknown[]) => mockCtx(...a),
    GetOrderKotNumbers: (...a: unknown[]) => mockKotNos(...a),
    GetOrderingPrintGuard: (...a: unknown[]) => mockGuard(...a),
    GetMovableLineSources: (...a: unknown[]) => mockSources(...a),
    EnsureNextPartyTable: async () => null,
    GetRestaurantAccountStatus: async () => "active",
    withTenant: async (_ctx: unknown, work: () => unknown) => work(),
  };
});
jest.mock("../kot_move", () => ({
  __esModule: true,
  printKotTableChange: (...a: unknown[]) => mockMoveSlip(...a),
  resolveMoveSourceKots: (...a: unknown[]) => mockResolveKots(...a),
  printKotItemMove: (...a: unknown[]) => mockItemSlip(...a),
}));
jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: (...a: unknown[]) => mockEmit(...a), emitOutlet: () => undefined }));
jest.mock("../storage_bucket_supabase", () => ({ __esModule: true, uploadScreenshot: async () => null }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: async () => undefined }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

const ADD_ORDERS = "4ad474d4-5230-449c-874f-6a238b833bca";
const TABLE_OCC = "090ea8d4-e348-4e1b-9723-11131a73a085";
const RES = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OUTLET = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ORDER = "5a4099ef-98c9-4310-9237-f44b98dc7bac";
const who = (role: string, actions: string[]) => ({ res_id: RES, outlet_id: OUTLET, employeeId: `emp-${role}`, employeeUsername: role, role, role_all: [role], actions });
const ADMIN = who("admin", ["*"]);
const MANAGER = who("manager", [ADD_ORDERS, TABLE_OCC]);
const WAITER = who("waiter", [ADD_ORDERS, TABLE_OCC]);

const GGV_DISHES = [
  { name: "KUNAFA BIRDS NEST", variation: null, quantity: 1 },
  { name: "STIR FRIED WATERCHESTNUT", variation: null, quantity: 1 },
  { name: "TRUFFLE CREAM CHEESE", variation: null, quantity: 1 },
];
const moved = (over: Record<string, unknown> = {}) => ({
  success: true, order_id: ORDER, outlet_id: OUTLET,
  from_table: "12", from_table_id: "t-12", to_table: "15", to_table_id: "t-15",
  seated_destination: false, total_amt: 3763, source_now_empty: true,
  items: GGV_DISHES, kot_nos: [65],
  ...over,
});
const unprinted = (table: unknown) => ({ table: String(table), table_id: `t-${String(table)}`, parent_table: null, print_count: 0 });
const printed = (table: unknown) => ({ table: String(table), table_id: `t-${String(table)}`, parent_table: null, print_count: 1 });

let h: FakeApp;
beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  const tables = await import("../routes/tables");
  const bills = await import("../routes/bills");
  h = makeFakeApp();
  tables.registerTableRoutes(h.app as never);
  bills.registerBillPrintAndEditRoutes(h.app as never);
});

beforeEach(() => {
  for (const m of [mockAudit, mockMoveOrder, mockMoveParty, mockMoveItem, mockCtx, mockKotNos, mockGuard, mockSources, mockMoveSlip, mockResolveKots, mockItemSlip, mockEmit]) { m.mockReset(); }
  mockAudit.mockResolvedValue(true);
  mockMoveOrder.mockResolvedValue(moved());
  mockCtx.mockResolvedValue({ order_id: ORDER, table_name: "12", items: [] });
  mockKotNos.mockResolvedValue(new Map());
  mockGuard.mockImplementation(async (_r: unknown, table: unknown) => unprinted(table));
  mockMoveSlip.mockResolvedValue({ printed: true, kot_no: 65, tickets: 1 });
  mockSources.mockResolvedValue([{ order_id: "src-1", lines: [{ id: "l1", name: "NOT YOUR PUCHKA", price: 469, quantity: 1 }] }]);
  mockResolveKots.mockResolvedValue(new Map([["src-1", [35]]]));
  mockMoveItem.mockResolvedValue({
    success: true,
    moved: { name: "NOT YOUR PUCHKA", price: 469, quantity: 1, lines: [{ name: "NOT YOUR PUCHKA", price: 469, quantity: 1 }], value: 469 },
    items: [{ name: "NOT YOUR PUCHKA", variation: null, quantity: 1 }],
    destinations: [{ order_id: "new-1", source_order_id: "src-1", kot_nos: [35], items: [{ name: "NOT YOUR PUCHKA", variation: null, quantity: 1 }] }],
  });
  mockItemSlip.mockResolvedValue({ printed: true, kot_no: 35, tickets: 1 });
});

// AddAuditLogEntry(res_id, outlet_id, employee_id, action_id, description, category, details)
const audits = () => mockAudit.mock.calls.map((c) => ({ reason: String(c[4]), details: c[6] as Record<string, unknown> }));
const lastAudit = () => {
  const all = audits();
  return all[all.length - 1]!;
};

// ===========================================================================
describe("POST /tables/move-order — the ticket, by name", () => {
  const moveOrder = (auth: unknown, to = "15") => h.call("POST", "/tables/move-order", { body: { order_id: ORDER, to_table: to }, auth: auth as never });

  test("the audit line names the KOT and every dish, and Bill Edit now reads it as an order move", async () => {
    const r = await moveOrder(ADMIN);
    expect(r.status).toBe(200);
    const { reason, details } = lastAudit();
    expect(reason).toBe("Moved KOT-65 (KUNAFA BIRDS NEST x1; STIR FRIED WATERCHESTNUT x1; TRUFFLE CREAM CHEESE x1) from 12 to 15 (correction docket printed)");
    expect(reason).not.toContain(ORDER);
    expect(details).toMatchObject({ order_id: ORDER, table: "15", from: "12", to: "15", kot_no: 65, item: "KUNAFA BIRDS NEST x1; STIR FRIED WATERCHESTNUT x1; TRUFFLE CREAM CHEESE x1" });
    expect(classifyBillEdit(ADD_ORDERS, reason, details)).toMatchObject({
      kind: "order_moved", table: "15", order_id: ORDER, item: "KUNAFA BIRDS NEST x1; STIR FRIED WATERCHESTNUT x1; TRUFFLE CREAM CHEESE x1",
    });
  });

  test("the answer carries the dishes (no price) and the KOT, for both clients' confirmations", async () => {
    const r = await moveOrder(WAITER);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ items: GGV_DISHES, kot_no: 65, kot_nos: [65], print: { printed: true, kot_no: 65 } });
    expect(JSON.stringify((r.body as { items: unknown }).items)).not.toMatch(/price/);
    expect(r.body).not.toHaveProperty("reprint_needed");
    // Who pressed it is recorded on the move.
    expect(mockMoveOrder).toHaveBeenCalledWith(RES, ORDER, "15", { by: "waiter" });
    // The realtime event names the ticket too.
    expect(mockEmit).toHaveBeenCalledWith(RES, "table:order_moved", expect.objectContaining({ kot_no: 65 }));
  });

  test("with dockets off, the ticket is still named by the number already printed for it", async () => {
    mockMoveSlip.mockResolvedValue({ printed: false, kot_no: null, tickets: 0, reason: "disabled" });
    mockMoveOrder.mockResolvedValue(moved({ kot_nos: [65] }));
    const r = await moveOrder(ADMIN);
    expect(lastAudit().reason).toBe("Moved KOT-65 (KUNAFA BIRDS NEST x1; STIR FRIED WATERCHESTNUT x1; TRUFFLE CREAM CHEESE x1) from 12 to 15 (automatic dockets are off)");
    expect((r.body as { kot_no: unknown }).kot_no).toBe(65);
  });

  test("an order the kitchen never had: 'Moved order (…)', no number", async () => {
    mockMoveSlip.mockResolvedValue({ printed: false, kot_no: null, tickets: 0, reason: "never_ticketed" });
    mockMoveOrder.mockResolvedValue(moved({ kot_nos: [] }));
    const r = await moveOrder(ADMIN);
    expect(lastAudit().reason).toBe("Moved order (KUNAFA BIRDS NEST x1; STIR FRIED WATERCHESTNUT x1; TRUFFLE CREAM CHEESE x1) from 12 to 15 (no docket was on the pass)");
    expect((r.body as { kot_no: unknown }).kot_no).toBeNull();
  });

  test("BOTH BILLS ARE JUDGED, destination first, then the source the order is on now", async () => {
    await moveOrder(WAITER);
    expect(mockGuard.mock.calls.map((c) => c[1])).toEqual(["15", "12"]);
    expect(mockCtx).toHaveBeenCalledWith(RES, ORDER);
  });

  test("a waiter moving onto a printed bill: 423, nothing moved, nothing printed", async () => {
    mockGuard.mockImplementation(async (_r: unknown, t: unknown) => (String(t) === "15" ? printed(t) : unprinted(t)));
    const r = await moveOrder(WAITER);
    expect(r.status).toBe(423);
    expect((r.body as { error: string }).error).toBe("15's bill has already been printed, so nothing more can be added to it. Ask a manager to move it and reprint the bill.");
    expect(mockMoveOrder).not.toHaveBeenCalled();
    expect(mockMoveSlip).not.toHaveBeenCalled();
  });

  test("a waiter moving OFF a printed bill: 423 with the source's own sentence, nothing moved", async () => {
    mockGuard.mockImplementation(async (_r: unknown, t: unknown) => (String(t) === "12" ? printed(t) : unprinted(t)));
    const r = await moveOrder(WAITER);
    expect(r.status).toBe(423);
    expect(r.body).toMatchObject({
      code: "bill_printed", table: "12", next_party_table: null, next_party_action: null,
      error: "12's bill has already been printed, so nothing can be moved off it. Ask a manager to move it and reprint the bill.",
    });
    expect(mockMoveOrder).not.toHaveBeenCalled();
    expect(audits().some((a) => a.reason === "REFUSED a move off table 12 — its bill was already printed 1 time(s)")).toBe(true);
  });

  test("a manager between two printed bills moves it and is told to reprint BOTH", async () => {
    mockGuard.mockImplementation(async (_r: unknown, t: unknown) => printed(t));
    const r = await moveOrder(MANAGER);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      reprint_needed: true, reprint_table: "15",
      reprint_message: "15's bill was already printed, so the paper no longer shows this. Reprint the bill before the guest pays.",
      also_reprint_needed: true, also_reprint_table: "12",
      also_reprint_message: "12's bill was already printed, so the paper no longer shows this. Reprint the bill before the guest pays.",
    });
  });

  test("an order that does not exist skips the source check and meets the writer's own refusal", async () => {
    mockCtx.mockResolvedValue(null);
    mockMoveOrder.mockRejectedValue(new Error("Order not found"));
    const r = await moveOrder(ADMIN);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "Order not found" });
    expect(mockGuard.mock.calls.map((c) => c[1])).toEqual(["15"]);
  });
});

// ===========================================================================
describe("POST /tables/move — the party's tickets on the record", () => {
  test("the audit details carry the KOT numbers and the dishes; the sentence is unchanged", async () => {
    mockMoveParty.mockResolvedValue({
      success: true, from_table: "15", to_table: "12", covers: 2, moved_orders: 2, total_amt: 900,
      moved_bill: true, moved_session: true, moved_waiter: true,
      moved_order_ids: ["o1", "o2"],
      moved_items: [{ name: "Dal", variation: "Half", quantity: 2 }, { name: "Naan", variation: null, quantity: 1 }],
    });
    mockKotNos.mockResolvedValue(new Map([["o1", [3]], ["o2", [5, 3]]]));
    const r = await h.call("POST", "/tables/move", { body: { from_table: "15", to_table: "12" }, auth: WAITER as never });
    expect(r.status).toBe(200);
    const { reason, details } = lastAudit();
    expect(reason).toBe("Moved the party at 15 to 12 (2 covers, 2 orders, bill carried)");
    expect(details).toMatchObject({ kot_nos: [3, 5], items: "Dal (Half) x2; Naan x1", moved_order_ids: ["o1", "o2"] });
  });

  test("an unreadable KOT number costs the detail, never the move", async () => {
    mockMoveParty.mockResolvedValue({ success: true, from_table: "15", to_table: "12", covers: 2, moved_orders: 0, total_amt: 0, moved_bill: false, moved_session: false, moved_waiter: false, moved_order_ids: [], moved_items: [] });
    mockKotNos.mockRejectedValue(new Error("down"));
    const r = await h.call("POST", "/tables/move", { body: { from_table: "15", to_table: "12" }, auth: WAITER as never });
    expect(r.status).toBe(200);
    expect(lastAudit().details).toMatchObject({ kot_nos: [], items: null });
  });
});

// ===========================================================================
describe("POST /bills/move-item — the dish, the kitchen and the record", () => {
  const moveItem = (auth: unknown, body: Record<string, unknown> = {}) => h.call("POST", "/bills/move-item", {
    body: { from_table: "31A", to_table: "31", item_name: "NOT YOUR PUCHKA", price: 469, ...body }, auth: auth as never,
  });

  test("the KOT is resolved BEFORE the move, handed to it, and the moved dish prints under it AFTER", async () => {
    const order: string[] = [];
    mockSources.mockImplementation(async () => { order.push("sources"); return [{ order_id: "src-1", lines: [{ id: "l1" }] }]; });
    mockResolveKots.mockImplementation(async () => { order.push("resolve"); return new Map([["src-1", [35]]]); });
    const base = await mockMoveItem.getMockImplementation()?.() ?? {};
    mockMoveItem.mockImplementation(async () => { order.push("move"); return base; });
    mockItemSlip.mockImplementation(async () => { order.push("print"); return { printed: true, kot_no: 35, tickets: 1 }; });

    const r = await moveItem(ADMIN);
    expect(r.status).toBe(200);
    expect(order).toEqual(["sources", "resolve", "move", "print"]);
    expect(mockSources).toHaveBeenCalledWith(RES, "31A", "NOT YOUR PUCHKA", 469);
    expect(mockResolveKots).toHaveBeenCalledWith(RES, [{ order_id: "src-1", lines: [{ id: "l1" }] }]);
    const opts = mockMoveItem.mock.calls[0]![5] as { by: string; kotNosByOrder: Map<string, number[]> };
    expect(opts.by).toBe("admin");
    expect([...opts.kotNosByOrder.entries()]).toEqual([["src-1", [35]]]);
    expect(mockItemSlip).toHaveBeenCalledWith({ restaurantId: RES, orderId: "new-1", previousTableName: "31A", kotNo: 35 });
  });

  test("the audit line names the dish, the quantity and the KOT — and Bill Edit still reads it as an item move", async () => {
    await moveItem(ADMIN);
    const { reason, details } = lastAudit();
    expect(reason).toBe("Moved item NOT YOUR PUCHKA x1 from 31A (KOT-35) to 31");
    expect(details).toMatchObject({ from: "31A", to: "31", kot_nos: [35], order_ids: ["new-1"], source_order_ids: ["src-1"] });
    expect(classifyBillEdit(ADD_ORDERS, reason, details)?.kind).toBe("item_moved");
  });

  test("the answer says what printed, per destination order", async () => {
    const r = await moveItem(ADMIN);
    expect(r.body).toMatchObject({
      success: true, kot_nos: [35],
      items: [{ name: "NOT YOUR PUCHKA", variation: null, quantity: 1 }],
      prints: [{ order_id: "new-1", printed: true, kot_no: 35, tickets: 1 }],
    });
  });

  test("a never-ticketed dish: the printer is asked with no number (and prints nothing); the line has no KOT", async () => {
    mockResolveKots.mockResolvedValue(new Map([["src-1", []]]));
    mockMoveItem.mockResolvedValue({
      success: true, moved: { name: "NOT YOUR PUCHKA", price: 469, quantity: 1, lines: [], value: 469 },
      items: [{ name: "NOT YOUR PUCHKA", variation: null, quantity: 1 }],
      destinations: [{ order_id: "new-1", source_order_id: "src-1", kot_nos: [], items: [] }],
    });
    mockItemSlip.mockResolvedValue({ printed: false, kot_no: null, tickets: 0, reason: "never_ticketed" });
    await moveItem(ADMIN);
    expect(mockItemSlip).toHaveBeenCalledWith(expect.objectContaining({ kotNo: null }));
    expect(lastAudit().reason).toBe("Moved item NOT YOUR PUCHKA x1 from 31A to 31");
  });

  test("an unreadable pre-read costs the docket, never the move", async () => {
    mockSources.mockRejectedValue(new Error("down"));
    mockResolveKots.mockResolvedValue(new Map());
    const r = await moveItem(ADMIN);
    expect(r.status).toBe(200);
    expect(mockResolveKots).toHaveBeenCalledWith(RES, []);
  });

  test("A COMPED DISH: the writer's refusal is the answer, verbatim, and nothing prints", async () => {
    mockMoveItem.mockRejectedValue(new Error("NOT YOUR PUCHKA is non-chargeable on 31A. Reverse the comp first, then move it."));
    const r = await moveItem(ADMIN);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "NOT YOUR PUCHKA is non-chargeable on 31A. Reverse the comp first, then move it." });
    expect(mockItemSlip).not.toHaveBeenCalled();
    expect(audits().some((a) => a.reason.startsWith("Moved item"))).toBe(false);
  });
});
