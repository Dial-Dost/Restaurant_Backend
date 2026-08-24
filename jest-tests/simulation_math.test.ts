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
  type SimulationRawStats,
  type SimulationBaseline,
  type SimulationLine,
  type SimulationResult,
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
