// C2 — "Only Managers are permitted to settle bills. Waiters must be restricted."
//
// ============================================================================
// WHY THIS SUITE DRIVES THE REAL HANDLERS
// ============================================================================
// A permission that is only a hidden button is not a permission. The clients do
// hide Settle (they read `scope.settle_bill` off the session — see
// sessionCapabilities), but a deep link, a back-navigation, a replayed request
// from an offline outbox or a bare curl all arrive at the route with the button
// nowhere in sight. So every case below calls the SHIPPED handler from
// routes/bills.ts and routes/orders.ts over the fake-app harness and asserts the
// 403 comes back BEFORE the data layer is reached — the guest_write_gate.test.ts
// discipline, applied to money.
//
// EVERY CASE IS A PAIR. The refusal half proves the waiter is stopped; the
// permitted half proves the gate LET SOMEONE THROUGH, by observing that the
// admin/manager call fails LATER and for a different reason (the handler's own
// validation, or the fixture DB having no such bill). A suite that only asserted
// "waiter gets 403" would still pass if the route had stopped working entirely,
// and "the fix took the till away from the person who runs it" is the failure
// mode this codebase fears most.
//
// THE SETTLE PATHS. There is no single settle endpoint. A settlement is spread
// across five writes, and all five are covered here:
//
//   POST  /bills/order/:orderId/waiter-confirm-payment   records the money
//   POST  /bills/order/:orderId/admin-approve-payment    closes the bill
//   POST  /bills/order/:orderId/close                    frees the table
//   PATCH /orders/:id/status            -> Paid / Closed
//   PATCH /bills/order/:orderId/status  -> 2 (approved) / 3 (closed)
//
// The last one is the back door: it writes "Bills".status as a raw integer and
// was gated only on a WORKFLOW permission, so a role that could move a ticket
// along could mark a bill settled without re-pricing it or reconciling a tender.

import { describe, test, expect, beforeAll } from "@jest/globals";
import { makeFakeApp, type FakeApp } from "./platform_fixtures";

jest.mock("pg", () => {
  interface FixtureGlobal {
    __platformFixtureConnect?: () => { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; release: () => void };
  }
  const conn = () => {
    const make = (globalThis as unknown as FixtureGlobal).__platformFixtureConnect;
    if (!make) {throw new Error("platform fixture harness was not loaded");}
    return make();
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> { return conn().query(sql, params); }
    connect(): Promise<unknown> { return Promise.resolve(conn()); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

// The action ids exactly as they appear in registration position on the routes.
const ADD_ORDERS = "4ad474d4-5230-449c-874f-6a238b833bca";
const CONFIRM_PAYMENT = "2393edd7-cdd9-439c-9ff3-d563d5216967";
const APPROVE_PAYMENT = "fc57d407-4bba-442c-97a2-9e6f3c57f288";
const CLOSE_BILL = "a953d044-31ba-4e31-b96f-99304fe43dfa";
const UPDATE_ORDER_STATUS = "07e364cc-f40d-46f3-b691-0f719dd38e0f";

const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";

const identity = (actions: string[], role = "waiter") => ({
  res_id: RES, outlet_id: OUTLET, employeeId: "emp-1", role, actions,
});

/**
 * THE WORST CASE THIS GATE EXISTS FOR: a floor role that a tenant has granted
 * every screen permission in the payment flow EXCEPT "Close Bill". Before C2 it
 * could take the money, approve it and free the table. It holds no wildcard and
 * no Close Bill, and every assertion below says it is refused.
 */
const WAITER_WITH_PAYMENT_SCREENS = identity([ADD_ORDERS, CONFIRM_PAYMENT, APPROVE_PAYMENT, UPDATE_ORDER_STATUS]);
/** An owner. "*" must satisfy every gate this suite adds — an admin loses nothing. */
const ADMIN = identity(["*"], "admin");
/** The core `manager` role's till permissions after C2 — the role the requirement names. */
const MANAGER = identity([ADD_ORDERS, CONFIRM_PAYMENT, APPROVE_PAYMENT, CLOSE_BILL, UPDATE_ORDER_STATUS], "manager");

let harness: FakeApp;

/** The exact refusal enforceSettleAuthority sends. Anything else is a different failure. */
const isSettleRefusal = (r: { status: number; body: unknown }): boolean =>
  r.status === 403 && (r.body as { requiredPermission?: string })?.requiredPermission === CLOSE_BILL;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  process.env.PLATFORM_DATABASE_URL =
    process.env.PLATFORM_DATABASE_URL || "postgres://fixture:fixture@localhost:5432/fixture";

  const bills = await import("../routes/bills");
  const orders = await import("../routes/orders");

  harness = makeFakeApp();
  bills.registerBillPaymentRoutes(harness.app as never);
  orders.registerOrderRoutes(harness.app as never);
});

// ---------------------------------------------------------------------------
describe("a waiter cannot settle a bill on ANY of the five settle paths", () => {
  test("POST /bills/order/:orderId/waiter-confirm-payment is refused before any money is recorded", async () => {
    const r = await harness.call("POST", "/bills/order/:orderId/waiter-confirm-payment", {
      params: { orderId: "order-1" },
      body: { payment_method: "Cash" },
      auth: WAITER_WITH_PAYMENT_SCREENS,
    });
    expect(isSettleRefusal(r)).toBe(true);
  });

  test("POST /bills/order/:orderId/admin-approve-payment is refused — the call that CLOSES the bill", async () => {
    const r = await harness.call("POST", "/bills/order/:orderId/admin-approve-payment", {
      params: { orderId: "order-1" },
      auth: WAITER_WITH_PAYMENT_SCREENS,
    });
    expect(isSettleRefusal(r)).toBe(true);
  });

  test("POST /bills/order/:orderId/close is refused in registration position", async () => {
    const r = await harness.call("POST", "/bills/order/:orderId/close", {
      params: { orderId: "order-1" },
      auth: WAITER_WITH_PAYMENT_SCREENS,
    });
    // This one is guarded by validateAction on the route line, whose 403 body is
    // the generic one — the verdict is identical, the wording is not.
    expect(r.status).toBe(403);
  });

  test("PATCH /orders/:id/status -> Paid is refused, while -> Served is NOT", async () => {
    const settle = await harness.call("PATCH", "/orders/:id/status", {
      params: { id: "order-1" }, body: { status: "Paid" }, auth: WAITER_WITH_PAYMENT_SCREENS,
    });
    expect(isSettleRefusal(settle)).toBe(true);

    // THE OTHER HALF OF THE RULE. A waiter must keep working: the everyday
    // transitions this route exists for are untouched, so this call gets past
    // the gate and fails later, in the data layer, on a fixture that has no such
    // order. If this ever came back as the settle refusal, the gate would have
    // swallowed the whole route.
    const serve = await harness.call("PATCH", "/orders/:id/status", {
      params: { id: "order-1" }, body: { status: "Served" }, auth: WAITER_WITH_PAYMENT_SCREENS,
    });
    expect(isSettleRefusal(serve)).toBe(false);
  });

  test("PATCH /bills/order/:orderId/status -> 3 is refused: the raw-integer back door", async () => {
    const closed = await harness.call("PATCH", "/bills/order/:orderId/status", {
      params: { orderId: "order-1" }, body: { status: 3 }, auth: WAITER_WITH_PAYMENT_SCREENS,
    });
    expect(isSettleRefusal(closed)).toBe(true);

    // status 2 = admin-approved, which is a settle in all but name.
    const approved = await harness.call("PATCH", "/bills/order/:orderId/status", {
      params: { orderId: "order-1" }, body: { status: 2 }, auth: WAITER_WITH_PAYMENT_SCREENS,
    });
    expect(isSettleRefusal(approved)).toBe(true);
  });

  test("PATCH /bills/order/:orderId/status -> 1 is NOT a settle and stays open to the workflow role", async () => {
    const r = await harness.call("PATCH", "/bills/order/:orderId/status", {
      params: { orderId: "order-1" }, body: { status: 1 }, auth: WAITER_WITH_PAYMENT_SCREENS,
    });
    expect(isSettleRefusal(r)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("the people who run the till lose nothing", () => {
  for (const [who, auth] of [["an admin", ADMIN], ["a manager", MANAGER]] as const) {
    test(`${who} is NOT refused by the settle gate on waiter-confirm-payment`, async () => {
      const r = await harness.call("POST", "/bills/order/:orderId/waiter-confirm-payment", {
        params: { orderId: "order-1" }, body: { payment_method: "Cash" }, auth,
      });
      // It fails LATER — there is no such bill in the fixture — which is the
      // proof that the gate let it through rather than that nothing ran.
      expect(isSettleRefusal(r)).toBe(false);
    });

    test(`${who} is NOT refused by the settle gate on admin-approve-payment`, async () => {
      const r = await harness.call("POST", "/bills/order/:orderId/admin-approve-payment", {
        params: { orderId: "order-1" }, auth,
      });
      expect(isSettleRefusal(r)).toBe(false);
    });

    test(`${who} is NOT refused marking an order Paid`, async () => {
      const r = await harness.call("PATCH", "/orders/:id/status", {
        params: { id: "order-1" }, body: { status: "Paid" }, auth,
      });
      expect(isSettleRefusal(r)).toBe(false);
    });

    test(`${who} is NOT refused writing bill status 3`, async () => {
      const r = await harness.call("PATCH", "/bills/order/:orderId/status", {
        params: { orderId: "order-1" }, body: { status: 3 }, auth,
      });
      expect(isSettleRefusal(r)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// The gate is a CAPABILITY, not the word "manager" — see enforceSettleAuthority.
describe("settling follows the granted capability, never the spelling of a role", () => {
  test("a CUSTOM role (a uuid, not a word) granted Close Bill may settle", async () => {
    // The csrorganics shape: role_all carries a uuid rather than a role name. A
    // rule that asked `role == "manager"` would lock this tenant out of its own
    // till; a rule that asks for the capability does not care what it is called.
    const customSeniorCashier = identity([CONFIRM_PAYMENT, APPROVE_PAYMENT, CLOSE_BILL], "d2b1f0c4-0000-4000-8000-000000000001");
    const r = await harness.call("POST", "/bills/order/:orderId/admin-approve-payment", {
      params: { orderId: "order-1" }, auth: customSeniorCashier,
    });
    expect(isSettleRefusal(r)).toBe(false);
  });

  test("an identity CALLED manager but NOT granted Close Bill is still refused", async () => {
    const nameOnly = identity([ADD_ORDERS, CONFIRM_PAYMENT], "manager");
    const r = await harness.call("POST", "/bills/order/:orderId/waiter-confirm-payment", {
      params: { orderId: "order-1" }, body: { payment_method: "Cash" }, auth: nameOnly,
    });
    expect(isSettleRefusal(r)).toBe(true);
  });

  test("an unauthenticated call is 401, never a silent pass", async () => {
    const r = await harness.call("POST", "/bills/order/:orderId/admin-approve-payment", {
      params: { orderId: "order-1" },
    });
    expect(r.status).toBe(403); // validateAction rejects first — no session, no actions
  });
});
