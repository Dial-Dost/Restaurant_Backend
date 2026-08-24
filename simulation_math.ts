// Pure what-if simulation math — NO database, network, or native dependencies.
//
// Same contract as billing_math.ts: this module is deliberately free of imports so
// the simulator can be unit-tested in isolation (jest) without loading the heavy
// `database_supabase.ts` graph. The route (routes/simulation.ts) fetches raw
// 30-day aggregates from the data layer and hands them here; everything after
// that — defaults, clamping, the model itself — is deterministic arithmetic.
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

/** Mid-range dining price elasticity of demand (restaurant studies cluster in -1 to -1.5). */
export const DEFAULT_ELASTICITY = -1.3;

/**
 * Floor for the profit-uplift divisor in breakeven_days, so a positive-but-tiny
 * uplift yields a huge finite number, never Infinity. Uplifts are whole rupees,
 * so anything positive is >= 1 and this floor is belt-and-braces only.
 */
export const BREAKEVEN_EPSILON = 0.01;

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
} as const;

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
}

export interface SimulationResult {
  current: SimulationLine;
  simulated: SimulationLine;
  delta: SimulationLine;
  notes: string[];
  breakeven_days: number | null;
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
  return {
    price_adjust_pct: clamp(body.price_adjust_pct, R.price_adjust_pct.min, R.price_adjust_pct.max, 0),
    elasticity: clamp(body.elasticity, R.elasticity.min, R.elasticity.max, DEFAULT_ELASTICITY),
    staff_count: Math.round(clamp(body.staff_count, R.staff_count.min, R.staff_count.max, staffFallback)),
    avg_wage_per_shift: clamp(body.avg_wage_per_shift, R.avg_wage_per_shift.min, R.avg_wage_per_shift.max, wageFallback),
    tat_target_min: clamp(body.tat_target_min, R.tat_target_min.min, R.tat_target_min.max, clamp(baseline.avg_tat_min, R.tat_target_min.min, R.tat_target_min.max, DEFAULT_TAT_MIN)),
    extra_expediters: Math.round(clamp(body.extra_expediters, R.extra_expediters.min, R.extra_expediters.max, 0)),
    marketing_spend: clamp(body.marketing_spend, R.marketing_spend.min, R.marketing_spend.max, 0),
    food_cost_pct: clamp(body.food_cost_pct, R.food_cost_pct.min, R.food_cost_pct.max, baseline.food_cost_pct),
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
  notes.push(`Basis: all ₹ figures are pre-tax (bill subtotal), per day, over a ${SIM_WINDOW_DAYS}-day baseline window.`);

  // --- CURRENT column: the live baseline, restated through the shared identity.
  const curRevenue = rupees(baseline.revenue_per_day);
  const curLabour = rupees(baseline.labour_cost_per_day);
  const curFood = rupees((finite(baseline.food_cost_pct) / 100) * curRevenue);
  const fixed = rupees(baseline.fixed_costs_per_day);
  const current: SimulationLine = {
    covers: round1(baseline.covers_per_day),
    apc: rupees(baseline.apc),
    revenue: curRevenue,
    labour_cost: curLabour,
    food_cost: curFood,
    marketing_per_day: 0,
    net_profit: dailyNetProfit(baseline),
    tat_min: round1(baseline.avg_tat_min),
  };

  // --- Price & elasticity: price moves APC directly; demand answers via elasticity.
  const priceFrac = p.price_adjust_pct / 100;
  const apc2 = rupees(baseline.apc * (1 + priceFrac));
  // Legal extremes keep (1 + e·p) within [0.4, 1.4]; the 0 floor is pure paranoia.
  const demandCovers = Math.max(0, baseline.covers_per_day * (1 + p.elasticity * priceFrac));
  if (priceFrac !== 0) {
    notes.push(`Price ${priceFrac > 0 ? "increase" : "cut"} of ${p.price_adjust_pct}%: APC ₹${current.apc} → ₹${apc2}; demand responds ×${(1 + p.elasticity * priceFrac).toFixed(2)} (elasticity ${p.elasticity}).`);
  }

  // --- TAT & capacity: expediters lower the achievable TAT; the target cannot
  // beat it; capacity scales as current/effective TAT within [0.5, 1.5].
  const currentTat = round1(baseline.avg_tat_min);
  const achievableTat = Math.max(TAT_FLOOR_MIN, currentTat - p.extra_expediters * EXPEDITER_TAT_CUT_MIN);
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
  const capacityCovers = baseline.covers_per_day * capacityMult;
  const servedFromPrice = Math.min(demandCovers, capacityCovers);
  if (capacityMult < 1) {
    notes.push(`Slower turnaround (${effectiveTat} min vs ${currentTat} min) constrains capacity to ${Math.round(capacityMult * 100)}% of current covers.`);
  } else if (capacityMult > 1 && demandCovers > capacityCovers) {
    notes.push(`Faster turnaround raises capacity ×${capacityMult.toFixed(2)} (capped at ${CAPACITY_MULT_CAP}), but demand still exceeds it.`);
  } else if (capacityMult > 1) {
    notes.push(`Faster turnaround raises capacity ×${capacityMult.toFixed(2)} (capped at ${CAPACITY_MULT_CAP}); demand, not capacity, limits covers.`);
  }

  // --- Marketing: diminishing-returns walk-ins (see MARKETING_YIELD). Assumed
  // absorbed off-peak, so they add on top of the peak-capacity clamp above.
  let marketingCovers = 0;
  if (p.marketing_spend > 0 && apc2 > 0) {
    marketingCovers = MARKETING_YIELD * Math.sqrt(p.marketing_spend / apc2);
    notes.push(`₹${rupees(p.marketing_spend)} one-time marketing ≈ +${round1(marketingCovers)} covers/day (${MARKETING_YIELD}·√(spend/APC), diminishing returns). The spend is NOT amortised into daily net profit; see breakeven_days.`);
  } else if (p.marketing_spend > 0) {
    notes.push(`Marketing spend has no modelled effect while APC is ₹0 (no sales history to convert walk-ins against).`);
  }

  const servedCovers = servedFromPrice + marketingCovers;

  // --- Daily P&L of the simulated day.
  const simRevenue = rupees(servedCovers * apc2);
  const simLabour = rupees(p.staff_count * p.avg_wage_per_shift + p.extra_expediters * EXPEDITER_WAGE_PER_SHIFT);
  if (simLabour !== curLabour) {
    notes.push(`Labour recomputed from sliders: ${p.staff_count} staff × ₹${rupees(p.avg_wage_per_shift)}/shift${p.extra_expediters > 0 ? ` + ${p.extra_expediters} expediter(s)` : ""} = ₹${simLabour}/day.`);
  }
  const simFood = rupees((p.food_cost_pct / 100) * simRevenue);
  if (round1(p.food_cost_pct) !== round1(baseline.food_cost_pct)) {
    notes.push(`Food cost set to ${round1(p.food_cost_pct)}% of revenue (baseline ${round1(baseline.food_cost_pct)}%).`);
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
    net_profit: rupees(simRevenue - simLabour - simFood - fixed),
    tat_min: effectiveTat,
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

  return { current, simulated, delta, notes, breakeven_days };
}
