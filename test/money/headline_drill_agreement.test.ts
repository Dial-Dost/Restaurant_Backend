// "TODAY AT A GLANCE" — FOLLOW EVERY JUMP, AND THE NUMBER MUST BE THERE.
//
// Client item 10 makes each element of the Overview's headline box lead
// somewhere (glance_drill.ts). A jump is only honest if the screen it lands on
// shows the figure the owner just tapped. So this suite does what the owner
// does: it reads the headline, takes each drill's OWN destination and params,
// runs the report those name through the REAL reader, and requires the same
// number — paper == drawer == reports, on the headline's day, all day.
//
//   today_ladder / net / gross  === Sales Summary(day).totals
//   Online (gross), its bills   === Sales Summary(day) by_order_type, delivery + other
//   Online (net)                === Order Summary(day) rows on those channels
//   Cash collection             === Settlement Summary(day), the Cash row
//   each mode's row             === Settlement Summary(day), that row
//   Month to date, month_bills  === Sales Summary(month_from..today)
//   N bill(s) settled           === Order Summary(day).page.total
//   NC                          === NC Summary(day) and Sales Summary(day) nc_*
//
// The trading day below also carries the trap headline_online_channel.test.ts
// is about — an old delivery ticket on the table of today's dine-in bill — so
// the Online agreement here holds with it in place.
//
// Driven through the REAL readers over mis_fixtures.ts (only `pg` is faked).

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { makeDb, useFixtureDb, type FixtureBill, type FixtureDb, type FixtureOrder } from "./mis_fixtures";
import { GLANCE_BLOCK_KEYS, GLANCE_FIGURE_KEYS, glanceDrill, glanceDrills, type GlanceTarget } from "../../glance_drill";

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
const IST = "Asia/Kolkata";

const r2 = (n: number): number => Number(n.toFixed(2));
const sum = (xs: number[]): number => r2(xs.reduce((s, x) => s + x, 0));
const WALK_IN = new Set(["dine_in", "takeaway"]);

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL ?? "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../../database_supabase");
});

/** Shape (b): a 1% service charge line + SGST/CGST 2.5% each. */
function paid(food: number): Pick<FixtureBill, "total_amt" | "tax_breakdown"> {
  const sc = r2(food * 0.01);
  const base = r2(food + sc);
  const g = r2(base * 0.025);
  return {
    total_amt: r2(base + g + g),
    tax_breakdown: [
      { name: "Service Charge", percentage: 1, amount: sc },
      { name: "SGST", percentage: 2.5, amount: g },
      { name: "CGST", percentage: 2.5, amount: g },
    ],
  };
}

/** g2: 450 of food after a 50 discount, its 477.22 rounded up to 478.00. */
const ROUNDED_G2 = { ...paid(450), total_amt: 478, round_off: r2(478 - paid(450).total_amt) };

const todayKey = (): string => db.dayKeyOf(new Date(), IST);
const monthFrom = (): string => `${todayKey().slice(0, 7)}-01`;
/** 12:00 IST on a day key, plus `min` minutes. */
const noonOf = (day: string, min = 0): string => new Date(new Date(`${day}T12:00:00+05:30`).getTime() + min * 60_000).toISOString();
const dayBefore = (day: string): string => new Date(new Date(`${day}T12:00:00+05:30`).getTime() - 86_400_000).toISOString().slice(0, 10);

function order(id: string, at: string, over: Partial<FixtureOrder> = {}): FixtureOrder {
  return { id, created_at: at, status: 7, table_name: "T1", order_type: "dine_in", items: [], ...over };
}

/**
 * A trading day with every kind of bill the box has an element for. Every
 * expected number is read off the REPORT the drill names — the point is the
 * agreement — except the few hand checks that pin the fixture itself.
 */
function tradingDay(): FixtureDb {
  const today = todayKey();
  const at = (min: number): string => noonOf(today, min);
  return makeDb({
    timezone: IST,
    bills: [
      // Dine-in cash on T1 — the table that once took a DELIVERY order (ox).
      { id: "g1", bill_no: "5001", settled_at: at(0), ...paid(1000), round_off: 0, payment_method: "Cash", table_name: "T1", session_id: "S1", covers: 4, order_id: "o1" },
      // A delivery order, UPI, with a flat discount, rounded up to the rupee.
      { id: "g2", bill_no: "5002", settled_at: at(5), ...ROUNDED_G2, payment_method: "Upi", table_name: "T2", session_id: "S2", covers: 1, order_id: "o2", discount_type: "flat", discount_value: 50 },
      // An aggregator order paid split, cash + card, parts reconstructing the bill.
      { id: "g3", bill_no: "5003", settled_at: at(10), ...paid(800), round_off: 0, payment_method: "Split", payment_splits: [{ method: "Cash", amount: 500 }, { method: "Card", amount: 348.4 }], table_name: "T3", session_id: "S3", covers: 2, order_id: "o3" },
      // A counter takeaway, card, half refunded. A walk-in: not online.
      { id: "g4", bill_no: "5004", settled_at: at(15), ...paid(100), round_off: 0, payment_method: "Card", refund_amount: 50, table_name: "T4", session_id: "S4", covers: 1, order_id: "o4" },
      // Settled as NC: 0.00, its dishes in the NC ledger.
      { id: "g5", bill_no: "5005", settled_at: at(20), total_amt: 0, tax_breakdown: [], round_off: 0, payment_method: "NC", table_name: "T5", session_id: "S5", covers: 3, order_id: "o5" },
      // A bill whose order row is gone: its money counts, its channel is nobody's.
      { id: "g6", bill_no: "5006", settled_at: at(25), ...paid(200), round_off: 0, payment_method: "Cash", table_name: "T6", session_id: "S6", covers: 2, order_id: "o-gone" },
      // A bad split: only ₹100 of it was put under a mode.
      { id: "g7", bill_no: "5007", settled_at: at(30), ...paid(300), round_off: 0, payment_method: "Split", payment_splits: [{ method: "Upi", amount: 100 }], table_name: "T7", session_id: "S7", covers: 2, order_id: "o7" },
      // Earlier this month (or earlier today, on the 1st): month to date only.
      { id: "m1", bill_no: "4001", settled_at: noonOf(monthFrom(), -300), ...paid(700), round_off: 0, payment_method: "Cash", table_name: "T1", session_id: "SM1", covers: 2, order_id: "om1" },
      // Last month: in nothing.
      { id: "p1", bill_no: "3001", settled_at: noonOf(dayBefore(monthFrom())), ...paid(9000), round_off: 0, payment_method: "Cash", table_name: "T1", session_id: "SP1", covers: 9, order_id: "op1" },
      // Still on the floor: in nothing.
      { id: "f1", bill_no: "5099", settled_at: at(35), ...paid(5000), settled: false, table_name: "T8", session_id: "S8", covers: 2, order_id: "o8" },
    ],
    orders: [
      // THE TRAP: a delivery ticket rung on T1 last year. Today's T1 bill is dine-in.
      order("ox", "2025-01-10T08:00:00.000Z", { order_type: "delivery", table_name: "T1" }),
      order("o1", at(-30), { table_name: "T1" }),
      order("o2", at(-30), { table_name: "T2", order_type: "delivery" }),
      order("o3", at(-30), { table_name: "T3", order_type: "zomato" }),
      order("o4", at(-30), { table_name: "T4", order_type: "takeaway" }),
      order("o5", at(-30), { table_name: "T5", items: [{ name: "Thali", quantity: 2, price: 400, nc: true }] }),
      order("o7", at(-30), { table_name: "T7" }),
      order("om1", noonOf(monthFrom(), -330), { table_name: "T1" }),
      order("op1", noonOf(dayBefore(monthFrom()), -30), { table_name: "T1", order_type: "delivery" }),
      order("o8", at(-30), { table_name: "T8", order_type: "delivery" }),
    ],
    non_chargeables: [
      { id: "n1", created_at: at(20), order_id: "o5", item_name: "Thali", table_name: "T5", nc_kind: "complimentary", reason: "Owner's guests", quantity: 2, unit_price: 400, menu_price_at_nc: 400, marked_by: "cashier1", authorised_by: "manager01", scope: "bill", bill_id: "g5" },
      { id: "n2", created_at: at(3), order_id: "o1", item_name: "Lassi", table_name: "T1", nc_kind: "guest_complaint", reason: "Too sweet", quantity: 1, unit_price: 120, menu_price_at_nc: 120, marked_by: "cashier1", authorised_by: "manager01" },
    ],
  });
}

/** Run the report a Reports target names, with exactly the params it carries. */
async function openReport(t: GlanceTarget) {
  expect(t.module).toBe("Reports");
  expect(t.params.slot).toBe("all");
  const q = { from: t.params.from, to: t.params.to, slot: t.params.slot };
  switch (t.params.report) {
    case "sales_summary": return { sales: await db.GetSalesSummaryReport(RID, q) };
    case "settlement_summary": return { settle: await db.GetSettlementSummaryReport(RID, q) };
    case "order_summary": return { orders: await db.GetOrderSummaryReport(RID, { ...q, limit: 500 }) };
    case "nc_summary": return { nc: await db.GetNcSummaryReport(RID, { ...q, limit: 500 }) };
    default: throw new Error(`no reader for ${String(t.params.report)}`);
  }
}

beforeEach(() => { useFixtureDb(tradingDay()); });

describe("follow each figure's drill: the report shows the same number", () => {
  test("the fixture is what it says (hand check)", async () => {
    const head = await db.GetOverviewHeadline(RID);
    expect(head.today).toBe(todayKey());
    expect(head.month_from).toBe(monthFrom());
    // g1..g7 today (+ m1 on the 1st of the month, when today IS the 1st).
    expect(head.today_bills).toBe(todayKey() === monthFrom() ? 8 : 7);
    // Online = the delivery bill and the aggregator bill. Not g1 (whose TABLE
    // once took a delivery), not the takeaway, not the bill with no order row.
    expect(head.today_online_bills).toBe(2);
    expect(head.online_gross.value).toBe(r2(478 + paid(800).total_amt));
    expect(head.online_net.value).toBe(1250);
  });

  test("Today's net and gross, and every rung between them, are the Sales Summary's totals", async () => {
    const head = await db.GetOverviewHeadline(RID);
    for (const key of ["today_net", "today_gross"] as const) {
      const { sales } = await openReport(head[key].drill!);
      expect(sales).toBeDefined();
      const t = sales!.totals;
      expect(head.today_ladder).toEqual({
        bills: t.bills, item_total: t.item_total, discount: t.discount, net: t.net,
        service_charge: t.service_charge, tax: t.tax, round_off: t.round_off,
        grand_total: t.grand_total, refund: t.refund,
      });
      expect(head.today_net.value).toBe(t.net);
      expect(head.today_gross.value).toBe(t.grand_total);
    }
    // The ladder joins the two figures, and carries what the sheet prints.
    const l = head.today_ladder;
    expect(r2(l.net + l.service_charge + l.tax + l.round_off)).toBe(l.grand_total);
    expect(l.discount).toBe(50);
    expect(l.refund).toBe(50);
    expect(l.round_off).toBe(0.78);
    // No covers, APC or ABV: this read has no seating to count them from.
    expect(Object.keys(l).sort()).toEqual(
      ["bills", "discount", "grand_total", "item_total", "net", "refund", "round_off", "service_charge", "tax"],
    );
  });

  test("Online (gross) and its bills are the Sales Summary's delivery + other channels", async () => {
    const head = await db.GetOverviewHeadline(RID);
    for (const key of ["online_net", "online_gross"] as const) {
      const { sales } = await openReport(head[key].drill!);
      const online = sales!.by_order_type.filter((r) => !WALK_IN.has(r.order_type));
      expect(sum(online.map((r) => r.grand_total))).toBe(head.online_gross.value);
      expect(online.reduce((s, r) => s + r.bills, 0)).toBe(head.today_online_bills);
    }
  });

  test("Online (net) is the Order Summary's net on those same channels", async () => {
    const head = await db.GetOverviewHeadline(RID);
    const d = head.drills.bills;
    const { orders } = await openReport(d);
    const online = orders!.rows.filter((r) => !WALK_IN.has(String(r.order_type ?? "dine_in")) && r.order_type !== null);
    expect(sum(online.map((r) => r.net))).toBe(head.online_net.value);
    expect(online.length).toBe(head.today_online_bills);
  });

  test("Cash collection is the Settlement Summary's Cash row, cash parts only", async () => {
    const head = await db.GetOverviewHeadline(RID);
    const { settle } = await openReport(head.cash_collection.drill!);
    const cash = settle!.rows.find((r) => r.method === "Cash");
    expect(cash?.amount).toBe(head.cash_collection.value);
    // g1 + g3's cash part + g6 (+ m1 on the 1st).
    const early = todayKey() === monthFrom() ? paid(700).total_amt : 0;
    expect(head.cash_collection.value).toBe(r2(paid(1000).total_amt + 500 + paid(200).total_amt + early));
  });

  test("the by-method label and every mode's row open the Settlement Summary on those rows", async () => {
    const head = await db.GetOverviewHeadline(RID);
    const { settle } = await openReport(head.drills.by_method);
    const shown = settle!.rows.filter((r) => r.method === "Unallocated" || r.amount !== 0 || r.refund !== 0);
    expect(head.today_by_method).toEqual(shown);
    expect(Object.keys(head.drills.by_method_rows)).toEqual(head.today_by_method.map((r) => r.method));
    for (const row of head.today_by_method) {
      const drill = head.drills.by_method_rows[row.method];
      const again = await openReport(drill);
      expect(again.settle!.rows.find((r) => r.method === row.method)).toEqual(row);
      // The secondary is that mode's own bills; Unallocated's are the Split bills.
      expect(drill.secondary).toMatchObject({
        module: "Accounting",
        params: { from: head.today, to: head.today, method: row.method === "Unallocated" ? "Split" : row.method },
        bills: true,
      });
    }
    expect(head.today_by_method.find((r) => r.method === "Unallocated")?.bills).toBe(1);
  });

  test("Month to date and month_bills are the Sales Summary over month_from..today", async () => {
    const head = await db.GetOverviewHeadline(RID);
    for (const d of [head.month_to_date.drill!, head.drills.month]) {
      expect(d.params).toMatchObject({ from: head.month_from, to: head.today });
      const { sales } = await openReport(d);
      expect(sales!.totals.grand_total).toBe(head.month_to_date.value);
      expect(sales!.totals.bills).toBe(head.month_bills);
    }
    // Last month's ₹9000 bill and the open table are in neither.
    expect(head.month_bills).toBe(8);
  });

  test("N bill(s) settled is the Order Summary's row count for the day", async () => {
    const head = await db.GetOverviewHeadline(RID);
    const { orders } = await openReport(head.drills.bills);
    expect(orders!.page.total).toBe(head.today_bills);
  });

  test("NC is the NC Summary's loss and the Sales Summary's nc_bills / nc_value", async () => {
    const head = await db.GetOverviewHeadline(RID);
    const { nc } = await openReport(head.drills.nc);
    expect(nc!.totals.loss).toBe(head.today_nc.value);
    expect(head.today_nc.value).toBe(800 + 120);
    const { sales } = await openReport(head.drills.header);
    expect(sales!.totals.nc_bills).toBe(head.today_nc.bills);
    expect(sales!.totals.nc_value).toBe(head.today_nc.value);
  });

  test("the header, the day chip and the split/warning fallbacks land on the same day", async () => {
    const head = await db.GetOverviewHeadline(RID);
    for (const d of [head.drills.header, head.drills.day, head.drills.split.fallbacks[0], head.drills.unallocated.fallbacks[0]]) {
      const res = await openReport(d);
      const total = res.sales?.totals.grand_total ?? res.settle?.totals.amount;
      expect(total).toBe(head.today_gross.value);
    }
  });
});

describe("the drills block is complete and cut on the headline's own day", () => {
  test("every figure carries its drill; the block carries the rest", async () => {
    const head = await db.GetOverviewHeadline(RID);
    const day = { today: head.today, month_from: head.month_from };
    for (const key of GLANCE_FIGURE_KEYS) {expect(head[key].drill).toEqual(glanceDrill(key, day));}
    expect(head.drills).toEqual(glanceDrills(day, head.today_by_method.map((r) => r.method)));
    for (const key of GLANCE_BLOCK_KEYS) {expect(head.drills[key]).toBeDefined();}
  });

  test("an empty day still ships every drill, with no row drills", async () => {
    const d = tradingDay();
    useFixtureDb({ ...d, bills: d.bills.filter((b) => b.id === "p1") });
    const head = await db.GetOverviewHeadline(RID);
    expect(head.today_bills).toBe(0);
    expect(head.today_online_bills).toBe(0);
    expect(head.today_ladder).toEqual({
      bills: 0, item_total: 0, discount: 0, net: 0, service_charge: 0, tax: 0, round_off: 0, grand_total: 0, refund: 0,
    });
    expect(head.drills.by_method_rows).toEqual({});
    expect(head.drills.nothing_settled.module).toBe("Tables");
  });
});
