// MENU GROUPS + ITEM VARIATIONS (migration 039) — the routes, the merge rules,
// and the one thing that can charge a guest wrongly.
//
// WHY THIS SUITE EXISTS, in three parts.
//
// 1. ABSENT CONFIG MUST STAY ABSENT, and this is the load-bearing one. Almost
//    every tenant will never open the groups/variations editor. For them the
//    guest menu payload, the stored order line, the KOT fingerprint and the
//    printed bill must be what they were before 039 existed — not "equivalent",
//    the same bytes. Part 1 pins that by DIFFING the real payloads and the real
//    outputs with the feature configured and not configured, rather than
//    trusting a comment that says the key is omitted.
//
// 2. A VARIATION IS A PRICE, AND THERE ARE TWO DOORS TO IT. applyMenuPriceFloor
//    prices the staff order paths; repriceFromMenu prices the guest QR path and
//    the waitlist pre-order. Before 039 both floored at Menu.price, so "the same
//    rule" was two copies of one expression. A variation makes the floor
//    conditional, and two copies of a conditional rule is exactly how a Half
//    plate comes to bill at ₹150 for a guest and ₹250 for a waiter. Part 2
//    drives resolveLinePriceFloor (the one rule both now call) through every
//    refusal, and then drives a REAL GUEST ROUTE end to end to prove the guest
//    door honours it.
//
// 3. AN EDIT MUST NOT WIPE WHAT IT DID NOT MENTION. A full-replace bulk save
//    once destroyed 56 dishes' images, sections and recipes. A variation row is
//    smaller but it carries a PRICE, and a price defaulted to 0 is a ₹0 FLOOR —
//    every line naming it could then be rung in at nothing. Part 3 pins the
//    merge: absent keys keep the stored value, a zero price is refused, and a
//    variation cannot be moved to another dish.
//
// Parts 1 and 3 drive the REAL handlers from routes/menu_taxonomy.ts and
// routes/guest.ts over the shared platform fixture, so they exercise the shipped
// SQL and the shipped guards rather than a TypeScript restatement of them.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import {
  MENU_TAXONOMY_NAME_MAX,
  MENU_TAXONOMY_SORT_MAX,
  MENU_TAXONOMY_SORT_MIN,
  mergeMenuGroupPatch,
  mergeMenuVariationPatch,
  publicVariationsByItem,
  variationPayloadFor,
  type PublicMenuVariation,
  type StoredMenuGroup,
  type StoredMenuVariation,
  type VariationSourceRow,
} from "../menu_taxonomy";
import { anyLineNamesVariation, resolveLinePriceFloor, type VariationPriceRef } from "../billing_math";
import { buildReceiptBase64, type ReceiptItem } from "../escpos";
import {
  addMenuGroup,
  addMenuItem,
  addMenuVariation,
  addOutlet,
  addRestaurant,
  addWaitlistEntry,
  fixtureUuid,
  makeFakeApp,
  menuVariations,
  resetStore,
  setFixtureGroupOnCategory,
  waitlists,
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


// ===========================================================================
// Part 0 — the pure shaping and merge rules (menu_taxonomy.ts). No database.
// ===========================================================================

const storedGroup = (over: Partial<StoredMenuGroup> = {}): StoredMenuGroup =>
  ({ id: "g1", name: "Beverage", kind: "revenue", active: true, sort_order: 3, ...over });

const storedVariation = (over: Partial<StoredMenuVariation> = {}): StoredMenuVariation =>
  ({ id: "v1", menu_id: "m1", name: "Half", price: 150, is_default: false, active: true, sort_order: 2, ...over });

const row = (over: Partial<VariationSourceRow> & { id: string; menu_id: string }): VariationSourceRow =>
  ({ name: "Half", price: 150, is_default: false, active: true, sort_order: 0, ...over });

describe("group merge — a key you did not send keeps what is stored", () => {
  test("retiring a group touches NOTHING else", () => {
    // The whole reason a partial body is allowed. `{active:false}` must not
    // rename the group, move it to the other axis or reset its position.
    const merged = mergeMenuGroupPatch(storedGroup(), { active: false });
    expect(merged).toEqual({ ok: true, value: { name: "Beverage", kind: "revenue", active: false, sort_order: 3 } });
  });

  test("an empty body round-trips the stored row unchanged", () => {
    const stored = storedGroup({ kind: "production", name: "Bar", active: false, sort_order: -2 });
    const merged = mergeMenuGroupPatch(stored, {});
    expect(merged).toEqual({ ok: true, value: { name: "Bar", kind: "production", active: false, sort_order: -2 } });
  });

  test("a create over NOTHING takes the documented defaults", () => {
    expect(mergeMenuGroupPatch(null, { name: "  Liquor  " }))
      .toEqual({ ok: true, value: { name: "Liquor", kind: "revenue", active: true, sort_order: 0 } });
  });

  test("an unrecognised kind is REFUSED, never absorbed as revenue", () => {
    // A group filed on the wrong axis is invisible to the report that asks for
    // the other one, so a typo has to be told.
    const merged = mergeMenuGroupPatch(null, { name: "Bar", kind: "producton" });
    expect(merged.ok).toBe(false);
    expect(merged.ok === false && merged.error).toContain("revenue");
  });

  test("a nameless group is refused; whitespace is not a name", () => {
    expect(mergeMenuGroupPatch(null, {}).ok).toBe(false);
    expect(mergeMenuGroupPatch(null, { name: "   " }).ok).toBe(false);
    expect(mergeMenuGroupPatch(storedGroup(), { name: "" }).ok).toBe(false);
  });

  test("names are collapsed and bounded; sort_order is clamped, never refused", () => {
    const merged = mergeMenuGroupPatch(null, { name: `  A${" ".repeat(5)}B  ${"x".repeat(200)}`, sort_order: 999_999 });
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect(merged.value.name.length).toBe(MENU_TAXONOMY_NAME_MAX);
      expect(merged.value.name.startsWith("A B")).toBe(true);
      expect(merged.value.sort_order).toBe(MENU_TAXONOMY_SORT_MAX);
    }
    // A picker sending "" for the position must not fail a rename that is fine.
    const junk = mergeMenuGroupPatch(storedGroup({ sort_order: 7 }), { name: "Drinks", sort_order: "" });
    expect(junk).toEqual({ ok: true, value: { name: "Drinks", kind: "revenue", active: true, sort_order: 7 } });
    expect(mergeMenuGroupPatch(null, { name: "X", sort_order: -999_999 }))
      .toEqual({ ok: true, value: { name: "X", kind: "revenue", active: true, sort_order: MENU_TAXONOMY_SORT_MIN } });
  });
});

describe("variation merge — the price is a FLOOR, so it is never defaulted", () => {
  test("retiring a variation keeps its price", () => {
    // THE money case. Without the snapshot, `{active:false}` would default the
    // price to 0 — a ₹0 floor — and every line naming this variation could then
    // be rung in at nothing.
    expect(mergeMenuVariationPatch(storedVariation(), { active: false }))
      .toEqual({ ok: true, value: { menu_id: "m1", name: "Half", price: 150, is_default: false, active: false, sort_order: 2 } });
  });

  test("a zero, negative or non-numeric price is refused on create AND on edit", () => {
    for (const bad of [0, -1, "abc", "0"]) {
      expect(mergeMenuVariationPatch(null, { menu_id: "m1", name: "Half", price: bad }).ok).toBe(false);
      expect(mergeMenuVariationPatch(storedVariation(), { price: bad }).ok).toBe(false);
    }
    // Absent price on a create has nothing to fall back to.
    expect(mergeMenuVariationPatch(null, { menu_id: "m1", name: "Half" }).ok).toBe(false);
    // Empty string means "not sent" — the stored price survives.
    expect(mergeMenuVariationPatch(storedVariation(), { price: "" }))
      .toEqual({ ok: true, value: { menu_id: "m1", name: "Half", price: 150, is_default: false, active: true, sort_order: 2 } });
  });

  test("prices are rounded to paise", () => {
    const merged = mergeMenuVariationPatch(null, { menu_id: "m1", name: "Half", price: 149.999 });
    expect(merged.ok && merged.value.price).toBe(150);
  });

  test("a variation cannot be MOVED to another dish", () => {
    // Its id is stamped on order lines: re-pointing it would relabel every past
    // sale that named it.
    const merged = mergeMenuVariationPatch(storedVariation(), { menu_id: "m2" });
    expect(merged.ok).toBe(false);
    expect(merged.ok === false && merged.error).toContain("cannot be moved");
    // Re-sending the SAME dish is not a move.
    expect(mergeMenuVariationPatch(storedVariation(), { menu_id: "m1" }).ok).toBe(true);
  });

  test("a create needs a dish and a name", () => {
    expect(mergeMenuVariationPatch(null, { name: "Half", price: 150 }).ok).toBe(false);
    expect(mergeMenuVariationPatch(null, { menu_id: "m1", price: 150 }).ok).toBe(false);
  });
});

describe("what a guest is offered", () => {
  test("a dish with no variations gets NO key at all — not an empty array", () => {
    // This is the mechanism behind the whole absent-config guarantee.
    const byItem = publicVariationsByItem([]);
    expect(variationPayloadFor("m1", byItem)).toEqual({});
    expect("variations" in variationPayloadFor("m1", byItem)).toBe(false);
    expect(JSON.stringify({ id: "m1", ...variationPayloadFor("m1", byItem) })).toBe('{"id":"m1"}');
  });

  test("retired variations are dropped from the guest surface", () => {
    const byItem = publicVariationsByItem([
      row({ id: "v1", menu_id: "m1", name: "Half", active: false }),
      row({ id: "v2", menu_id: "m1", name: "Full", price: 250 }),
    ]);
    expect(byItem.get("m1")?.map((v) => v.name)).toEqual(["Full"]);
  });

  test("a dish whose every variation is retired gets no key either", () => {
    const byItem = publicVariationsByItem([row({ id: "v1", menu_id: "m1", active: false })]);
    expect(variationPayloadFor("m1", byItem)).toEqual({});
  });

  test("at most ONE variation per dish is served as the default", () => {
    // Two pre-selected options is not a state a picker can render, and two
    // clients guessing differently would show two prices for one dish.
    const byItem = publicVariationsByItem([
      row({ id: "v1", menu_id: "m1", name: "Full", price: 250, is_default: true, sort_order: 1 }),
      row({ id: "v2", menu_id: "m1", name: "Half", price: 150, is_default: true, sort_order: 0 }),
    ]);
    const list = byItem.get("m1") ?? [];
    expect(list.map((v) => [v.name, v.is_default])).toEqual([["Half", true], ["Full", false]]);
  });

  test("ordering is sort_order, then name, then arrival — and it is stable", () => {
    const byItem = publicVariationsByItem([
      row({ id: "v1", menu_id: "m1", name: "Zebra", sort_order: 5 }),
      row({ id: "v2", menu_id: "m1", name: "Beta", sort_order: 5 }),
      row({ id: "v3", menu_id: "m1", name: "Alpha", sort_order: -1 }),
    ]);
    expect((byItem.get("m1") ?? []).map((v) => v.name)).toEqual(["Alpha", "Beta", "Zebra"]);
  });

  test("prices are served rounded, and dishes stay separate", () => {
    const byItem = publicVariationsByItem([
      row({ id: "v1", menu_id: "m1", price: 149.999 }),
      row({ id: "v2", menu_id: "m2", name: "Large", price: 80 }),
    ]);
    expect(byItem.get("m1")?.[0]?.price).toBe(150);
    expect(byItem.get("m2")?.map((v: PublicMenuVariation) => v.name)).toEqual(["Large"]);
  });
});


// ===========================================================================
// Part 2a — the price floor, the ONE rule both order paths call.
// ===========================================================================

const variation = (over: Partial<VariationPriceRef> & { id: string; menu_id: string }): VariationPriceRef =>
  ({ name: "Half", price: 150, active: true, ...over });

const lookup = (...vs: VariationPriceRef[]): ReadonlyMap<string, VariationPriceRef> =>
  new Map(vs.map((v) => [v.id, v]));

describe("resolveLinePriceFloor", () => {
  const dish = { id: "m1", price: 250 };

  test("a line naming NO variation floors at the base price — unchanged behaviour", () => {
    // Every line written before 039, and every line of every tenant that
    // configures none. This arm must stay arithmetically what shipped.
    for (const named of [undefined, null, "", "   ", 7]) {
      expect(resolveLinePriceFloor(named, dish, lookup()))
        .toEqual({ base: 250, variation: null, refused: "none" });
    }
  });

  test("a line naming a live variation OF THIS DISH floors at the VARIATION price", () => {
    // The money bug this exists to prevent: floored at the base, a Half plate
    // would be rung at ₹250 with "Half" still printed on the docket.
    const half = variation({ id: "v1", menu_id: "m1" });
    expect(resolveLinePriceFloor("v1", dish, lookup(half)))
      .toEqual({ base: 150, variation: half, refused: "none" });
    // Whitespace around a real id is still that id.
    expect(resolveLinePriceFloor("  v1  ", dish, lookup(half)).base).toBe(150);
  });

  test("a variation belonging to ANOTHER dish is refused — the floor is not a hole", () => {
    // Honouring it would let a till bill a ₹250 dish at another dish's ₹80
    // "Small" price.
    const foreign = variation({ id: "v9", menu_id: "m2", name: "Small", price: 80 });
    expect(resolveLinePriceFloor("v9", dish, lookup(foreign)))
      .toEqual({ base: 250, variation: null, refused: "foreign" });
  });

  test("a RETIRED variation cannot be sold again", () => {
    const retired = variation({ id: "v1", menu_id: "m1", active: false });
    expect(resolveLinePriceFloor("v1", dish, lookup(retired)))
      .toEqual({ base: 250, variation: null, refused: "retired" });
  });

  test("an id nobody has heard of is refused", () => {
    expect(resolveLinePriceFloor("v-nope", dish, lookup()))
      .toEqual({ base: 250, variation: null, refused: "unknown" });
  });

  test("EVERY refusal falls back UP to the base price, never down", () => {
    // The safe direction, stated as one property: a hostile or stale
    // variation_id can only ever cost the guest full price.
    const cheapForeign = variation({ id: "vf", menu_id: "m2", price: 1 });
    const cheapRetired = variation({ id: "vr", menu_id: "m1", price: 1, active: false });
    for (const id of ["vf", "vr", "unknown-id"]) {
      const r = resolveLinePriceFloor(id, dish, lookup(cheapForeign, cheapRetired));
      expect(r.base).toBe(250);
      expect(r.variation).toBeNull();
    }
  });

  test("anyLineNamesVariation gates the extra query — false for every legacy line", () => {
    expect(anyLineNamesVariation([])).toBe(false);
    expect(anyLineNamesVariation([{ name: "Dosa", price: 120 }, null, undefined])).toBe(false);
    expect(anyLineNamesVariation([{ variation_id: "" }, { variation_id: "   " }, { variation_id: 7 }])).toBe(false);
    expect(anyLineNamesVariation([{ name: "Dosa" }, { variation_id: "v1" }])).toBe(true);
  });
});


// ===========================================================================
// Part 2b — the KOT fingerprint and the printed line.
// ===========================================================================

describe("KOT numbering across the 039 deploy", () => {
  const key = (items: { name: string; quantity: number; note?: string | null; variation?: string | null }[]): string =>
    kotTicketKey({ outletId: "o1", businessDay: "2026-09-02", tableId: "t1", items });
  // kot_numbers.ts imports database_supabase.ts, which refuses to load without a
  // connection string — so it is pulled in from beforeAll, after the bootstrap,
  // exactly as jest-tests/kot_numbering.test.ts does.

  test("a ticket with no variations hashes EXACTLY as it did before the field existed", () => {
    // If it did not, the first reprint of every live table on deploy day would
    // burn a second KOT number for a docket already on paper.
    const withField = key([{ name: "Paneer Tikka", quantity: 2, note: "no chilli", variation: null }]);
    const withoutField = key([{ name: "Paneer Tikka", quantity: 2, note: "no chilli" }]);
    const emptyString = key([{ name: "Paneer Tikka", quantity: 2, note: "no chilli", variation: "  " }]);
    expect(withField).toBe(withoutField);
    expect(emptyString).toBe(withoutField);
  });

  test("swapping a Half for a Full at the same quantity is a DIFFERENT ticket", () => {
    // Price is not in the fingerprint, so without the label these two hashed the
    // same and the second docket printed the first ticket's number as a reprint.
    const half = key([{ name: "Paneer Tikka", quantity: 1, variation: "Half" }]);
    const full = key([{ name: "Paneer Tikka", quantity: 1, variation: "Full" }]);
    expect(half).not.toBe(full);
    expect(half).not.toBe(key([{ name: "Paneer Tikka", quantity: 1 }]));
  });

  test("a genuine reprint of the same variation still finds the same number", () => {
    expect(key([{ name: "Paneer Tikka", quantity: 1, variation: "Half" }]))
      .toBe(key([{ name: "Paneer Tikka", quantity: 1, variation: " half " }]));
  });
});

describe("the printed docket and bill", () => {
  const render = (items: ReceiptItem[], kind: "bill" | "kot"): string =>
    Buffer.from(buildReceiptBase64({
      restaurantName: "Gaia", table: "T4", covers: 2, items,
      total: 400, currency: "₹", kind, grandTotal: 400,
    }, 48), "base64").toString("latin1");

  test("a line with no variation prints byte-identically to before the field existed", () => {
    const plain: ReceiptItem = { name: "Paneer Tikka", quantity: 1, price: 250 };
    for (const kind of ["bill", "kot"] as const) {
      expect(render([{ ...plain, variation: null }], kind)).toBe(render([plain], kind));
      expect(render([{ ...plain, variation: "  " }], kind)).toBe(render([plain], kind));
    }
  });

  test("the variation is printed on BOTH the docket and the bill", () => {
    // A docket that says "Half" beside a bill that says only the dish name is
    // how a ₹150 line gets queried at the till.
    const item: ReceiptItem = { name: "Paneer Tikka", quantity: 1, price: 150, variation: "Half" };
    expect(render([item], "kot")).toContain("Paneer Tikka (Half)");
    const bill = render([item], "bill");
    expect(bill).toContain("Paneer Tikka (Half)");
    // …and it is the VARIATION price beside it, not the dish's base.
    expect(bill).toContain("150.00");
  });
});


// ===========================================================================
// Parts 1 and 3 — the REAL routes over the fixture.
// ===========================================================================

let harness: FakeApp;
let kotTicketKey: typeof import("../kot_numbers").kotTicketKey;

const VIEW_MENU = "f4177b38-77fa-4d8c-9fbd-c4f06bf28610";
const EDIT_MENU = "ed800655-b937-44ba-a7ca-7458295886c9";

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL ?? "postgres://fixture:fixture@localhost:5432/fixture";
  process.env.PLATFORM_DATABASE_URL =
    process.env.PLATFORM_DATABASE_URL ?? "postgres://fixture:fixture@localhost:5432/fixture";

  ({ kotTicketKey } = await import("../kot_numbers"));
  const taxonomyRoutes = await import("../routes/menu_taxonomy");
  const guestRoutes = await import("../routes/guest");
  harness = makeFakeApp();
  taxonomyRoutes.registerMenuTaxonomyRoutes(harness.app as never);
  guestRoutes.registerGuestOrderingRoutes(harness.app as never);
  // The waitlist half carries POST /qr/:slug/waitlist/:token/preorder, which is
  // the guest write that runs normalizeWaitlistItems + repriceFromMenu — the
  // pair the table-QR order path also runs.
  guestRoutes.registerGuestWaitlistAndPaymentRoutes(harness.app as never);
});

let ipSeq = 0;
const freshIp = (): string => `198.51.100.${String((ipSeq++ % 250) + 1)}`;

interface Tenant { res: RestaurantRow; outlet: OutletRow; paneerId: string; dosaId: string }

function seedTenant(): Tenant {
  const res = addRestaurant({ res_username: "gaia" });
  const outlet = addOutlet({ res_id: res.id, outlet_name: "Main" });
  const paneerId = fixtureUuid();
  const dosaId = fixtureUuid();
  addMenuItem({ res_id: res.id, outlet_id: outlet.id, id: paneerId, name: "Paneer Tikka", price: 250, category: "Starters" });
  addMenuItem({ res_id: res.id, outlet_id: outlet.id, id: dosaId, name: "Dosa", price: 120, category: "Mains" });
  return { res, outlet, paneerId, dosaId };
}

const auth = (t: Tenant, actions: string[]) =>
  ({ res_id: t.res.id, outlet_id: t.outlet.id, employeeId: "emp-1", role: "admin", actions });

const menu = (): Promise<{ status: number; body: unknown }> =>
  harness.call("GET", "/qr/:slug/menu", { params: { slug: "gaia" }, ip: freshIp() });

beforeEach(() => { resetStore(); });


describe("PART 1 — a restaurant that configures nothing is unchanged", () => {
  test("the guest menu payload carries NO variations key anywhere", async () => {
    seedTenant();
    const r = await menu();
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain("variation");
  });

  test("adding a variation changed the payload by EXACTLY that one key on that one dish", async () => {
    // The strongest form of "byte-identical" available without a golden file
    // that would rot: serve the same tenant twice and assert the two payloads
    // differ only by the key this feature adds.
    const t = seedTenant();
    const before = JSON.stringify((await menu()).body);

    addMenuVariation({ res_id: t.res.id, outlet_id: t.outlet.id, menu_id: t.paneerId, name: "Half", price: 150 });
    const after = (await menu()).body as { items: Record<string, unknown>[] };
    const paneer = after.items.find((i) => i.id === t.paneerId);
    const dosa = after.items.find((i) => i.id === t.dosaId);
    expect(paneer?.variations).toEqual([{ id: expect.any(String), name: "Half", price: 150, is_default: false }]);
    // The OTHER dish is untouched — no empty array, no key.
    expect("variations" in (dosa ?? {})).toBe(false);

    delete paneer?.variations;
    expect(JSON.stringify(after)).toBe(before);
  });

  test("a variations read failure degrades to today's page rather than a 500", async () => {
    // Variations are an offer; the menu is the product. Same trade the posters
    // read makes, and the opposite of repriceFromMenu, where swallowing a failed
    // MENU read into "empty" destroyed real orders.
    const t = seedTenant();
    const v = addMenuVariation({ res_id: t.res.id, outlet_id: t.outlet.id, menu_id: t.paneerId, name: "Half", price: 150 });
    expect(((await menu()).body as { items: Record<string, unknown>[] }).items.some((i) => i.variations)).toBe(true);

    Object.defineProperty(v, "price", { get() { throw new Error("variation read exploded"); } });
    const r = await menu();
    expect(r.status).toBe(200);
    const body = r.body as { items: Record<string, unknown>[] };
    expect(body.items.length).toBe(2);
    expect(JSON.stringify(body)).not.toContain("variation");
  });

  test("a RETIRED variation is not offered to a guest", async () => {
    const t = seedTenant();
    addMenuVariation({ res_id: t.res.id, outlet_id: t.outlet.id, menu_id: t.paneerId, name: "Half", price: 150, active: false });
    expect(JSON.stringify((await menu()).body)).not.toContain("Half");
  });

  test("a guest pre-order with no variation stores exactly the line it always stored", async () => {
    const t = seedTenant();
    const entry = addWaitlistEntry({ res_id: t.res.id, status: "waiting" });
    const r = await harness.call("POST", "/qr/:slug/waitlist/:token/preorder", {
      params: { slug: "gaia", token: entry.token },
      body: { items: [{ id: t.paneerId, name: "Paneer Tikka", price: 250, quantity: 1 }] },
      ip: freshIp(),
    });
    expect(r.status).toBe(200);
    const stored = JSON.parse(waitlists().find((w) => w.token === entry.token)?.pre_order ?? "[]") as unknown[];
    expect(stored).toEqual([{ id: t.paneerId, menu_id: t.paneerId, name: "Paneer Tikka", price: 250, quantity: 1 }]);
  });
});


describe("PART 2c — the GUEST door honours the variation price", () => {
  test("a guest picking Half is stored at the HALF price, not floored up to the dish's", async () => {
    // The route runs normalizeWaitlistItems -> repriceFromMenu, the same pair
    // POST /qr/:slug/order runs. Before 039 taught repriceFromMenu about
    // variations, this line came back at 250.
    const t = seedTenant();
    const half = addMenuVariation({ res_id: t.res.id, outlet_id: t.outlet.id, menu_id: t.paneerId, name: "Half", price: 150 });
    const entry = addWaitlistEntry({ res_id: t.res.id, status: "waiting" });

    const r = await harness.call("POST", "/qr/:slug/waitlist/:token/preorder", {
      params: { slug: "gaia", token: entry.token },
      // A hostile client price of ₹1 is ignored — the server re-prices.
      body: { items: [{ id: t.paneerId, name: "Paneer Tikka", price: 1, quantity: 2, variation_id: half.id }] },
      ip: freshIp(),
    });
    expect(r.status).toBe(200);
    const stored = JSON.parse(waitlists().find((w) => w.token === entry.token)?.pre_order ?? "[]") as Record<string, unknown>[];
    expect(stored).toEqual([{
      id: t.paneerId, menu_id: t.paneerId, name: "Paneer Tikka", price: 150, quantity: 2,
      variation_id: half.id, variation_name: "Half",
    }]);
  });

  test("a guest naming ANOTHER dish's variation pays this dish's full price", async () => {
    const t = seedTenant();
    const dosaSmall = addMenuVariation({ res_id: t.res.id, outlet_id: t.outlet.id, menu_id: t.dosaId, name: "Small", price: 80 });
    const entry = addWaitlistEntry({ res_id: t.res.id, status: "waiting" });

    await harness.call("POST", "/qr/:slug/waitlist/:token/preorder", {
      params: { slug: "gaia", token: entry.token },
      body: { items: [{ id: t.paneerId, name: "Paneer Tikka", price: 80, quantity: 1, variation_id: dosaSmall.id }] },
      ip: freshIp(),
    });
    const stored = JSON.parse(waitlists().find((w) => w.token === entry.token)?.pre_order ?? "[]") as Record<string, unknown>[];
    expect(stored[0]).toEqual({ id: t.paneerId, menu_id: t.paneerId, name: "Paneer Tikka", price: 250, quantity: 1 });
  });

  test("a guest naming a RETIRED variation pays the full price", async () => {
    const t = seedTenant();
    const gone = addMenuVariation({ res_id: t.res.id, outlet_id: t.outlet.id, menu_id: t.paneerId, name: "Half", price: 150, active: false });
    const entry = addWaitlistEntry({ res_id: t.res.id, status: "waiting" });

    await harness.call("POST", "/qr/:slug/waitlist/:token/preorder", {
      params: { slug: "gaia", token: entry.token },
      body: { items: [{ id: t.paneerId, name: "Paneer Tikka", price: 150, quantity: 1, variation_id: gone.id }] },
      ip: freshIp(),
    });
    const stored = JSON.parse(waitlists().find((w) => w.token === entry.token)?.pre_order ?? "[]") as Record<string, unknown>[];
    expect(stored[0]?.price).toBe(250);
    expect("variation_id" in (stored[0] ?? {})).toBe(false);
  });

  test("the LABEL on the line is the server's, never the client's", async () => {
    const t = seedTenant();
    const half = addMenuVariation({ res_id: t.res.id, outlet_id: t.outlet.id, menu_id: t.paneerId, name: "Half", price: 150 });
    const entry = addWaitlistEntry({ res_id: t.res.id, status: "waiting" });

    await harness.call("POST", "/qr/:slug/waitlist/:token/preorder", {
      params: { slug: "gaia", token: entry.token },
      body: { items: [{ id: t.paneerId, name: "Free Paneer", price: 0, quantity: 1, variation_id: half.id, variation_name: "COMPLIMENTARY" }] },
      ip: freshIp(),
    });
    const stored = JSON.parse(waitlists().find((w) => w.token === entry.token)?.pre_order ?? "[]") as Record<string, unknown>[];
    expect(stored[0]?.variation_name).toBe("Half");
    expect(stored[0]?.name).toBe("Paneer Tikka");
    expect(stored[0]?.price).toBe(150);
  });
});


describe("PART 3 — the group routes", () => {
  test("View Menu reads, Edit Menu writes, and a holder of neither is refused", async () => {
    const t = seedTenant();
    expect((await harness.call("GET", "/menu-groups", { auth: auth(t, []) })).status).toBe(403);
    expect((await harness.call("POST", "/menu-groups", { auth: auth(t, [VIEW_MENU]), body: { name: "Food" } })).status).toBe(403);
    expect((await harness.call("GET", "/menu-groups", { auth: auth(t, [VIEW_MENU]) })).status).toBe(200);
  });

  test("a group is created, then EDITED by merge — a retire keeps its name and axis", async () => {
    const t = seedTenant();
    const created = await harness.call("POST", "/menu-groups", {
      auth: auth(t, [EDIT_MENU]), body: { name: "Liquor", kind: "revenue", sort_order: 4 },
    });
    expect(created.status).toBe(201);
    const group = (created.body as { group: { id: string; name: string; sort_order: number } }).group;
    expect(group).toMatchObject({ name: "Liquor", kind: "revenue", active: true, sort_order: 4 });

    const retired = await harness.call("PATCH", "/menu-groups/:id", {
      auth: auth(t, [EDIT_MENU]), params: { id: group.id }, body: { active: false },
    });
    expect(retired.status).toBe(200);
    expect((retired.body as { group: unknown }).group).toMatchObject({ name: "Liquor", kind: "revenue", active: false, sort_order: 4 });
  });

  test("a RENAME works — the write is an UPDATE by id, not the name-keyed upsert", async () => {
    // Through UpsertMenuGroup a rename would trip the primary key; that is why
    // UpdateMenuGroupById exists at all.
    const t = seedTenant();
    const g = addMenuGroup({ res_id: t.res.id, outlet_id: t.outlet.id, name: "Bevrage" });
    const r = await harness.call("PATCH", "/menu-groups/:id", {
      auth: auth(t, [EDIT_MENU]), params: { id: g.id }, body: { name: "Beverage" },
    });
    expect(r.status).toBe(200);
    expect((r.body as { group: { name: string } }).group.name).toBe("Beverage");
  });

  test("a duplicate name is a 409 that hands back the EXISTING group, not a second bucket", async () => {
    // "Beverage" and "beverage" as two groups would split one bucket in two on
    // every report that sums by name.
    const t = seedTenant();
    const first = addMenuGroup({ res_id: t.res.id, outlet_id: t.outlet.id, name: "Beverage" });
    const r = await harness.call("POST", "/menu-groups", { auth: auth(t, [EDIT_MENU]), body: { name: "  beverage " } });
    expect(r.status).toBe(409);
    expect((r.body as { group: { id: string } }).group.id).toBe(first.id);
    // …and the stored row was NOT quietly rewritten by the attempt.
    expect(first.name).toBe("Beverage");
  });

  test("renaming ONTO another group's name is refused rather than merging the two", async () => {
    const t = seedTenant();
    addMenuGroup({ res_id: t.res.id, outlet_id: t.outlet.id, name: "Food" });
    const other = addMenuGroup({ res_id: t.res.id, outlet_id: t.outlet.id, name: "Beverage" });
    const r = await harness.call("PATCH", "/menu-groups/:id", {
      auth: auth(t, [EDIT_MENU]), params: { id: other.id }, body: { name: "Food" },
    });
    expect(r.status).toBe(409);
    expect(other.name).toBe("Beverage");
  });

  test("a group from another outlet is a 404, not someone else's row", async () => {
    const t = seedTenant();
    const other = addRestaurant({ res_username: "elsewhere" });
    const otherOutlet = addOutlet({ res_id: other.id, outlet_name: "Main" });
    const theirs = addMenuGroup({ res_id: other.id, outlet_id: otherOutlet.id, name: "Food" });
    const r = await harness.call("PATCH", "/menu-groups/:id", {
      auth: auth(t, [EDIT_MENU]), params: { id: theirs.id }, body: { name: "Stolen" },
    });
    expect(r.status).toBe(404);
    expect(theirs.name).toBe("Food");
  });

  test("an unknown ?kind is refused rather than answered on the wrong axis", async () => {
    const t = seedTenant();
    const r = await harness.call("GET", "/menu-groups", { auth: auth(t, [VIEW_MENU]), query: { kind: "producton" } });
    expect(r.status).toBe(400);
  });

  test("the list defaults to BOTH axes — a production group is never silently hidden", async () => {
    // Defaulting the LIST to revenue would hide every production group an owner
    // configured. Listing both is lossless; the caller filters what it got.
    const t = seedTenant();
    addMenuGroup({ res_id: t.res.id, outlet_id: t.outlet.id, name: "Food", kind: "revenue" });
    addMenuGroup({ res_id: t.res.id, outlet_id: t.outlet.id, name: "Bar", kind: "production" });

    const all = await harness.call("GET", "/menu-groups", { auth: auth(t, [VIEW_MENU]) });
    expect((all.body as { kind: unknown; groups: unknown[] }).kind).toBeNull();
    expect((all.body as { groups: { name: string }[] }).groups.map((g) => g.name).sort()).toEqual(["Bar", "Food"]);

    const oneAxis = await harness.call("GET", "/menu-groups", { auth: auth(t, [VIEW_MENU]), query: { kind: "production" } });
    expect((oneAxis.body as { kind: string; groups: { name: string }[] })).toMatchObject({ kind: "production" });
    expect((oneAxis.body as { groups: { name: string }[] }).groups.map((g) => g.name)).toEqual(["Bar"]);
  });

  test("a malformed ?menu_id is refused, not widened to the whole menu", async () => {
    // The data layer drops a non-uuid filter and answers for every dish, so a
    // typo'd id would hand a client another dish's price points to render
    // against this one — a wrong answer that looks like a right one.
    const t = seedTenant();
    addMenuVariation({ res_id: t.res.id, outlet_id: t.outlet.id, menu_id: t.dosaId, name: "Small", price: 80 });
    const r = await harness.call("GET", "/menu-variations", { auth: auth(t, [VIEW_MENU]), query: { menu_id: "not-a-uuid" } });
    expect(r.status).toBe(400);
  });

  test("retired groups are hidden by default and returned on request", async () => {
    const t = seedTenant();
    addMenuGroup({ res_id: t.res.id, outlet_id: t.outlet.id, name: "Tobacco", active: false });
    const hidden = await harness.call("GET", "/menu-groups", { auth: auth(t, [VIEW_MENU]) });
    expect((hidden.body as { groups: unknown[] }).groups).toHaveLength(0);
    const shown = await harness.call("GET", "/menu-groups", { auth: auth(t, [VIEW_MENU]), query: { include_inactive: "true" } });
    expect((shown.body as { groups: unknown[] }).groups).toHaveLength(1);
  });
});


describe("PART 3 — filing the menu under groups", () => {
  test("an unclassified menu reports itself as unclassified — it never invents a group", async () => {
    const t = seedTenant();
    const r = await harness.call("GET", "/menu-group-assignments", { auth: auth(t, [VIEW_MENU]) });
    expect(r.status).toBe(200);
    const body = r.body as { items: { resolved_group_name: string | null }[]; unclassified_items: number; categories: unknown[] };
    expect(body.unclassified_items).toBe(2);
    expect(body.items.every((i) => i.resolved_group_name === null)).toBe(true);
    // The category ids an editor needs — nothing else exposes them.
    expect(body.categories).toHaveLength(2);
  });

  test("a CATEGORY default classifies every dish under it, and an ITEM override beats it", async () => {
    const t = seedTenant();
    const food = addMenuGroup({ res_id: t.res.id, outlet_id: t.outlet.id, name: "Food" });
    const bev = addMenuGroup({ res_id: t.res.id, outlet_id: t.outlet.id, name: "Beverage" });
    const before = await harness.call("GET", "/menu-group-assignments", { auth: auth(t, [VIEW_MENU]) });
    const starters = (before.body as { categories: { id: string; name: string }[] }).categories
      .find((c) => c.name === "Starters");

    const filed = await harness.call("POST", "/menu-group-assignments", {
      auth: auth(t, [EDIT_MENU]), body: { main_cat_id: starters?.id, group_id: food.id },
    });
    expect(filed.status).toBe(200);

    const after = await harness.call("GET", "/menu-group-assignments", { auth: auth(t, [VIEW_MENU]) });
    const paneer = (after.body as { items: { id: string; group_id: string | null; resolved_group_name: string | null }[] }).items
      .find((i) => i.id === t.paneerId);
    // Inherited, not overridden — the editor can tell the two apart.
    expect(paneer).toMatchObject({ group_id: null, resolved_group_name: "Food" });
    expect((after.body as { unclassified_items: number }).unclassified_items).toBe(1);

    // The genuine exception: one dish filed against its category's default.
    await harness.call("POST", "/menu-group-assignments", {
      auth: auth(t, [EDIT_MENU]), body: { menu_id: t.paneerId, group_id: bev.id },
    });
    const overridden = await harness.call("GET", "/menu-group-assignments", { auth: auth(t, [VIEW_MENU]) });
    expect((overridden.body as { items: { id: string; group_id: string | null; resolved_group_name: string | null }[] }).items
      .find((i) => i.id === t.paneerId))
      .toMatchObject({ group_id: bev.id, resolved_group_name: "Beverage" });
  });

  test("clearing an item override falls back to the category, not to Unclassified", async () => {
    const t = seedTenant();
    const food = addMenuGroup({ res_id: t.res.id, outlet_id: t.outlet.id, name: "Food" });
    const bev = addMenuGroup({ res_id: t.res.id, outlet_id: t.outlet.id, name: "Beverage" });
    setFixtureGroupOnCategory(t.res.id, t.outlet.id, "Starters", food.id);
    await harness.call("POST", "/menu-group-assignments", {
      auth: auth(t, [EDIT_MENU]), body: { menu_id: t.paneerId, group_id: bev.id },
    });
    await harness.call("POST", "/menu-group-assignments", {
      auth: auth(t, [EDIT_MENU]), body: { menu_id: t.paneerId, group_id: null },
    });
    const r = await harness.call("GET", "/menu-group-assignments", { auth: auth(t, [VIEW_MENU]) });
    expect((r.body as { items: { id: string; resolved_group_name: string | null }[] }).items.find((i) => i.id === t.paneerId))
      .toMatchObject({ group_id: null, resolved_group_name: "Food" });
  });

  test("a group from another outlet cannot be filed against this menu", async () => {
    // Neither column carries a foreign key, so a dangling uuid would look
    // classified on the editor and report as Unclassified.
    const t = seedTenant();
    const other = addRestaurant({ res_username: "elsewhere" });
    const otherOutlet = addOutlet({ res_id: other.id, outlet_name: "Main" });
    const theirs = addMenuGroup({ res_id: other.id, outlet_id: otherOutlet.id, name: "Food" });
    const r = await harness.call("POST", "/menu-group-assignments", {
      auth: auth(t, [EDIT_MENU]), body: { menu_id: t.paneerId, group_id: theirs.id },
    });
    expect(r.status).toBe(400);
  });

  test("naming both a dish and a category is refused rather than half-honoured", async () => {
    const t = seedTenant();
    const r = await harness.call("POST", "/menu-group-assignments", {
      auth: auth(t, [EDIT_MENU]), body: { menu_id: t.paneerId, main_cat_id: "maincat-1", group_id: null },
    });
    expect(r.status).toBe(400);
    expect((await harness.call("POST", "/menu-group-assignments", { auth: auth(t, [EDIT_MENU]), body: {} })).status).toBe(400);
  });
});


describe("PART 3 — the variation routes", () => {
  test("a variation is created against a real dish and listed back", async () => {
    const t = seedTenant();
    const r = await harness.call("POST", "/menu-variations", {
      auth: auth(t, [EDIT_MENU]),
      body: { menu_id: t.paneerId, name: "Half", price: 150, is_default: true, sort_order: 1 },
    });
    expect(r.status).toBe(201);
    expect((r.body as { variation: unknown }).variation)
      .toMatchObject({ menu_id: t.paneerId, name: "Half", price: 150, is_default: true, active: true, sort_order: 1 });

    const list = await harness.call("GET", "/menu-variations", { auth: auth(t, [VIEW_MENU]), query: { menu_id: t.paneerId } });
    expect((list.body as { variations: unknown[] }).variations).toHaveLength(1);
  });

  test("a ZERO-priced variation is refused — it would be a ZERO FLOOR", async () => {
    // Free food is a non-chargeable (migration 034), with a reason, an
    // authoriser and a ledger row. Not a menu row anyone can ring in at ₹0.
    const t = seedTenant();
    for (const price of [0, -50, "abc"]) {
      const r = await harness.call("POST", "/menu-variations", {
        auth: auth(t, [EDIT_MENU]), body: { menu_id: t.paneerId, name: "Free", price },
      });
      expect(r.status).toBe(400);
    }
    expect(menuVariations()).toHaveLength(0);
  });

  test("retiring a variation through PATCH does NOT reset its price", async () => {
    // The merge-over-snapshot claim, at the route. Without it `{active:false}`
    // would default price to 0 and every line naming this id could be rung in
    // at nothing.
    const t = seedTenant();
    const v = addMenuVariation({ res_id: t.res.id, outlet_id: t.outlet.id, menu_id: t.paneerId, name: "Half", price: 150, sort_order: 3 });
    const r = await harness.call("PATCH", "/menu-variations/:id", {
      auth: auth(t, [EDIT_MENU]), params: { id: v.id }, body: { active: false },
    });
    expect(r.status).toBe(200);
    expect((r.body as { variation: unknown }).variation)
      .toMatchObject({ name: "Half", price: 150, active: false, sort_order: 3 });
    expect(menuVariations()[0]?.price).toBe(150);
  });

  test("a PATCH that sends a bad price leaves the stored price alone", async () => {
    const t = seedTenant();
    const v = addMenuVariation({ res_id: t.res.id, outlet_id: t.outlet.id, menu_id: t.paneerId, name: "Half", price: 150 });
    const r = await harness.call("PATCH", "/menu-variations/:id", {
      auth: auth(t, [EDIT_MENU]), params: { id: v.id }, body: { price: 0 },
    });
    expect(r.status).toBe(400);
    expect(menuVariations()[0]?.price).toBe(150);
  });

  test("a variation cannot be MOVED to another dish through the route either", async () => {
    const t = seedTenant();
    const v = addMenuVariation({ res_id: t.res.id, outlet_id: t.outlet.id, menu_id: t.paneerId, name: "Half", price: 150 });
    const r = await harness.call("PATCH", "/menu-variations/:id", {
      auth: auth(t, [EDIT_MENU]), params: { id: v.id }, body: { menu_id: t.dosaId },
    });
    expect(r.status).toBe(400);
    expect(menuVariations()[0]?.menu_id).toBe(t.paneerId);
  });

  test("a variation on a dish that is not on this menu is refused by the foreign key", async () => {
    const t = seedTenant();
    const r = await harness.call("POST", "/menu-variations", {
      auth: auth(t, [EDIT_MENU]), body: { menu_id: fixtureUuid(9999), name: "Half", price: 150 },
    });
    expect(r.status).toBe(400);
    expect(menuVariations()).toHaveLength(0);
  });

  test("a duplicate name on one dish is a 409; the SAME name on ANOTHER dish is fine", async () => {
    const t = seedTenant();
    addMenuVariation({ res_id: t.res.id, outlet_id: t.outlet.id, menu_id: t.paneerId, name: "Half", price: 150 });
    const dupe = await harness.call("POST", "/menu-variations", {
      auth: auth(t, [EDIT_MENU]), body: { menu_id: t.paneerId, name: " half ", price: 999 },
    });
    expect(dupe.status).toBe(409);
    expect(menuVariations()[0]?.price).toBe(150);

    const otherDish = await harness.call("POST", "/menu-variations", {
      auth: auth(t, [EDIT_MENU]), body: { menu_id: t.dosaId, name: "Half", price: 70 },
    });
    expect(otherDish.status).toBe(201);
  });

  test("a retired duplicate says so, so an owner reinstates instead of stacking a second", async () => {
    const t = seedTenant();
    addMenuVariation({ res_id: t.res.id, outlet_id: t.outlet.id, menu_id: t.paneerId, name: "Half", price: 150, active: false });
    const r = await harness.call("POST", "/menu-variations", {
      auth: auth(t, [EDIT_MENU]), body: { menu_id: t.paneerId, name: "Half", price: 160 },
    });
    expect(r.status).toBe(409);
    expect(String((r.body as { error: string }).error)).toContain("retired");
  });

  test("another outlet's variation is a 404", async () => {
    const t = seedTenant();
    const other = addRestaurant({ res_username: "elsewhere" });
    const otherOutlet = addOutlet({ res_id: other.id, outlet_name: "Main" });
    const dishId = fixtureUuid();
    addMenuItem({ res_id: other.id, outlet_id: otherOutlet.id, id: dishId, name: "Theirs", price: 100, category: "X" });
    const theirs = addMenuVariation({ res_id: other.id, outlet_id: otherOutlet.id, menu_id: dishId, name: "Half", price: 50 });
    const r = await harness.call("PATCH", "/menu-variations/:id", {
      auth: auth(t, [EDIT_MENU]), params: { id: theirs.id }, body: { price: 1 },
    });
    expect(r.status).toBe(404);
    expect(theirs.price).toBe(50);
  });

  test("there is no wholesale replace and no delete on either table", () => {
    // The 56-item wipe, and 039's deactivate-never-delete rule, as a claim about
    // the registered route table rather than about anyone's intentions.
    const paths = harness.routes().filter((r) => /^\/menu-(groups|variations|group-assignments)/.test(r.path));
    expect(paths.some((r) => r.method === "PUT")).toBe(false);
    expect(paths.some((r) => r.method === "DELETE")).toBe(false);
    expect(paths.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      "GET /menu-group-assignments",
      "GET /menu-groups",
      "GET /menu-variations",
      "PATCH /menu-groups/:id",
      "PATCH /menu-variations/:id",
      "POST /menu-group-assignments",
      "POST /menu-groups",
      "POST /menu-variations",
    ]);
  });
});
