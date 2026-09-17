// CLIENT ITEM 4 — THE KITCHEN'S HALF OF MOVING ONE DISH (kot_move.ts).
//
// A dish moved from 31A to 31 used to print nothing and carry no number, so on
// every screen it sat in "No KOT number" as a fresh ticket — to the kitchen, a
// second order for food it was already cooking. Two things are pinned here:
//
//   1. THE NUMBER IS RESOLVED, NEVER MINTED, AND BEFORE THE MOVE: the ticket key
//      (the added-line docket for a single line, then the whole-order docket),
//      else the first number PrintJobs attributes to the order, else none. A
//      Pending order has none, whatever the table's paper says.
//   2. THE DOCKET: only the moved dish, on the new table, under that number,
//      headed "*** MOVED FROM 31A ***", grouped under the NEW order's
//      `order-<id>` so migration 043 attributes the number to it. Nothing
//      prints for a never-ticketed dish or with dockets off, and nothing here
//      ever throws at the route.
import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";

type AnyAsync = (...a: unknown[]) => Promise<unknown>;
const mockCtx = jest.fn<AnyAsync>();
const mockPrinted = jest.fn<AnyAsync>();
const mockSettings = jest.fn<AnyAsync>();
const mockLookup = jest.fn<AnyAsync>();
const mockDispatch = jest.fn<AnyAsync>();

jest.mock("pg", () => {
  class FakePool {
    on(): this { return this; }
    query() { return Promise.resolve({ rows: [] }); }
    connect() { return Promise.resolve({ query: () => Promise.resolve({ rows: [] }), release: () => undefined }); }
    end() { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});
jest.mock("../database_supabase", () => {
  // The real module (kot_print reads its day-key helpers), less the reads.
  const actual = jest.requireActual("../database_supabase") as Record<string, unknown>;
  return {
    ...actual,
    __esModule: true,
    GetOrderKotContext: (...a: unknown[]) => mockCtx(...a),
    GetOrderKotNumbers: (...a: unknown[]) => mockPrinted(...a),
    GetRestaurantSettings: (...a: unknown[]) => mockSettings(...a),
    GetRestaurantProfile: async () => ({ outlet_name: "GGV" }),
    GetTableFeedbackContext: async () => ({ employee_name: "Atsu", employee_role: "waiter" }),
    LookupKotNumber: (...a: unknown[]) => mockLookup(...a),
  };
});
jest.mock("../kot_print", () => {
  const actual = jest.requireActual("../kot_print") as Record<string, unknown>;
  return { ...actual, __esModule: true, dispatchKot: (...a: unknown[]) => mockDispatch(...a) };
});
jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: () => undefined, emitOutlet: () => undefined }));

let km: typeof import("../kot_move");
let kp: typeof import("../kot_print");

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  km = await import("../kot_move");
  kp = await import("../kot_print");
});

const OUTLET = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ctx = (over: Record<string, unknown> = {}) => ({
  order_id: "src-1", outlet_id: OUTLET, table_id: "t-31a", table_name: "31A", section: "Patio", covers: 3,
  is_virtual: false, order_type: "dine_in", awaiting_approval: false, order_note: null,
  items: [{ name: "NOT YOUR PUCHKA", price: 469, quantity: 1 }, { name: "MOCKMEAT SAMOSA", price: 399, quantity: 1 }],
  ...over,
});
const PUCHKA = { id: "l1", name: "NOT YOUR PUCHKA", price: 469, quantity: 1, note: "extra chutney", menu_id: "m-1" };

beforeEach(() => {
  for (const m of [mockCtx, mockPrinted, mockSettings, mockLookup, mockDispatch]) { m.mockReset(); }
  mockSettings.mockResolvedValue({ timezone: "Asia/Kolkata", currency: "₹", bill_paper_width: "80mm", kot_auto_print: true });
  mockPrinted.mockResolvedValue(new Map());
  mockLookup.mockResolvedValue(null);
  mockDispatch.mockResolvedValue({ tickets: 1, stations: ["main"], kotNo: 35, businessDay: "2026-09-14", reprint: true, jobIds: [], devices: [], skipped: false, billId: "x" });
});

describe("resolveMoveSourceKots — the number on the paper, read before the move", () => {
  test("a single moved line: its added-line docket is asked FIRST, by the line's own scoped key", async () => {
    mockCtx.mockResolvedValue(ctx());
    mockLookup.mockImplementationOnce(async () => ({ kot_no: 36, business_day: "2026-09-14" }));
    const out = await km.resolveMoveSourceKots("ggv", [{ order_id: "src-1", lines: [PUCHKA] }]);
    expect(out.get("src-1")).toEqual([36]);
    const firstKey = String(mockLookup.mock.calls[0]![1]);
    const scoped = kp.buildKotTicketKey({
      outletId: OUTLET, tableId: "t-31a",
      items: [{ name: "NOT YOUR PUCHKA", quantity: 1, price: 469, note: "extra chutney", menu_id: "m-1" }],
      firedAt: mockLookup.mock.calls[0]![2] as Date, tz: "Asia/Kolkata", scope: "l1",
    });
    expect(firstKey).toBe(scoped);
  });

  test("…then the whole-order docket", async () => {
    mockCtx.mockResolvedValue(ctx());
    mockLookup.mockResolvedValueOnce(null).mockResolvedValueOnce({ kot_no: 35, business_day: "2026-09-14" });
    const out = await km.resolveMoveSourceKots("ggv", [{ order_id: "src-1", lines: [PUCHKA] }]);
    expect(out.get("src-1")).toEqual([35]);
    expect(mockLookup).toHaveBeenCalledTimes(2);
  });

  test("a key that no longer matches (the order was edited since it printed) falls back to the FIRST printed number", async () => {
    mockCtx.mockResolvedValue(ctx());
    mockPrinted.mockResolvedValue(new Map([["src-1", [35, 40]]]));
    const out = await km.resolveMoveSourceKots("ggv", [{ order_id: "src-1", lines: [PUCHKA, { ...PUCHKA, id: "l9" }] }]);
    expect(out.get("src-1")).toEqual([35]);
    // Two lines: no scoped key to ask, only the whole order.
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });

  test("a PENDING order was never ticketed — no number, whatever PrintJobs says, and no key is asked", async () => {
    mockCtx.mockResolvedValue(ctx({ awaiting_approval: true }));
    mockPrinted.mockResolvedValue(new Map([["src-1", [12]]]));
    const out = await km.resolveMoveSourceKots("ggv", [{ order_id: "src-1", lines: [PUCHKA] }]);
    expect(out.get("src-1")).toEqual([]);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  test("never ticketed at all: an empty list, not an error", async () => {
    mockCtx.mockResolvedValue(ctx());
    const out = await km.resolveMoveSourceKots("ggv", [{ order_id: "src-1", lines: [PUCHKA] }]);
    expect(out.get("src-1")).toEqual([]);
  });

  test("every read can fail and the answer is still a map", async () => {
    mockCtx.mockRejectedValue(new Error("db down"));
    mockPrinted.mockRejectedValue(new Error("db down"));
    mockSettings.mockRejectedValue(new Error("db down"));
    const out = await km.resolveMoveSourceKots("ggv", [{ order_id: "src-1", lines: [PUCHKA] }, { order_id: "src-2", lines: [] }]);
    expect([...out.entries()]).toEqual([["src-1", []], ["src-2", []]]);
  });

  test("no sources, no reads", async () => {
    expect((await km.resolveMoveSourceKots("ggv", [])).size).toBe(0);
    expect(mockPrinted).not.toHaveBeenCalled();
    expect(mockCtx).not.toHaveBeenCalled();
  });
});

describe("printKotItemMove — the moved dish's docket on its new table", () => {
  const dest = ctx({ order_id: "new-1", table_id: "t-31", table_name: "31", items: [{ name: "NOT YOUR PUCHKA", price: 469, quantity: 1, note: "extra chutney" }], order_note: "no peanuts" });

  test("pinned to the number the pass knows, headed MOVED FROM, grouped under the new order", async () => {
    mockCtx.mockResolvedValue(dest);
    const out = await km.printKotItemMove({ restaurantId: "ggv", orderId: "new-1", previousTableName: "31a", kotNo: 35 });
    expect(out).toEqual({ printed: true, kot_no: 35, tickets: 1 });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0]![0]).toMatchObject({
      restaurantId: "ggv", outletId: OUTLET, tableName: "31", tableId: "t-31",
      items: dest.items, orderNote: "no peanuts",
      billId: "order-new-1", pinnedKotNo: 35, skipIfTicketed: false,
      contextLine: "*** MOVED FROM 31A ***", assignedTo: "Atsu",
    });
    expect(mockCtx).toHaveBeenCalledWith("ggv", "new-1");
  });

  test.each([
    ["never ticketed", { kotNo: null }, "never_ticketed"],
    ["a zero number", { kotNo: 0 }, "never_ticketed"],
  ] as const)("%s: nothing prints and nothing is read", async (_l, over, reason) => {
    const out = await km.printKotItemMove({ restaurantId: "ggv", orderId: "new-1", previousTableName: "31A", ...over });
    expect(out).toEqual({ printed: false, kot_no: null, tickets: 0, reason });
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockCtx).not.toHaveBeenCalled();
  });

  test("dockets switched off: nothing prints, the number is still reported", async () => {
    mockSettings.mockResolvedValue({ kot_auto_print: false });
    const out = await km.printKotItemMove({ restaurantId: "ggv", orderId: "new-1", previousTableName: "31A", kotNo: 35 });
    expect(out).toEqual({ printed: false, kot_no: 35, tickets: 0, reason: "disabled" });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test("a Pending destination prints nothing", async () => {
    mockCtx.mockResolvedValue({ ...dest, awaiting_approval: true });
    const out = await km.printKotItemMove({ restaurantId: "ggv", orderId: "new-1", previousTableName: "31A", kotNo: 35 });
    expect(out.reason).toBe("never_ticketed");
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test.each([
    ["the order vanished", null, "order_not_found"],
    ["no outlet", { ...dest, outlet_id: "" }, "no_outlet"],
    ["no lines", { ...dest, items: [] }, "no_items"],
  ] as const)("%s: reported, not printed", async (_l, value, reason) => {
    mockCtx.mockResolvedValue(value);
    const out = await km.printKotItemMove({ restaurantId: "ggv", orderId: "new-1", previousTableName: "31A", kotNo: 35 });
    expect(out.reason).toBe(reason);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test("a printer failure is reported and NEVER thrown — the move has committed", async () => {
    mockCtx.mockResolvedValue(dest);
    mockDispatch.mockRejectedValue(new Error("printer on fire"));
    await expect(km.printKotItemMove({ restaurantId: "ggv", orderId: "new-1", previousTableName: "31A", kotNo: 35 }))
      .resolves.toEqual({ printed: false, kot_no: 35, tickets: 0, reason: "print_failed" });
  });
});
