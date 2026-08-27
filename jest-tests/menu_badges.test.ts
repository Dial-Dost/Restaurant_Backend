// Configurable menu badges: the per-restaurant catalogue, the per-item tags, and
// the rule that turns the two (plus the item's allergens) into what a diner is
// actually told about a dish.
//
// WHY THIS SUITE EXISTS, in three parts.
//
// 1. ABSENT MUST STAY ABSENT. Every live tenant has a NULL menu_badges column
//    today. If "no catalogue" ever resolved to the shipped starter set, ~every
//    restaurant on the platform would wake up with "Bestseller" and "Contains
//    nuts" stuck on dishes nobody tagged — claims the restaurant never made.
//    So the empty case is pinned everywhere: catalogue, item payload, guest
//    payload.
//
// 2. TAGGING MUST NOT DISTURB ANYTHING ELSE. A bulk save once destroyed 56
//    dishes' images, kitchen sections and recipes. Bulk TAGGING is the same
//    shape of operation — one action, many items — so the tests assert the
//    surviving fields explicitly rather than trusting that the write path is
//    narrow.
//
// 3. SAFETY BADGES ARE NOT DECORATION. "Contains nuts" and "Jain" are claims a
//    diner acts on. The tests pin that they render first, that they are the
//    kind a compact surface may not truncate, that a derived allergen badge
//    cannot be untagged, and that dropping a tagged dietary badge from the
//    catalogue is refused rather than silently applied.
//
// Parts 2 and 3 drive the REAL route handlers from routes/menu.ts and
// routes/guest.ts over the shared platform fixture, so they test the shipped
// statements rather than a TypeScript re-implementation of them.

import { describe, test, expect, beforeAll, beforeEach } from "@jest/globals";
import {
  MENU_BADGE_KINDS,
  MENU_BADGE_MAX,
  MENU_BADGE_PER_ITEM_MAX,
  MENU_BADGE_PRESETS,
  MENU_BADGE_PROTECTED_KINDS,
  badgeCoveredAllergens,
  capMenuBadges,
  enabledMenuBadges,
  isDerivedMenuBadge,
  menuBadgeSlug,
  resolveMenuBadges,
  sanitizeMenuBadgeCatalogue,
  sanitizeMenuBadgeIds,
  type MenuBadge,
} from "../menu_badges";
import {
  addMenuItem,
  addOutlet,
  addRestaurant,
  makeFakeApp,
  resetStore,
  restaurants,
  type FakeApp,
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

// ---------------------------------------------------------------------------
// Part 1 — the pure rules (menu_badges.ts). No database, no routes.
// ---------------------------------------------------------------------------

const badge = (over: Partial<MenuBadge> & { id: string }): MenuBadge =>
  ({ label: over.id, kind: "promo", enabled: true, ...over });

describe("badge catalogue sanitization", () => {
  test("an absent / unusable catalogue is EMPTY, never the starter set", () => {
    // The load-bearing one. See the header: a default catalogue would put
    // claims on every existing tenant's menu that they never made.
    expect(sanitizeMenuBadgeCatalogue(null)).toEqual([]);
    expect(sanitizeMenuBadgeCatalogue(undefined)).toEqual([]);
    expect(sanitizeMenuBadgeCatalogue({})).toEqual([]);
    expect(sanitizeMenuBadgeCatalogue("must_try")).toEqual([]);
    expect(sanitizeMenuBadgeCatalogue([])).toEqual([]);
    expect(sanitizeMenuBadgeCatalogue([null, 7, "x", {}])).toEqual([]);
  });

  test("round-trips a catalogue unchanged, preserving tenant ORDER", () => {
    const input: MenuBadge[] = [
      { id: "contains_nuts", label: "Contains nuts", kind: "alert", enabled: true, allergen: "nuts" },
      { id: "jain", label: "Jain", kind: "diet", enabled: true },
      { id: "must_try", label: "Must Try", kind: "promo", enabled: false },
    ];
    expect(sanitizeMenuBadgeCatalogue(input)).toEqual(input);
    // Order is the tenant's, and it is what breaks ties when rendering.
    expect(sanitizeMenuBadgeCatalogue([input[1], input[0]]).map((b) => b.id))
      .toEqual(["jain", "contains_nuts"]);
  });

  test("the shipped preset set survives sanitization bit-for-bit", () => {
    // The editors hand the presets straight back on "use the starter set", so a
    // preset that the sanitizer would alter is a preset that lies in the UI.
    expect(sanitizeMenuBadgeCatalogue(MENU_BADGE_PRESETS)).toEqual(MENU_BADGE_PRESETS);
    expect(MENU_BADGE_PRESETS.length).toBeLessThanOrEqual(MENU_BADGE_MAX);
  });

  test("an id is derived from the label when one is not supplied", () => {
    expect(menuBadgeSlug("Chef's Special")).toBe("chefs_special");
    expect(menuBadgeSlug("  Must   Try!  ")).toBe("must_try");
    expect(menuBadgeSlug("!!!")).toBe("");
    expect(sanitizeMenuBadgeCatalogue([{ label: "House Favourite" }])[0])
      .toEqual({ id: "house_favourite", label: "House Favourite", kind: "promo", enabled: true });
  });

  test("duplicate ids collapse to the first, and the catalogue is capped", () => {
    const dupes = sanitizeMenuBadgeCatalogue([
      { id: "veg", label: "Veg", kind: "diet" },
      { id: "veg", label: "Vegetarian", kind: "promo" },
    ]);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].label).toBe("Veg");

    const many = Array.from({ length: MENU_BADGE_MAX + 5 }, (_, i) => ({ id: `b${String(i)}`, label: `B${String(i)}` }));
    expect(sanitizeMenuBadgeCatalogue(many)).toHaveLength(MENU_BADGE_MAX);
  });

  test("an unknown kind falls back to promo — the SAFE direction", () => {
    // A typo must never promote a marketing sticker into the always-visible
    // safety lane; it may only demote one out of it.
    expect(sanitizeMenuBadgeCatalogue([{ id: "x", label: "X", kind: "danger" }])[0].kind).toBe("promo");
    expect(MENU_BADGE_PROTECTED_KINDS).not.toContain("promo");
  });

  test("labels are plain text, single line and capped", () => {
    const out = sanitizeMenuBadgeCatalogue([
      { id: "a", label: "<b onclick='x'>Must\n\nTry</b>" },
      { id: "b", label: "x".repeat(200) },
      { id: "c", label: "   " },
    ]);
    expect(out[0].label).toBe("Must Try");
    expect(out[0].label).not.toContain("<");
    expect(out[1].label).toHaveLength(24);
    // A blank label falls back to the id rather than rendering an empty chip.
    expect(out[2].label).toBe("c");
  });

  test("only alert badges may be allergen-derived", () => {
    const out = sanitizeMenuBadgeCatalogue([
      { id: "n", label: "Nuts", kind: "alert", allergen: "  NUTS " },
      { id: "v", label: "Vegan", kind: "diet", allergen: "dairy" },
      { id: "p", label: "Hot", kind: "promo", allergen: "nuts" },
    ]);
    expect(out[0].allergen).toBe("nuts");
    // A dietary or promo badge that suppressed an allergen chip would hide a
    // safety fact behind a label that does not state it.
    expect(out[1].allergen).toBeUndefined();
    expect(out[2].allergen).toBeUndefined();
    expect(isDerivedMenuBadge(out[0])).toBe(true);
    expect(isDerivedMenuBadge(out[1])).toBe(false);
  });

  test("absent `enabled` means enabled — a pre-badges client cannot go dark", () => {
    expect(sanitizeMenuBadgeCatalogue([{ id: "a", label: "A" }])[0].enabled).toBe(true);
    expect(sanitizeMenuBadgeCatalogue([{ id: "a", label: "A", enabled: false }])[0].enabled).toBe(false);
  });
});

describe("item badge tags", () => {
  test("tags are slugified, deduped and capped; junk resolves to []", () => {
    expect(sanitizeMenuBadgeIds(null)).toEqual([]);
    expect(sanitizeMenuBadgeIds("must_try")).toEqual([]);
    expect(sanitizeMenuBadgeIds(["Must Try", "must_try", 7, "", "jain"])).toEqual(["must_try", "jain"]);
    const many = Array.from({ length: MENU_BADGE_PER_ITEM_MAX + 4 }, (_, i) => `b${String(i)}`);
    expect(sanitizeMenuBadgeIds(many)).toHaveLength(MENU_BADGE_PER_ITEM_MAX);
  });

  test("tags are NOT validated against the catalogue at write time", () => {
    // Deliberate: encodeMenuDescription has no tenant context, and a tag for a
    // momentarily-disabled badge must survive a re-save of the item. Unknown
    // ids are dropped at RENDER time instead.
    expect(sanitizeMenuBadgeIds(["not_in_any_catalogue"])).toEqual(["not_in_any_catalogue"]);
  });
});

describe("badge resolution", () => {
  const catalogue: MenuBadge[] = [
    badge({ id: "must_try", label: "Must Try", kind: "promo" }),
    badge({ id: "bestseller", label: "Bestseller", kind: "promo" }),
    badge({ id: "jain", label: "Jain", kind: "diet" }),
    badge({ id: "spicy", label: "Spicy", kind: "alert" }),
    badge({ id: "contains_nuts", label: "Contains nuts", kind: "alert", allergen: "nuts" }),
    badge({ id: "retired", label: "Retired", kind: "promo", enabled: false }),
  ];

  test("an EMPTY catalogue resolves to nothing, whatever the item carries", () => {
    expect(resolveMenuBadges([], ["must_try", "jain"], ["nuts"])).toEqual([]);
  });

  test("an untagged item with no allergens resolves to nothing", () => {
    expect(resolveMenuBadges(catalogue, undefined, undefined)).toEqual([]);
    expect(resolveMenuBadges(catalogue, [], [])).toEqual([]);
  });

  test("orders alert -> diet -> promo, then by catalogue position", () => {
    const ids = resolveMenuBadges(catalogue, ["bestseller", "must_try", "jain", "spicy"], []).map((b) => b.id);
    expect(ids).toEqual(["spicy", "jain", "must_try", "bestseller"]);
  });

  test("unknown and disabled tags are dropped", () => {
    expect(resolveMenuBadges(catalogue, ["ghost", "retired", "must_try"], []).map((b) => b.id))
      .toEqual(["must_try"]);
  });

  test("an allergen-derived badge comes from the ALLERGEN list, not a tag", () => {
    // Present because the dish declares nuts, with no badge tag anywhere.
    expect(resolveMenuBadges(catalogue, [], ["Nuts"]).map((b) => b.id)).toEqual(["contains_nuts"]);
    // And tagging it by hand does NOT conjure it onto a dish with no nuts —
    // there is exactly one store of this fact and the tag is not it.
    expect(resolveMenuBadges(catalogue, ["contains_nuts"], [])).toEqual([]);
    // Which is the property that matters: you cannot untag a nut warning.
    expect(resolveMenuBadges(catalogue, [], ["nuts", "gluten"]).map((b) => b.id)).toEqual(["contains_nuts"]);
  });

  test("badgeCoveredAllergens names the chips a badge already speaks for", () => {
    expect(badgeCoveredAllergens(catalogue)).toEqual(["nuts"]);
    // A disabled derived badge covers nothing, so its allergen falls back to the
    // plain chip row rather than disappearing from the card entirely.
    const off = catalogue.map((b) => (b.id === "contains_nuts" ? { ...b, enabled: false } : b));
    expect(badgeCoveredAllergens(off)).toEqual([]);
    expect(badgeCoveredAllergens([])).toEqual([]);
  });

  test("capping is allowed to drop marketing and NOTHING else", () => {
    const resolved = resolveMenuBadges(catalogue, ["must_try", "bestseller", "jain", "spicy"], ["nuts"]);
    const tight = capMenuBadges(resolved, 1);
    // Both alerts and the dietary badge survive a limit of one.
    expect(tight.shown.map((b) => b.id)).toEqual(["spicy", "contains_nuts", "jain", "must_try"]);
    expect(tight.hidden).toBe(1);

    const noPromo = capMenuBadges(resolved, 0);
    expect(noPromo.shown.every((b) => b.kind !== "promo")).toBe(true);
    expect(noPromo.shown.map((b) => b.id)).toEqual(["spicy", "contains_nuts", "jain"]);
    expect(noPromo.hidden).toBe(2);

    // A generous limit hides nothing.
    expect(capMenuBadges(resolved, 9).hidden).toBe(0);
  });

  test("enabledMenuBadges keeps catalogue order", () => {
    expect(enabledMenuBadges(catalogue).map((b) => b.id))
      .toEqual(["must_try", "bestseller", "jain", "spicy", "contains_nuts"]);
  });

  test("every preset kind is one the renderers know", () => {
    for (const preset of MENU_BADGE_PRESETS) {
      expect(MENU_BADGE_KINDS).toContain(preset.kind);
    }
    // The starter set covers all three lanes — a set that was promo-only would
    // quietly make "badges" mean "marketing".
    expect(new Set(MENU_BADGE_PRESETS.map((p) => p.kind))).toEqual(new Set(MENU_BADGE_KINDS));
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the real routes over the fixture.
// ---------------------------------------------------------------------------

let harness: FakeApp;
let res: RestaurantRow;
let outlet: OutletRow;

// A menu item id has to be a real uuid: SetMenuItemBadges narrows to `= any
// ($3::uuid[])`, and a non-uuid would abort the statement.
const ITEM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ITEM_B = "aaaaaaaa-0000-4000-8000-000000000002";
const ITEM_C = "aaaaaaaa-0000-4000-8000-000000000003";

/** Everything a dish carries besides its badges — the fields the 56-item wipe destroyed. */
const RICH_ITEM_EXTRA = {
  image_url: "https://cdn.example.com/paneer.jpg",
  station: "Tandoor",
  allergens: ["dairy", "nuts"],
  blurb: "Cottage cheese, charred over coal.",
  recipe: [{ inventory_id: "inv-paneer", qty: 200, note: "grams" }],
  modifiers: [{ name: "Spice", multi: false, required: false, options: [{ name: "Hot", price: 0 }] }],
  price_updated_at: "2026-01-01T00:00:00.000Z",
  price_baseline: 300,
};

beforeAll(async () => {
  // The pool is constructed at import time and refuses to build without a URL;
  // the fake `pg` above means nothing ever dials it (same preamble as
  // waitlist_preorder.test.ts).
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  process.env.PLATFORM_DATABASE_URL =
    process.env.PLATFORM_DATABASE_URL || "postgres://fixture:fixture@localhost:5432/fixture";

  harness = makeFakeApp();
  const menuRoutes = await import("../routes/menu");
  const guestRoutes = await import("../routes/guest");
  menuRoutes.registerMenuRoutes(harness.app as never);
  menuRoutes.registerMenuAdminRoutes(harness.app as never);
  guestRoutes.registerGuestOrderingRoutes(harness.app as never);
  // The QUEUE pre-order menu is its own endpoint, so it needs its own coverage:
  // a party still standing at the door is choosing food too.
  guestRoutes.registerGuestWaitlistAndPaymentRoutes(harness.app as never);
});

let ipCounter = 0;
const freshIp = (): string => `198.51.100.${String((ipCounter++ % 200) + 1)}`;

// A staff session, as requireAuth would have left it: extractRestaurantId reads
// req.auth.res_id (never the query string), and validateAction reads
// req.auth.actions. "*" stands for an owner — which permission gates which route
// is the route manifest's job, not this suite's.
const staff = () => ({ res_id: res.id, outlet_id: outlet.id, employeeId: "", role: "admin", actions: ["*"] });

const get = (path: string, params: Record<string, string> = {}) =>
  harness.call("GET", path, { params, ip: freshIp(), auth: staff() });
const put = (path: string, body: unknown) =>
  harness.call("PUT", path, { body, ip: freshIp(), auth: staff() });
const post = (path: string, body: unknown) =>
  harness.call("POST", path, { body, ip: freshIp(), auth: staff() });
// The guest QR menu runs unauthenticated — no auth on this one, deliberately.
const guest = (slug: string) => harness.call("GET", "/qr/:slug/menu", { params: { slug }, ip: freshIp() });
const queueGuest = (slug: string) => harness.call("GET", "/qr/:slug/queue-menu", { params: { slug }, ip: freshIp() });

/** GET /menu, as a map from item id to the whole item. */
const menuById = async (): Promise<Record<string, any>> => {
  const r = await get("/menu");
  const out: Record<string, any> = {};
  for (const it of r.body as any[]) {out[it.id] = it;}
  return out;
};

const CATALOGUE: MenuBadge[] = [
  { id: "contains_nuts", label: "Contains nuts", kind: "alert", enabled: true, allergen: "nuts" },
  { id: "jain", label: "Jain", kind: "diet", enabled: true },
  { id: "must_try", label: "Must Try", kind: "promo", enabled: true },
];

beforeEach(() => {
  resetStore();
  res = addRestaurant({ res_username: "gaia", res_name: "Gaia Kitchen" });
  outlet = addOutlet({ res_id: res.id });
  addMenuItem({ id: ITEM_A, res_id: res.id, outlet_id: outlet.id, name: "Paneer Tikka", price: 340, category: "Starters", extra: RICH_ITEM_EXTRA });
  addMenuItem({ id: ITEM_B, res_id: res.id, outlet_id: outlet.id, name: "Dal Tadka", price: 260, category: "Mains" });
  addMenuItem({ id: ITEM_C, res_id: res.id, outlet_id: outlet.id, name: "Gulab Jamun", price: 140, category: "Desserts" });
});

describe("catalogue round-trip through the routes", () => {
  test("an unconfigured tenant reads an EMPTY catalogue and the presets", async () => {
    const r = await get("/menu/badges");
    expect(r.status).toBe(200);
    expect((r.body as any).badges).toEqual([]);
    // The starter set is OFFERED, never applied — the editors render it as
    // toggles, and until one is switched on the tenant has no badges.
    expect((r.body as any).presets).toEqual(MENU_BADGE_PRESETS);
    expect((r.body as any).kinds).toEqual(MENU_BADGE_KINDS);
  });

  test("PUT then GET returns exactly what was written, in order", async () => {
    const w = await put("/menu/badges", { badges: CATALOGUE });
    expect(w.status).toBe(200);
    expect((w.body as any).badges).toEqual(CATALOGUE);

    const r = await get("/menu/badges");
    expect((r.body as any).badges).toEqual(CATALOGUE);
  });

  test("a rename keeps the id, so every existing tag survives it", async () => {
    await put("/menu/badges", { badges: CATALOGUE });
    await post("/menu/badges/tag", { items: [{ id: ITEM_B, badges: ["must_try"] }] });

    const renamed = CATALOGUE.map((b) => (b.id === "must_try" ? { ...b, label: "Owner's Pick" } : b));
    await put("/menu/badges", { badges: renamed });

    expect((await menuById())[ITEM_B].badges).toEqual(["must_try"]);
    const r = await get("/menu/badges");
    expect((r.body as any).badges[2].label).toBe("Owner's Pick");
  });

  test("a malformed body is refused rather than clearing the catalogue", async () => {
    await put("/menu/badges", { badges: CATALOGUE });
    const bad = await put("/menu/badges", { badges: "must_try" });
    expect(bad.status).toBe(400);
    expect((await get("/menu/badges")).body as any)
      .toMatchObject({ badges: CATALOGUE });
  });
});

describe("tagging an item disturbs nothing else about it", () => {
  test("bulk tagging preserves image, section, recipe, allergens, blurb and price history", async () => {
    await put("/menu/badges", { badges: CATALOGUE });
    const before = (await menuById())[ITEM_A];

    const r = await post("/menu/badges/tag", {
      items: [{ id: ITEM_A, badges: ["must_try", "jain"] }],
    });
    expect(r.status).toBe(200);
    expect((r.body as any).updated).toBe(1);

    const after = (await menuById())[ITEM_A];
    // THE ASSERTION THIS SUITE EXISTS FOR. A bulk save once wiped 56 items'
    // images, sections and recipes; bulk tagging is the same shape of action, so
    // every other field is named explicitly instead of trusted.
    expect(after.image_url).toBe(RICH_ITEM_EXTRA.image_url);
    expect(after.station).toBe(RICH_ITEM_EXTRA.station);
    expect(after.recipe).toEqual(RICH_ITEM_EXTRA.recipe);
    expect(after.allergens).toEqual(RICH_ITEM_EXTRA.allergens);
    expect(after.blurb).toBe(RICH_ITEM_EXTRA.blurb);
    expect(after.modifiers).toEqual(RICH_ITEM_EXTRA.modifiers);
    expect(after.price).toBe(340);
    expect(after.available).toBe(true);
    expect(after.price_updated_at).toBe(RICH_ITEM_EXTRA.price_updated_at);
    expect(after.price_baseline).toBe(RICH_ITEM_EXTRA.price_baseline);
    // ...and the ONLY difference is the badges.
    expect({ ...after, badges: before.badges }).toEqual(before);
    expect(after.badges).toEqual(["must_try", "jain"]);
  });

  test("tagging one dish leaves every other dish alone", async () => {
    await put("/menu/badges", { badges: CATALOGUE });
    await post("/menu/badges/tag", { items: [{ id: ITEM_B, badges: ["must_try"] }] });
    const all = await menuById();
    expect(all[ITEM_B].badges).toEqual(["must_try"]);
    expect(all[ITEM_A].badges).toEqual([]);
    expect(all[ITEM_C].badges).toEqual([]);
  });

  test("clearing an item's badges leaves it exactly as it was before tagging", async () => {
    await put("/menu/badges", { badges: CATALOGUE });
    const pristine = (await menuById())[ITEM_A];
    await post("/menu/badges/tag", { items: [{ id: ITEM_A, badges: ["must_try"] }] });
    await post("/menu/badges/tag", { items: [{ id: ITEM_A, badges: [] }] });
    // Byte-for-byte the untagged item again — the key is dropped, not left as [].
    expect((await menuById())[ITEM_A]).toEqual(pristine);
  });

  test("an unrelated item save does NOT strip the badges (preserve-on-omit)", async () => {
    await put("/menu/badges", { badges: CATALOGUE });
    await post("/menu/badges/tag", { items: [{ id: ITEM_A, badges: ["must_try"] }] });

    // A price/availability edit from a client that has never heard of badges.
    const saved = await post("/menu", {
      id: ITEM_A, name: "Paneer Tikka", price: 360, category: "Starters", available: false,
    });
    expect(saved.status).toBe(201);

    const after = (await menuById())[ITEM_A];
    expect(after.badges).toEqual(["must_try"]);
    expect(after.price).toBe(360);
    expect(after.available).toBe(false);
    // And the rest of the blob still survives that path too.
    expect(after.image_url).toBe(RICH_ITEM_EXTRA.image_url);
    expect(after.recipe).toEqual(RICH_ITEM_EXTRA.recipe);
  });

  test("an explicit empty array on the item save DOES clear them", async () => {
    await put("/menu/badges", { badges: CATALOGUE });
    await post("/menu/badges/tag", { items: [{ id: ITEM_A, badges: ["must_try"] }] });
    await post("/menu", {
      id: ITEM_A, name: "Paneer Tikka", price: 340, category: "Starters", badges: [],
    });
    expect((await menuById())[ITEM_A].badges).toEqual([]);
  });

  test("a bulk tag that changes nothing writes nothing", async () => {
    await put("/menu/badges", { badges: CATALOGUE });
    await post("/menu/badges/tag", { items: [{ id: ITEM_A, badges: ["must_try"] }] });
    const again = await post("/menu/badges/tag", { items: [{ id: ITEM_A, badges: ["must_try"] }] });
    expect((again.body as any).updated).toBe(0);
  });

  test("a tag for an item id that is not a menu item is a no-op, not a 500", async () => {
    const r = await post("/menu/badges/tag", {
      items: [{ id: "not-a-uuid", badges: ["must_try"] }, { id: "bbbbbbbb-0000-4000-8000-00000000ffff", badges: ["must_try"] }],
    });
    expect(r.status).toBe(200);
    expect((r.body as any).updated).toBe(0);
  });
});

describe("dietary and safety badges are not decoration", () => {
  test("dropping a TAGGED dietary badge is refused with the counts", async () => {
    await put("/menu/badges", { badges: CATALOGUE });
    await post("/menu/badges/tag", {
      items: [{ id: ITEM_A, badges: ["jain"] }, { id: ITEM_B, badges: ["jain", "must_try"] }],
    });

    const refused = await put("/menu/badges", {
      badges: CATALOGUE.filter((b) => b.id !== "jain"),
    });
    expect(refused.status).toBe(409);
    expect((refused.body as any).badges).toEqual([{ id: "jain", label: "Jain", kind: "diet", items: 2 }]);

    // Nothing moved: the catalogue and both dishes are untouched.
    expect((await get("/menu/badges")).body as any)
      .toMatchObject({ badges: CATALOGUE });
    expect((await menuById())[ITEM_B].badges).toEqual(["jain", "must_try"]);
  });

  test("DISABLING a tagged dietary badge is refused too — it renders nowhere either", async () => {
    await put("/menu/badges", { badges: CATALOGUE });
    await post("/menu/badges/tag", { items: [{ id: ITEM_A, badges: ["jain"] }] });
    const refused = await put("/menu/badges", {
      badges: CATALOGUE.map((b) => (b.id === "jain" ? { ...b, enabled: false } : b)),
    });
    expect(refused.status).toBe(409);
  });

  test("release_tagged untags the dishes and removes the badge, atomically", async () => {
    await put("/menu/badges", { badges: CATALOGUE });
    await post("/menu/badges/tag", {
      items: [{ id: ITEM_A, badges: ["jain", "must_try"] }, { id: ITEM_B, badges: ["jain"] }],
    });

    const ok = await put("/menu/badges", {
      badges: CATALOGUE.filter((b) => b.id !== "jain"),
      release_tagged: true,
    });
    expect(ok.status).toBe(200);
    expect((ok.body as any).released).toBe(2);

    const all = await menuById();
    // The dish keeps the badges it still has a catalogue entry for; only the
    // released id is gone, so the items and the catalogue agree afterwards.
    expect(all[ITEM_A].badges).toEqual(["must_try"]);
    expect(all[ITEM_B].badges).toEqual([]);
    // Releasing must not have touched anything else about the dish either.
    expect(all[ITEM_A].image_url).toBe(RICH_ITEM_EXTRA.image_url);
    expect(all[ITEM_A].recipe).toEqual(RICH_ITEM_EXTRA.recipe);
  });

  test("an UNTAGGED protected badge can be removed freely", async () => {
    await put("/menu/badges", { badges: CATALOGUE });
    const ok = await put("/menu/badges", {
      badges: CATALOGUE.filter((b) => b.id !== "jain"),
    });
    expect(ok.status).toBe(200);
    expect((ok.body as any).released).toBe(0);
  });

  test("a promo badge is dropped without ceremony, even when tagged", async () => {
    await put("/menu/badges", { badges: CATALOGUE });
    await post("/menu/badges/tag", { items: [{ id: ITEM_A, badges: ["must_try"] }] });
    const ok = await put("/menu/badges", {
      badges: CATALOGUE.filter((b) => b.id !== "must_try"),
    });
    // Losing a "Must Try" sticker costs nothing, so it is not worth a dialog.
    expect(ok.status).toBe(200);
  });

  test("removing an allergen-DERIVED badge is never refused — the fact is not in a tag", async () => {
    // ITEM_A declares nuts, so it wears "Contains nuts" without being tagged.
    await put("/menu/badges", { badges: CATALOGUE });
    const guestBefore = await guest(res.res_username);
    expect(guestItem(guestBefore, ITEM_A).badges).toContain("contains_nuts");

    const ok = await put("/menu/badges", {
      badges: CATALOGUE.filter((b) => b.id !== "contains_nuts"),
    });
    expect(ok.status).toBe(200);

    // The badge is gone but the ALLERGEN is not: the dish still declares nuts,
    // it has simply been demoted back to the plain chip row.
    const guestAfter = await guest(res.res_username);
    expect(guestItem(guestAfter, ITEM_A).badges).toEqual([]);
    expect(guestItem(guestAfter, ITEM_A).allergens).toEqual(["dairy", "nuts"]);
    expect((guestAfter.body as any).badge_allergens).toEqual([]);
  });
});

const guestItem = (r: { body: unknown }, id: string): any =>
  ((r.body as any).items as any[]).find((it) => it.id === id);

describe("the guest payload", () => {
  test("carries the catalogue and each dish's RESOLVED badges", async () => {
    await put("/menu/badges", { badges: CATALOGUE });
    await post("/menu/badges/tag", {
      items: [{ id: ITEM_A, badges: ["must_try"] }, { id: ITEM_C, badges: ["jain"] }],
    });

    const r = await guest(res.res_username);
    expect(r.status).toBe(200);
    expect((r.body as any).menu_badges).toEqual(CATALOGUE);

    // ITEM_A: tagged must_try AND derives contains_nuts from its allergens.
    // Safety leads, marketing trails — the order the card renders in.
    expect(guestItem(r, ITEM_A).badges).toEqual(["contains_nuts", "must_try"]);
    expect(guestItem(r, ITEM_B).badges).toEqual([]);
    expect(guestItem(r, ITEM_C).badges).toEqual(["jain"]);

    // The chips the badges already speak for, so the card prints "nuts" once.
    expect((r.body as any).badge_allergens).toEqual(["nuts"]);
  });

  test("the QUEUE pre-order menu carries the same badges as the table menu", async () => {
    await put("/menu/badges", { badges: CATALOGUE });
    await post("/menu/badges/tag", { items: [{ id: ITEM_A, badges: ["must_try"] }] });

    const table = await guest(res.res_username);
    const queue = await queueGuest(res.res_username);
    expect(queue.status).toBe(200);
    expect((queue.body as any).menu_badges).toEqual(CATALOGUE);
    expect((queue.body as any).badge_allergens).toEqual(["nuts"]);
    // The same dish, told the same thing on both surfaces. A guest warned about
    // nuts at a table and NOT warned while queuing is the bug this pins.
    expect(guestItem(queue, ITEM_A).badges).toEqual(guestItem(table, ITEM_A).badges);
    expect(guestItem(queue, ITEM_A).badges).toEqual(["contains_nuts", "must_try"]);
  });

  test("a disabled badge disappears from the catalogue AND from every dish", async () => {
    await put("/menu/badges", { badges: CATALOGUE });
    await post("/menu/badges/tag", { items: [{ id: ITEM_A, badges: ["must_try"] }] });
    await put("/menu/badges", {
      badges: CATALOGUE.map((b) => (b.id === "must_try" ? { ...b, enabled: false } : b)),
    });

    const r = await guest(res.res_username);
    expect(((r.body as any).menu_badges as MenuBadge[]).map((b) => b.id)).toEqual(["contains_nuts", "jain"]);
    expect(guestItem(r, ITEM_A).badges).toEqual(["contains_nuts"]);
    // The tag itself is still stored, so re-enabling brings it straight back.
    expect((await menuById())[ITEM_A].badges).toEqual(["must_try"]);
  });
});

describe("absent means absent, everywhere", () => {
  test("a tenant that never configured badges sees none on any surface", async () => {
    // Deliberately including the dish that DOES declare nuts: with no catalogue
    // there is no badge to derive, and its allergens still render as they always
    // did. This is the whole platform's current state, so it must be inert.
    expect(restaurants().find((x) => x.id === res.id)!.menu_badges).toBeNull();

    const cat = await get("/menu/badges");
    expect((cat.body as any).badges).toEqual([]);

    const staff = await menuById();
    expect(staff[ITEM_A].badges).toEqual([]);
    expect(staff[ITEM_B].badges).toEqual([]);

    const g = await guest(res.res_username);
    expect((g.body as any).menu_badges).toEqual([]);
    expect((g.body as any).badge_allergens).toEqual([]);
    for (const it of (g.body as any).items as any[]) {
      expect(it.badges).toEqual([]);
    }
    // ...and the allergen chips are untouched, since nothing covers them.
    expect(guestItem(g, ITEM_A).allergens).toEqual(["dairy", "nuts"]);
  });

  test("tags stored against an empty catalogue render nowhere but are not lost", async () => {
    // A tenant can wipe their catalogue; the dishes keep their ids so restoring
    // the catalogue restores the badges rather than requiring a re-tag.
    await put("/menu/badges", { badges: CATALOGUE });
    await post("/menu/badges/tag", { items: [{ id: ITEM_A, badges: ["must_try"] }] });
    await put("/menu/badges", { badges: [] });

    const g = await guest(res.res_username);
    expect(guestItem(g, ITEM_A).badges).toEqual([]);
    expect((await menuById())[ITEM_A].badges).toEqual(["must_try"]);

    await put("/menu/badges", { badges: CATALOGUE });
    const back = await guest(res.res_username);
    expect(guestItem(back, ITEM_A).badges).toEqual(["contains_nuts", "must_try"]);
  });
});
