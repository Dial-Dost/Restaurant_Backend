// Pure inventory unit parsing + stock-status math — NO database, network, or
// native dependencies.
//
// Same contract as billing_math.ts / simulation_math.ts: this module is
// deliberately free of imports so jest can exercise it without a tenant, a pool
// or a single `await`. `database_supabase.ts` imports it, so the rule that
// decides "In Stock / Low Stock / Out of Stock" exists exactly ONCE in the
// product and every surface (the inventory list, the Overview concerns feed,
// its notification, the Supply KPI, both clients) reads the same answer.
//
// THE DEFECT THIS REPLACES
// ------------------------
//   if (stock <= 0) return "Out of Stock";
//   if (stock < 10)  return "Low Stock";
//   return "In Stock";
//
// A bare number comparison that never looked at the unit. 5000 mg of potato
// (five grams — a garnish) read "In Stock" because 5000 > 10, while 5 kg of the
// same potato read "Low Stock" because 5 < 10. The number alone carries no
// meaning: it only means something once you know what it counts.
//
// WHAT REPLACES IT
// ----------------
// A quantity is compared against a REORDER LEVEL, and both sides are pushed
// into the same dimension base before the comparison happens. The reorder level
// is per item and is expressed IN THE ITEM'S OWN UNIT, because an owner thinks
// "reorder potatoes below 5 kg", never "below 5000 g".
//
// FAIL-SAFE DIRECTION
// -------------------
// Units are free text (the web form literally says `placeholder="e.g., kg"`),
// so real tenants have typed "kgs", "Kilogram", "ltr", "nos" — and "handful".
// Anything this module cannot classify is UNKNOWN, and unknown degrades to the
// EXACT legacy rule above, never to a guess. A tenant who typed "handful" sees
// precisely what they saw yesterday; they do not open the app to a wall of red.

// ---------------------------------------------------------------------------
// Small total helpers, defined first so nothing below uses them before they
// exist. Every one of them is total: junk in, documented value out, never throw.
// ---------------------------------------------------------------------------

/** Text of a scalar. Objects/arrays/null/undefined become "" rather than
 *  "[object Object]", so a malformed stored blob can never masquerade as a
 *  unit name. */
function asText(value: unknown): string {
  if (typeof value === "string") {return value;}
  if (typeof value === "number" || typeof value === "boolean") {return String(value);}
  return "";
}

/** Coerce anything into a finite number (`fallback` for junk, NaN, null, ""). */
export function toFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") {return Number.isFinite(value) ? value : fallback;}
  const text = asText(value).trim();
  if (text === "") {return fallback;}
  const n = Number(text);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Kill binary-float dust (1000/0.001 style artefacts) without rounding away
 * legitimate precision. 12 significant digits is far more than any kitchen
 * quantity carries and far less than the ~15.95 where doubles start lying.
 */
function tidy(n: number): number {
  if (!Number.isFinite(n)) {return 0;}
  if (n === 0) {return 0;}
  return Number(n.toPrecision(12));
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/**
 * What a unit measures. Mass and volume are NEVER interconvertible — 1 kg of
 * flour is not 1 litre of flour, and the density that would relate them is a
 * per-ingredient fact this system does not hold. The type says so on purpose:
 * every conversion returns a discriminated result and a cross-dimension request
 * comes back `ok: false`, so no caller can silently compare kg against litres.
 */
export type UnitDimension = "mass" | "volume" | "count" | "unknown";

/** Base unit per dimension: mass -> gram, volume -> millilitre, count -> each. */
export type BaseUnit = "g" | "ml" | "each" | "";

export interface ParsedUnit {
  dimension: UnitDimension;
  /** Multiply a quantity in this unit by this to get the dimension's base unit. */
  factorToBase: number;
  /** The dimension's base unit symbol ("" when the unit is unrecognised). */
  base: BaseUnit;
  /** The normalised lookup key ("kgs" -> "kg"); "" when the input was blank. */
  canonical: string;
}

interface UnitEntry { dimension: Exclude<UnitDimension, "unknown">; factorToBase: number }

const BASE_OF: Record<UnitDimension, BaseUnit> = {
  mass: "g",
  volume: "ml",
  count: "each",
  unknown: "",
};

// ---------------------------------------------------------------------------
// The unit table
// ---------------------------------------------------------------------------
//
// Every spelling a real Indian restaurant kitchen has typed into a free-text
// box. Lookup is case-insensitive, trims, tolerates a trailing period and a
// trailing plural "s" (handled by the normaliser, so only the singular and the
// genuinely irregular spellings need a row here).
//
// COUNT UNITS ALL HAVE FACTOR 1 except `dozen`. A "pack" is not 6 of anything
// this system knows about — pack size is a per-item, per-vendor fact we do not
// store — so a pack is one countable thing. Treating it as anything else would
// invent stock that is not there.
const UNITS: Record<string, UnitEntry> = {
  // --- mass (base: gram) ---------------------------------------------------
  mg: { dimension: "mass", factorToBase: 0.001 },
  milligram: { dimension: "mass", factorToBase: 0.001 },
  milligramme: { dimension: "mass", factorToBase: 0.001 },
  g: { dimension: "mass", factorToBase: 1 },
  gm: { dimension: "mass", factorToBase: 1 },
  gr: { dimension: "mass", factorToBase: 1 },
  gram: { dimension: "mass", factorToBase: 1 },
  gramme: { dimension: "mass", factorToBase: 1 },
  kg: { dimension: "mass", factorToBase: 1000 },
  kilo: { dimension: "mass", factorToBase: 1000 },
  kilogram: { dimension: "mass", factorToBase: 1000 },
  kilogramme: { dimension: "mass", factorToBase: 1000 },
  // Imperial: exact definitions, not the schoolroom approximations.
  lb: { dimension: "mass", factorToBase: 453.59237 },
  pound: { dimension: "mass", factorToBase: 453.59237 },
  oz: { dimension: "mass", factorToBase: 28.349523125 },
  ounce: { dimension: "mass", factorToBase: 28.349523125 },

  // --- volume (base: millilitre) -------------------------------------------
  ml: { dimension: "volume", factorToBase: 1 },
  millilitre: { dimension: "volume", factorToBase: 1 },
  milliliter: { dimension: "volume", factorToBase: 1 },
  cl: { dimension: "volume", factorToBase: 10 },
  centilitre: { dimension: "volume", factorToBase: 10 },
  centiliter: { dimension: "volume", factorToBase: 10 },
  l: { dimension: "volume", factorToBase: 1000 },
  lt: { dimension: "volume", factorToBase: 1000 },
  ltr: { dimension: "volume", factorToBase: 1000 },
  litre: { dimension: "volume", factorToBase: 1000 },
  liter: { dimension: "volume", factorToBase: 1000 },

  // --- count (base: each) ---------------------------------------------------
  pc: { dimension: "count", factorToBase: 1 },
  pcs: { dimension: "count", factorToBase: 1 },
  piece: { dimension: "count", factorToBase: 1 },
  no: { dimension: "count", factorToBase: 1 },
  nos: { dimension: "count", factorToBase: 1 },
  number: { dimension: "count", factorToBase: 1 },
  unit: { dimension: "count", factorToBase: 1 },
  each: { dimension: "count", factorToBase: 1 },
  ea: { dimension: "count", factorToBase: 1 },
  item: { dimension: "count", factorToBase: 1 },
  dozen: { dimension: "count", factorToBase: 12 },
  dz: { dimension: "count", factorToBase: 12 },
  doz: { dimension: "count", factorToBase: 12 },
  pack: { dimension: "count", factorToBase: 1 },
  packet: { dimension: "count", factorToBase: 1 },
  pkt: { dimension: "count", factorToBase: 1 },
  box: { dimension: "count", factorToBase: 1 },
  tin: { dimension: "count", factorToBase: 1 },
  can: { dimension: "count", factorToBase: 1 },
  bottle: { dimension: "count", factorToBase: 1 },
  btl: { dimension: "count", factorToBase: 1 },
  tray: { dimension: "count", factorToBase: 1 },
  bag: { dimension: "count", factorToBase: 1 },
  jar: { dimension: "count", factorToBase: 1 },
  crate: { dimension: "count", factorToBase: 1 },
  bundle: { dimension: "count", factorToBase: 1 },
};

const lookup = (key: string): UnitEntry | undefined =>
  Object.prototype.hasOwnProperty.call(UNITS, key) ? UNITS[key] : undefined;

const described = (entry: UnitEntry, canonical: string): ParsedUnit => ({
  dimension: entry.dimension,
  factorToBase: entry.factorToBase,
  base: BASE_OF[entry.dimension],
  canonical,
});

/**
 * Free text -> lookup key. Lower-cases and drops everything that is not a
 * letter, so "Kg." -> "kg", "  LTR  " -> "ltr", "kilo gram" -> "kilogram", and a
 * stray "5 kg" in the unit box still resolves as "kg".
 */
function normaliseUnitKey(raw: unknown): string {
  return asText(raw).toLowerCase().replace(/[^a-z]+/g, "");
}

/**
 * Parse a free-text unit. Returns `dimension: "unknown"` for anything not in
 * the table — including "" — and callers MUST treat unknown as "no unit
 * knowledge", not as a default.
 */
export function parseUnit(raw: unknown): ParsedUnit {
  const key = normaliseUnitKey(raw);
  if (key === "") {
    return { dimension: "unknown", factorToBase: 1, base: "", canonical: "" };
  }
  // Direct hit first, then one plural strip. Order matters: "gms" is not in the
  // table, "gm" is; but "nos" IS in the table and must not be read as "no"
  // stripped — it resolves the same either way, and the direct hit keeps the
  // canonical spelling the tenant typed.
  const direct = lookup(key);
  if (direct) {return described(direct, key);}

  if (key.endsWith("s") && key.length > 1) {
    const singular = key.slice(0, -1);
    const plural = lookup(singular);
    if (plural) {return described(plural, singular);}
    // "boxes" / "ounces" / "pieces": strip the "es" too.
    if (singular.endsWith("e") && singular.length > 1) {
      const stem = singular.slice(0, -1);
      const es = lookup(stem);
      if (es) {return described(es, stem);}
    }
  }
  return { dimension: "unknown", factorToBase: 1, base: "", canonical: key };
}

// ---------------------------------------------------------------------------
// Conversion — always fallible, never across dimensions
// ---------------------------------------------------------------------------

export type ConversionFailure = "unknown-unit" | "dimension-mismatch";

export type ConversionResult =
  | { ok: true; value: number }
  | { ok: false; reason: ConversionFailure };

/**
 * Convert `value` from one free-text unit into another.
 *
 * Two rules make this safe:
 *   1. IDENTICAL units always convert (factor 1) even when both are unknown.
 *      "3 handfuls" against "5 handfuls" is a perfectly valid comparison — the
 *      unit cancels — and refusing it would throw away a level the owner set
 *      deliberately.
 *   2. Different dimensions NEVER convert. kg -> litre is not a rounding
 *      problem, it is a category error; it comes back `ok: false` and the caller
 *      falls back rather than printing a confident wrong answer.
 */
export function convertQuantity(value: number, fromUnit: unknown, toUnit: unknown): ConversionResult {
  const v = toFiniteNumber(value);
  if (normaliseUnitKey(fromUnit) === normaliseUnitKey(toUnit)) {return { ok: true, value: v };}

  const from = parseUnit(fromUnit);
  const to = parseUnit(toUnit);
  if (from.dimension === "unknown" || to.dimension === "unknown") {
    return { ok: false, reason: "unknown-unit" };
  }
  if (from.dimension !== to.dimension) {
    return { ok: false, reason: "dimension-mismatch" };
  }
  return { ok: true, value: tidy((v * from.factorToBase) / to.factorToBase) };
}

/** Quantity expressed in its dimension's base unit; null when the unit is unknown. */
export function toBaseQuantity(value: number, unit: unknown): number | null {
  const parsed = parseUnit(unit);
  if (parsed.dimension === "unknown") {return null;}
  return tidy(toFiniteNumber(value) * parsed.factorToBase);
}

// ---------------------------------------------------------------------------
// Reorder levels
// ---------------------------------------------------------------------------

/**
 * PER-DIMENSION DEFAULT reorder levels, in each dimension's BASE unit, used when
 * an item has no reorder level of its own.
 *
 * These numbers are the whole safety argument of this change, so the reasoning
 * is written down rather than left to be re-derived:
 *
 *  • mass = 1000 g (1 kg). A kitchen ingredient down to its last kilo is worth a
 *    purchase order for essentially any ingredient — a kilo of onions, of
 *    paneer, of atta is under a day's service. It is also LOW ENOUGH that a
 *    genuinely stocked item is untouched: 5 kg of potato stays "In Stock", which
 *    is exactly the case the owner reported. And it is high enough to catch the
 *    other half of that report: 5000 mg is 5 g, and 50 g is 50 g — both land far
 *    under a kilo and both correctly read "Low Stock".
 *
 *  • volume = 1000 ml (1 litre). Mirrors mass so the two read consistently; a
 *    litre of oil, milk or stock left is the same "order today" signal a kilo is.
 *
 *  • count = 5 each. Deliberately NOT the legacy 10. Two reasons. First, a
 *    default that paints every count item red is a worse bug than the one being
 *    fixed, and count items are the ones tenants stock in small numbers (5 gas
 *    cylinders, 8 chafing trays) — at 10 those all read "Low" forever and the
 *    badge stops meaning anything. Second, 5 is the threshold the Overview
 *    concerns feed and the Supply KPI ALREADY used in SQL, so this makes the
 *    inventory page and the concerns feed agree instead of contradicting each
 *    other as they did before. Moving count from 10 to 5 can only ever REMOVE a
 *    red badge, never add one, so no tenant wakes up to new alarms.
 *
 * An owner who disagrees sets a per-item level, which always wins.
 */
export const DEFAULT_REORDER_BASE: Record<Exclude<UnitDimension, "unknown">, number> = {
  mass: 1000,
  volume: 1000,
  count: 5,
};

/**
 * The legacy threshold, kept ONLY for items whose unit this module cannot
 * classify and which carry no reorder level of their own. Applied with a STRICT
 * `<`, exactly as the function this module replaces did, so an unclassifiable
 * item's badge is bit-for-bit what it was before this change.
 */
export const LEGACY_LOW_STOCK_THRESHOLD = 10;

/** A reorder level as stored: a number plus the unit it was typed in. */
export interface ReorderLevel {
  value: number;
  /** The unit the level was entered in. Defaults to the item's own unit. */
  unit?: string | null;
}

export type InventoryStatus = "In Stock" | "Low Stock" | "Out of Stock";

/**
 * Where the threshold that decided a status came from.
 *  • "item"              — the owner set a level on this item.
 *  • "dimension-default" — DEFAULT_REORDER_BASE for the item's dimension.
 *  • "legacy"            — unit unclassifiable and no per-item level: the old
 *                          `< 10` rule, unchanged.
 */
export type ThresholdBasis = "item" | "dimension-default" | "legacy";

export interface StockStatusResult {
  status: InventoryStatus;
  /** The threshold actually applied, expressed IN THE ITEM'S OWN UNIT. */
  threshold: number;
  basis: ThresholdBasis;
  dimension: UnitDimension;
  /**
   * quantity ÷ threshold. 0 when out of stock, ≤1 when low. Dimensionless, so
   * it is the ONLY sound way to rank items of different units against each
   * other ("which of these is most urgent?") — comparing 5000 mg to 3 kg by
   * their raw numbers is the original bug in a different costume.
   */
  ratio: number;
}

/**
 * Resolve the threshold to apply, IN THE ITEM'S OWN UNIT.
 *
 * A per-item level wins whenever it can be expressed in the item's unit. It
 * CANNOT when the owner set it in litres and later changed the item to kg — a
 * dimension mismatch — and in that case we fall back to the default rather than
 * compare two things that are not comparable.
 */
function resolveThreshold(
  parsed: ParsedUnit,
  unit: unknown,
  reorder?: ReorderLevel | null,
): { threshold: number; basis: ThresholdBasis } {
  const raw = toFiniteNumber(reorder?.value);
  if (reorder !== null && reorder !== undefined && raw > 0) {
    // An absent reorder unit means "same unit as the item" — that is how the
    // form presents it ("Reorder at or below ___ kg"), so it needs no conversion.
    const levelUnit = asText(reorder.unit).trim();
    const level = levelUnit === ""
      ? { ok: true as const, value: raw }
      : convertQuantity(raw, levelUnit, unit);
    if (level.ok) {
      return { threshold: tidy(level.value), basis: "item" };
    }
    // Falls through: an uncomparable level is discarded, never coerced.
  }
  if (parsed.dimension !== "unknown") {
    return { threshold: tidy(DEFAULT_REORDER_BASE[parsed.dimension] / parsed.factorToBase), basis: "dimension-default" };
  }
  return { threshold: LEGACY_LOW_STOCK_THRESHOLD, basis: "legacy" };
}

/**
 * `quantity <= threshold`, both already in the ITEM'S unit, with a relative
 * epsilon so a boundary that is exact in decimal (1000 mg against a 1 g level)
 * is not flipped by binary floating point.
 */
function atOrBelow(quantity: number, threshold: number, factorToBase: number): boolean {
  const q = quantity * factorToBase;
  const t = threshold * factorToBase;
  return q <= t * (1 + 1e-9);
}

/**
 * THE status rule. Both sides are normalised to the dimension base before the
 * comparison, so the unit is never ignored and never guessed.
 *
 * Out of Stock stays `quantity <= 0` — unchanged, and independent of units.
 */
export function computeStockStatus(
  quantity: unknown,
  unit: unknown,
  reorder?: ReorderLevel | null,
): StockStatusResult {
  const qty = toFiniteNumber(quantity);
  const parsed = parseUnit(unit);
  const resolved = resolveThreshold(parsed, unit, reorder);

  // Ratio is reported for every status, including Out of Stock (0), so callers
  // can rank a mixed-unit list by urgency without re-deriving anything.
  const ratio = resolved.threshold > 0
    ? tidy(Math.max(0, qty) / resolved.threshold)
    : (qty > 0 ? Number.POSITIVE_INFINITY : 0);

  if (qty <= 0) {
    return { status: "Out of Stock", threshold: resolved.threshold, basis: resolved.basis, dimension: parsed.dimension, ratio: 0 };
  }

  // The legacy fallback keeps the STRICT `<` of the function it replaces, so an
  // unclassifiable unit at exactly 10 reads "In Stock" today as it did before.
  // A real reorder level means "at or below this, reorder", which is what a
  // reorder point means everywhere else in the trade — hence `<=`.
  const low = resolved.basis === "legacy"
    ? qty < resolved.threshold
    : atOrBelow(qty, resolved.threshold, parsed.dimension === "unknown" ? 1 : parsed.factorToBase);

  return {
    status: low ? "Low Stock" : "In Stock",
    threshold: resolved.threshold,
    basis: resolved.basis,
    dimension: parsed.dimension,
    ratio,
  };
}

/** Convenience wrapper for the many call sites that only want the string. */
export function inventoryStatusOf(quantity: unknown, unit: unknown, reorder?: ReorderLevel | null): InventoryStatus {
  return computeStockStatus(quantity, unit, reorder).status;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
//
// WHERE THE REORDER LEVEL LIVES, AND WHY. "Inventory" has PK (barcode, res_id,
// outlet_id), a `"Quantity"` numeric and a `description` text — and no reorder,
// threshold or unit column anywhere in the schema. A new column needs a
// migration, and this pipeline deliberately REFUSES to deploy while a migration
// is pending. `description` already carries the per-item `unit` and `category`
// as a JSON blob (encode/parseInventoryDescription in database_supabase.ts), so
// it is the established, migration-free home for exactly this kind of per-item
// inventory metadata — and it keeps the level beside the unit that gives it
// meaning.

/**
 * Sanitise a reorder level for storage. Returns null for "unset" — a level of 0
 * or below is meaningless (every item would be low forever) and is treated as
 * unset rather than stored.
 */
export function sanitizeReorderLevel(value: unknown): number | null {
  if (value === null || value === undefined) {return null;}
  if (typeof value === "string" && value.trim() === "") {return null;}
  const n = toFiniteNumber(value, Number.NaN);
  if (!Number.isFinite(n) || n <= 0) {return null;}
  return tidy(n);
}
