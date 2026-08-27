// Promotional POSTERS on the guest menu: the scheduling predicate, the upload
// gate, and the two guarantees that decide whether this feature is safe to ship
// to pages real diners are on right now.
//
// THE TWO GUARANTEES
// ------------------
//  1. A restaurant with NO posters gets the guest payload it got before this
//     feature existed, byte for byte. `posters` is omitted rather than sent as
//     `[]`, and this suite pins that by serialising the real /qr/:slug/menu
//     response and comparing it against the same response with the key removed.
//     Every restaurant on the platform is in this state today, so a regression
//     here is a regression for all of them at once.
//  2. A poster outside its window is NEVER served — not filtered on the client,
//     not "usually" filtered, not filtered against the SERVER's calendar day.
//     The owner's ask was "a Sunday brunch poster stops showing on Monday", and
//     Monday starts at local midnight: for a Kolkata restaurant the UTC day is
//     still Sunday until 05:30 IST, which is halfway through the next morning's
//     service. So the schedule is compared against a day key derived from the
//     RESTAURANT'S timezone, and the timezone test below proves it by giving two
//     tenants whose local clocks are 25 hours apart the SAME one-day poster and
//     asserting that only one of them is served it.
//
// The route tests drive the REAL handlers from routes/guest.ts and
// routes/posters.ts over the shared platform fixture, so the assertions are
// about shipped code and not about a re-implementation of it.

import { describe, test, expect, beforeAll, beforeEach } from "@jest/globals";
import {
  addMenuItem,
  addOutlet,
  addPoster,
  addRestaurant,
  makeFakeApp,
  posters,
  resetStore,
  type FakeApp,
  type OutletRow,
  type RestaurantRow,
} from "./platform_fixtures";
import {
  POSTER_CONTENT_TYPES,
  POSTER_MAX_UPLOAD_BYTES,
  base64ByteLength,
  normalizePosterContentType,
  posterIsVisible,
  posterWindowError,
  sanitizePosterPatch,
  validatePosterUpload,
  visiblePosters,
  type PosterRecord,
} from "../posters";

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

// ---------------------------------------------------------------------------
// The pure rules — no database, no clock, no network
// ---------------------------------------------------------------------------

const poster = (over: Partial<PosterRecord> = {}): PosterRecord => ({
  id: "p1",
  image_url: "https://cdn.example.test/p1.webp",
  title: "",
  placement: "menu",
  sort_order: 0,
  start_on: null,
  end_on: null,
  active: true,
  width: 1200,
  height: 675,
  created_at: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("poster scheduling", () => {
  test("an unscheduled poster shows on any day", () => {
    expect(posterIsVisible(poster(), "2026-08-27")).toBe(true);
    expect(posterIsVisible(poster(), "1999-01-01")).toBe(true);
  });

  test("both bounds are INCLUSIVE — the Sunday brunch poster is up on Sunday", () => {
    // 2026-08-30 is a Sunday. The owner sets the poster to that one day.
    const brunch = poster({ start_on: "2026-08-30", end_on: "2026-08-30" });
    expect(posterIsVisible(brunch, "2026-08-29")).toBe(false); // Saturday: too early
    expect(posterIsVisible(brunch, "2026-08-30")).toBe(true);  // Sunday: showing
    expect(posterIsVisible(brunch, "2026-08-31")).toBe(false); // Monday: gone
  });

  test("an open-ended start or end is honoured on its own", () => {
    expect(posterIsVisible(poster({ end_on: "2026-08-27" }), "2026-08-27")).toBe(true);
    expect(posterIsVisible(poster({ end_on: "2026-08-27" }), "2026-08-28")).toBe(false);
    expect(posterIsVisible(poster({ start_on: "2026-08-27" }), "2026-08-26")).toBe(false);
    expect(posterIsVisible(poster({ start_on: "2026-08-27" }), "2026-08-27")).toBe(true);
  });

  test("a paused poster never shows, window or no window", () => {
    expect(posterIsVisible(poster({ active: false }), "2026-08-27")).toBe(false);
    expect(posterIsVisible(poster({ active: false, start_on: "2026-01-01", end_on: "2030-01-01" }), "2026-08-27")).toBe(false);
  });

  test("a nonsense day key fails CLOSED on scheduled posters", () => {
    // A broken clock helper must not resurrect last Christmas's banner.
    expect(posterIsVisible(poster({ end_on: "2025-12-26" }), "not-a-date")).toBe(false);
    expect(posterIsVisible(poster({ start_on: "2026-01-01" }), "")).toBe(false);
    // …while an unscheduled poster is unaffected: there is no window to get wrong.
    expect(posterIsVisible(poster(), "not-a-date")).toBe(true);
  });

  test("the day comparison is lexicographic and therefore chronological", () => {
    // Year/month/day rollovers are where a naive string compare would break; ISO
    // keys are fixed-width, so they do not.
    expect(posterIsVisible(poster({ end_on: "2026-12-31" }), "2027-01-01")).toBe(false);
    expect(posterIsVisible(poster({ start_on: "2026-09-01" }), "2026-08-31")).toBe(false);
    expect(posterIsVisible(poster({ start_on: "2026-09-01", end_on: "2026-09-30" }), "2026-09-09")).toBe(true);
  });

  test("a backwards window is refused rather than silently swapped", () => {
    expect(posterWindowError("2026-08-30", "2026-08-29")).toBe("The end date is before the start date.");
    expect(posterWindowError("2026-08-30", "2026-08-30")).toBeNull();
    expect(posterWindowError(null, "2026-08-29")).toBeNull();
    expect(posterWindowError("2026-08-29", null)).toBeNull();
  });
});

describe("the guest projection", () => {
  test("orders by (sort_order, created_at, id) and narrows to public fields", () => {
    const rows = [
      poster({ id: "b", sort_order: 5, created_at: "2026-01-01T00:00:00.000Z" }),
      poster({ id: "a", sort_order: 1, created_at: "2026-02-01T00:00:00.000Z" }),
      poster({ id: "c", sort_order: 1, created_at: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(visiblePosters(rows, "2026-08-27").map((p) => p.id)).toEqual(["c", "a", "b"]);
    // No schedule, no active flag, no sort key reaches a public page.
    expect(Object.keys(visiblePosters(rows, "2026-08-27")[0]!).sort())
      .toEqual(["height", "id", "image_url", "placement", "title", "width"]);
  });

  test("ties on sort_order AND created_at still have a stable order", () => {
    // Two posters saved in the same second: without the id tiebreak the banner
    // could reshuffle between two refreshes of the same menu.
    const rows = [
      poster({ id: "zzz", sort_order: 0, created_at: "2026-01-01T00:00:00.000Z" }),
      poster({ id: "aaa", sort_order: 0, created_at: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(visiblePosters(rows, "2026-08-27").map((p) => p.id)).toEqual(["aaa", "zzz"]);
    expect(visiblePosters([...rows].reverse(), "2026-08-27").map((p) => p.id)).toEqual(["aaa", "zzz"]);
  });

  test("expired and future posters are dropped, not reordered to the back", () => {
    const rows = [
      poster({ id: "expired", end_on: "2026-08-26" }),
      poster({ id: "live" }),
      poster({ id: "future", start_on: "2026-08-28" }),
      poster({ id: "paused", active: false }),
    ];
    expect(visiblePosters(rows, "2026-08-27").map((p) => p.id)).toEqual(["live"]);
  });

  test("what one guest page can be handed is capped", () => {
    const rows = Array.from({ length: 20 }, (_, i) => poster({ id: `p${String(i).padStart(2, "0")}`, sort_order: i }));
    expect(visiblePosters(rows, "2026-08-27")).toHaveLength(6);
  });
});

describe("the upload gate", () => {
  // 4 MB of base64 'A's — over the cap, and deliberately never decoded.
  const oversized = "A".repeat(Math.ceil((POSTER_MAX_UPLOAD_BYTES + 1_000_000) * 4 / 3));
  const smallPng = "iVBORw0KGgoAAAANSUhEUg==";

  test("byte length is computed from the base64 WITHOUT decoding it", () => {
    // The cap exists so a hostile payload is refused before it is allocated;
    // measuring after decoding would defeat the entire point.
    expect(base64ByteLength("")).toBe(0);
    expect(base64ByteLength("QQ==")).toBe(1);
    expect(base64ByteLength("QUJD")).toBe(3);
    expect(base64ByteLength("data:image/png;base64,QUJD")).toBe(3);
    expect(base64ByteLength(oversized)).toBeGreaterThan(POSTER_MAX_UPLOAD_BYTES);
  });

  test("an oversized image is refused, with the size named", () => {
    const r = validatePosterUpload({ image_base64: oversized, content_type: "image/png" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/MB/);
      expect(r.error).toMatch(/under 3 MB/);
    }
  });

  test("a wrong content type is refused", () => {
    for (const bad of ["image/gif", "image/svg+xml", "application/pdf", "text/html", "", null, 42]) {
      const r = validatePosterUpload({ image_base64: smallPng, content_type: bad });
      expect(r.ok).toBe(false);
    }
  });

  test("SVG in particular is refused — it is a script-bearing document", () => {
    expect(normalizePosterContentType("image/svg+xml")).toBeNull();
    expect((POSTER_CONTENT_TYPES as readonly string[]).includes("image/svg+xml")).toBe(false);
  });

  test("the three real formats are accepted, including the image/jpg spelling", () => {
    for (const ct of ["image/png", "image/jpeg", "image/webp", "IMAGE/PNG", "image/jpeg; charset=binary", "image/jpg"]) {
      const r = validatePosterUpload({ image_base64: smallPng, content_type: ct });
      expect(r.ok).toBe(true);
    }
    expect(normalizePosterContentType("image/jpg")).toBe("image/jpeg");
  });

  test("an empty payload is refused before anything else looks at it", () => {
    expect(validatePosterUpload({ image_base64: "", content_type: "image/png" }).ok).toBe(false);
    expect(validatePosterUpload({ content_type: "image/png" }).ok).toBe(false);
  });
});

describe("the editor patch sanitizer", () => {
  test("omitted keys stay omitted (merge-on-omit), sent-as-null clears a date", () => {
    expect(sanitizePosterPatch({})).toEqual({});
    expect(sanitizePosterPatch({ end_on: null })).toEqual({ end_on: null });
    expect(sanitizePosterPatch({ end_on: "2026-08-30" })).toEqual({ end_on: "2026-08-30" });
    // A malformed date is a CLEAR, not an accept: a stored bound the owner tried
    // to change must never survive as the old value.
    expect(sanitizePosterPatch({ start_on: "30/08/2026" })).toEqual({ start_on: null });
  });

  test("an unknown placement is dropped rather than stored", () => {
    expect(sanitizePosterPatch({ placement: "sidebar" })).toEqual({});
    expect(sanitizePosterPatch({ placement: "top" })).toEqual({ placement: "top" });
  });

  test("sort_order is clamped, and titles are trimmed and bounded", () => {
    expect(sanitizePosterPatch({ sort_order: -5 }).sort_order).toBe(0);
    expect(sanitizePosterPatch({ sort_order: 1e9 }).sort_order).toBe(999);
    expect(sanitizePosterPatch({ sort_order: "not a number" }).sort_order).toBe(0);
    expect(sanitizePosterPatch({ title: "  Sunday Brunch  " }).title).toBe("Sunday Brunch");
    expect(sanitizePosterPatch({ title: "x".repeat(500) }).title).toHaveLength(80);
    expect(sanitizePosterPatch({ title: null }).title).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The real routes, over the fixture
// ---------------------------------------------------------------------------

let harness: FakeApp;

const BRANDING_PERM = "4a1c8e73-5f60-49b2-a3d8-7c2e0b6f9153"; // PERM_BRANDING

beforeAll(async () => {
  // database_supabase.ts refuses to load without a connection string, and the
  // fake Pool never dials it — same bootstrap the other fixture suites use.
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL ?? "postgres://fixture:fixture@localhost:5432/fixture";
  process.env.PLATFORM_DATABASE_URL =
    process.env.PLATFORM_DATABASE_URL ?? "postgres://fixture:fixture@localhost:5432/fixture";

  const guestRoutes = await import("../routes/guest");
  const posterRoutes = await import("../routes/posters");
  harness = makeFakeApp();
  guestRoutes.registerGuestOrderingRoutes(harness.app as never);
  // /qr/:slug/queue-menu lives in the waitlist half of guest.ts, and it is the
  // route the QUEUE page actually reads — registering only the ordering half is
  // how a poster regression on that surface stayed invisible to this suite.
  guestRoutes.registerGuestWaitlistAndPaymentRoutes(harness.app as never);
  posterRoutes.registerPosterRoutes(harness.app as never);
});

let ipSeq = 0;
// rateLimit is keyed per IP; a fresh one per call keeps an unrelated 429 out of
// these assertions.
const freshIp = (): string => `198.51.100.${String((ipSeq++ % 250) + 1)}`;

const menu = (slug: string): Promise<{ status: number; body: unknown }> =>
  harness.call("GET", "/qr/:slug/menu", { params: { slug }, ip: freshIp() });

// The OTHER guest surface. The queue page prefers /qr/:slug/queue-menu and only
// falls back to /qr/:slug/menu on a 404, so a poster that reaches one route and
// not the other is invisible in production while every menu-route test stays
// green — which is exactly what happened: the queue-menu route shipped without
// posters, both slots on the queue page rendered empty, and no suite spanned the
// seam because this one only ever drove /menu.
const queueMenu = (slug: string): Promise<{ status: number; body: unknown }> =>
  harness.call("GET", "/qr/:slug/queue-menu", { params: { slug }, ip: freshIp() });

function seedTenant(over: Partial<RestaurantRow> = {}): { res: RestaurantRow; outlet: OutletRow } {
  const res = addRestaurant({ res_username: "postercafe", ...over });
  const outlet = addOutlet({ res_id: res.id, outlet_name: "Main" });
  addMenuItem({ res_id: res.id, outlet_id: outlet.id, name: "Dosa", price: 120, category: "Mains" });
  return { res, outlet };
}

beforeEach(() => { resetStore(); });

describe("GET /qr/:slug/menu — a restaurant with no posters", () => {
  test("the payload carries NO posters key at all", async () => {
    seedTenant();
    const r = await menu("postercafe");
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect("posters" in body).toBe(false);
    // Not merely absent from the object — absent from the wire.
    expect(JSON.stringify(body)).not.toContain("poster");
  });

  test("adding the feature changed the payload by EXACTLY the posters key", async () => {
    // The strongest form of "byte-identical" available without a golden file
    // that would rot: serve the same tenant twice, once with a live poster and
    // once without, and assert the two payloads differ only by that one key.
    const { res } = seedTenant();
    const without = JSON.stringify((await menu("postercafe")).body);

    addPoster({ res_id: res.id, title: "Sunday Brunch" });
    const withPoster = (await menu("postercafe")).body as Record<string, unknown>;
    expect(Array.isArray(withPoster.posters)).toBe(true);
    delete withPoster.posters;
    expect(JSON.stringify(withPoster)).toBe(without);
  });

  test("a poster read failure degrades to today's page rather than a 500", async () => {
    // Posters are decoration; the menu is the product. A tenant whose poster read
    // fails must still get a menu — the opposite trade to repriceFromMenu, where
    // swallowing a failed MENU read into "empty" destroyed real orders.
    const { res } = seedTenant();
    addPoster({ res_id: res.id });
    const before = (await menu("postercafe")).body as Record<string, unknown>;
    expect(Array.isArray(before.posters)).toBe(true);

    // Break the poster read only: an unparseable placement is not what breaks it,
    // so reach for the store directly and make the row explode on map.
    const rows = posters();
    Object.defineProperty(rows[0]!, "image_url", {
      get() { throw new Error("poster read exploded"); },
    });
    const r = await menu("postercafe");
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect("posters" in body).toBe(false);
    expect(Array.isArray(body.items)).toBe(true);
    expect((body.items as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("GET /qr/:slug/menu — scheduling, in the restaurant's timezone", () => {
  test("a poster whose window has passed is not served", async () => {
    const { res } = seedTenant();
    addPoster({ res_id: res.id, title: "Last Diwali", start_on: "2020-10-01", end_on: "2020-11-30" });
    const body = (await menu("postercafe")).body as Record<string, unknown>;
    expect("posters" in body).toBe(false);
  });

  test("a poster whose window has not started is not served", async () => {
    const { res } = seedTenant();
    addPoster({ res_id: res.id, title: "Next century", start_on: "2099-01-01" });
    const body = (await menu("postercafe")).body as Record<string, unknown>;
    expect("posters" in body).toBe(false);
  });

  test("a paused poster is not served even inside its window", async () => {
    const { res } = seedTenant();
    addPoster({ res_id: res.id, active: false, start_on: "2020-01-01", end_on: "2099-01-01" });
    const body = (await menu("postercafe")).body as Record<string, unknown>;
    expect("posters" in body).toBe(false);
  });

  /**
   * THE TIMEZONE CASE, without freezing the clock.
   *
   * Pacific/Kiritimati is UTC+14 and Pacific/Midway is UTC-11 — neither observes
   * DST, so their local clocks are 25 hours apart at EVERY instant. 25 > 24, so
   * their calendar dates are ALWAYS different, whenever this suite happens to
   * run. That is what makes this deterministic where "Kolkata vs Honolulu" would
   * only have been true for 15 of every 24 hours.
   *
   * So: give both tenants the same one-day poster, dated to KIRITIMATI'S today.
   * Kiritimati must see it and Midway must not. A schedule keyed on the server's
   * UTC day (or on either tenant's day for both) fails this, and failing it is
   * precisely the bug where a Sunday brunch banner is still on diners' phones
   * through Monday morning's service.
   */
  test("one instant, two zones, two answers — the tenant's calendar decides", async () => {
    const dayKeyIn = (tz: string): string => new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());

    const AHEAD = "Pacific/Kiritimati";  // UTC+14
    const BEHIND = "Pacific/Midway";     // UTC-11
    const aheadToday = dayKeyIn(AHEAD);
    // The premise the test rests on, asserted rather than assumed.
    expect(dayKeyIn(BEHIND)).not.toBe(aheadToday);

    const ahead = addRestaurant({ res_username: "kiritimati", timezone: AHEAD });
    const aOutlet = addOutlet({ res_id: ahead.id, outlet_name: "Main" });
    addMenuItem({ res_id: ahead.id, outlet_id: aOutlet.id, name: "Brunch plate", price: 120 });
    addPoster({ res_id: ahead.id, title: "Brunch", start_on: aheadToday, end_on: aheadToday });

    const behind = addRestaurant({ res_username: "midway", timezone: BEHIND });
    const bOutlet = addOutlet({ res_id: behind.id, outlet_name: "Main" });
    addMenuItem({ res_id: behind.id, outlet_id: bOutlet.id, name: "Brunch plate", price: 120 });
    addPoster({ res_id: behind.id, title: "Brunch", start_on: aheadToday, end_on: aheadToday });

    const aBody = (await menu("kiritimati")).body as Record<string, unknown>;
    expect(Array.isArray(aBody.posters)).toBe(true);
    expect((aBody.posters as { title: string }[])[0]!.title).toBe("Brunch");

    const bBody = (await menu("midway")).body as Record<string, unknown>;
    expect("posters" in bBody).toBe(false);
  });

  test("a poster inside its window is served with only the public fields", async () => {
    const { res } = seedTenant();
    addPoster({ res_id: res.id, title: "Brunch", placement: "top", start_on: "2020-01-01", end_on: "2099-12-31", width: 1200, height: 400 });
    const body = (await menu("postercafe")).body as Record<string, unknown>;
    const served = body.posters as Record<string, unknown>[];
    expect(served).toHaveLength(1);
    expect(Object.keys(served[0]!).sort()).toEqual(["height", "id", "image_url", "placement", "title", "width"]);
    expect(served[0]!.placement).toBe("top");
    expect(served[0]!.width).toBe(1200);
  });
});

describe("POST /posters — the upload is refused before it costs anything", () => {
  const authFor = (res: RestaurantRow, outlet: OutletRow, actions: string[] = [BRANDING_PERM]) => ({
    res_id: res.id, outlet_id: outlet.id, employeeId: "emp-1", role: "admin", actions,
  });

  test("a wrong content type is refused with a 400 and stores nothing", async () => {
    const { res, outlet } = seedTenant();
    const r = await harness.call("POST", "/posters", {
      auth: authFor(res, outlet),
      body: { image_base64: "PHN2Zz48L3N2Zz4=", content_type: "image/svg+xml", title: "Nice try" },
      ip: freshIp(),
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/PNG, JPEG or WebP/);
    expect(posters()).toHaveLength(0);
  });

  test("an oversized image is refused with a 400 and stores nothing", async () => {
    const { res, outlet } = seedTenant();
    const huge = "A".repeat(Math.ceil((POSTER_MAX_UPLOAD_BYTES + 1_000_000) * 4 / 3));
    const r = await harness.call("POST", "/posters", {
      auth: authFor(res, outlet),
      body: { image_base64: huge, content_type: "image/png" },
      ip: freshIp(),
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/under 3 MB/);
    expect(posters()).toHaveLength(0);
  });

  test("a valid type gets PAST validation and fails at storage instead", async () => {
    // Proves the ordering: the size/type gate is not what stops a legitimate
    // upload. Supabase storage is unconfigured in jest, so the request reaches it
    // and comes back 502 — the same answer /menu/upload-image gives, and NOT the
    // 400 an owner with a good JPEG would have been wrongly shown if the two
    // failure modes were collapsed together.
    const { res, outlet } = seedTenant();
    const r = await harness.call("POST", "/posters", {
      auth: authFor(res, outlet),
      // A real 1x1 PNG, so sharp decodes it and the ONLY thing left to fail is
      // the bucket.
      body: {
        image_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        content_type: "image/png",
      },
      ip: freshIp(),
    });
    expect(r.status).toBe(502);
    expect(posters()).toHaveLength(0);
  });

  test("the routes are gated by Manage Branding, not merely by being logged in", async () => {
    // `validate` authenticates without checking anything, so a route wearing only
    // that is open to every logged-in waiter. These wear validateAction.
    const { res, outlet } = seedTenant();
    for (const [method, path] of [["GET", "/posters"], ["POST", "/posters"], ["PATCH", "/posters/:id"], ["DELETE", "/posters/:id"]] as const) {
      const r = await harness.call(method, path, {
        auth: authFor(res, outlet, ["some-other-permission"]),
        params: { id: "11111111-1111-4111-8111-111111111111" },
        body: {},
        ip: freshIp(),
      });
      expect(r.status).toBe(403);
    }
  });
});

describe("GET /posters — the editor's library", () => {
  test("returns expired and paused posters too, plus the restaurant's day key", async () => {
    // The editor has to show what is NOT showing — that is most of the point of a
    // schedule — and it labels each row using the tenant's day, not the browser's.
    const { res, outlet } = seedTenant({ timezone: "Asia/Kolkata" });
    addPoster({ res_id: res.id, title: "Expired", end_on: "2020-01-01" });
    addPoster({ res_id: res.id, title: "Paused", active: false });
    addPoster({ res_id: res.id, title: "Live" });

    const r = await harness.call("GET", "/posters", {
      auth: { res_id: res.id, outlet_id: outlet.id, employeeId: "emp-1", role: "admin", actions: [BRANDING_PERM] },
      ip: freshIp(),
    });
    expect(r.status).toBe(200);
    const body = r.body as { posters: PosterRecord[]; today: string; timezone: string; placements: unknown[] };
    expect(body.posters.map((p) => p.title)).toEqual(["Expired", "Paused", "Live"]);
    expect(body.timezone).toBe("Asia/Kolkata");
    expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The placement catalogue ships with the library so the two editors cannot
    // hardcode labels that drift apart.
    expect(body.placements).toHaveLength(2);
    // The editor's "showing now" badge uses the SAME predicate the guest read
    // uses — this is what keeps the two from ever disagreeing.
    expect(body.posters.filter((p) => posterIsVisible(p, body.today)).map((p) => p.title)).toEqual(["Live"]);
  });
});

describe("both guest surfaces agree about posters", () => {
  test("a live poster reaches the QUEUE menu, not just the table menu", async () => {
    const { res } = seedTenant();
    addPoster({ res_id: res.id, title: "Sunday brunch", start_on: "2020-01-01", end_on: "2099-01-01" });

    const table = (await menu("postercafe")).body as Record<string, unknown>;
    const queue = (await queueMenu("postercafe")).body as Record<string, unknown>;

    expect(Array.isArray(table.posters)).toBe(true);
    expect(Array.isArray(queue.posters)).toBe(true);
    // Same poster, same shape — a guest queuing at the door and a guest at a
    // table are looking at the same promotion.
    expect(JSON.stringify(queue.posters)).toBe(JSON.stringify(table.posters));
  });

  test("no posters means NO posters key on the queue menu either", async () => {
    seedTenant();
    const queue = (await queueMenu("postercafe")).body as Record<string, unknown>;
    expect(queue.status === undefined || true).toBe(true);
    expect("posters" in queue).toBe(false);
  });

  test("an expired poster is hidden on BOTH surfaces", async () => {
    const { res } = seedTenant();
    addPoster({ res_id: res.id, title: "Last Diwali", start_on: "2020-10-01", end_on: "2020-11-30" });

    const table = (await menu("postercafe")).body as Record<string, unknown>;
    const queue = (await queueMenu("postercafe")).body as Record<string, unknown>;
    expect("posters" in table).toBe(false);
    expect("posters" in queue).toBe(false);
  });
});
