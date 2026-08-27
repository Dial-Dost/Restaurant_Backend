// The CUSTOMIZABLE queue pre-order menu, end to end over the real route
// handlers: what a queuing walk-in is SERVED (GET /qr/:slug/queue-menu) and what
// the pre-order write ACCEPTS (POST /qr/:slug/waitlist/:token/preorder).
//
// WHY THIS SUITE EXISTS — the whole feature rests on one claim: the rule is
// enforced on the SERVER. Hiding a dish in the browser would be theatre. A guest
// with a stale tab, a shared link, or curl must be refused the same dish the
// page never showed them, and the DINE-IN menu must be completely unaffected
// (that is the point: keep the 40-minute biryani off the queue list while it
// stays orderable at the table).
//
// The pure rules are unit-tested in queue_menu.test.ts. This drives the routes
// over the shared platform fixture, the same way waitlist_preorder.test.ts does.

import { describe, test, expect, beforeAll, beforeEach } from "@jest/globals";
import {
  addMenuItem,
  addOutlet,
  addRestaurant,
  addSubscription,
  addWaitlistEntry,
  makeFakeApp,
  resetStore,
  setQueueMenuConfig,
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
// Imported lazily (after the pg mock is in place) so the dine-in menu read can
// be driven through the same data layer the /qr/:slug/menu route uses.
let db: typeof import("../database_supabase");

// Every guest waitlist route is rate limited per IP against a process-wide store
// no test resets, so each call gets its own IP or the suite 429s itself.
let ipSeq = 0;
const freshIp = (): string => `203.0.113.${String((ipSeq++ % 250) + 1)}`;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  process.env.PLATFORM_DATABASE_URL =
    process.env.PLATFORM_DATABASE_URL || "postgres://fixture:fixture@localhost:5432/fixture";

  const guestRoutes = await import("../routes/guest");
  db = await import("../database_supabase");
  harness = makeFakeApp();
  guestRoutes.registerGuestWaitlistAndPaymentRoutes(harness.app as never);
});

beforeEach(() => { resetStore(); });

const get = (path: string, params: Record<string, string>) =>
  harness.call("GET", path, { params, ip: freshIp() });
const post = (path: string, params: Record<string, string>, body: Record<string, unknown> = {}) =>
  harness.call("POST", path, { params, body, query: {}, ip: freshIp() });

const SLUG = "gaia";

interface QueueMenuBody {
  restaurant_name?: string;
  currency?: string;
  configured?: boolean;
  queue_show_menu?: boolean;
  queue_menu?: { headline?: string; intro?: string; show_prices?: boolean };
  categories?: string[];
  items?: { id: string; name: string; price: number; category: string }[];
}

/** An active tenant whose menu spans three categories — enough to tell an
 *  alphabetical order from an arranged one, and to exclude a whole section. */
function tenantWithMenu(): {
  r: RestaurantRow;
  outlet: OutletRow;
  biryani: MenuRow;
  paneer: MenuRow;
  papad: MenuRow;
  lassi: MenuRow;
} {
  const r = addRestaurant({ res_username: SLUG, res_name: "Gaia Kitchen" });
  addSubscription({ res_id: r.id, status: "active" });
  const outlet = addOutlet({ res_id: r.id });
  const seed = { res_id: r.id, outlet_id: outlet.id };
  // Seeded oldest-first; GetMenuItems returns newest-first, so the served order
  // is lassi, papad, paneer, biryani.
  const biryani = addMenuItem({ ...seed, name: "Dum Biryani", price: 480, category: "Mains" });
  const paneer = addMenuItem({ ...seed, name: "Paneer Tikka", price: 390, category: "Starters" });
  const papad = addMenuItem({ ...seed, name: "Masala Papad", price: 90, category: "Starters" });
  const lassi = addMenuItem({ ...seed, name: "Sweet Lassi", price: 120, category: "Drinks" });
  return { r, outlet, biryani, paneer, papad, lassi };
}

const namesOf = (body: unknown): string[] => ((body as QueueMenuBody).items ?? []).map((i) => i.name);

const storedPreorder = (token: string): { id: string; name: string; price: number; quantity: number }[] => {
  const w = waitlists().find((x) => x.token === token);
  return w ? (JSON.parse(w.pre_order) as { id: string; name: string; price: number; quantity: number }[]) : [];
};

/** The DINE-IN menu, read exactly the way GET /qr/:slug/menu reads it. The whole
 *  promise of this feature is that narrowing the queue menu leaves this alone. */
const dineInMenu = async (): Promise<string[]> => {
  const items = await db.withTenant(
    { res_id: "", outlet_id: "", employeeId: "", role: "" } as never,
    () => db.GetMenuItems(SLUG),
  );
  return items.map((i) => i.name);
};

// ---------------------------------------------------------------------------
describe("no config — the shipped behaviour, bit for bit", () => {
  test("the whole available menu, categories alphabetical, prices on", async () => {
    tenantWithMenu();

    const res = await get("/qr/:slug/queue-menu", { slug: SLUG });
    expect(res.status).toBe(200);
    const body = res.body as QueueMenuBody;

    // Every dish, in the menu's own newest-first order — untouched.
    expect(namesOf(body)).toEqual(["Sweet Lassi", "Masala Papad", "Paneer Tikka", "Dum Biryani"]);
    // Object.keys(byCategory).sort() is what the queue page did before this
    // feature existed.
    expect(body.categories).toEqual(["Drinks", "Mains", "Starters"]);
    // Nothing was customized, so the page keeps its own localised copy and its
    // prices, and knows not to treat an empty list as a deliberate silence.
    expect(body.configured).toBe(false);
    // "" for the copy = "use your own localised line". The SELECTION rule is
    // deliberately not here: it is the server's business, not the browser's.
    expect(body.queue_menu).toEqual({ headline: "", intro: "", show_prices: true });
    // The master switch and the branding the page paints itself with still ride
    // along, so this stays a single round trip.
    expect(body.queue_show_menu).toBe(true);
    expect(body.restaurant_name).toBe("Gaia Kitchen");
    expect(body.currency).toBe("₹");
  });

  test("a sold-out dish is absent — the page's client-side filter, now server-side", async () => {
    const { r, outlet } = tenantWithMenu();
    addMenuItem({ res_id: r.id, outlet_id: outlet.id, name: "Fish Curry", price: 520, category: "Mains", available: false });

    const res = await get("/qr/:slug/queue-menu", { slug: SLUG });
    expect(namesOf(res.body)).not.toContain("Fish Curry");
  });

  test("staging a pre-order still works exactly as before", async () => {
    const { r, paneer } = tenantWithMenu();
    const entry = addWaitlistEntry({ res_id: r.id, status: "waiting" });

    const res = await post("/qr/:slug/waitlist/:token/preorder", { slug: SLUG, token: entry.token }, {
      items: [{ id: paneer.id, name: "Paneer Tikka", price: 1, quantity: 2 }],
    });

    expect(res.status).toBe(200);
    expect(storedPreorder(entry.token)).toEqual([
      expect.objectContaining({ id: paneer.id, name: "Paneer Tikka", price: 390, quantity: 2 }),
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("an EXCLUDED dish is unreachable — served and accepted must agree", () => {
  test("it is absent from the queue payload, and its now-empty category goes with it", async () => {
    const { r, biryani } = tenantWithMenu();
    setQueueMenuConfig(r.id, { mode: "exclude", items: [biryani.id] });

    const res = await get("/qr/:slug/queue-menu", { slug: SLUG });
    const body = res.body as QueueMenuBody;
    expect(namesOf(body)).toEqual(["Sweet Lassi", "Masala Papad", "Paneer Tikka"]);
    // Nothing anywhere in the payload names it — not the item list, and not the
    // config echo either. This is not a hidden flag the browser is trusted to
    // honour, and it does not tell the guest what they are missing.
    expect(JSON.stringify(body)).not.toContain(biryani.id);
    expect(JSON.stringify(body)).not.toContain("Biryani");
    // Mains held only the biryani, so the tab must not render empty.
    expect(body.categories).toEqual(["Drinks", "Starters"]);
    expect(body.configured).toBe(true);
  });

  test("the pre-order write REFUSES it — a stale tab or a curl cannot stage it", async () => {
    // The attack this closes: the guest loaded the page before the kitchen
    // excluded the dish (or never used the page at all) and posts the id anyway.
    const { r, biryani, paneer } = tenantWithMenu();
    setQueueMenuConfig(r.id, { mode: "exclude", items: [biryani.id] });
    const entry = addWaitlistEntry({ res_id: r.id, status: "waiting" });

    const res = await post("/qr/:slug/waitlist/:token/preorder", { slug: SLUG, token: entry.token }, {
      items: [
        { id: biryani.id, name: "Dum Biryani", price: 480, quantity: 1 },
        { id: paneer.id, name: "Paneer Tikka", price: 390, quantity: 2 },
      ],
    });

    expect(res.status).toBe(200);
    // Dropped, exactly the way an off-menu item is dropped — the guest keeps the
    // rest of their picks instead of losing the whole save.
    const stored = storedPreorder(entry.token);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: paneer.id, name: "Paneer Tikka", price: 390, quantity: 2 });
  });

  test("excluding by NAME instead of id is refused too", async () => {
    // The line arrives with no usable id; repriceFromMenu resolves it by name,
    // and the queue rule then has to catch the resolved item — otherwise the
    // by-name path would be a way around the exclusion.
    const { r, biryani } = tenantWithMenu();
    setQueueMenuConfig(r.id, { mode: "exclude", items: [biryani.id] });
    const entry = addWaitlistEntry({ res_id: r.id, status: "waiting" });

    await post("/qr/:slug/waitlist/:token/preorder", { slug: SLUG, token: entry.token }, {
      items: [{ id: "not-a-real-id", name: "Dum Biryani", price: 480, quantity: 1 }],
    });

    expect(storedPreorder(entry.token)).toEqual([]);
  });

  test("THE POINT: the same dish is still fully orderable on the DINE-IN menu", async () => {
    const { r, biryani } = tenantWithMenu();
    setQueueMenuConfig(r.id, { mode: "exclude", items: [biryani.id] });

    // The queue guest cannot see it...
    expect(namesOf((await get("/qr/:slug/queue-menu", { slug: SLUG })).body)).not.toContain("Dum Biryani");
    // ...and the guest sitting at a table still can. Narrowing the queue menu is
    // not "mark it unavailable".
    expect(await dineInMenu()).toContain("Dum Biryani");
  });

  test("excluding a CATEGORY takes the whole section out of the queue menu only", async () => {
    const { r } = tenantWithMenu();
    setQueueMenuConfig(r.id, { mode: "exclude", categories: ["Starters"] });

    const body = (await get("/qr/:slug/queue-menu", { slug: SLUG })).body as QueueMenuBody;
    expect(namesOf(body)).toEqual(["Sweet Lassi", "Dum Biryani"]);
    expect(body.categories).toEqual(["Drinks", "Mains"]);
    expect(await dineInMenu()).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
describe("an INCLUDE allowlist", () => {
  test("only the ticked items and categories are served, and only they are accepted", async () => {
    const { r, papad, lassi, paneer } = tenantWithMenu();
    // "While you wait you may order drinks, plus the papad."
    setQueueMenuConfig(r.id, { mode: "include", categories: ["Drinks"], items: [papad.id] });

    const body = (await get("/qr/:slug/queue-menu", { slug: SLUG })).body as QueueMenuBody;
    expect(namesOf(body)).toEqual(["Sweet Lassi", "Masala Papad"]);

    const entry = addWaitlistEntry({ res_id: r.id, status: "waiting" });
    await post("/qr/:slug/waitlist/:token/preorder", { slug: SLUG, token: entry.token }, {
      items: [
        { id: lassi.id, name: "Sweet Lassi", price: 120, quantity: 2 },
        { id: paneer.id, name: "Paneer Tikka", price: 390, quantity: 1 }, // not on the list
      ],
    });
    expect(storedPreorder(entry.token).map((i) => i.id)).toEqual([lassi.id]);
  });

  test("an EMPTY allowlist offers nothing, and says so as a choice rather than a failure", async () => {
    const { r } = tenantWithMenu();
    setQueueMenuConfig(r.id, { mode: "include", items: [], categories: [] });

    const body = (await get("/qr/:slug/queue-menu", { slug: SLUG })).body as QueueMenuBody;
    expect(body.items).toEqual([]);
    // `configured` is what stops the page apologising with "menu unavailable
    // right now" for a restaurant that deliberately takes no pre-orders.
    expect(body.configured).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("how the queue menu presents itself", () => {
  test("the tenant's headline, intro, price switch and category order all reach the page", async () => {
    const { r } = tenantWithMenu();
    setQueueMenuConfig(r.id, {
      headline: "Order while you wait",
      intro: "Drinks reach your table the moment you sit down.",
      show_prices: false,
      category_order: ["Drinks", "Starters"],
    });

    const body = (await get("/qr/:slug/queue-menu", { slug: SLUG })).body as QueueMenuBody;
    expect(body.queue_menu).toMatchObject({
      headline: "Order while you wait",
      intro: "Drinks reach your table the moment you sit down.",
      show_prices: false,
    });
    // Arranged categories lead; anything the owner did not pin stays alphabetical.
    expect(body.categories).toEqual(["Drinks", "Starters", "Mains"]);
    // Ordering is presentation only — every dish is still offered.
    expect(namesOf(body)).toHaveLength(4);
  });

  test("a category the owner arranged and later deleted is ignored, not rendered empty", async () => {
    const { r } = tenantWithMenu();
    setQueueMenuConfig(r.id, { category_order: ["Desserts", "Mains"] });

    const body = (await get("/qr/:slug/queue-menu", { slug: SLUG })).body as QueueMenuBody;
    expect(body.categories).toEqual(["Mains", "Drinks", "Starters"]);
  });

  test("a stored value that is nonsense degrades to the shipped defaults, never to a broken page", async () => {
    const { r } = tenantWithMenu();
    setQueueMenuConfig(r.id, { mode: "sometimes", category_order: "Drinks", show_prices: "no" });

    const body = (await get("/qr/:slug/queue-menu", { slug: SLUG })).body as QueueMenuBody;
    expect(body.queue_menu).toEqual({ headline: "", intro: "", show_prices: true });
    expect(namesOf(body)).toHaveLength(4);
    expect(body.categories).toEqual(["Drinks", "Mains", "Starters"]);
  });
});

// ---------------------------------------------------------------------------
describe("an unknown restaurant", () => {
  test("404s like every other public route rather than leaking an empty menu", async () => {
    const res = await get("/qr/:slug/queue-menu", { slug: "nobody" });
    expect(res.status).toBe(404);
  });
});
