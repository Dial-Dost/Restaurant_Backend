// The Overview "needs attention" stock rows, now that bucketing happens in
// TypeScript against the one unit-aware rule instead of a `"Quantity" <= 5`
// predicate in SQL.
//
// buildNeedsAttention is a pure function over rows, so this exercises the real
// feed the owner reads without a database.

// buildNeedsAttention is pure, but it lives in database_supabase.ts, which opens
// a pg Pool at import time. Only `pg` is faked; the code under test is the
// shipped feed builder, not a copy of it.
import { describe, test, expect, beforeAll, jest } from "@jest/globals";

jest.mock("pg", () => {
  class FakePool {
    on(): this { return this; }
    query(): Promise<never> {
      return Promise.reject(new Error("inventory_attention: no test here may touch the database"));
    }
    connect(): Promise<never> {
      return Promise.reject(new Error("inventory_attention: pool.connect() is not stubbed"));
    }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

type Db = typeof import("../database_supabase");
type AttentionSources = import("../database_supabase").AttentionSources;
type AttentionStockRow = import("../database_supabase").AttentionStockRow;
let db: Db;

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
});

const EMPTY: AttentionSources = { stock: [], discounts: [], bills: [], orders: [], slow_movers: [] };

/** One "Inventory" row as the stock query hands it over. */
const row = (
  name: string,
  qty: number,
  unit: string,
  opts: { reorder?: number; reorderUnit?: string; days?: number | null } = {},
): AttentionStockRow => ({
  barcode: `bc-${name.replace(/\s+/g, "-")}`,
  name,
  description: JSON.stringify({
    category: "General",
    unit,
    ...(opts.reorder === undefined ? {} : { reorder_level: opts.reorder, reorder_unit: opts.reorderUnit ?? unit }),
  }),
  qty,
  days_to_expiry: opts.days ?? null,
});

const feed = (stock: AttentionStockRow[]) => db.buildNeedsAttention({ ...EMPTY, stock });
const lowRow = (stock: AttentionStockRow[]) => feed(stock).find((r) => r.key === "low_stock");

describe("the concerns feed stops ignoring units", () => {
  test("5000 mg of potato is named as low; 5 kg of onion is not named at all", () => {
    const low = lowRow([row("Potato", 5000, "mg"), row("Onion", 5, "kg")]);
    expect(low).toBeDefined();
    expect(low!.count).toBe(1);
    expect(low!.items.map((i) => i.label)).toEqual(["Potato"]);
  });

  test("a well-stocked shelf produces NO low-stock row at all", () => {
    // The feed must not start screaming about items that are fine. Under the old
    // `"Quantity" <= 5` predicate every one of these kg/litre rows was "low".
    const row_ = lowRow([
      row("Onion", 5, "kg"),
      row("Refined oil", 4, "litre"),
      row("Paneer", 3, "kg"),
      row("Gas cylinders", 4, "nos", { reorder: 2 }),
    ]);
    expect(row_).toBeUndefined();
  });

  test("the count and the named offenders come from the same set", () => {
    const low = lowRow([
      row("A", 100, "g"),
      row("B", 200, "g"),
      row("C", 300, "g"),
      row("D", 400, "g"),
      row("E", 500, "g"),
      row("F", 50, "kg"),
    ]);
    expect(low!.count).toBe(5);           // A..E are low, F is not
    expect(low!.items).toHaveLength(4);   // ATTENTION_ITEM_CAP
    expect(low!.items.map((i) => i.label)).not.toContain("F");
  });

  test("offenders are ranked by how far below their OWN level they are, not by raw quantity", () => {
    // 5000 mg (5 g of a 1 kg level) is far more urgent than 0.9 kg (900 g of the
    // same level), even though 5000 > 0.9. Sorting by the bare number is the
    // original bug wearing a different hat.
    const low = lowRow([row("Nearly fine", 0.9, "kg"), row("Effectively gone", 5000, "mg")]);
    expect(low!.items.map((i) => i.label)).toEqual(["Effectively gone", "Nearly fine"]);
  });

  test("an item's own reorder level drives the feed, in both directions", () => {
    const promoted = lowRow([row("Saffron", 8, "kg", { reorder: 10 })]);
    expect(promoted!.items.map((i) => i.label)).toEqual(["Saffron"]);

    const demoted = lowRow([row("Yeast", 0.4, "kg", { reorder: 0.2 })]);
    expect(demoted).toBeUndefined();
  });

  test("an unclassifiable unit behaves exactly as it did before", () => {
    expect(lowRow([row("Curry leaves", 40, "handful")])).toBeUndefined();
    expect(lowRow([row("Curry leaves", 4, "handful")])!.count).toBe(1);
  });

  test("out of stock still lands in the low row, worded as out of stock", () => {
    const low = lowRow([row("Butter", 0, "kg")]);
    expect(low!.items[0]!.sub).toContain("out of stock");
  });
});

describe("bucket precedence survives the move out of SQL", () => {
  test("already-expired beats low: an expired near-empty item is NOT filed as low", () => {
    const rows = feed([row("Curd", 0.1, "kg", { days: -3 })]);
    expect(rows.find((r) => r.key === "low_stock")).toBeUndefined();
    const expired = rows.find((r) => r.key === "expired_stock");
    expect(expired!.count).toBe(1);
    expect(expired!.items[0]!.sub).toContain("expired 3 days ago");
  });

  test("low beats expiring-soon: restocking resolves both, so it is reported once", () => {
    const rows = feed([row("Cream", 0.2, "litre", { days: 3 })]);
    expect(rows.find((r) => r.key === "expiring_stock")).toBeUndefined();
    const low = rows.find((r) => r.key === "low_stock");
    expect(low!.count).toBe(1);
    expect(low!.items[0]!.sub).toContain("expires in 3 days");
  });

  test("a well-stocked item expiring soon is reported as expiring, not as low", () => {
    const rows = feed([row("Milk", 20, "litre", { days: 2 })]);
    expect(rows.find((r) => r.key === "low_stock")).toBeUndefined();
    expect(rows.find((r) => r.key === "expiring_stock")!.count).toBe(1);
  });

  test("a well-stocked item expiring beyond the window is reported nowhere", () => {
    expect(feed([row("Rice", 40, "kg", { days: 90 })])).toEqual([]);
  });

  test("the three buckets stay disjoint over a mixed shelf", () => {
    const rows = feed([
      row("Expired curd", 0.1, "kg", { days: -1 }),
      row("Low cream", 0.2, "litre", { days: 3 }),
      row("Expiring milk", 20, "litre", { days: 2 }),
      row("Fine rice", 40, "kg"),
    ]);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.count]));
    expect(byKey.expired_stock).toBe(1);
    expect(byKey.low_stock).toBe(1);
    expect(byKey.expiring_stock).toBe(1);
  });
});

describe("rows the query now hands over but the feed must ignore", () => {
  test("the whole tenant shelf can be passed in and only the real problems surface", () => {
    // The stock query no longer filters — it hands over every row — so the feed
    // has to be the thing that stays quiet.
    const shelf = [
      row("Onion", 25, "kg"),
      row("Potato", 30, "kg"),
      row("Oil", 15, "litre"),
      row("Paneer", 4, "kg"),
      row("Masala box", 12, "box"),
      row("Soda", 48, "bottles"),
      row("Saffron", 20, "g", { reorder: 5, reorderUnit: "g" }),
    ];
    expect(feed(shelf)).toEqual([]);
  });

  test("a malformed description degrades to the legacy rule instead of throwing", () => {
    const broken: AttentionStockRow = { barcode: "bc-x", name: "Mystery", description: "not json", qty: 4, days_to_expiry: null };
    const low = lowRow([broken]);
    // description unparseable -> unit falls back to "pcs" (count, default 5).
    expect(low!.count).toBe(1);
    expect(lowRow([{ ...broken, qty: 40 }])).toBeUndefined();
  });
});
