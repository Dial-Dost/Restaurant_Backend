// "AN ORDER THAT STILL OWES MONEY" — ONE DEFINITION, PINNED.
//
// ============================================================================
// WHAT WENT WRONG
// ============================================================================
// There were three copies of the status list and they did not agree:
//
//   * activeOrderSubtotal (the bill math) skipped Paid/Cancelled/Closed — so
//     status 6 "Payment Pending Approval" WAS charged for;
//   * eleven SQL readers wrote `not in ('4','5','7')` — the same rule;
//   * GetTableReleaseImpact, the preflight that decides whether releasing a
//     table is a WRITE-OFF, wrote `not in ('4','5','6','7')`.
//
// So a table whose orders sat at status 6 with no waiter-confirmed bill row —
// the bill reopened, merged away or never written — reported ₹0 to the gate
// while the bill math charged for every rupee of it. The preflight could be made
// to read zero on exactly the table a release would empty, and the gate built to
// stop a waiter walking a service's takings out of the system had nothing to
// stop. A comment said the two filters "must agree". A comment is not a
// mechanism.
//
// ============================================================================
// WHAT THIS SUITE PINS
// ============================================================================
//   1. The SQL predicate and the TypeScript predicate are built from ONE array,
//      and agree on every status code that exists — asserted code by code, not
//      by re-stating the list.
//   2. Status 6 still owes money, in both halves. This is the regression.
//   3. "What ReleaseTable may VOID" is a DIFFERENT question, is derived from the
//      owing set rather than written out, and is strictly a superset of it.
//   4. THE SOURCE ITSELF carries no fourth copy. A second list that agrees today
//      is how this happened, so a stray `not in ('4','5','7')` reappearing in
//      database_supabase.ts fails this suite.
//   5. The shipped GetTableReleaseImpact really does count a status-6 order —
//      driven over a fake Pool, so the assertion is about the statement that
//      ships rather than a copy of it.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RELEASE_VOID_EXEMPT_STATUS_CODES,
  SETTLED_ORDER_STATUS_CODES,
  orderStatusStillOwes,
  releaseVoidableStatusSql,
  stillOwesStatusSql,
} from "../billing_math";
import { releaseWriteOffValue } from "../release_authority";

const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";
const TABLE_ID = "33333333-3333-3333-3333-333333333333";

interface Fixture {
  orders: { food: unknown; status: unknown }[];
  billTotal: number | null;
  sql: string[];
}
const fx: Fixture = { orders: [], billTotal: null, sql: [] };

jest.mock("pg", () => {
  const query = async (sql: string): Promise<{ rows: unknown[] }> => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    fx.sql.push(q);
    if (/from "Restaurant" r/i.test(q)) {
      return { rows: [{
        res_id: RES, outlet_id: OUTLET, restaurant_slug: "gaia", restaurant_name: "Gaia",
        restaurant_main_office_add: null, restaurant_logo_url: null, timezone: null,
      }] };
    }
    if (/select id from "Tables"/i.test(q)) { return { rows: [{ id: TABLE_ID }] }; }
    if (/select total_amt from "Bills"/i.test(q)) {
      return { rows: fx.billTotal === null ? [] : [{ total_amt: fx.billTotal }] };
    }
    if (/select food, status from "Orders"/i.test(q)) {
      // THE FIXTURE APPLIES THE SHIPPED PREDICATE ITSELF, from the SQL text it
      // was handed, rather than trusting a hand-written filter. If the statement
      // starts excluding a status again, these rows disappear here exactly as
      // they would in Postgres — which is what makes case 5 a real test.
      const excluded = [...q.matchAll(/not in \(([^)]*)\)/g)]
        .flatMap((m) => m[1].split(",").map((c) => c.trim().replace(/'/g, "")));
      return { rows: fx.orders.filter((o) => !excluded.includes(String(Math.round(Number(o.status ?? 1))))) };
    }
    return { rows: [] };
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string): Promise<{ rows: unknown[] }> { return query(sql); }
    connect(): Promise<unknown> { return Promise.resolve({ query, release: () => undefined }); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

/** Every status code fromOrderStatusCode knows, plus the unreadable ones. */
const ALL_CODES: unknown[] = [1, 2, 3, 4, 5, 6, 7, 8, "1", "6", null, undefined, "", "nonsense", 99];

/** The SQL predicate, evaluated the way Postgres would: coalesce then `not in`. */
function sqlSaysOwes(predicate: string, status: unknown): boolean {
  const excluded = (predicate.match(/not in \(([^)]*)\)/) ?? ["", ""])[1]
    .split(",").map((c) => c.trim().replace(/'/g, "")).filter(Boolean);
  const n = Number(status);
  const coalesced = Number.isFinite(n) && status !== null && status !== undefined && status !== ""
    ? String(Math.round(n))
    : "1"; // coalesce(status::text, '1')
  return !excluded.includes(coalesced);
}

let db: typeof import("../database_supabase");

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
});

beforeEach(() => { fx.sql = []; fx.orders = []; fx.billTotal = null; });

// ===========================================================================
describe("one definition, two halves", () => {
  test("the SQL and the TypeScript agree on every status code there is", () => {
    for (const code of ALL_CODES) {
      expect([code, sqlSaysOwes(stillOwesStatusSql(), code)])
        .toEqual([code, orderStatusStillOwes(code)]);
    }
  });

  test("status 6 (Payment Pending Approval) STILL OWES — in both halves", () => {
    // THE REGRESSION. The bill math has always charged for it; the preflight
    // excluded it and therefore read ₹0 on a table that was going to be charged.
    expect(orderStatusStillOwes(6)).toBe(true);
    expect(sqlSaysOwes(stillOwesStatusSql(), 6)).toBe(true);
    expect(SETTLED_ORDER_STATUS_CODES).not.toContain("6");
  });

  test("paid, cancelled and closed do not owe; everything else does", () => {
    expect([4, 5, 7].map(orderStatusStillOwes)).toEqual([false, false, false]);
    expect([1, 2, 3, 6, 8].map(orderStatusStillOwes)).toEqual([true, true, true, true, true]);
  });

  test("an unreadable status owes — failing towards 'there is money here'", () => {
    // Over-reporting costs one escalation. Under-reporting is the bug above.
    for (const junk of [null, undefined, "", "nonsense", {}]) {
      expect([junk, orderStatusStillOwes(junk)]).toEqual([junk, true]);
    }
  });

  test("the SQL builder takes a column alias without becoming a second literal", () => {
    expect(stillOwesStatusSql("o.status")).toContain("o.status");
    expect(stillOwesStatusSql("o.status").match(/not in \(([^)]*)\)/)?.[1])
      .toBe(stillOwesStatusSql().match(/not in \(([^)]*)\)/)?.[1]);
  });
});

// ===========================================================================
describe("'what may be voided' is a different question with a derived answer", () => {
  test("the release-void set is the owing set plus 6, and is derived from it", () => {
    expect(RELEASE_VOID_EXEMPT_STATUS_CODES).toEqual([...SETTLED_ORDER_STATUS_CODES, "6"]);
    // Strictly a superset: every settled code is exempt from voiding too.
    for (const c of SETTLED_ORDER_STATUS_CODES) {
      expect([c, RELEASE_VOID_EXEMPT_STATUS_CODES.includes(c)]).toEqual([c, true]);
    }
  });

  test("a status-6 order is NOT voided by a release, but IS counted by the preflight", () => {
    // Both are correct and they are not the same sentence: the guest has
    // tendered, so cancelling their orders would delete collected money — and
    // closing the bill at zero around them still destroys value, which is what
    // the preflight has to see.
    expect(sqlSaysOwes(releaseVoidableStatusSql(), 6)).toBe(false);
    expect(sqlSaysOwes(stillOwesStatusSql(), 6)).toBe(true);
  });
});

// ===========================================================================
describe("no fourth copy of the list survives in the source", () => {
  const source = readFileSync(join(__dirname, "..", "database_supabase.ts"), "utf8");

  test("database_supabase.ts hand-writes the status list nowhere", () => {
    // A second list that agrees today is exactly how this happened. Every reader
    // goes through stillOwesStatusSql / releaseVoidableStatusSql, so ANY literal
    // tuple of these codes reappearing is a regression, whatever it says.
    const strays = source.match(/not in \(\s*'(?:4|5|6|7)'[^)]*\)/g) ?? [];
    expect(strays).toEqual([]);
  });

  test("…and the TypeScript predicate is not re-written by name either", () => {
    // The old shape, exactly: a three-way name test standing in for the list.
    // (`st === "cancelled"` on its own survives in the analytics readers and is
    // a DIFFERENT question — "was this order cancelled" counts paid orders in,
    // which the owing rule must not.)
    expect(source).not.toMatch(/st === "cancelled" \|\| st === "paid"/);
    expect(source).toContain("orderStatusStillOwes(r.status)");
  });
});

// ===========================================================================
describe("the shipped preflight, over a fake Pool", () => {
  const impactFor = (orders: { food: unknown; status: unknown }[], billTotal: number | null = null) => {
    fx.orders = orders;
    fx.billTotal = billTotal;
    return db.GetTableReleaseImpact(RES, "T7");
  };

  test("THE HOLE: a table carrying only status-6 orders no longer reads ₹0", async () => {
    // Before the fix the SQL excluded 6, the rows never came back, and the
    // preflight answered "nothing to protect" for a table the bill math would
    // have charged ₹7,500 for.
    const impact = await impactFor([
      { food: { subtotal: 4500, total: 4500 }, status: 6 },
      { food: { subtotal: 3000, total: 3000 }, status: 6 },
    ]);
    expect(impact?.active_order_total).toBe(7500);
    expect(impact?.active_order_count).toBe(2);
    // …and therefore the release gate sees a write-off and refuses a waiter.
    expect(releaseWriteOffValue(impact)).toBe(7500);
  });

  test("the statement it issues excludes 4, 5 and 7 — and nothing else", async () => {
    await impactFor([{ food: { subtotal: 100, total: 100 }, status: 1 }]);
    const stmt = fx.sql.find((q) => /select food, status from "Orders"/i.test(q)) ?? "";
    const excluded = (stmt.match(/not in \(([^)]*)\)/) ?? ["", ""])[1]
      .split(",").map((c) => c.trim().replace(/'/g, "")).filter(Boolean).sort();
    expect(excluded).toEqual(["4", "5", "7"]);
  });

  test("settled and cancelled orders are still ignored — an empty table stays empty", async () => {
    const impact = await impactFor([
      { food: { subtotal: 9000, total: 9000 }, status: 4 },
      { food: { subtotal: 500, total: 500 }, status: 5 },
      { food: { subtotal: 400, total: 400 }, status: 7 },
    ]);
    expect(impact?.active_order_total).toBe(0);
    expect(impact?.active_order_count).toBe(0);
    // An empty table is ordinary floor work and must stay releasable by anyone.
    expect(releaseWriteOffValue(impact)).toBe(0);
  });

  test("the greater of the bill and the orders still wins", async () => {
    const impact = await impactFor([{ food: { subtotal: 100, total: 100 }, status: 6 }], 4250);
    expect(releaseWriteOffValue(impact)).toBe(4250);
  });
});
