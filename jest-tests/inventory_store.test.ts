// The inventory READ/WRITE path end to end: GetInventoryItems,
// UpsertInventoryItem and SetInventoryReorderLevel, driven over a fake `pg`
// Pool that models the one table they touch.
//
// WHY A FIXTURE AND NOT PURE FUNCTIONS. The riskiest behaviour in this change is
// not the arithmetic (inventory_units.test.ts covers that) — it is PRESERVE ON
// OMIT. `Inventory.description` is a single JSON blob carrying category, unit
// and the reorder level, and UpsertInventoryItem replaces it wholesale. Every
// client built before the reorder field existed posts without it, so a naive
// upsert silently wipes a level the owner set. That is the same failure mode as
// the full-menu replace that once erased 56 items' images and recipes, and a
// test that re-implemented the merge in TypeScript would only prove the copy
// agrees with itself. This drives the shipped code over a stubbed Pool.
//
// WHAT IT MODELS: the "Inventory" upsert key (barcode, res_id, outlet_id), the
// ON CONFLICT DO UPDATE column list (name, description, "Quantity" — note it
// does NOT touch expiry_date), and the description-only UPDATE.
// WHAT IT DOES NOT MODEL: RLS, concurrency, numeric precision limits.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";

const RES_ID = "11111111-1111-4111-8111-111111111111";
const OUTLET_ID = "22222222-2222-4222-8222-222222222222";
const SLUG = "fixture-kitchen";

interface StoredRow { barcode: string; name: string; description: string | null; quantity: number; expiry_date: unknown }

/** The one table under test. Reset between tests. */
const table = new Map<string, StoredRow>();

/** Every statement the fake Pool was asked to run, for asserting write shape. */
let statements: { sql: string; params: unknown[] }[] = [];

const norm = (sql: string): string => sql.replace(/\s+/g, " ").trim();

function dispatch(sql: string, params: unknown[]): { rows: unknown[] } {
  const q = norm(sql);
  statements.push({ sql: q, params });

  // Lazy DDL guard — a no-op here.
  if (/^alter table/i.test(q)) {return { rows: [] };}

  // resolveRestaurantContext (default first-outlet branch).
  if (q.includes('from "Restaurant" r')) {
    return {
      rows: [{
        res_id: RES_ID,
        outlet_id: OUTLET_ID,
        restaurant_slug: SLUG,
        restaurant_name: "Fixture Kitchen",
        restaurant_main_office_add: null,
        restaurant_logo_url: null,
        timezone: "Asia/Kolkata",
      }],
    };
  }

  // GetInventoryItems list read.
  if (q.startsWith("select barcode, name, description")) {
    return { rows: [...table.values()].map((r) => ({ ...r })) };
  }

  // The merge read in UpsertInventoryItem / SetInventoryReorderLevel.
  if (q.startsWith('select description from "Inventory"')) {
    const row = table.get(String(params[2]));
    return { rows: row ? [{ description: row.description }] : [] };
  }

  // The upsert.
  if (q.startsWith('insert into "Inventory"')) {
    const [barcode, name, resId, outletId, description, quantity] = params as [string, string, string, string, string, number];
    expect(resId).toBe(RES_ID);
    expect(outletId).toBe(OUTLET_ID);
    const existing = table.get(barcode);
    table.set(barcode, {
      barcode,
      name,
      description,
      quantity: Number(quantity),
      // ON CONFLICT DO UPDATE lists name/description/"Quantity" only, so an
      // existing expiry survives an upsert. Modelled, because a test that let
      // the upsert clear it would hide a real regression.
      expiry_date: existing?.expiry_date ?? null,
    });
    return { rows: [] };
  }

  // The description-only update (SetInventoryReorderLevel).
  if (q.startsWith('update "Inventory" set description')) {
    const barcode = String(params[2]);
    const row = table.get(barcode);
    if (row) {row.description = String(params[3]);}
    return { rows: [] };
  }

  throw new Error(`inventory_store fixture: unstubbed SQL -> ${q.slice(0, 120)}`);
}

jest.mock("pg", () => {
  class FakePool {
    on(): this { return this; }
    query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
      return Promise.resolve(dispatch(sql, params));
    }
    connect(): Promise<never> {
      return Promise.reject(new Error("inventory_store: pool.connect() is not stubbed"));
    }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

type Db = typeof import("../database_supabase");
let db: Db;

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
});

beforeEach(() => {
  table.clear();
  statements = [];
});

/** Seed a row exactly as the database holds it. */
const seed = (barcode: string, name: string, quantity: number, description: unknown): void => {
  table.set(barcode, {
    barcode,
    name,
    description: typeof description === "string" ? description : JSON.stringify(description),
    quantity,
    expiry_date: null,
  });
};

const oneItem = async () => (await db.GetInventoryItems(SLUG))[0]!;

// ---------------------------------------------------------------------------

describe("the reported case, read through the real list endpoint", () => {
  test("5000 mg -> Low, 50 g -> Low, 5 kg -> In Stock, all from one read", async () => {
    seed("a", "Potato (mg)", 5000, { category: "Veg", unit: "mg" });
    seed("b", "Potato (g)", 50, { category: "Veg", unit: "g" });
    seed("c", "Potato (kg)", 5, { category: "Veg", unit: "kg" });

    const items = await db.GetInventoryItems(SLUG);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId.a!.status).toBe("Low Stock");
    expect(byId.b!.status).toBe("Low Stock");
    expect(byId.c!.status).toBe("In Stock");
  });

  test("each row explains itself: the threshold it was judged against, in its own unit", async () => {
    seed("a", "Potato", 5000, { category: "Veg", unit: "mg" });
    const item = await oneItem();
    expect(item.reorder_applied).toBe(1000000);   // 1 kg expressed in mg
    expect(item.reorder_basis).toBe("dimension-default");
    expect(item.reorder_level).toBeNull();
    expect(item.unit).toBe("mg");
  });

  test("a legacy two-key blob (category + unit only) still reads", async () => {
    // Exactly what every existing production row holds today.
    seed("a", "Onion", 40, { category: "Veg", unit: "kg" });
    const item = await oneItem();
    expect(item.status).toBe("In Stock");
    expect(item.reorder_level).toBeNull();
    expect(item.reorder_unit).toBeNull();
  });

  test("an unparseable description degrades instead of throwing", async () => {
    seed("a", "Mystery", 4, "definitely not json");
    const item = await oneItem();
    expect(item.unit).toBe("pcs");
    expect(item.status).toBe("Low Stock");
  });
});

describe("fractional stock survives the round trip", () => {
  test("2.5 kg reads back as 2.5, not 3", async () => {
    seed("a", "Paneer", 2.5, { category: "Dairy", unit: "kg" });
    expect((await oneItem()).stock).toBe(2.5);
  });

  test("0.4 kg is Low Stock, NOT Out of Stock", async () => {
    // Rounding on read turned 0.4 into 0, i.e. into "Out of Stock" — a lie about
    // stock that is really there. Survivable while everything was whole pieces;
    // not survivable once a kg item's whole working range is fractional.
    seed("a", "Saffron", 0.4, { category: "Spice", unit: "kg" });
    const item = await oneItem();
    expect(item.stock).toBe(0.4);
    expect(item.status).toBe("Low Stock");
  });

  test("a fractional quantity is written as typed, not rounded", async () => {
    await db.UpsertInventoryItem(SLUG, { name: "Cream", stock: 2.5, unit: "litre", category: "Dairy" });
    expect([...table.values()][0]!.quantity).toBe(2.5);
  });

  test("a negative quantity is still clamped to zero on write", async () => {
    await db.UpsertInventoryItem(SLUG, { name: "Odd", stock: -5, unit: "kg" });
    expect([...table.values()][0]!.quantity).toBe(0);
  });
});

describe("PRESERVE ON OMIT — an old client must not wipe a reorder level", () => {
  test("an upsert that sends no reorder_level keeps the stored one", async () => {
    seed("bc-1", "Potato", 20, { category: "Veg", unit: "kg", reorder_level: 8, reorder_unit: "kg" });

    // Exactly the payload a client built before this field existed sends.
    await db.UpsertInventoryItem(SLUG, { id: "bc-1", name: "Potato", stock: 20, unit: "kg", category: "Veg" });

    const item = await oneItem();
    expect(item.reorder_level).toBe(8);
    expect(item.reorder_unit).toBe("kg");
    expect(item.reorder_basis).toBe("item");
  });

  test("an explicit null CLEARS it — omitted and null are different requests", async () => {
    seed("bc-1", "Potato", 20, { category: "Veg", unit: "kg", reorder_level: 8, reorder_unit: "kg" });
    await db.UpsertInventoryItem(SLUG, { id: "bc-1", name: "Potato", stock: 20, unit: "kg", reorder_level: null });
    const item = await oneItem();
    expect(item.reorder_level).toBeNull();
    expect(item.reorder_basis).toBe("dimension-default");
  });

  test("a number SETS it", async () => {
    seed("bc-1", "Potato", 20, { category: "Veg", unit: "kg" });
    await db.UpsertInventoryItem(SLUG, { id: "bc-1", name: "Potato", stock: 20, unit: "kg", reorder_level: 25 });
    const item = await oneItem();
    expect(item.reorder_level).toBe(25);
    expect(item.status).toBe("Low Stock");   // 20 kg against a 25 kg level
  });

  test("an omitted category and unit also survive rather than reverting to defaults", async () => {
    seed("bc-1", "Refined oil", 20, { category: "Grocery", unit: "litre", reorder_level: 4, reorder_unit: "litre" });
    await db.UpsertInventoryItem(SLUG, { id: "bc-1", name: "Refined oil", stock: 18 });
    const item = await oneItem();
    expect(item.unit).toBe("litre");
    expect(item.category).toBe("Grocery");
    expect(item.reorder_level).toBe(4);
    expect(item.stock).toBe(18);
  });

  test("a brand-new item (no id) does not read anything first", async () => {
    await db.UpsertInventoryItem(SLUG, { name: "New thing", stock: 3, unit: "kg" });
    const reads = statements.filter((s) => s.sql.startsWith('select description from "Inventory"'));
    expect(reads).toHaveLength(0);
  });

  test("an item without a level round-trips to the same two-key blob as before", async () => {
    await db.UpsertInventoryItem(SLUG, { name: "Onion", stock: 30, unit: "kg", category: "Veg" });
    const stored = JSON.parse([...table.values()][0]!.description!) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["category", "unit"]);
  });
});

describe("SetInventoryReorderLevel changes the threshold and NOTHING else", () => {
  test("the quantity is never written", async () => {
    seed("bc-1", "Potato", 20, { category: "Veg", unit: "kg" });
    await db.SetInventoryReorderLevel(SLUG, "bc-1", 25);
    expect(table.get("bc-1")!.quantity).toBe(20);
    // The one write is a description-only UPDATE; no insert/upsert is issued,
    // so a stock movement that landed while the dialog was open cannot be
    // stamped over by a stale form value.
    expect(statements.some((s) => s.sql.startsWith('insert into "Inventory"'))).toBe(false);
    expect(statements.filter((s) => s.sql.startsWith('update "Inventory" set description'))).toHaveLength(1);
  });

  test("it flips the badge in both directions", async () => {
    seed("bc-1", "Potato", 20, { category: "Veg", unit: "kg" });
    expect((await oneItem()).status).toBe("In Stock");
    await db.SetInventoryReorderLevel(SLUG, "bc-1", 25);
    expect((await oneItem()).status).toBe("Low Stock");
    await db.SetInventoryReorderLevel(SLUG, "bc-1", null);
    expect((await oneItem()).status).toBe("In Stock");
  });

  test("the level defaults to the item's own unit", async () => {
    seed("bc-1", "Potato", 20, { category: "Veg", unit: "kg" });
    const r = await db.SetInventoryReorderLevel(SLUG, "bc-1", 5);
    expect(r).toEqual({ success: true, reorder_level: 5, reorder_unit: "kg" });
  });

  test("a level in another unit of the SAME dimension is accepted and converted on read", async () => {
    seed("bc-1", "Potato", 1500, { category: "Veg", unit: "g" });
    await db.SetInventoryReorderLevel(SLUG, "bc-1", 2, "kg");
    const item = await oneItem();
    expect(item.reorder_level).toBe(2);
    expect(item.reorder_unit).toBe("kg");
    expect(item.reorder_applied).toBe(2000);   // in the item's own unit
    expect(item.status).toBe("Low Stock");
  });

  test("a level in another DIMENSION is refused loudly, not stored to be ignored", async () => {
    seed("bc-1", "Potato", 5, { category: "Veg", unit: "kg" });
    await expect(db.SetInventoryReorderLevel(SLUG, "bc-1", 2, "litre")).rejects.toThrow(/cannot be compared/i);
    // Nothing was written.
    expect(statements.some((s) => s.sql.startsWith('update "Inventory" set description'))).toBe(false);
    expect((await oneItem()).reorder_level).toBeNull();
  });

  test("a zero or negative level is rejected rather than silently dropped", async () => {
    seed("bc-1", "Potato", 5, { category: "Veg", unit: "kg" });
    await expect(db.SetInventoryReorderLevel(SLUG, "bc-1", 0)).rejects.toThrow(/positive number/i);
    await expect(db.SetInventoryReorderLevel(SLUG, "bc-1", -3)).rejects.toThrow(/positive number/i);
  });

  test("an unknown item is an error, not a silent no-op", async () => {
    await expect(db.SetInventoryReorderLevel(SLUG, "nope", 5)).rejects.toThrow(/not found/i);
  });

  test("it leaves the unit and category alone", async () => {
    seed("bc-1", "Potato", 20, { category: "Veg", unit: "kg" });
    await db.SetInventoryReorderLevel(SLUG, "bc-1", 5);
    const item = await oneItem();
    expect(item.unit).toBe("kg");
    expect(item.category).toBe("Veg");
  });
});
