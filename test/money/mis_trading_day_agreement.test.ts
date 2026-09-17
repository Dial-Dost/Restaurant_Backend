// TRADING DAYS ON REAL MONEY, THROUGH THE REAL READERS (client item 9).
//
// "Email the reports at the end of each day, at a time I choose." A daily
// email at 02:00 reports the 24 hours that just ended — the trading day — and
// jest-tests/report_trading_day.test.ts proves that arithmetic in isolation.
// This suite proves what the owner, the accountant and the drawer rely on:
//
//   1. THE HEADLINE NUMBERS AGREE ON A TRADING DAY. Sales = Σ Order =
//      Σ Settlement = Σ Counter, and the email's headline is those numbers.
//   2. TRADING DAYS TILE. Fifteen daily emails add up, report by report, to the
//      fifteen-day read with the same close. No bill twice, none lost at 02:00.
//   3. HALF-OPEN AT THE CLOSE. 01:59 is yesterday's, 02:00 and 02:01 today's;
//      an evening close (23:30) sends 23:30 itself to tomorrow.
//   4. A 00:00 CLOSE IS THE CALENDAR DAY, payload for payload, on all fifteen.
//   5. THE ACCOUNTING SALES REPORT, read on the same trading day, agrees with
//      the Sales Summary — so an email carrying both never contradicts itself.
//   6. THE BUNDLE'S CSV IS THE ROUTE'S CSV for the same trading day.
//   7. REFUSED OUT LOUD: a close with a slot, or an unreadable close.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { readXlsx } from "../../jest-tests/xlsx_reader";
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
type Bundle = typeof import("../../report_bundle");
type Render = typeof import("../../report_render");
let db: Readers;
let bundle: Bundle;
let render: Render;

const RID = "zztest-mis";
const W = { from: "2026-06-01", to: "2026-06-15" };
const CLOSE = "02:00";
const TW = { ...W, day_close: CLOSE };
const day = (k: string, close = CLOSE) => ({ from: k, to: k, day_close: close });

const r2 = (n: number): number => Number(n.toFixed(2));
const sum = (xs: number[]): number => r2(xs.reduce((s, x) => s + x, 0));

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL ?? "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../../database_supabase");
  bundle = await import("../../report_bundle");
  render = await import("../../report_render");
});

function ist(local: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!m) {throw new Error(`bad local time ${local}`);}
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  return new Date(utc - 330 * 60_000).toISOString();
}

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

const COUNTER_1 = "c1c1c1c1-1111-4111-8111-c1c1c1c1c1c1";

function bill(over: Partial<FixtureBill> & { id: string; bill_no: string; at: string; food: number }): FixtureBill {
  const { food, at, ...rest } = over;
  const b = billOf(food);
  return {
    settled_at: ist(at), total_amt: b.total, tax_breakdown: b.lines,
    payment_method: "Cash", table_name: "T1", session_id: `S-${over.id}`, covers: 2,
    counter_id: COUNTER_1,
    ...rest,
  };
}

function order(id: string, at: string, items: FixtureOrderItem[], over: Partial<FixtureOrder> = {}): FixtureOrder {
  return { id, created_at: ist(at), status: 7, order_type: "dine_in", table_name: "T1", items, ...over };
}
const dal = (quantity: number): FixtureOrderItem => ({ name: "Dal", quantity, price: 100, menu_id: "m-dal" });

const grand = (...foods: number[]): number => sum(foods.map((f) => billOf(f).total));

/**
 * Settlement times, IST, around a 02:00 close:
 *
 *   A1  2 Jun 13:00 (1000)   A2  2 Jun 23:30 (500)   A3  3 Jun 01:59 (700)  -> trading day 2 Jun
 *   A4  3 Jun 02:00 (300)    A5  3 Jun 02:01 (200)                          -> trading day 3 Jun
 *   A6  1 Jun 01:30 (400)    -> 31 May (OUT of 1-15 Jun on trading days, IN on calendar days)
 *   A7 16 Jun 01:30 (600)    -> 15 Jun (IN on trading days, OUT on calendar days)
 *   A8 10 Jun 20:00 (1000, 200 off, Upi)   A9 11 Jun 00:30 (900, a comp at 00:15) -> 10 Jun
 *   elsewhere: another outlet at 2 Jun 13:30; another restaurant; an unsettled bill
 *
 * Every order was placed ten minutes before its bill settled, so the order-clock
 * reports move with the same close.
 */
function tradingDb(over: Partial<FixtureDb> = {}): FixtureDb {
  const b: [string, string, string, number, Partial<FixtureBill>?][] = [
    ["A1", "301", "2026-06-02 13:00", 1000],
    ["A2", "302", "2026-06-02 23:30", 500, { payment_method: "Card" }],
    ["A3", "303", "2026-06-03 01:59", 700],
    ["A4", "304", "2026-06-03 02:00", 300],
    ["A5", "305", "2026-06-03 02:01", 200, { payment_method: "Upi" }],
    ["A6", "306", "2026-06-01 01:30", 400],
    ["A7", "307", "2026-06-16 01:30", 600],
    ["A8", "308", "2026-06-10 20:00", 1000, { discount_type: "flat", discount_value: 200, payment_method: "Upi" }],
    ["A9", "309", "2026-06-11 00:30", 900],
  ];
  const minus10 = (local: string): string => {
    const t = new Date(Date.parse(ist(local)) - 10 * 60_000 + 330 * 60_000).toISOString();
    return `${t.slice(0, 10)} ${t.slice(11, 16)}`;
  };
  return makeDb({
    timezone: "Asia/Kolkata",
    bills: [
      ...b.map(([id, no, at, food, extra]) => bill({ id, bill_no: no, at, food, order_id: `o${id}`, ...(extra ?? {}) })),
      bill({ id: "OB", bill_no: "401", at: "2026-06-02 13:30", food: 400, outlet_id: OUTLET_B, order_id: "oOB" }),
      bill({ id: "UNSETTLED", bill_no: "399", at: "2026-06-02 14:00", food: 7777, settled: false }),
      bill({ id: "BX", bill_no: "901", at: "2026-06-02 13:00", food: 50000, res_id: OTHER_RES_ID, outlet_id: OTHER_OUTLET }),
      // Last month, for the Executive Summary's comparison period.
      bill({ id: "M1", bill_no: "051", at: "2026-05-03 13:00", food: 800 }),
    ],
    orders: [
      ...b.map(([id, , at, food]) => order(`o${id}`, minus10(at), [dal(food / 100)])),
      order("oOB", "2026-06-02 13:20", [dal(4)], { outlet_id: OUTLET_B }),
      order("11111111-aaaa-4aaa-8aaa-111111111111", "2026-06-03 01:45", [dal(2)], { status: 5 }),
    ],
    menu: [{ id: "m-dal", name: "Dal", category: "Mains", group: "Food" }],
    non_chargeables: [
      { id: "nc1", created_at: ist("2026-06-11 00:15"), order_id: "oA9", item_name: "Dal", table_name: "T1", nc_kind: "complimentary", reason: "Late", quantity: 1, unit_price: 100, marked_by: "asha", authorised_by: "manager01" },
      { id: "nc2", created_at: ist("2026-06-03 02:05"), order_id: "oA4", item_name: "Dal", table_name: "T1", nc_kind: "complimentary", reason: "Wait", quantity: 1, unit_price: 100, marked_by: "asha", authorised_by: "manager01" },
    ],
    waivers: [
      { id: "w1", waived_at: ist("2026-06-03 01:50"), bill_id: "A3", table_name: "T1", basis: "tax_line", basis_percent: 1, basis_amount: 700, amount_waived: 7, tax_on_waived: 0.35, waiver_kind: "goodwill", reason: "Late", waived_by: "asha", authorised_by: "manager01" },
    ],
    tenders: [
      { id: "t1", bill_id: "A3", table_name: "T1", seq: 1, settled_at: ist("2026-06-03 01:59"), method: "Cash", amount: billOf(700).total, tip_amount: 40, tip_mode: "cash", tip_credited_to: "asha", settled_by: "asha" },
      { id: "t2", bill_id: "A4", table_name: "T1", seq: 1, settled_at: ist("2026-06-03 02:00"), method: "Cash", amount: billOf(300).total, tip_amount: 10, tip_mode: "cash", tip_credited_to: "asha", settled_by: "asha" },
    ],
    audits: [
      { id: "a1", created_at: ist("2026-06-03 01:40"), action_id: "4ad474d4-5230-449c-874f-6a238b833bca", action_name: "Add Orders", reason: "Removed item Dal from table T1", details: { table: "T1", item: "Dal" }, fname: "Asha", lname: "Rao" },
    ],
    counters: [{ id: COUNTER_1, code: "C1", name: "Front till", sort_order: 1 }],
    cash_sessions: [],
    order_voids: [],
    ...over,
  });
}

beforeEach(() => { useFixtureDb(tradingDb()); });

type Summary = Record<string, number>;
const q500 = (q: Record<string, unknown>) => ({ ...q, limit: 500 });

/** The fifteen, reduced to the figures that must add up across days. */
const FIFTEEN: [string, (q: Record<string, unknown>) => Promise<Summary>][] = [
  ["item_wise", async (q) => { const r = await db.GetItemWiseReport(RID, q500(q)); return { qty: r.totals.qty, gross: r.totals.gross_amount, nc_value: r.totals.nc_value }; }],
  ["discount", async (q) => { const r = await db.GetDiscountReport(RID, q500(q)); return { discount: r.totals.discount_amount, bills: r.totals.discounted_bills, grand_total: r.totals.grand_total }; }],
  ["void_kot", async (q) => { const r = await db.GetVoidKotReport(RID, q500(q)); return { voids: r.totals.voids, value: r.totals.value }; }],
  ["bill_edit", async (q) => { const r = await db.GetBillEditReport(RID, q500(q)); return { edits: r.totals.edits }; }],
  ["sales_summary", async (q) => {
    const t = (await db.GetSalesSummaryReport(RID, q)).totals;
    return { bills: t.bills, covers: t.covers, discount: t.discount, net: t.net, service_charge: t.service_charge, tax: t.tax, round_off: t.round_off, grand_total: t.grand_total, nc_value: t.nc_value };
  }],
  ["order_summary", async (q) => { const r = await db.GetOrderSummaryReport(RID, q500(q)); return { rows: r.page.total, grand_total: r.totals.grand_total }; }],
  ["executive_summary", async (q) => { const r = await db.GetExecutiveSummaryReport(RID, q); return { grand_total: r.current.grand_total, net: r.current.net, bills: r.current.bills }; }],
  ["cover_size_summary", async (q) => { const r = await db.GetCoverSizeSummaryReport(RID, q); return { grand_total: r.totals.grand_total, covers: r.totals.covers }; }],
  ["settlement_summary", async (q) => { const r = await db.GetSettlementSummaryReport(RID, q); return { amount: r.totals.amount, bills: r.totals.bills }; }],
  ["nc_summary", async (q) => { const r = await db.GetNcSummaryReport(RID, q500(q)); return { loss: r.totals.loss, entries: r.totals.entries }; }],
  ["service_charge_deny", async (q) => { const r = await db.GetServiceChargeDenyReport(RID, q500(q)); return { waived: r.totals.amount_waived, waivers: r.totals.waivers }; }],
  ["group_summary", async (q) => { const r = await db.GetGroupSummaryReport(RID, q); return { gross: r.totals.gross_amount, qty: r.totals.qty }; }],
  ["variation_summary", async (q) => { const r = await db.GetVariationSummaryReport(RID, q); return { window_gross: r.window_gross }; }],
  ["tip_summary", async (q) => { const r = await db.GetTipSummaryReport(RID, q500(q)); return { tips: r.totals.tip_amount, tenders: r.totals.tenders }; }],
  ["counter_summary", async (q) => { const r = await db.GetCounterSummaryReport(RID, q); return { grand_total: r.totals.grand_total, bills: r.totals.bills }; }],
];

const DAYS = Array.from({ length: 15 }, (_v, i) => `2026-06-${String(i + 1).padStart(2, "0")}`);

// --- 1. THE HEADLINE AGREES ON A TRADING DAY ----------------------------------

describe("on a trading day the headline numbers agree", () => {
  test.each([
    ["2 Jun (01:59 is the 2nd's)", "2026-06-02"],
    ["3 Jun (02:00 and 02:01 are the 3rd's)", "2026-06-03"],
    ["10 Jun (00:30 on the 11th is the 10th's)", "2026-06-10"],
  ])("%s: Sales = Σ Order = Σ Settlement = Σ Counter", async (_name, k) => {
    const q = day(k);
    const sales = await db.GetSalesSummaryReport(RID, q);
    const orders = await db.GetOrderSummaryReport(RID, q500(q));
    const settle = await db.GetSettlementSummaryReport(RID, q);
    const counter = await db.GetCounterSummaryReport(RID, q);
    const g = sales.totals.grand_total;
    expect(g).toBeGreaterThan(0);
    expect(sum(orders.rows.map((r) => r.grand_total))).toBe(g);
    expect(orders.totals.grand_total).toBe(g);
    expect(sum(settle.rows.map((r) => r.amount))).toBe(g);
    expect(sum(counter.rows.map((r) => r.grand_total))).toBe(g);
    expect(sum(sales.series.map((s) => s.grand_total))).toBe(g);
  });

  test("exactly the right bills, half-open at 02:00", async () => {
    const nos = async (k: string) => (await db.GetOrderSummaryReport(RID, q500(day(k)))).rows.map((r) => r.bill_no).sort();
    expect(await nos("2026-06-02")).toEqual(["301", "302", "303"]);
    expect(await nos("2026-06-03")).toEqual(["304", "305"]);
    expect(await nos("2026-06-10")).toEqual(["308", "309"]);
    expect(await nos("2026-05-31")).toEqual(["306"]);
    expect(await nos("2026-06-15")).toEqual(["307"]);
  });

  test("an evening close (23:30) sends 23:30 itself to the next trading day", async () => {
    const at2330 = async (k: string) => (await db.GetOrderSummaryReport(RID, q500(day(k, "23:30")))).rows.map((r) => r.bill_no).sort();
    // Trading day 2 Jun = [1 Jun 23:30, 2 Jun 23:30): A1 only.
    expect(await at2330("2026-06-02")).toEqual(["301"]);
    // Trading day 3 Jun = [2 Jun 23:30, 3 Jun 23:30): A2 (23:30 exactly), A3, A4, A5.
    expect(await at2330("2026-06-03")).toEqual(["302", "303", "304", "305"]);
  });

  test("the day series buckets on the BUSINESS date, and says the window it used", async () => {
    const sales = await db.GetSalesSummaryReport(RID, TW);
    const byDay = new Map(sales.series.map((s) => [s.bucket, s.grand_total]));
    expect([...byDay.keys()]).toEqual(["2026-06-02", "2026-06-03", "2026-06-10", "2026-06-15"]);
    expect(byDay.get("2026-06-02")).toBe(grand(1000, 500, 700));
    expect(byDay.get("2026-06-15")).toBe(grand(600));
    expect(sales.meta.window).toEqual({
      from: "2026-06-01", to: "2026-06-15", days: 15, source: "range", clamped: [],
      day_close: "02:00",
      from_at: ist("2026-06-01 02:00"),
      to_at: ist("2026-06-16 02:00"),
    });
    expect(sales.meta.notes.join(" ")).toMatch(/Trading day closing at 02:00: .*printed bill keeps its calendar date/);
    // The comp at 00:15 on the 11th is on the 10th's row, beside its bill.
    expect(sales.series.find((s) => s.bucket === "2026-06-10")?.nc_value).toBe(100);
  });

  test("the window moves with the close: A6 leaves, A7 arrives", async () => {
    const trading = (await db.GetOrderSummaryReport(RID, q500(TW))).rows.map((r) => r.bill_no);
    const calendar = (await db.GetOrderSummaryReport(RID, q500(W))).rows.map((r) => r.bill_no);
    expect(trading).toContain("307");
    expect(trading).not.toContain("306");
    expect(calendar).toContain("306");
    expect(calendar).not.toContain("307");
  });
});

// --- 2. TRADING DAYS TILE -----------------------------------------------------

describe("fifteen daily emails add up to the fifteen-day read, report by report", () => {
  test.each(FIFTEEN.map(([key, run]) => [key, run] as const))("%s", async (_key, run) => {
    const whole = await run(TW);
    const parts: Summary[] = [];
    for (const k of DAYS) { parts.push(await run(day(k))); }
    for (const field of Object.keys(whole)) {
      expect({ field, value: sum(parts.map((p) => p[field] ?? 0)) }).toEqual({ field, value: whole[field] });
    }
    expect(Object.values(whole).some((v) => v !== 0)).toBe(true);
  });
});

// --- 4. A MIDNIGHT CLOSE IS THE CALENDAR DAY -----------------------------------

describe("a 00:00 close is exactly the calendar read", () => {
  const LOAD: [string, (q: Record<string, unknown>) => Promise<{ meta: { generated_at: string } }>][] = [
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
  const noClock = (p: { meta: { generated_at: string } }): unknown => ({ ...p, meta: { ...p.meta, generated_at: "" } });
  test.each(LOAD.map(([k, f]) => [k, f] as const))("%s", async (_k, load) => {
    expect(noClock(await load({ ...W, day_close: "00:00" }))).toEqual(noClock(await load(W)));
    expect(noClock(await load({ ...W, day_close: "24:00" }))).toEqual(noClock(await load(W)));
  });
});

// --- 5. THE ACCOUNTING SALES REPORT AGREES --------------------------------------

describe("the accounting Sales report, read on the same trading day", () => {
  test("its total and its days are the Sales Summary's", async () => {
    const acc = await db.GetSalesReport(RID, W.from, W.to, { dayShiftMin: 120 });
    const mis = await db.GetSalesSummaryReport(RID, TW);
    expect(acc.total_sales).toBe(mis.totals.grand_total);
    expect(acc.total_net).toBe(mis.totals.net);
    expect(acc.bill_count).toBe(mis.totals.bills);
    expect(acc.by_day.map((d) => [d.date, d.sales])).toEqual(mis.series.map((s) => [s.bucket, s.grand_total]));
  });

  test("with no shift it is the report it always was", async () => {
    const plain = await db.GetSalesReport(RID, W.from, W.to);
    const zero = await db.GetSalesReport(RID, W.from, W.to, { dayShiftMin: 0 });
    expect(zero).toEqual(plain);
    expect(plain.total_sales).toBe((await db.GetSalesSummaryReport(RID, W)).totals.grand_total);
  });
});

// --- 1b / 6. WHAT THE EMAIL CARRIES ------------------------------------------------

describe("the email's headline and files are the screen's numbers", () => {
  const req = (k: string) => ({
    resId: RES_ID, outletId: OUTLET_A, scope: "outlet" as const,
    keys: ["sales_summary", "settlement_summary"], formats: ["csv" as const],
    from: k, to: k, dayClose: CLOSE, windowStartAt: ist(`${k} 02:00`), windowEndAt: "", maxBytes: 5_000_000,
  });

  test("headline = Sales Summary = Σ Settlement, for a trading day", async () => {
    const r = req("2026-06-02");
    const headline = await bundle.loadHeadline(r, new Map());
    const sales = await db.GetSalesSummaryReport(RID, day("2026-06-02"));
    const settle = await db.GetSettlementSummaryReport(RID, day("2026-06-02"));
    expect(headline).not.toBeNull();
    expect(headline?.gross).toBe(sales.totals.grand_total);
    expect(headline?.gross).toBe(sum(settle.rows.map((x) => x.amount)));
    expect(headline?.net).toBe(sales.totals.net);
    expect(headline?.bills).toBe(3);
    // The void placed at 01:45 on the 3rd is the 2nd's, on the order clock too.
    expect(headline?.voids).toBe(1);
    expect(sum((headline?.payments ?? []).map((p) => p.amount))).toBe(sales.totals.grand_total);
  });

  test("the CSV file is the .csv route's body for the same trading day, byte for byte", async () => {
    const out = await bundle.renderReportBundle(req("2026-06-02"));
    const settle = await db.GetSettlementSummaryReport(RID, day("2026-06-02"));
    const sales = await db.GetSalesSummaryReport(RID, day("2026-06-02"));
    const byKey = new Map(out.files.map((f) => [f.report_key, f.body.toString("utf8")]));
    expect(byKey.get("settlement_summary")).toBe(render.renderMisCsv(settle.columns, settle.rows, settle.totals));
    expect(byKey.get("sales_summary")).toBe(render.renderMisCsv(sales.columns, sales.series, sales.totals));
    expect(out.files.map((f) => f.filename)).toEqual([
      "sales_summary_Main_2026-06-02_to_2026-06-02_close-0200.csv",
      "settlement_summary_Main_2026-06-02_to_2026-06-02_close-0200.csv",
    ]);
    expect(out.headline?.gross).toBe(sales.totals.grand_total);
  });

  test("the ALL-OUTLETS bundle reads every outlet of THIS restaurant and no other", async () => {
    const out = await bundle.renderReportBundle({ ...req("2026-06-02"), scope: "all" });
    expect(out.headline?.gross).toBe(grand(1000, 500, 700, 400));
    expect(out.files[0].filename).toMatch(/_all-outlets_/);
  });
});

// --- 7. REFUSED OUT LOUD ------------------------------------------------------

describe("what a trading day will not do", () => {
  test("a close alongside a slot keeps the slot, calendar days, and names the clamp", async () => {
    const both = await db.GetSalesSummaryReport(RID, { ...W, day_close: CLOSE, slot: "dinner" });
    const slotOnly = await db.GetSalesSummaryReport(RID, { ...W, slot: "dinner" });
    expect(both.meta.window.clamped).toEqual(["day_close_with_slot"]);
    expect(both.meta.window.day_close).toBeUndefined();
    expect(both.totals).toEqual(slotOnly.totals);
  });

  test("an unreadable close is calendar days, with its own clamp", async () => {
    const bad = await db.GetSalesSummaryReport(RID, { ...W, day_close: "2am" });
    const cal = await db.GetSalesSummaryReport(RID, W);
    expect(bad.meta.window.clamped).toEqual(["day_close_unparseable"]);
    expect(bad.totals).toEqual(cal.totals);
  });
});

// --- THE WORKBOOK -----------------------------------------------------------------

const NL = "\n";

describe("the workbook an email carries", () => {
  const base = {
    resId: RES_ID, outletId: OUTLET_A, scope: "outlet" as const,
    from: "2026-06-01", to: "2026-06-15", dayClose: CLOSE,
    windowStartAt: ist("2026-06-01 02:00"), windowEndAt: ist("2026-06-16 02:00"), maxBytes: 5_000_000,
    generatedAt: new Date("2026-06-16T00:00:00Z"),
  };

  test("Summary, a sheet per report, Notes — money as numbers, the totals row the payload's own", async () => {
    const out = await bundle.renderReportBundle({ ...base, keys: ["sales_summary", "settlement_summary", "gst"], formats: ["xlsx"] });
    expect(out.files).toHaveLength(1);
    expect(out.files[0].filename).toBe("reports_Main_2026-06-01_to_2026-06-15_close-0200.xlsx");
    const wb = readXlsx(out.files[0].body);
    expect(wb.sheetNames).toEqual(["Summary", "Sales Summary", "Settlement Summary", "GST", "Notes"]);

    const sales = await db.GetSalesSummaryReport(RID, TW);
    const sheet = wb.sheets["Sales Summary"];
    expect(sheet[0]).toEqual(sales.columns.map((c) => c.label));
    const total = sheet[sheet.length - 1];
    expect(total[0]).toBe("Total");
    const gi = sales.columns.findIndex((c) => c.key === "grand_total");
    expect(total[gi]).toBe(sales.totals.grand_total);
    expect(typeof total[gi]).toBe("number");
    // Rows are the series, in order, one per business date.
    expect(sheet.slice(1, -1).map((r) => r[0])).toEqual(sales.series.map((x) => x.bucket));

    const summary = wb.sheets.Summary;
    const label = (text: string) => summary.find((r) => r[0] === text)?.[1];
    expect(summary[0][0]).toBe("ZZTEST MIS Fixture");
    expect(label("Trading day closes at")).toBe("02:00");
    expect(label("From")).toBe("1 Jun 2026, 02:00 (Asia/Kolkata)");
    expect(label("Up to (not included)")).toBe("16 Jun 2026, 02:00 (Asia/Kolkata)");
    expect(label("Gross (grand total)")).toBe(sales.totals.grand_total);
    expect(label("Bills")).toBe(sales.totals.bills);

    const notes = wb.sheets.Notes.map((r) => String(r[0] ?? ""));
    expect(notes.join(" ")).toMatch(/Trading day closing at 02:00/);
    expect(notes).toContain("GST");
  });

  test("a paged report is read page by page until the server says there is no more", async () => {
    const many: FixtureBill[] = Array.from({ length: 1100 }, (_v, i) => bill({
      id: `P${String(i)}`, bill_no: String(5000 + i), at: `2026-06-04 ${String(10 + (i % 10)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`, food: 100,
    }));
    useFixtureDb(tradingDb({ bills: many }));
    const out = await bundle.renderReportBundle({ ...base, from: "2026-06-04", to: "2026-06-04", keys: ["order_summary"], formats: ["csv"] });
    const lines = out.files[0].body.toString("utf8").split(NL);
    // Header + 1,100 rows + the totals row.
    expect(lines).toHaveLength(1102);
    expect(out.files[0].rows).toBe(1100);
    expect(out.files[0].truncated).toBe(false);
  });

  test("past the row cap the file is cut, and SAYS so in a row as wide as the report", async () => {
    const out = await bundle.renderReportBundle({ ...base, keys: ["order_summary"], formats: ["csv", "xlsx"], maxRows: 2 });
    const csv = out.files.find((f) => f.format === "csv");
    expect(csv?.rows).toBe(2);
    expect(csv?.truncated).toBe(true);
    const text = csv?.body.toString("utf8") ?? "";
    const last = text.split(NL).pop() ?? "";
    expect(last).toMatch(/^TRUNCATED - 2 of 8 rows,+$/);
    const width = text.split(NL)[0].split(",").length;
    expect(last.split(",")).toHaveLength(width);
    const wb = readXlsx(out.files.find((f) => f.format === "xlsx")?.body as Buffer);
    const sheet = wb.sheets["Order Summary"];
    expect(String(sheet[sheet.length - 1][0])).toMatch(/Cut at 2 rows — the full report has 8/);
  });

  test("a bundle over the attachment limit is refused, permanently, in a sentence", async () => {
    await expect(bundle.renderReportBundle({ ...base, keys: ["order_summary"], formats: ["csv"], maxBytes: 100 }))
      .rejects.toThrow(/over the 0\.0 MB an email may carry/);
  });
});
