// Two defects that a reader can SEE in the shipped UI, pinned here.
//
// (D) effective_weights are rendered by the owner app as "Counts for X% of this
//     score". Rounding each share independently let them total 101%.
// (E) GetCustomerSegments merges a customer's `c:`, `p:<phone>` and `n:<name>`
//     buckets. Four rows on the live tenant share the phone 9999999999, so the
//     same anonymous spend was added to all four — and spend decides the
//     high-spend quartile, so the double count moves people between segments.
//
// Both functions are pure, but they live in database_supabase.ts, which opens a
// pg Pool at import time. Only `pg` is faked; the code under test is the shipped
// code, not a copy of it.

import { describe, test, expect, beforeAll, jest } from "@jest/globals";

jest.mock("pg", () => {
  class FakePool {
    on(): this { return this; }
    query(): Promise<never> {
      return Promise.reject(new Error("segments_and_weights: no test here may touch the database"));
    }
    connect(): Promise<never> {
      return Promise.reject(new Error("segments_and_weights: pool.connect() is not stubbed"));
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

// --- D: effective weights must sum to exactly 1 ------------------------------

// The shipped nominal weights. Kept literal so this test still fails loudly if
// someone re-tunes them without re-checking the rounding.
const WEIGHTS = { apc: 0.35, rating: 0.30, attendance: 0.20, tat: 0.15 } as const;
type K = keyof typeof WEIGHTS;

const ALL_KEYS: K[] = ["apc", "rating", "attendance", "tat"];

/** Every non-empty subset of the four components — all 15 of them. */
const SUBSETS: K[][] = (() => {
  const out: K[][] = [];
  for (let mask = 1; mask < 1 << ALL_KEYS.length; mask++) {
    out.push(ALL_KEYS.filter((_, i) => (mask & (1 << i)) !== 0));
  }
  return out;
})();

const sum2 = (xs: number[]): number => Number(xs.reduce((s, x) => s + x, 0).toFixed(2));

describe("distributeEffectiveWeights", () => {
  test.each(SUBSETS.map((s) => [s.join("+"), s] as const))(
    "shares sum to exactly 1 with %s available",
    (_label, live) => {
      const w = db.distributeEffectiveWeights<K>(WEIGHTS, live);
      expect(sum2(Object.values(w))).toBe(1);
    },
  );

  // The exact case in the report: apc + rating + tat (0.80 of nominal weight).
  // Independent rounding gave 0.44 + 0.38 + 0.19 = 1.01.
  test("apc+rating+tat no longer totals 1.01", () => {
    const w = db.distributeEffectiveWeights<K>(WEIGHTS, ["apc", "rating", "tat"]);
    expect(sum2([w.apc, w.rating, w.attendance, w.tat])).toBe(1);
    expect(sum2([w.apc, w.rating, w.attendance, w.tat])).not.toBe(1.01);
    // Largest remainder: apc and tat carry the two leftover hundredths (biggest
    // discarded fractions), rating takes the floor.
    expect(w).toEqual({ apc: 0.44, rating: 0.37, attendance: 0, tat: 0.19 });
  });

  test("an unmeasured component gets exactly 0, never a share", () => {
    const w = db.distributeEffectiveWeights<K>(WEIGHTS, ["apc", "rating"]);
    expect(w.attendance).toBe(0);
    expect(w.tat).toBe(0);
    expect(sum2([w.apc, w.rating])).toBe(1);
  });

  test("a lone component carries the whole score", () => {
    for (const k of ALL_KEYS) {
      const w = db.distributeEffectiveWeights<K>(WEIGHTS, [k]);
      expect(w[k]).toBe(1);
      expect(sum2(Object.values(w))).toBe(1);
    }
  });

  test("nothing measured means every share is 0, matching the null score", () => {
    const w = db.distributeEffectiveWeights<K>(WEIGHTS, []);
    expect(Object.values(w)).toEqual([0, 0, 0, 0]);
  });

  test("no share is ever negative or above 1", () => {
    for (const live of SUBSETS) {
      const w = db.distributeEffectiveWeights<K>(WEIGHTS, live);
      for (const v of Object.values(w)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  test("a heavier nominal weight never gets a smaller share", () => {
    for (const live of SUBSETS) {
      const w = db.distributeEffectiveWeights<K>(WEIGHTS, live);
      const ordered = [...live].sort((a, b) => WEIGHTS[b] - WEIGHTS[a]);
      for (let i = 1; i < ordered.length; i++) {
        expect(w[ordered[i - 1]!]).toBeGreaterThanOrEqual(w[ordered[i]!]);
      }
    }
  });
});

// --- E: a shared phone must not be claimed by anybody ------------------------

// The real csrorganics roster shape, reduced to the identity fields. Four rows
// share 9999999999, two share 1234567890, two share 9998887770.
const ROSTER = [
  { id: "c1", phone_digits: "9999999999", name_key: "james bonds" },
  { id: "c2", phone_digits: "9999999999", name_key: "nitish -" },
  { id: "c3", phone_digits: "9999999999", name_key: "jack -" },
  { id: "c4", phone_digits: "9999999999", name_key: "pig -" },
  { id: "c5", phone_digits: "1234567890", name_key: "test chicken" },
  { id: "c6", phone_digits: "1234567890", name_key: "chirayu nilesh chaudhari" },
  { id: "c7", phone_digits: "9998887770", name_key: "demo guest" },
  { id: "c8", phone_digits: "9998887770", name_key: "tablebug test delete" },
  { id: "c9", phone_digits: "9876500001", name_key: "asha rao" },
];

describe("customerIdentityKeys", () => {
  test("a phone on four customer rows is claimed by none of them", () => {
    const keys = db.customerIdentityKeys(ROSTER);
    for (const id of ["c1", "c2", "c3", "c4"]) {
      expect(keys.get(id)).not.toContain("p:9999999999");
    }
    // Two-way sharing is just as wrong as four-way.
    expect(keys.get("c5")).not.toContain("p:1234567890");
    expect(keys.get("c6")).not.toContain("p:1234567890");
    expect(keys.get("c7")).not.toContain("p:9998887770");
    expect(keys.get("c8")).not.toContain("p:9998887770");
  });

  test("a phone unique to one customer is still claimed", () => {
    expect(db.customerIdentityKeys(ROSTER).get("c9")).toContain("p:9876500001");
  });

  test("the cust_id bucket is always claimed, so a named bill is never lost", () => {
    const keys = db.customerIdentityKeys(ROSTER);
    for (const r of ROSTER) { expect(keys.get(r.id)).toContain(`c:${r.id}`); }
  });

  test("no bucket is claimed by two customers — the double-count invariant", () => {
    const keys = db.customerIdentityKeys(ROSTER);
    const owners = new Map<string, number>();
    for (const list of keys.values()) {
      for (const k of list) { owners.set(k, (owners.get(k) ?? 0) + 1); }
    }
    // Before the fix, p:9999999999 had 4 owners, so one bill's spend was counted
    // four times and could push all four rows into the high-spend quartile.
    expect([...owners.entries()].filter(([, n]) => n > 1)).toEqual([]);
  });

  test("a shared NAME has the same failure mode and is withheld too", () => {
    const twoGuests = [
      { id: "a", phone_digits: "", name_key: "guest" },
      { id: "b", phone_digits: "", name_key: "guest" },
      { id: "c", phone_digits: "", name_key: "rahul sharma" },
    ];
    const keys = db.customerIdentityKeys(twoGuests);
    expect(keys.get("a")).toEqual(["c:a"]);
    expect(keys.get("b")).toEqual(["c:b"]);
    expect(keys.get("c")).toEqual(["c:c", "n:rahul sharma"]);
  });

  test("an empty phone or name never becomes a bucket", () => {
    const keys = db.customerIdentityKeys([{ id: "x", phone_digits: "", name_key: "" }]);
    expect(keys.get("x")).toEqual(["c:x"]);
  });
});

// --- C: the one concern that cannot span outlets says so ---------------------

describe("floorConcernScope", () => {
  const OUTLET = "58373382-2765-4e18-8ea6-4295badec7f6";

  test("single-outlet mode reads exactly as it always did", () => {
    const s = db.floorConcernScope(false, "CSR Organics Main Outlet", OUTLET);
    expect(s.label).toBe("Seated tables tracking under the APC target");
    expect(s.advice_suffix).toBe("");
    expect(s.params).toEqual({ filter: "below_apc" });
  });

  test("all-outlets mode names the outlet the count actually covers", () => {
    const s = db.floorConcernScope(true, "CSR Organics Main Outlet", OUTLET);
    // Without this, the row sits beside all-outlet counts looking like one.
    expect(s.label).toBe("Seated tables tracking under the APC target (CSR Organics Main Outlet only)");
    expect(s.advice_suffix).toContain("CSR Organics Main Outlet floor only");
    // Machine-readable too, so a client is not parsing English to know the scope.
    expect(s.params).toEqual({ filter: "below_apc", outlet_id: OUTLET });
  });
});

describe("customerIdentityKeys (edge)", () => {
  test("an empty phone or name never becomes a bucket", () => {
    const keys = db.customerIdentityKeys([{ id: "x", phone_digits: "", name_key: "" }]);
    expect(keys.get("x")).toEqual(["c:x"]);
  });
});
