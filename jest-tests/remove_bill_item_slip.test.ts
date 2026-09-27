// CLIENT ITEM 2 — "deleted items in point 1 above: cancelled KOT is not getting
// printed."
//
// ============================================================================
// WHY THIS IS A SAFETY BUG AND NOT A NICETY
// ============================================================================
// Requirement 1.1 already puts a CANCELLED slip on the pass when a whole KOT is
// cancelled, and DELETE /orders/:id/items/:itemId puts one there for a single
// line. POST /bills/remove-item — the "Remove from bill" the floor actually
// uses — printed NOTHING. The docket stayed on the rail, so the dish the admin
// had just taken off the guest's bill went on being cooked, plated and carried
// out: food cost the house eats, and a plate the guest never ordered.
//
// ============================================================================
// WHAT IS PINNED HERE — the ROUTE, over a fake app
// ============================================================================
//   * The slip is asked for, once, for the ticket the line came off.
//   * It names the DISH THAT WAS REMOVED and nothing else. Cancelling the whole
//     ticket would tell the kitchen to bin food the table is still waiting for.
//   * The ticket and the line are read BEFORE the write. A KOT number is found
//     by a fingerprint of the order's item SET, so afterwards there is no
//     number to put on the slip — this is the same pre-read /bills/move-item
//     and the delete route both do, and getting it backwards costs the number.
//   * A line that was never on the pass prints nothing, and the answer says so.
//   * A printer that cannot be reached does not fail the removal.
//   * The gate is unchanged: admin only.
//
// What the slip LOOKS like — "** CANCELLED **" in the biggest type the printer
// has, the number, the table, the dish — is dispatchCancellationKot's, and is
// pinned on real paper in kot_cancellation.test.ts (including the one-line slip
// this route asks for).

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFakeApp, type FakeApp } from "./platform_fixtures";

type AnyAsync = (...a: unknown[]) => Promise<unknown>;
const mockAudit = jest.fn<AnyAsync>();
const mockRemove = jest.fn<AnyAsync>();
const mockTarget = jest.fn<AnyAsync>();
const mockCtx = jest.fn<AnyAsync>();
const mockSlip = jest.fn<AnyAsync>();
const mockEmit = jest.fn<(...a: unknown[]) => void>();
/** Every statement the fake pool saw, so "read before the write" is observed. */
const calls: string[] = [];

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
    RemoveBillItem: (...a: unknown[]) => mockRemove(...a),
    GetRemovableBillLine: (...a: unknown[]) => mockTarget(...a),
    GetOrderKotContext: (...a: unknown[]) => mockCtx(...a),
    GetRestaurantAccountStatus: async () => "active",
    withTenant: async (_ctx: unknown, work: () => unknown) => work(),
  };
});
// The line shaping (kotLineOfStored) is the real one: it decides what reaches
// the printer, so a test that stubbed it would pin nothing.
jest.mock("../kot_print", () => ({
  ...(jest.requireActual("../kot_print") as Record<string, unknown>),
  __esModule: true,
  dispatchKot: async () => ({ tickets: 0, stations: [], kotNo: null }),
  logKotDispatched: () => undefined,
  dispatchCancellationKot: (...a: unknown[]) => mockSlip(...a),
}));
jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: (...a: unknown[]) => mockEmit(...a), emitOutlet: () => undefined }));
jest.mock("../storage_bucket_supabase", () => ({ __esModule: true, uploadScreenshot: async () => null }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: async () => undefined }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

const RES = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OUTLET = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const KOT3 = "33333333-1111-4111-8111-333333333333";
const who = (role: string, actions: string[]) => ({
  res_id: RES, outlet_id: OUTLET, employeeId: `emp-${role}`, employeeUsername: role, role, role_all: [role], actions,
});
const ADMIN = who("admin", ["*"]);
const MANAGER = who("manager", ["4ad474d4-5230-449c-874f-6a238b833bca"]);
const WAITER = who("waiter", ["4ad474d4-5230-449c-874f-6a238b833bca"]);

/** The line as "Orders".food holds it: a size, a kitchen note and a menu id. */
const ROTI_LINE = {
  id: "r2", name: "Tandoori Roti", price: 130, quantity: 1,
  note: " extra butter ", variation_name: "Butter", menu_id: "m-roti",
  orderedAt: "2026-09-16T08:03:00Z", station: null, course_hold: false, fired_at: null,
};

let h: FakeApp;
beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL ?? "postgres://fixture:fixture@localhost:5432/fixture";
  const bills = await import("../routes/bills");
  h = makeFakeApp();
  bills.registerBillPrintAndEditRoutes(h.app as never);
});

beforeEach(() => {
  calls.length = 0;
  for (const m of [mockAudit, mockRemove, mockTarget, mockCtx, mockSlip]) { m.mockReset(); }
  mockEmit.mockReset();
  mockAudit.mockResolvedValue(true);
  mockTarget.mockImplementation(async () => { calls.push("read"); return { order_id: KOT3, line: { ...ROTI_LINE } }; });
  mockCtx.mockImplementation(async () => { calls.push("context"); return { order_id: KOT3, table_name: "T7", items: [{ name: "Paneer Tikka", quantity: 1 }, { name: "Tandoori Roti", quantity: 1 }] }; });
  mockRemove.mockImplementation(async () => {
    calls.push("write");
    return {
      success: true,
      removed: { name: "Tandoori Roti", price: 130, quantity: 1, lines: [{ name: "Tandoori Roti", price: 130, quantity: 1 }], value: 130 },
      taken: [{ order_id: KOT3, lines: [{ ...ROTI_LINE }] }],
    };
  });
  mockSlip.mockImplementation(async () => { calls.push("slip"); return { printed: true, kot_no: 3, tickets: 1 }; });
});

const remove = (body: Record<string, unknown>, auth: unknown = ADMIN) =>
  h.call("POST", "/bills/remove-item", { body, auth: auth as never });

const BODY = { table_name: "T7", item_name: "Tandoori Roti", price: 130, order_id: KOT3, item_id: "r2" };
// AddAuditLogEntry(res_id, outlet_id, employee_id, action_id, description, category, details)
const lastAudit = () => {
  const c = mockAudit.mock.calls.at(-1);
  if (!c) { throw new Error("nothing was audited"); }
  return { reason: String(c[4]), details: c[6] as Record<string, unknown> };
};

describe("the kitchen is told about the dish that left", () => {
  test("one slip, for the ticket it came off, naming that dish alone", async () => {
    const r = await remove(BODY);

    expect(r.status).toBe(200);
    expect(mockSlip).toHaveBeenCalledTimes(1);
    const opts = mockSlip.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts).toMatchObject({ restaurantId: RES, orderId: KOT3, where: "bill_item_removed", itemId: "r2" });
    // THE REMOVED DISH, NOT THE TICKET. The order's context carries two dishes;
    // the slip carries one, because the other is still being cooked.
    expect(opts.only).toEqual([{
      name: "Tandoori Roti", quantity: 1, price: 130,
      note: "extra butter", variation: "Butter", menu_id: "m-roti",
    }]);
  });

  test("the answer tells the till what the pass was handed", async () => {
    const r = await remove(BODY);
    expect(r.body).toMatchObject({
      success: true, order_id: KOT3,
      removed: { name: "Tandoori Roti", quantity: 1 },
      kot_cancelled: true, kot_no: 3, kot_tickets: 1,
    });
  });

  test("the ticket and the line are read BEFORE the write, and the slip printed after it", async () => {
    // A KOT number is a fingerprint of the order's item set: ask afterwards and
    // there is no number left to print. The pre-read also pins the write to the
    // ticket the slip will name, so the two can never disagree.
    await remove(BODY);
    expect(calls).toEqual(["read", "context", "write", "slip"]);
    expect(mockTarget).toHaveBeenCalledWith(RES, "T7", "Tandoori Roti", 130, { orderId: KOT3, itemId: "r2" });
    expect(mockRemove).toHaveBeenCalledWith(RES, "T7", "Tandoori Roti", 130, { orderId: KOT3, itemId: "r2" });
  });

  test("a till that sends no ids: the pre-read resolves the ticket and the write is pinned to it", async () => {
    await remove({ table_name: "T7", item_name: "Tandoori Roti", price: 130 });
    expect(mockRemove).toHaveBeenCalledWith(RES, "T7", "Tandoori Roti", 130, { orderId: KOT3, itemId: null });
    expect(mockSlip).toHaveBeenCalledTimes(1);
  });

  test("the audit line records whether the kitchen got paper", async () => {
    await remove(BODY);
    const { reason, details } = lastAudit();
    expect(reason).toBe("Removed item Tandoori Roti from table T7");
    expect(details).toMatchObject({ table: "T7", order_id: KOT3, item_id: "r2", quantity: 1, kot_cancelled: true, kot_no: 3 });
  });
});

describe("when there is no paper at the pass to correct", () => {
  test("a line that was never ticketed prints nothing, and the answer says why", async () => {
    // dispatchCancellationKot's own gate: a Pending order (never accepted to the
    // kitchen) and a tenant with auto-print off both answer this way. The
    // removal still goes through — there is simply nothing to tell anyone.
    mockSlip.mockResolvedValue({ printed: false, kot_no: null, tickets: 0, reason: "never_ticketed" });
    const r = await remove(BODY);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, kot_cancelled: false, kot_no: null, kot_tickets: 0, kot_skipped: "never_ticketed" });
    expect(lastAudit().details).toMatchObject({ kot_cancelled: false, kot_skipped: "never_ticketed" });
  });

  test("nothing matched: no slip, and the refusal is the one the till already shows", async () => {
    mockTarget.mockResolvedValue(null);
    mockRemove.mockRejectedValue(new Error("Item not found on this table's bill"));
    const r = await remove({ ...BODY, item_id: "gone" });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: "Item not found on this table's bill" });
    expect(mockSlip).not.toHaveBeenCalled();
  });

  test("an unreadable ticket context costs the number, never the removal", async () => {
    mockCtx.mockRejectedValue(new Error("no such order"));
    const r = await remove(BODY);
    expect(r.status).toBe(200);
    expect((mockSlip.mock.calls[0]![0] as { order: unknown }).order).toBeNull();
  });
});

describe("the gate is unchanged", () => {
  test("admin only — a manager and a waiter are both refused, and nothing is written or printed", async () => {
    for (const auth of [MANAGER, WAITER]) {
      mockRemove.mockClear(); mockSlip.mockClear();
      const r = await remove(BODY, auth);
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ error: "Forbidden", requiredRoles: ["admin"] });
      expect(mockRemove).not.toHaveBeenCalled();
      expect(mockSlip).not.toHaveBeenCalled();
    }
  });

  test("no session at all is 401", async () => {
    const r = await h.call("POST", "/bills/remove-item", { body: BODY });
    expect(r.status).toBe(401);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  test("the handler still opens with enforceRoles(['admin']) — the guard is in the body, not the chain", async () => {
    // /bills/remove-item carries no validateAction, so npm run test:routes
    // cannot see its authority: it is the first line of the handler. A refactor
    // that dropped it would make every one of the tests above pass against an
    // open door, so the source is read.
    const src = readFileSync(join(__dirname, "..", "routes", "bills.ts"), "utf8");
    const handler = src.slice(src.indexOf("app.post('/bills/remove-item'"));
    expect(handler.slice(0, 400)).toContain(`enforceRoles(req, res, ["admin"])`);
  });
});
