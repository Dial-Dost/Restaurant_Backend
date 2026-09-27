// ROUND 4 ITEM 2 — THE REPRINT DOOR ITSELF: POST /print/kot/order/:id.
//
// kot_reprint_edited.test.ts pins the paper and the numbering over the real
// allocator. This pins the ROUTE's decision, over a fake app, because the defect
// was not in the numbering at all — AllocateKotNumber did exactly what it is
// supposed to do with the key it was handed. The defect was that the route
// handed it a key for food that had changed, and therefore asked it to MINT
// when it should have asked nothing at all.
//
// WHAT IS PINNED HERE
//   * The docket is built from the order as it stands NOW. (It always was; a
//     test says so, because "the reprint prints the original" was the first
//     thing this item was suspected of and the next reader deserves the answer.)
//   * The number is RESOLVED from "PrintJobs" and PINNED, with `neverAllocate`,
//     so an edited ticket reprints as itself and burns nothing.
//   * An order with nothing on paper yet still allocates, exactly as before.
//   * An emptied ticket is refused, and the sentence says why.
//   * The permission gate is unchanged.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { makeFakeApp, type FakeApp } from "./platform_fixtures";

type AnyAsync = (...a: unknown[]) => Promise<unknown>;
const mockCtx = jest.fn<AnyAsync>();
const mockPrintedNumbers = jest.fn<AnyAsync>();
const mockDispatch = jest.fn<AnyAsync>();
const mockAudit = jest.fn<AnyAsync>();

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
    GetRestaurantAccountStatus: async () => "active",
    withTenant: async (_ctx: unknown, work: () => unknown) => work(),
    GetOrderKotContext: (...a: unknown[]) => mockCtx(...a),
    GetRestaurantSettings: async () => ({ currency: "₹", timezone: "Asia/Kolkata", bill_paper_width: "80mm" }),
    GetRestaurantProfile: async () => ({ outlet_name: "Gaia" }),
    GetTableFeedbackContext: async () => null,
    // THE EDIT-PROOF READ. kot_print.ts's kotNumberOnPaperForOrder is the REAL
    // one here — what it does with this map is precisely what is under test.
    GetOrderKotNumbers: (...a: unknown[]) => mockPrintedNumbers(...a),
  };
});
jest.mock("../kot_print", () => ({
  ...(jest.requireActual("../kot_print") as Record<string, unknown>),
  __esModule: true,
  dispatchKot: (...a: unknown[]) => mockDispatch(...a),
  logKotDispatched: () => undefined,
}));
jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: () => undefined, emitOutlet: () => undefined }));
jest.mock("../storage_bucket_supabase", () => ({ __esModule: true, uploadScreenshot: async () => null }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: async () => undefined }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

const RES = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OUTLET = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ORDER = "33333333-1111-4111-8111-333333333333";
const PRINT = "4ad474d4-5230-449c-874f-6a238b833bca";
const who = (role: string, actions: string[]) => ({
  res_id: RES, outlet_id: OUTLET, employeeId: `emp-${role}`, employeeUsername: role, role, role_all: [role], actions,
});
const ADMIN = who("admin", ["*"]);
const MANAGER = who("manager", [PRINT]);
const NO_PRINT = who("waiter", ["something-else"]);

/** The ticket after the Roti has been taken off it — what the order IS now. */
const EDITED = [
  { name: "Paneer Tikka", quantity: 2 },
  { name: "Dark Chocolate Mousse", quantity: 1 },
];

let h: FakeApp;
beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL ?? "postgres://fixture:fixture@localhost:5432/fixture";
  const bills = await import("../routes/bills");
  h = makeFakeApp();
  bills.registerBillPrintAndEditRoutes(h.app as never);
});

beforeEach(() => {
  for (const m of [mockCtx, mockPrintedNumbers, mockDispatch, mockAudit]) { m.mockReset(); }
  mockAudit.mockResolvedValue(true);
  mockCtx.mockResolvedValue({
    order_id: ORDER, outlet_id: OUTLET, table_id: "table-4", table_name: "T4",
    section: null, covers: 2, is_virtual: false, order_type: "dine_in",
    awaiting_approval: false, order_note: null, items: EDITED,
  });
  // The kitchen was handed KOT-12 when this order was punched.
  mockPrintedNumbers.mockResolvedValue(new Map([[ORDER, [12]]]));
  mockDispatch.mockResolvedValue({
    billId: `order-${ORDER}`, tickets: 1, stations: ["General"],
    kotNo: 12, businessDay: "2026-09-27", reprint: true, jobIds: ["j1"], devices: [null], skipped: false,
  });
});

const reprint = (auth: unknown = ADMIN) =>
  h.call("POST", "/print/kot/order/:id", { params: { id: ORDER }, auth: auth as never });

const dispatchArgs = () => mockDispatch.mock.calls[0]![0] as Record<string, unknown>;

describe("reprinting a KOT a line has been removed from", () => {
  test("the docket is built from the order as it stands NOW, not from a stored original", async () => {
    await reprint();
    expect(mockCtx).toHaveBeenCalledWith(RES, ORDER);
    // The live item set, and only it: the removed Roti is nowhere in the call.
    expect(dispatchArgs().items).toEqual(EDITED);
    expect(JSON.stringify(dispatchArgs().items)).not.toContain("Tandoori Roti");
  });

  test("the number is the one already on the paper, PINNED — nothing is minted", async () => {
    // THE DEFECT. Without this the route passed no pin, dispatchKot allocated
    // against the edited item set, and the pass holding KOT-12 was handed a
    // brand new KOT-13 for food it was already cooking.
    const r = await reprint();
    expect(r.status).toBe(200);
    expect(mockPrintedNumbers).toHaveBeenCalledWith(RES, [ORDER]);
    expect(dispatchArgs()).toMatchObject({ pinnedKotNo: 12, neverAllocate: true });
  });

  test("the answer and the audit line both call it a reprint of that ticket", async () => {
    const r = await reprint();
    expect(r.body).toMatchObject({ success: true, kot_no: 12, reprint: true, tickets: 1 });
    const reason = String(mockAudit.mock.calls.at(-1)![4]);
    expect(reason).toContain("Reprinted KOT-12 (reprint)");
  });

  test("the jobs stay grouped with the ticket they reprint", async () => {
    await reprint();
    expect(dispatchArgs().billId).toBe(`order-${ORDER}`);
  });
});

describe("when there is no paper to name", () => {
  test("an order with nothing in the print queue allocates exactly as it always did", async () => {
    // The repair the button exists for: an allocation that succeeded and an
    // enqueue that threw leaves a memo row and no paper. The key still matches,
    // so allocating resolves to the number that was minted — which is why the
    // pin has to be ABSENT here rather than null.
    mockPrintedNumbers.mockResolvedValue(new Map());
    await reprint();
    expect(dispatchArgs()).not.toHaveProperty("pinnedKotNo");
    expect(dispatchArgs()).not.toHaveProperty("neverAllocate");
  });

  test("a read that fails costs the pin, never the docket", async () => {
    mockPrintedNumbers.mockRejectedValue(new Error("PrintJobs unreadable"));
    const r = await reprint();
    expect(r.status).toBe(200);
    expect(dispatchArgs()).not.toHaveProperty("pinnedKotNo");
  });

  test("a nonsense number in the queue is not printed as one", async () => {
    mockPrintedNumbers.mockResolvedValue(new Map([[ORDER, [0]]]));
    await reprint();
    expect(dispatchArgs()).not.toHaveProperty("pinnedKotNo");
  });
});

describe("a ticket with every dish taken off it", () => {
  test("is not reprinted, and the refusal says so in the floor's words", async () => {
    // THE DECISION (round 4): nothing to reprint. The order is Cancelled, the
    // pass already holds the CANCELLED slip for the last dish, and an empty
    // docket under a live number is a ticket that asks the kitchen for nothing
    // while looking exactly like an order.
    mockCtx.mockResolvedValue({
      order_id: ORDER, outlet_id: OUTLET, table_id: "table-4", table_name: "T4",
      section: null, covers: 2, is_virtual: false, order_type: "dine_in",
      awaiting_approval: false, order_note: null, items: [],
    });
    const r = await reprint();
    expect(r.status).toBe(400);
    expect(String((r.body as { error: string }).error)).toContain("nothing to reprint");
    expect(String((r.body as { error: string }).error)).toContain("CANCELLED");
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test("an order that does not exist is still a 404", async () => {
    mockCtx.mockResolvedValue(null);
    const r = await reprint();
    expect(r.status).toBe(404);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe("the gate is unchanged", () => {
  test("whoever may print may reprint — a manager with the print action is allowed", async () => {
    const r = await reprint(MANAGER);
    expect(r.status).toBe(200);
  });

  test("without the print action, nothing is dispatched", async () => {
    const r = await reprint(NO_PRINT);
    expect(r.status).toBe(403);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
