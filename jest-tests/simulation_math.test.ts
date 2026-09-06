import { describe, test, expect } from "@jest/globals";
import {
  buildBaseline,
  dailyNetProfit,
  resolveParams,
  runSimulation,
  DEFAULT_FOOD_COST_PCT,
  DEFAULT_TAT_MIN,
  EXPEDITER_WAGE_PER_SHIFT,
  CAPACITY_MULT_CAP,
  CAPACITY_MULT_FLOOR,
  TAT_FLOOR_MIN,
  SIM_WINDOW_DAYS,
  DEFAULT_ACQUISITION_PER_1000,
  MARKETING_OFFPEAK_SHARE,
  PARAM_RANGES,
  PARAM_CATALOG,
  PLAN_TIERS,
  PLAN_FEE_DAYS,
  BASELINE_WASTE_PCT,
  BASELINE_NO_SHOW_PCT,
  BASELINE_RETENTION_PCT,
  BOOKED_COVERS_SHARE,
  RETENTION_SENSITIVITY,
  DEFAULT_PARTY_SIZE,
  DEFAULT_CAPTAIN_SHARE_PCT,
  DEFAULT_KITCHEN_STATIONS,
  CAPTAIN_TAT_SPAN_MIN,
  KITCHEN_STATION_TAT_CUT_MIN,
  LOYALTY_AVG_REDEMPTION_VALUE,
  SECOND_OUTLET_REVENUE_SHARE,
  SECOND_OUTLET_COST_MULT,
  SHIFT_HOURS,
  DEFAULT_TAX_RATE_PCT,
  type SimulationRawStats,
  type SimulationBaseline,
  type SimulationLine,
  type SimulationResult,
  type SimulationParams,
} from "../simulation_math";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A healthy mid-size tenant: ~₹40k/day pre-tax, 100 covers/day, APC ₹400. */
function healthyRaw(): SimulationRawStats {
  return {
    window_days: 30,
    bill_count: 900,
    pretax_revenue_total: 1_200_000, // ₹40,000/day
    covers_total: 3000,              // 100/day, APC = 400
    avg_tat_min: 42,
    staff_count: 12,
    table_count: 18,
    expense_categories: [
      { category: "Food & Ingredients", amount: 384_000 }, // 32% of pre-tax
      { category: "Salaries", amount: 180_000 },           // ₹6,000/day
      { category: "Rent", amount: 150_000 },               // ₹5,000/day fixed
    ],
    payroll_monthly_wage_bill: 0,
  };
}

/** A brand-new tenant: no bills, no sessions, no expenses, no payroll, no staff. */
function emptyRaw(): SimulationRawStats {
  return {
    window_days: 30,
    bill_count: 0,
    pretax_revenue_total: 0,
    covers_total: 0,
    avg_tat_min: null,
    staff_count: 0,
    table_count: 0,
    expense_categories: [],
    payroll_monthly_wage_bill: 0,
  };
}

const LINE_KEYS: (keyof SimulationLine)[] = [
  "covers", "apc", "revenue", "labour_cost", "food_cost", "marketing_per_day", "net_profit", "tat_min",
];

function expectAllFinite(result: SimulationResult): void {
  for (const key of LINE_KEYS) {
    expect(Number.isFinite(result.current[key])).toBe(true);
    expect(Number.isFinite(result.simulated[key])).toBe(true);
    expect(Number.isFinite(result.delta[key])).toBe(true);
  }
  if (result.breakeven_days !== null) {
    expect(Number.isFinite(result.breakeven_days)).toBe(true);
  }
}

function expectBaselineFinite(b: SimulationBaseline): void {
  const numericKeys = Object.keys(b).filter((k) => k !== "sources") as (keyof Omit<SimulationBaseline, "sources">)[];
  for (const key of numericKeys) {
    expect(Number.isFinite(b[key])).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// buildBaseline
// ---------------------------------------------------------------------------

describe("buildBaseline", () => {
  test("healthy tenant: every field measured from the window", () => {
    const b = buildBaseline(healthyRaw());
    expect(b.window_days).toBe(30);
    expect(b.covers_per_day).toBe(100);
    expect(b.apc).toBe(400);
    expect(b.revenue_per_day).toBe(40_000);
    expect(b.food_cost_pct).toBe(32);
    expect(b.labour_cost_per_day).toBe(6_000);
    expect(b.staff_count).toBe(12);
    expect(b.avg_tat_min).toBe(42);
    expect(b.table_count).toBe(18);
    expect(b.fixed_costs_per_day).toBe(5_000);
    // net = 40000 - 6000 - 12800 (32%) - 5000
    expect(b.net_profit_per_day).toBe(16_200);
    expect(Object.values(b.sources)).not.toContain("default");
  });

  test("labour falls back to configured payroll when no labour expenses", () => {
    const raw = healthyRaw();
    raw.expense_categories = raw.expense_categories.filter((e) => e.category !== "Salaries");
    raw.payroll_monthly_wage_bill = 210_000;
    const b = buildBaseline(raw);
    expect(b.labour_cost_per_day).toBe(7_000);
    expect(b.sources.labour_cost_per_day).toBe("measured");
  });

  test("no payroll and no labour expenses: headcount default, marked default", () => {
    const raw = healthyRaw();
    raw.expense_categories = raw.expense_categories.filter((e) => e.category !== "Salaries");
    const b = buildBaseline(raw);
    expect(b.labour_cost_per_day).toBe(12 * 450);
    expect(b.sources.labour_cost_per_day).toBe("default");
  });

  test("dailyNetProfit identity matches the baseline's own net figure", () => {
    const b = buildBaseline(healthyRaw());
    expect(dailyNetProfit(b)).toBe(b.net_profit_per_day);
  });
});

// ---------------------------------------------------------------------------
// The reference bug: an empty tenant must produce finite zeros, never ₹NaN.
// ---------------------------------------------------------------------------

describe("empty tenant (the reference implementation's ₹NaN bug)", () => {
  test("baseline of a tenant with zero bills is all finite zeros with default markers", () => {
    const b = buildBaseline(emptyRaw());
    expectBaselineFinite(b);
    expect(b.covers_per_day).toBe(0);
    expect(b.apc).toBe(0);
    expect(b.revenue_per_day).toBe(0);
    expect(b.labour_cost_per_day).toBe(0);
    expect(b.fixed_costs_per_day).toBe(0);
    expect(b.net_profit_per_day).toBe(0);
    // The two non-₹ model inputs keep usable defaults instead of zero…
    expect(b.food_cost_pct).toBe(DEFAULT_FOOD_COST_PCT);
    expect(b.avg_tat_min).toBe(DEFAULT_TAT_MIN);
    // …and everything unmeasured is honestly flagged.
    expect(b.sources.covers_per_day).toBe("default");
    expect(b.sources.apc).toBe("default");
    expect(b.sources.revenue_per_day).toBe("default");
    expect(b.sources.food_cost_pct).toBe("default");
    expect(b.sources.avg_tat_min).toBe("default");
    expect(b.sources.labour_cost_per_day).toBe("default");
    expect(b.sources.net_profit_per_day).toBe("default");
  });

  test("running every slider against an all-zero baseline yields finite numbers in every cell", () => {
    const b = buildBaseline(emptyRaw());
    const r = runSimulation(b, {
      price_adjust_pct: 30,
      elasticity: -2,
      staff_count: 10,
      avg_wage_per_shift: 500,
      tat_target_min: 10,
      extra_expediters: 5,
      marketing_spend: 100_000,
      food_cost_pct: 60,
    });
    expectAllFinite(r);
    // Zero APC ⇒ marketing has nothing to convert against and never breaks even.
    expect(r.simulated.revenue).toBe(0);
    expect(r.breakeven_days).toBeNull();
    // Labour is still a real, finite cost — net goes negative, not NaN.
    expect(r.simulated.labour_cost).toBe(10 * 500 + 5 * EXPEDITER_WAGE_PER_SHIFT);
    expect(r.simulated.net_profit).toBe(-r.simulated.labour_cost);
  });

  test("garbage raw stats (NaN/Infinity smuggled in) still produce a finite baseline", () => {
    const raw = emptyRaw();
    raw.pretax_revenue_total = Number.NaN;
    raw.covers_total = Number.POSITIVE_INFINITY as unknown as number;
    raw.avg_tat_min = Number.NaN;
    const b = buildBaseline(raw);
    expectBaselineFinite(b);
    expectAllFinite(runSimulation(b, {}));
  });
});

// ---------------------------------------------------------------------------
// runSimulation — happy path and neutrality
// ---------------------------------------------------------------------------

describe("runSimulation happy path", () => {
  test("neutral sliders reproduce the current column (delta ≈ 0 everywhere)", () => {
    const b = buildBaseline(healthyRaw());
    // wage = labour/staff = 6000/12 = 500 exactly, so neutrality is exact here.
    const r = runSimulation(b, {});
    expectAllFinite(r);
    for (const key of LINE_KEYS) {
      expect(r.delta[key]).toBe(0);
    }
    expect(r.breakeven_days).toBeNull();
  });

  test("current column restates the live baseline", () => {
    const b = buildBaseline(healthyRaw());
    const r = runSimulation(b, { price_adjust_pct: 10 });
    expect(r.current.covers).toBe(100);
    expect(r.current.apc).toBe(400);
    expect(r.current.revenue).toBe(40_000);
    expect(r.current.labour_cost).toBe(6_000);
    expect(r.current.food_cost).toBe(12_800);
    expect(r.current.marketing_per_day).toBe(0);
    expect(r.current.net_profit).toBe(16_200);
    expect(r.current.tat_min).toBe(42);
  });

  test("price rise: APC up, covers down via elasticity, delta = simulated - current", () => {
    const b = buildBaseline(healthyRaw());
    const r = runSimulation(b, { price_adjust_pct: 10, elasticity: -1.3 });
    expect(r.simulated.apc).toBe(440);                      // 400 × 1.10
    expect(r.simulated.covers).toBe(87);                    // 100 × (1 − 1.3×0.10)
    expect(r.simulated.revenue).toBe(Math.round(87 * 440)); // 38,280
    for (const key of LINE_KEYS) {
      expect(r.delta[key]).toBe(
        key === "covers" || key === "tat_min"
          ? Math.round((r.simulated[key] - r.current[key]) * 10) / 10
          : r.simulated[key] - r.current[key],
      );
    }
    expect(r.notes.some((n) => n.includes("Price increase"))).toBe(true);
  });

  test("marketing spend: extra covers, uplift, and a finite breakeven", () => {
    const b = buildBaseline(healthyRaw());
    const r = runSimulation(b, { marketing_spend: 10_000 });
    // 0.6·√(10000/400) = 3 extra covers/day at APC 400 ⇒ +₹1,200 revenue/day.
    expect(r.simulated.covers).toBe(103);
    expect(r.delta.revenue).toBe(1_200);
    // Marketing is reported per-day but NOT amortised into net profit:
    expect(r.simulated.marketing_per_day).toBe(Math.round(10_000 / SIM_WINDOW_DAYS));
    expect(r.delta.net_profit).toBe(r.delta.revenue - r.delta.food_cost);
    // breakeven = ceil(10000 / uplift)
    expect(r.breakeven_days).toBe(Math.ceil(10_000 / r.delta.net_profit));
    expectAllFinite(r);
  });
});

// ---------------------------------------------------------------------------
// Slider extremes: every slider at min, every slider at max
// ---------------------------------------------------------------------------

describe("slider extremes stay finite", () => {
  test("every slider at its minimum", () => {
    const b = buildBaseline(healthyRaw());
    const r = runSimulation(b, {
      price_adjust_pct: -20,
      elasticity: -2,
      staff_count: 1,
      avg_wage_per_shift: 100,
      tat_target_min: 10,
      extra_expediters: 0,
      marketing_spend: 0,
      food_cost_pct: 20,
    });
    expectAllFinite(r);
    // Price cut with strong elasticity: demand ×1.4 but capacity caps servings.
    expect(r.simulated.apc).toBe(320);
    expect(r.simulated.covers).toBeLessThanOrEqual(100 * CAPACITY_MULT_CAP);
    expect(r.breakeven_days).toBeNull(); // no spend
  });

  test("every slider at its maximum", () => {
    const b = buildBaseline(healthyRaw());
    const r = runSimulation(b, {
      price_adjust_pct: 30,
      elasticity: -0.5,
      staff_count: 60,
      avg_wage_per_shift: 2000,
      tat_target_min: 60,
      extra_expediters: 5,
      marketing_spend: 100_000,
      food_cost_pct: 60,
    });
    expectAllFinite(r);
    expect(r.simulated.apc).toBe(520);
    expect(r.simulated.labour_cost).toBe(60 * 2000 + 5 * EXPEDITER_WAGE_PER_SHIFT);
    // TAT target 60 > current 42 ⇒ the slower target is honoured as-is.
    expect(r.simulated.tat_min).toBe(60);
  });

  test("out-of-range curl values are clamped, not rejected and not propagated", () => {
    const b = buildBaseline(healthyRaw());
    const p = resolveParams({
      price_adjust_pct: 999,
      elasticity: 5,           // wrong sign — clamped into [-2, -0.5]
      staff_count: -3,
      avg_wage_per_shift: 1e9,
      tat_target_min: 0,
      extra_expediters: 99,
      marketing_spend: -500,
      food_cost_pct: "garbage",
    }, b);
    expect(p.price_adjust_pct).toBe(30);
    expect(p.elasticity).toBe(-0.5);
    expect(p.staff_count).toBe(1);
    expect(p.avg_wage_per_shift).toBe(2000);
    expect(p.tat_target_min).toBe(10);
    expect(p.extra_expediters).toBe(5);
    expect(p.marketing_spend).toBe(0);
    expect(p.food_cost_pct).toBe(b.food_cost_pct); // garbage → baseline value
    expectAllFinite(runSimulation(b, { elasticity: Number.NaN, marketing_spend: Number.POSITIVE_INFINITY }));
  });
});

// ---------------------------------------------------------------------------
// Elasticity sign behaviour
// ---------------------------------------------------------------------------

describe("elasticity sign behaviour", () => {
  test("price UP always lowers demand; stronger elasticity lowers it more", () => {
    const b = buildBaseline(healthyRaw());
    const weak = runSimulation(b, { price_adjust_pct: 20, elasticity: -0.5 });
    const strong = runSimulation(b, { price_adjust_pct: 20, elasticity: -2 });
    expect(weak.simulated.covers).toBeLessThan(b.covers_per_day);
    expect(strong.simulated.covers).toBeLessThan(weak.simulated.covers);
    // Weak elasticity: the price rise still pays. 90 × 480 > 40,000.
    expect(weak.delta.revenue).toBeGreaterThan(0);
    // Strong elasticity: volume collapse outweighs the higher APC. 60 × 480 < 40,000.
    expect(strong.delta.revenue).toBeLessThan(0);
  });

  test("price DOWN raises demand (negative elasticity, negative price change)", () => {
    const b = buildBaseline(healthyRaw());
    const r = runSimulation(b, { price_adjust_pct: -10, elasticity: -1.3, tat_target_min: 30, extra_expediters: 5 });
    // Demand 100×1.13 = 113; capacity 42/30 = 1.4 ⇒ 140. Demand is the binding limit.
    expect(r.simulated.covers).toBe(113);
    expect(r.simulated.apc).toBe(360);
  });
});

// ---------------------------------------------------------------------------
// Capacity clamp, both directions
// ---------------------------------------------------------------------------

describe("capacity clamp", () => {
  test("faster TAT multiplies capacity but never above the 1.5 cap", () => {
    const b = buildBaseline(healthyRaw()); // current TAT 42
    // Huge demand via price cut; TAT target 10 min with 5 expediters:
    // achievable = max(10, 42−15) = 27 ⇒ effective 27 ⇒ raw mult 42/27 ≈ 1.556 → capped 1.5.
    const r = runSimulation(b, { price_adjust_pct: -20, elasticity: -2, tat_target_min: 10, extra_expediters: 5 });
    // Demand 100×1.4 = 140; capacity 100×1.5 = 150 ⇒ demand-bound at 140.
    expect(r.simulated.covers).toBe(140);
    const capped = runSimulation(b, { price_adjust_pct: -20, elasticity: -2, tat_target_min: 10, extra_expediters: 0 });
    // Without expediters achievable = 42 ⇒ no capacity change ⇒ served min(140, 100) = 100.
    expect(capped.simulated.covers).toBe(100);
    expect(capped.notes.some((n) => n.includes("clamped"))).toBe(true);
  });

  test("a slower target constrains capacity below demand, floored at 0.5", () => {
    const b = buildBaseline(healthyRaw()); // current TAT 42
    const r = runSimulation(b, { tat_target_min: 60 });
    // mult = 42/60 = 0.7 ⇒ 70 covers served though demand stays 100.
    expect(r.simulated.covers).toBe(70);
    expect(r.simulated.tat_min).toBe(60);
    expect(r.delta.covers).toBe(-30);
    expect(r.notes.some((n) => n.includes("constrains capacity"))).toBe(true);
    // The floor: even an absurdly slow target can't model away more than half the room.
    const floored = runSimulation({ ...b, avg_tat_min: 12 }, { tat_target_min: 60 });
    // raw mult 12/60 = 0.2 → floored at 0.5 ⇒ 50 covers.
    expect(floored.simulated.covers).toBe(100 * CAPACITY_MULT_FLOOR);
  });

  test("expediters respect the 10-minute TAT floor", () => {
    const b = buildBaseline(healthyRaw());
    const fast = { ...b, avg_tat_min: 14 };
    const r = runSimulation(fast, { tat_target_min: 10, extra_expediters: 5 });
    // achievable = max(10, 14−15) = TAT_FLOOR_MIN, not negative.
    expect(r.simulated.tat_min).toBe(TAT_FLOOR_MIN);
    expectAllFinite(r);
  });
});

// ---------------------------------------------------------------------------
// Breakeven
// ---------------------------------------------------------------------------

describe("breakeven_days", () => {
  test("null when there is no marketing spend at all", () => {
    const b = buildBaseline(healthyRaw());
    expect(runSimulation(b, { price_adjust_pct: 10 }).breakeven_days).toBeNull();
  });

  test("null when spend produces no profit uplift (uplift <= 0)", () => {
    const b = buildBaseline(healthyRaw());
    // Marketing spend but a simultaneous wage explosion sinks daily profit.
    const r = runSimulation(b, { marketing_spend: 50_000, staff_count: 60, avg_wage_per_shift: 2000 });
    expect(r.delta.net_profit).toBeLessThan(0);
    expect(r.breakeven_days).toBeNull();
    expect(r.notes.some((n) => n.includes("never breaks even"))).toBe(true);
  });

  test("positive uplift: breakeven = ceil(spend / uplift), finite and > 0", () => {
    const b = buildBaseline(healthyRaw());
    const r = runSimulation(b, { marketing_spend: 40_000 });
    expect(r.delta.net_profit).toBeGreaterThan(0);
    expect(r.breakeven_days).toBe(Math.ceil(40_000 / r.delta.net_profit));
    expect(r.breakeven_days!).toBeGreaterThan(0);
    expect(Number.isFinite(r.breakeven_days!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Extended levers — the catalog itself
// ---------------------------------------------------------------------------

/** Every key a SimulationLine carries, read off a real result (not hardcoded). */
function allLineKeys(): (keyof SimulationLine)[] {
  const probe = runSimulation(buildBaseline(healthyRaw()), {});
  return Object.keys(probe.current) as (keyof SimulationLine)[];
}

describe("PARAM_CATALOG", () => {
  test("every numeric lever's catalog range is exactly its PARAM_RANGES range", () => {
    const ranges = PARAM_RANGES as unknown as Record<string, { min: number; max: number }>;
    for (const spec of PARAM_CATALOG) {
      if (spec.kind !== "number") { continue; }
      expect(ranges[spec.key]).toBeDefined();
      expect(spec.min).toBe(ranges[spec.key]!.min);
      expect(spec.max).toBe(ranges[spec.key]!.max);
      expect(spec.step!).toBeGreaterThan(0);
    }
  });

  test("the original eight keep their documented ranges (a wider slider would silently snap)", () => {
    expect(PARAM_RANGES.price_adjust_pct).toEqual({ min: -20, max: 30 });
    expect(PARAM_RANGES.elasticity).toEqual({ min: -2, max: -0.5 });
    expect(PARAM_RANGES.staff_count).toEqual({ min: 1, max: 60 });
    expect(PARAM_RANGES.avg_wage_per_shift).toEqual({ min: 100, max: 2000 });
    expect(PARAM_RANGES.tat_target_min).toEqual({ min: 10, max: 60 });
    expect(PARAM_RANGES.extra_expediters).toEqual({ min: 0, max: 5 });
    expect(PARAM_RANGES.marketing_spend).toEqual({ min: 0, max: 100000 });
    expect(PARAM_RANGES.food_cost_pct).toEqual({ min: 20, max: 60 });
  });

  test("every catalog entry is resolvable, and every lever the model reads is catalogued", () => {
    const b = buildBaseline(healthyRaw());
    const resolved = resolveParams({}, b) as unknown as Record<string, unknown>;
    for (const spec of PARAM_CATALOG) {
      expect(resolved[spec.key]).toBeDefined();
    }
    // The catalog is the UI source of truth, so it must cover every resolved
    // lever (internal bookkeeping fields excluded).
    const internal = new Set(["second_outlet_blocked"]);
    for (const key of Object.keys(resolved)) {
      if (internal.has(key)) { continue; }
      expect(PARAM_CATALOG.some((s) => s.key === key)).toBe(true);
    }
  });

  test("levers whose neutral value is the tenant's own measurement say so", () => {
    const measured = PARAM_CATALOG.filter((s) => s.default === null);
    expect(measured.map((s) => s.key).sort()).toEqual(
      ["avg_wage_per_shift", "fixed_costs_per_day", "food_cost_pct", "staff_count", "table_count", "tat_target_min"].sort(),
    );
    for (const spec of measured) { expect(spec.default_from).toBeTruthy(); }
  });
});

// ---------------------------------------------------------------------------
// Neutrality: an untouched lever must not move a single cell
// ---------------------------------------------------------------------------

/**
 * The body a UI sends when nothing has been touched: every catalog default,
 * with the per-tenant ones resolved off the live baseline (what "reset" does).
 */
function neutralBody(b: SimulationBaseline): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const spec of PARAM_CATALOG) {
    if (spec.default === null) {
      body[spec.key] = spec.key === "avg_wage_per_shift"
        ? b.labour_cost_per_day / Math.max(1, b.staff_count)
        : (b as unknown as Record<string, number>)[spec.default_from as string];
    } else {
      body[spec.key] = spec.default;
    }
  }
  return body;
}

describe("extended levers are neutral at their defaults", () => {
  test("an empty body leaves every cell — including the new ones — at delta 0", () => {
    const b = buildBaseline(healthyRaw());
    const r = runSimulation(b, {});
    for (const key of allLineKeys()) { expect(r.delta[key]).toBe(0); }
    expect(r.warnings).toEqual([]);
  });

  test("a full body of catalog defaults is identical to an empty body", () => {
    const b = buildBaseline(healthyRaw());
    const empty = runSimulation(b, {});
    const full = runSimulation(b, neutralBody(b) as SimulationParams);
    expect(full.current).toEqual(empty.current);
    expect(full.simulated).toEqual(empty.simulated);
    expect(full.delta).toEqual(empty.delta);
    for (const key of allLineKeys()) { expect(full.delta[key]).toBe(0); }
  });

  test("the same holds for a tenant whose measurements sit OUTSIDE the new slider ranges", () => {
    // 4 tables (slider min 20) and ₹30,000/day of rent (slider max ₹20,000):
    // echoing those measured values back must not clamp them into a different
    // simulation, or an untouched screen would silently change the answer.
    const raw = healthyRaw();
    raw.table_count = 4;
    raw.expense_categories = [{ category: "Rent", amount: 900_000 }, { category: "Salaries", amount: 180_000 }];
    const b = buildBaseline(raw);
    expect(b.table_count).toBe(4);
    expect(b.fixed_costs_per_day).toBe(30_000);
    const empty = runSimulation(b, {});
    const full = runSimulation(b, neutralBody(b) as SimulationParams);
    expect(full.simulated).toEqual(empty.simulated);
    for (const key of allLineKeys()) { expect(full.delta[key]).toBe(0); }
    // …and they are still overridable in the direction the slider allows.
    expect(resolveParams({ table_count: 30 }, b).table_count).toBe(30);
    expect(resolveParams({ fixed_costs_per_day: 12_000 }, b).fixed_costs_per_day).toBe(12_000);
  });
});

// ---------------------------------------------------------------------------
// tax_rate_pct: display only. THE contract test.
// ---------------------------------------------------------------------------

describe("tax_rate_pct never moves money", () => {
  test("sweeping the whole range leaves every ₹ figure except the tax line untouched", () => {
    const b = buildBaseline(healthyRaw());
    // A body with plenty of moving parts, so the claim is not tested on zeros.
    const busy = {
      price_adjust_pct: 7, staff_count: 15, marketing_spend: 20_000,
      discount_depth_pct: 10, discount_frequency_pct: 40, service_charge_pct: 5,
      aggregator_mix_pct: 20, waste_pct: 6, utilities_per_day: 1_000,
    };
    const reference = runSimulation(b, busy);
    for (let rate = PARAM_RANGES.tax_rate_pct.min; rate <= PARAM_RANGES.tax_rate_pct.max; rate += 0.5) {
      const r = runSimulation(b, { ...busy, tax_rate_pct: rate });
      expect(r.simulated.net_profit).toBe(reference.simulated.net_profit);
      expect(r.current.net_profit).toBe(reference.current.net_profit);
      expect(r.delta.net_profit).toBe(reference.delta.net_profit);
      expect(r.simulated.revenue).toBe(reference.simulated.revenue);
      expect(r.simulated.food_cost).toBe(reference.simulated.food_cost);
      expect(r.simulated.labour_cost).toBe(reference.simulated.labour_cost);
      expect(r.simulated.fixed_cost).toBe(reference.simulated.fixed_cost);
      expect(r.simulated.covers).toBe(reference.simulated.covers);
      expect(r.breakeven_days).toBe(reference.breakeven_days);
      expect(Number.isFinite(r.simulated.tax_collected)).toBe(true);
    }
  });

  test("it does move the (display-only) tax line, and says so", () => {
    const b = buildBaseline(healthyRaw());
    const low = runSimulation(b, { tax_rate_pct: 0 });
    const high = runSimulation(b, { tax_rate_pct: 18 });
    expect(low.simulated.tax_collected).toBe(0);
    expect(high.simulated.tax_collected).toBe(Math.round(40_000 * 0.18));
    expect(high.current.tax_collected).toBe(Math.round(40_000 * 0.18));
    expect(high.delta.tax_collected).toBe(0); // revenue unchanged ⇒ tax unchanged
    expect(high.simulated.net_profit).toBe(low.simulated.net_profit);
    expect(high.notes.some((n) => n.includes("tax line only"))).toBe(true);
    // The default rate is silent — a lever nobody moved must not add a note.
    expect(runSimulation(b, { tax_rate_pct: DEFAULT_TAX_RATE_PCT }).notes)
      .toEqual(runSimulation(b, {}).notes);
  });
});

// ---------------------------------------------------------------------------
// Pricing & demand levers
// ---------------------------------------------------------------------------

describe("pricing and demand levers", () => {
  test("discount depth × frequency comes off revenue, never off APC or food cost", () => {
    const b = buildBaseline(healthyRaw());
    const r = runSimulation(b, { discount_depth_pct: 10, discount_frequency_pct: 50 });
    expect(r.simulated.apc).toBe(400);                 // APC is the menu price, not the realised one
    expect(r.simulated.covers).toBe(100);
    expect(r.simulated.revenue).toBe(38_000);          // 40,000 − 10% × 50%
    expect(r.simulated.revenue_deductions).toBe(2_000);
    expect(r.simulated.food_cost).toBe(12_800);        // discounts do not make ingredients cheaper
    expect(r.delta.net_profit).toBe(-2_000);
    expect(r.notes.some((n) => n.includes("Discounting"))).toBe(true);
  });

  test("depth without frequency (and vice versa) changes nothing", () => {
    const b = buildBaseline(healthyRaw());
    expect(runSimulation(b, { discount_depth_pct: 30 }).delta.revenue).toBe(0);
    expect(runSimulation(b, { discount_frequency_pct: 100 }).delta.revenue).toBe(0);
  });

  test("coupons and loyalty are per-cover ₹ redemptions", () => {
    const b = buildBaseline(healthyRaw());
    const coupons = runSimulation(b, { coupon_redemption_pct: 50, coupon_avg_value: 100 });
    expect(coupons.simulated.revenue).toBe(35_000);    // 100 covers × 50% × ₹100
    const loyalty = runSimulation(b, { loyalty_redemption_pct: 30 });
    expect(loyalty.simulated.revenue).toBe(40_000 - 100 * 0.3 * LOYALTY_AVG_REDEMPTION_VALUE);
    expect(loyalty.notes.some((n) => n.includes("no loyalty ledger"))).toBe(true);
  });

  test("discounts can never drive revenue below zero (the flat discount is clamped)", () => {
    const b = buildBaseline(healthyRaw());
    const r = runSimulation(b, {
      discount_depth_pct: 30, discount_frequency_pct: 100,
      coupon_redemption_pct: 50, coupon_avg_value: 500,
      loyalty_redemption_pct: 30,
    });
    expect(r.simulated.revenue).toBe(0);
    expect(Number.isFinite(r.simulated.net_profit)).toBe(true);
  });

  test("service charge runs through the real billing pipeline: discount first, then charge", () => {
    const b = buildBaseline(healthyRaw());
    const plain = runSimulation(b, { service_charge_pct: 10 });
    expect(plain.simulated.service_charge).toBe(4_000);
    expect(plain.simulated.revenue).toBe(44_000);
    expect(plain.delta.net_profit).toBe(4_000);
    // With a discount, the charge is levied on the DISCOUNTED subtotal (₹38,000).
    const discounted = runSimulation(b, { service_charge_pct: 10, discount_depth_pct: 10, discount_frequency_pct: 50 });
    expect(discounted.simulated.service_charge).toBe(3_800);
    expect(discounted.simulated.revenue).toBe(41_800);
  });

  test("party size scales the covers ceiling, and only the ceiling", () => {
    const b = buildBaseline(healthyRaw());
    // Half the party size ⇒ half the seats ⇒ capacity, not demand, binds.
    const small = runSimulation(b, { avg_party_size: DEFAULT_PARTY_SIZE / 2 });
    expect(small.simulated.covers).toBe(50);
    // A bigger party lifts the ceiling, but demand (100) still limits covers.
    const big = runSimulation(b, { avg_party_size: 6 });
    expect(big.simulated.covers).toBe(100);
    expect(big.notes.some((n) => n.includes("covers per turn"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Staffing levers
// ---------------------------------------------------------------------------

describe("staffing levers", () => {
  test("shifts multiply BOTH the wage bill and the covers ceiling", () => {
    const b = buildBaseline(healthyRaw());
    const r = runSimulation(b, { shifts_per_day: 2 });
    expect(r.simulated.labour_cost).toBe(12_000);
    // The ceiling doubles, but demand is unchanged, so covers do not.
    expect(r.simulated.covers).toBe(100);
    // Halve the seats and the doubled shift genuinely wins them back.
    const tight = runSimulation(b, { avg_party_size: DEFAULT_PARTY_SIZE / 2 });
    const tightTwoShifts = runSimulation(b, { avg_party_size: DEFAULT_PARTY_SIZE / 2, shifts_per_day: 2 });
    expect(tight.simulated.covers).toBe(50);
    expect(tightTwoShifts.simulated.covers).toBe(100);
    expect(r.notes.some((n) => n.includes("shifts/day"))).toBe(true);
  });

  test("overtime = staff × hours × (wage ÷ 8) × premium, per shift", () => {
    const b = buildBaseline(healthyRaw()); // 12 staff, neutral wage ₹500
    const r = runSimulation(b, { overtime_hours_per_shift: 2, overtime_premium_pct: 50 });
    const expected = 12 * 2 * (500 / SHIFT_HOURS) * 1.5;
    expect(expected).toBe(2_250);
    expect(r.simulated.labour_cost).toBe(6_000 + 2_250);
    expect(r.notes.some((n) => n.includes("overtime"))).toBe(true);
    // A premium with no hours is free.
    expect(runSimulation(b, { overtime_premium_pct: 100 }).simulated.labour_cost).toBe(6_000);
  });

  test("attendance cuts the covers ceiling but not the payroll", () => {
    const b = buildBaseline(healthyRaw());
    const r = runSimulation(b, { staff_attendance_pct: 70 });
    expect(r.simulated.covers).toBe(70);
    expect(r.simulated.labour_cost).toBe(6_000);
    expect(r.notes.some((n) => n.includes("not payroll"))).toBe(true);
  });

  test("captains cut turnaround, separately from expediters, and never below the floor", () => {
    const b = buildBaseline(healthyRaw()); // TAT 42
    const r = runSimulation(b, { captain_share_pct: 100, tat_target_min: 10 });
    const cut = ((100 - DEFAULT_CAPTAIN_SHARE_PCT) / 100) * CAPTAIN_TAT_SPAN_MIN;
    expect(cut).toBe(3.2);
    expect(r.simulated.tat_min).toBe(42 - 3.2);
    // Fewer captains than assumed is a penalty, not a no-op.
    expect(runSimulation(b, { captain_share_pct: 0, tat_target_min: 10 }).simulated.tat_min).toBe(42.8);
    // The floor still governs when every TAT lever is pushed at once.
    const floored = runSimulation({ ...b, avg_tat_min: 14 }, { captain_share_pct: 100, kitchen_stations: 8, extra_expediters: 5, tat_target_min: 10 });
    expect(floored.simulated.tat_min).toBe(TAT_FLOOR_MIN);
  });
});

// ---------------------------------------------------------------------------
// Operations levers
// ---------------------------------------------------------------------------

describe("operations levers", () => {
  test("kitchen stations move turnaround on their own scale", () => {
    const b = buildBaseline(healthyRaw());
    const r = runSimulation(b, { kitchen_stations: 8, tat_target_min: 10 });
    expect(r.simulated.tat_min).toBe(42 - (8 - DEFAULT_KITCHEN_STATIONS) * KITCHEN_STATION_TAT_CUT_MIN);
    expect(runSimulation(b, { kitchen_stations: 1, tat_target_min: 10 }).simulated.tat_min).toBe(46);
    expect(r.notes.some((n) => n.includes("kitchen station"))).toBe(true);
  });

  test("table count overrides the measured room and scales the ceiling", () => {
    const raw = healthyRaw();
    raw.table_count = 30;
    const b = buildBaseline(raw);
    // Halve the room: capacity 50 covers, below the 100 covers of demand.
    const r = runSimulation(b, { table_count: 150 });
    expect(r.simulated.covers).toBe(100); // ceiling rises; demand still binds
    const halved = runSimulation(b, { table_count: 20, avg_party_size: DEFAULT_PARTY_SIZE / 2 });
    expect(halved.simulated.covers).toBe(round1To(100 * (20 / 30) * 0.5));
    expect(halved.notes.some((n) => n.includes("Tables 20 vs 30 measured"))).toBe(true);
  });

  test("wastage above the measured baseline adds food cost; below it saves", () => {
    const b = buildBaseline(healthyRaw());
    const worse = runSimulation(b, { waste_pct: 15 });
    expect(worse.simulated.food_cost).toBe(12_800 + Math.round((15 - BASELINE_WASTE_PCT) / 100 * 40_000));
    const better = runSimulation(b, { waste_pct: 0 });
    expect(better.simulated.food_cost).toBe(12_800 - Math.round(BASELINE_WASTE_PCT / 100 * 40_000));
    expect(runSimulation(b, { waste_pct: BASELINE_WASTE_PCT }).delta.food_cost).toBe(0);
  });

  test("ingredient inflation multiplies the effective food-cost %", () => {
    const b = buildBaseline(healthyRaw());
    const r = runSimulation(b, { ingredient_inflation_pct: 25 });
    expect(r.simulated.food_cost).toBe(Math.round(40_000 * 0.32 * 1.25)); // 32% → 40%
    const deflation = runSimulation(b, { ingredient_inflation_pct: -10 });
    expect(deflation.simulated.food_cost).toBe(Math.round(40_000 * 0.32 * 0.9));
    expect(r.notes.some((n) => n.includes("Ingredient prices"))).toBe(true);
  });

  test("no-shows move only the booked slice of demand, relative to today's rate", () => {
    const b = buildBaseline(healthyRaw());
    const worse = runSimulation(b, { no_show_pct: 40 });
    const mult = 1 + BOOKED_COVERS_SHARE * (((100 - 40) / (100 - BASELINE_NO_SHOW_PCT)) - 1);
    expect(worse.simulated.covers).toBe(round1To(100 * mult));
    expect(runSimulation(b, { no_show_pct: BASELINE_NO_SHOW_PCT }).delta.covers).toBe(0);
  });
});

/** Round like the module does, so expectations read as the model computes. */
function round1To(value: number): number {
  return Math.round(value * 10) / 10;
}

// ---------------------------------------------------------------------------
// Marketing & growth
// ---------------------------------------------------------------------------

describe("marketing and growth levers", () => {
  // THE PICKER'S CORE CONTRACT, at the one lever that used to break it. A lever
  // sitting at its default must be indistinguishable from a lever that is not
  // there — otherwise merely ADDING it to the active list moves the answer with
  // no change-dot to explain why, and the screen lies about what it is showing.
  test("the acquisition lever at its default is identical to omitting it", () => {
    const b = buildBaseline(healthyRaw());
    for (const spend of [0, 1_000, 10_000, 100_000]) {
      const absent = runSimulation(b, { marketing_spend: spend });
      const atDefault = runSimulation(b, {
        marketing_spend: spend,
        acquisition_per_1000: DEFAULT_ACQUISITION_PER_1000,
      });
      expect(atDefault.simulated).toEqual(absent.simulated);
      expect(atDefault.delta).toEqual(absent.delta);
      expect(atDefault.notes).toEqual(absent.notes);
      expect(atDefault.breakeven_days).toBe(absent.breakeven_days);
    }
    // ...and at the default it is still HEAD's curve: 0.6·√(10000/400) = 3.
    expect(runSimulation(b, { marketing_spend: 10_000 }).simulated.covers).toBe(103);
  });

  test("the acquisition rate SCALES the curve rather than replacing it", () => {
    const b = buildBaseline(healthyRaw());
    // Double the rate → double the bump, still on the √ curve (3 → 6).
    expect(runSimulation(b, { marketing_spend: 10_000, acquisition_per_1000: 4 })
      .simulated.covers).toBe(106);
    // Half the rate → half the bump.
    expect(runSimulation(b, { marketing_spend: 10_000, acquisition_per_1000: 1 })
      .simulated.covers).toBe(101.5);
    // A zero rate is a real answer (marketing that converts nobody), not a no-op.
    expect(runSimulation(b, { marketing_spend: 100_000, acquisition_per_1000: 0 })
      .simulated.covers).toBe(100);
  });

  // The lever's top end used to be unbounded: linear acquisition projected 1,300
  // covers/day on a 30-table room and "marketing repays itself in 1 day".
  test("marketing covers cannot run away from the room's capacity", () => {
    const b = buildBaseline(healthyRaw());
    const maxed = runSimulation(b, { marketing_spend: 100_000, acquisition_per_1000: 10 });
    // round1To because covers leave the model rounded to 0.1, and 100 × 1.15 is
    // 114.99999999999999 in binary floating point — comparing against the raw
    // product would fail on the rounding, not on the cap.
    const ceiling = round1To(b.covers_per_day * (1 + MARKETING_OFFPEAK_SHARE));
    expect(maxed.simulated.covers).toBeLessThanOrEqual(ceiling);
    // Unbounded, this same body projected 1,300 covers on this room.
    expect(maxed.simulated.covers).toBeLessThan(200);
    expect(maxed.notes.some((n) => n.includes("capped"))).toBe(true);
    // The cap never binds at the legacy scale — that is what keeps the original
    // eight byte-identical to HEAD.
    const legacy = runSimulation(b, { marketing_spend: 100_000 });
    expect(legacy.notes.some((n) => n.includes("capped"))).toBe(false);
  });

  test("an acquisition rate with no spend says so instead of silently doing nothing", () => {
    const b = buildBaseline(healthyRaw());
    const r = runSimulation(b, { acquisition_per_1000: 10 });
    expect(r.delta.covers).toBe(0);
    expect(r.notes.some((n) => n.includes("marketing spend is ₹0"))).toBe(true);
  });

  test("retention is a directional demand multiplier around today's assumed rate", () => {
    const b = buildBaseline(healthyRaw());
    const churn = runSimulation(b, { retention_pct: 0 });
    expect(churn.simulated.covers).toBe(round1To(100 * (1 - RETENTION_SENSITIVITY * BASELINE_RETENTION_PCT / 100)));
    expect(runSimulation(b, { retention_pct: BASELINE_RETENTION_PCT }).delta.covers).toBe(0);
    // Upside is real demand, but the room still has to seat it.
    const loyal = runSimulation(b, { retention_pct: 100 });
    expect(loyal.simulated.covers).toBe(100);
    expect(loyal.notes.some((n) => n.includes("Repeat guests"))).toBe(true);
  });

  test("aggregator commission comes off revenue without inventing covers", () => {
    const b = buildBaseline(healthyRaw());
    const r = runSimulation(b, { aggregator_mix_pct: 60, aggregator_commission_pct: 30 });
    expect(r.simulated.covers).toBe(100);
    expect(r.simulated.revenue).toBe(40_000 - 7_200);
    expect(r.simulated.revenue_deductions).toBe(7_200);
    expect(r.delta.net_profit).toBe(-7_200);
    // No mix ⇒ the commission rate is inert, whatever it is.
    expect(runSimulation(b, { aggregator_commission_pct: 30 }).delta.revenue).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Overhead & scale
// ---------------------------------------------------------------------------

describe("overhead and plan levers", () => {
  test("fixed costs override the measured figure; utilities add to it", () => {
    const b = buildBaseline(healthyRaw()); // measured ₹5,000/day
    const override = runSimulation(b, { fixed_costs_per_day: 10_000 });
    expect(override.simulated.fixed_cost).toBe(10_000);
    expect(override.delta.net_profit).toBe(-5_000);
    expect(override.notes.some((n) => n.includes("measured ₹5000/day"))).toBe(true);
    const utilities = runSimulation(b, { utilities_per_day: 2_500 });
    expect(utilities.simulated.fixed_cost).toBe(7_500);
    expect(utilities.delta.net_profit).toBe(-2_500);
  });

  test("plan tier adds its real monthly fee ÷ 30 to fixed costs", () => {
    const b = buildBaseline(healthyRaw());
    for (const tier of ["growth", "enterprise"] as const) {
      const r = runSimulation(b, { plan_tier: tier });
      expect(r.simulated.fixed_cost).toBe(Math.round(5_000 + PLAN_TIERS[tier].monthly_fee / PLAN_FEE_DAYS));
      expect(r.notes.some((n) => n.includes(PLAN_TIERS[tier].label))).toBe(true);
    }
    // Starter is free, so it is the neutral tier.
    expect(runSimulation(b, { plan_tier: "starter" }).delta.fixed_cost).toBe(0);
  });

  test("an unknown tier resolves to Starter instead of crashing; 'pro' means Enterprise", () => {
    const b = buildBaseline(healthyRaw());
    expect(resolveParams({ plan_tier: "platinum" }, b).plan_tier).toBe("starter");
    expect(resolveParams({ plan_tier: 42 }, b).plan_tier).toBe("starter");
    expect(resolveParams({ plan_tier: null }, b).plan_tier).toBe("starter");
    expect(resolveParams({ plan_tier: { name: "growth" } }, b).plan_tier).toBe("starter");
    expect(resolveParams({ plan_tier: "GROWTH" }, b).plan_tier).toBe("growth");
    expect(resolveParams({ plan_tier: "pro" }, b).plan_tier).toBe("enterprise");
    expect(runSimulation(b, { plan_tier: "platinum" }).delta.fixed_cost).toBe(0);
  });
});

describe("second outlet (speculative)", () => {
  test("only a multi-outlet plan can switch it on", () => {
    const b = buildBaseline(healthyRaw());
    for (const tier of ["starter", "growth"] as const) {
      const blocked = runSimulation(b, { second_outlet: true, plan_tier: tier });
      expect(blocked.simulated.covers).toBe(100);
      expect(blocked.warnings).toEqual([]);
      expect(blocked.notes.some((n) => n.includes("does not include multi-outlet"))).toBe(true);
      expect(resolveParams({ second_outlet: true, plan_tier: tier }, b).second_outlet).toBe(false);
    }
    expect(resolveParams({ second_outlet: true, plan_tier: "enterprise" }, b).second_outlet).toBe(true);
  });

  test("on an Enterprise plan it scales volume and doubles site costs — and says it is a guess", () => {
    const b = buildBaseline(healthyRaw());
    const r = runSimulation(b, { second_outlet: true, plan_tier: "enterprise" });
    expect(r.simulated.covers).toBe(100 * (1 + SECOND_OUTLET_REVENUE_SHARE));
    expect(r.simulated.revenue).toBe(64_000);
    expect(r.simulated.labour_cost).toBe(6_000 * SECOND_OUTLET_COST_MULT);
    expect(r.simulated.food_cost).toBe(Math.round(64_000 * 0.32));
    expect(r.simulated.fixed_cost).toBe(Math.round(5_000 * SECOND_OUTLET_COST_MULT + PLAN_TIERS.enterprise.monthly_fee / PLAN_FEE_DAYS));
    expect(r.simulated.net_profit).toBe(64_000 - 12_000 - 20_480 - 10_133);
    // The caveat is loud and machine-readable, not buried in prose.
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("SPECULATIVE");
    expect(r.notes).toContain(r.warnings[0]);
  });

  test("the toggle accepts the shapes a JSON body actually carries", () => {
    const b = buildBaseline(healthyRaw());
    const on = { plan_tier: "enterprise", second_outlet: true };
    for (const v of [true, "true", "on", "yes", 1]) {
      expect(resolveParams({ ...on, second_outlet: v }, b).second_outlet).toBe(true);
    }
    for (const v of [false, "false", "off", 0, null, undefined, "", "banana"]) {
      expect(resolveParams({ ...on, second_outlet: v }, b).second_outlet).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// TOTALITY. The single most valuable test in this file: no input, however
// hostile, may produce a non-finite number in any cell.
// ---------------------------------------------------------------------------

describe("totality: every parameter, every extreme, every baseline", () => {
  /** Values chosen to break arithmetic: range edges, zero, junk, and nothing. */
  const HOSTILE: unknown[] = [
    undefined, null, "", "garbage", NaN, Infinity, -Infinity,
    0, -1, 1e12, -1e12, true, false, [], {}, "12", -0,
  ];

  const BASELINES: [string, () => SimulationBaseline][] = [
    ["healthy", () => buildBaseline(healthyRaw())],
    ["empty", () => buildBaseline(emptyRaw())],
    ["zeroed", () => ({
      // Not reachable through buildBaseline — a hand-built worst case where even
      // the TAT and food-cost fallbacks are gone.
      window_days: 0, covers_per_day: 0, apc: 0, revenue_per_day: 0, food_cost_pct: 0,
      labour_cost_per_day: 0, staff_count: 0, avg_tat_min: 0, table_count: 0,
      fixed_costs_per_day: 0, net_profit_per_day: 0, sources: {},
    })],
  ];

  function expectTotal(label: string, r: SimulationResult): void {
    for (const col of ["current", "simulated", "delta"] as const) {
      for (const [key, value] of Object.entries(r[col])) {
        if (!Number.isFinite(value)) {
          throw new Error(`${label}: ${col}.${key} = ${value}`);
        }
      }
    }
    if (r.breakeven_days !== null && !Number.isFinite(r.breakeven_days)) {
      throw new Error(`${label}: breakeven_days = ${r.breakeven_days}`);
    }
    for (const n of [...r.notes, ...r.warnings]) {
      expect(typeof n).toBe("string");
      expect(n.includes("NaN")).toBe(false);
      expect(n.includes("Infinity")).toBe(false);
      expect(n.includes("undefined")).toBe(false);
    }
  }

  test("one hostile value at a time, in every parameter, on every baseline", () => {
    let runs = 0;
    for (const [baselineName, mk] of BASELINES) {
      const b = mk();
      for (const spec of PARAM_CATALOG) {
        const values = spec.kind === "number"
          ? [...HOSTILE, spec.min, spec.max, (spec.min! + spec.max!) / 2]
          : [...HOSTILE, "starter", "growth", "enterprise", "pro"];
        for (const value of values) {
          const body = { [spec.key]: value } as SimulationParams;
          expectTotal(`${baselineName}/${spec.key}=${String(value)}`, runSimulation(b, body));
          // Resolution itself must stay finite, or the model is fed junk.
          const resolved = resolveParams(body, b) as unknown as Record<string, unknown>;
          for (const [k, v] of Object.entries(resolved)) {
            if (typeof v === "number" && !Number.isFinite(v)) {
              throw new Error(`${baselineName}/${spec.key}=${String(value)} → resolved.${k} = ${v}`);
            }
          }
          runs++;
        }
      }
    }
    expect(runs).toBeGreaterThan(1_500);
  });

  test("every parameter at its minimum, then every parameter at its maximum, together", () => {
    for (const [baselineName, mk] of BASELINES) {
      const b = mk();
      for (const edge of ["min", "max"] as const) {
        const body: Record<string, unknown> = {};
        for (const spec of PARAM_CATALOG) {
          if (spec.kind === "number") { body[spec.key] = spec[edge]; }
          else if (spec.kind === "toggle") { body[spec.key] = edge === "max"; }
          else { body[spec.key] = edge === "max" ? "enterprise" : "starter"; }
        }
        expectTotal(`${baselineName}/all-${edge}`, runSimulation(b, body));
      }
    }
  });

  test("every parameter set to junk at once, on every baseline", () => {
    for (const junk of [NaN, null, undefined, "x", Infinity, -Infinity, {}]) {
      for (const [baselineName, mk] of BASELINES) {
        const body: Record<string, unknown> = {};
        for (const spec of PARAM_CATALOG) { body[spec.key] = junk; }
        expectTotal(`${baselineName}/all-junk-${String(junk)}`, runSimulation(mk(), body));
      }
    }
  });

  test("a hostile body on the empty tenant still balances: current + delta = simulated", () => {
    const b = buildBaseline(emptyRaw());
    const r = runSimulation(b, {
      price_adjust_pct: 30, elasticity: -2, staff_count: 60, avg_wage_per_shift: 2_000,
      tat_target_min: 10, extra_expediters: 5, marketing_spend: 100_000, food_cost_pct: 60,
      discount_depth_pct: 30, discount_frequency_pct: 100, coupon_redemption_pct: 50,
      coupon_avg_value: 500, service_charge_pct: 10, tax_rate_pct: 28, avg_party_size: 8,
      loyalty_redemption_pct: 30, captain_share_pct: 100, shifts_per_day: 2,
      overtime_premium_pct: 100, overtime_hours_per_shift: 4, staff_attendance_pct: 70,
      table_count: 150, kitchen_stations: 8, waste_pct: 15, ingredient_inflation_pct: 30,
      no_show_pct: 40, acquisition_per_1000: 10, retention_pct: 100, aggregator_mix_pct: 60,
      aggregator_commission_pct: 30, fixed_costs_per_day: 20_000, utilities_per_day: 5_000,
      plan_tier: "enterprise", second_outlet: true,
    });
    for (const key of allLineKeys()) {
      expect(Number.isFinite(r.simulated[key])).toBe(true);
      const sum = key === "covers" || key === "tat_min"
        ? round1To(r.current[key] + r.delta[key])
        : r.current[key] + r.delta[key];
      expect(sum).toBe(r.simulated[key]);
    }
  });
});
