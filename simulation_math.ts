// Pure what-if simulation math — NO database, network, or native dependencies.
//
// Same contract as billing_math.ts: this module loads nothing but billing_math
// itself (which is equally pure and import-free), so the simulator can be
// unit-tested in isolation (jest) without loading the heavy
// `database_supabase.ts` graph. The route (routes/simulation.ts) fetches raw
// 30-day aggregates from the data layer and hands them here; everything after
// that — defaults, clamping, the model itself — is deterministic arithmetic.
// The one import exists so the discount → service charge → tax order comes from
// the REAL bill pipeline (computeBillCharges) instead of a second copy of it.
//
// TOTALITY GUARANTEE. The reference implementation this feature replaces rendered
// ₹NaN in every delta cell. Every function here is total: for ANY input in (or
// out of) the legal range, including an all-zero baseline from an empty tenant,
// every returned number is finite. Division is always guarded, non-finite inputs
// are coerced to a documented default, and ₹ values are rounded to whole rupees
// (TAT to 0.1 min) before they leave this module.
//
// BASIS. All ₹ figures are PRE-TAX (the bill's taxable base — same basis as APC:
// bill subtotal / covers, covers counted once per seating). Bills.total_amt is
// tax-inclusive and is never used directly here; the data layer strips tax and
// service charge per bill before aggregating.
//
// ORDER OF OPERATIONS. Every lever enters this chain at exactly one point, so
// two levers can never scale the same cover twice. Demand levers multiply
// demand; capacity levers multiply the ceiling; served = min(demand, ceiling).
//
//   COVERS   1. demand   = baseline.covers × (1 + elasticity·price%)   [demand]
//            2.          × retention × no-show                          [demand]
//            3. ceiling  = baseline.covers × tatMult                    [capacity]
//                          × tables × party size × shifts × attendance  [capacity]
//            4. served   = min(demand, ceiling)
//            5.          + marketing covers (absorbed off-peak)
//            6.          × second outlet (1 + 60%)                      [SPECULATIVE]
//   APC      7. apc      = baseline.apc × (1 + price%). Discounts NEVER move
//                          APC — they are bill-level deductions, below.
//   REVENUE  8. gross    = served × apc              (the food-cost driver)
//            9. discounts = depth×frequency + coupons + loyalty (₹, off gross)
//           10. computeBillCharges(gross, tax, service charge, discounts)
//               → discounted subtotal, service charge, tax (display only)
//           11. commission = discounted subtotal × aggregator mix × rate
//           12. revenue  = discounted subtotal + service charge − commission
//   COSTS   13. food     = gross × food% × (1 + inflation) + gross × waste delta
//           14. labour   = (staff×wage + expediters) × shifts × outlet + overtime
//           15. fixed    = (fixed + utilities) × outlet + plan fee ÷ 30
//   NET     16. net      = revenue − labour − food − fixed
//               Tax is EXCLUDED from net in both columns (the model is pre-tax
//               throughout); one-time marketing is excluded too (breakeven_days).
//
// NEUTRALITY. Every parameter — old and new — has a neutral value that
// reproduces the baseline exactly, and a missing/garbage field resolves to it.
// An untouched lever therefore yields delta 0 in every cell and adds no note.

import { computeBillCharges } from "./billing_math.js";

// ---------------------------------------------------------------------------
// Constants — every tunable in the model, with its rationale.
// ---------------------------------------------------------------------------

/** Baseline/measurement window. The contract fixes it at 30 days. */
export const SIM_WINDOW_DAYS = 30;

/**
 * Food cost as % of pre-tax revenue when the tenant has recorded no food-like
 * expenses. 28–35% is the widely cited band for Indian casual dining (NRAI India
 * Food Services Report rule of thumb); 32 is the midpoint.
 */
export const DEFAULT_FOOD_COST_PCT = 32;

/**
 * Seat-to-settle table turnaround when no TableSessions exist yet. ~45 min is a
 * typical casual-dining seating; it also keeps the capacity model meaningful
 * (a 0-min TAT would disable the whole capacity lever).
 */
export const DEFAULT_TAT_MIN = 45;

/**
 * Per-staff daily wage when neither payroll nor labour expenses exist.
 * ₹13,500/month entry-level restaurant wage ÷ 30 days = ₹450/shift.
 */
export const DEFAULT_WAGE_PER_SHIFT = 450;

/**
 * Cost of one extra expediter, per shift per day. Fixed by the design contract
 * (labour = staff*wage + expediters*2100): an expediter is a senior/agency hire,
 * ~₹63k/month, well above line-staff wages.
 */
export const EXPEDITER_WAGE_PER_SHIFT = 2100;

/** Each expediter cuts the achievable TAT by 3 min (contract), never below the floor. */
export const EXPEDITER_TAT_CUT_MIN = 3;

/** No amount of expediting gets a table below 10 min seat-to-settle (contract). */
export const TAT_FLOOR_MIN = 10;

/**
 * Capacity multiplier bounds (contract): faster turns can serve at most 1.5× the
 * current covers (tables, kitchen and peak hours don't scale linearly); slower
 * turns never model away more than half the room.
 */
export const CAPACITY_MULT_CAP = 1.5;
export const CAPACITY_MULT_FLOOR = 0.5;

/**
 * Marketing yield: extra covers/day = MARKETING_YIELD * sqrt(spend / APC).
 * spend/APC is "how many covers' worth of spend" (₹ ÷ ₹/cover = covers), so the
 * sqrt is dimensionally sane and gives diminishing returns; 0.6 calibrates to
 * ~3 extra covers/day for a ₹10,000 one-time spend at APC ₹400 — a deliberately
 * conservative walk-in conversion. One-time spend is NOT amortised into daily
 * net profit; its payback is reported via breakeven_days instead.
 */
export const MARKETING_YIELD = 0.6;

/**
 * The acquisition rate that reproduces the legacy curve exactly.
 *
 * `acquisition_per_1000` SCALES the MARKETING_YIELD curve rather than replacing
 * it, and this is the value at which the scale factor is 1. That is what makes
 * the lever honest in the picker: a lever sitting at its default must produce
 * the same answer as a lever that is not there at all. The first cut switched
 * models on the mere PRESENCE of the key, so merely adding the lever and never
 * touching it moved profit by +Rs 9,740/day with no change-dot to show for it —
 * the screen said nothing had changed while the answer moved.
 *
 * Scaling also keeps the diminishing returns. A purely linear guests-per-Rs1,000
 * rate is unbounded inside its own slider range: at the top of the range it
 * projected 1,300 covers/day on a 30-table room (43 covers per table per day)
 * and told the owner marketing repays itself in one day at +442% profit.
 */
export const DEFAULT_ACQUISITION_PER_1000 = 2;

/**
 * How much of the capacity ceiling marketing covers may fill.
 *
 * HEAD deliberately added marketing covers ON TOP of the peak-capacity clamp,
 * on the reasoning that they are absorbed off-peak. That is defensible for a
 * bump of ~9 covers; it stops being defensible once a lever can scale it 5x. So
 * the off-peak allowance is bounded — but NEVER below what the legacy curve
 * alone would have produced, which is what keeps the original eight parameters
 * byte-identical to HEAD (see the cap in runSimulation).
 */
export const MARKETING_OFFPEAK_SHARE = 0.15;

/** Mid-range dining price elasticity of demand (restaurant studies cluster in -1 to -1.5). */
export const DEFAULT_ELASTICITY = -1.3;

/**
 * Floor for the profit-uplift divisor in breakeven_days, so a positive-but-tiny
 * uplift yields a huge finite number, never Infinity. Uplifts are whole rupees,
 * so anything positive is >= 1 and this floor is belt-and-braces only.
 */
export const BREAKEVEN_EPSILON = 0.01;

// ---------------------------------------------------------------------------
// Extended levers. Each constant below is either read from a real system of
// record (plan fees: migration 009) or is a labelled APPROXIMATION. Each also
// fixes the NEUTRAL value of its lever — the value at which the lever changes
// nothing, so an untouched slider yields delta 0 and adds no note.
// ---------------------------------------------------------------------------

/** Covers per table the capacity model treats as "today". Neutral for avg_party_size. */
export const DEFAULT_PARTY_SIZE = 3;

/** Captain share of the floor assumed today. Neutral for captain_share_pct. */
export const DEFAULT_CAPTAIN_SHARE_PCT = 20;

/**
 * APPROXIMATION. TAT minutes a full 0 → 100% captain-share swing is worth:
 * captains are the ones who can bark an order before approval, so a
 * captain-heavy floor gets tickets to the kitchen sooner. Deliberately smaller
 * than one expediter (3 min) — it re-labels existing staff, it doesn't add any.
 */
export const CAPTAIN_TAT_SPAN_MIN = 4;

/** Kitchen stations assumed today. Neutral for kitchen_stations. */
export const DEFAULT_KITCHEN_STATIONS = 3;

/**
 * APPROXIMATION. Each station above (or below) the default moves achievable TAT
 * by this much — the same shape as EXPEDITER_TAT_CUT_MIN but a separate lever:
 * expediters speed up the pass, stations speed up the cooking itself.
 */
export const KITCHEN_STATION_TAT_CUT_MIN = 2;

/** Wastage already priced into a measured food-cost %. Neutral for waste_pct. */
export const BASELINE_WASTE_PCT = 3;

/** No-show rate already priced into today's covers. Neutral for no_show_pct. */
export const BASELINE_NO_SHOW_PCT = 10;

/**
 * APPROXIMATION. Share of covers that arrive from a booking and can therefore
 * no-show; walk-ins cannot. SimulationRawStats carries no booking-source split,
 * so the no-show lever moves only this slice of the room.
 */
export const BOOKED_COVERS_SHARE = 0.25;

/** Repeat-guest rate assumed today. Neutral for retention_pct. */
export const BASELINE_RETENTION_PCT = 40;

/**
 * APPROXIMATION, deliberately timid (contract: "keep it directional, do not
 * invent a cohort model"). A full 0 → 100% retention swing moves demand by
 * ±15% of the gap from the baseline rate: at 100% repeat, demand ×1.09.
 */
export const RETENTION_SENSITIVITY = 0.15;

/**
 * APPROXIMATION. ₹ a redeemed loyalty reward takes off a bill. There is no
 * loyalty ledger in the schema (nothing to measure), so one redemption is
 * priced at ₹100 — roughly a quarter of a mid-market APC.
 */
export const LOYALTY_AVG_REDEMPTION_VALUE = 100;

/** Hours in one paid shift, used to price overtime off the shift wage. */
export const SHIFT_HOURS = 8;

/**
 * SPECULATIVE — the second-outlet model has never been validated end to end.
 * A new outlet is assumed to reach 60% of the primary's covers while doubling
 * site costs (rent, utilities, labour). Every result that uses it carries a
 * warning; do not present it with the confidence of a measured lever.
 */
export const SECOND_OUTLET_REVENUE_SHARE = 0.6;
export const SECOND_OUTLET_COST_MULT = 2;

/** Neutral tax rate for the display-only tax line (does not move ₹ or net). */
export const DEFAULT_TAX_RATE_PCT = 5;

export type PlanTier = "starter" | "growth" | "enterprise";

/**
 * Subscription tiers, read from migration 009's platform.plans seed — NOT
 * invented. `price_cents` there is paise (it is handed to Razorpay's `amount`
 * verbatim), so ₹/month = price_cents / 100: starter ₹0, growth ₹1,499,
 * enterprise ₹3,999. `multi_outlet` is copied from the same seed's features
 * blob, which grants it to ENTERPRISE ONLY — growth's features say
 * "multi_outlet": false — so only the enterprise tier can enable second_outlet.
 * Operators can edit plans in the platform console, so these are the seeded
 * defaults rather than a contract; the simulator says so in its note.
 */
export const PLAN_TIERS: Record<PlanTier, { label: string; monthly_fee: number; multi_outlet: boolean }> = {
  starter: { label: "Starter", monthly_fee: 0, multi_outlet: false },
  growth: { label: "Growth", monthly_fee: 1499, multi_outlet: false },
  enterprise: { label: "Enterprise", monthly_fee: 3999, multi_outlet: true },
};

/** Days a monthly subscription fee is spread over to reach a daily fixed cost. */
export const PLAN_FEE_DAYS = 30;

/** Legal slider ranges (contract). Out-of-range curl input is CLAMPED, not rejected. */
export const PARAM_RANGES = {
  price_adjust_pct: { min: -20, max: 30 },
  elasticity: { min: -2, max: -0.5 },
  staff_count: { min: 1, max: 60 },
  avg_wage_per_shift: { min: 100, max: 2000 },
  tat_target_min: { min: 10, max: 60 },
  extra_expediters: { min: 0, max: 5 },
  marketing_spend: { min: 0, max: 100000 },
  food_cost_pct: { min: 20, max: 60 },
  // --- Pricing & demand
  discount_depth_pct: { min: 0, max: 30 },
  discount_frequency_pct: { min: 0, max: 100 },
  coupon_redemption_pct: { min: 0, max: 50 },
  coupon_avg_value: { min: 0, max: 500 },
  service_charge_pct: { min: 0, max: 10 },
  tax_rate_pct: { min: 0, max: 28 },
  avg_party_size: { min: 1, max: 8 },
  loyalty_redemption_pct: { min: 0, max: 30 },
  // --- Staffing
  captain_share_pct: { min: 0, max: 100 },
  shifts_per_day: { min: 1, max: 2 },
  overtime_premium_pct: { min: 0, max: 100 },
  overtime_hours_per_shift: { min: 0, max: 4 },
  staff_attendance_pct: { min: 70, max: 100 },
  // --- Operations
  table_count: { min: 20, max: 150 },
  kitchen_stations: { min: 1, max: 8 },
  waste_pct: { min: 0, max: 15 },
  ingredient_inflation_pct: { min: -10, max: 30 },
  no_show_pct: { min: 0, max: 40 },
  // --- Marketing & growth
  acquisition_per_1000: { min: 0, max: 10 },
  retention_pct: { min: 0, max: 100 },
  aggregator_mix_pct: { min: 0, max: 60 },
  aggregator_commission_pct: { min: 15, max: 30 },
  // --- Overhead
  fixed_costs_per_day: { min: 0, max: 20000 },
  utilities_per_day: { min: 0, max: 5000 },
} as const;

/** One row of the editable parameter list the UI renders. */
export interface ParamSpec {
  key: string;
  group: "Pricing & demand" | "Staffing" | "Operations" | "Marketing & growth" | "Overhead" | "Scale";
  label: string;
  unit: string;
  kind: "number" | "enum" | "toggle";
  min?: number;
  max?: number;
  step?: number;
  /** Neutral default. `null` = resolved per tenant from `default_from`. */
  default: number | string | boolean | null;
  default_from?: keyof SimulationBaseline;
  /** Set when the lever is a rough sketch rather than a measured relationship. */
  speculative?: boolean;
  options?: readonly { value: string; label: string }[];
}

/**
 * The catalog behind the user-editable parameter list: every lever, its group,
 * its step, and its NEUTRAL default (what "reset" and the changed-dot compare
 * against). PARAM_RANGES stays the single source of truth for clamping; this
 * adds only presentation metadata, so the two can never disagree on min/max.
 * Levers whose default is the tenant's own measured figure carry
 * `default: null` + `default_from`, because there is no catalog number for them.
 */
export const PARAM_CATALOG: readonly ParamSpec[] = [
  // The original eight, unchanged in every respect.
  { key: "price_adjust_pct", group: "Pricing & demand", label: "Menu price change", unit: "%", kind: "number", min: -20, max: 30, step: 1, default: 0 },
  { key: "elasticity", group: "Pricing & demand", label: "Price elasticity", unit: "", kind: "number", min: -2, max: -0.5, step: 0.1, default: DEFAULT_ELASTICITY },
  { key: "staff_count", group: "Staffing", label: "Staff on shift", unit: "people", kind: "number", min: 1, max: 60, step: 1, default: null, default_from: "staff_count" },
  { key: "avg_wage_per_shift", group: "Staffing", label: "Average wage", unit: "₹/shift", kind: "number", min: 100, max: 2000, step: 50, default: null, default_from: "labour_cost_per_day" },
  { key: "tat_target_min", group: "Operations", label: "Turnaround target", unit: "min", kind: "number", min: 10, max: 60, step: 1, default: null, default_from: "avg_tat_min" },
  { key: "extra_expediters", group: "Staffing", label: "Extra expediters", unit: "people", kind: "number", min: 0, max: 5, step: 1, default: 0 },
  { key: "marketing_spend", group: "Marketing & growth", label: "Marketing spend (one-time)", unit: "₹", kind: "number", min: 0, max: 100000, step: 1000, default: 0 },
  { key: "food_cost_pct", group: "Operations", label: "Food cost", unit: "% of revenue", kind: "number", min: 20, max: 60, step: 1, default: null, default_from: "food_cost_pct" },
  // Pricing & demand
  { key: "discount_depth_pct", group: "Pricing & demand", label: "Average discount depth", unit: "%", kind: "number", min: 0, max: 30, step: 1, default: 0 },
  { key: "discount_frequency_pct", group: "Pricing & demand", label: "Bills discounted", unit: "%", kind: "number", min: 0, max: 100, step: 5, default: 0 },
  { key: "coupon_redemption_pct", group: "Pricing & demand", label: "Coupon redemption", unit: "% of bills", kind: "number", min: 0, max: 50, step: 5, default: 0 },
  { key: "coupon_avg_value", group: "Pricing & demand", label: "Average coupon value", unit: "₹", kind: "number", min: 0, max: 500, step: 25, default: 0 },
  { key: "service_charge_pct", group: "Pricing & demand", label: "Service charge", unit: "%", kind: "number", min: 0, max: 10, step: 0.5, default: 0 },
  { key: "tax_rate_pct", group: "Pricing & demand", label: "Tax rate (display only)", unit: "%", kind: "number", min: 0, max: 28, step: 0.5, default: DEFAULT_TAX_RATE_PCT },
  { key: "avg_party_size", group: "Pricing & demand", label: "Average party size", unit: "covers/table", kind: "number", min: 1, max: 8, step: 0.5, default: DEFAULT_PARTY_SIZE },
  { key: "loyalty_redemption_pct", group: "Pricing & demand", label: "Loyalty redemption", unit: "% of bills", kind: "number", min: 0, max: 30, step: 5, default: 0 },
  // Staffing
  { key: "captain_share_pct", group: "Staffing", label: "Captains on the floor", unit: "% of staff", kind: "number", min: 0, max: 100, step: 5, default: DEFAULT_CAPTAIN_SHARE_PCT },
  { key: "shifts_per_day", group: "Staffing", label: "Shifts per day", unit: "shifts", kind: "number", min: 1, max: 2, step: 1, default: 1 },
  { key: "overtime_premium_pct", group: "Staffing", label: "Overtime premium", unit: "%", kind: "number", min: 0, max: 100, step: 10, default: 0 },
  { key: "overtime_hours_per_shift", group: "Staffing", label: "Overtime per shift", unit: "hrs", kind: "number", min: 0, max: 4, step: 0.5, default: 0 },
  { key: "staff_attendance_pct", group: "Staffing", label: "Attendance", unit: "%", kind: "number", min: 70, max: 100, step: 5, default: 100 },
  // Operations
  { key: "table_count", group: "Operations", label: "Tables", unit: "count", kind: "number", min: 20, max: 150, step: 2, default: null, default_from: "table_count" },
  { key: "kitchen_stations", group: "Operations", label: "Kitchen stations", unit: "count", kind: "number", min: 1, max: 8, step: 1, default: DEFAULT_KITCHEN_STATIONS },
  { key: "waste_pct", group: "Operations", label: "Food wastage", unit: "% of revenue", kind: "number", min: 0, max: 15, step: 0.5, default: BASELINE_WASTE_PCT },
  { key: "ingredient_inflation_pct", group: "Operations", label: "Ingredient inflation", unit: "%", kind: "number", min: -10, max: 30, step: 1, default: 0 },
  { key: "no_show_pct", group: "Operations", label: "Booking no-shows", unit: "%", kind: "number", min: 0, max: 40, step: 5, default: BASELINE_NO_SHOW_PCT },
  // Marketing & growth
  { key: "acquisition_per_1000", group: "Marketing & growth", label: "Guests per ₹1,000 spent", unit: "guests", kind: "number", min: 0, max: 10, step: 0.5, default: 2 },
  { key: "retention_pct", group: "Marketing & growth", label: "Repeat guests", unit: "%", kind: "number", min: 0, max: 100, step: 5, default: BASELINE_RETENTION_PCT },
  { key: "aggregator_mix_pct", group: "Marketing & growth", label: "Delivery aggregator mix", unit: "% of covers", kind: "number", min: 0, max: 60, step: 5, default: 0 },
  { key: "aggregator_commission_pct", group: "Marketing & growth", label: "Aggregator commission", unit: "%", kind: "number", min: 15, max: 30, step: 1, default: 20 },
  // Overhead
  { key: "fixed_costs_per_day", group: "Overhead", label: "Fixed costs", unit: "₹/day", kind: "number", min: 0, max: 20000, step: 500, default: null, default_from: "fixed_costs_per_day" },
  { key: "utilities_per_day", group: "Overhead", label: "Extra utilities", unit: "₹/day", kind: "number", min: 0, max: 5000, step: 250, default: 0 },
  { key: "plan_tier", group: "Overhead", label: "Subscription plan", unit: "", kind: "enum", default: "starter", options: [
    { value: "starter", label: "Starter — ₹0/mo" },
    { value: "growth", label: "Growth — ₹1,499/mo" },
    { value: "enterprise", label: "Enterprise — ₹3,999/mo (multi-outlet)" },
  ] },
  // Scale
  { key: "second_outlet", group: "Scale", label: "Open a second outlet", unit: "", kind: "toggle", default: false, speculative: true },
] as const;

/**
 * Expense-category classifiers for the baseline P&L split. Categories are free
 * text typed by owners, so this is a keyword match, not a taxonomy: anything
 * food-ish counts toward food cost, anything wage-ish toward labour, and the
 * remainder (rent, utilities, maintenance…) is treated as fixed cost.
 */
export const FOOD_CATEGORY_RE = /food|ingredient|grocer|produce|meat|fish|veg|fruit|dairy|kitchen|raw|provision|beverage|liquor|bar/i;
export const LABOUR_CATEGORY_RE = /salar|wage|payroll|staff|labour|labor|bonus|incentive/i;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Raw 30-day aggregates from the data layer. All numbers may legitimately be 0. */
export interface SimulationRawStats {
  window_days: number;
  bill_count: number;
  /** Sum of settled bills' taxable_base (pre-tax, pre-service-charge) over the window. */
  pretax_revenue_total: number;
  /** Sum of seating covers across those settled bills (covers once per seating). */
  covers_total: number;
  /** Avg seat-to-settle minutes from TableSessions, or null when none exist. */
  avg_tat_min: number | null;
  staff_count: number;
  table_count: number;
  /** Window expense totals grouped by (free-text) category. */
  expense_categories: { category: string; amount: number }[];
  /** Configured monthly wage bill (base+allowances of monthly-pay profiles). */
  payroll_monthly_wage_bill: number;
}

export type BaselineSource = "measured" | "default";

export interface SimulationBaseline {
  window_days: number;
  covers_per_day: number;
  apc: number;
  revenue_per_day: number;
  food_cost_pct: number;
  labour_cost_per_day: number;
  staff_count: number;
  avg_tat_min: number;
  table_count: number;
  fixed_costs_per_day: number;
  net_profit_per_day: number;
  /** Honesty marker per field: "measured" from real rows, "default" industry fallback. */
  sources: Record<string, BaselineSource>;
}

/** Untrusted body of POST /simulation/run — every field optional/garbage-tolerant. */
export interface SimulationParams {
  price_adjust_pct?: unknown;
  elasticity?: unknown;
  staff_count?: unknown;
  avg_wage_per_shift?: unknown;
  tat_target_min?: unknown;
  extra_expediters?: unknown;
  marketing_spend?: unknown;
  food_cost_pct?: unknown;
  // --- Pricing & demand
  discount_depth_pct?: unknown;
  discount_frequency_pct?: unknown;
  coupon_redemption_pct?: unknown;
  coupon_avg_value?: unknown;
  service_charge_pct?: unknown;
  tax_rate_pct?: unknown;
  avg_party_size?: unknown;
  loyalty_redemption_pct?: unknown;
  // --- Staffing
  captain_share_pct?: unknown;
  shifts_per_day?: unknown;
  overtime_premium_pct?: unknown;
  overtime_hours_per_shift?: unknown;
  staff_attendance_pct?: unknown;
  // --- Operations
  table_count?: unknown;
  kitchen_stations?: unknown;
  waste_pct?: unknown;
  ingredient_inflation_pct?: unknown;
  no_show_pct?: unknown;
  // --- Marketing & growth
  acquisition_per_1000?: unknown;
  retention_pct?: unknown;
  aggregator_mix_pct?: unknown;
  aggregator_commission_pct?: unknown;
  // --- Overhead & scale
  fixed_costs_per_day?: unknown;
  utilities_per_day?: unknown;
  plan_tier?: unknown;
  second_outlet?: unknown;
}

/** One row of the CURRENT | SIMULATED | DELTA table. ₹ whole rupees, TAT 0.1 min. */
export interface SimulationLine {
  covers: number;
  apc: number;
  revenue: number;
  labour_cost: number;
  food_cost: number;
  marketing_per_day: number;
  net_profit: number;
  tat_min: number;
  /** Fixed costs actually charged to this column (override + utilities + plan). */
  fixed_cost: number;
  /** Service charge earned (0 in the CURRENT column — the baseline basis excludes it). */
  service_charge: number;
  /** Bill discounts + coupons + loyalty + aggregator commission taken off gross. */
  revenue_deductions: number;
  /** DISPLAY ONLY. Tax at the chosen rate; never part of revenue or net_profit. */
  tax_collected: number;
}

export interface SimulationResult {
  current: SimulationLine;
  simulated: SimulationLine;
  delta: SimulationLine;
  notes: string[];
  breakeven_days: number | null;
  /** Loud, UI-facing caveats (e.g. the speculative second-outlet model). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Total-arithmetic helpers
// ---------------------------------------------------------------------------

/** Coerce anything to a finite number (fallback otherwise). The NaN firewall. */
function finite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Whole rupees. `+ 0` normalises -0 so JSON never carries a negative zero. */
function rupees(value: number): number {
  return Math.round(finite(value)) + 0;
}

/** One decimal place (TAT minutes, covers/day). */
function round1(value: number): number {
  return Math.round(finite(value) * 10) / 10 + 0;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return Math.min(max, Math.max(min, finite(value, fallback)));
}

/** True when the body actually carries a usable number for a field. */
function supplied(value: unknown): boolean {
  if (value === undefined || value === null || value === "") {return false;}
  return Number.isFinite(Number(value));
}

/**
 * Clamp like `clamp`, EXCEPT that a missing/garbage field falls back to the
 * tenant's own MEASURED figure without clamping it. The catalog range describes
 * the slider, not the tenant's reality — an 18-table room or ₹25,000/day of rent
 * is perfectly legal — and clamping the fallback would move a lever nobody
 * touched, breaking the neutrality guarantee. Explicit values are still clamped.
 */
function clampMeasured(value: unknown, min: number, max: number, measured: number): number {
  const fallback = finite(measured, min);
  if (!supplied(value)) {return fallback;}
  // The tenant's own measurement is always inside the legal domain, even when it
  // sits outside the catalog range (an 18-table room, ₹30,000/day of rent). A UI
  // that echoes the measured default back must get the same simulation as one
  // that omits the field — clamping it to the catalog edge would silently move a
  // lever the user never touched.
  return clamp(value, Math.min(min, fallback), Math.max(max, fallback), fallback);
}

/** Unknown/garbage tiers resolve to Starter, never a crash. "pro" is accepted as
 *  an alias for the seeded top tier, which platform.plans calls "enterprise". */
function resolvePlanTier(value: unknown): PlanTier {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (key === "growth") {return "growth";}
  if (key === "enterprise" || key === "pro" || key === "premium") {return "enterprise";}
  return "starter";
}

/** Truthiness for a toggle arriving as a bool, "true"/"on"/"yes", or 1. */
function resolveToggle(value: unknown): boolean {
  if (typeof value === "boolean") {return value;}
  if (typeof value === "number") {return Number.isFinite(value) && value !== 0;}
  if (typeof value !== "string") {return false;}
  const s = value.trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

/**
 * Turn raw window aggregates into the live baseline. Every field the tenant has
 * data for is "measured"; the rest fall back to the documented defaults above and
 * are marked "default" so the UI can tag them "estimated". An empty tenant gets
 * finite zeros (plus the two non-₹ defaults the model needs: food % and TAT) —
 * never NaN/null.
 */
export function buildBaseline(raw: SimulationRawStats): SimulationBaseline {
  const days = finite(raw.window_days, SIM_WINDOW_DAYS) > 0 ? finite(raw.window_days, SIM_WINDOW_DAYS) : SIM_WINDOW_DAYS;
  const billCount = Math.max(0, finite(raw.bill_count));
  const pretax = Math.max(0, finite(raw.pretax_revenue_total));
  const coversTotal = Math.max(0, finite(raw.covers_total));
  const sources: Record<string, BaselineSource> = {};

  const measuredRevenue = billCount > 0;
  const covers_per_day = round1(coversTotal / days);
  const apc = coversTotal > 0 ? rupees(pretax / coversTotal) : 0;
  const revenue_per_day = rupees(pretax / days);
  sources.covers_per_day = measuredRevenue && coversTotal > 0 ? "measured" : "default";
  sources.apc = sources.covers_per_day;
  sources.revenue_per_day = measuredRevenue ? "measured" : "default";

  // Split window expenses into food / labour / fixed by category keyword.
  let foodSpend = 0, labourSpend = 0, otherSpend = 0;
  for (const e of raw.expense_categories ?? []) {
    const amount = Math.max(0, finite(e?.amount));
    const category = String(e?.category ?? "");
    if (FOOD_CATEGORY_RE.test(category)) {foodSpend += amount;}
    else if (LABOUR_CATEGORY_RE.test(category)) {labourSpend += amount;}
    else {otherSpend += amount;}
  }
  const hasExpenses = (raw.expense_categories ?? []).length > 0;

  // Food %: measured only when both sides of the ratio exist. Clamped into the
  // slider range so /baseline and /run always agree on the legal domain.
  let food_cost_pct: number;
  if (foodSpend > 0 && pretax > 0) {
    food_cost_pct = round1(clamp((foodSpend / pretax) * 100, PARAM_RANGES.food_cost_pct.min, PARAM_RANGES.food_cost_pct.max, DEFAULT_FOOD_COST_PCT));
    sources.food_cost_pct = "measured";
  } else {
    food_cost_pct = DEFAULT_FOOD_COST_PCT;
    sources.food_cost_pct = "default";
  }

  const staff_count = Math.max(0, Math.round(finite(raw.staff_count)));
  sources.staff_count = staff_count > 0 ? "measured" : "default";

  // Labour preference order: real labour expenses in the window, then the
  // configured payroll wage bill, then headcount × default wage (marked default).
  const payrollMonthly = Math.max(0, finite(raw.payroll_monthly_wage_bill));
  let labour_cost_per_day: number;
  if (labourSpend > 0) {
    labour_cost_per_day = rupees(labourSpend / days);
    sources.labour_cost_per_day = "measured";
  } else if (payrollMonthly > 0) {
    labour_cost_per_day = rupees(payrollMonthly / SIM_WINDOW_DAYS);
    sources.labour_cost_per_day = "measured";
  } else {
    labour_cost_per_day = rupees(staff_count * DEFAULT_WAGE_PER_SHIFT);
    sources.labour_cost_per_day = "default";
  }

  const rawTat = raw.avg_tat_min == null ? 0 : finite(raw.avg_tat_min);
  const avg_tat_min = rawTat > 0 ? round1(rawTat) : DEFAULT_TAT_MIN;
  sources.avg_tat_min = rawTat > 0 ? "measured" : "default";

  const table_count = Math.max(0, Math.round(finite(raw.table_count)));
  sources.table_count = "measured";

  // Everything not food/labour is treated as fixed (rent, power, upkeep…).
  // "measured" whenever ANY expense rows exist: recorded expenses that all
  // landed in food/labour genuinely mean measured-zero fixed costs.
  const fixed_costs_per_day = rupees(otherSpend / days);
  sources.fixed_costs_per_day = hasExpenses ? "measured" : "default";

  const baseline: SimulationBaseline = {
    window_days: SIM_WINDOW_DAYS,
    covers_per_day,
    apc,
    revenue_per_day,
    food_cost_pct,
    labour_cost_per_day,
    staff_count,
    avg_tat_min,
    table_count,
    fixed_costs_per_day,
    net_profit_per_day: 0, // filled below from the same daily P&L used by /run
    sources,
  };
  baseline.net_profit_per_day = dailyNetProfit(baseline);
  // Derived figure: honest only when its revenue input is.
  sources.net_profit_per_day = sources.revenue_per_day;
  return baseline;
}

/**
 * The one daily P&L identity, shared by /baseline and the CURRENT column of /run
 * so the two endpoints can never disagree:
 *   net = revenue − labour − food%·revenue − fixed  (one-time marketing excluded).
 */
export function dailyNetProfit(b: Pick<SimulationBaseline, "revenue_per_day" | "labour_cost_per_day" | "food_cost_pct" | "fixed_costs_per_day">): number {
  const revenue = rupees(b.revenue_per_day);
  const food = rupees((finite(b.food_cost_pct) / 100) * revenue);
  return rupees(revenue - rupees(b.labour_cost_per_day) - food - rupees(b.fixed_costs_per_day));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/** Slider values after clamping, defaults resolved against the live baseline. */
export interface ResolvedParams {
  price_adjust_pct: number;
  elasticity: number;
  staff_count: number;
  avg_wage_per_shift: number;
  tat_target_min: number;
  extra_expediters: number;
  marketing_spend: number;
  food_cost_pct: number;
  // --- Pricing & demand
  discount_depth_pct: number;
  discount_frequency_pct: number;
  coupon_redemption_pct: number;
  coupon_avg_value: number;
  service_charge_pct: number;
  tax_rate_pct: number;
  avg_party_size: number;
  loyalty_redemption_pct: number;
  // --- Staffing
  captain_share_pct: number;
  shifts_per_day: number;
  overtime_premium_pct: number;
  overtime_hours_per_shift: number;
  staff_attendance_pct: number;
  // --- Operations
  table_count: number;
  kitchen_stations: number;
  waste_pct: number;
  ingredient_inflation_pct: number;
  no_show_pct: number;
  // --- Marketing & growth
  acquisition_per_1000: number;
  retention_pct: number;
  aggregator_mix_pct: number;
  aggregator_commission_pct: number;
  // --- Overhead & scale
  fixed_costs_per_day: number;
  utilities_per_day: number;
  plan_tier: PlanTier;
  /** Effective value: a tier without multi_outlet can never turn this on. */
  second_outlet: boolean;
  /** True when the toggle was asked for but the plan tier refused it. */
  second_outlet_blocked: boolean;
}

/**
 * Clamp an untrusted body into the legal slider ranges. Missing/garbage fields
 * resolve to the NEUTRAL value for this tenant (the baseline equivalent), so a
 * partial body simulates only the levers it actually moved.
 */
export function resolveParams(raw: SimulationParams | null | undefined, baseline: SimulationBaseline): ResolvedParams {
  const body = raw ?? {};
  const R = PARAM_RANGES;
  const staffFallback = clamp(baseline.staff_count, R.staff_count.min, R.staff_count.max, R.staff_count.min);
  // Neutral wage = the wage that reproduces the baseline labour bill at the
  // baseline headcount, so an untouched staff/wage pair yields delta ≈ 0.
  const wageFallback = clamp(
    baseline.staff_count > 0 ? baseline.labour_cost_per_day / baseline.staff_count : DEFAULT_WAGE_PER_SHIFT,
    R.avg_wage_per_shift.min, R.avg_wage_per_shift.max, DEFAULT_WAGE_PER_SHIFT,
  );
  // Toggling a second outlet is a PLAN capability, not a slider: platform.plans
  // grants multi_outlet to the enterprise tier only (migration 009), so a
  // starter/growth simulation cannot switch it on however hard the body tries.
  const plan_tier = resolvePlanTier(body.plan_tier);
  const wantsSecondOutlet = resolveToggle(body.second_outlet);
  const second_outlet = wantsSecondOutlet && PLAN_TIERS[plan_tier].multi_outlet;
  return {
    price_adjust_pct: clamp(body.price_adjust_pct, R.price_adjust_pct.min, R.price_adjust_pct.max, 0),
    elasticity: clamp(body.elasticity, R.elasticity.min, R.elasticity.max, DEFAULT_ELASTICITY),
    staff_count: Math.round(clamp(body.staff_count, R.staff_count.min, R.staff_count.max, staffFallback)),
    avg_wage_per_shift: clamp(body.avg_wage_per_shift, R.avg_wage_per_shift.min, R.avg_wage_per_shift.max, wageFallback),
    tat_target_min: clamp(body.tat_target_min, R.tat_target_min.min, R.tat_target_min.max, clamp(baseline.avg_tat_min, R.tat_target_min.min, R.tat_target_min.max, DEFAULT_TAT_MIN)),
    extra_expediters: Math.round(clamp(body.extra_expediters, R.extra_expediters.min, R.extra_expediters.max, 0)),
    marketing_spend: clamp(body.marketing_spend, R.marketing_spend.min, R.marketing_spend.max, 0),
    food_cost_pct: clamp(body.food_cost_pct, R.food_cost_pct.min, R.food_cost_pct.max, baseline.food_cost_pct),

    // --- Pricing & demand. Neutral = 0 for every deduction: the baseline's
    // revenue basis is the taxable base actually billed, so "no extra discount".
    discount_depth_pct: clamp(body.discount_depth_pct, R.discount_depth_pct.min, R.discount_depth_pct.max, 0),
    discount_frequency_pct: clamp(body.discount_frequency_pct, R.discount_frequency_pct.min, R.discount_frequency_pct.max, 0),
    coupon_redemption_pct: clamp(body.coupon_redemption_pct, R.coupon_redemption_pct.min, R.coupon_redemption_pct.max, 0),
    coupon_avg_value: clamp(body.coupon_avg_value, R.coupon_avg_value.min, R.coupon_avg_value.max, 0),
    // Neutral = 0, NOT the 1% a menu would suggest: the baseline is measured
    // PRE-service-charge, so any non-zero default would invent revenue the
    // tenant is not earning and give an untouched simulation a non-zero delta.
    service_charge_pct: clamp(body.service_charge_pct, R.service_charge_pct.min, R.service_charge_pct.max, 0),
    // Display-only, so its default is free of neutrality constraints.
    tax_rate_pct: clamp(body.tax_rate_pct, R.tax_rate_pct.min, R.tax_rate_pct.max, DEFAULT_TAX_RATE_PCT),
    // Capacity levers are RATIOS against these same defaults, so the constant
    // cancels out and the lever is neutral at its default whatever it is.
    avg_party_size: clamp(body.avg_party_size, R.avg_party_size.min, R.avg_party_size.max, DEFAULT_PARTY_SIZE),
    loyalty_redemption_pct: clamp(body.loyalty_redemption_pct, R.loyalty_redemption_pct.min, R.loyalty_redemption_pct.max, 0),

    // --- Staffing
    captain_share_pct: clamp(body.captain_share_pct, R.captain_share_pct.min, R.captain_share_pct.max, DEFAULT_CAPTAIN_SHARE_PCT),
    shifts_per_day: Math.round(clamp(body.shifts_per_day, R.shifts_per_day.min, R.shifts_per_day.max, 1)),
    overtime_premium_pct: clamp(body.overtime_premium_pct, R.overtime_premium_pct.min, R.overtime_premium_pct.max, 0),
    overtime_hours_per_shift: clamp(body.overtime_hours_per_shift, R.overtime_hours_per_shift.min, R.overtime_hours_per_shift.max, 0),
    staff_attendance_pct: clamp(body.staff_attendance_pct, R.staff_attendance_pct.min, R.staff_attendance_pct.max, 100),

    // --- Operations. table_count OVERRIDES a measured baseline field, so its
    // neutral value is that measurement (unclamped — see clampMeasured).
    table_count: Math.round(clampMeasured(body.table_count, R.table_count.min, R.table_count.max, baseline.table_count)),
    kitchen_stations: Math.round(clamp(body.kitchen_stations, R.kitchen_stations.min, R.kitchen_stations.max, DEFAULT_KITCHEN_STATIONS)),
    waste_pct: clamp(body.waste_pct, R.waste_pct.min, R.waste_pct.max, BASELINE_WASTE_PCT),
    ingredient_inflation_pct: clamp(body.ingredient_inflation_pct, R.ingredient_inflation_pct.min, R.ingredient_inflation_pct.max, 0),
    no_show_pct: clamp(body.no_show_pct, R.no_show_pct.min, R.no_show_pct.max, BASELINE_NO_SHOW_PCT),

    // --- Marketing & growth
    // Neutral at DEFAULT_ACQUISITION_PER_1000: at that value the scale factor is
    // 1 and the legacy curve runs unchanged, so "lever present at default" and
    // "lever absent" are the same simulation. Nothing keys off presence.
    acquisition_per_1000: clamp(body.acquisition_per_1000, R.acquisition_per_1000.min, R.acquisition_per_1000.max, DEFAULT_ACQUISITION_PER_1000),
    retention_pct: clamp(body.retention_pct, R.retention_pct.min, R.retention_pct.max, BASELINE_RETENTION_PCT),
    aggregator_mix_pct: clamp(body.aggregator_mix_pct, R.aggregator_mix_pct.min, R.aggregator_mix_pct.max, 0),
    aggregator_commission_pct: clamp(body.aggregator_commission_pct, R.aggregator_commission_pct.min, R.aggregator_commission_pct.max, 20),

    // --- Overhead & scale. fixed_costs_per_day OVERRIDES the measured baseline
    // figure (derived from expense categories), so neutral = that figure.
    fixed_costs_per_day: clampMeasured(body.fixed_costs_per_day, R.fixed_costs_per_day.min, R.fixed_costs_per_day.max, baseline.fixed_costs_per_day),
    utilities_per_day: clamp(body.utilities_per_day, R.utilities_per_day.min, R.utilities_per_day.max, 0),
    plan_tier,
    second_outlet,
    second_outlet_blocked: wantsSecondOutlet && !second_outlet,
  };
}

/**
 * The what-if model. Pure and total: any baseline (including all zeros) with any
 * body produces three finite SimulationLines and an explanatory note per applied
 * effect. delta = simulated − current, computed AFTER rounding so the table the
 * user reads always adds up.
 */
export function runSimulation(baseline: SimulationBaseline, rawParams: SimulationParams | null | undefined): SimulationResult {
  const p = resolveParams(rawParams, baseline);
  const notes: string[] = [];
  const warnings: string[] = [];
  notes.push(`Basis: all ₹ figures are pre-tax (bill subtotal), per day, over a ${SIM_WINDOW_DAYS}-day baseline window.`);

  // --- CURRENT column: the live baseline, restated through the shared identity.
  const curRevenue = rupees(baseline.revenue_per_day);
  const curLabour = rupees(baseline.labour_cost_per_day);
  const curFood = rupees((finite(baseline.food_cost_pct) / 100) * curRevenue);
  const fixed = rupees(baseline.fixed_costs_per_day);
  // Tax on the CURRENT column at the same rate, so the tax row is comparable.
  // Display only: it is never subtracted from net_profit in either column.
  const curCharges = computeBillCharges(curRevenue, [{ name: "Tax", percentage: p.tax_rate_pct }], 0, true, null);
  const current: SimulationLine = {
    covers: round1(baseline.covers_per_day),
    apc: rupees(baseline.apc),
    revenue: curRevenue,
    labour_cost: curLabour,
    food_cost: curFood,
    marketing_per_day: 0,
    net_profit: dailyNetProfit(baseline),
    tat_min: round1(baseline.avg_tat_min),
    fixed_cost: fixed,
    service_charge: 0,
    revenue_deductions: 0,
    tax_collected: rupees(curCharges.tax_total),
  };

  // --- Price & elasticity: price moves APC directly; demand answers via elasticity.
  const priceFrac = p.price_adjust_pct / 100;
  const apc2 = rupees(baseline.apc * (1 + priceFrac));
  // Legal extremes keep (1 + e·p) within [0.4, 1.4]; the 0 floor is pure paranoia.
  const demandCovers = Math.max(0, baseline.covers_per_day * (1 + p.elasticity * priceFrac));
  if (priceFrac !== 0) {
    notes.push(`Price ${priceFrac > 0 ? "increase" : "cut"} of ${p.price_adjust_pct}%: APC ₹${current.apc} → ₹${apc2}; demand responds ×${(1 + p.elasticity * priceFrac).toFixed(2)} (elasticity ${p.elasticity}).`);
  }

  // --- Demand-side levers (step 2 of the chain). Retention and no-shows move
  // how many guests WANT a table; they never touch the ceiling below, so a
  // demand lever and a capacity lever can never claim the same cover twice.
  const retentionMult = Math.max(0, 1 + RETENTION_SENSITIVITY * ((p.retention_pct - BASELINE_RETENTION_PCT) / 100));
  if (p.retention_pct !== BASELINE_RETENTION_PCT) {
    notes.push(`Repeat guests ${round1(p.retention_pct)}% vs the ${BASELINE_RETENTION_PCT}% assumed today: demand ×${retentionMult.toFixed(3)} (directional stability effect, not a cohort model).`);
  }
  // No-shows only bite the booked slice of the room (BOOKED_COVERS_SHARE), and
  // only relative to the rate already baked into today's covers.
  const noShowMult = Math.max(0, 1 + BOOKED_COVERS_SHARE * (((100 - p.no_show_pct) / (100 - BASELINE_NO_SHOW_PCT)) - 1));
  if (p.no_show_pct !== BASELINE_NO_SHOW_PCT) {
    notes.push(`No-shows ${round1(p.no_show_pct)}% vs ${BASELINE_NO_SHOW_PCT}% today, on the ${Math.round(BOOKED_COVERS_SHARE * 100)}% of covers that come from bookings: demand ×${noShowMult.toFixed(3)}.`);
  }
  const adjustedDemand = Math.max(0, demandCovers * retentionMult * noShowMult);

  // --- TAT & capacity: expediters lower the achievable TAT; the target cannot
  // beat it; capacity scales as current/effective TAT within [0.5, 1.5].
  const currentTat = round1(baseline.avg_tat_min);
  // Captains and kitchen stations cut the achievable TAT alongside expediters,
  // additively, each measured against the level assumed today (so both are
  // neutral at their defaults). The 10-minute floor still governs the sum.
  const captainTatCut = ((p.captain_share_pct - DEFAULT_CAPTAIN_SHARE_PCT) / 100) * CAPTAIN_TAT_SPAN_MIN;
  const stationTatCut = (p.kitchen_stations - DEFAULT_KITCHEN_STATIONS) * KITCHEN_STATION_TAT_CUT_MIN;
  if (captainTatCut !== 0) {
    notes.push(`Captains at ${round1(p.captain_share_pct)}% of the floor (vs ${DEFAULT_CAPTAIN_SHARE_PCT}%) ${captainTatCut > 0 ? "cut" : "add"} ${round1(Math.abs(captainTatCut))} min of turnaround — captains are the ones who can bark an order before approval.`);
  }
  if (stationTatCut !== 0) {
    notes.push(`${p.kitchen_stations} kitchen station${p.kitchen_stations === 1 ? "" : "s"} (vs ${DEFAULT_KITCHEN_STATIONS}) ${stationTatCut > 0 ? "cut" : "add"} ${round1(Math.abs(stationTatCut))} min of turnaround, separately from expediters.`);
  }
  const achievableTat = Math.max(TAT_FLOOR_MIN, currentTat - p.extra_expediters * EXPEDITER_TAT_CUT_MIN - captainTatCut - stationTatCut);
  const effectiveTat = round1(Math.max(p.tat_target_min, achievableTat));
  if (p.extra_expediters > 0) {
    notes.push(`${p.extra_expediters} extra expediter${p.extra_expediters > 1 ? "s" : ""} cut achievable TAT by ${p.extra_expediters * EXPEDITER_TAT_CUT_MIN} min to ${round1(achievableTat)} min (floor ${TAT_FLOOR_MIN} min), at ₹${EXPEDITER_WAGE_PER_SHIFT}/shift each.`);
  }
  if (p.tat_target_min < achievableTat) {
    notes.push(`TAT target ${p.tat_target_min} min is faster than currently achievable; clamped to ${effectiveTat} min.`);
  }
  // currentTat is 0 only for a hand-built baseline (buildBaseline defaults it to
  // 45); treat that as "no capacity signal" rather than dividing zero by target.
  const capacityMult = currentTat > 0
    ? clamp(currentTat / effectiveTat, CAPACITY_MULT_FLOOR, CAPACITY_MULT_CAP, 1)
    : 1;
  // --- Physical capacity (step 3b). Tables, party size, shifts and attendance
  // scale the SEATS available, expressed as ratios against what the tenant runs
  // today, so each is exactly 1 at its neutral value and the ceiling is
  // untouched. These sit OUTSIDE the [0.5, 1.5] TAT cap: that cap models how
  // much faster one room can turn, not how many rooms/seats/shifts exist.
  const tableRatio = baseline.table_count > 0 ? p.table_count / baseline.table_count : 1;
  const partyRatio = p.avg_party_size / DEFAULT_PARTY_SIZE;
  const attendanceMult = p.staff_attendance_pct / 100;
  const physicalMult = Math.max(0, tableRatio * partyRatio * p.shifts_per_day * attendanceMult);
  if (p.table_count !== baseline.table_count) {
    notes.push(baseline.table_count > 0
      ? `Tables ${p.table_count} vs ${baseline.table_count} measured: seating capacity ×${tableRatio.toFixed(2)}.`
      : `Table count override ignored for capacity: the baseline has no measured tables to scale against.`);
  }
  if (p.avg_party_size !== DEFAULT_PARTY_SIZE) {
    notes.push(`Average party ${round1(p.avg_party_size)} covers/table vs ${DEFAULT_PARTY_SIZE} assumed: covers per turn ×${partyRatio.toFixed(2)}.`);
  }
  if (p.shifts_per_day > 1) {
    notes.push(`${p.shifts_per_day} shifts/day: the covers ceiling AND the wage bill both scale ×${p.shifts_per_day}.`);
  }
  if (p.staff_attendance_pct !== 100) {
    notes.push(`Attendance ${round1(p.staff_attendance_pct)}%: the covers ceiling drops to ${Math.round(attendanceMult * 100)}% — absent staff cost you service capacity, not payroll (wages are modelled on headcount).`);
  }
  const capacityCovers = baseline.covers_per_day * capacityMult * physicalMult;
  const servedFromPrice = Math.min(adjustedDemand, capacityCovers);
  if (capacityMult < 1) {
    notes.push(`Slower turnaround (${effectiveTat} min vs ${currentTat} min) constrains capacity to ${Math.round(capacityMult * 100)}% of current covers.`);
  } else if (capacityMult > 1 && adjustedDemand > capacityCovers) {
    notes.push(`Faster turnaround raises capacity ×${capacityMult.toFixed(2)} (capped at ${CAPACITY_MULT_CAP}), but demand still exceeds it.`);
  } else if (capacityMult > 1) {
    notes.push(`Faster turnaround raises capacity ×${capacityMult.toFixed(2)} (capped at ${CAPACITY_MULT_CAP}); demand, not capacity, limits covers.`);
  }

  // --- Marketing (step 5). Two models, and which one runs is decided by the
  // BODY, not by a constant: send acquisition_per_1000 and you get the linear
  // "guests per ₹1,000" rate that replaces the older curve; omit it and the
  // legacy MARKETING_YIELD·√(spend/APC) diminishing-returns bump is used
  // unchanged, so a caller who only moves the original eight sliders gets
  // exactly the numbers it always got. Either way the covers are assumed
  // absorbed off-peak, so they add on top of the peak-capacity clamp above.
  let marketingCovers = 0;
  if (p.marketing_spend > 0 && apc2 > 0) {
    // ONE model. `acquisition_per_1000` scales the legacy diminishing-returns
    // curve; at DEFAULT_ACQUISITION_PER_1000 the factor is exactly 1, so this
    // reduces to HEAD's arithmetic and an untouched (or absent) lever cannot
    // move the answer. See DEFAULT_ACQUISITION_PER_1000 for why presence-based
    // model switching was wrong.
    const acquisitionScale = p.acquisition_per_1000 / DEFAULT_ACQUISITION_PER_1000;
    const legacyBump = MARKETING_YIELD * Math.sqrt(p.marketing_spend / apc2);
    const wanted = legacyBump * acquisitionScale;
    // The off-peak allowance, bounded — but never below the legacy bump itself,
    // which is what preserves byte-parity with HEAD for the original eight (at
    // scale 1, `wanted === legacyBump <= cap`, so the cap can never bind).
    const cap = Math.max(legacyBump, capacityCovers * MARKETING_OFFPEAK_SHARE);
    marketingCovers = Math.min(wanted, cap);
    if (marketingCovers < wanted) {
      notes.push(`Marketing covers capped at +${round1(marketingCovers)}/day: at ${round1(p.acquisition_per_1000)} guests per ₹1,000 the spend would win ${round1(wanted)} covers, but the room can only absorb about ${Math.round(MARKETING_OFFPEAK_SHARE * 100)}% of its capacity off-peak. Add tables or turns to convert the rest.`);
    } else if (p.acquisition_per_1000 !== DEFAULT_ACQUISITION_PER_1000) {
      notes.push(`₹${rupees(p.marketing_spend)} one-time marketing ≈ +${round1(marketingCovers)} covers/day at ${round1(p.acquisition_per_1000)} guests per ₹1,000 (×${round1(acquisitionScale)} the baseline conversion, on the same √(spend/APC) curve). The spend is NOT amortised into daily net profit; see breakeven_days.`);
    } else {
      notes.push(`₹${rupees(p.marketing_spend)} one-time marketing ≈ +${round1(marketingCovers)} covers/day (${MARKETING_YIELD}·√(spend/APC), diminishing returns). The spend is NOT amortised into daily net profit; see breakeven_days.`);
    }
  } else if (p.marketing_spend > 0) {
    notes.push(`Marketing spend has no modelled effect while APC is ₹0 (no sales history to convert walk-ins against).`);
  } else if (p.acquisition_per_1000 !== DEFAULT_ACQUISITION_PER_1000) {
    notes.push(`Acquisition rate set to ${round1(p.acquisition_per_1000)} guests per ₹1,000, but marketing spend is ₹0, so no covers are added.`);
  }

  // --- Second outlet (step 6). SPECULATIVE: a flat share of the primary's
  // volume, applied last so it scales everything downstream (covers → gross →
  // food) coherently, with site costs doubled below.
  const outletCoverMult = p.second_outlet ? 1 + SECOND_OUTLET_REVENUE_SHARE : 1;
  const outletCostMult = p.second_outlet ? SECOND_OUTLET_COST_MULT : 1;
  if (p.second_outlet) {
    const w = `SPECULATIVE — the second-outlet projection has never been validated end to end. It assumes the new site reaches ${Math.round(SECOND_OUTLET_REVENUE_SHARE * 100)}% of this one's covers at the same APC, and doubles site fixed costs and labour. Treat it as a sketch, not a forecast.`;
    warnings.push(w);
    notes.push(w);
  }
  if (p.second_outlet_blocked) {
    notes.push(`Second outlet not simulated: the ${PLAN_TIERS[p.plan_tier].label} plan does not include multi-outlet (platform.plans grants it to Enterprise only). Switch the plan tier to model it.`);
  }
  const servedCovers = (servedFromPrice + marketingCovers) * outletCoverMult;

  // --- Revenue (steps 8–12). `grossRevenue` is what the kitchen actually
  // served, before any bill-level deduction: it is the base food cost scales
  // on, because a discount does not make the ingredients cheaper.
  const grossRevenue = rupees(servedCovers * apc2);
  const promoDiscount = grossRevenue * (p.discount_depth_pct / 100) * (p.discount_frequency_pct / 100);
  const couponDiscount = servedCovers * (p.coupon_redemption_pct / 100) * p.coupon_avg_value;
  const loyaltyDiscount = servedCovers * (p.loyalty_redemption_pct / 100) * LOYALTY_AVG_REDEMPTION_VALUE;
  const billDiscount = Math.max(0, finite(promoDiscount + couponDiscount + loyaltyDiscount));
  // The REAL pipeline: billing_math.computeBillCharges applies the discount to
  // the subtotal, the service charge to the discounted amount, and tax to the
  // sum — the same order a printed bill uses. Applied once to the day's
  // aggregate, which is exact because every step here is a percentage.
  // computeBillCharges clamps a flat discount to the subtotal, so revenue can
  // never go negative however deep the discounting goes.
  const charges = computeBillCharges(
    grossRevenue,
    [{ name: "Tax", percentage: p.tax_rate_pct }],
    p.service_charge_pct,
    true,
    billDiscount > 0 ? { type: "flat", value: billDiscount } : null,
  );
  if (promoDiscount > 0) {
    notes.push(`Discounting ${round1(p.discount_depth_pct)}% off on ${round1(p.discount_frequency_pct)}% of bills ⇒ −₹${rupees(promoDiscount)}/day off the items subtotal.`);
  }
  if (couponDiscount > 0) {
    notes.push(`Coupons on ${round1(p.coupon_redemption_pct)}% of covers at ₹${rupees(p.coupon_avg_value)} each ⇒ −₹${rupees(couponDiscount)}/day.`);
  }
  if (loyaltyDiscount > 0) {
    notes.push(`Loyalty redemption by ${round1(p.loyalty_redemption_pct)}% of covers at ₹${LOYALTY_AVG_REDEMPTION_VALUE} per redemption (assumed — there is no loyalty ledger to measure) ⇒ −₹${rupees(loyaltyDiscount)}/day.`);
  }
  if (p.service_charge_pct > 0) {
    notes.push(`Service charge ${round1(p.service_charge_pct)}% on the discounted subtotal adds ₹${rupees(charges.service_charge)}/day of revenue (computed by the same billing pipeline the POS prints).`);
  }
  // Aggregator commission is NOT a bill discount — the guest pays full price and
  // the platform keeps its cut — so it comes off after the bill is built.
  // Aggregator covers are assumed to be a re-mix of existing demand, not extra
  // demand, so only the commission bites; nothing here scales covers.
  const aggregatorCommission = Math.max(0, charges.discounted_subtotal * (p.aggregator_mix_pct / 100) * (p.aggregator_commission_pct / 100));
  if (aggregatorCommission > 0) {
    notes.push(`${round1(p.aggregator_mix_pct)}% of covers via aggregators at ${round1(p.aggregator_commission_pct)}% commission ⇒ −₹${rupees(aggregatorCommission)}/day. Aggregator covers are modelled as a re-mix of existing demand, not extra demand.`);
  }
  const simRevenue = rupees(charges.discounted_subtotal + charges.service_charge - aggregatorCommission);
  if (p.tax_rate_pct !== DEFAULT_TAX_RATE_PCT) {
    notes.push(`Tax rate ${round1(p.tax_rate_pct)}% changes the tax line only (₹${rupees(charges.tax_total)}/day). The whole model is pre-tax: revenue and net profit are identical at every tax rate.`);
  }

  // --- Costs (steps 13–15).
  const baseLabour = p.staff_count * p.avg_wage_per_shift + p.extra_expediters * EXPEDITER_WAGE_PER_SHIFT;
  // Overtime is priced off the shift wage (wage ÷ 8h) plus its premium, per
  // shift, so a second shift pays overtime twice.
  const overtimeCost = p.staff_count * p.overtime_hours_per_shift * (p.avg_wage_per_shift / SHIFT_HOURS) * (1 + p.overtime_premium_pct / 100) * p.shifts_per_day;
  const simLabour = rupees((baseLabour * p.shifts_per_day + overtimeCost) * outletCostMult);
  if (simLabour !== curLabour) {
    const extras: string[] = [];
    if (p.shifts_per_day > 1) {extras.push(`×${p.shifts_per_day} shifts`);}
    if (overtimeCost > 0) {extras.push(`+ ₹${rupees(overtimeCost)} overtime`);}
    if (p.second_outlet) {extras.push(`×${SECOND_OUTLET_COST_MULT} for the second outlet`);}
    notes.push(`Labour recomputed from sliders: ${p.staff_count} staff × ₹${rupees(p.avg_wage_per_shift)}/shift${p.extra_expediters > 0 ? ` + ${p.extra_expediters} expediter(s)` : ""}${extras.length > 0 ? ` ${extras.join(" ")}` : ""} = ₹${simLabour}/day.`);
  }
  // Food scales on GROSS (what was cooked), inflated by ingredient prices, plus
  // the wastage ABOVE what a measured food-cost % already contains.
  const effectiveFoodPct = Math.max(0, p.food_cost_pct * (1 + p.ingredient_inflation_pct / 100));
  const wasteDeltaPct = p.waste_pct - BASELINE_WASTE_PCT;
  const simFood = rupees((effectiveFoodPct / 100) * grossRevenue + (wasteDeltaPct / 100) * grossRevenue);
  if (round1(p.food_cost_pct) !== round1(baseline.food_cost_pct)) {
    notes.push(`Food cost set to ${round1(p.food_cost_pct)}% of revenue (baseline ${round1(baseline.food_cost_pct)}%).`);
  }
  if (p.ingredient_inflation_pct !== 0) {
    notes.push(`Ingredient prices ${p.ingredient_inflation_pct > 0 ? "+" : ""}${round1(p.ingredient_inflation_pct)}%: effective food cost ${round1(effectiveFoodPct)}% of revenue.`);
  }
  if (wasteDeltaPct !== 0) {
    notes.push(`Wastage ${round1(p.waste_pct)}% vs the ${BASELINE_WASTE_PCT}% already inside the measured food cost: ${wasteDeltaPct > 0 ? "+" : "−"}₹${rupees(Math.abs((wasteDeltaPct / 100) * grossRevenue))}/day of food cost.`);
  }
  const planFeePerDay = PLAN_TIERS[p.plan_tier].monthly_fee / PLAN_FEE_DAYS;
  // The subscription is billed per account, so it is NOT doubled by a second
  // outlet; rent/utilities are per site, so they are.
  const simFixed = rupees((p.fixed_costs_per_day + p.utilities_per_day) * outletCostMult + planFeePerDay);
  if (p.fixed_costs_per_day !== baseline.fixed_costs_per_day) {
    notes.push(`Fixed costs overridden to ₹${rupees(p.fixed_costs_per_day)}/day (measured ₹${fixed}/day from expense categories).`);
  }
  if (p.utilities_per_day > 0) {
    notes.push(`Extra utilities ₹${rupees(p.utilities_per_day)}/day added to fixed costs.`);
  }
  if (p.plan_tier !== "starter") {
    notes.push(`${PLAN_TIERS[p.plan_tier].label} plan: ₹${PLAN_TIERS[p.plan_tier].monthly_fee.toLocaleString("en-IN")}/month ⇒ +₹${rupees(planFeePerDay)}/day of fixed cost (seeded platform pricing; operators can edit plans).`);
  }

  const simulated: SimulationLine = {
    covers: round1(servedCovers),
    apc: apc2,
    revenue: simRevenue,
    labour_cost: simLabour,
    food_cost: simFood,
    // Informational per-day equivalent of the one-time spend over the window —
    // deliberately EXCLUDED from net_profit (contract: not amortised).
    marketing_per_day: rupees(p.marketing_spend / SIM_WINDOW_DAYS),
    net_profit: rupees(simRevenue - simLabour - simFood - simFixed),
    tat_min: effectiveTat,
    fixed_cost: simFixed,
    service_charge: rupees(charges.service_charge),
    revenue_deductions: rupees(charges.discount + aggregatorCommission),
    tax_collected: rupees(charges.tax_total),
  };

  // --- Delta AFTER rounding, so CURRENT + DELTA = SIMULATED in the rendered table.
  const delta: SimulationLine = {
    covers: round1(simulated.covers - current.covers),
    apc: rupees(simulated.apc - current.apc),
    revenue: rupees(simulated.revenue - current.revenue),
    labour_cost: rupees(simulated.labour_cost - current.labour_cost),
    food_cost: rupees(simulated.food_cost - current.food_cost),
    marketing_per_day: rupees(simulated.marketing_per_day - current.marketing_per_day),
    net_profit: rupees(simulated.net_profit - current.net_profit),
    tat_min: round1(simulated.tat_min - current.tat_min),
    fixed_cost: rupees(simulated.fixed_cost - current.fixed_cost),
    service_charge: rupees(simulated.service_charge - current.service_charge),
    revenue_deductions: rupees(simulated.revenue_deductions - current.revenue_deductions),
    tax_collected: rupees(simulated.tax_collected - current.tax_collected),
  };

  // --- Marketing payback: days of profit uplift needed to recover the spend.
  let breakeven_days: number | null = null;
  if (p.marketing_spend > 0) {
    const uplift = simulated.net_profit - current.net_profit;
    if (uplift > 0) {
      breakeven_days = Math.ceil(p.marketing_spend / Math.max(uplift, BREAKEVEN_EPSILON));
      notes.push(`Marketing pays for itself in ${breakeven_days} day${breakeven_days === 1 ? "" : "s"} at +₹${uplift}/day profit uplift.`);
    } else {
      notes.push(`No daily profit uplift versus current — the marketing spend never breaks even under these settings.`);
    }
  }

  return { current, simulated, delta, notes, breakeven_days, warnings };
}
