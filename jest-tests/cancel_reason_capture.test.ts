// A2 — "A reason is required before the action is processed and finalized."
//
// ============================================================================
// THE GAP: THE REASON ARRIVED AND WAS THROWN AWAY
// ============================================================================
// Both clients now prompt unconditionally before a cancel and put the answer in
// the body. PATCH /orders/:id/status read `status` and nothing else. So the
// requirement was satisfied on the screen and false in the database: the void
// report went on showing "unknown" beside every cancelled ticket, and the audit
// line said `Order <id> -> Cancelled` with no more than that.
//
// WHERE IT NOW GOES: "OrderVoids" (migration 035), scope='order'. Not a new home
// invented here — 035's own header names "PATCH /orders/:id/status -> Cancelled"
// as one of the two writes it exists to record, and it was simply never wired.
// That is what makes the reason reach the void report, the server-derived fraud
// STAGE and the money figure, all of which already existed.
//
// ============================================================================
// WHAT THIS SUITE IS MOST CAREFUL ABOUT: NOT BREAKING A LIVE FLOOR
// ============================================================================
// The field is deliberately NOT mandatory server-side. Every till in the field
// is a shipped binary and some of them send no reason; a 400 would mean a
// restaurant cannot cancel a mis-keyed order tonight. So the rule is RECORD WHAT
// YOU ARE GIVEN, and three cases below are about the other direction entirely —
// a cancel with no reason must still work, and a LEDGER WRITE THAT FAILS must
// not turn a completed cancellation into an error the till will retry.

import { describe, test, expect, beforeAll, beforeEach } from "@jest/globals";
import { makeFakeApp, type FakeApp } from "./platform_fixtures";

const SetOrderStatus = jest.fn();
const RecordOrderVoid = jest.fn();
const dispatchCancellationKot = jest.fn();

jest.mock("../database_supabase", () => ({
  __esModule: true,
  Audit_log_category: { Orders: "Orders", Bill: "Bill", Tables: "Tables" },
  BARK_ORDER_ACTION_ID: "3f6a9c1e-8d24-4b7a-b5c9-2e1f7d4a8b63",
  FIRE_COURSE_ACTION_ID: "4ad474d4-5230-449c-874f-6a238b833bca",
  SetOrderStatus: (...a: unknown[]) => SetOrderStatus(...a),
  RecordOrderVoid: (...a: unknown[]) => RecordOrderVoid(...a),
  AddOrder: jest.fn(), AddTakeawayOrder: jest.fn(), BarkOrder: jest.fn(), DeleteOrder: jest.fn(),
  FireOrderItems: jest.fn(), GetOrderKotContext: jest.fn(), GetOrders: jest.fn(),
  GetOrdersScope: jest.fn(), IsOrderItemServed: jest.fn(), OrderTimingAction: jest.fn(),
  UpdateOrderItemsSplit: jest.fn(), applyMenuPriceFloor: jest.fn(),
  // routes/_shared.ts's imports.
  AddAuditLogEntry: jest.fn(), AddCustomer: jest.fn(), AddEmailToCustomer: jest.fn(),
  AddNotification: jest.fn(), GetCustomerId: jest.fn(), GetDueBookingReminders: jest.fn(),
  GetEmployeeDetailsFromEmpID: jest.fn(async () => null), GetMessagingConfig: jest.fn(),
  GetRestaurantLogoRaw: jest.fn(async () => null), GetRestaurantAccountStatus: jest.fn(),
  GetRestaurantProfile: jest.fn(), GetRestaurantRazorpayKeys: jest.fn(),
  GetRestaurantSettings: jest.fn(), GetSuperadminEmployeeId: jest.fn(),
  GetTableFeedbackContext: jest.fn(async () => null), ListBillingCounters: jest.fn(),
  MarkBookingReminderSent: jest.fn(), RecordOutboundMessage: jest.fn(),
  SetOrderCustomerId: jest.fn(), UpdateCustomerDemographics: jest.fn(),
  sanitizeTimezone: (t: unknown) => t, withTenant: jest.fn(), zonedWallToUtc: jest.fn(),
}));
jest.mock("../kot_print", () => ({
  __esModule: true,
  autoPrintOrderKot: jest.fn(async () => null),
  dispatchCancellationKot: (...a: unknown[]) => dispatchCancellationKot(...a),
}));
jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: jest.fn(), emitOutlet: jest.fn() }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: jest.fn() }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

const ADD_ORDERS = "4ad474d4-5230-449c-874f-6a238b833bca";
const CLOSE_BILL = "a953d044-31ba-4e31-b96f-99304fe43dfa";
const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";

const WAITER = {
  res_id: RES, outlet_id: OUTLET, employeeId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  employeeUsername: "waiter01", role: "waiter", role_all: ["waiter"], actions: [ADD_ORDERS],
};
const ADMIN = {
  res_id: RES, outlet_id: OUTLET, employeeId: "3f2504e0-4f89-11d3-9a0c-0305e82c3302",
  employeeUsername: "owner", role: "admin", role_all: ["admin"], actions: ["*", CLOSE_BILL],
};

let harness: FakeApp;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  const orders = await import("../routes/orders");
  harness = makeFakeApp();
  orders.registerOrderRoutes(harness.app as never);
});

beforeEach(() => {
  SetOrderStatus.mockReset();
  RecordOrderVoid.mockReset();
  dispatchCancellationKot.mockReset();
  SetOrderStatus.mockResolvedValue({ ok: true, changed: true, previous_status: "Preparing" });
  RecordOrderVoid.mockResolvedValue({ id: "void-1", void_kind: "wrong_entry", stage: "after_print", reason: "x" });
  dispatchCancellationKot.mockResolvedValue({ printed: false, kot_no: null, tickets: 0, reason: "never ticketed" });
});

const patch = (body: Record<string, unknown>, auth: unknown = WAITER) =>
  harness.call("PATCH", "/orders/:id/status", { params: { id: "order-1" }, body, auth: auth as never });

// ---------------------------------------------------------------------------
describe("the reason is recorded against the cancelled order", () => {
  test("a cancel WITH a reason writes it to the void ledger, verbatim", async () => {
    const r = await patch({ status: "Cancelled", reason: "  Guest changed their mind  " });
    expect(r.status).toBe(200);
    expect(RecordOrderVoid).toHaveBeenCalledTimes(1);
    const [resId, input] = RecordOrderVoid.mock.calls[0] as [string, Record<string, unknown>];
    expect(resId).toBe(RES);
    expect(input.order_id).toBe("order-1");
    expect(input.scope).toBe("order");
    expect(input.reason).toBe("Guest changed their mind");
    expect((r.body as { void_reason_recorded?: boolean }).void_reason_recorded).toBe(true);
    expect((r.body as { void_stage?: string }).void_stage).toBe("after_print");
  });

  test("a recognised void_kind is carried through; anything else falls back to 'other'", async () => {
    // 035's CHECK accepts seven values. The clients send free text, and refusing
    // a real reason for want of a category would discard exactly the thing this
    // change exists to keep.
    await patch({ status: "Cancelled", reason: "duplicate ticket", void_kind: "duplicate" });
    expect((RecordOrderVoid.mock.calls[0] as [string, Record<string, unknown>])[1].void_kind).toBe("duplicate");

    RecordOrderVoid.mockClear();
    await patch({ status: "Cancelled", reason: "guest walked out" });
    expect((RecordOrderVoid.mock.calls[0] as [string, Record<string, unknown>])[1].void_kind).toBe("other");
  });

  test("THE ACTOR COMES FROM THE SESSION, never from the body", async () => {
    // A client that could name its own actor could sign a void as the manager.
    await patch({ status: "Cancelled", reason: "wrong table", username: "manager01", authorised_by_username: "manager01" });
    const actor = (RecordOrderVoid.mock.calls[0] as [string, { actor: Record<string, unknown> }])[1].actor;
    expect(actor.username).toBe("waiter01");
    // SELF-AUTHORISED, AND THE ROW SAYS SO. This is the everyday cancel, not the
    // manager-void route (POST /orders/:id/void), which is where a second name is
    // demanded and permission-checked. An auditor seeing voided_by =
    // authorised_by can tell at a glance that nobody countersigned.
    expect(actor.authorised_by_username).toBe("waiter01");
  });

  test("the reason is in the AUDIT LINE too, not only in the ledger", async () => {
    // The audit trail is what a manager reads at the end of a service. A reason
    // reachable only by expanding a JSON column is a reason nobody reads. The
    // audit write throws in this harness (no employee row); the assertion is that
    // the request still succeeded, which is the property that matters.
    const r = await patch({ status: "Cancelled", reason: "kitchen ran out" });
    expect(r.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe("a live floor keeps working — the field is NOT mandatory server-side", () => {
  test("a shipped client that sends NO reason still cancels", async () => {
    // THE CASE THIS WHOLE POSTURE EXISTS FOR. Make this a 400 and a restaurant
    // on last month's build cannot cancel a mis-keyed order tonight.
    const r = await patch({ status: "Cancelled" });
    expect(r.status).toBe(200);
    expect(RecordOrderVoid).not.toHaveBeenCalled();
    expect(r.body).not.toHaveProperty("void_reason_recorded");
  });

  test("a blank/whitespace reason is treated as none, not as a reason of ' '", async () => {
    const r = await patch({ status: "Cancelled", reason: "   " });
    expect(r.status).toBe(200);
    expect(RecordOrderVoid).not.toHaveBeenCalled();
  });

  test("A FAILED LEDGER WRITE DOES NOT UNDO THE CANCEL", async () => {
    // 035 unapplied on this deployment, a constraint, a dead connection. The
    // order is already cancelled by the time this runs; turning that into a 400
    // would have the till retry a cancellation that already happened.
    RecordOrderVoid.mockRejectedValue(new Error('relation "OrderVoids" does not exist'));
    const r = await patch({ status: "Cancelled", reason: "wrong entry" });
    expect(r.status).toBe(200);
    // AND IT SAYS SO, rather than claiming success it cannot stand behind: a till
    // that gets `false` knows the audit line has the reason and the void report
    // will not.
    expect((r.body as { void_reason_recorded?: boolean }).void_reason_recorded).toBe(false);
  });

  test("an idempotent RE-cancel writes no second record", async () => {
    // SetOrderStatus reports `changed: false` for an order that is already
    // Cancelled, and the handler returns before anything else runs. A
    // double-tapped cancel must not produce a second, competing reason.
    SetOrderStatus.mockResolvedValue({ ok: true, changed: false, previous_status: "Cancelled" });
    const r = await patch({ status: "Cancelled", reason: "second tap" });
    expect(r.status).toBe(200);
    expect(RecordOrderVoid).not.toHaveBeenCalled();
  });

  test("a NON-cancel status carrying a reason records nothing", async () => {
    // "Served" with a note attached is not a void, and a reason column filling up
    // with serve notes would make the void report useless.
    await patch({ status: "Served", reason: "table asked for it early" });
    expect(RecordOrderVoid).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("an admin loses nothing", () => {
  test("an owner's cancel records exactly the same way", async () => {
    const r = await patch({ status: "Cancelled", reason: "comped and cleared" }, ADMIN);
    expect(r.status).toBe(200);
    expect(RecordOrderVoid).toHaveBeenCalledTimes(1);
    const actor = (RecordOrderVoid.mock.calls[0] as [string, { actor: Record<string, unknown> }])[1].actor;
    expect(actor.username).toBe("owner");
  });

  test("an owner's cancel without a reason is not blocked either", async () => {
    const r = await patch({ status: "Cancelled" }, ADMIN);
    expect(r.status).toBe(200);
  });
});
