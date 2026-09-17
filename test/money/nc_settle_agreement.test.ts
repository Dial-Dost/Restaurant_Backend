// NC ANALYTICS, AND THE AGREEMENT THEY MUST NOT BREAK — client item 5.
//
// A bill SETTLED AS NC closes at 0.00 with payment_method 'NC', and its dishes
// sit in the NC ledger with scope 'bill'. The control pack then has to say two
// things at once, and keep them apart:
//
//   1. THE MONEY DOES NOT MOVE. Sales Gross === Σ Order Summary rows ===
//      Σ Settlement rows === Σ Counter rows, with a Cash bill, an NC-settled
//      bill, an item comp and a released ₹0 table all in the window.
//   2. NC IS VISIBLE, BESIDE THE MONEY. Sales `nc_bills` + `nc_value`, the
//      Settlement "Non-chargeable (NC)" row at 0.00 and `totals.nc`, the
//      Overview's `today_nc`, the NC Summary's Scope column and `by_scope`, and
//      the Bill Edit kind — every one the same numbers.
//
// And the rule decision 2 fixed: an NC bill COUNTS as a bill and its party
// counts as covers, exactly as a released ₹0 table always has, so APC and ABV
// keep their denominators — and the reports say so.
//
// Driven through the REAL readers over mis_fixtures.ts (only `pg` is faked).

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import {
  RES_ID,
  OUTLET_A,
  makeDb,
  useFixtureDb,
  type FixtureBill,
  type FixtureDb,
  type FixtureNonChargeable,
  type FixtureOrder,
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
const IST = "Asia/Kolkata";
const W = { from: "2026-06-01", to: "2026-06-15" };
const PERM_NC = "b4e7a1c9-2d58-4f36-9a07-5c81e3b0d472";

const r2 = (n: number): number => Number(n.toFixed(2));
const sum = (xs: number[]): number => r2(xs.reduce((s, x) => s + x, 0));

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL ?? "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../../database_supabase");
});

/** Shape (b): 1% service charge line + SGST/CGST 2.5% each, as the seed carries. */
function paid(food: number): { total_amt: number; tax_breakdown: FixtureBill["tax_breakdown"] } {
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

function comp(over: Partial<FixtureNonChargeable> & Pick<FixtureNonChargeable, "id" | "created_at" | "order_id" | "item_name" | "quantity" | "unit_price">): FixtureNonChargeable {
  return {
    table_name: "T1", nc_kind: "complimentary", reason: "On the house",
    marked_by: "cashier1", authorised_by: "manager01", menu_price_at_nc: over.unit_price,
    ...over,
  };
}

const NC_BILL: FixtureBill = {
  id: "bnc", bill_no: "2002", settled_at: "2026-06-03T14:00:00.000Z",
  total_amt: 0, tax_breakdown: [], round_off: 0, payment_method: "NC",
  table_name: "T2", session_id: "S2", covers: 6, order_id: "o2",
};

/**
 * Cash 1000 on T1 (one dessert comped on it), the whole of T2 settled as NC,
 * a released ₹0 table, and Card 500. Every expected number is by hand.
 */
function ncDb(over: Partial<FixtureDb> = {}): FixtureDb {
  const orders: FixtureOrder[] = [
    { id: "o1", created_at: "2026-06-02T09:00:00.000Z", status: 4, table_name: "T1", items: [
      { name: "Paneer Tikka", quantity: 2, price: 300 }, { name: "Dal", quantity: 1, price: 400 },
      { name: "Gulab Jamun", quantity: 1, price: 150, nc: true },
    ] },
    { id: "o2", created_at: "2026-06-03T13:00:00.000Z", status: 4, table_name: "T2", items: [
      { name: "Thali", quantity: 3, price: 400, nc: true }, { name: "Lassi", quantity: 2, price: 100, nc: true },
    ] },
    { id: "o3", created_at: "2026-06-04T09:00:00.000Z", status: 5, table_name: "T3", items: [{ name: "Chai", quantity: 2, price: 50 }] },
    { id: "o4", created_at: "2026-06-05T09:00:00.000Z", status: 4, table_name: "T4", items: [
      { name: "Biryani", quantity: 1, price: 500 }, { name: "Raita", quantity: 1, price: 80 },
    ] },
  ];
  return makeDb({
    timezone: IST,
    bills: [
      { id: "b1", bill_no: "2001", settled_at: "2026-06-02T10:00:00.000Z", ...paid(1000), round_off: 0, payment_method: "Cash", table_name: "T1", session_id: "S1", covers: 4, order_id: "o1" },
      NC_BILL,
      // A RELEASED table: closed at 0.00 with no mode, as ReleaseTable leaves it.
      { id: "b3", bill_no: "2003", settled_at: "2026-06-04T10:00:00.000Z", total_amt: 0, tax_breakdown: [], payment_method: null, table_name: "T3", session_id: "S3", covers: 2, order_id: "o3" },
      { id: "b4", bill_no: "2004", settled_at: "2026-06-05T10:00:00.000Z", ...paid(500), round_off: 0, payment_method: "Card", table_name: "T4", session_id: "S4", covers: 2, order_id: "o4" },
    ],
    orders,
    non_chargeables: [
      // An item comp on the Cash bill.
      comp({ id: "n1", created_at: "2026-06-02T09:30:00.000Z", order_id: "o1", item_name: "Gulab Jamun", quantity: 1, unit_price: 150, nc_kind: "guest_complaint" }),
      // The NC settle: two lines, scope 'bill', naming the bill it closed.
      comp({ id: "n2", created_at: "2026-06-03T14:00:00.000Z", order_id: "o2", item_name: "Thali", quantity: 3, unit_price: 400, table_name: "T2", scope: "bill", bill_id: "bnc" }),
      comp({ id: "n3", created_at: "2026-06-03T14:00:00.000Z", order_id: "o2", item_name: "Lassi", quantity: 2, unit_price: 100, table_name: "T2", scope: "bill", bill_id: "bnc" }),
      // A comp a manager reversed: listed, worth nothing.
      comp({ id: "n4", created_at: "2026-06-05T09:30:00.000Z", order_id: "o4", item_name: "Raita", quantity: 1, unit_price: 80, table_name: "T4", reversed_at: "2026-06-05T09:35:00.000Z", reversed_by: "manager01", reversal_reason: "Wrong table" }),
    ],
    audits: [
      { id: "a1", created_at: "2026-06-02T09:30:00.000Z", action_id: PERM_NC, action_name: "Mark Items Non-Chargeable", reason: "Made 1 x Gulab Jamun non-chargeable", details: { nc_id: "n1", order_id: "o1", table: "T1", item: "Gulab Jamun" } },
      { id: "a2", created_at: "2026-06-03T14:00:00.000Z", action_id: PERM_NC, action_name: "Mark Items Non-Chargeable", reason: "Settled bill 2002 (table T2) as non-chargeable", details: { scope: "bill", bill_id: "bnc", bill_no: "2002", table: "T2", nc_value: 1400, nc_lines: 2, would_have_charged: 1624 } },
      { id: "a3", created_at: "2026-06-06T09:00:00.000Z", action_id: PERM_NC, action_name: "Mark Items Non-Chargeable", reason: "Undid the non-chargeable settle of bill 1999", details: { scope: "bill", reversal: true, bill_id: "bold", table: "T9" } },
    ],
    ...over,
  });
}

const PAID_GROSS = sum([paid(1000).total_amt, paid(500).total_amt]);
const NC_VALUE = 150 + 1200 + 200; // live comps only: n4 was reversed

beforeEach(() => { useFixtureDb(ncDb()); });

describe("the money does not move: the four headline sums still agree", () => {
  test("Sales Gross === Σ Order rows === Σ Settlement rows === Σ Counter rows", async () => {
    const sales = await db.GetSalesSummaryReport(RID, W);
    const orders = await db.GetOrderSummaryReport(RID, { ...W, limit: 500 });
    const settle = await db.GetSettlementSummaryReport(RID, W);
    const counter = await db.GetCounterSummaryReport(RID, W);
    expect(sales.totals.grand_total).toBe(PAID_GROSS);
    expect(sum(orders.rows.map((r) => r.grand_total))).toBe(PAID_GROSS);
    expect(sum(settle.rows.map((r) => r.amount))).toBe(PAID_GROSS);
    expect(settle.totals.amount).toBe(PAID_GROSS);
    expect(sum(counter.rows.map((r) => r.grand_total))).toBe(PAID_GROSS);
    // Net carries no given-away food either.
    expect(sales.totals.net).toBe(1500);
    expect(r2(sales.totals.net + sales.totals.service_charge + sales.totals.tax + sales.totals.round_off)).toBe(sales.totals.grand_total);
  });

  test("the accounting Sales report books nothing for the NC bill", async () => {
    const acc = await db.GetSalesReport(RID, W.from, W.to);
    expect(acc.total_sales).toBe(PAID_GROSS);
    expect(acc.total_net).toBe(1500);
  });
});

describe("NC bills count as bills, and their parties as covers (decision 2)", () => {
  test("bills 4, covers 14 — the NC and the released table both inside, APC and ABV on those denominators", async () => {
    const sales = await db.GetSalesSummaryReport(RID, W);
    expect(sales.totals.bills).toBe(4);
    expect(sales.totals.covers).toBe(4 + 6 + 2 + 2);
    expect(sales.totals.apc).toBe(r2(1500 / 14));
    expect(sales.totals.abv).toBe(r2(PAID_GROSS / 4));
  });

  test("the rule is stated on every report that counts them", async () => {
    const rule = /settled as non-chargeable \(NC\) close at 0\.00 .* still counts as a bill and its party still counts as covers/;
    expect((await db.GetSalesSummaryReport(RID, W)).meta.notes.some((n) => rule.test(n))).toBe(true);
    expect((await db.GetSettlementSummaryReport(RID, W)).meta.notes.some((n) => rule.test(n))).toBe(true);
    expect((await db.GetNcSummaryReport(RID, { ...W, limit: 500 })).meta.notes.some((n) => rule.test(n))).toBe(true);
  });
});

describe("NC is visible beside the money, and every report tells it the same way", () => {
  test("Sales Summary: nc_bills and nc_value, in the totals and summed by the series", async () => {
    const sales = await db.GetSalesSummaryReport(RID, W);
    expect(sales.totals.nc_bills).toBe(1);
    expect(sales.totals.nc_value).toBe(NC_VALUE);
    expect(sales.columns.find((c) => c.key === "nc_bills")).toMatchObject({ label: "NC bills", type: "int", total: true });
    expect(sum(sales.series.map((r) => r.nc_bills))).toBe(1);
    expect(sum(sales.series.map((r) => r.nc_value))).toBe(NC_VALUE);
    expect(sales.series.find((r) => r.nc_bills === 1)?.bucket).toBe("2026-06-03");
  });

  test("Settlement Summary: a Non-chargeable (NC) row at 0.00, and totals.nc beside the takings", async () => {
    const settle = await db.GetSettlementSummaryReport(RID, W);
    const row = settle.rows.find((r) => r.method === "NC");
    expect(row).toMatchObject({ label: "Non-chargeable (NC)", bills: 1, amount: 0, refund: 0, net_amount: 0, share_pct: 0 });
    // The released table is still the Other row it always was.
    expect(settle.rows.find((r) => r.method === "Other")).toMatchObject({ bills: 1, amount: 0 });
    const sales = await db.GetSalesSummaryReport(RID, W);
    expect(settle.totals.nc).toEqual({ bills: sales.totals.nc_bills, value: sales.totals.nc_value });
    expect(settle.totals.bills).toBe(4);
  });

  test("NC Summary: a Scope column, the NC bill named directly, by_scope summing to the loss", async () => {
    const nc = await db.GetNcSummaryReport(RID, { ...W, limit: 500 });
    expect(nc.columns.find((c) => c.key === "scope")).toMatchObject({ label: "Scope", type: "text" });
    const byId = new Map(nc.rows.map((r) => [r.nc_id, r]));
    expect(byId.get("n1")).toMatchObject({ scope: "Item", bill_no: "2001", loss: 150 });
    expect(byId.get("n2")).toMatchObject({ scope: "Bill", bill_no: "2002", bill_id: "bnc", loss: 1200 });
    expect(byId.get("n3")).toMatchObject({ scope: "Bill", bill_no: "2002", loss: 200 });
    expect(byId.get("n4")).toMatchObject({ scope: "Item", loss: 0, reversed_loss: 80 });
    expect(nc.totals.loss).toBe(NC_VALUE);
    expect(nc.by_scope).toEqual([
      { scope: "item", label: "Item comped", entries: 1, quantity: 1, loss: 150 },
      { scope: "bill", label: "Bill settled as NC", entries: 2, quantity: 5, loss: 1400 },
    ]);
    expect(sum(nc.by_scope.map((s) => s.loss))).toBe(nc.totals.loss);
    const sales = await db.GetSalesSummaryReport(RID, W);
    expect(nc.totals.loss).toBe(sales.totals.nc_value);
  });

  test("the STORED bill wins where the resolution would name another seating's", async () => {
    // A bill on T2 that closed after the comps but before the NC bill: the
    // "first bill at or after the comp" rule would pick it.
    const base = ncDb();
    useFixtureDb({
      ...base,
      bills: [
        ...base.bills.map((b) => (b.id === "bnc" ? { ...b, settled_at: "2026-06-03T15:00:00.000Z" } : b)),
        { id: "bx2", bill_no: "2999", settled_at: "2026-06-03T14:30:00.000Z", ...paid(100), round_off: 0, payment_method: "Cash", table_name: "T2", session_id: "S9", covers: 1 },
      ],
    });
    const nc = await db.GetNcSummaryReport(RID, { ...W, limit: 500 });
    expect(nc.rows.find((r) => r.nc_id === "n2")?.bill_no).toBe("2002");
  });

  test("before migration 052 the report still opens: every row an item comp, nothing selected that is not there", async () => {
    // A process that has never seen the columns (the catalogue answer only ever latches true).
    db.__poolHygieneTestSeam.resetDdlMemo();
    useFixtureDb(ncDb({ nc_bill_columns_missing: true }));
    const nc = await db.GetNcSummaryReport(RID, { ...W, limit: 500 });
    expect(nc.rows.every((r) => r.scope === "Item")).toBe(true);
    expect(nc.totals.loss).toBe(NC_VALUE);
    expect(nc.by_scope.find((s) => s.scope === "item")?.loss).toBe(NC_VALUE);
    expect(nc.by_scope.find((s) => s.scope === "bill")?.loss).toBe(0);
  });

  test("Bill Edit: the NC settle, and its undoing, are kinds of their own", async () => {
    const edits = await db.GetBillEditReport(RID, { ...W, limit: 500 });
    const kinds = new Map(edits.rows.map((r) => [r.audit_id, r]));
    expect(kinds.get("a1")).toMatchObject({ kind: "item_non_chargeable", action: "Item made non-chargeable" });
    expect(kinds.get("a2")).toMatchObject({ kind: "bill_non_chargeable", action: "Bill settled as non-chargeable", bill_id: "bnc", table_name: "T2" });
    expect(kinds.get("a3")).toMatchObject({ kind: "bill_non_chargeable_reversed" });
  });
});

describe("the Overview: today's NC beside the by-method block, never inside it", () => {
  const today = (): string => db.dayKeyOf(new Date(), IST);
  const shiftToToday = (d: FixtureDb): FixtureDb => {
    const key = today();
    const at = (hh: number): string => new Date(`${key}T00:00:00+05:30`).getTime() + hh * 3600000 > Date.now()
      ? new Date(Date.now() - (6 - hh) * 60000).toISOString()
      : new Date(new Date(`${key}T00:00:00+05:30`).getTime() + hh * 3600000).toISOString();
    return {
      ...d,
      bills: d.bills.map((b, i) => ({ ...b, settled_at: at(1 + i) })),
      orders: d.orders.map((o, i) => ({ ...o, created_at: at(i) })),
      non_chargeables: d.non_chargeables.map((n, i) => ({ ...n, created_at: at(i), reversed_at: n.reversed_at ? at(i) : null })),
    };
  };

  test("today_nc is the Sales Summary's nc_bills / nc_value for today, and the modes still add up to Gross", async () => {
    useFixtureDb(shiftToToday(ncDb()));
    const head = await db.GetOverviewHeadline(RID);
    const sales = await db.GetSalesSummaryReport(RID, { from: today(), to: today() });
    expect(head.today_nc).toMatchObject({ bills: 1, value: NC_VALUE, label: "Non-chargeable (NC) — not collected" });
    expect(head.today_nc.bills).toBe(sales.totals.nc_bills);
    expect(head.today_nc.value).toBe(sales.totals.nc_value);
    expect(head.today_nc.hint).toMatch(/add nothing to the figures above/);
    // Beside, never inside: no NC row among the modes, which still sum to Gross.
    expect(head.today_by_method.map((r) => r.method)).not.toContain("NC");
    expect(sum(head.today_by_method.map((r) => r.amount))).toBe(head.today_gross.value);
    expect(head.today_gross.value).toBe(PAID_GROSS);
    expect(head.today_bills).toBe(4);
    // Cash is the cash bill's money and nothing else.
    expect(head.cash_collection.value).toBe(paid(1000).total_amt);
  });

  test("a day with no NC reads zero, not missing", async () => {
    useFixtureDb(shiftToToday(ncDb({ non_chargeables: [], bills: ncDb().bills.filter((b) => b.id !== "bnc") })));
    const head = await db.GetOverviewHeadline(RID);
    expect(head.today_nc).toMatchObject({ bills: 0, value: 0 });
  });
});

void OUTLET_A;
void RES_ID;
