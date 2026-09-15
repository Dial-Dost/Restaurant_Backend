// TIME SLOTS ON REAL MONEY, THROUGH THE REAL READERS.
//
// jest-tests/report_window.test.ts proves the slot contract in isolation. This
// suite proves what an owner actually relies on when they pick "Lunch":
//
//   1. THE HEADLINE NUMBERS STILL AGREE UNDER A SLOT. Sales = Σ Order =
//      Σ Settlement = Σ Counter, and Item Wise gross = Group gross, because
//      every read in a clock family is cut by the same minutes. One reader that
//      forgot the slot breaks this while every all-day test stays green.
//   2. THE SLOTS PARTITION THE DAY. Lunch + Dinner + the two gaps (00:00-12:00
//      and 17:00-18:00) equal the whole day, for every rung of every one of the
//      fifteen reports — no rupee is counted twice and none vanishes between two
//      presets. The client's own presets leave those gaps, and production has
//      money in them.
//   3. MIDNIGHT. A slot that crosses midnight belongs to the day it starts on;
//      Dinner 18:00-24:00 does not cross it.
//   4. ALL DAY IS UNCHANGED. No slot, slot=all and 00:00-24:00 are one payload,
//      and none of them issues a time-of-day predicate or reads the presets.
//
// The fixture MODELS the slot from the SQL text and refuses a slot-bound query
// without its predicate (see mis_fixtures.ts), so none of this can pass
// vacuously against the whole day.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import {
  OTHER_OUTLET,
  OTHER_RES_ID,
  OUTLET_A,
  OUTLET_B,
  RES_ID,
  fixtureQuery,
  makeDb,
  useFixtureDb,
  type FixtureBill,
  type FixtureDb,
  type FixtureOrder,
  type FixtureOrderItem,
} from "./mis_fixtures";

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
const W = { from: "2026-06-01", to: "2026-06-15" };
const LUNCH = { ...W, slot: "lunch" };
const DINNER = { ...W, slot: "dinner" };
/** The two gaps the client's presets leave. Custom slots, so every report can be asked for them. */
const EARLY = { ...W, time_from: "00:00", time_to: "12:00" };
const TEA = { ...W, time_from: "17:00", time_to: "18:00" };
const LATE_NIGHT = { ...W, time_from: "22:00", time_to: "02:00" };

const r2 = (n: number): number => Number(n.toFixed(2));
const sum = (xs: number[]): number => r2(xs.reduce((s, x) => s + x, 0));

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL ?? "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../../database_supabase");
});

// --- the fixture -------------------------------------------------------------

/** A wall-clock time in Kolkata ("2026-06-02 13:00[:ss]") as the UTC instant stored. */
function ist(local: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!m) {throw new Error(`bad local time ${local}`);}
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  return new Date(utc - 330 * 60_000).toISOString();
}

/** Same bill shape as the agreement suite: food -> SC 1% -> SGST/CGST 2.5% each. */
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

function bill(over: Partial<FixtureBill> & { id: string; bill_no: string; at: string; food: number }): FixtureBill {
  const { food, at, ...rest } = over;
  const b = billOf(food);
  return {
    settled_at: ist(at), total_amt: b.total, tax_breakdown: b.lines,
    payment_method: "Cash", table_name: "T1", session_id: `S-${over.id}`, covers: 2,
    ...rest,
  };
}

function order(id: string, at: string, items: FixtureOrderItem[], over: Partial<FixtureOrder> = {}): FixtureOrder {
  return { id, created_at: ist(at), status: 7, order_type: "dine_in", table_name: "T1", items, ...over };
}

const dal = (quantity: number): FixtureOrderItem => ({ name: "Dal", quantity, price: 300, menu_id: "m-dal" });
const naan = (quantity: number): FixtureOrderItem => ({ name: "Naan", quantity, price: 50, menu_id: "m-naan" });
const chai = (quantity: number): FixtureOrderItem => ({ name: "Chai", quantity, price: 50 });
const biryani = (quantity: number): FixtureOrderItem => ({ name: "Biryani", quantity, price: 1000, menu_id: "m-biryani" });

const COUNTER_1 = "c1c1c1c1-1111-4111-8111-c1c1c1c1c1c1";
const COUNTER_2 = "c2c2c2c2-2222-4222-8222-c2c2c2c2c2c2";
const CATCH_ALL = "4ad474d4-5230-449c-874f-6a238b833bca";
const VOID_LUNCH = "11111111-aaaa-4aaa-8aaa-111111111111";
const VOID_DINNER = "33333333-cccc-4ccc-8ccc-333333333333";

/**
 * A fortnight with money in every part of the day. Settlement times, IST:
 *
 *   LUNCH 12-17   L1 2 Jun 13:00 (1000)   L2 2 Jun 16:59:30 (500, same seating)
 *   DINNER 18-24  D1 5 Jun 20:00 (1800, 200 off)   D2 5 Jun 23:59 (700)   D3 15 Jun 22:30 (150)
 *   00:00-12:00   EARLY 1 Jun 01:30 (400)   LATE 7 Jun 00:30 (900)   BRK 9 Jun 09:00 (250, no seating)
 *   17:00-18:00   E17 3 Jun 17:00:00 exactly (300) — NOT Lunch
 *   beyond W      AFTER 16 Jun 01:30 (600) — out of 1-15 June, in the 15th's 22:00-02:00
 *   elsewhere     L3 at OUTLET_B at lunch; another restaurant's lunch; an unsettled lunch bill
 *
 * Order placement differs on purpose: LATE's order was placed 6 Jun 22:30
 * (Dinner, on the order clock) and AFTER's 15 Jun 23:30 (inside the window).
 */
function slotDb(over: Partial<FixtureDb> = {}): FixtureDb {
  return makeDb({
    timezone: "Asia/Kolkata",
    bills: [
      bill({ id: "L1", bill_no: "101", at: "2026-06-02 13:00", food: 1000, session_id: "SL1", covers: 4, order_id: "oL1", counter_id: COUNTER_1 }),
      bill({ id: "L2", bill_no: "102", at: "2026-06-02 16:59:30", food: 500, session_id: "SL1", covers: 4, order_id: "oL2", payment_method: "Card", counter_id: COUNTER_2 }),
      bill({ id: "E17", bill_no: "103", at: "2026-06-03 17:00", food: 300, covers: 1, order_id: "oE17" }),
      bill({ id: "D1", bill_no: "104", at: "2026-06-05 20:00", food: 1800, order_id: "oD1", discount_type: "flat", discount_value: 200, payment_method: "Upi", counter_id: COUNTER_1 }),
      bill({ id: "D2", bill_no: "105", at: "2026-06-05 23:59", food: 700, covers: 3, order_id: "oD2", payment_method: "Split", payment_splits: [{ method: "Cash", amount: 400 }, { method: "Card", amount: r2(billOf(700).total - 400) }] }),
      bill({ id: "LATE", bill_no: "106", at: "2026-06-07 00:30", food: 900, order_id: "oN1", payment_method: "Upi" }),
      bill({ id: "BRK", bill_no: "107", at: "2026-06-09 09:00", food: 250, session_id: null, order_id: "oB" }),
      bill({ id: "EARLY", bill_no: "108", at: "2026-06-01 01:30", food: 400, order_id: "oX1" }),
      bill({ id: "D3", bill_no: "109", at: "2026-06-15 22:30", food: 150, order_id: "oD3" }),
      bill({ id: "AFTER", bill_no: "110", at: "2026-06-16 01:30", food: 600, order_id: "oA1" }),
      bill({ id: "L3", bill_no: "201", at: "2026-06-08 13:30", food: 400, outlet_id: OUTLET_B, payment_method: "Card", order_id: "oB1" }),
      bill({ id: "UNSETTLED", bill_no: "199", at: "2026-06-02 14:00", food: 7777, settled: false }),
      bill({ id: "BX", bill_no: "901", at: "2026-06-02 13:00", food: 50000, res_id: OTHER_RES_ID, outlet_id: OTHER_OUTLET }),
      // Last month, for the Executive Summary's comparison period (same dates, May 1-15).
      bill({ id: "M1", bill_no: "051", at: "2026-05-03 13:00", food: 800 }),
      bill({ id: "M2", bill_no: "052", at: "2026-05-03 20:00", food: 1200 }),
    ],
    orders: [
      order("oL1", "2026-06-02 12:10", [dal(2), naan(8)]),                       // 1000
      order("oL2", "2026-06-02 12:20", [dal(1), naan(4)]),                       //  500
      order("oE17", "2026-06-03 16:50", [chai(6)]),                              //  300 — Lunch on the ORDER clock
      order("oD1", "2026-06-05 19:00", [biryani(2)], { order_type: "takeaway" }), // 2000
      order("oD2", "2026-06-05 23:00", [{ name: "Paneer", quantity: 2, price: 350, menu_id: "m-paneer", variation_id: "v-full", variation_name: "Full" }]), // 700
      order("oN1", "2026-06-06 22:30", [dal(3)]),                                //  900 — Dinner on the ORDER clock
      order("oB", "2026-06-09 08:45", [chai(5)]),                                //  250
      order("oX1", "2026-05-31 23:40", [naan(8)]),                               //  400 — before the window
      order("oD3", "2026-06-15 22:00", [chai(3)]),                               //  150
      order("oA1", "2026-06-15 23:30", [dal(2)]),                                //  600 — in the window on this clock
      order("oB1", "2026-06-08 13:00", [naan(8)], { outlet_id: OUTLET_B }),
      order(VOID_LUNCH, "2026-06-02 13:15", [biryani(3)], { status: 5 }),
      order(VOID_DINNER, "2026-06-05 21:00", [chai(2)], { status: 5 }),
      order("oBX", "2026-06-02 12:30", [biryani(50)], { res_id: OTHER_RES_ID, outlet_id: OTHER_OUTLET }),
    ],
    audits: [
      { id: "a1", created_at: ist("2026-06-02 14:00"), action_id: CATCH_ALL, action_name: "Add Orders", reason: "Removed item Naan from table T1", details: { table: "T1", item: "Naan" }, fname: "Asha", lname: "Rao" },
      { id: "a2", created_at: ist("2026-06-05 22:00"), action_id: CATCH_ALL, action_name: "Add Orders", reason: "Removed item Dal from table T2", details: { table: "T2", item: "Dal" }, fname: "Asha", lname: "Rao" },
      { id: "a3", created_at: ist("2026-06-09 09:30"), action_id: CATCH_ALL, action_name: "Add Orders", reason: "Removed item Chai from table T3", details: { table: "T3", item: "Chai" }, fname: "Bipin", lname: "Shah" },
    ],
    menu: [
      { id: "m-dal", name: "Dal", category: "Mains", group: "Food" },
      { id: "m-naan", name: "Naan", category: "Breads", group: "Food" },
      { id: "m-biryani", name: "Biryani", category: "Mains", group: "Food" },
      { id: "m-paneer", name: "Paneer", category: "Starters", group: "Food", variations: [{ id: "v-full", name: "Full", price: 350 }] },
    ],
    non_chargeables: [
      { id: "nc1", created_at: ist("2026-06-02 12:30"), order_id: "oL1", item_name: "Dal", table_name: "T1", nc_kind: "complimentary", reason: "Wait", quantity: 1, unit_price: 300, marked_by: "asha", authorised_by: "manager01" },
      { id: "nc2", created_at: ist("2026-06-05 19:30"), order_id: "oD1", item_name: "Biryani", table_name: "T1", nc_kind: "complimentary", reason: "Birthday", quantity: 1, unit_price: 1000, marked_by: "asha", authorised_by: "manager01" },
      { id: "nc3", created_at: ist("2026-06-03 17:30"), order_id: "oE17", item_name: "Chai", table_name: "T1", nc_kind: "staff_meal", reason: "Staff", quantity: 1, unit_price: 50, marked_by: "bipin", authorised_by: "manager01" },
      { id: "nc4", created_at: ist("2026-06-07 00:15"), order_id: "oN1", item_name: "Dal", table_name: "T1", nc_kind: "complimentary", reason: "Late", quantity: 1, unit_price: 300, marked_by: "bipin", authorised_by: "manager01" },
    ],
    waivers: [
      { id: "w1", waived_at: ist("2026-06-02 16:00"), bill_id: "L1", table_name: "T1", basis: "tax_line", basis_percent: 1, basis_amount: 1000, amount_waived: 10, tax_on_waived: 0.5, waiver_kind: "guest_complaint", reason: "Wait", waived_by: "asha", authorised_by: "manager01" },
      { id: "w2", waived_at: ist("2026-06-05 21:00"), bill_id: "D1", table_name: "T1", basis: "tax_line", basis_percent: 1, basis_amount: 1800, amount_waived: 18, tax_on_waived: 0.9, waiver_kind: "goodwill", reason: "Regular", waived_by: "asha", authorised_by: "manager01" },
      { id: "w3", waived_at: ist("2026-06-09 10:00"), bill_id: "BRK", table_name: "T1", basis: "tax_line", basis_percent: 1, basis_amount: 250, amount_waived: 2.5, tax_on_waived: 0.13, waiver_kind: "goodwill", reason: "Early", waived_by: "bipin", authorised_by: "manager01" },
    ],
    tenders: [
      { id: "t1", bill_id: "L1", table_name: "T1", seq: 1, settled_at: ist("2026-06-02 13:00"), method: "Cash", amount: billOf(1000).total, tip_amount: 50, tip_mode: "cash", tip_credited_to: "asha", settled_by: "asha" },
      { id: "t2", bill_id: "D1", table_name: "T1", seq: 1, settled_at: ist("2026-06-05 20:00"), method: "Upi", amount: billOf(1800).total, tip_amount: 100, tip_mode: "upi", tip_credited_to: "pool", settled_by: "asha" },
      { id: "t3", bill_id: "LATE", table_name: "T1", seq: 1, settled_at: ist("2026-06-07 00:30"), method: "Upi", amount: billOf(900).total, tip_amount: 30, tip_mode: "upi", tip_credited_to: "bipin", settled_by: "bipin" },
      { id: "t4", bill_id: "E17", table_name: "T1", seq: 1, settled_at: ist("2026-06-03 17:00"), method: "Cash", amount: billOf(300).total, tip_amount: 20, tip_mode: "cash", tip_credited_to: "bipin", settled_by: "bipin" },
    ],
    counters: [
      { id: COUNTER_1, code: "C1", name: "Front till", sort_order: 1 },
      { id: COUNTER_2, code: "C2", name: "Bar till", sort_order: 2 },
    ],
    cash_sessions: [
      { counter_id: COUNTER_1, opened_at: ist("2026-06-02 11:00"), closed_at: ist("2026-06-02 23:00"), variance: -20 },
    ],
    order_voids: [],
    ...over,
  });
}

const grand = (...foods: number[]): number => sum(foods.map((f) => billOf(f).total));

beforeEach(() => { useFixtureDb(slotDb()); });

// --- the fifteen, reduced to the figures that must partition ------------------

type Summary = Record<string, number>;
const q500 = (q: Record<string, unknown>) => ({ ...q, limit: 500 });

const FIFTEEN: [string, (q: Record<string, unknown>) => Promise<Summary>][] = [
  ["item_wise", async (q) => { const r = await db.GetItemWiseReport(RID, q500(q)); return { qty: r.totals.qty, gross: r.totals.gross_amount, nc_value: r.totals.nc_value, bill_level_discount: r.bill_level_discount }; }],
  ["discount", async (q) => { const r = await db.GetDiscountReport(RID, q500(q)); return { discount: r.totals.discount_amount, bills: r.totals.discounted_bills, grand_total: r.totals.grand_total }; }],
  ["void_kot", async (q) => { const r = await db.GetVoidKotReport(RID, q500(q)); return { voids: r.totals.voids, value: r.totals.value }; }],
  ["bill_edit", async (q) => { const r = await db.GetBillEditReport(RID, q500(q)); return { edits: r.totals.edits }; }],
  ["sales_summary", async (q) => {
    const t = (await db.GetSalesSummaryReport(RID, q)).totals;
    return { bills: t.bills, covers: t.covers, gross: t.gross, discount: t.discount, net: t.net, service_charge: t.service_charge, tax: t.tax, round_off: t.round_off, grand_total: t.grand_total, refund: t.refund, nc_value: t.nc_value, nc_qty: t.nc_qty };
  }],
  ["order_summary", async (q) => { const r = await db.GetOrderSummaryReport(RID, q500(q)); return { rows: r.page.total, grand_total: r.totals.grand_total, row_sum: sum(r.rows.map((x) => x.grand_total)) }; }],
  ["executive_summary", async (q) => { const r = await db.GetExecutiveSummaryReport(RID, q); return { grand_total: r.current.grand_total, net: r.current.net, bills: r.current.bills, covers: r.current.covers, nc_value: r.totals.nc_value, previous: r.previous.grand_total }; }],
  ["cover_size_summary", async (q) => { const r = await db.GetCoverSizeSummaryReport(RID, q); return { grand_total: r.totals.grand_total, covers: r.totals.covers, parties: r.totals.parties }; }],
  ["settlement_summary", async (q) => { const r = await db.GetSettlementSummaryReport(RID, q); return { amount: r.totals.amount, bills: r.totals.bills, row_sum: sum(r.rows.map((x) => x.amount)) }; }],
  ["nc_summary", async (q) => { const r = await db.GetNcSummaryReport(RID, q500(q)); return { loss: r.totals.loss, entries: r.totals.entries, quantity: r.totals.quantity, net_sales: r.totals.net_sales }; }],
  ["service_charge_deny", async (q) => { const r = await db.GetServiceChargeDenyReport(RID, q500(q)); return { waived: r.totals.amount_waived, tax: r.totals.tax_on_waived, waivers: r.totals.waivers, collected: r.totals.service_charge_collected }; }],
  ["group_summary", async (q) => { const r = await db.GetGroupSummaryReport(RID, q); return { gross: r.totals.gross_amount, qty: r.totals.qty }; }],
  ["variation_summary", async (q) => { const r = await db.GetVariationSummaryReport(RID, q); return { gross: r.totals.gross_amount, window_gross: r.window_gross }; }],
  ["tip_summary", async (q) => { const r = await db.GetTipSummaryReport(RID, q500(q)); return { tips: r.totals.tip_amount, tenders: r.totals.tenders }; }],
  ["counter_summary", async (q) => { const r = await db.GetCounterSummaryReport(RID, q); return { grand_total: r.totals.grand_total, bills: r.totals.bills, covers: r.totals.covers, row_sum: sum(r.rows.map((x) => x.grand_total)) }; }],
];

// --- 1. THE HEADLINE NUMBERS AGREE UNDER A SLOT ------------------------------

describe("under a time slot the headline numbers still agree", () => {
  test.each([
    ["Lunch", LUNCH, grand(1000, 500)],
    ["Dinner", DINNER, grand(1800, 700, 150)],
    ["22:00-02:00", LATE_NIGHT, grand(700, 900, 150, 600)],
  ])("%s: Sales = Σ Order = Σ Settlement = Σ Counter, and it is exactly that slot's bills", async (_name, q, expected) => {
    const sales = await db.GetSalesSummaryReport(RID, q);
    const orders = await db.GetOrderSummaryReport(RID, q500(q));
    const settle = await db.GetSettlementSummaryReport(RID, q);
    const counter = await db.GetCounterSummaryReport(RID, q);
    expect(sales.totals.grand_total).toBe(expected);
    expect(sum(orders.rows.map((r) => r.grand_total))).toBe(expected);
    expect(orders.totals.grand_total).toBe(expected);
    expect(sum(settle.rows.map((r) => r.amount))).toBe(expected);
    expect(sum(counter.rows.map((r) => r.grand_total))).toBe(expected);
    expect(sum(sales.series.map((s) => s.grand_total))).toBe(expected);
  });

  test("Lunch is 12:00 up to 17:00: 16:59:30 is in, 17:00:00 is out", async () => {
    const orders = await db.GetOrderSummaryReport(RID, q500(LUNCH));
    expect(orders.rows.map((r) => r.bill_no).sort()).toEqual(["101", "102"]);
    const tea = await db.GetOrderSummaryReport(RID, q500(TEA));
    expect(tea.rows.map((r) => r.bill_no)).toEqual(["103"]);
  });

  test("Item Wise gross = Group gross under a slot — on the ORDER clock", async () => {
    // Lunch placements: oL1 1000 + oL2 500 + oE17 300 (placed 16:50, settled 17:00).
    // Dinner placements: oD1 2000 + oD2 700 + oN1 900 (settled 00:30) + oD3 150 + oA1 600 (settled the 16th).
    for (const [q, gross] of [[LUNCH, 1800], [DINNER, 4350], [EARLY, 250], [TEA, 0]] as const) {
      const items = await db.GetItemWiseReport(RID, q500(q));
      const groups = await db.GetGroupSummaryReport(RID, q);
      expect(items.totals.gross_amount).toBe(gross);
      expect(groups.totals.gross_amount).toBe(gross);
      expect(groups.totals.qty).toBe(items.totals.qty);
    }
  });

  test("the ALL-OUTLETS read still reconciles under a slot, and never crosses a tenant", async () => {
    const ALL = { res_id: RES_ID, outlet_id: OUTLET_A, employeeId: "e1", role: "admin", allOutlets: true };
    const sales = await db.withTenant(ALL, () => db.GetSalesSummaryReport(RID, LUNCH));
    const settle = await db.withTenant(ALL, () => db.GetSettlementSummaryReport(RID, LUNCH));
    expect(sales.totals.grand_total).toBe(grand(1000, 500, 400));
    expect(sum(settle.rows.map((r) => r.amount))).toBe(sales.totals.grand_total);
  });
});

// --- 2. THE SLOTS PARTITION THE DAY ------------------------------------------

describe("Lunch + Dinner + the gaps partition the whole day, on every report", () => {
  test.each(FIFTEEN.map(([key, run]) => [key, run] as const))("%s", async (_key, run) => {
    const all = await run(W);
    const parts = [await run(LUNCH), await run(DINNER), await run(EARLY), await run(TEA)];
    for (const field of Object.keys(all)) {
      expect({ field, value: sum(parts.map((p) => p[field] ?? 0)) }).toEqual({ field, value: all[field] });
    }
    // Not vacuous: the whole day has something in it on every report.
    expect(Object.values(all).some((v) => v !== 0)).toBe(true);
  });

  test("the session breakdown: one row per preset, then Outside sessions, each equal to its own slot", async () => {
    const day = await db.GetSalesSummaryReport(RID, { ...W, bucket: "session" });
    expect(day.bucket).toBe("session");
    expect(day.series.map((s) => s.bucket)).toEqual(["Lunch (12:00-17:00)", "Dinner (18:00-24:00)", "Outside sessions"]);
    const lunch = (await db.GetSalesSummaryReport(RID, LUNCH)).totals;
    const dinner = (await db.GetSalesSummaryReport(RID, DINNER)).totals;
    const early = (await db.GetSalesSummaryReport(RID, EARLY)).totals;
    const tea = (await db.GetSalesSummaryReport(RID, TEA)).totals;
    const rungs = ["bills", "covers", "gross", "discount", "net", "service_charge", "tax", "round_off", "grand_total", "refund", "nc_value", "nc_qty"] as const;
    const [lunchRow, dinnerRow, outsideRow] = day.series;
    for (const rung of rungs) {
      expect({ rung, lunch: lunchRow[rung] }).toEqual({ rung, lunch: lunch[rung] });
      expect({ rung, dinner: dinnerRow[rung] }).toEqual({ rung, dinner: dinner[rung] });
      expect({ rung, outside: outsideRow[rung] }).toEqual({ rung, outside: r2(early[rung] + tea[rung]) });
      expect({ rung, total: sum(day.series.map((s) => s[rung])) }).toEqual({ rung, total: day.totals[rung] });
    }
    // The client's presets leave real money outside them. Showing it is the point.
    expect(outsideRow.grand_total).toBe(grand(300, 900, 250, 400));
  });

  test("under a slot, every preset still has its row, and an empty Outside row is left out", async () => {
    const lunchOnly = await db.GetSalesSummaryReport(RID, { ...LUNCH, bucket: "session" });
    expect(lunchOnly.series.map((s) => s.bucket)).toEqual(["Lunch (12:00-17:00)", "Dinner (18:00-24:00)"]);
    expect(lunchOnly.series[1]).toMatchObject({ bills: 0, grand_total: 0, covers: 0, nc_value: 0 });
    expect(lunchOnly.series[0]?.grand_total).toBe(lunchOnly.totals.grand_total);
  });
});

// --- 3. MIDNIGHT -------------------------------------------------------------

describe("midnight", () => {
  test("22:00-02:00 includes 01:30 on the 16th (the 15th's night) and excludes 01:30 on the 1st (May's)", async () => {
    const orders = await db.GetOrderSummaryReport(RID, q500(LATE_NIGHT));
    const nos = orders.rows.map((r) => r.bill_no);
    expect(nos).toContain("110");
    expect(nos).not.toContain("108");
    expect(nos.sort()).toEqual(["105", "106", "109", "110"]);
    const all = await db.GetOrderSummaryReport(RID, q500(W));
    // And the whole day is the calendar: the 1st's 01:30 is in, the 16th's is out.
    expect(all.rows.map((r) => r.bill_no)).toContain("108");
    expect(all.rows.map((r) => r.bill_no)).not.toContain("110");
  });

  test("a crossing slot's night stays with the evening it began, in the day series and the comp column", async () => {
    const sales = await db.GetSalesSummaryReport(RID, LATE_NIGHT);
    const byDay = new Map(sales.series.map((s) => [s.bucket, s]));
    expect([...byDay.keys()]).toEqual(["2026-06-05", "2026-06-06", "2026-06-15"]);
    expect(byDay.get("2026-06-06")?.grand_total).toBe(grand(900));
    expect(byDay.get("2026-06-06")?.nc_value).toBe(300);
    expect(byDay.get("2026-06-15")?.grand_total).toBe(grand(150, 600));
    expect(sales.meta.time_slot).toEqual({ id: null, label: "Custom", start: "22:00", end: "02:00", crosses_midnight: true, source: "custom" });
    expect(sales.meta.notes.join(" ")).toMatch(/belong to the day it started on/);
  });

  test("the DATE x HOUR cut keeps the calendar hour, and it still sums", async () => {
    const hour = await db.GetSalesSummaryReport(RID, { ...LATE_NIGHT, bucket: "hour" });
    expect(hour.series.map((s) => s.bucket)).toEqual(["2026-06-05T23", "2026-06-07T00", "2026-06-15T22", "2026-06-16T01"]);
    expect(sum(hour.series.map((s) => s.grand_total))).toBe(hour.totals.grand_total);
  });

  test("Dinner 18:00-24:00 does not cross midnight: 23:59 is in, 00:30 is out", async () => {
    const orders = await db.GetOrderSummaryReport(RID, q500(DINNER));
    const nos = orders.rows.map((r) => r.bill_no);
    expect(nos).toContain("105");
    expect(nos).not.toContain("106");
    const sales = await db.GetSalesSummaryReport(RID, DINNER);
    expect(sales.meta.time_slot).toEqual({ id: "dinner", label: "Dinner", start: "18:00", end: "24:00", crosses_midnight: false, source: "preset" });
  });
});

// --- 4. THE COMPARISON PERIOD ------------------------------------------------

describe("the Executive Summary's previous period carries the slot", () => {
  test("Lunch is compared with last month's Lunch, Dinner with last month's Dinner", async () => {
    const lunch = await db.GetExecutiveSummaryReport(RID, LUNCH);
    const dinner = await db.GetExecutiveSummaryReport(RID, DINNER);
    const all = await db.GetExecutiveSummaryReport(RID, W);
    expect(lunch.previous_window).toMatchObject({ from: "2026-05-01", to: "2026-05-15" });
    expect(lunch.previous.grand_total).toBe(grand(800));
    expect(dinner.previous.grand_total).toBe(grand(1200));
    expect(all.previous.grand_total).toBe(grand(800, 1200));
    expect(lunch.totals.previous_grand_total).toBe(grand(800));
    expect(lunch.meta.notes.join(" ")).toMatch(/comparison period is cut by the same time slot/);
  });
});

// --- 5. ALL DAY IS UNCHANGED -------------------------------------------------

interface FixtureGlobal { __misFixtureQuery?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }

/** Run `work` recording every SQL statement the readers issue. */
async function recordingSql<T>(work: () => Promise<T>): Promise<{ value: T; sql: string[] }> {
  const g = globalThis as unknown as FixtureGlobal;
  const original = g.__misFixtureQuery;
  const sql: string[] = [];
  g.__misFixtureQuery = (text: string, params?: unknown[]) => { sql.push(text); return fixtureQuery(text, params); };
  try {
    return { value: await work(), sql };
  } finally {
    g.__misFixtureQuery = original;
  }
}

const withoutClock = (payload: { meta: { generated_at: string } }): unknown => ({ ...payload, meta: { ...payload.meta, generated_at: "" } });

describe("all day is exactly what it was", () => {
  const LOADERS: [string, (q: Record<string, unknown>) => Promise<{ meta: { generated_at: string } }>][] = [
    ["item_wise", (q) => db.GetItemWiseReport(RID, q)],
    ["discount", (q) => db.GetDiscountReport(RID, q)],
    ["void_kot", (q) => db.GetVoidKotReport(RID, q)],
    ["bill_edit", (q) => db.GetBillEditReport(RID, q)],
    ["sales_summary", (q) => db.GetSalesSummaryReport(RID, q)],
    ["order_summary", (q) => db.GetOrderSummaryReport(RID, q)],
    ["executive_summary", (q) => db.GetExecutiveSummaryReport(RID, q)],
    ["cover_size_summary", (q) => db.GetCoverSizeSummaryReport(RID, q)],
    ["settlement_summary", (q) => db.GetSettlementSummaryReport(RID, q)],
    ["nc_summary", (q) => db.GetNcSummaryReport(RID, q)],
    ["service_charge_deny", (q) => db.GetServiceChargeDenyReport(RID, q)],
    ["group_summary", (q) => db.GetGroupSummaryReport(RID, q)],
    ["variation_summary", (q) => db.GetVariationSummaryReport(RID, q)],
    ["tip_summary", (q) => db.GetTipSummaryReport(RID, q)],
    ["counter_summary", (q) => db.GetCounterSummaryReport(RID, q)],
  ];

  test.each(LOADERS)("%s: no slot, slot=all and 00:00-24:00 are one payload, with no time predicate and no preset read", async (_key, load) => {
    const plain = await recordingSql(() => load(W));
    const allSlot = await load({ ...W, slot: "all" });
    const wholeDay = await load({ ...W, time_from: "00:00", time_to: "24:00" });
    expect(withoutClock(allSlot)).toEqual(withoutClock(plain.value));
    expect(withoutClock(wholeDay)).toEqual(withoutClock(plain.value));
    const meta = (plain.value as unknown as { meta: { time_slot: unknown; notes: string[]; window: { clamped: string[] } } }).meta;
    expect(meta.time_slot).toBeNull();
    expect(meta.window.clamped).toEqual([]);
    expect(meta.notes.join(" ")).not.toMatch(/Time slot/);
    expect(plain.sql.some((s) => /at time zone/i.test(s))).toBe(false);
    expect(plain.sql.some((s) => /report_time_slots/i.test(s))).toBe(false);
  });

  test("custom times never read the presets either", async () => {
    const { sql } = await recordingSql(() => db.GetSalesSummaryReport(RID, TEA));
    expect(sql.some((s) => /report_time_slots/i.test(s))).toBe(false);
    expect(sql.some((s) => /at time zone 'Asia\/Kolkata'\)::time >= '17:00'::time/i.test(s))).toBe(true);
  });
});

describe("a slot that cannot be honoured is the whole day, and says why", () => {
  test.each([
    ["an unknown preset", { slot: "brunch" }, "slot_unknown"],
    ["an unreadable time", { time_from: "25:00", time_to: "26:00" }, "time_unparseable"],
    ["an empty slot", { time_from: "12:00", time_to: "12:00" }, "time_empty"],
  ])("%s", async (_name, extra, clamp) => {
    const whole = await db.GetSalesSummaryReport(RID, W);
    const asked = await db.GetSalesSummaryReport(RID, { ...W, ...extra });
    expect(asked.totals).toEqual(whole.totals);
    expect(asked.series).toEqual(whole.series);
    expect(asked.meta.time_slot).toBeNull();
    expect(asked.meta.window.clamped).toEqual([clamp]);
  });
});

// --- 6. THE TIME-WISE CUTS ---------------------------------------------------

describe("hour of day", () => {
  test("one row per hour with activity, in hour order, summing to the totals and counting covers once", async () => {
    const r = await db.GetSalesSummaryReport(RID, { ...W, bucket: "hour_of_day" });
    expect(r.bucket).toBe("hour_of_day");
    // Bills at 00:30, 01:30, 09:00, 13:00, 16:59, 17:00, 20:00, 22:30, 23:59; comps
    // alone at 12:30 and 19:30 still get their hour, so the NC column adds up.
    expect(r.series.map((s) => s.bucket)).toEqual([
      "00:00-01:00", "01:00-02:00", "09:00-10:00", "12:00-13:00", "13:00-14:00", "16:00-17:00",
      "17:00-18:00", "19:00-20:00", "20:00-21:00", "22:00-23:00", "23:00-24:00",
    ]);
    for (const rung of ["grand_total", "net", "bills", "covers", "nc_value"] as const) {
      expect({ rung, total: sum(r.series.map((s) => s[rung])) }).toEqual({ rung, total: r.totals[rung] });
    }
    // The split seating SL1 (four covers) settled at 13:00 and 16:59: counted once, in its first hour.
    expect(r.series.find((s) => s.bucket === "13:00-14:00")?.covers).toBe(4);
    expect(r.series.find((s) => s.bucket === "16:00-17:00")?.covers).toBe(0);
  });

  test("combined with a slot, only that slot's hours appear", async () => {
    const r = await db.GetSalesSummaryReport(RID, { ...LUNCH, bucket: "hour_of_day" });
    expect(r.series.map((s) => s.bucket)).toEqual(["12:00-13:00", "13:00-14:00", "16:00-17:00"]);
  });
});

// --- 7. THE PRESETS ----------------------------------------------------------

describe("the restaurant's own presets", () => {
  const LATE_DINNER = {
    version: 1,
    slots: [
      { id: "dinner", label: "Dinner", start: "18:00", end: "02:00" },
      { id: "lunch", label: "Lunch", start: "12:00", end: "17:00" },
    ],
  };

  test("a saved Dinner that runs to 02:00 is honoured by ?slot=dinner and by the session cut", async () => {
    useFixtureDb(slotDb({ report_time_slots: LATE_DINNER }));
    const orders = await db.GetOrderSummaryReport(RID, q500(DINNER));
    expect(orders.rows.map((r) => r.bill_no).sort()).toEqual(["104", "105", "106", "109", "110"]);
    const sessions = await db.GetSalesSummaryReport(RID, { ...W, bucket: "session" });
    expect(sessions.series.map((s) => s.bucket)).toEqual(["Dinner (18:00-02:00)", "Lunch (12:00-17:00)", "Outside sessions"]);
    expect(sum(sessions.series.map((s) => s.grand_total))).toBe(sessions.totals.grand_total);
  });

  test("a database migration 049 never reached (42703) reads the defaults instead of failing", async () => {
    useFixtureDb(slotDb({ report_time_slots_missing: true }));
    const sales = await db.GetSalesSummaryReport(RID, LUNCH);
    expect(sales.totals.grand_total).toBe(grand(1000, 500));
    expect(await db.GetReportTimeSlots(RID)).toMatchObject({ is_default: true, slots: [{ id: "lunch" }, { id: "dinner" }] });
  });

  test("a stored value that no longer validates is the defaults, visibly", async () => {
    useFixtureDb(slotDb({ report_time_slots: { version: 1, slots: [{ id: "x", label: "Bad", start: "12:00", end: "12:00" }] } }));
    expect(await db.GetReportTimeSlots(RID)).toMatchObject({ is_default: true });
    expect((await db.GetSalesSummaryReport(RID, { ...W, slot: "x" })).meta.window.clamped).toEqual(["slot_unknown"]);
  });

  test("a save snapshots what it replaced, stores {version, slots}, and an empty list resets to NULL", async () => {
    const fixture = slotDb();
    useFixtureDb(fixture);
    const first = await db.SetReportTimeSlots(RID, LATE_DINNER.slots);
    expect(first.before).toMatchObject({ is_default: true, slots: [{ id: "lunch" }, { id: "dinner" }] });
    expect(first.after).toEqual({ is_default: false, slots: LATE_DINNER.slots });
    expect(fixture.report_time_slots).toEqual(LATE_DINNER);

    const reset = await db.SetReportTimeSlots(RID, []);
    expect(reset.before).toEqual({ is_default: false, slots: LATE_DINNER.slots });
    expect(reset.after).toMatchObject({ is_default: true });
    expect(fixture.report_time_slots).toBeNull();
  });

  test("an overlapping save is refused with its sentence and writes nothing", async () => {
    const fixture = slotDb({ report_time_slots: LATE_DINNER });
    useFixtureDb(fixture);
    await expect(db.SetReportTimeSlots(RID, [
      { label: "Lunch", start: "12:00", end: "17:00" },
      { label: "High tea", start: "16:00", end: "18:00" },
    ])).rejects.toThrow('"Lunch" (12:00-17:00) overlaps "High tea" (16:00-18:00); a time of day can belong to only one time slot.');
    expect(fixture.report_time_slots).toEqual(LATE_DINNER);
  });
});

// --- 8. A ZONE WITH DAYLIGHT SAVING -------------------------------------------

describe("a zone with daylight saving", () => {
  test("Lunch in London across the spring-forward night is still 12:00-17:00 local on each day", async () => {
    // 29 March 2026: clocks go from 01:00 GMT to 02:00 BST. 12:30 local is 12:30Z
    // on the 28th and 11:30Z on the 29th and 30th; the slot must follow the wall.
    useFixtureDb(makeDb({
      timezone: "Europe/London",
      bills: [
        { id: "g1", bill_no: "1", settled_at: "2026-03-28T12:30:00.000Z", total_amt: 100, tax_breakdown: [], payment_method: "Cash" },
        { id: "g2", bill_no: "2", settled_at: "2026-03-29T11:30:00.000Z", total_amt: 200, tax_breakdown: [], payment_method: "Cash" },
        { id: "g3", bill_no: "3", settled_at: "2026-03-30T15:59:00.000Z", total_amt: 400, tax_breakdown: [], payment_method: "Cash" },
        // 11:30 local on the 29th (10:30Z): before Lunch.
        { id: "g4", bill_no: "4", settled_at: "2026-03-29T10:30:00.000Z", total_amt: 800, tax_breakdown: [], payment_method: "Cash" },
        // 16:30Z on the 30th is 17:30 BST: after Lunch, though 16:30 on a GMT clock.
        { id: "g5", bill_no: "5", settled_at: "2026-03-30T16:30:00.000Z", total_amt: 1600, tax_breakdown: [], payment_method: "Cash" },
      ],
    }));
    const r = await db.GetOrderSummaryReport(RID, { from: "2026-03-28", to: "2026-03-30", slot: "lunch", limit: 50 });
    expect(r.rows.map((x) => x.bill_no).sort()).toEqual(["1", "2", "3"]);
    expect(r.totals.grand_total).toBe(700);
  });
});

// --- 9. THE FIXTURE IS NOT VACUOUS ------------------------------------------

describe("the fixture refuses a slot it cannot see", () => {
  test("a bill read bound to a slot's outer bounds WITHOUT the time-of-day predicate throws", async () => {
    useFixtureDb(slotDb());
    const sql = `select b.id from "Bills" b ${"s.covers as session_covers"}
      where b.res_id = $1 and (false or b.outlet_id = $2)
        and (b.admin_approved_at is not null or b.closed_at is not null)
        and coalesce(b.closed_at, b.admin_approved_at) >= $3
        and coalesce(b.closed_at, b.admin_approved_at) < $4`;
    const lunchBounds = [ist("2026-06-01 12:00"), ist("2026-06-15 17:00")];
    const params = [slotDb().res_id, slotDb().outlets[0]?.id, ...lunchBounds];
    await expect(fixtureQuery(sql, params)).rejects.toThrow(/time-of-day predicate on coalesce\(b\.closed_at, b\.admin_approved_at\) is missing/);
  });
});
