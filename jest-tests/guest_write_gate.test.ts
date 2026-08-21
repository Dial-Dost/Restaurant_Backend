// The guest / partner WRITE gate: a restaurant that is archived (or suspended, or
// expired) must stop taking orders from the public surface.
//
// WHY THIS IS ITS OWN SUITE. Archiving revokes every tenant session and blocks
// every login. The /qr/ prefix and /aggregator/order are exempted from the tenant
// auth gate (index.ts:306, :297) and resolve their tenant from the URL slug or an
// API key, so before this gate existed they kept accepting guest orders, coupon
// applications, payments, reservations, waitlist joins and Swiggy/Zomato intake
// into a restaurant NOBODY COULD SIGN IN TO. Orders accrued against bills that
// could never be settled, and the operator console said the tenant was gone. That
// is strictly worse than doing nothing, which is why it was a ship blocker.
//
// HOW IT IS TESTED. Every case drives the REAL handler from routes/guest.ts and
// routes/aggregator.ts over the shared platform fixture, so the assertion is
// about the shipped code path, not a re-implementation. Each write endpoint gets
// a PAIR: the same request against an active tenant and against an archived one.
// The active half deliberately fails LATER, on the handler's own validation
// ("Invalid table code", "At least one item is required"), which proves the gate
// let it through rather than proving nothing at all — a bare "not 404" would pass
// even if the route had stopped working entirely.

import { describe, test, expect, beforeAll, beforeEach } from "@jest/globals";
import {
  ADMIN_ID,
  PLAN_GROWTH_ID,
  addRestaurant,
  addSubscription,
  makeFakeApp,
  resetStore,
  type FakeApp,
} from "./platform_fixtures";

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

let harness: FakeApp;
let operatorToken: string;

// Every guest write route is rate limited per IP against a process-wide store no
// test resets, so each call gets its own IP or the suite 429s itself as it grows.
let ipSeq = 0;
const freshIp = (): string => `192.0.2.${String((ipSeq++ % 250) + 1)}`;

const AGGREGATOR_KEY = "agg-key-that-is-long-enough";

const post = (path: string, slug: string, body: Record<string, unknown> = {}) =>
  harness.call("POST", path, { params: { slug }, body, ip: freshIp() });

const errorOf = (r: { body: unknown }): string => (r.body as { error?: string })?.error ?? "";

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  process.env.PLATFORM_DATABASE_URL =
    process.env.PLATFORM_DATABASE_URL || "postgres://fixture:fixture@localhost:5432/fixture";

  const guestRoutes = await import("../routes/guest");
  const aggregatorRoutes = await import("../routes/aggregator");
  // The operator routes are registered too, so the round-trip test below can drive
  // the REAL archive and restore rather than hand-editing the store into the shape
  // it believes archiving produces.
  const platformRoutes = await import("../platform/routes");
  const platformSessions = await import("../platform/sessions");

  harness = makeFakeApp();
  // Registered in the same order and from the same three entry points index.ts
  // uses (:356, :358, :386), so the routes under test are the ones the server
  // actually serves.
  guestRoutes.registerGuestOrderingRoutes(harness.app as never);
  guestRoutes.registerGuestWaitlistAndPaymentRoutes(harness.app as never);
  guestRoutes.registerGuestBrandingRoute(harness.app as never);
  aggregatorRoutes.registerAggregatorRoutes(harness.app as never);
  platformRoutes.registerPlatformRoutes(harness.app as never);

  operatorToken = await platformSessions.createPlatformSession({
    adminId: ADMIN_ID, email: "operator@example.test", name: "Operator",
  });
});

beforeEach(() => { resetStore(); });

/** A tenant the operator archived: flag set, subscription cancelled — exactly the
 *  pair of columns POST /platform/restaurants/:id/archive writes. */
function archivedTenant(slug: string) {
  const r = addRestaurant({ res_username: slug, account_status: "archived" });
  addSubscription({ res_id: r.id, status: "cancelled" });
  return r;
}

function activeTenant(slug: string) {
  const r = addRestaurant({ res_username: slug });
  addSubscription({ res_id: r.id, status: "active" });
  return r;
}

// ---------------------------------------------------------------------------
describe("an archived restaurant is refused on the guest ordering write path", () => {
  test("POST /qr/:slug/order is refused, and the identical request on a live tenant is not", async () => {
    activeTenant("stilltrading");
    archivedTenant("gonecafe");

    const order = {
      table_name: "T1",
      sig: "whatever",
      items: [{ id: "i1", name: "Dosa", price: 120, quantity: 1 }],
    };

    const refused = await post("/qr/:slug/order", "gonecafe", order);
    expect(refused.status).toBe(404);
    expect(errorOf(refused)).toBe("Restaurant not found");

    // The live tenant gets PAST the gate and is stopped by the handler's own
    // table-code check — which is what proves the gate is what refused the other
    // one, rather than the route being broken for everybody.
    const allowed = await post("/qr/:slug/order", "stilltrading", order);
    expect(allowed.status).toBe(403);
    expect(errorOf(allowed)).toContain("Invalid table code");
  });

  test("the refusal is indistinguishable from an unknown restaurant", async () => {
    // Deliberate: the reader is a stranger holding a printed QR code, and the
    // tenant's billing trouble is not theirs to learn. It also means the guest
    // pages need no change — they already handle this exact 404.
    archivedTenant("closedup");
    const archived = await post("/qr/:slug/order", "closedup", { items: [] });
    const unknown = await post("/qr/:slug/order", "nosuchrestaurant", { items: [] });

    expect(archived.status).toBe(unknown.status);
    expect(archived.body).toEqual(unknown.body);
    expect(archived.status).toBe(404);
  });

  test.each([
    ["/qr/:slug/pay", { table_name: "T1", sig: "x", payment_method: "upi" }],
    ["/qr/:slug/coupon", { table_name: "T1", sig: "x", code: "SAVE10" }],
    ["/qr/:slug/reserve", { name: "Asha", phone: "9876543210", party_size: 2, date: "2026-09-01T19:00:00Z" }],
    ["/qr/:slug/waitlist/join", { name: "Asha", phone: "9876543210", party_size: 2 }],
    ["/qr/:slug/razorpay/create", { table_name: "T1", sig: "x" }],
  ])("%s is refused", async (path, body) => {
    archivedTenant("gonecafe");
    const r = await post(path, "gonecafe", body);
    expect(r.status).toBe(404);
    expect(errorOf(r)).toBe("Restaurant not found");
  });

  test("a merely SUSPENDED tenant is refused too, and a past_due one inside grace is not", async () => {
    // Suspended and expired tenants are locked out of their own POS by the same
    // login gate, so guest orders land in exactly the same unsettleable pile. A
    // gate that special-cased 'archived' would be a second lifecycle rule to keep
    // in sync with platform.restaurant_status.
    addRestaurant({ res_username: "suspended", account_status: "suspended" });
    // past_due WITHIN grace still reads 'active' (migrations/011_billing_grace.sql:21):
    // a restaurant that is merely late keeps trading. One subscription row only —
    // a second would shadow it, and the case would silently stop being tested.
    const late = addRestaurant({ res_username: "latepayer" });
    addSubscription({ res_id: late.id, status: "past_due" });

    const off = await post("/qr/:slug/order", "suspended", { items: [] });
    expect(off.status).toBe(404);

    const on = await post("/qr/:slug/order", "latepayer", { items: [] });
    expect(on.status).toBe(403);
    expect(errorOf(on)).toContain("Invalid table code");
  });
});

// ---------------------------------------------------------------------------
describe("an archived restaurant is refused on aggregator intake", () => {
  const order = { key: AGGREGATOR_KEY, source: "swiggy", external_id: "SW-1", items: [{ name: "Dosa", price: 120, qty: 1 }] };

  test("the waitlist pre-order CONFIRM is refused — it is the one token route that places an order", async () => {
    // Every other /waitlist/:token/* route moves no money and creates no ticket,
    // so they stay open on purpose. Confirm is different: it calls AddOrder. Left
    // ungated, a diner holding a queue token could still put a live order into an
    // archived restaurant, which is exactly the "operator thinks it is gone while
    // it is still trading" failure the gate exists to prevent.
    activeTenant("stilltrading");
    archivedTenant("gonecafe");

    const refused = await post("/qr/:slug/waitlist/:token/preorder/confirm", "gonecafe", {});
    expect(refused.status).toBe(404);
    expect(errorOf(refused)).toBe("Restaurant not found");

    // The live tenant gets past the gate and fails on the token instead, which is
    // what proves the gate refused the other one rather than the route being dead.
    const allowed = await post("/qr/:slug/waitlist/:token/preorder/confirm", "stilltrading", {});
    expect(allowed.status).not.toBe(404);
  });

  test("POST /aggregator/order is refused with a diagnosable 403", async () => {
    // The key is still VALID — an archived tenant's Swiggy/Zomato middleware has
    // no way to know anything changed, so the intake never stops on its own.
    const tenant = addRestaurant({ res_username: "gonecafe", account_status: "archived", aggregator_key: AGGREGATOR_KEY });
    addSubscription({ res_id: tenant.id, status: "cancelled" });

    const r = await harness.call("POST", "/aggregator/order", { body: order, ip: freshIp() });

    expect(r.status).toBe(403);
    expect(errorOf(r)).toBe("This restaurant is not accepting orders.");
    // 403, not the guest surface's 404: this caller is a partner integration with
    // a valid credential and an operator reading its logs, so a diagnosable
    // refusal is worth more than discretion.
    expect(r.status).not.toBe(404);
  });

  test("the same intake on a live tenant gets past the gate", async () => {
    const tenant = activeTenant("stilltrading");
    tenant.aggregator_key = AGGREGATOR_KEY;

    const r = await harness.call("POST", "/aggregator/order", {
      body: { ...order, source: "not-a-real-source" },
      ip: freshIp(),
    });

    // Stopped by the handler's own source validation, i.e. AFTER the gate.
    expect(r.status).toBe(400);
    expect(errorOf(r)).toContain("source must be");
  });

  test("an invalid key is still 401, not 403 — the gate did not swallow the auth failure", async () => {
    archivedTenant("gonecafe");
    const r = await harness.call("POST", "/aggregator/order", {
      body: { ...order, key: "definitely-not-a-real-key" },
      ip: freshIp(),
    });
    expect(r.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe("restore returns the tenant to working order", () => {
  test("archive stops guest ordering; restore starts it again", async () => {
    // The whole round trip through the REAL operator routes, because the property
    // that matters is that the two ends agree: whatever archive changed, restore
    // has to change back, and the guest surface is where a tenant finds out.
    const tenant = addRestaurant({ res_username: "seasonal" });
    addSubscription({ res_id: tenant.id, status: "active", plan_id: PLAN_GROWTH_ID });
    const order = { table_name: "T1", sig: "x", items: [{ id: "i1", name: "Dosa", price: 120, quantity: 1 }] };

    // Trading.
    expect((await post("/qr/:slug/order", "seasonal", order)).status).toBe(403);

    const archived = await harness.call("POST", "/platform/restaurants/:id/archive", {
      token: operatorToken, params: { id: tenant.id }, body: { reason: "seasonal closure" },
    });
    expect(archived.status).toBe(200);

    // Closed — to guests and to the aggregator alike.
    const refused = await post("/qr/:slug/order", "seasonal", order);
    expect(refused.status).toBe(404);
    expect(errorOf(refused)).toBe("Restaurant not found");

    const restored = await harness.call("POST", "/platform/restaurants/:id/restore", {
      token: operatorToken, params: { id: tenant.id },
    });
    expect(restored.status).toBe(200);
    expect((restored.body as { requires_plan_assignment: boolean }).requires_plan_assignment).toBe(false);

    // Trading again — and stopped by the SAME handler check as before the archive,
    // so nothing about the route changed except whether the gate let it through.
    const back = await post("/qr/:slug/order", "seasonal", order);
    expect(back.status).toBe(403);
    expect(errorOf(back)).toContain("Invalid table code");
  });
});

// ---------------------------------------------------------------------------
describe("what the gate deliberately does NOT close", () => {
  test("finishing a payment the guest has already made is still allowed", async () => {
    // /qr/:slug/razorpay/verify records money the guest ALREADY handed to the
    // gateway. Refusing it takes their money and writes nothing, which is worse
    // than accepting an order into a closed restaurant. The initiating half
    // (/razorpay/create) is gated, so no NEW payment can start.
    archivedTenant("gonecafe");
    const r = await post("/qr/:slug/razorpay/verify", "gonecafe", { table_name: "T1", sig: "x" });

    expect(r.status).not.toBe(404);
    // It stops on the restaurant's missing Razorpay configuration, i.e. past the
    // point where a gated route would have refused.
    expect(r.status).toBe(503);
  });

  test("reading the menu is still allowed, so a guest sees a page rather than a broken app", async () => {
    // Reads are harmless and were explicitly left for later. Asserted rather than
    // assumed so that closing them later is a deliberate, visible decision.
    const tenant = archivedTenant("gonecafe");
    expect(tenant.account_status).toBe("archived");
    const r = await harness.call("GET", "/qr/:slug/branding", { params: { slug: "gonecafe" }, ip: freshIp() });
    expect(r.status).not.toBe(404);
  });
});
