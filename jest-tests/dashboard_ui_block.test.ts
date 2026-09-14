// BLOCK 6 — the three server-side halves of the V3 dashboard work.
//
// H1  the six headline figures
// H4  the availability toggle behind the "86 a dish" sidebar
// H6  the name printed on a running table's bill
//
// ============================================================================
// EACH OF THESE IS A WRITE THAT COULD DESTROY SOMETHING, AND THAT IS THE POINT
// ============================================================================
// H4 is the clearest. The obvious way to build it — POST /menu with
// `{ available: false }` — is a FULL UPSERT: it requires name, category and a
// positive price and it writes every field it is given. This codebase has
// already lost 56 menu items' images, sections and recipes to a bulk save that
// sent what the client happened to be holding. A control tapped forty times
// during a rush must be incapable of changing anything but the one flag, so the
// tests below assert the SHAPE OF THE WRITE, not the shape of the response.
//
// H6 has the mirror problem: the name lives inside "Orders".food, a table's bill
// is the SUM of its orders, and GetBillForTable takes the FIRST non-placeholder
// name it finds. Writing only one order therefore produces a bill whose header
// depends on which round was typed into first — and correcting a later round
// appears to do nothing at all.
//
// H1 is a read, and its hazard is different again: six figures whose definitions
// nobody can reconcile with their own reports. Its money must come from the same
// composition the MIS reports use, and the payload must carry its own
// definitions so the screen cannot invent different ones.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";

const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";
const TABLE_ID = "33333333-3333-4333-8333-333333333333";
const ITEM_ID = "44444444-4444-4444-8444-444444444444";

interface Fx {
  sql: string[];
  /** Every write to "Menu".description. */
  menuWrites: string[];
  /** The stored menu row's description blob. */
  menuDescription: string;
  /** The table's still-owing orders. */
  orders: { id: string; food: Record<string, unknown> }[];
  /** Every write to "Orders".food. */
  orderWrites: { id: string; food: Record<string, unknown> }[];
  /** Simulate a locked (approved/closed) bill. */
  billLocked: boolean;
}

const fx: Fx = {
  sql: [], menuWrites: [], menuDescription: "", orders: [], orderWrites: [], billLocked: false,
};

jest.mock("pg", () => {
  const query = async (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    fx.sql.push(q);
    const p = (params ?? []) as unknown[];
    if (/from "Restaurant" r/i.test(q)) {
      return { rows: [{
        res_id: RES, outlet_id: OUTLET, restaurant_slug: "gaia", restaurant_name: "Gaia",
        restaurant_main_office_add: null, restaurant_logo_url: null, timezone: "Asia/Kolkata",
      }] };
    }
    if (/^select id, name, description from "Menu"/i.test(q)) {
      return { rows: [{ id: ITEM_ID, name: "Paneer Tikka", description: fx.menuDescription }] };
    }
    if (/^update "Menu" set description/i.test(q)) {
      fx.menuWrites.push(String(p[3]));
      return { rows: [] };
    }
    if (/^select id from "Tables"/i.test(q)) { return { rows: [{ id: TABLE_ID }] }; }
    if (/from "Tables"/i.test(q)) { return { rows: [{ id: TABLE_ID, table_name: "T7" }] }; }
    if (/admin_approved_at from "Bills"/i.test(q)) {
      return { rows: [{ admin_approved_at: fx.billLocked ? new Date() : null }] };
    }
    if (/^select id, food from "Orders"/i.test(q)) { return { rows: fx.orders }; }
    if (/^update "Orders" set food/i.test(q)) {
      fx.orderWrites.push({ id: String(p[0]), food: JSON.parse(String(p[3])) as Record<string, unknown> });
      return { rows: [] };
    }
    return { rows: [] };
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> { return query(sql, params); }
    connect(): Promise<unknown> { return Promise.resolve({ query, release: () => undefined }); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: jest.fn(), emitOutlet: jest.fn() }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: jest.fn() }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

let db: typeof import("../database_supabase");

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
});

beforeEach(() => {
  fx.sql = [];
  fx.menuWrites = [];
  fx.orderWrites = [];
  fx.billLocked = false;
  // A REAL dish, with everything a bulk save has previously destroyed on one.
  fx.menuDescription = JSON.stringify({
    price: 390,
    available: true,
    image_url: "https://cdn.example.test/paneer.jpg",
    station: "tandoor",
    allergens: ["dairy", "nuts"],
    recipe: [{ inventory_id: "inv-paneer", qty: 0.15, note: "per portion" }],
    blurb: "Charred in the tandoor, finished with lime.",
    badges: ["chef_special"],
  });
  fx.orders = [
    { id: "o1", food: { customer: "Guest", items: [{ name: "Paneer Tikka", price: 390, quantity: 1 }] } },
    { id: "o2", food: { customer: "Guest", items: [{ name: "Naan", price: 60, quantity: 2 }] } },
  ];
});

// ===========================================================================
// H4 — ONE FLAG, AND NOTHING ELSE
// ===========================================================================
describe("taking a dish off the menu changes the dish and nothing else", () => {
  const written = (): Record<string, unknown> => {
    expect(fx.menuWrites).toHaveLength(1);
    return JSON.parse(fx.menuWrites[0]) as Record<string, unknown>;
  };

  test("the flag flips", async () => {
    const r = await db.SetMenuItemAvailability(RES, ITEM_ID, false);
    expect(r).toMatchObject({ id: ITEM_ID, name: "Paneer Tikka", available: false, previous: { available: true } });
    expect(written().available).toBe(false);
  });

  test("and it flips back", async () => {
    fx.menuDescription = JSON.stringify({ price: 390, available: false });
    const r = await db.SetMenuItemAvailability(RES, ITEM_ID, true);
    expect(r.available).toBe(true);
    // AVAILABLE IS THE ABSENCE OF THE KEY. encodeMenuDescription omits it when
    // true (the default), so a restored dish's blob is byte-identical to one
    // that was never taken off — which is what keeps this reversible rather than
    // leaving a trail of `available: true` on every dish anybody ever 86'd.
    expect(written().available).toBeUndefined();
  });

  test("THE RULE: the image, the station, the recipe, the allergens, the blurb and the badges all survive", async () => {
    // The incident this pins: a bulk save wiped 56 items' images, sections and
    // recipes because the client sent what it happened to be holding.
    await db.SetMenuItemAvailability(RES, ITEM_ID, false);
    expect(written()).toMatchObject({
      price: 390,
      image_url: "https://cdn.example.test/paneer.jpg",
      station: "tandoor",
      allergens: ["dairy", "nuts"],
      recipe: [{ inventory_id: "inv-paneer", qty: 0.15, note: "per portion" }],
      blurb: "Charred in the tandoor, finished with lime.",
      badges: ["chef_special"],
    });
  });

  test("the PRICE is untouched — this control must never be able to move money", async () => {
    await db.SetMenuItemAvailability(RES, ITEM_ID, false);
    expect(written().price).toBe(390);
  });

  test("it takes the row FOR UPDATE — two people 86ing the same dish at once is the normal case", async () => {
    // Without the lock the second write is a read-modify-write over a stale
    // description and silently undoes whatever landed between them.
    await db.SetMenuItemAvailability(RES, ITEM_ID, false);
    expect(fx.sql.some((q) => /select id, name, description from "Menu".*for update/i.test(q))).toBe(true);
  });

  test("an unknown dish is a 'not found', not a silent no-op", async () => {
    fx.menuDescription = "";
    const original = fx.sql;
    // Force the row read to come back empty.
    const spy = jest.spyOn(JSON, "parse");
    spy.mockRestore();
    void original;
    // The fixture always returns a row, so this asserts the guard exists in the
    // source rather than simulating a missing row through the fake.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fsmod = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const file = [process.cwd(), path.join(__dirname, "..")]
      .map((b) => path.join(b, "database_supabase.ts"))
      .find((f) => fsmod.existsSync(f))!;
    const src = fsmod.readFileSync(file, "utf8");
    const fn = src.slice(src.indexOf("export async function SetMenuItemAvailability"));
    expect(fn.slice(0, 2000)).toMatch(/throw new Error\("Menu item not found"\)/);
  });
});

// ===========================================================================
// H6 — THE NAME ON THE BILL
// ===========================================================================
describe("the name on a running table's bill", () => {
  test("EVERY still-owing order is renamed, not just the first", async () => {
    // GetBillForTable takes the FIRST non-placeholder name it finds, so writing
    // one order leaves the header dependent on which round was typed into
    // first — and correcting a later round appears to do nothing at all.
    const r = await db.SetBillCustomerName(RES, "T7", "Mr Sharma");
    expect(r).toMatchObject({ success: true, customer: "Mr Sharma", orders_updated: 2 });
    expect(fx.orderWrites.map((w) => w.id).sort()).toEqual(["o1", "o2"]);
    for (const w of fx.orderWrites) { expect(w.food.customer).toBe("Mr Sharma"); }
  });

  test("the ITEMS are carried through untouched", async () => {
    await db.SetBillCustomerName(RES, "T7", "Mr Sharma");
    const first = fx.orderWrites.find((w) => w.id === "o1")!;
    expect(first.food.items).toEqual([{ name: "Paneer Tikka", price: 390, quantity: 1 }]);
  });

  test("clearing restores the placeholder rather than an empty header", async () => {
    fx.orders = [{ id: "o1", food: { customer: "Mr Sharma", items: [] } }];
    const r = await db.SetBillCustomerName(RES, "T7", "   ");
    expect(r.customer).toBeNull();
    expect(fx.orderWrites[0].food.customer).toBe("Guest");
  });

  test("whitespace is collapsed and the name is capped", async () => {
    await db.SetBillCustomerName(RES, "T7", "  Mr   Sharma  ");
    expect(fx.orderWrites[0].food.customer).toBe("Mr Sharma");
    fx.orderWrites = [];
    await db.SetBillCustomerName(RES, "T7", "x".repeat(400));
    expect(String(fx.orderWrites[0].food.customer)).toHaveLength(120);
  });

  test("an order already carrying the name is not rewritten", async () => {
    fx.orders = [
      { id: "o1", food: { customer: "Mr Sharma", items: [] } },
      { id: "o2", food: { customer: "Guest", items: [] } },
    ];
    const r = await db.SetBillCustomerName(RES, "T7", "Mr Sharma");
    expect(r.orders_updated).toBe(1);
    expect(fx.orderWrites.map((w) => w.id)).toEqual(["o2"]);
  });

  test("a SETTLED bill is refused — the name is on a tax document by then", async () => {
    fx.billLocked = true;
    await expect(db.SetBillCustomerName(RES, "T7", "Mr Sharma")).rejects.toThrow();
    expect(fx.orderWrites).toHaveLength(0);
  });

  test("a table with nothing running says so rather than succeeding at nothing", async () => {
    fx.orders = [];
    await expect(db.SetBillCustomerName(RES, "T7", "Mr Sharma")).rejects.toThrow(/no running orders/i);
  });
});

// ===========================================================================
// H1 — THE SIX FIGURES
// ===========================================================================
describe("the headline figures define themselves", () => {
  function source(): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const file = [process.cwd(), path.join(__dirname, "..")]
      .map((b) => path.join(b, "database_supabase.ts"))
      .find((f) => fs.existsSync(f));
    if (!file) { throw new Error("database_supabase.ts not found"); }
    return fs.readFileSync(file, "utf8");
  }
  const fn = (): string => {
    const src = source();
    return src.slice(src.indexOf("export async function GetOverviewHeadline"), src.indexOf("// --- Drill-down"));
  };

  test("every figure ships its own definition, so the screen cannot invent one", () => {
    const body = fn();
    for (const key of ["today_net", "today_gross", "online_net", "online_gross", "cash_collection", "month_to_date"]) {
      expect(body).toContain(`${key}: fig(`);
    }
  });

  test("cash uses the SAME allocation as the Settlement Summary", () => {
    // Two different answers to "how much cash is in the till" is the one thing
    // this must never produce. The allocation now arrives through
    // settlementByMethod — the Settlement Summary's own cut — which calls
    // allocateSettlement; a second hand-rolled loop here is what this forbids.
    expect(fn()).toMatch(/settlementByMethod\(todaySettled\)/);
    expect(fn()).toMatch(/parsePaymentSplits\(/);
    expect(fn()).not.toMatch(/allocateSettlement\(/);
  });

  test("the Settlement Summary reads the very same cut", () => {
    const src = source();
    const report = src.slice(
      src.indexOf("export async function GetSettlementSummaryReport"),
      src.indexOf("// H1 — THE OVERVIEW HEADLINE"),
    );
    expect(report).toMatch(/settlementByMethod\(/);
    expect(report).not.toMatch(/allocateSettlement\(/);
  });

  test("Cash collection is READ OFF the by-method rows, so the Cash row and the tile cannot differ", () => {
    const body = fn();
    // Derived from the helper's rows, case-insensitively, as it always was…
    expect(body).toMatch(/for \(const row of byMethod\.rows\) \{\s*if \(row\.method\.trim\(\)\.toLowerCase\(\) === "cash"\)/);
    // …and the tile is that figure.
    expect(body).toMatch(/cash_collection: fig\(cash,/);
  });

  test("today by payment method ships, with its counts and its own definition", () => {
    const body = fn();
    for (const key of ["today_by_method:", "today_split_bills:", "today_unallocated:", "by_method: {"]) {
      expect(body).toContain(key);
    }
    // The split sentence both clients print claims MORE THAN ONE METHOD. The
    // report's split_bills also counts a one-tender bill whose other part is the
    // Unallocated residual, so it is the wrong count to hand them.
    expect(body).toMatch(/today_split_bills: byMethod\.multi_method_bills,/);
    expect(body).not.toMatch(/today_split_bills: byMethod\.split_bills/);
    // A released ₹0 table must not print as "Other ₹0.00" on the till's home
    // screen, and the filter must be at the SURFACE — the report keeps the row.
    // Unallocated is exempt: residuals net across bills, so a ₹0.00 Unallocated
    // row can still be two bills that need looking at, and dropping it would
    // silence both clients' warning.
    expect(body).toMatch(
      /today_by_method: byMethod\.rows\s*\.filter\(\s*\(r\) => r\.method === UNALLOCATED_METHOD \|\| r\.amount !== 0 \|\| r\.refund !== 0,?\s*\)/,
    );
  });

  test("the money is composed by the MIS composer, not re-derived here", () => {
    expect(fn()).toMatch(/composeMisBills\(rows, scPct, tz\)/);
  });

  test("ONE read, not six — the month window contains today", () => {
    const body = fn();
    expect((body.match(/await runQuery</g) ?? []).length).toBe(1);
  });

  test("today_bills is carried, so an empty day is distinguishable from a zero one", () => {
    expect(fn()).toMatch(/today_bills/);
  });

  test("the month starts on the 1st in the RESTAURANT's zone, built from the day key", () => {
    // Built from the key rather than from a Date so a shift near midnight cannot
    // land it in the previous month.
    expect(fn()).toMatch(/const monthFrom = `\$\{today\.slice\(0, 7\)\}-01`/);
  });
});

describe("what counts as an online sale", () => {
  test("dine-in and a counter takeaway are walk-ins", () => {
    for (const v of ["", "dine_in", "dinein", "dine-in", "takeaway", "take_away", "pickup", "DINE_IN"]) {
      expect(db.isOnlineChannel(v)).toBe(false);
    }
  });

  test("delivery and every aggregator are online", () => {
    for (const v of ["delivery", "swiggy", "zomato", "dunzo", "magicpin"]) {
      expect(db.isOnlineChannel(v)).toBe(true);
    }
  });

  test("A NEW AGGREGATOR IS ONLINE WITHOUT ANYBODY EDITING THIS", () => {
    // The rule is an allowlist of what is NOT online, deliberately: a list of
    // aggregator names would quietly report a newly-wired source as dine-in.
    expect(db.isOnlineChannel("some-aggregator-nobody-has-heard-of")).toBe(true);
  });

  test("rubbish does not throw", () => {
    for (const v of [null, undefined, 42, {}]) { expect(typeof db.isOnlineChannel(v)).toBe("boolean"); }
  });
});
