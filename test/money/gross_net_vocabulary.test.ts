// GROSS AND NET MEAN ONE THING EACH — on every report, in every export.
//
// The client: "Gross means the total value of all the bills including service
// charge, taxes and so on. Net means just the menu price value of all the bills
// where you reduce the discounts, service charge, taxes and so on."
//
// Nothing about the MONEY was wrong. The WORDS were: "Gross" named the
// pre-discount item value on seven MIS reports and the grand total on the
// Overview; "Net" named the pre-tax base, a tax-inclusive after-refunds figure on
// the Settlement Summary, and another on Accounting. A restaurant that never
// discounts (every production tenant in the last 30 days) saw Gross === Net on
// every row, which is exactly what the client was looking at.
//
// So this suite pins VOCABULARY to KEYS, through the real readers:
//   * a column labelled "Gross" is keyed grand_total, and grand_total is always
//     labelled "Gross";
//   * a column labelled "Net" is keyed net, and net is always labelled "Net";
//   * a column labelled "Item total" is the pre-discount rung (item_total, or
//     gross_amount on the three item-level reports);
//   * the deprecated `gross` alias is never a column, and still carries the item
//     total for installed 1.9.x tills;
// plus the two agreements the new words promise: the visible rungs of the Order
// and Counter Summaries add up to their Gross (round off included), and the
// accounting Sales report's Net is the MIS Net for the same days.
//
// Only `pg` is faked — see mis_fixtures.ts.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { makeDb, useFixtureDb, type FixtureDb, type FixtureOrder } from "./mis_fixtures";
import { renderSalesCsv } from "../../report_render";
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
    connect(): Promise<{ query: typeof run; release: () => void }> {
      return Promise.resolve({ query: run, release: () => { /* pooled */ } });
    }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

type Readers = typeof import("../../database_supabase");
let db: Readers;

const RID = "zztest-gross-net";
const W = { from: "2026-06-01", to: "2026-06-15" };

const r2 = (n: number): number => Number(n.toFixed(2));
const sum = (xs: number[]): number => r2(xs.reduce((s, x) => s + x, 0));

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL ?? "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../../database_supabase");
});

function order(over: Partial<FixtureOrder> & { id: string; created_at: string }): FixtureOrder {
  return { items: [], order_type: "dine_in", table_name: "T1", status: 7, ...over };
}

// --- the tenant ----------------------------------------------------------------
//
// Three bills, every rung non-zero somewhere, so no two words can share a value
// by accident:
//
//   g1  Gaia's receipt   net 4745 · GST 237.26 · round off −0.26 · Gross 4982
//   g2  150 off, SC 1%   item total 1150 − 150 = net 1000 · SC 10 · GST 50.50
//                        · round off −0.50 · Gross 1060
//   g3  rounded up       net 90 · GST 4.50 · round off +0.50 · Gross 95
//
//   Item total 5985 · Discount 150 · Net 5835 · SC 10 · Tax 292.26
//   · Round off −0.26 · Gross 6137
const ITEM_TOTAL = 5985;
const DISCOUNT = 150;
const NET = 5835;
const SERVICE_CHARGE = 10;
const TAX = 292.26;
const ROUND_OFF = -0.26;
const GROSS = 6137;

function tenant(): FixtureDb {
  return makeDb({
    timezone: "Asia/Kolkata",
    bills: [
      {
        id: "g1", bill_no: "5001", settled_at: "2026-06-03T10:00:00.000Z", total_amt: 4982, round_off: -0.26,
        tax_breakdown: [{ name: "SGST", percentage: 2.5, amount: 118.63 }, { name: "CGST", percentage: 2.5, amount: 118.63 }],
        payment_method: "Cash", table_name: "T1", session_id: "S1", covers: 2, order_id: "og1",
      },
      {
        id: "g2", bill_no: "5002", settled_at: "2026-06-04T10:00:00.000Z", total_amt: 1060, round_off: -0.5,
        tax_breakdown: [
          { name: "Service Charge", percentage: 1, amount: 10 },
          { name: "SGST", percentage: 2.5, amount: 25.25 },
          { name: "CGST", percentage: 2.5, amount: 25.25 },
        ],
        discount_type: "flat", discount_value: 150, reason: "Regular",
        payment_method: "Card", table_name: "T2", session_id: "S2", covers: 3, order_id: "og2",
      },
      {
        id: "g3", bill_no: "5003", settled_at: "2026-06-05T10:00:00.000Z", total_amt: 95, round_off: 0.5,
        tax_breakdown: [{ name: "GST", percentage: 5, amount: 4.5 }],
        payment_method: "Upi", table_name: "T3", session_id: null, order_id: "og3",
      },
    ],
    orders: [
      order({ id: "og1", created_at: "2026-06-03T09:00:00.000Z", items: [{ name: "Thali", quantity: 1, price: 4745 }] }),
      order({ id: "og2", created_at: "2026-06-04T09:00:00.000Z", items: [{ name: "Dal", quantity: 1, price: 1150 }] }),
      order({ id: "og3", created_at: "2026-06-05T09:00:00.000Z", items: [{ name: "Chai", quantity: 3, price: 30 }] }),
    ],
  });
}

beforeEach(() => { useFixtureDb(tenant()); });

/** Every one of the fifteen, as (name, columns). Static, but read off live payloads. */
async function allColumns(): Promise<{ report: string; columns: MisColumn[] }[]> {
  const paged = { ...W, limit: 500 };
  return [
    { report: "item_wise", columns: (await db.GetItemWiseReport(RID, paged)).columns },
    { report: "discount", columns: (await db.GetDiscountReport(RID, paged)).columns },
    { report: "void_kot", columns: (await db.GetVoidKotReport(RID, paged)).columns },
    { report: "bill_edit", columns: (await db.GetBillEditReport(RID, paged)).columns },
    { report: "sales_summary", columns: (await db.GetSalesSummaryReport(RID, W)).columns },
    { report: "order_summary", columns: (await db.GetOrderSummaryReport(RID, paged)).columns },
    { report: "executive_summary", columns: (await db.GetExecutiveSummaryReport(RID, W)).columns },
    { report: "cover_size_summary", columns: (await db.GetCoverSizeSummaryReport(RID, W)).columns },
    { report: "settlement_summary", columns: (await db.GetSettlementSummaryReport(RID, W)).columns },
    { report: "nc_summary", columns: (await db.GetNcSummaryReport(RID, paged)).columns },
    { report: "service_charge_deny", columns: (await db.GetServiceChargeDenyReport(RID, paged)).columns },
    { report: "group_summary", columns: (await db.GetGroupSummaryReport(RID, W)).columns },
    { report: "variation_summary", columns: (await db.GetVariationSummaryReport(RID, W)).columns },
    { report: "tip_summary", columns: (await db.GetTipSummaryReport(RID, paged)).columns },
    { report: "counter_summary", columns: (await db.GetCounterSummaryReport(RID, W)).columns },
  ];
}

// --- 1. THE VOCABULARY PIN -----------------------------------------------------

describe("one word, one key, on all fifteen", () => {
  test("a column labelled Gross is keyed grand_total, and grand_total is always labelled Gross", async () => {
    for (const { report, columns } of await allColumns()) {
      for (const c of columns) {
        if (c.label === "Gross") {expect(`${report}:${c.key}`).toBe(`${report}:grand_total`);}
        if (c.key === "grand_total") {expect(`${report}:${c.label}`).toBe(`${report}:Gross`);}
        // Any other mention of gross is a qualified reference TO the grand total.
        if (/gross/i.test(c.label) && c.label !== "Gross") {
          expect([`${report}:previous_grand_total`, `${report}:share_pct`]).toContain(`${report}:${c.key}`);
        }
      }
    }
  });

  test("a column labelled Net is keyed net, and net is always labelled Net — no other column says net", async () => {
    for (const { report, columns } of await allColumns()) {
      for (const c of columns) {
        if (c.key === "net") {expect(`${report}:${c.label}`).toBe(`${report}:Net`);}
        if (/\bnet\b/i.test(c.label)) {expect(`${report}:${c.key}`).toBe(`${report}:net`);}
      }
    }
  });

  test("Item total is the pre-discount rung, and the deprecated gross alias is never a column", async () => {
    for (const { report, columns } of await allColumns()) {
      for (const c of columns) {
        if (c.label === "Item total") {
          expect(["item_total", "gross_amount"]).toContain(c.key);
        }
        expect(`${report}:${c.key}`).not.toBe(`${report}:gross`);
        // The old word for the bottom rung is retired everywhere.
        expect(`${report}:${c.label}`).not.toBe(`${report}:Grand total`);
      }
    }
  });

  test("the item-level reports show Item total only — their always-equal Discount and Net columns are gone from the grid, not from the payload", async () => {
    const item = await db.GetItemWiseReport(RID, { ...W, limit: 500 });
    const group = await db.GetGroupSummaryReport(RID, W);
    const variation = await db.GetVariationSummaryReport(RID, W);
    for (const r of [item, group, variation]) {
      const keys = r.columns.map((c) => c.key);
      expect(keys).toContain("gross_amount");
      expect(keys).not.toContain("net_amount");
      expect(keys).not.toContain("discount_amount");
    }
    // Installed 1.9.x tills still read these off the totals.
    expect(item.totals.net_amount).toBe(item.totals.gross_amount);
    expect(item.totals.discount_amount).toBe(0);
    expect(group.totals.net_amount).toBe(group.totals.gross_amount);
  });

  test("the reports that print the words define them, in the notes every export carries", async () => {
    const defines = (notes: string[]): boolean => notes.some((n) => /^Gross is the grand total/.test(n));
    expect(defines((await db.GetSalesSummaryReport(RID, W)).meta.notes)).toBe(true);
    expect(defines((await db.GetOrderSummaryReport(RID, { ...W, limit: 500 })).meta.notes)).toBe(true);
    expect(defines((await db.GetCounterSummaryReport(RID, W)).meta.notes)).toBe(true);
    expect(defines((await db.GetDiscountReport(RID, { ...W, limit: 500 })).meta.notes)).toBe(true);
    expect(defines((await db.GetExecutiveSummaryReport(RID, W)).meta.notes)).toBe(true);
    expect(defines((await db.GetCoverSizeSummaryReport(RID, W)).meta.notes)).toBe(true);
  });

  // The Discount report printed "Bill totals are already NET of these discounts"
  // one line above the note that defines Net as the item total less discounts —
  // while those bill totals are its Gross column (1060 on g2, Net 1000). Every
  // CSV/XLSX/PDF preamble carried both.
  test("the Discount report never calls the bill totals net of its discounts — they are Gross", async () => {
    const notes = (await db.GetDiscountReport(RID, { ...W, limit: 500 })).meta.notes;
    for (const n of notes) {expect(n).not.toMatch(/\bnet of\b/i);}
    expect(notes.some((n) => /^Bill totals \(Gross\) are already after these discounts/.test(n))).toBe(true);
  });
});

// --- 2. THE NUMBERS BEHIND THE WORDS ------------------------------------------

describe("Gross, Net and Item total over one window", () => {
  test("the Sales Summary: item total − discount = net + SC + tax + round off = gross, and gross ≠ net", async () => {
    const t = (await db.GetSalesSummaryReport(RID, W)).totals;
    expect(t.item_total).toBe(ITEM_TOTAL);
    expect(t.discount).toBe(DISCOUNT);
    expect(t.net).toBe(NET);
    expect(t.service_charge).toBe(SERVICE_CHARGE);
    expect(t.tax).toBe(TAX);
    expect(t.round_off).toBe(ROUND_OFF);
    expect(t.grand_total).toBe(GROSS);
    expect(r2(t.item_total - t.discount)).toBe(t.net);
    expect(r2(t.net + t.service_charge + t.tax + t.round_off)).toBe(t.grand_total);
    // The alias installed tills read keeps its old value.
    expect(t.gross).toBe(t.item_total);
  });

  test("the Discount report: Item total rides beside Net and Gross, and its % is of the WHOLE window's item total", async () => {
    const disc = await db.GetDiscountReport(RID, { ...W, limit: 500 });
    const row = disc.rows[0];
    expect(row?.item_total).toBe(1150);
    expect(row?.net).toBe(1000);
    expect(row?.grand_total).toBe(1060);
    expect(row?.gross).toBe(row?.item_total);
    expect(disc.totals.item_total).toBe(1150);
    expect(disc.totals.discount_pct_of_item_total).toBe(r2((DISCOUNT / ITEM_TOTAL) * 100));
    expect(disc.totals.discount_pct_of_gross).toBe(disc.totals.discount_pct_of_item_total);
  });

  test("Sales, Order and Counter Summary default layouts show the round off, so their visible rungs reach Gross", async () => {
    const sales = await db.GetSalesSummaryReport(RID, W);
    const orders = await db.GetOrderSummaryReport(RID, { ...W, limit: 500 });
    const counter = await db.GetCounterSummaryReport(RID, W);
    for (const cols of [sales.columns, orders.columns, counter.columns]) {
      const at = (k: string): number => cols.findIndex((c) => c.key === k);
      const roundOff = cols[at("round_off")];
      expect(roundOff?.default_on).not.toBe(false);
      expect(roundOff?.total).toBe(true);
      // Between the rungs it sits between, in reading order.
      expect(at("net")).toBeLessThan(at("round_off"));
      expect(at("round_off")).toBeLessThan(at("grand_total"));
    }
  });

  // The round off being ON is not the property; the property is that a reader
  // who never touches the column picker can add up what is in front of them. The
  // test above passed with Service charge (Order, Counter) and Tax (Counter)
  // still hidden by default — bill 5002 read Net 1000 + Tax 50.50 + Round off
  // −0.50 = 1050 beside a Gross of 1060. So this one ADDS the default-visible
  // rungs, row by row, exactly as the grid, CSV, XLSX and PDF would lay them out.
  test("every row's default-visible Net and rungs add up to the Gross beside them — no rung hidden by default", async () => {
    const sales = await db.GetSalesSummaryReport(RID, W);
    const orders = await db.GetOrderSummaryReport(RID, { ...W, limit: 500 });
    const counter = await db.GetCounterSummaryReport(RID, W);
    const layouts: { report: string; columns: MisColumn[]; rows: Record<string, unknown>[] }[] = [
      { report: "sales_summary", columns: sales.columns, rows: [...sales.series, sales.totals] as unknown as Record<string, unknown>[] },
      { report: "order_summary", columns: orders.columns, rows: [...orders.rows, orders.totals] as unknown as Record<string, unknown>[] },
      { report: "counter_summary", columns: counter.columns, rows: [...counter.rows, counter.totals] as unknown as Record<string, unknown>[] },
    ];
    for (const { report, columns, rows } of layouts) {
      const at = (k: string): number => columns.findIndex((c) => c.key === k);
      // The ladder as declared: Net, then everything up to (not including) Gross.
      const ladder = columns.slice(at("net"), at("grand_total"));
      expect(ladder.map((c) => c.key)).toEqual(["net", "service_charge", "tax", "round_off"]);
      for (const c of [...ladder, columns[at("grand_total")]]) {
        expect(`${report}:${c?.key ?? "?"}:${String(c?.default_on)}`).not.toBe(`${report}:${c?.key ?? "?"}:false`);
      }
      const shown = ladder.filter((c) => c.default_on !== false);
      expect(rows.length).toBeGreaterThan(1);
      for (const row of rows) {
        const visible = sum(shown.map((c) => Number(row[c.key])));
        expect(`${report}:${visible}`).toBe(`${report}:${Number(row.grand_total)}`);
      }
    }
    // The bill the old default layout could not add up.
    const g2 = orders.rows.find((r) => r.bill_no === "5002");
    expect(g2?.service_charge).toBe(SERVICE_CHARGE);
    expect(g2?.grand_total).toBe(1060);
  });

  test("THE ROUND-OFF PARTITION: Σ Order rows === Σ Counter rows === the Sales Summary's round off", async () => {
    const sales = await db.GetSalesSummaryReport(RID, W);
    const orders = await db.GetOrderSummaryReport(RID, { ...W, limit: 500 });
    const counter = await db.GetCounterSummaryReport(RID, W);
    expect(sum(orders.rows.map((r) => r.round_off))).toBe(ROUND_OFF);
    expect(sum(counter.rows.map((r) => r.round_off))).toBe(ROUND_OFF);
    expect(sales.totals.round_off).toBe(ROUND_OFF);
    expect(counter.totals.round_off).toBe(ROUND_OFF);
    expect(orders.totals.round_off).toBe(ROUND_OFF);
  });

  test("every Order and Counter row closes on its own Gross, and its Item total is its Net plus its discount", async () => {
    const orders = await db.GetOrderSummaryReport(RID, { ...W, limit: 500 });
    const counter = await db.GetCounterSummaryReport(RID, W);
    for (const r of [...orders.rows, ...counter.rows]) {
      expect(r2(r.net + r.service_charge + r.tax + r.round_off)).toBe(r.grand_total);
      expect(r2(r.item_total - r.discount)).toBe(r.net);
      expect(r.gross).toBe(r.item_total);
    }
    expect(orders.rows.find((r) => r.bill_no === "5001")?.round_off).toBe(-0.26);
    expect(sum(orders.rows.map((r) => r.item_total))).toBe(ITEM_TOTAL);
    expect(sum(counter.rows.map((r) => r.item_total))).toBe(ITEM_TOTAL);
  });

  test("the Overview's gross sale is the Sales Summary's Gross, and its net sale the Sales Summary's Net", async () => {
    const today = db.dayKeyOf(new Date(), "Asia/Kolkata");
    const base = tenant();
    useFixtureDb({
      ...base,
      bills: base.bills.map((b, i) => ({ ...b, settled_at: `${today}T0${String(4 + i)}:30:00.000Z` })),
      orders: base.orders.map((o, i) => ({ ...o, created_at: `${today}T0${String(4 + i)}:00:00.000Z` })),
    });
    const head = await db.GetOverviewHeadline(RID);
    const sales = await db.GetSalesSummaryReport(RID, { from: today, to: today });
    expect(head.today_gross.value).toBe(GROSS);
    expect(head.today_gross.value).toBe(sales.totals.grand_total);
    expect(head.today_net.value).toBe(sales.totals.net);
    expect(head.today_gross.hint).toMatch(/service charge, tax and round off/);
  });
});

// --- 3. ACCOUNTING SAYS THE SAME ----------------------------------------------

describe("the accounting Sales report agrees with the MIS words", () => {
  test("total_sales is the MIS Gross and total_net the MIS Net, over the same days", async () => {
    const mis = await db.GetSalesSummaryReport(RID, W);
    const sales = await db.GetSalesReport(RID, W.from, W.to);
    expect(sales.bill_count).toBe(mis.totals.bills);
    expect(sales.total_sales).toBe(mis.totals.grand_total);
    expect(sales.total_net).toBe(mis.totals.net);
    expect(sales.total_net).toBe(NET);
    expect(sales.total_round_off).toBe(mis.totals.round_off);
    expect(sum(sales.by_day.map((d) => d.net))).toBe(sales.total_net);
    // The old tax-inclusive after-refunds figure keeps its key AND its value.
    expect(sales.net_sales).toBe(r2(sales.total_sales - sales.total_refund));
    expect(sales.net_sales).not.toBe(sales.total_net);
  });

  test("the sales CSV names the grand total Gross sales and appends Net sales as the last column", async () => {
    const sales = await db.GetSalesReport(RID, W.from, W.to);
    const lines = renderSalesCsv(sales).split("\n");
    const header = lines[0]?.split(",") ?? [];
    const total = lines[lines.length - 1]?.split(",") ?? [];
    expect(Number(total[header.indexOf("Gross sales")])).toBe(GROSS);
    expect(Number(total[header.length - 1])).toBe(NET);
    expect(header[header.length - 1]).toBe("Net sales");
  });
});
