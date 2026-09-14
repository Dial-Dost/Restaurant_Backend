// THE FIFTEEN CONTROL REPORTS, ON REAL MONEY, THROUGH THE REAL READERS.
//
// jest-tests/mis_report_math.test.ts proves the arithmetic in isolation. This
// suite proves the thing that actually matters: that the shipped readers in
// database_supabase.ts, over the shipped SQL, produce numbers that AGREE — and
// that the four rules a control pack lives or dies by survive the trip:
//
//   1. Sales Summary grand total === Σ Order Summary rows === Σ Settlement rows
//      === Σ Counter Summary rows. Headline numbers that disagree is a pack
//      nobody signs.
//   2. Cancelled orders are not sales.
//   3. Covers are counted ONCE PER SEATING.
//   4. Both ends of the date range are inclusive, in the TENANT's timezone.
//
// Plus the two that keep it safe and usable: an empty window is an empty report
// (never a 500), and one tenant cannot read another's rows.
//
// Only `pg` is faked — see mis_fixtures.ts for why a fixture and not a live DB,
// and for how it enforces (rather than assumes) the predicates it models.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import {
  OTHER_OUTLET,
  OTHER_RES_ID,
  OUTLET_A,
  OUTLET_B,
  RES_ID,
  makeDb,
  useFixtureDb,
  type FixtureBill,
  type FixtureDb,
  type FixtureOrder,
} from "./mis_fixtures";
import { renderMisCsv } from "../../report_render";
// Type-only: erased at runtime, so it does not pull the data layer in ahead of
// the pg mock that the dynamic import in beforeAll installs.
import type { MisColumn } from "../../database_supabase";

jest.mock("pg", () => {
  interface FixtureGlobal {
    __misFixtureQuery?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  }
  const run = (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const q = (globalThis as unknown as FixtureGlobal).__misFixtureQuery;
    if (!q) {throw new Error("mis fixture harness was not loaded");}
    return q(sql, params);
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> { return run(sql, params); }
    // withTenant checks a client out, so the ALL-OUTLETS aggregate read (which is
    // only reachable through it) can be driven end to end.
    connect(): Promise<{ query: typeof run; release: () => void }> {
      return Promise.resolve({ query: run, release: () => { /* pooled */ } });
    }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

type Readers = typeof import("../../database_supabase");
let db: Readers;

const RID = "zztest-mis";
const IST = "Asia/Kolkata";
const AHEAD = "Pacific/Kiritimati"; // UTC+14
const BEHIND = "Pacific/Midway";    // UTC-11

const FROM = "2026-06-01";
const TO = "2026-06-15";

const r2 = (n: number): number => Number(n.toFixed(2));
const sum = (xs: number[]): number => r2(xs.reduce((s, x) => s + x, 0));

beforeAll(async () => {
  // A connection string is required at import time; the pool is faked, so the
  // value is never dialled.
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL ?? "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../../database_supabase");
});

// --- the fixture bill set ----------------------------------------------------
//
// SHAPE (b) throughout — "Service Charge" is a line inside the stored
// tax_breakdown, which is what migrations/000_base_schema.sql seeds into
// Outlets.default_tax and what live tenants actually have. It is also the shape
// that used to be misreported as GST, so it is the one worth testing.
//
//   food base F  ->  service charge 1% of F  ->  SGST 2.5% + CGST 2.5% of (F+SC)
//   grand total  =  F + SC + SGST + CGST

function billOf(food: number): { total: number; lines: { name: string; percentage: number; amount: number }[] } {
  const sc = r2(food * 0.01);
  const taxBase = r2(food + sc);
  const sgst = r2(taxBase * 0.025);
  const cgst = r2(taxBase * 0.025);
  return {
    total: r2(taxBase + sgst + cgst),
    lines: [
      { name: "Service Charge", percentage: 1, amount: sc },
      { name: "SGST", percentage: 2.5, amount: sgst },
      { name: "CGST", percentage: 2.5, amount: cgst },
    ],
  };
}

/** `food` is the base AFTER any discount — total_amt is stored net of it. */
function bill(over: Partial<FixtureBill> & { id: string; bill_no: string; settled_at: string; food: number }): FixtureBill {
  const { food, ...rest } = over;
  const b = billOf(food);
  return {
    total_amt: b.total,
    tax_breakdown: b.lines,
    payment_method: "Cash",
    table_name: "T1",
    session_id: `S-${over.id}`,
    covers: 2,
    ...rest,
  };
}

function order(over: Partial<FixtureOrder> & { id: string; created_at: string; status: number }): FixtureOrder {
  return { items: [], order_type: "dine_in", table_name: "T1", ...over };
}

const CATCH_ALL = "4ad474d4-5230-449c-874f-6a238b833bca";

// The two VOIDED orders carry real uuids: GetMisOrderDetail refuses a malformed
// id before it reaches SQL, so a fixture id like "ov1" would exercise that guard
// instead of the tenant predicate the isolation test is actually about.
const VOID_ID = "11111111-aaaa-4aaa-8aaa-111111111111";
const OTHER_VOID_ID = "22222222-bbbb-4bbb-8bbb-222222222222";

/**
 * The standard tenant. Every number below is derivable by hand from these rows,
 * which is the point: a fixture whose expected values come out of the code it
 * tests proves nothing.
 */
function standardDb(over: Partial<FixtureDb> = {}): FixtureDb {
  return makeDb({
    timezone: IST,
    bills: [
      // ONE SEATING, TWO BILLS (a split bill). Four covers, counted ONCE.
      bill({ id: "b1", bill_no: "1001", settled_at: "2026-06-02T10:00:00.000Z", food: 1000, session_id: "S1", covers: 4, order_id: "o1", payment_method: "Cash" }),
      bill({ id: "b2", bill_no: "1002", settled_at: "2026-06-02T10:05:00.000Z", food: 500, session_id: "S1", covers: 4, order_id: "o2", payment_method: "Card" }),
      // A DISCOUNTED bill: 2000 of food with 200 off, so 1800 was charged.
      bill({ id: "b3", bill_no: "1003", settled_at: "2026-06-05T08:00:00.000Z", food: 1800, session_id: "S2", covers: 2, order_id: "o3", discount_type: "flat", discount_value: 200, reason: "Regular guest", payment_method: "Upi" }),
      // A SPLIT TENDER that reconstructs: 848.40 = 500 + 348.40.
      bill({ id: "b4", bill_no: "1004", settled_at: "2026-06-07T09:00:00.000Z", food: 800, session_id: "S3", covers: 1, order_id: "o4", payment_method: "Split", payment_splits: [{ method: "Cash", amount: 500 }, { method: "Card", amount: 348.4 }] }),
      // NO RESOLVABLE SEATING: money counts, covers do not.
      bill({ id: "b5", bill_no: "1005", settled_at: "2026-06-09T09:00:00.000Z", food: 300, session_id: null, order_id: "o5", payment_method: "Cash" }),
      // 23:30 IST on the LAST day of the range — the inclusive upper bound.
      bill({ id: "b6", bill_no: "1006", settled_at: "2026-06-15T18:00:00.000Z", food: 100, session_id: "S4", covers: 3, order_id: "o6", payment_method: "Cash" }),
      // 00:30 IST on the 16th — OUTSIDE a 1-15 June range, though still the 15th in UTC.
      bill({ id: "b7", bill_no: "1007", settled_at: "2026-06-15T19:00:00.000Z", food: 9999, session_id: "S5", covers: 9, payment_method: "Cash" }),
      // NEVER SETTLED — still on the floor, so not revenue.
      bill({ id: "b8", bill_no: "1008", settled_at: "2026-06-10T09:00:00.000Z", food: 7777, settled: false, session_id: "S6", covers: 5 }),
      // ANOTHER OUTLET of the same restaurant: only in the ALL-OUTLETS read.
      bill({ id: "b9", bill_no: "2001", settled_at: "2026-06-08T09:00:00.000Z", food: 400, outlet_id: OUTLET_B, session_id: "S7", covers: 2, payment_method: "Card" }),
      // ANOTHER RESTAURANT ENTIRELY. Must never appear, in any mode.
      bill({ id: "bx", bill_no: "9001", settled_at: "2026-06-03T09:00:00.000Z", food: 50000, res_id: OTHER_RES_ID, outlet_id: OTHER_OUTLET, session_id: "SX", covers: 40 }),
    ],
    orders: [
      order({ id: "o1", created_at: "2026-06-02T09:30:00.000Z", status: 7, items: [{ name: "Paneer Tikka", quantity: 2, price: 300 }, { name: "Dal", quantity: 1, price: 400 }] }),
      order({ id: "o2", created_at: "2026-06-02T09:40:00.000Z", status: 7, items: [{ name: "Dal", quantity: 1, price: 500 }] }),
      order({ id: "o3", created_at: "2026-06-05T07:30:00.000Z", status: 7, order_type: "takeaway", items: [{ name: "Biryani", quantity: 2, price: 1000 }] }),
      order({ id: "o4", created_at: "2026-06-07T08:30:00.000Z", status: 7, order_type: "delivery", items: [{ name: "Dal", quantity: 2, price: 400 }] }),
      order({ id: "o5", created_at: "2026-06-09T08:30:00.000Z", status: 7, items: [{ name: "Chai", quantity: 6, price: 50 }] }),
      order({ id: "o6", created_at: "2026-06-15T17:30:00.000Z", status: 7, items: [{ name: "Chai", quantity: 2, price: 50 }] }),
      // A VOID: cancelled, so its food is not revenue anywhere.
      order({ id: VOID_ID, created_at: "2026-06-06T10:00:00.000Z", status: 5, table_name: "T9", items: [{ name: "Biryani", quantity: 3, price: 1000 }] }),
      // Another restaurant's void.
      order({ id: OTHER_VOID_ID, created_at: "2026-06-06T10:00:00.000Z", status: 5, res_id: OTHER_RES_ID, outlet_id: OTHER_OUTLET, items: [{ name: "Biryani", quantity: 99, price: 1000 }] }),
    ],
    audits: [
      { id: "a1", created_at: "2026-06-06T10:05:00.000Z", action_id: CATCH_ALL, action_name: "Add Orders", reason: `Order ${VOID_ID} -> Cancelled`, details: { order_id: VOID_ID, status: "Cancelled" }, fname: "Asha", lname: "Rao" },
      { id: "a2", created_at: "2026-06-05T07:50:00.000Z", action_id: CATCH_ALL, action_name: "Add Orders", reason: "Removed item Dal from table T1", details: { table: "T1", item: "Dal" }, fname: "Bipin", lname: "Shah" },
      // A PRINT. Same action id, and not a bill edit.
      { id: "a3", created_at: "2026-06-05T07:55:00.000Z", action_id: CATCH_ALL, action_name: "Add Orders", reason: "Printed KOT for table T1 (1 station ticket(s))", details: { table: "T1", kind: "KOT", kot_no: 12 }, fname: "Bipin", lname: "Shah" },
      // Another restaurant's edit.
      { id: "ax", created_at: "2026-06-05T07:50:00.000Z", res_id: OTHER_RES_ID, outlet_id: OTHER_OUTLET, action_id: CATCH_ALL, action_name: "Add Orders", reason: "Removed item Secret from table Z1", details: { table: "Z1", item: "Secret" }, fname: "Nobody", lname: "Else" },
    ],
    menu: [{ name: "Paneer Tikka", category: "Starters" }, { name: "Dal", category: "Mains" }],
    // A2/035 — THE RECORDED REASON for the void above. Deliberately the ONLY
    // one: OTHER_VOID_ID has none, which is the pre-035 / no-reason-sent shape
    // the report has to render as a truthful blank rather than a guess.
    order_voids: [
      { order_id: VOID_ID, reason: "Guest changed their mind", void_kind: "guest_changed_mind", stage: "after_print" },
    ],
    ...over,
  });
}

/** The six bills of OUTLET_A that settle inside 1-15 June, by hand. */
const IN_WINDOW_FOOD = [1000, 500, 1800, 800, 300, 100];
const EXPECTED_GRAND = sum(IN_WINDOW_FOOD.map((f) => billOf(f).total));
const EXPECTED_NET = sum(IN_WINDOW_FOOD);

const W = { from: FROM, to: TO };

beforeEach(() => { useFixtureDb(standardDb()); });

// --- 1. THE RECONCILIATION ---------------------------------------------------

describe("the three headline numbers agree", () => {
  test("Sales Summary grand total === Σ Order Summary rows === Σ Settlement Summary rows", async () => {
    const sales = await db.GetSalesSummaryReport(RID, W);
    const orders = await db.GetOrderSummaryReport(RID, { ...W, limit: 500 });
    const settle = await db.GetSettlementSummaryReport(RID, W);

    expect(sales.totals.grand_total).toBe(EXPECTED_GRAND);
    expect(sum(orders.rows.map((r) => r.grand_total))).toBe(EXPECTED_GRAND);
    expect(sum(settle.rows.map((r) => r.amount))).toBe(EXPECTED_GRAND);
    expect(settle.totals.amount).toBe(EXPECTED_GRAND);
  });

  test("the Order Summary's totals row covers the WINDOW, not the page", async () => {
    // Two rows on screen, six bills in the window: a totals row computed from
    // the page is the classic way a control report understates a day.
    const page = await db.GetOrderSummaryReport(RID, { ...W, limit: 2 });
    expect(page.rows).toHaveLength(2);
    expect(page.page.total).toBe(6);
    expect(page.page.has_more).toBe(true);
    expect(page.totals.grand_total).toBe(EXPECTED_GRAND);
    expect(sum(page.rows.map((r) => r.grand_total))).toBeLessThan(EXPECTED_GRAND);
  });

  test("the ladder closes on every report: net + service charge + tax === grand total", async () => {
    const sales = await db.GetSalesSummaryReport(RID, W);
    const t = sales.totals;
    expect(r2(t.net + t.service_charge + t.tax + t.round_off)).toBe(t.grand_total);
    expect(t.net).toBe(EXPECTED_NET);
    expect(t.round_off).toBe(0);
  });

  test("the service charge is reported as the owner's income, never as tax", async () => {
    // Shape (b): "Service Charge" is a line in the stored breakdown. Summing the
    // breakdown blindly books it as GST owed to the government.
    const sales = await db.GetSalesSummaryReport(RID, W);
    expect(sales.totals.service_charge).toBe(sum(IN_WINDOW_FOOD.map((f) => r2(f * 0.01))));
    expect(sales.totals.tax).toBe(sum(IN_WINDOW_FOOD.map((f) => r2(r2(f + r2(f * 0.01)) * 0.025) * 2)));
  });

  test("a discount is reported as money, and gross minus discount is net", async () => {
    const sales = await db.GetSalesSummaryReport(RID, W);
    expect(sales.totals.discount).toBe(200);
    expect(sales.totals.gross).toBe(r2(EXPECTED_NET + 200));
    expect(r2(sales.totals.gross - sales.totals.discount)).toBe(sales.totals.net);
  });

  test("the Discount report's totals agree with the Sales Summary's discount", async () => {
    const disc = await db.GetDiscountReport(RID, W);
    const sales = await db.GetSalesSummaryReport(RID, W);
    expect(disc.totals.discount_amount).toBe(sales.totals.discount);
    expect(disc.totals.discounted_bills).toBe(1);
    expect(disc.totals.estimated_bills).toBe(0);
    expect(disc.rows).toHaveLength(1);
    expect(disc.rows[0]?.bill_no).toBe("1003");
    expect(disc.rows[0]?.discount_amount).toBe(200);
    expect(disc.rows[0]?.estimated).toBe(false);
  });

  test("the day series sums to the window totals — rows that do not add up to their own total are the first thing an auditor checks", async () => {
    const sales = await db.GetSalesSummaryReport(RID, W);
    expect(sum(sales.series.map((s) => s.grand_total))).toBe(sales.totals.grand_total);
    expect(sum(sales.series.map((s) => s.net))).toBe(sales.totals.net);
    expect(sales.series.reduce((s, x) => s + x.bills, 0)).toBe(sales.totals.bills);
    expect(sales.series.reduce((s, x) => s + x.covers, 0)).toBe(sales.totals.covers);
  });

  test("the Cover Size buckets sum to the window totals", async () => {
    const cover = await db.GetCoverSizeSummaryReport(RID, W);
    expect(sum(cover.rows.map((r) => r.grand_total))).toBe(EXPECTED_GRAND);
    expect(cover.rows.reduce((s, r) => s + r.covers, 0)).toBe(cover.totals.covers);
  });
});

// --- 2. CANCELLED IS NOT SALES ----------------------------------------------

describe("cancelled orders are not sales", () => {
  test("a voided order's food never reaches the Item Wise numbers", async () => {
    const item = await db.GetItemWiseReport(RID, { ...W, limit: 500 });
    const biryani = item.rows.find((r) => r.name === "Biryani");
    // ov1 cancelled 3 × Biryani at 1000. Only o3's 2 × 1000 is a sale.
    expect(biryani?.qty).toBe(2);
    expect(biryani?.gross_amount).toBe(2000);
  });

  test("the voided order is the SUBJECT of the Void report, with its own value", async () => {
    const voids = await db.GetVoidKotReport(RID, { ...W, limit: 500 });
    expect(voids.totals.voids).toBe(1);
    expect(voids.totals.value).toBe(3000);
    expect(voids.rows[0]?.order_id).toBe(VOID_ID);
    expect(voids.rows[0]?.table_name).toBe("T9");
    // Who and when come from the audit trail; the KOT number is deliberately not
    // guessed, because no column ties one back to an order.
    expect(voids.rows[0]?.voided_by).toBe("Asha Rao");
    expect(voids.rows[0]?.voided_at).toBe("2026-06-06T10:05:00.000Z");
    expect(voids.rows[0]?.kot_no).toBeNull();
  });

  test("A2: the recorded REASON reaches the Void report, and an unrecorded one reads blank", async () => {
    // THE POINT OF THE A2 CHANGE. The clients have been sending a reason all
    // along and PATCH /orders/:id/status discarded it, so this column was
    // permanently empty and the requirement ("a reason is required before the
    // action is processed and finalized") was true of the prompt and false of
    // the database.
    const voids = await db.GetVoidKotReport(RID, { ...W, limit: 500 });
    expect(voids.rows[0]?.reason).toBe("Guest changed their mind");
    expect(voids.rows[0]?.void_kind).toBe("guest_changed_mind");
    // SERVER-DERIVED, never self-reported — a void's stage is the fraud signal.
    expect(voids.rows[0]?.stage).toBe("after_print");
    // And the column is declared, so the CSV and the table render it.
    expect(voids.columns.map((c) => c.key)).toEqual(expect.arrayContaining(["reason", "stage"]));
  });

  test("A2: a cancel with NO recorded reason is a truthful blank, not a fabricated one", async () => {
    // Every order cancelled before 035, and every cancel a shipped till makes
    // without sending a reason. The report counts them; it does not invent a
    // reason or a stage for them, because a stage computed from the wrong
    // instant is a fabricated fraud signal pointing at a named employee.
    useFixtureDb(standardDb({ order_voids: [] }));
    const voids = await db.GetVoidKotReport(RID, { ...W, limit: 500 });
    expect(voids.totals.voids).toBe(1);
    expect(voids.rows[0]?.reason).toBeNull();
    expect(voids.rows[0]?.stage).toBeNull();
  });

  test("an unsettled bill is not revenue either", async () => {
    // b8 is 7777 of food still on the floor. If it leaked in, the grand total
    // would be nowhere near the hand-computed figure.
    const sales = await db.GetSalesSummaryReport(RID, W);
    expect(sales.totals.grand_total).toBe(EXPECTED_GRAND);
    expect(sales.totals.bills).toBe(6);
  });
});

// --- 3. COVERS ARE COUNTED ONCE PER SEATING ---------------------------------

describe("covers", () => {
  test("two bills on ONE seating are one party, not two", async () => {
    // S1 seated 4 and was billed twice. Counting per bill would report 8.
    // 4 (S1) + 2 (S2) + 1 (S3) + 3 (S4) = 10; b5 has no seating and adds none.
    const sales = await db.GetSalesSummaryReport(RID, W);
    expect(sales.totals.covers).toBe(10);
    expect(sales.totals.bills).toBe(6);
    expect(sales.totals.bills_without_covers).toBe(1);
  });

  test("APC is PRE-TAX and per cover; ABV is tax-inclusive and per bill", async () => {
    const sales = await db.GetSalesSummaryReport(RID, W);
    expect(sales.totals.apc).toBe(r2(EXPECTED_NET / 10));
    expect(sales.totals.abv).toBe(r2(EXPECTED_GRAND / 6));
    // The two must not be the same number — that would mean one of them is wrong.
    expect(sales.totals.apc).not.toBe(sales.totals.abv);
  });

  test("the Cover Size report treats a split bill as ONE party of its own size", async () => {
    const cover = await db.GetCoverSizeSummaryReport(RID, W);
    const four = cover.rows.find((r) => r.party_size === 4);
    expect(four?.parties).toBe(1);
    expect(four?.bills).toBe(2);
    expect(four?.covers).toBe(4);
    expect(four?.net).toBe(1500);
    expect(four?.spend_per_cover).toBe(375);
  });

  test("bills with no resolvable seating get their own bucket: money in, covers out", async () => {
    const cover = await db.GetCoverSizeSummaryReport(RID, W);
    const unknown = cover.rows.find((r) => r.party_size === null);
    expect(unknown?.bills).toBe(1);
    expect(unknown?.covers).toBe(0);
    expect(unknown?.spend_per_cover).toBeNull();
    expect(unknown?.grand_total).toBe(billOf(300).total);
    // It sorts last, so it never leads the table.
    expect(cover.rows[cover.rows.length - 1]?.party_size).toBeNull();
  });
});

// --- 4. THE RANGE, IN THE TENANT'S ZONE -------------------------------------

describe("the window", () => {
  test("the LAST day of the range is included — 23:30 IST on the 15th is in", async () => {
    // Dropping it is the "the numbers are short" bug, and no aggregate flags it.
    const orders = await db.GetOrderSummaryReport(RID, { ...W, limit: 500 });
    expect(orders.rows.map((r) => r.bill_no)).toContain("1006");
  });

  test("00:30 IST on the 16th is OUT, though it is still the 15th in UTC", async () => {
    const orders = await db.GetOrderSummaryReport(RID, { ...W, limit: 500 });
    expect(orders.rows.map((r) => r.bill_no)).not.toContain("1007");
  });

  test("the same instants land in different days for a tenant 14 hours ahead", async () => {
    // Kiritimati is UTC+14: the 15th ends 14 hours earlier than in IST, so the
    // 18:00Z bill has already rolled into the 16th and drops out.
    useFixtureDb(standardDb({ timezone: AHEAD }));
    const orders = await db.GetOrderSummaryReport(RID, { ...W, limit: 500 });
    expect(orders.rows.map((r) => r.bill_no)).not.toContain("1006");
  });

  test("and for a tenant 11 hours behind, the 16th's IST bill is still the 15th", async () => {
    useFixtureDb(standardDb({ timezone: BEHIND }));
    const orders = await db.GetOrderSummaryReport(RID, { ...W, limit: 500 });
    expect(orders.rows.map((r) => r.bill_no)).toContain("1007");
  });

  test("the window the SERVER used travels in every payload", async () => {
    const sales = await db.GetSalesSummaryReport(RID, W);
    expect(sales.meta.window).toMatchObject({ from: FROM, to: TO, days: 15, source: "range", clamped: [] });
    expect(sales.meta.timezone).toBe(IST);
  });

  test("a range wider than the cap is clamped and SAYS SO rather than answering quietly", async () => {
    const sales = await db.GetSalesSummaryReport(RID, { from: "2000-01-01", to: TO });
    expect(sales.meta.window.clamped).toContain("span_capped");
    expect(sales.meta.window.to).toBe(TO);
    expect(sales.meta.window.days).toBe(731);
  });

  test("a reversed drag is swapped, not emptied", async () => {
    const sales = await db.GetSalesSummaryReport(RID, { from: TO, to: FROM });
    expect(sales.meta.window.clamped).toContain("reversed");
    expect(sales.totals.grand_total).toBe(EXPECTED_GRAND);
  });
});

// --- 5. AN EMPTY WINDOW IS AN EMPTY REPORT ----------------------------------

describe("an empty window", () => {
  const EMPTY = { from: "2026-03-01", to: "2026-03-07" };

  test("every one of the fifteen returns zeros, with the asked-for dates, and never throws", async () => {
    // A restaurant that was closed all week must see its own date range with
    // zeros on it. A failed request reads to an owner as lost data.
    const item = await db.GetItemWiseReport(RID, EMPTY);
    expect(item.rows).toEqual([]);
    expect(item.totals.gross_amount).toBe(0);
    expect(item.meta.window.from).toBe(EMPTY.from);

    expect((await db.GetDiscountReport(RID, EMPTY)).totals.discount_amount).toBe(0);
    expect((await db.GetVoidKotReport(RID, EMPTY)).totals.voids).toBe(0);
    expect((await db.GetBillEditReport(RID, EMPTY)).totals.edits).toBe(0);

    const sales = await db.GetSalesSummaryReport(RID, EMPTY);
    expect(sales.totals.grand_total).toBe(0);
    expect(sales.totals.apc).toBeNull();
    expect(sales.totals.abv).toBeNull();
    expect(sales.series).toEqual([]);

    expect((await db.GetOrderSummaryReport(RID, EMPTY)).rows).toEqual([]);
    expect((await db.GetCoverSizeSummaryReport(RID, EMPTY)).rows).toEqual([]);

    const settle = await db.GetSettlementSummaryReport(RID, EMPTY);
    expect(settle.rows).toEqual([]);
    expect(settle.totals.amount).toBe(0);

    const exec = await db.GetExecutiveSummaryReport(RID, EMPTY);
    expect(exec.current.grand_total).toBe(0);
    expect(exec.growth.grand_total).toBeNull();
    expect(exec.by_outlet).toEqual([]);
    expect(exec.totals.nc_value).toBe(0);
    expect(sales.totals.nc_value).toBe(0);

    // The six that read migrations 034-039. A window in which the restaurant
    // comped nothing, waived nothing, was tipped nothing and rang nothing is a
    // report full of zeros, never a failure.
    expect((await db.GetNcSummaryReport(RID, EMPTY)).totals.loss).toBe(0);
    expect((await db.GetServiceChargeDenyReport(RID, EMPTY)).totals.amount_waived).toBe(0);
    expect((await db.GetGroupSummaryReport(RID, EMPTY)).rows).toEqual([]);
    expect((await db.GetVariationSummaryReport(RID, EMPTY)).rows).toEqual([]);
    expect((await db.GetTipSummaryReport(RID, EMPTY)).totals.tip_amount).toBe(0);

    const counter = await db.GetCounterSummaryReport(RID, EMPTY);
    expect(counter.rows).toEqual([]);
    expect(counter.totals.grand_total).toBe(0);
    for (const report of [
      await db.GetNcSummaryReport(RID, EMPTY),
      await db.GetServiceChargeDenyReport(RID, EMPTY),
      await db.GetGroupSummaryReport(RID, EMPTY),
      await db.GetVariationSummaryReport(RID, EMPTY),
      await db.GetTipSummaryReport(RID, EMPTY),
      counter,
    ]) {
      expect(report.meta.window.from).toBe(EMPTY.from);
      expect(report.meta.window.to).toBe(EMPTY.to);
    }
  });

  test("a tenant with no rows at all still gets fifteen well-formed reports", async () => {
    useFixtureDb(makeDb({ timezone: IST }));
    const sales = await db.GetSalesSummaryReport(RID, W);
    expect(sales.totals.bills).toBe(0);
    expect(sales.columns.length).toBeGreaterThan(0);
    expect(sales.meta.outlet_name).toBe("Main");

    // ...and so do the six, on a tenant with no menu, no bills and no capture
    // rows of any kind.
    for (const report of [
      await db.GetNcSummaryReport(RID, W),
      await db.GetServiceChargeDenyReport(RID, W),
      await db.GetGroupSummaryReport(RID, W),
      await db.GetVariationSummaryReport(RID, W),
      await db.GetTipSummaryReport(RID, W),
      await db.GetCounterSummaryReport(RID, W),
    ]) {
      expect(report.columns.length).toBeGreaterThan(0);
      expect(report.meta.outlet_name).toBe("Main");
      expect(report.meta.notes.length).toBeGreaterThan(0);
    }
  });
});

// --- 6. TENANT ISOLATION -----------------------------------------------------

describe("one tenant cannot read another's rows", () => {
  test("another restaurant's 50,000 bill is in no report, in either outlet scope", async () => {
    const sales = await db.GetSalesSummaryReport(RID, W);
    expect(sales.totals.grand_total).toBe(EXPECTED_GRAND);

    const orders = await db.GetOrderSummaryReport(RID, { ...W, limit: 500 });
    expect(orders.rows.map((r) => r.bill_no)).not.toContain("9001");

    const all = await db.withTenant(
      { res_id: RES_ID, outlet_id: OUTLET_A, employeeId: "e1", role: "admin", allOutlets: true },
      () => db.GetOrderSummaryReport(RID, { ...W, limit: 500 }),
    );
    expect(all.rows.map((r) => r.bill_no)).not.toContain("9001");
  });

  test("another restaurant's void and bill edit are invisible too", async () => {
    const voids = await db.GetVoidKotReport(RID, { ...W, limit: 500 });
    expect(voids.rows.map((r) => r.order_id)).not.toContain(OTHER_VOID_ID);

    const edits = await db.GetBillEditReport(RID, { ...W, limit: 500 });
    expect(edits.rows.map((r) => r.item)).not.toContain("Secret");
  });

  test("another restaurant's comps, waivers and tips are invisible in every scope", async () => {
    // The capture tables carry their own res_id and their own outlet_id, so this
    // is a separate predicate from the one the bill reports rely on — and a
    // separate chance to lose it.
    useFixtureDb(captureDb());
    const scope = { res_id: RES_ID, outlet_id: OUTLET_A, employeeId: "e1", role: "admin", allOutlets: true };
    for (const read of [
      async () => (await db.GetNcSummaryReport(RID, { ...W, limit: 500 })).totals.loss,
      async () => (await db.GetServiceChargeDenyReport(RID, { ...W, limit: 500 })).totals.amount_waived,
      async () => (await db.GetTipSummaryReport(RID, { ...W, limit: 500 })).totals.tip_amount,
      async () => (await db.GetGroupSummaryReport(RID, W)).totals.gross_amount,
      async () => (await db.GetCounterSummaryReport(RID, W)).totals.grand_total,
    ]) {
      const own = await read();
      const everyOutlet = await db.withTenant(scope, read);
      // The other tenant's 9,000 comp, 5,000 waiver, 9,999 tip and 50,000 bill
      // would each be impossible to miss. Neither scope sees any of them.
      expect(everyOutlet).toBeLessThan(own + 50000);
      expect(own).toBeLessThan(50000);
    }
    const nc = await db.withTenant(scope, () => db.GetNcSummaryReport(RID, { ...W, limit: 500 }));
    expect(nc.rows.map((r) => r.item_name)).not.toContain("Secret");
    expect(nc.totals.loss).toBe(400);
  });

  test("the drill-downs refuse another tenant's ids", async () => {
    // A well-formed id belonging to ANOTHER restaurant simply resolves nothing.
    expect(await db.GetMisOrderDetail(RID, OTHER_VOID_ID)).toBeNull();
    // A malformed id is refused before it ever reaches SQL.
    expect(await db.GetMisOrderDetail(RID, "not-a-uuid")).toBeNull();
    // ...and this tenant's own order still opens, so the guard is not just
    // refusing everything.
    expect((await db.GetMisOrderDetail(RID, VOID_ID))?.id).toBe(VOID_ID);
  });
});

// --- Outlet scope + the Executive Summary ------------------------------------

describe("outlet scope", () => {
  test("a single-outlet read sees only its own outlet's money", async () => {
    const sales = await db.GetSalesSummaryReport(RID, W);
    // b9 (400 of food) belongs to OUTLET_B and must not be here.
    expect(sales.totals.grand_total).toBe(EXPECTED_GRAND);
    expect(sales.meta.outlet_scope).toBe("outlet");
    expect(sales.meta.outlet_id).toBe(OUTLET_A);
  });

  test("the ALL-OUTLETS aggregate read spans every outlet of the SAME restaurant", async () => {
    const all = await db.withTenant(
      { res_id: RES_ID, outlet_id: OUTLET_A, employeeId: "e1", role: "admin", allOutlets: true },
      () => db.GetSalesSummaryReport(RID, W),
    );
    expect(all.meta.outlet_scope).toBe("all");
    expect(all.meta.outlet_id).toBeNull();
    expect(all.totals.grand_total).toBe(r2(EXPECTED_GRAND + billOf(400).total));
    expect(all.totals.bills).toBe(7);
  });

  test("the Executive Summary breaks the group down by outlet, and the rows sum to the group", async () => {
    const exec = await db.withTenant(
      { res_id: RES_ID, outlet_id: OUTLET_A, employeeId: "e1", role: "admin", allOutlets: true },
      () => db.GetExecutiveSummaryReport(RID, W),
    );
    expect(exec.by_outlet).toHaveLength(2);
    expect(sum(exec.by_outlet.map((o) => o.grand_total))).toBe(exec.current.grand_total);
    expect(exec.by_outlet.map((o) => o.outlet_name)).toEqual(["Main", "Annexe"]);
    expect(sum(exec.by_outlet.map((o) => o.share_pct ?? 0))).toBeCloseTo(100, 1);
  });

  test("a single-outlet Executive Summary is one honest row, not an empty breakdown", async () => {
    const exec = await db.GetExecutiveSummaryReport(RID, W);
    expect(exec.by_outlet).toHaveLength(1);
    expect(exec.by_outlet[0]?.outlet_id).toBe(OUTLET_A);
    expect(exec.by_outlet[0]?.grand_total).toBe(EXPECTED_GRAND);
  });
});

describe("the Executive Summary's comparison period", () => {
  test("a whole month compares against the whole month before it, in calendar days", async () => {
    // June has 30 days and May has 31: an equal-DAY-COUNT comparison would have
    // measured June against 2-31 May, which is not a period anyone asked about.
    const may = bill({ id: "bm", bill_no: "0900", settled_at: "2026-05-20T09:00:00.000Z", food: 1000, session_id: "SM", covers: 2 });
    useFixtureDb(standardDb({ bills: [...standardDb().bills, may] }));
    const exec = await db.GetExecutiveSummaryReport(RID, { from: "2026-06-01", to: "2026-06-30" });
    expect(exec.previous_window).toEqual({ from: "2026-05-01", to: "2026-05-31", days: 31, basis: "months" });
    expect(exec.previous.grand_total).toBe(billOf(1000).total);
    expect(exec.growth.grand_total).toBeGreaterThan(0);
  });

  test("a drag inside one month compares against the SAME DATES a month earlier", async () => {
    // V3: the comparison is the matching date range, not a rolling window. See
    // previousWindow's header for what the old answer (2026-05-17 to 05-31) was
    // measuring and why no owner meant it.
    const exec = await db.GetExecutiveSummaryReport(RID, W);
    expect(exec.previous_window).toEqual({ from: "2026-05-01", to: "2026-05-15", days: 15, basis: "same_dates_prev_month" });
  });

  test("growth from a zero base is blank, not infinite", async () => {
    const exec = await db.GetExecutiveSummaryReport(RID, W);
    expect(exec.previous.grand_total).toBe(0);
    expect(exec.growth.grand_total).toBeNull();
    expect(exec.growth.covers).toBeNull();
  });
});

// --- The remaining reports ---------------------------------------------------

describe("Settlement Summary", () => {
  test("a split tender counts under each mode it touched, and the parts sum to the bill", async () => {
    const settle = await db.GetSettlementSummaryReport(RID, W);
    const cash = settle.rows.find((r) => r.method === "Cash");
    const card = settle.rows.find((r) => r.method === "Card");
    // Cash: b1 1060.50 + b5 318.16 + b6 106.05 + b4's 500 part.
    expect(cash?.bills).toBe(4);
    expect(card?.bills).toBe(2);
    expect(settle.totals.split_bills).toBe(1);
    expect(settle.totals.unallocated).toBe(0);
    expect(sum(settle.rows.map((r) => r.amount))).toBe(EXPECTED_GRAND);
  });

  test("a split whose parts do not reconstruct sends the residual to Unallocated, never into thin air", async () => {
    const base = standardDb();
    const broken = base.bills.map((b) => (b.id === "b4" ? { ...b, payment_splits: [{ method: "Cash", amount: 100 }] } : b));
    useFixtureDb(standardDb({ bills: broken }));
    const settle = await db.GetSettlementSummaryReport(RID, W);
    expect(settle.totals.unallocated).toBe(r2(billOf(800).total - 100));
    // The cash-up still balances — that is the whole point of the bucket.
    expect(sum(settle.rows.map((r) => r.amount))).toBe(EXPECTED_GRAND);
  });

  test("a bill with no recorded mode lands under Other rather than vanishing", async () => {
    const base = standardDb();
    const anon = base.bills.map((b) => (b.id === "b5" ? { ...b, payment_method: null } : b));
    useFixtureDb(standardDb({ bills: anon }));
    const settle = await db.GetSettlementSummaryReport(RID, W);
    expect(settle.rows.find((r) => r.method === "Other")?.amount).toBe(billOf(300).total);
    expect(sum(settle.rows.map((r) => r.amount))).toBe(EXPECTED_GRAND);
  });

  test("a refund follows the money it reversed, and Collected stays what the till took", async () => {
    const base = standardDb();
    const refunded = base.bills.map((b) => (b.id === "b1" ? { ...b, refund_amount: 1060.5 } : b));
    useFixtureDb(standardDb({ bills: refunded }));
    const settle = await db.GetSettlementSummaryReport(RID, W);
    const cash = settle.rows.find((r) => r.method === "Cash");
    expect(cash?.refund).toBe(1060.5);
    expect(cash?.net_amount).toBe(r2((cash?.amount ?? 0) - 1060.5));
    expect(sum(settle.rows.map((r) => r.amount))).toBe(EXPECTED_GRAND);
  });
});

// --- The Overview headline: today by payment method --------------------------
//
// "How much money from each payment method made in the day has to be shown."
// The Overview's block is the Settlement Summary cut over TODAY, through the
// same settlementByMethod — so this drives both readers over the same bills and
// requires the same answer. The headline reads its own clock, so the fixture
// settles its bills at noon of the restaurant's today.

describe("the Overview's today-by-method block", () => {
  function todayDb(): { db: FixtureDb; today: string } {
    const today = db.dayKeyOf(new Date(), IST);
    const noon = `${today}T06:30:00.000Z`; // 12:00 IST
    const yesterday = new Date(new Date(noon).getTime() - 86_400_000).toISOString();
    const at = (min: number): string => new Date(new Date(noon).getTime() + min * 60_000).toISOString();
    return {
      today,
      db: makeDb({
        timezone: IST,
        bills: [
          bill({ id: "t1", bill_no: "3001", settled_at: at(0), food: 1000, order_id: "to1", payment_method: "Cash" }),
          bill({ id: "t2", bill_no: "3002", settled_at: at(5), food: 500, order_id: "to2", payment_method: "Upi" }),
          // Split: cash part + card part that reconstruct the bill.
          bill({ id: "t3", bill_no: "3003", settled_at: at(10), food: 800, order_id: "to3", payment_method: "Split",
            payment_splits: [{ method: "Cash", amount: 500 }, { method: "Card", amount: 348.4 }] }),
          // Split that falls short: the residual is Unallocated, never lost.
          bill({ id: "t4", bill_no: "3004", settled_at: at(15), food: 300, order_id: "to4", payment_method: "Split",
            payment_splits: [{ method: "Upi", amount: 100 }] }),
          // Refunded card bill.
          bill({ id: "t5", bill_no: "3005", settled_at: at(20), food: 100, order_id: "to5", payment_method: "Card", refund_amount: 50 }),
          // A RELEASED table: no mode, no money. Counted in today_bills as it
          // always was, but it must not print as "Other ₹0.00".
          { id: "t6", bill_no: "3006", settled_at: at(25), total_amt: 0, tax_breakdown: [], payment_method: null },
          // Yesterday's cash: month to date, never today's drawer.
          bill({ id: "y1", bill_no: "2999", settled_at: yesterday, food: 700, payment_method: "Cash" }),
        ],
        orders: [
          order({ id: "to1", created_at: at(-30), status: 7 }),
          order({ id: "to2", created_at: at(-30), status: 7, order_type: "delivery" }),
          order({ id: "to3", created_at: at(-30), status: 7 }),
          order({ id: "to4", created_at: at(-30), status: 7 }),
          order({ id: "to5", created_at: at(-30), status: 7 }),
        ],
      }),
    };
  }

  test("its rows ARE the Settlement Summary's rows for today, less the ₹0 released table", async () => {
    const { db: fixture, today } = todayDb();
    useFixtureDb(fixture);
    const head = await db.GetOverviewHeadline(RID);
    const settle = await db.GetSettlementSummaryReport(RID, { from: today, to: today });

    expect(head.today).toBe(today);
    expect(head.today_by_method).toEqual(
      settle.rows.filter((r) => r.method === "Unallocated" || r.amount !== 0 || r.refund !== 0),
    );
    // The report keeps the Other row (its bills column always counted it)…
    expect(settle.rows.find((r) => r.method === "Other")).toMatchObject({ bills: 1, amount: 0 });
    // …the headline does not print it.
    expect(head.today_by_method.some((r) => r.method === "Other")).toBe(false);
    // NOT the report's split_bills. The report counts t3 and t4 — two bills cut
    // into parts — and keeps doing so. The headline's count is what both clients
    // print as "paid across more than one method", and t4 was paid by UPI alone:
    // its other part is the Unallocated residual. Only t3 (cash + card) was.
    expect(settle.totals.split_bills).toBe(2);
    expect(head.today_split_bills).toBe(1);
    expect(head.today_unallocated).toBe(settle.totals.unallocated);
    expect(head.today_unallocated).toBe(r2(billOf(300).total - 100));
    expect(head.by_method.label).toBeTruthy();
    expect(head.by_method.hint).toMatch(/gross/i);
  });

  test("THE INVARIANT: Σ today_by_method.amount === Today's gross sale", async () => {
    useFixtureDb(todayDb().db);
    const head = await db.GetOverviewHeadline(RID);
    expect(sum(head.today_by_method.map((r) => r.amount))).toBe(head.today_gross.value);
    expect(head.today_gross.value).toBe(sum([1000, 500, 800, 300, 100].map((f) => billOf(f).total)));
  });

  test("the Cash row IS the Cash collection tile — today's cash parts only", async () => {
    useFixtureDb(todayDb().db);
    const head = await db.GetOverviewHeadline(RID);
    const cash = head.today_by_method.find((r) => r.method === "Cash");
    expect(cash?.amount).toBe(head.cash_collection.value);
    // t1 whole + t3's ₹500 cash part. Yesterday's ₹700-of-food bill is not in it.
    expect(head.cash_collection.value).toBe(r2(billOf(1000).total + 500));
    expect(cash?.bills).toBe(2);
  });

  test("a refund shows against the mode that took the money", async () => {
    useFixtureDb(todayDb().db);
    const head = await db.GetOverviewHeadline(RID);
    const card = head.today_by_method.find((r) => r.method === "Card");
    // t5 refunded ₹50, all card; t3's card part carried no refund.
    expect(card?.refund).toBe(50);
    expect(card?.net_amount).toBe(r2((card?.amount ?? 0) - 50));
  });

  test("residuals that cancel across bills still ship the Unallocated row, with its bill count", async () => {
    // One split ₹50 short, one ₹50 over: the Unallocated bucket nets to ₹0.00
    // and today_unallocated is 0, so neither can say anything is wrong. The row's
    // bills column can, and it is what both clients warn off — so the ₹0 filter
    // that drops a released table must not drop this.
    const { db: fixture, today } = todayDb();
    const at = fixture.bills.find((b) => b.id === "t1")!.settled_at;
    const total = billOf(1000).total;
    useFixtureDb({
      ...fixture,
      bills: [
        bill({ id: "u1", bill_no: "4001", settled_at: at, food: 1000, order_id: "to1", payment_method: "Split",
          payment_splits: [{ method: "Cash", amount: 600 }, { method: "Upi", amount: r2(total - 650) }] }),
        bill({ id: "u2", bill_no: "4002", settled_at: at, food: 1000, order_id: "to3", payment_method: "Split",
          payment_splits: [{ method: "Cash", amount: 650 }, { method: "Upi", amount: r2(total - 600) }] }),
        { id: "u3", bill_no: "4003", settled_at: at, total_amt: 0, tax_breakdown: [], payment_method: null },
      ],
    });
    const head = await db.GetOverviewHeadline(RID);
    const settle = await db.GetSettlementSummaryReport(RID, { from: today, to: today });

    expect(head.today_unallocated).toBe(0);
    expect(settle.rows.find((r) => r.method === "Unallocated")).toMatchObject({ bills: 2, amount: 0 });
    expect(head.today_by_method.find((r) => r.method === "Unallocated")).toMatchObject({ bills: 2, amount: 0 });
    // The released ₹0 table is still left out, and the total still holds.
    expect(head.today_by_method.some((r) => r.method === "Other")).toBe(false);
    expect(sum(head.today_by_method.map((r) => r.amount))).toBe(head.today_gross.value);
  });

  test("nothing settled today is an empty list, not a row of zeroes", async () => {
    const { db: fixture } = todayDb();
    useFixtureDb({ ...fixture, bills: fixture.bills.filter((b) => b.id === "y1") });
    const head = await db.GetOverviewHeadline(RID);
    expect(head.today_bills).toBe(0);
    expect(head.today_by_method).toEqual([]);
    expect(head.today_split_bills).toBe(0);
    expect(head.today_unallocated).toBe(0);
  });
});

describe("Item Wise", () => {
  test("quantities, gross, average selling price and contribution", async () => {
    const item = await db.GetItemWiseReport(RID, { ...W, limit: 500 });
    const dal = item.rows.find((r) => r.name === "Dal");
    // o1 1×400 (dine-in), o2 1×500 (dine-in), o4 2×400 (delivery) = 4 @ 1700.
    expect(dal?.qty).toBe(4);
    expect(dal?.gross_amount).toBe(1700);
    expect(dal?.avg_selling_price).toBe(425);
    expect(dal?.dine_in_qty).toBe(2);
    expect(dal?.delivery_qty).toBe(2);
    expect(dal?.takeaway_qty).toBe(0);
    expect(sum(item.rows.map((r) => r.contribution_pct ?? 0))).toBeCloseTo(100, 1);
    expect(item.totals.gross_amount).toBe(sum(item.rows.map((r) => r.gross_amount)));
  });

  test("net equals gross, because a discount in this system is BILL-level", async () => {
    const item = await db.GetItemWiseReport(RID, { ...W, limit: 500 });
    for (const row of item.rows) {
      expect(row.discount_amount).toBe(0);
      expect(row.net_amount).toBe(row.gross_amount);
    }
    // ...and the money that WAS given away is reported, not hidden.
    expect(item.bill_level_discount).toBe(200);
  });

  test("category comes from a NAME join and is honest about being inexact", async () => {
    const item = await db.GetItemWiseReport(RID, { ...W, limit: 500 });
    expect(item.category_exact).toBe(false);
    expect(item.rows.find((r) => r.name === "Dal")?.category).toBe("Mains");
    // Biryani is not on the current menu — a renamed or deleted item shows blank
    // rather than being guessed into a category.
    expect(item.rows.find((r) => r.name === "Biryani")?.category).toBeNull();
  });

  test("search narrows the rows without breaking the report", async () => {
    const item = await db.GetItemWiseReport(RID, { ...W, search: "dal", limit: 500 });
    expect(item.rows.map((r) => r.name)).toEqual(["Dal"]);
  });
});

describe("Bill Edit", () => {
  test("a real edit is reported and a print is not", async () => {
    const edits = await db.GetBillEditReport(RID, { ...W, limit: 500 });
    const kinds = edits.rows.map((r) => r.kind);
    expect(kinds).toContain("item_removed");
    expect(kinds).toContain("order_cancelled");
    expect(edits.rows.some((r) => (r.description ?? "").startsWith("Printed"))).toBe(false);
    expect(edits.totals.edits).toBe(2);
  });

  test("the actor and the item ride along, and no before/after amount is invented", async () => {
    const edits = await db.GetBillEditReport(RID, { ...W, limit: 500 });
    const removal = edits.rows.find((r) => r.kind === "item_removed");
    expect(removal?.by).toBe("Bipin Shah");
    expect(removal?.item).toBe("Dal");
    expect(removal?.table_name).toBe("T1");
    // There is no amount_before / amount_after / difference anywhere on the row.
    expect(Object.keys(removal ?? {}).some((k) => /before|after|difference|delta/i.test(k))).toBe(false);
  });
});

describe("drill-down", () => {
  test("the KOT behind a void row opens with its items, its value and its trail", async () => {
    const detail = await db.GetMisOrderDetail(RID, VOID_ID);
    expect(detail?.status).toBe("Cancelled");
    expect(detail?.qty).toBe(3);
    expect(detail?.value).toBe(3000);
    expect(detail?.items[0]?.line_total).toBe(3000);
    expect(detail?.trail[0]?.by).toBe("Asha Rao");
  });
});

// --- The CSV export ----------------------------------------------------------

describe("the CSV export", () => {
  test("the sheet has the same columns, order and TOTALS row as the grid", async () => {
    const sales = await db.GetSalesSummaryReport(RID, W);
    const csv = renderMisCsv(sales.columns, sales.series, sales.totals);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(sales.columns.map((c) => c.label).join(","));
    expect(lines).toHaveLength(sales.series.length + 2); // header + rows + totals
    const totals = (lines[lines.length - 1] ?? "").split(",");
    expect(totals[0]).toBe("Total");
    // Figures that ARE the window's own — ABV and APC are not sums of the rows,
    // and covers are counted once per seating, so adding the rows would double a
    // split-billed party. All three must still appear.
    expect(Number(totals[sales.columns.findIndex((c) => c.key === "grand_total")])).toBe(EXPECTED_GRAND);
    expect(Number(totals[sales.columns.findIndex((c) => c.key === "covers")])).toBe(10);
    expect(Number(totals[sales.columns.findIndex((c) => c.key === "apc")])).toBe(sales.totals.apc);
    expect(Number(totals[sales.columns.findIndex((c) => c.key === "abv")])).toBe(sales.totals.abv);
  });

  test("a column that must never be summed stays blank in the TOTALS row", async () => {
    const item = await db.GetItemWiseReport(RID, { ...W, limit: 500 });
    const lines = renderMisCsv(item.columns, item.rows, item.totals).split("\n");
    const totals = (lines[lines.length - 1] ?? "").split(",");
    expect(totals[item.columns.findIndex((c) => c.key === "avg_selling_price")]).toBe("");
    expect(totals[item.columns.findIndex((c) => c.key === "contribution_pct")]).toBe("");
    expect(Number(totals[item.columns.findIndex((c) => c.key === "qty")])).toBe(item.totals.qty);
  });

  test("a blank is a blank — never the word null, and never a made-up zero", async () => {
    const cover = await db.GetCoverSizeSummaryReport(RID, W);
    const csv = renderMisCsv(cover.columns, cover.rows, cover.totals);
    expect(csv).not.toContain("null");
    expect(csv).not.toContain("undefined");
    // The unresolvable-seating row has no per-cover figure, and shows nothing.
    const unknown = csv.split("\n").find((l) => l.startsWith(","));
    expect(unknown).toBeDefined();
  });

  test("the Executive Summary's TOTALS row is the GROUP, not an empty line", async () => {
    const exec = await db.withTenant(
      { res_id: RES_ID, outlet_id: OUTLET_A, employeeId: "e1", role: "admin", allOutlets: true },
      () => db.GetExecutiveSummaryReport(RID, W),
    );
    const lines = renderMisCsv(exec.columns, exec.by_outlet, exec.totals).split("\n");
    const totals = (lines[lines.length - 1] ?? "").split(",");
    expect(totals[0]).toBe("Total");
    expect(Number(totals[exec.columns.findIndex((c) => c.key === "grand_total")])).toBe(exec.current.grand_total);
    expect(Number(totals[exec.columns.findIndex((c) => c.key === "share_pct")])).toBe(100);
  });

  test("a report with nothing to total emits no totals row at all", async () => {
    // Bill Edit's totals are a count and a per-kind breakdown; no COLUMN of the
    // grid has a window-level value, so a lone "Total,,,,,," would be noise.
    const edits = await db.GetBillEditReport(RID, { ...W, limit: 500 });
    const lines = renderMisCsv(edits.columns, edits.rows, edits.totals).split("\n");
    expect(lines).toHaveLength(edits.rows.length + 1);
    expect(lines[lines.length - 1]?.startsWith("Total,")).toBe(false);
  });
});

describe("the shell every report carries", () => {
  test("columns, totals and paging travel with each payload", async () => {
    const orders = await db.GetOrderSummaryReport(RID, { ...W, limit: 3, offset: 3 });
    expect(orders.columns.some((c) => c.key === "grand_total" && c.total === true)).toBe(true);
    expect(orders.page).toMatchObject({ limit: 3, offset: 3, total: 6, has_more: false });
    expect(orders.rows).toHaveLength(3);
  });

  test("every report names its caveats instead of leaving the reader to guess", async () => {
    for (const report of [
      await db.GetSalesSummaryReport(RID, W),
      await db.GetOrderSummaryReport(RID, W),
      await db.GetSettlementSummaryReport(RID, W),
      await db.GetCoverSizeSummaryReport(RID, W),
      await db.GetItemWiseReport(RID, W),
      await db.GetDiscountReport(RID, W),
      await db.GetVoidKotReport(RID, W),
      await db.GetBillEditReport(RID, W),
      await db.GetExecutiveSummaryReport(RID, W),
      await db.GetNcSummaryReport(RID, W),
      await db.GetServiceChargeDenyReport(RID, W),
      await db.GetGroupSummaryReport(RID, W),
      await db.GetVariationSummaryReport(RID, W),
      await db.GetTipSummaryReport(RID, W),
      await db.GetCounterSummaryReport(RID, W),
    ]) {
      expect(report.meta.notes.length).toBeGreaterThan(0);
      expect(report.columns.length).toBeGreaterThan(0);
      expect(report.meta.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  test("the hourly toggle re-buckets the same money without changing it", async () => {
    const day = await db.GetSalesSummaryReport(RID, W);
    const hour = await db.GetSalesSummaryReport(RID, { ...W, bucket: "hour" });
    expect(hour.bucket).toBe("hour");
    expect(hour.totals.grand_total).toBe(day.totals.grand_total);
    expect(sum(hour.series.map((s) => s.grand_total))).toBe(day.totals.grand_total);
    // Covers still count once per seating across the finer buckets.
    expect(hour.series.reduce((s, x) => s + x.covers, 0)).toBe(day.totals.covers);
    expect(hour.series[0]?.bucket).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/);
  });
});

// =============================================================================
// THE SIX CAPTURE REPORTS — migrations 034-039
// =============================================================================
//
// Same posture as everything above: the numbers below are derivable BY HAND from
// the fixture rows, and the reconciliations are asserted rather than assumed.
// The two that matter most:
//
//   Sigma Counter Summary rows.grand_total === Sales Summary grand total
//       — it is the same bill set, re-cut by till, so a bill that lost its
//         counter row must still land somewhere.
//   Sigma Group Summary rows.gross === Item Wise gross
//       — the same order lines, re-cut by menu group. Two item-level reports
//         that disagree about what sold are the same failure as two bill-level
//         reports that disagree about net sales.
//
// And the rule the whole tip feature lives or dies by: a tip appears in NO sales
// figure anywhere.

const COUNTER_1 = "c1c1c1c1-1111-4111-8111-c1c1c1c1c1c1";
const COUNTER_2 = "c2c2c2c2-2222-4222-8222-c2c2c2c2c2c2";

/**
 * The standard tenant, with the six capture tables filled in.
 *
 * The bills are the SAME bills — same totals, same seatings, same modes — so
 * every reconciliation asserted against EXPECTED_GRAND above still applies here.
 * What is added is what migrations 034-039 record about them.
 */
function captureDb(): FixtureDb {
  const base = standardDb();
  const counterOf: Record<string, string> = { b1: COUNTER_1, b2: COUNTER_1, b3: COUNTER_2 };
  const cashierOf: Record<string, [string, string]> = {
    b1: ["Asha", "Rao"], b2: ["Bipin", "Shah"], b3: ["Asha", "Rao"],
  };
  return {
    ...base,
    bills: base.bills.map((b) => ({
      ...b,
      counter_id: counterOf[b.id] ?? null,
      waiter_fname: cashierOf[b.id]?.[0] ?? b.waiter_fname ?? null,
      waiter_lname: cashierOf[b.id]?.[1] ?? b.waiter_lname ?? null,
    })),
    // The SAME orders, with the ids migration 039 stamps and the one comp flag
    // migration 034 writes. Menu-price value per dish:
    //   Paneer Tikka 600 + 200 + 250 = 1050   (three variations)
    //   Dal          400 + 500 + 800 = 1700   (400 of it comped)
    //   Biryani                       2000    (on the menu, in no group)
    //   Chai         300 + 100 =       400    (not on the menu at all)
    //                                 ----
    //                                 5150
    orders: [
      order({
        id: "o1", created_at: "2026-06-02T09:30:00.000Z", status: 7, taken_by: "Asha Rao",
        items: [
          { name: "Paneer Tikka", quantity: 2, price: 300, menu_id: "m-paneer", variation_id: "v-full", variation_name: "Full" },
          { name: "Dal", quantity: 1, price: 400, menu_id: "m-dal", nc: true },
        ],
      }),
      order({
        id: "o2", created_at: "2026-06-02T09:40:00.000Z", status: 7,
        items: [
          { name: "Dal", quantity: 1, price: 500, menu_id: "m-dal" },
          { name: "Paneer Tikka", quantity: 1, price: 200, menu_id: "m-paneer", variation_id: "v-half", variation_name: "Half" },
        ],
      }),
      order({
        id: "o3", created_at: "2026-06-05T07:30:00.000Z", status: 7, order_type: "takeaway", taken_by: "Bipin Shah",
        items: [{ name: "Biryani", quantity: 2, price: 1000, menu_id: "m-biryani" }],
      }),
      order({
        id: "o4", created_at: "2026-06-07T08:30:00.000Z", status: 7, order_type: "delivery",
        items: [
          { name: "Dal", quantity: 2, price: 400, menu_id: "m-dal" },
          // A variation this menu no longer has: a real sale of something retired.
          { name: "Paneer Tikka", quantity: 1, price: 250, menu_id: "m-paneer", variation_id: "v-gone", variation_name: "Jumbo" },
        ],
      }),
      order({ id: "o5", created_at: "2026-06-09T08:30:00.000Z", status: 7, items: [{ name: "Chai", quantity: 6, price: 50 }] }),
      order({ id: "o6", created_at: "2026-06-15T17:30:00.000Z", status: 7, items: [{ name: "Chai", quantity: 2, price: 50 }] }),
      order({ id: VOID_ID, created_at: "2026-06-06T10:00:00.000Z", status: 5, table_name: "T9", items: [{ name: "Biryani", quantity: 3, price: 1000 }] }),
      order({ id: OTHER_VOID_ID, created_at: "2026-06-06T10:00:00.000Z", status: 5, res_id: OTHER_RES_ID, outlet_id: OTHER_OUTLET, items: [{ name: "Biryani", quantity: 99, price: 1000 }] }),
    ],
    menu: [
      { id: "m-paneer", name: "Paneer Tikka", category: "Starters", group: "Food",
        variations: [{ id: "v-full", name: "Full", price: 300 }, { id: "v-half", name: "Half", price: 200 }] },
      { id: "m-dal", name: "Dal", category: "Mains", group: "Food" },
      // On the menu and in NO group: a configuration gap -> Unclassified.
      { id: "m-biryani", name: "Biryani", category: "Mains" },
      // "Chai" is on no menu row at all: a history gap -> Unattributed.
    ],
    non_chargeables: [
      { id: "nc1", created_at: "2026-06-02T09:45:00.000Z", order_id: "o1", item_name: "Dal", table_name: "T1",
        nc_kind: "complimentary", reason: "Guest waited 40 minutes", quantity: 1, unit_price: 400,
        menu_price_at_nc: 400, marked_by: "asha", authorised_by: "manager01" },
      // Reversed: still listed, and it gave away nothing.
      { id: "nc2", created_at: "2026-06-05T07:40:00.000Z", order_id: "o3", item_name: "Biryani", table_name: "T1",
        nc_kind: "staff_meal", reason: "Kitchen tasting", quantity: 1, unit_price: 1000,
        menu_price_at_nc: 1000, marked_by: "bipin", authorised_by: "manager01",
        reversed_at: "2026-06-05T08:30:00.000Z", reversed_by: "manager01", reversal_reason: "Wrong ticket" },
      // Another restaurant's comp. Must never appear, in either outlet scope.
      { id: "ncx", created_at: "2026-06-03T09:00:00.000Z", res_id: OTHER_RES_ID, outlet_id: OTHER_OUTLET,
        order_id: "ox", item_name: "Secret", nc_kind: "promo", reason: "Not ours", quantity: 9, unit_price: 9000,
        marked_by: "nobody", authorised_by: "nobody" },
    ],
    waivers: [
      { id: "w1", waived_at: "2026-06-05T07:55:00.000Z", bill_id: "b3", table_name: "T1",
        basis: "tax_line", basis_percent: 1, basis_amount: 1800, amount_waived: 18, tax_on_waived: 0.9,
        waiver_kind: "guest_complaint", reason: "Long wait", waived_by: "asha", authorised_by: "manager01" },
      { id: "w2", waived_at: "2026-06-07T08:50:00.000Z", bill_id: "b4", table_name: "T1",
        basis: "restaurant_percent", basis_percent: 5, basis_amount: 800, amount_waived: 40, tax_on_waived: 2,
        waiver_kind: "goodwill", reason: "Regular", waived_by: "bipin", authorised_by: "manager01",
        reversed_at: "2026-06-07T09:10:00.000Z", reversed_by: "manager01", reversal_reason: "Applied to the wrong bill" },
      { id: "wx", waived_at: "2026-06-03T09:00:00.000Z", res_id: OTHER_RES_ID, outlet_id: OTHER_OUTLET,
        bill_id: "bx", basis: "tax_line", basis_percent: 10, basis_amount: 50000, amount_waived: 5000, tax_on_waived: 250,
        waiver_kind: "policy", reason: "Not ours", waived_by: "nobody", authorised_by: "nobody" },
    ],
    tenders: [
      { id: "t1", bill_id: "b1", table_name: "T1", seq: 1, settled_at: "2026-06-02T10:00:00.000Z",
        method: "Cash", amount: 1060.5, tip_amount: 50, tip_mode: "cash", tip_credited_to: "asha", settled_by: "asha" },
      { id: "t2", bill_id: "b2", table_name: "T1", seq: 1, settled_at: "2026-06-02T10:05:00.000Z",
        method: "Card", amount: 530.26, tip_amount: 25, tip_mode: "card", tip_credited_to: "pool", settled_by: "bipin" },
      // No tip: not a row in a tip report.
      { id: "t3", bill_id: "b3", table_name: "T1", seq: 1, settled_at: "2026-06-05T08:00:00.000Z",
        method: "Upi", amount: 1908.9, settled_by: "asha" },
      // Keyed twice and voided: its tip is owed to nobody.
      { id: "t4", bill_id: "b5", table_name: "T1", seq: 2, settled_at: "2026-06-09T09:00:00.000Z",
        method: "Cash", amount: 318.15, tip_amount: 100, tip_mode: "cash", tip_credited_to: "asha",
        settled_by: "asha", voided_at: "2026-06-09T09:02:00.000Z" },
      { id: "tx", res_id: OTHER_RES_ID, outlet_id: OTHER_OUTLET, bill_id: "bx", seq: 1,
        settled_at: "2026-06-03T09:00:00.000Z", method: "Cash", amount: 50000, tip_amount: 9999,
        tip_mode: "cash", tip_credited_to: "nobody", settled_by: "nobody" },
    ],
    counters: [
      { id: COUNTER_1, code: "C1", name: "Front till", sort_order: 1 },
      { id: COUNTER_2, code: "C2", name: "Bar till", kind: "terminal", sort_order: 2 },
    ],
    cash_sessions: [
      { counter_id: COUNTER_1, opened_at: "2026-06-01T04:00:00.000Z", closed_at: "2026-06-02T18:00:00.000Z", variance: -50 },
      // Still open: a drawer that has not been counted has no closing time.
      { counter_id: COUNTER_2, opened_at: "2026-06-05T04:00:00.000Z", variance: 0 },
    ],
  };
}

/** Item Wise / Group / Variation all cut THESE lines. Menu-price value: 5150. */
const CAPTURE_ITEM_GROSS = 5150;

describe("NC Summary", () => {
  beforeEach(() => { useFixtureDb(captureDb()); });

  test("every comp, with both prices, the loss, the reason and the second name", async () => {
    const nc = await db.GetNcSummaryReport(RID, { ...W, limit: 500 });
    expect(nc.rows).toHaveLength(2);
    const live = nc.rows.find((r) => r.nc_id === "nc1");
    expect(live?.item_name).toBe("Dal");
    expect(live?.category).toBe("Mains");
    expect(live?.quantity).toBe(1);
    expect(live?.menu_price).toBe(400);
    expect(live?.nc_price).toBe(400);
    expect(live?.loss).toBe(400);
    expect(live?.reason).toBe("Guest waited 40 minutes");
    expect(live?.nc_kind).toBe("Complimentary");
    expect(live?.marked_by).toBe("asha");
    // THE control: a second name against every giveaway, never a copy of the first.
    expect(live?.authorised_by).toBe("manager01");
    expect(live?.waiter).toBe("Asha Rao");
    expect(live?.order_type).toBe("dine_in");
  });

  test("a reversed comp is still listed and gave away NOTHING", async () => {
    const nc = await db.GetNcSummaryReport(RID, { ...W, limit: 500 });
    const reversed = nc.rows.find((r) => r.nc_id === "nc2");
    expect(reversed?.reversed).toBe(true);
    expect(reversed?.loss).toBe(0);
    expect(reversed?.menu_value).toBe(0);
    expect(reversed?.reversed_loss).toBe(1000);
    expect(reversed?.reversed_by).toBe("manager01");
    // Every money column still adds up to its own total.
    expect(sum(nc.rows.map((r) => r.loss))).toBe(nc.totals.loss);
    expect(sum(nc.rows.map((r) => r.reversed_loss))).toBe(nc.totals.reversed_loss);
    expect(sum(nc.rows.map((r) => r.menu_value ?? 0))).toBe(nc.totals.menu_value);
  });

  test("the totals separate what was given away from what was taken back", async () => {
    const nc = await db.GetNcSummaryReport(RID, { ...W, limit: 500 });
    expect(nc.totals.entries).toBe(1);
    expect(nc.totals.reversed_entries).toBe(1);
    expect(nc.totals.loss).toBe(400);
    expect(nc.totals.reversed_loss).toBe(1000);
    expect(nc.totals.net_sales).toBe(EXPECTED_NET);
    expect(nc.totals.loss_pct_of_net).toBe(r2((400 / EXPECTED_NET) * 100));
    expect(nc.by_kind).toEqual([{ kind: "complimentary", label: "Complimentary", entries: 1, quantity: 1, loss: 400 }]);
  });

  test("the bill column is the bill the comp actually reduced", async () => {
    const nc = await db.GetNcSummaryReport(RID, { ...W, limit: 500 });
    // nc1 was comped at 15:15 IST on 2 June; the first bill on T1 that settled at
    // or after it is 1001, not the last bill the table ever had.
    expect(nc.rows.find((r) => r.nc_id === "nc1")?.bill_no).toBe("1001");
    expect(nc.rows.find((r) => r.nc_id === "nc2")?.bill_no).toBe("1003");
  });

  test("search narrows the rows, and another restaurant's comp is in neither scope", async () => {
    const found = await db.GetNcSummaryReport(RID, { ...W, search: "waited", limit: 500 });
    expect(found.rows.map((r) => r.nc_id)).toEqual(["nc1"]);
    const all = await db.withTenant(
      { res_id: RES_ID, outlet_id: OUTLET_A, employeeId: "e1", role: "admin", allOutlets: true },
      () => db.GetNcSummaryReport(RID, { ...W, limit: 500 }),
    );
    expect(all.rows.some((r) => r.item_name === "Secret")).toBe(false);
    expect(all.totals.loss).toBe(400);
  });
});

describe("the comped money sits BESIDE the ladder, never inside it", () => {
  beforeEach(() => { useFixtureDb(captureDb()); });

  test("the Sales Summary reports it without moving a single rung", async () => {
    const sales = await db.GetSalesSummaryReport(RID, W);
    // Every rung is exactly what it was before comps existed.
    expect(sales.totals.grand_total).toBe(EXPECTED_GRAND);
    expect(sales.totals.net).toBe(EXPECTED_NET);
    expect(r2(sales.totals.net + sales.totals.service_charge + sales.totals.tax)).toBe(EXPECTED_GRAND);
    // ...and the giveaway is reported next to them.
    expect(sales.totals.nc_value).toBe(400);
    expect(sales.non_chargeable).toMatchObject({
      value: 400, qty: 1, entries: 1, reversed_value: 1000, reversed_entries: 1,
    });
  });

  test("the NC column adds up to its own total, in both bucket modes", async () => {
    for (const bucket of ["day", "hour"] as const) {
      const sales = await db.GetSalesSummaryReport(RID, { ...W, bucket });
      expect(sum(sales.series.map((s) => s.nc_value))).toBe(sales.totals.nc_value);
      expect(sales.series.reduce((s, x) => s + x.nc_qty, 0)).toBe(sales.totals.nc_qty);
      // and the money still reconciles alongside it
      expect(sum(sales.series.map((s) => s.grand_total))).toBe(EXPECTED_GRAND);
    }
  });

  test("a day that comped something and settled nothing still gets a row", async () => {
    const base = captureDb();
    useFixtureDb({
      ...base,
      non_chargeables: [
        ...base.non_chargeables,
        // 14 June IST: no bill settled that day anywhere in the fixture.
        { id: "nc-quiet", created_at: "2026-06-14T06:00:00.000Z", order_id: "o1", item_name: "Dal",
          table_name: "T1", nc_kind: "spoilage", reason: "Dropped", quantity: 1, unit_price: 150,
          menu_price_at_nc: 150, marked_by: "asha", authorised_by: "manager01" },
      ],
    });
    const sales = await db.GetSalesSummaryReport(RID, W);
    const quiet = sales.series.find((s) => s.bucket === "2026-06-14");
    expect(quiet).toBeDefined();
    expect(quiet?.bills).toBe(0);
    expect(quiet?.grand_total).toBe(0);
    expect(quiet?.nc_value).toBe(150);
    expect(sum(sales.series.map((s) => s.nc_value))).toBe(sales.totals.nc_value);
    expect(sum(sales.series.map((s) => s.grand_total))).toBe(EXPECTED_GRAND);
  });

  test("the Executive Summary carries it per outlet, and the rows sum to the group", async () => {
    const exec = await db.withTenant(
      { res_id: RES_ID, outlet_id: OUTLET_A, employeeId: "e1", role: "admin", allOutlets: true },
      () => db.GetExecutiveSummaryReport(RID, W),
    );
    expect(exec.totals.nc_value).toBe(400);
    expect(sum(exec.by_outlet.map((o) => o.nc_value))).toBe(exec.totals.nc_value);
    expect(exec.by_outlet.find((o) => o.outlet_id === OUTLET_A)?.nc_value).toBe(400);
    expect(exec.by_outlet.find((o) => o.outlet_id === OUTLET_B)?.nc_value).toBe(0);
  });

  test("Item Wise counts the comped food as sold AND reports what it gave away", async () => {
    const item = await db.GetItemWiseReport(RID, { ...W, limit: 500 });
    const dal = item.rows.find((r) => r.name === "Dal");
    // The dish was made and served: it is still in qty and gross.
    expect(dal?.qty).toBe(4);
    expect(dal?.gross_amount).toBe(1700);
    expect(dal?.net_amount).toBe(1700);
    // ...and the part of it nobody paid for is reported.
    expect(dal?.nc_qty).toBe(1);
    expect(dal?.nc_value).toBe(400);
    expect(item.totals.nc_value).toBe(400);
    expect(item.totals.gross_amount).toBe(CAPTURE_ITEM_GROSS);
    expect(sum(item.rows.map((r) => r.nc_value))).toBe(item.totals.nc_value);
  });
});

describe("Service Charge Deny", () => {
  beforeEach(() => { useFixtureDb(captureDb()); });

  test("the percentage, the base and the charge are the numbers 036 measured", async () => {
    const deny = await db.GetServiceChargeDenyReport(RID, { ...W, limit: 500 });
    const live = deny.rows.find((r) => r.waiver_id === "w1");
    expect(live?.bill_no).toBe("1003");
    expect(live?.basis).toBe("Tax line");
    expect(live?.basis_percent).toBe(1);
    expect(live?.basis_amount).toBe(1800);
    expect(live?.amount_waived).toBe(18);
    expect(live?.tax_on_waived).toBe(0.9);
    expect(live?.grand_total_reduction).toBe(18.9);
    expect(live?.waiver_kind).toBe("Guest complaint");
    expect(live?.denied_by).toBe("asha");
    expect(live?.authorised_by).toBe("manager01");
    expect(live?.bill_grand_total).toBe(billOf(1800).total);
  });

  test("BOTH tax shapes are named, not guessed", async () => {
    const deny = await db.GetServiceChargeDenyReport(RID, { ...W, limit: 500 });
    expect(deny.rows.map((r) => r.basis).sort()).toEqual(["Restaurant %", "Tax line"]);
  });

  test("a reversed waiver put the charge back, so it denied nothing", async () => {
    const deny = await db.GetServiceChargeDenyReport(RID, { ...W, limit: 500 });
    const reversed = deny.rows.find((r) => r.waiver_id === "w2");
    expect(reversed?.reversed).toBe(true);
    expect(reversed?.amount_waived).toBe(0);
    expect(reversed?.grand_total_reduction).toBe(0);
    expect(reversed?.reversed_amount).toBe(42);
    expect(sum(deny.rows.map((r) => r.amount_waived))).toBe(deny.totals.amount_waived);
    expect(sum(deny.rows.map((r) => r.grand_total_reduction))).toBe(deny.totals.grand_total_reduction);
  });

  test("what was denied is measured against what was collected", async () => {
    const deny = await db.GetServiceChargeDenyReport(RID, { ...W, limit: 500 });
    const sales = await db.GetSalesSummaryReport(RID, W);
    expect(deny.totals.waivers).toBe(1);
    expect(deny.totals.reversed_waivers).toBe(1);
    expect(deny.totals.amount_waived).toBe(18);
    expect(deny.totals.service_charge_collected).toBe(sales.totals.service_charge);
    expect(deny.totals.denied_pct_of_chargeable).toBe(r2((18 / (18 + sales.totals.service_charge)) * 100));
  });

  test("a denied charge never becomes revenue, and another tenant's is invisible", async () => {
    const sales = await db.GetSalesSummaryReport(RID, W);
    expect(sales.totals.grand_total).toBe(EXPECTED_GRAND);
    const all = await db.withTenant(
      { res_id: RES_ID, outlet_id: OUTLET_A, employeeId: "e1", role: "admin", allOutlets: true },
      () => db.GetServiceChargeDenyReport(RID, { ...W, limit: 500 }),
    );
    expect(all.rows.some((r) => r.reason === "Not ours")).toBe(false);
    expect(all.totals.amount_waived).toBe(18);
  });
});

describe("Group Summary", () => {
  beforeEach(() => { useFixtureDb(captureDb()); });

  test("its gross equals Item Wise's gross — the same lines, cut a different way", async () => {
    const group = await db.GetGroupSummaryReport(RID, W);
    const item = await db.GetItemWiseReport(RID, { ...W, limit: 500 });
    expect(group.totals.gross_amount).toBe(item.totals.gross_amount);
    expect(group.totals.gross_amount).toBe(CAPTURE_ITEM_GROSS);
    expect(sum(group.rows.map((r) => r.gross_amount))).toBe(group.totals.gross_amount);
    expect(sum(group.rows.map((r) => r.contribution_pct ?? 0))).toBeCloseTo(100, 1);
  });

  test("a configured group rolls its dishes up", async () => {
    const group = await db.GetGroupSummaryReport(RID, W);
    const food = group.rows.find((r) => r.group_name === "Food");
    expect(food?.gap).toBe(false);
    expect(food?.items).toBe(2);              // Paneer Tikka + Dal
    expect(food?.gross_amount).toBe(2750);    // 1050 + 1700
    expect(food?.net_amount).toBe(2750);
    expect(food?.discount_amount).toBe(0);
    expect(food?.nc_value).toBe(400);
  });

  test("the two gaps are DIFFERENT gaps, and neither is folded into a group", async () => {
    const group = await db.GetGroupSummaryReport(RID, W);
    // On the menu, in no group: a configuration gap that shrinks as the menu is
    // classified.
    const unclassified = group.rows.find((r) => r.group_name === "Unclassified");
    expect(unclassified?.gap).toBe(true);
    expect(unclassified?.group_id).toBeNull();
    expect(unclassified?.gross_amount).toBe(2000);   // Biryani
    // On no menu row at all: a history gap that cannot be closed backwards.
    const unattributed = group.rows.find((r) => r.group_name === "Unattributed");
    expect(unattributed?.gap).toBe(true);
    expect(unattributed?.gross_amount).toBe(400);    // Chai
    expect(group.totals.unclassified_gross).toBe(2000);
    expect(group.totals.unattributed_gross).toBe(400);
    // Real groups first; the gaps last.
    expect(group.rows[0]?.gap).toBe(false);
    expect(group.rows[group.rows.length - 1]?.gap).toBe(true);
  });

  test("a cancelled order is not sales here either, and the bill discount is shown", async () => {
    const group = await db.GetGroupSummaryReport(RID, W);
    // The voided KOT was 3 x Biryani at 1000. Unclassified is 2000, not 5000.
    expect(group.rows.find((r) => r.group_name === "Unclassified")?.gross_amount).toBe(2000);
    expect(group.bill_level_discount).toBe(200);
  });
});

describe("Variation Summary", () => {
  beforeEach(() => { useFixtureDb(captureDb()); });

  test("one row per size, with the share of the dish it took", async () => {
    const v = await db.GetVariationSummaryReport(RID, W);
    expect(v.no_variations_configured).toBe(false);
    expect(v.rows.map((r) => r.variation_name).sort()).toEqual(["Full", "Half", "Jumbo"]);
    const full = v.rows.find((r) => r.variation_name === "Full");
    expect(full?.item_name).toBe("Paneer Tikka");
    expect(full?.qty).toBe(2);
    expect(full?.gross_amount).toBe(600);
    expect(full?.avg_price).toBe(300);
    expect(full?.list_price).toBe(300);
    expect(full?.item_share_pct).toBe(r2((600 / 1050) * 100));
    expect(sum(v.rows.map((r) => r.item_share_pct ?? 0))).toBeCloseTo(100, 1);
  });

  test("a retired variation keeps its label and claims no configured price", async () => {
    const v = await db.GetVariationSummaryReport(RID, W);
    const gone = v.rows.find((r) => r.variation_name === "Jumbo");
    expect(gone?.resolved).toBe(false);
    expect(gone?.list_price).toBeNull();
    expect(gone?.avg_price).toBe(250);
    expect(gone?.gross_amount).toBe(250);
  });

  test("it is an honest SUBSET of Item Wise, and says how big a one", async () => {
    const v = await db.GetVariationSummaryReport(RID, W);
    const item = await db.GetItemWiseReport(RID, { ...W, limit: 500 });
    // Only Paneer Tikka is sold in sizes. Dal, Biryani and Chai are not here.
    expect(v.totals.items).toBe(1);
    expect(v.totals.gross_amount).toBe(1050);
    expect(v.window_gross).toBe(item.totals.gross_amount);
    expect(v.totals.gross_amount).toBeLessThan(v.window_gross);
    expect(sum(v.rows.map((r) => r.gross_amount))).toBe(v.totals.gross_amount);
  });

  test("a variation is never inferred from an item name", async () => {
    const base = captureDb();
    useFixtureDb({
      ...base,
      orders: base.orders.map((o) => (o.id === "o5"
        // A waiter's hand-typed off-menu line. It names no variation id, and the
        // dish it looks like is not even on the menu.
        ? { ...o, items: [{ name: "Chai (Large)", quantity: 6, price: 50 }] }
        : o)),
    });
    const v = await db.GetVariationSummaryReport(RID, W);
    expect(v.rows.some((r) => /large/i.test(r.variation_name))).toBe(false);
    expect(v.totals.gross_amount).toBe(1050);
  });
});

describe("Tip Summary", () => {
  beforeEach(() => { useFixtureDb(captureDb()); });

  test("a tip appears in NO sales figure, anywhere", async () => {
    const tips = await db.GetTipSummaryReport(RID, { ...W, limit: 500 });
    expect(tips.totals.tip_amount).toBe(75);

    const sales = await db.GetSalesSummaryReport(RID, W);
    const orders = await db.GetOrderSummaryReport(RID, { ...W, limit: 500 });
    const settle = await db.GetSettlementSummaryReport(RID, W);
    const counter = await db.GetCounterSummaryReport(RID, W);
    // Every headline number is exactly what it is without a single tip recorded.
    expect(sales.totals.grand_total).toBe(EXPECTED_GRAND);
    expect(sum(orders.rows.map((r) => r.grand_total))).toBe(EXPECTED_GRAND);
    expect(sum(settle.rows.map((r) => r.amount))).toBe(EXPECTED_GRAND);
    expect(sum(counter.rows.map((r) => r.grand_total))).toBe(EXPECTED_GRAND);
    // ...and no per-cover or per-bill figure moved either.
    expect(sales.totals.apc).toBe(r2(EXPECTED_NET / 10));
    expect(sales.totals.abv).toBe(r2(EXPECTED_GRAND / 6));
    // The ladder does not even carry the word.
    expect(JSON.stringify(sales.totals)).not.toMatch(/tip/i);
  });

  test("who is owed what, in what form", async () => {
    const tips = await db.GetTipSummaryReport(RID, { ...W, limit: 500 });
    expect(tips.rows).toHaveLength(2);
    expect(tips.totals.tenders).toBe(2);
    expect(tips.totals.bills).toBe(2);
    const cash = tips.rows.find((r) => r.tender_id === "t1");
    expect(cash?.bill_no).toBe("1001");
    expect(cash?.tip_amount).toBe(50);
    expect(cash?.tip_mode).toBe("Cash");
    expect(cash?.credited_to).toBe("asha");
    expect(cash?.method).toBe("Cash");
    expect(tips.by_credited_to).toEqual([
      { credited_to: "asha", tips: 50, tenders: 1 },
      { credited_to: "pool", tips: 25, tenders: 1 },
    ]);
    expect(tips.by_mode.map((m) => m.mode)).toEqual(["cash", "card"]);
  });

  test("an untipped tender is not a row, and a voided one is owed to nobody", async () => {
    const tips = await db.GetTipSummaryReport(RID, { ...W, limit: 500 });
    expect(tips.rows.map((r) => r.tender_id).sort()).toEqual(["t1", "t2"]);
    expect(tips.totals.tip_amount).toBe(75);
  });

  test("the mirror the Settlement Summary reads NEVER carries a tip", async () => {
    // This is the one place a tip could become revenue. A settled bill's
    // payment_method / payment_splits are written from its live tenders by
    // mirrorTendersToBillColumns, and the Settlement Summary cashes up against
    // those two columns — not against the ledger. A tip folded into a part would
    // make the parts exceed the bill, which allocateSettlement books to the
    // Unallocated bucket, and the day would read high by the tips.
    const base = captureDb();
    const b1Total = billOf(1000).total;                       // 1060.50
    useFixtureDb({
      ...base,
      tenders: [
        ...base.tenders.filter((t) => t.id !== "t1"),
        { id: "t1a", bill_id: "b1", table_name: "T1", seq: 1, settled_at: "2026-06-02T10:00:00.000Z",
          method: "Cash", amount: 500, tip_amount: 50, tip_mode: "cash", tip_credited_to: "asha", settled_by: "asha" },
        { id: "t1b", bill_id: "b1", table_name: "T1", seq: 2, settled_at: "2026-06-02T10:00:00.000Z",
          method: "Card", amount: r2(b1Total - 500), tip_amount: 10, tip_mode: "card", tip_credited_to: "pool", settled_by: "asha" },
      ],
    });

    const ledger = await db.GetBillPaymentLedger(RID, { bill_id: "b1" });
    expect(ledger.payment_method).toBe("Split");
    expect(ledger.tips_total).toBe(60);
    // The parts reconstruct the BILL — not the bill plus the tips.
    expect(sum(ledger.payment_splits.map((p) => p.amount))).toBe(b1Total);
    expect(ledger.tendered).toBe(b1Total);

    // Feed that mirror straight into the sheet the cashier cashes up against.
    const withMirror = captureDb();
    useFixtureDb({
      ...withMirror,
      bills: withMirror.bills.map((b) => (b.id === "b1"
        ? { ...b, payment_method: ledger.payment_method, payment_splits: ledger.payment_splits }
        : b)),
    });
    const settle = await db.GetSettlementSummaryReport(RID, W);
    expect(sum(settle.rows.map((r) => r.amount))).toBe(EXPECTED_GRAND);
    // Nothing left over in either direction: the tips are simply not here.
    expect(settle.totals.unallocated).toBe(0);
    expect(settle.rows.some((r) => r.method === "Unallocated")).toBe(false);
  });

  test("the tender's own amount is not a column, and another tenant's tip is invisible", async () => {
    const tips = await db.withTenant(
      { res_id: RES_ID, outlet_id: OUTLET_A, employeeId: "e1", role: "admin", allOutlets: true },
      () => db.GetTipSummaryReport(RID, { ...W, limit: 500 }),
    );
    expect(tips.columns.some((c) => c.key === "amount" || c.key === "tender_amount")).toBe(false);
    expect(tips.totals.tip_amount).toBe(75);
    expect(tips.rows.some((r) => r.credited_to === "nobody")).toBe(false);
  });
});

describe("Counter Summary", () => {
  beforeEach(() => { useFixtureDb(captureDb()); });

  test("Sigma rows === the Sales Summary's grand total: the same bills, re-cut by till", async () => {
    const counter = await db.GetCounterSummaryReport(RID, W);
    const sales = await db.GetSalesSummaryReport(RID, W);
    expect(sum(counter.rows.map((r) => r.grand_total))).toBe(EXPECTED_GRAND);
    expect(counter.totals.grand_total).toBe(sales.totals.grand_total);
    expect(sum(counter.rows.map((r) => r.net))).toBe(sales.totals.net);
    expect(sum(counter.rows.map((r) => r.discount))).toBe(sales.totals.discount);
  });

  test("covers are still counted once per seating, ACROSS tills as well as within one", async () => {
    const counter = await db.GetCounterSummaryReport(RID, W);
    const sales = await db.GetSalesSummaryReport(RID, W);
    expect(counter.rows.reduce((s, r) => s + r.covers, 0)).toBe(sales.totals.covers);
    // b1 and b2 are one party of four, split across two bills on one till.
    expect(counter.rows.find((r) => r.counter_code === "C1")?.covers).toBe(4);
    expect(counter.rows.find((r) => r.counter_code === "C1")?.bills).toBe(2);
  });

  test("a party that pays across TWO tills is still one party", async () => {
    // b1 and b2 are one seating of four. Put them on different tills: the covers
    // column must still add up to four, not eight. Counting each till's seatings
    // with a fresh set is exactly how a quiet Tuesday becomes a fictional
    // banquet, and it is invisible until somebody splits a bill at the bar.
    const base = captureDb();
    useFixtureDb({
      ...base,
      bills: base.bills.map((b) => (b.id === "b2" ? { ...b, counter_id: COUNTER_2 } : b)),
    });
    const counter = await db.GetCounterSummaryReport(RID, W);
    const sales = await db.GetSalesSummaryReport(RID, W);
    expect(counter.rows.find((r) => r.counter_code === "C1")?.covers).toBe(4);
    expect(counter.rows.find((r) => r.counter_code === "C2")?.covers).toBe(2);
    expect(counter.rows.reduce((s, r) => s + r.covers, 0)).toBe(sales.totals.covers);
    // The money still splits the ordinary way.
    expect(sum(counter.rows.map((r) => r.grand_total))).toBe(EXPECTED_GRAND);
  });

  test("a bill that recorded no till lands in an explicit row, never nowhere", async () => {
    const counter = await db.GetCounterSummaryReport(RID, W);
    const none = counter.rows.find((r) => r.counter_id === null);
    expect(none).toBeDefined();
    expect(none?.bills).toBe(3);   // b4, b5, b6
    expect(none?.grand_total).toBe(sum([800, 300, 100].map((f) => billOf(f).total)));
    // ...and it is the LAST row: it is not a till.
    expect(counter.rows[counter.rows.length - 1]?.counter_id).toBeNull();
  });

  test("the cashier, the mode split and the shift ride on the row", async () => {
    const counter = await db.GetCounterSummaryReport(RID, W);
    const c1 = counter.rows.find((r) => r.counter_code === "C1");
    expect(c1?.counter_name).toBe("Front till");
    expect(c1?.cashiers).toBe("Asha Rao, Bipin Shah");
    expect(c1?.cashier_count).toBe(2);
    expect(c1?.by_method.map((m) => m.method)).toEqual(["Cash", "Card"]);
    expect(sum(c1?.by_method.map((m) => m.amount) ?? [])).toBe(c1?.grand_total);
    expect(c1?.payment_modes).toContain("Cash");
    // The till was opened and counted: one closed shift, with its variance.
    expect(c1?.sessions).toBe(1);
    expect(c1?.opened_at).toBe("2026-06-01T04:00:00.000Z");
    expect(c1?.closed_at).toBe("2026-06-02T18:00:00.000Z");
    expect(c1?.variance).toBe(-50);
  });

  test("a drawer that has not been counted has NO closing time", async () => {
    const counter = await db.GetCounterSummaryReport(RID, W);
    const c2 = counter.rows.find((r) => r.counter_code === "C2");
    expect(c2?.sessions).toBe(1);
    expect(c2?.opened_at).toBe("2026-06-05T04:00:00.000Z");
    expect(c2?.closed_at).toBeNull();
    expect(c2?.counter_kind).toBe("terminal");
  });

  test("the ALL-OUTLETS read still reconciles, and never crosses a tenant", async () => {
    const scope = { res_id: RES_ID, outlet_id: OUTLET_A, employeeId: "e1", role: "admin", allOutlets: true };
    const counter = await db.withTenant(scope, () => db.GetCounterSummaryReport(RID, W));
    const sales = await db.withTenant(scope, () => db.GetSalesSummaryReport(RID, W));
    expect(sum(counter.rows.map((r) => r.grand_total))).toBe(sales.totals.grand_total);
    // OUTLET_B's bill has no till of its own, so it joins the unassigned row.
    expect(counter.rows.find((r) => r.counter_id === null)?.bills).toBe(4);
  });
});

describe("a tenant that has not run migrations 034-039", () => {
  // standardDb() has every capture table EMPTY, which is what a tenant one
  // migration behind reads as. Every one of the six must open with the asked-for
  // dates on it and no numbers, never a 500 — an owner reads a failed request as
  // lost data.
  beforeEach(() => { useFixtureDb(standardDb()); });

  test("all six open, empty and well-formed", async () => {
    const nc = await db.GetNcSummaryReport(RID, W);
    const deny = await db.GetServiceChargeDenyReport(RID, W);
    const tips = await db.GetTipSummaryReport(RID, W);
    const counter = await db.GetCounterSummaryReport(RID, W);
    const group = await db.GetGroupSummaryReport(RID, W);
    const variation = await db.GetVariationSummaryReport(RID, W);

    expect(nc.rows).toHaveLength(0);
    expect(nc.totals.loss).toBe(0);
    expect(deny.rows).toHaveLength(0);
    expect(deny.totals.amount_waived).toBe(0);
    expect(tips.rows).toHaveLength(0);
    expect(tips.totals.tip_amount).toBe(0);
    expect(variation.rows).toHaveLength(0);
    expect(variation.no_variations_configured).toBe(true);
    expect(counter.no_counters_configured).toBe(true);

    // The money reports still reconcile: nothing about the capture tables is
    // load-bearing for the ladder.
    expect(sum(counter.rows.map((r) => r.grand_total))).toBe(EXPECTED_GRAND);
    expect(counter.rows).toHaveLength(1);
    expect(counter.rows[0]?.counter_id).toBeNull();
    // Every line is unattributed on a tenant with no groups — and reported as
    // such rather than filed under an invented default.
    expect(group.totals.gross_amount).toBe(4700);
    expect(group.rows.every((r) => r.gap)).toBe(true);

    for (const report of [nc, deny, tips, counter, group, variation]) {
      expect(report.meta.window).toMatchObject({ from: FROM, to: TO });
      expect(report.meta.notes.length).toBeGreaterThan(0);
      expect(report.columns.length).toBeGreaterThan(0);
    }
  });

  test("the Sales Summary reports zero given away rather than nothing at all", async () => {
    const sales = await db.GetSalesSummaryReport(RID, W);
    expect(sales.totals.nc_value).toBe(0);
    expect(sales.non_chargeable.entries).toBe(0);
    expect(sales.totals.grand_total).toBe(EXPECTED_GRAND);
  });
});

describe("the six export like the nine", () => {
  beforeEach(() => { useFixtureDb(captureDb()); });

  test("each sheet has the grid's columns and a TOTALS row that adds up", async () => {
    const cases: { columns: MisColumn[]; rows: object[]; totals: object; key: string; expected: number }[] = [
      await (async () => {
        const r = await db.GetNcSummaryReport(RID, { ...W, limit: 500 });
        return { columns: r.columns, rows: r.rows, totals: r.totals, key: "loss", expected: 400 };
      })(),
      await (async () => {
        const r = await db.GetServiceChargeDenyReport(RID, { ...W, limit: 500 });
        return { columns: r.columns, rows: r.rows, totals: r.totals, key: "amount_waived", expected: 18 };
      })(),
      await (async () => {
        const r = await db.GetGroupSummaryReport(RID, W);
        return { columns: r.columns, rows: r.rows, totals: r.totals, key: "gross_amount", expected: CAPTURE_ITEM_GROSS };
      })(),
      await (async () => {
        const r = await db.GetVariationSummaryReport(RID, W);
        return { columns: r.columns, rows: r.rows, totals: r.totals, key: "gross_amount", expected: 1050 };
      })(),
      await (async () => {
        const r = await db.GetTipSummaryReport(RID, { ...W, limit: 500 });
        return { columns: r.columns, rows: r.rows, totals: r.totals, key: "tip_amount", expected: 75 };
      })(),
      await (async () => {
        const r = await db.GetCounterSummaryReport(RID, W);
        return { columns: r.columns, rows: r.rows, totals: r.totals, key: "grand_total", expected: EXPECTED_GRAND };
      })(),
    ];
    for (const c of cases) {
      const lines = renderMisCsv(c.columns, c.rows, c.totals).split("\n");
      expect(lines[0]).toBe(c.columns.map((x) => x.label).join(","));
      expect(lines).toHaveLength(c.rows.length + 2);
      const totals = (lines[lines.length - 1] ?? "").split(",");
      expect(totals[0]).toBe("Total");
      expect(Number(totals[c.columns.findIndex((x) => x.key === c.key)])).toBe(c.expected);
      expect(renderMisCsv(c.columns, c.rows, c.totals)).not.toContain("undefined");
    }
  });
});
