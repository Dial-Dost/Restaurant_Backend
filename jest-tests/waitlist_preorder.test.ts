// The guest waitlist PRE-ORDER flow: a queued walk-in stages picks from the menu
// while they wait; the picks are held on their queue entry, become 'pending' when
// staff seat the party, and are then confirmed (placed as a real order), declined,
// or claimed (seed the table cart).
//
// WHY THIS SUITE EXISTS — a production incident (tenant test session, 2026-08-24).
// The backend was under session-pool exhaustion ("max clients reached in session
// mode"), so reads were failing intermittently. repriceFromMenu swallowed the
// menu READ ERROR into "the menu is empty" (`.catch(() => [])`), and every
// waitlist path treated that as "drop every line":
//
//   - staging a pre-order WIPED the guest's held items to [] and reported success;
//   - confirming one destroyed the 'pending' state ("no longer on the menu");
//   - claiming one consumed it while returning ZERO items.
//
// From the guest's side that is exactly "the pre-order isn't working": picks
// vanish with a green checkmark. The fix makes a menu read failure THROW (fail
// loudly + retryably, state intact) on the paths that persist or place, and fall
// back to the held items on the paths that only seed a cart. These tests drive
// the REAL route handlers from routes/guest.ts over the shared platform fixture,
// with `breakMenuRead()` reproducing the production failure.

import { describe, test, expect, beforeAll, beforeEach } from "@jest/globals";
import {
  addMenuItem,
  addOutlet,
  addRestaurant,
  addSubscription,
  addWaitlistEntry,
  breakMenuRead,
  healMenuRead,
  makeFakeApp,
  resetStore,
  waitlists,
  type FakeApp,
  type MenuRow,
  type OutletRow,
  type RestaurantRow,
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

// Every guest waitlist route is rate limited per IP against a process-wide store
// no test resets, so each call gets its own IP or the suite 429s itself.
let ipSeq = 0;
const freshIp = (): string => `198.51.100.${String((ipSeq++ % 250) + 1)}`;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  process.env.PLATFORM_DATABASE_URL =
    process.env.PLATFORM_DATABASE_URL || "postgres://fixture:fixture@localhost:5432/fixture";

  const guestRoutes = await import("../routes/guest");
  harness = makeFakeApp();
  guestRoutes.registerGuestWaitlistAndPaymentRoutes(harness.app as never);
});

beforeEach(() => { resetStore(); });

const post = (path: string, params: Record<string, string>, body: Record<string, unknown> = {}, query: Record<string, string> = {}) =>
  harness.call("POST", path, { params, body, query, ip: freshIp() });
const get = (path: string, params: Record<string, string>) =>
  harness.call("GET", path, { params, ip: freshIp() });

const errorOf = (r: { body: unknown }): string => (r.body as { error?: string })?.error ?? "";

/** An active tenant with one outlet (the guest flow resolves the default outlet,
 *  and GetMenuItems is outlet-scoped) and one ₹390 dish on the menu. */
function tenantWithMenu(slug = "gaia"): { r: RestaurantRow; outlet: OutletRow; paneer: MenuRow } {
  const r = addRestaurant({ res_username: slug });
  addSubscription({ res_id: r.id, status: "active" });
  const outlet = addOutlet({ res_id: r.id });
  const paneer = addMenuItem({ res_id: r.id, outlet_id: outlet.id, name: "Paneer Tikka", price: 390 });
  return { r, outlet, paneer };
}

const storedPreorder = (token: string): { id: string; name: string; price: number; quantity: number }[] => {
  const w = waitlists().find((x) => x.token === token);
  return w ? (JSON.parse(w.pre_order) as { id: string; name: string; price: number; quantity: number }[]) : [];
};

// ---------------------------------------------------------------------------
describe("staging a pre-order (POST /qr/:slug/waitlist/:token/preorder)", () => {
  test("items are re-priced from the menu and persisted; off-menu items drop BY DESIGN", async () => {
    const { r, paneer } = tenantWithMenu();
    const entry = addWaitlistEntry({ res_id: r.id, status: "waiting" });

    const res = await post("/qr/:slug/waitlist/:token/preorder", { slug: "gaia", token: entry.token }, {
      items: [
        // Client-sent price is hostile (₹1 for a ₹390 dish) — the MENU price must win.
        { id: paneer.id, name: "Paneer Tikka", price: 1, quantity: 2 },
        // Not on the menu at all: cannot be billed, silently dropped (the contract).
        { id: "ghost", name: "Free Steak", price: 0, quantity: 3 },
      ],
    });

    expect(res.status).toBe(200);
    expect((res.body as { success?: boolean })?.success).toBe(true);
    const stored = storedPreorder(entry.token);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: paneer.id, name: "Paneer Tikka", price: 390, quantity: 2 });
  });

  test("REGRESSION: a menu READ FAILURE must not wipe the held pre-order and report success", async () => {
    // The incident shape: the guest had already staged picks; the next save hit
    // the exhausted pool. Old behaviour: menu read error -> "menu is empty" ->
    // every line dropped -> pre_order overwritten with [] -> 200 success. The
    // guest's picks were gone and nobody was told.
    const { r, paneer } = tenantWithMenu();
    const held = JSON.stringify([{ id: paneer.id, name: "Paneer Tikka", price: 390, quantity: 2 }]);
    const entry = addWaitlistEntry({ res_id: r.id, status: "waiting", pre_order: held });

    breakMenuRead();
    const res = await post("/qr/:slug/waitlist/:token/preorder", { slug: "gaia", token: entry.token }, {
      items: [{ id: paneer.id, name: "Paneer Tikka", price: 390, quantity: 5 }],
    });

    expect(res.status).toBe(500);
    expect(errorOf(res)).toBe("Unable to save your selection");
    // The held items are byte-identical — nothing was wiped, the guest can retry.
    expect(waitlists().find((x) => x.token === entry.token)?.pre_order).toBe(held);

    // And once the database recovers, the same save goes through.
    healMenuRead();
    const retry = await post("/qr/:slug/waitlist/:token/preorder", { slug: "gaia", token: entry.token }, {
      items: [{ id: paneer.id, name: "Paneer Tikka", price: 390, quantity: 5 }],
    });
    expect(retry.status).toBe(200);
    expect(storedPreorder(entry.token)[0]).toMatchObject({ quantity: 5 });
  });
});

// ---------------------------------------------------------------------------
describe("the seated handshake (confirm / decline / claim by token)", () => {
  test("GET /qr/:slug/waitlist/:token exposes pre_order_status — the guest page's cue to ask", async () => {
    // Seating no longer places the pre-order (SeatWaitlistEntry holds it as
    // 'pending'); the guest queue page can only ask "send your picks to the
    // kitchen?" if the poll payload carries the pending state + the table token.
    const { r, paneer } = tenantWithMenu();
    const entry = addWaitlistEntry({
      res_id: r.id,
      status: "seated",
      table_name: "T4",
      pre_order: JSON.stringify([{ id: paneer.id, name: "Paneer Tikka", price: 390, quantity: 2 }]),
      pre_order_status: "pending",
      seated_at: new Date(),
    });

    const res = await get("/qr/:slug/waitlist/:token", { slug: "gaia", token: entry.token });
    expect(res.status).toBe(200);
    const body = res.body as { status?: string; pre_order_status?: string; qr_token?: string | null; pre_order?: unknown[] };
    expect(body.status).toBe("seated");
    expect(body.pre_order_status).toBe("pending");
    expect(body.pre_order).toHaveLength(1);
    // The signed table token the queue page redirects with.
    expect(typeof body.qr_token).toBe("string");
  });

  test("REGRESSION: a menu read failure during CONFIRM keeps the pre-order 'pending' (retryable), not destroyed", async () => {
    // Old behaviour: read error -> "menu is empty" -> pre_order_status wiped to
    // 'none' + "None of the held items are on the menu any more". The guest's
    // confirmed order silently never reached the kitchen and could not be retried.
    const { r, paneer } = tenantWithMenu();
    const entry = addWaitlistEntry({
      res_id: r.id,
      status: "seated",
      table_name: "T4",
      pre_order: JSON.stringify([{ id: paneer.id, name: "Paneer Tikka", price: 390, quantity: 2 }]),
      pre_order_status: "pending",
      seated_at: new Date(),
    });

    breakMenuRead();
    const res = await post("/qr/:slug/waitlist/:token/preorder/confirm", { slug: "gaia", token: entry.token });

    expect(res.status).toBe(500);
    expect(errorOf(res)).toBe("Unable to confirm your order");
    // Still pending — the transaction rolled back; a retry can still place it.
    expect(waitlists().find((x) => x.token === entry.token)?.pre_order_status).toBe("pending");
  });

  test("a confirm replay returns the SAME order instead of ringing the kitchen twice", async () => {
    const { r } = tenantWithMenu();
    const entry = addWaitlistEntry({
      res_id: r.id,
      status: "seated",
      table_name: "T4",
      pre_order_status: "confirmed",
      placed_order_id: "order-77",
    });

    const res = await post("/qr/:slug/waitlist/:token/preorder/confirm", { slug: "gaia", token: entry.token });
    expect(res.status).toBe(200);
    expect(res.body as Record<string, unknown>).toMatchObject({ success: true, placed_order_id: "order-77", already: true });
  });

  test("DECLINE still hands the guest their items when the menu cannot be read", async () => {
    // Decline's items only seed a cart (the /order page re-prices everything it
    // submits), so a transient read failure falls back to the held items rather
    // than blocking the guest's "I'll change it at the table".
    const { r, paneer } = tenantWithMenu();
    const entry = addWaitlistEntry({
      res_id: r.id,
      status: "seated",
      table_name: "T4",
      pre_order: JSON.stringify([{ id: paneer.id, name: "Paneer Tikka", price: 390, quantity: 2 }]),
      pre_order_status: "pending",
    });

    breakMenuRead();
    const res = await post("/qr/:slug/waitlist/:token/preorder/decline", { slug: "gaia", token: entry.token });

    expect(res.status).toBe(200);
    const items = (res.body as { items?: unknown[] })?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "Paneer Tikka", quantity: 2 });
    expect(waitlists().find((x) => x.token === entry.token)?.pre_order_status).toBe("declined");
  });

  test("REGRESSION: CLAIM under a menu read failure must not consume the pre-order with ZERO items", async () => {
    // Old behaviour: read error -> priced = [] -> status flipped to 'claimed'
    // anyway -> the cart seeded with nothing and the items unreachable forever.
    const { r, paneer } = tenantWithMenu();
    const entry = addWaitlistEntry({
      res_id: r.id,
      status: "seated",
      table_name: "T4",
      pre_order: JSON.stringify([{ id: paneer.id, name: "Paneer Tikka", price: 390, quantity: 2 }]),
      pre_order_status: "declined",
    });

    breakMenuRead();
    const res = await post("/qr/:slug/waitlist/:token/preorder/claim", { slug: "gaia", token: entry.token });

    expect(res.status).toBe(200);
    const body = res.body as { status?: string; items?: unknown[] };
    expect(body.status).toBe("claimed");
    expect(body.items).toHaveLength(1);
    expect(body.items?.[0]).toMatchObject({ name: "Paneer Tikka", quantity: 2 });
  });

  test("CLAIM with ?peek=1 previews without consuming — a refresh cannot lose the picks", async () => {
    const { r, paneer } = tenantWithMenu();
    const entry = addWaitlistEntry({
      res_id: r.id,
      status: "seated",
      table_name: "T4",
      pre_order: JSON.stringify([{ id: paneer.id, name: "Paneer Tikka", price: 390, quantity: 2 }]),
      pre_order_status: "declined",
    });

    const peek = await post("/qr/:slug/waitlist/:token/preorder/claim", { slug: "gaia", token: entry.token }, {}, { peek: "1" });
    expect(peek.status).toBe(200);
    expect((peek.body as { status?: string }).status).toBe("declined");
    expect((peek.body as { items?: unknown[] }).items).toHaveLength(1);
    expect(waitlists().find((x) => x.token === entry.token)?.pre_order_status).toBe("declined");

    // The real claim then consumes exactly once.
    const claim = await post("/qr/:slug/waitlist/:token/preorder/claim", { slug: "gaia", token: entry.token });
    expect((claim.body as { status?: string }).status).toBe("claimed");
    expect(waitlists().find((x) => x.token === entry.token)?.pre_order_status).toBe("claimed");
  });
});
