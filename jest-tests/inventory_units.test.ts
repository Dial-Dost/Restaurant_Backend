// Unit-aware inventory stock status — the rule that replaced a bare
// `if (stock < 10) return "Low Stock"`.
//
// Pure module, so this suite needs no tenant, no pool and no fixtures.

import {
  computeStockStatus,
  convertQuantity,
  inventoryStatusOf,
  parseUnit,
  sanitizeReorderLevel,
  toBaseQuantity,
  DEFAULT_REORDER_BASE,
  LEGACY_LOW_STOCK_THRESHOLD,
} from "../inventory_units";

// ---------------------------------------------------------------------------
// The bug as the owner reported it, verbatim.
// ---------------------------------------------------------------------------

describe('the owner\'s report: "5000 mg of potato reads In Stock even though it is only 5 grams; 50 g also reads In Stock because the number is high"', () => {
  test("5000 mg of potato is five grams, and reads Low Stock", () => {
    expect(inventoryStatusOf(5000, "mg")).toBe("Low Stock");
  });

  test("50 g of potato reads Low Stock — the number is high, the quantity is not", () => {
    expect(inventoryStatusOf(50, "g")).toBe("Low Stock");
  });

  test("5 kg of potato is a genuinely stocked item and stays In Stock", () => {
    expect(inventoryStatusOf(5, "kg")).toBe("In Stock");
  });

  test("the three verdicts come from ONE rule, differing only by unit", () => {
    // Same rule, same default, three different units: the whole defect was that
    // the number alone decided. Under the old rule these were In / In / Low.
    expect([
      inventoryStatusOf(5000, "mg"),
      inventoryStatusOf(50, "g"),
      inventoryStatusOf(5, "kg"),
    ]).toEqual(["Low Stock", "Low Stock", "In Stock"]);
  });

  test("the old rule really did get all three wrong (regression anchor)", () => {
    const legacy = (stock: number) => (stock <= 0 ? "Out of Stock" : stock < 10 ? "Low Stock" : "In Stock");
    expect(legacy(5000)).toBe("In Stock");   // wrong: 5 g
    expect(legacy(50)).toBe("In Stock");     // wrong: 50 g
    expect(legacy(5)).toBe("Low Stock");     // wrong: 5 kg
  });
});

// ---------------------------------------------------------------------------
// Out of Stock
// ---------------------------------------------------------------------------

describe("Out of Stock is quantity <= 0, whatever the unit", () => {
  test.each([
    ["kg", 0],
    ["mg", 0],
    ["litre", 0],
    ["pcs", 0],
    ["handful", 0],
    ["", 0],
  ])("0 %s is Out of Stock", (unit, qty) => {
    expect(inventoryStatusOf(qty, unit)).toBe("Out of Stock");
  });

  test("a negative quantity is Out of Stock, not Low", () => {
    expect(inventoryStatusOf(-3, "kg")).toBe("Out of Stock");
  });

  test("junk quantities are treated as zero rather than throwing", () => {
    expect(inventoryStatusOf(Number.NaN, "kg")).toBe("Out of Stock");
    expect(inventoryStatusOf(null, "kg")).toBe("Out of Stock");
    expect(inventoryStatusOf("not a number", "kg")).toBe("Out of Stock");
  });
});

// ---------------------------------------------------------------------------
// Unknown units degrade to yesterday's behaviour, exactly
// ---------------------------------------------------------------------------

describe("an unclassifiable unit degrades to the legacy rule and nothing else", () => {
  const legacy = (stock: number) => (stock <= 0 ? "Out of Stock" : stock < 10 ? "Low Stock" : "In Stock");

  test.each([0, 0.5, 1, 5, 9, 9.999, 10, 10.001, 50, 5000])(
    "%p of a 'handful' matches the pre-change verdict",
    (qty) => {
      expect(inventoryStatusOf(qty, "handful")).toBe(legacy(qty));
    },
  );

  test("the strict `< 10` boundary is preserved — exactly 10 is NOT low", () => {
    // The rule this replaces used `<`, so 10 read In Stock. Switching to `<=`
    // here would turn a currently-green item red for every tenant with an
    // unrecognised unit, which is the one thing this fallback exists to prevent.
    expect(inventoryStatusOf(10, "handful")).toBe("In Stock");
    expect(inventoryStatusOf(9.999, "handful")).toBe("Low Stock");
    expect(computeStockStatus(10, "handful").threshold).toBe(LEGACY_LOW_STOCK_THRESHOLD);
    expect(computeStockStatus(10, "handful").basis).toBe("legacy");
  });

  test("a blank unit is unknown, not a silent default", () => {
    expect(computeStockStatus(20, "").dimension).toBe("unknown");
    expect(computeStockStatus(20, "").basis).toBe("legacy");
    expect(computeStockStatus(20, null).basis).toBe("legacy");
  });

  test("a tenant on unknown units does not wake up to a wall of red", () => {
    const shelf = [40, 25, 12, 60, 200, 15];
    const reds = shelf.filter((q) => inventoryStatusOf(q, "handful") !== "In Stock");
    expect(reds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Per-item reorder level overrides the default, in both directions
// ---------------------------------------------------------------------------

describe("a per-item reorder level overrides the per-dimension default", () => {
  test("upwards: 8 kg is In Stock by default, Low when the owner reorders below 10 kg", () => {
    expect(inventoryStatusOf(8, "kg")).toBe("In Stock");
    expect(inventoryStatusOf(8, "kg", { value: 10 })).toBe("Low Stock");
  });

  test("downwards: 0.5 kg is Low by default, In Stock when the owner reorders below 0.25 kg", () => {
    expect(inventoryStatusOf(0.5, "kg")).toBe("Low Stock");
    expect(inventoryStatusOf(0.5, "kg", { value: 0.25 })).toBe("In Stock");
  });

  test("the level is read in the item's own unit when no unit is given", () => {
    // "reorder potatoes below 5 kg" — not "below 5000 g". The form asks in the
    // item's unit, so an absent reorder unit means the item's unit.
    const r = computeStockStatus(4, "kg", { value: 5 });
    expect(r.status).toBe("Low Stock");
    expect(r.threshold).toBe(5);
    expect(r.basis).toBe("item");
  });

  test("a level in a DIFFERENT unit of the same dimension is converted, not ignored", () => {
    // Item held in grams, level typed as 2 kg -> 2000 g.
    const r = computeStockStatus(1500, "g", { value: 2, unit: "kg" });
    expect(r.threshold).toBe(2000);
    expect(r.status).toBe("Low Stock");
    expect(inventoryStatusOf(2500, "g", { value: 2, unit: "kg" })).toBe("In Stock");
  });

  test("at exactly the reorder level the item IS low (a reorder point is inclusive)", () => {
    expect(inventoryStatusOf(5, "kg", { value: 5 })).toBe("Low Stock");
    expect(inventoryStatusOf(5.0001, "kg", { value: 5 })).toBe("In Stock");
  });

  test("a level survives an exact decimal boundary across a fractional factor", () => {
    // 1000 mg vs a 1 g level: 1000 * 0.001 is not exactly 1 in binary floating
    // point, and without the epsilon this flips to In Stock.
    expect(inventoryStatusOf(1000, "mg", { value: 1, unit: "g" })).toBe("Low Stock");
  });

  test("a level on an unclassifiable unit still applies when the units match", () => {
    // "3 handfuls" against "5 handfuls" is a sound comparison: the unit cancels.
    // Refusing it would throw away something the owner set deliberately.
    expect(inventoryStatusOf(2, "handful", { value: 3 })).toBe("Low Stock");
    expect(inventoryStatusOf(4, "handful", { value: 3 })).toBe("In Stock");
    expect(computeStockStatus(4, "handful", { value: 3 }).basis).toBe("item");
  });

  test("a zero or negative level is treated as unset, not as 'never low'", () => {
    expect(computeStockStatus(0.5, "kg", { value: 0 }).basis).toBe("dimension-default");
    expect(computeStockStatus(0.5, "kg", { value: -5 }).basis).toBe("dimension-default");
    expect(inventoryStatusOf(0.5, "kg", { value: 0 })).toBe("Low Stock");
  });
});

// ---------------------------------------------------------------------------
// The mixed-dimension guard
// ---------------------------------------------------------------------------

describe("mass, volume and count are never compared with each other", () => {
  test("convertQuantity refuses a cross-dimension conversion", () => {
    expect(convertQuantity(1, "kg", "litre")).toEqual({ ok: false, reason: "dimension-mismatch" });
    expect(convertQuantity(1, "ml", "g")).toEqual({ ok: false, reason: "dimension-mismatch" });
    expect(convertQuantity(1, "pcs", "kg")).toEqual({ ok: false, reason: "dimension-mismatch" });
  });

  test("convertQuantity refuses when either side is unclassifiable", () => {
    expect(convertQuantity(1, "handful", "kg")).toEqual({ ok: false, reason: "unknown-unit" });
    expect(convertQuantity(1, "kg", "handful")).toEqual({ ok: false, reason: "unknown-unit" });
  });

  test("identical units always convert, even unknown ones", () => {
    expect(convertQuantity(3, "handful", "handful")).toEqual({ ok: true, value: 3 });
    expect(convertQuantity(3, "Handfuls.", "handfuls")).toEqual({ ok: true, value: 3 });
  });

  test("a reorder level in litres against stock in kg is DISCARDED, not coerced", () => {
    // The owner changed the item's unit after setting the level. Comparing 5 kg
    // against 2 litres is a category error; falling back to the mass default is
    // the only honest answer.
    const r = computeStockStatus(5, "kg", { value: 2, unit: "litre" });
    expect(r.basis).toBe("dimension-default");
    expect(r.threshold).toBe(1);
    expect(r.status).toBe("In Stock");
  });

  test("the discarded level does not leak into the verdict either way", () => {
    // 0.5 kg is low on the mass default no matter what the stale litre level said.
    expect(inventoryStatusOf(0.5, "kg", { value: 2, unit: "litre" })).toBe("Low Stock");
    expect(inventoryStatusOf(0.5, "kg", { value: 0.1, unit: "litre" })).toBe("Low Stock");
  });
});

// ---------------------------------------------------------------------------
// Free-text unit parsing
// ---------------------------------------------------------------------------

describe("free-text unit parsing", () => {
  test.each([
    ["mg", "mass", 0.001],
    ["MG", "mass", 0.001],
    ["g", "mass", 1],
    ["gm", "mass", 1],
    ["gms", "mass", 1],
    ["gram", "mass", 1],
    ["Grams", "mass", 1],
    ["kg", "mass", 1000],
    ["Kg", "mass", 1000],
    ["KG", "mass", 1000],
    ["kgs", "mass", 1000],
    ["kilo", "mass", 1000],
    ["kilogram", "mass", 1000],
    ["kilograms", "mass", 1000],
    ["lb", "mass", 453.59237],
    ["pound", "mass", 453.59237],
    ["pounds", "mass", 453.59237],
    ["oz", "mass", 28.349523125],
    ["ounces", "mass", 28.349523125],
    ["ml", "volume", 1],
    ["millilitre", "volume", 1],
    ["cl", "volume", 10],
    ["l", "volume", 1000],
    ["L", "volume", 1000],
    ["ltr", "volume", 1000],
    ["litre", "volume", 1000],
    ["litres", "volume", 1000],
    ["liter", "volume", 1000],
    ["pcs", "count", 1],
    ["pc", "count", 1],
    ["piece", "count", 1],
    ["pieces", "count", 1],
    ["nos", "count", 1],
    ["no", "count", 1],
    ["unit", "count", 1],
    ["units", "count", 1],
    ["each", "count", 1],
    ["dozen", "count", 12],
    ["pack", "count", 1],
    ["packet", "count", 1],
    ["packets", "count", 1],
    ["box", "count", 1],
    ["boxes", "count", 1],
    ["tin", "count", 1],
    ["can", "count", 1],
    ["bottle", "count", 1],
    ["bottles", "count", 1],
    ["tray", "count", 1],
    ["bag", "count", 1],
  ])("%s parses as %s x%p", (raw, dimension, factor) => {
    const parsed = parseUnit(raw);
    expect(parsed.dimension).toBe(dimension);
    expect(parsed.factorToBase).toBe(factor);
  });

  test("trims, tolerates a trailing period and surrounding whitespace", () => {
    expect(parseUnit("  Kg. ").dimension).toBe("mass");
    expect(parseUnit("kg.").factorToBase).toBe(1000);
    expect(parseUnit("  LTR  ").factorToBase).toBe(1000);
  });

  test.each(["handful", "pinch", "sachet-ish", "??", "", "   ", "1234"])(
    "%p is UNKNOWN rather than guessed",
    (raw) => {
      expect(parseUnit(raw).dimension).toBe("unknown");
      expect(parseUnit(raw).factorToBase).toBe(1);
    },
  );

  test("a dozen is twelve of something countable", () => {
    expect(toBaseQuantity(2, "dozen")).toBe(24);
    expect(inventoryStatusOf(1, "dozen")).toBe("In Stock"); // 12 each vs a 5-each default
  });

  test("toBaseQuantity refuses to invent a base for an unknown unit", () => {
    expect(toBaseQuantity(5, "handful")).toBeNull();
    expect(toBaseQuantity(5, "kg")).toBe(5000);
    expect(toBaseQuantity(5000, "mg")).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe("per-dimension defaults", () => {
  test("the defaults are the documented ones, in base units", () => {
    expect(DEFAULT_REORDER_BASE).toEqual({ mass: 1000, volume: 1000, count: 5 });
  });

  test("the default is expressed back into the item's own unit", () => {
    expect(computeStockStatus(1, "kg").threshold).toBe(1);
    expect(computeStockStatus(1, "g").threshold).toBe(1000);
    expect(computeStockStatus(1, "mg").threshold).toBe(1000000);
    expect(computeStockStatus(1, "litre").threshold).toBe(1);
    expect(computeStockStatus(1, "ml").threshold).toBe(1000);
    expect(computeStockStatus(1, "pcs").threshold).toBe(5);
  });

  test("the count default does not paint a normal count shelf red", () => {
    // 5, not the legacy 10: count items are the ones a kitchen stocks in small
    // numbers, and a default of 10 leaves them permanently amber.
    const shelf = [
      { name: "gas cylinders", qty: 8 },
      { name: "chafing trays", qty: 6 },
      { name: "soda bottles", qty: 24 },
    ];
    expect(shelf.filter((i) => inventoryStatusOf(i.qty, "pcs") !== "In Stock")).toEqual([]);
    expect(inventoryStatusOf(5, "pcs")).toBe("Low Stock");
    expect(inventoryStatusOf(4, "nos")).toBe("Low Stock");
  });

  test("moving count from 10 to 5 can only ever REMOVE a red badge", () => {
    // Nothing that was In Stock under the legacy rule becomes Low under the new
    // count default, for any quantity.
    for (const qty of [0.5, 1, 3, 5, 6, 7, 9, 9.5, 10, 11, 40]) {
      const wasLow = qty > 0 && qty < 10;
      const isLow = inventoryStatusOf(qty, "pcs") === "Low Stock";
      if (isLow) { expect(wasLow).toBe(true); }
    }
  });

  test("volume mirrors mass so the two read consistently", () => {
    expect(inventoryStatusOf(500, "ml")).toBe("Low Stock");
    expect(inventoryStatusOf(5, "litre")).toBe("In Stock");
    expect(inventoryStatusOf(0.5, "litre")).toBe("Low Stock");
  });
});

// ---------------------------------------------------------------------------
// Ranking across units
// ---------------------------------------------------------------------------

describe("ratio ranks a mixed-unit shelf by urgency", () => {
  test("5000 mg is more urgent than 3 kg even though 5000 > 3", () => {
    const almostGone = computeStockStatus(5000, "mg");   // 5 g of a 1 kg level
    const gettingLow = computeStockStatus(0.9, "kg");    // 900 g of a 1 kg level
    expect(almostGone.ratio).toBeLessThan(gettingLow.ratio);
  });

  test("out of stock ranks first, and a healthy item ranks above 1", () => {
    expect(computeStockStatus(0, "kg").ratio).toBe(0);
    expect(computeStockStatus(5, "kg").ratio).toBe(5);
    expect(computeStockStatus(1, "kg").ratio).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Storage sanitiser
// ---------------------------------------------------------------------------

describe("sanitizeReorderLevel", () => {
  test.each([null, undefined, "", "   ", 0, -1, "abc", Number.NaN, Number.POSITIVE_INFINITY])(
    "%p stores as null (unset)",
    (v) => {
      expect(sanitizeReorderLevel(v)).toBeNull();
    },
  );

  test.each([
    [5, 5],
    ["5", 5],
    [" 2.5 ", 2.5],
    [0.001, 0.001],
  ])("%p stores as %p", (raw, want) => {
    expect(sanitizeReorderLevel(raw)).toBe(want);
  });
});
