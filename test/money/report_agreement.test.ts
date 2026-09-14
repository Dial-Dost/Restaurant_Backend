// AGREEMENT ACROSS READERS — the assertion that was missing.
//
// The bill-detail path (ListClosedBills → mapClosedBillSummary → closedBillCharges
// → splitServiceChargeLine) classified a stored "Service Charge" tax_breakdown
// line correctly. The report readers (GetSalesReport / GetGstReport /
// GetProfitAndLoss / BuildTallyXml) summed every breakdown line blindly, so the
// owner's own service-charge income was reported as GST owed to the government —
// 31,733.92 of it — and nothing asserted that the two views of the SAME bills
// agreed. These tests run both views over one in-memory bill set and require
// them to produce the same money.
//
// The readers are the real, shipped functions; only `pg` is faked (see
// bill_fixtures.ts for why a fixture rather than a live DB).

import { describe, test, expect, beforeAll, jest } from "@jest/globals";
import {
  makeDb,
  useFixtureDb,
  type FixtureBill,
  type FixtureDb,
} from "./bill_fixtures";

jest.mock("pg", () => {
  interface FixtureGlobal {
    __moneyFixtureQuery?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  }
  class FakePool {
    on(): this {
      return this;
    }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
      const run = (globalThis as unknown as FixtureGlobal).__moneyFixtureQuery;
      if (!run) {throw new Error("money fixture harness was not loaded");}
      return run(sql, params);
    }
    connect(): Promise<never> {
      // No reader under test opens a transaction; if one starts to, fail loudly.
      return Promise.reject(new Error("money fixture: pool.connect() is not stubbed"));
    }
    end(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

type Readers = typeof import("../../database_supabase");
let db: Readers;

const RID = "zztest-money";
const FROM = "2026-06-01";
const TO = "2026-06-30";

const r2 = (n: number) => Number(n.toFixed(2));
const sum = (xs: number[]) => r2(xs.reduce((s, x) => s + x, 0));

beforeAll(async () => {
  // A connection string is required at import time; the pool is faked, so the
  // value is never dialled.
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../../database_supabase");
});

// --- the fixture bill set ----------------------------------------------------
// Three settled bills, 1000 / 2400 / 500 of food, SGST 2.5 + CGST 2.5 + a 1%
// service charge — i.e. exactly what migrations/000_base_schema.sql seeds into
// Outlets.default_tax.
//
//   food base    3900
//   genuine tax   195   (SGST 97.50 + CGST 97.50)
//   service chg    39
//   grand total  4134
//
// Blindly summing tax_breakdown gives 234 of "tax" — 39 too much. That gap is
// the bug, scaled down.
const BASE = 3900;
const GENUINE_TAX = 195;
const SERVICE_CHARGE = 39;
const GRAND = 4134;
const BLIND_TAX_SUM = 234;

const scLine = (amount: number) => ({ name: "Service Charge", percentage: 1, amount });
const gstLines = (each: number) => [
  { name: "SGST", percentage: 2.5, amount: each },
  { name: "CGST", percentage: 2.5, amount: each },
];

/** Shape (b): the service charge is a stored tax_breakdown line. */
const BILLS_SHAPE_B: FixtureBill[] = [
  {
    id: "b1", bill_no: "1", settled_at: "2026-06-15T08:00:00Z", total_amt: 1060,
    tax_breakdown: [...gstLines(25), scLine(10)], payment_method: "Cash", covers: 2,
  },
  {
    id: "b2", bill_no: "2", settled_at: "2026-06-15T14:00:00Z", total_amt: 2544,
    tax_breakdown: [...gstLines(60), scLine(24)], payment_method: "Card", covers: 4,
  },
  {
    // 19:00Z = 00:30 the NEXT day in Asia/Kolkata, so this bill must bucket into
    // 2026-06-16 — day bucketing and money separation are tested together.
    id: "b3", bill_no: "3", settled_at: "2026-06-15T19:00:00Z", total_amt: 530,
    tax_breakdown: [...gstLines(12.5), scLine(5)], payment_method: "UPI", covers: 2,
  },
];

/**
 * Shape (a): the SAME money, stored the other way — Restaurant.service_charge is
 * 1%, so the charge is folded into the amount the taxes were computed on and is
 * absent from tax_breakdown. Every stored grand total is identical to shape (b).
 */
const BILLS_SHAPE_A: FixtureBill[] = BILLS_SHAPE_B.map((b) => ({
  ...b,
  tax_breakdown: b.tax_breakdown.filter((l) => !/service\s*charge/i.test(l.name)),
}));

const shapeB = (): FixtureDb => makeDb({ bills: BILLS_SHAPE_B, service_charge_percent: 0 });
const shapeA = (): FixtureDb => makeDb({ bills: BILLS_SHAPE_A, service_charge_percent: 1 });

// --- 1. the core invariant, per bill, through the shipped detail reader -------

describe("core invariant, per bill (bill-detail reader)", () => {
  test.each([["default_tax line (shape b)", shapeB], ["Restaurant.service_charge (shape a)", shapeA]] as const)(
    "%s: taxable_base + service_charge + tax_total === grand_total",
    async (_label, makeFixture) => {
      useFixtureDb(makeFixture());
      const page = await db.ListClosedBills(RID, { limit: 200 });
      expect(page.bills).toHaveLength(3);
      for (const b of page.bills) {
        expect(r2(b.taxable_base + b.service_charge + b.tax_total)).toBe(b.grand_total);
        expect(b.service_charge).toBeGreaterThan(0);
      }
      expect(sum(page.bills.map((b) => b.grand_total))).toBe(GRAND);
      expect(sum(page.bills.map((b) => b.tax_total))).toBe(GENUINE_TAX);
      expect(sum(page.bills.map((b) => b.service_charge))).toBe(SERVICE_CHARGE);
      expect(sum(page.bills.map((b) => b.taxable_base))).toBe(BASE);
    },
  );
});

// --- 2. agreement across readers ---------------------------------------------

describe("every reader agrees with the bill-detail reader", () => {
  test("GetSalesReport", async () => {
    useFixtureDb(shapeB());
    const detail = await db.ListClosedBills(RID, { limit: 200 });
    useFixtureDb(shapeB());
    const sales = await db.GetSalesReport(RID, FROM, TO);

    expect(sales.total_sales).toBe(sum(detail.bills.map((b) => b.grand_total)));
    expect(sales.total_tax).toBe(sum(detail.bills.map((b) => b.tax_total)));
    expect(sales.total_service_charge).toBe(sum(detail.bills.map((b) => b.service_charge)));

    // GST must be GENUINE TAX ONLY — the exact regression.
    expect(sales.total_tax).toBe(GENUINE_TAX);
    expect(sales.total_tax).not.toBe(BLIND_TAX_SUM);
    expect(sales.total_service_charge).toBe(SERVICE_CHARGE);
    // and the two must not have merged into one another.
    expect(r2(sales.total_tax + sales.total_service_charge)).toBe(BLIND_TAX_SUM);
  });

  test("GetGstReport — no by_rate row is a service charge", async () => {
    useFixtureDb(shapeB());
    const gst = await db.GetGstReport(RID, FROM, TO);

    expect(gst.total_tax).toBe(GENUINE_TAX);
    expect(gst.total_service_charge).toBe(SERVICE_CHARGE);
    // Turnover ex-tax = food + service charge; the charge is income, so it stays
    // inside taxable turnover rather than being netted off as tax.
    expect(gst.total_taxable).toBe(r2(BASE + SERVICE_CHARGE));

    for (const row of gst.by_rate) {
      expect(row.name).not.toMatch(/service\s*charge/i);
    }
    expect(sum(gst.by_rate.map((r) => r.tax))).toBe(GENUINE_TAX);
    // Each rate's reconstructed taxable amount must be the food base.
    for (const row of gst.by_rate) {
      expect(r2(row.taxable)).toBe(BASE);
    }
  });

  test("GetProfitAndLoss — service charge is income, tax is pass-through", async () => {
    useFixtureDb(shapeB());
    const pnl = await db.GetProfitAndLoss(RID, FROM, TO);

    expect(pnl.gross_sales).toBe(GRAND);
    expect(pnl.tax_collected).toBe(GENUINE_TAX);
    expect(pnl.service_charge).toBe(SERVICE_CHARGE);
    // Net revenue keeps the service charge and drops only genuine tax.
    expect(pnl.net_revenue).toBe(r2(BASE + SERVICE_CHARGE));
    // If the charge were counted as tax, net revenue would be BASE (3900) and the
    // owner would be told to remit 234 instead of 195.
    expect(pnl.net_revenue).not.toBe(BASE);
    expect(pnl.tax_collected).not.toBe(BLIND_TAX_SUM);
  });

  test("BuildTallyXml — Output Tax carries genuine tax only", async () => {
    useFixtureDb(shapeB());
    const xml = await db.BuildTallyXml(RID, FROM, TO);
    const ledgers = tallyLedgerTotals(xml);

    expect(ledgers["Output Tax"]).toBe(GENUINE_TAX);
    expect(ledgers["Service Charge Income"]).toBe(SERVICE_CHARGE);
    expect(ledgers["Sales Account"]).toBe(BASE);
    expect(ledgers["Sales Receipts"]).toBe(-GRAND); // debit, stored negative
    expect(ledgers["Output Tax"]).not.toBe(BLIND_TAX_SUM);

    // Double entry: every voucher must net to zero, or Tally rejects the import.
    for (const voucher of xml.split("<TALLYMESSAGE").slice(1)) {
      expect(r2(Object.values(tallyLedgerTotals(voucher)).reduce((s, v) => s + v, 0))).toBe(0);
    }
  });

  test("day buckets sum back to the report totals", async () => {
    useFixtureDb(shapeB());
    const sales = await db.GetSalesReport(RID, FROM, TO);

    // 19:00Z belongs to the tenant's NEXT day (Asia/Kolkata).
    expect(sales.by_day.map((d) => d.date)).toEqual(["2026-06-15", "2026-06-16"]);
    expect(sum(sales.by_day.map((d) => d.sales))).toBe(sales.total_sales);
    expect(sum(sales.by_day.map((d) => d.tax))).toBe(sales.total_tax);
    expect(sum(sales.by_day.map((d) => d.service_charge))).toBe(sales.total_service_charge);
    expect(sum(sales.by_method.map((m) => m.sales))).toBe(sales.total_sales);
  });
});

// --- 3. both service-charge shapes produce the same separated result ---------

describe("both service-charge shapes separate identically", () => {
  test("shape (a) and shape (b) report the same money", async () => {
    useFixtureDb(shapeB());
    const salesB = await db.GetSalesReport(RID, FROM, TO);
    useFixtureDb(shapeB());
    const gstB = await db.GetGstReport(RID, FROM, TO);

    useFixtureDb(shapeA());
    const salesA = await db.GetSalesReport(RID, FROM, TO);
    useFixtureDb(shapeA());
    const gstA = await db.GetGstReport(RID, FROM, TO);

    expect(salesA.total_sales).toBe(salesB.total_sales);
    expect(salesA.total_tax).toBe(salesB.total_tax);
    expect(salesA.total_service_charge).toBe(salesB.total_service_charge);
    expect(gstA.total_taxable).toBe(gstB.total_taxable);
    expect(gstA.total_tax).toBe(gstB.total_tax);
    expect(gstA.total_service_charge).toBe(gstB.total_service_charge);
  });

  test("a charge configured in BOTH places is counted once", async () => {
    // Shape (b) data with Restaurant.service_charge also set: the stored line
    // wins and must not be added a second time by the percent-unwind branch.
    useFixtureDb(makeDb({ bills: BILLS_SHAPE_B, service_charge_percent: 1 }));
    const sales = await db.GetSalesReport(RID, FROM, TO);
    expect(sales.total_service_charge).toBe(SERVICE_CHARGE);
    expect(sales.total_tax).toBe(GENUINE_TAX);
  });
});

// --- 4. refunds ---------------------------------------------------------------

describe("refunds", () => {
  const oneBill = (refund: number): FixtureDb =>
    makeDb({
      bills: [{
        id: "r1", bill_no: "9", settled_at: "2026-06-15T08:00:00Z", total_amt: 1060,
        tax_breakdown: [...gstLines(25), scLine(10)], payment_method: "Cash",
        refund_amount: refund, covers: 2,
      }],
      service_charge_percent: 0,
    });

  test("a fully refunded bill nets to 0, not to minus its own tax", async () => {
    useFixtureDb(oneBill(1060));
    const pnl = await db.GetProfitAndLoss(RID, FROM, TO);
    expect(pnl.net_revenue).toBe(0);
    expect(pnl.net_profit).toBe(0);
    expect(pnl.tax_collected).toBe(0);
    expect(pnl.net_revenue).not.toBe(-50); // the pre-fix behaviour: minus the tax
  });

  test("a partial refund is proportional", async () => {
    useFixtureDb(oneBill(530)); // exactly half the tax-inclusive total
    const sales = await db.GetSalesReport(RID, FROM, TO);
    useFixtureDb(oneBill(530));
    const pnl = await db.GetProfitAndLoss(RID, FROM, TO);

    expect(sales.total_refunded_tax).toBe(25); // half of the 50 genuine tax
    expect(pnl.tax_collected).toBe(25);
    // Half of the ex-tax revenue (food 1000 + service charge 10) survives.
    expect(pnl.net_revenue).toBe(r2((1060 - 50) / 2));
  });
});

// --- 5. a released-unpaid bill is not revenue --------------------------------

describe("released-unpaid bills", () => {
  test("contribute no sales, no tax and no service charge", async () => {
    // ReleaseTable closes the bill and ZEROES total_amt + tax_breakdown when it
    // was never admin-approved (nothing was collected), so the money readers see
    // a settled row worth nothing. Assert the whole reader stack agrees.
    const released: FixtureBill = {
      id: "rel", bill_no: "10", settled_at: "2026-06-15T10:00:00Z",
      total_amt: 0, tax_breakdown: [], closed_by_username: "released", covers: 3,
    };
    const paid = BILLS_SHAPE_B[0]; // 1060 grand, 50 tax, 10 service charge

    useFixtureDb(makeDb({ bills: [paid, released], service_charge_percent: 0 }));
    const sales = await db.GetSalesReport(RID, FROM, TO);
    useFixtureDb(makeDb({ bills: [paid, released], service_charge_percent: 0 }));
    const pnl = await db.GetProfitAndLoss(RID, FROM, TO);
    useFixtureDb(makeDb({ bills: [paid, released], service_charge_percent: 0 }));
    const xml = await db.BuildTallyXml(RID, FROM, TO);

    expect(sales.total_sales).toBe(1060);
    expect(sales.total_tax).toBe(50);
    expect(sales.total_service_charge).toBe(10);
    expect(pnl.net_revenue).toBe(1010);
    // One Sales voucher for the day — the released bill adds nothing to book.
    expect(tallyLedgerTotals(xml)["Sales Receipts"]).toBe(-1060);
  });

  test("a bill that never settled is invisible to every reader", async () => {
    const open: FixtureBill = {
      id: "open", bill_no: "11", settled_at: "2026-06-15T10:00:00Z", total_amt: 999,
      tax_breakdown: [...gstLines(20), scLine(8)], settled: false,
    };
    useFixtureDb(makeDb({ bills: [BILLS_SHAPE_B[0], open], service_charge_percent: 0 }));
    const sales = await db.GetSalesReport(RID, FROM, TO);
    expect(sales.bill_count).toBe(1);
    expect(sales.total_sales).toBe(1060);
  });
});

// --- 6. rounding --------------------------------------------------------------

describe("rounding", () => {
  // TOLERANCE: round2 can move any one figure by at most 0.005, so a total built
  // from N rounded per-bill figures may differ from the rounded exact sum by at
  // most N * 0.005. Below that is rounding; above it is an arithmetic bug. With
  // 60 bills the bound is 0.30 — three orders of magnitude tighter than the
  // service-charge gap these bills carry (0.6% of turnover), so the bound cannot
  // paper over the bug it exists to catch.
  test("per-bill figures re-sum to the report totals within N * 0.005", async () => {
    const bills: FixtureBill[] = [];
    for (let i = 0; i < 60; i++) {
      // Subtotals chosen to land taxes on a half-paisa as often as possible.
      const base = r2(101.11 + i * 33.33);
      const each = r2((base * 2.5) / 100);
      const sc = r2((base * 1) / 100);
      bills.push({
        id: `x${i}`, bill_no: String(i), settled_at: "2026-06-15T08:00:00Z",
        total_amt: r2(base + each * 2 + sc),
        tax_breakdown: [...gstLines(each), scLine(sc)],
        payment_method: "Cash",
      });
    }
    const tolerance = 0.005 * bills.length;

    useFixtureDb(makeDb({ bills, service_charge_percent: 0 }));
    const detail = await db.ListClosedBills(RID, { limit: 200 });
    useFixtureDb(makeDb({ bills, service_charge_percent: 0 }));
    const sales = await db.GetSalesReport(RID, FROM, TO);

    expect(Math.abs(sales.total_tax - sum(detail.bills.map((b) => b.tax_total)))).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(sales.total_service_charge - sum(detail.bills.map((b) => b.service_charge)))).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(sales.total_sales - sum(detail.bills.map((b) => b.grand_total)))).toBeLessThanOrEqual(tolerance);
    // The parts must still reconstruct the whole within the same bound.
    const rebuilt = sum([sales.total_tax, sales.total_service_charge, sum(detail.bills.map((b) => b.taxable_base))]);
    expect(Math.abs(rebuilt - sales.total_sales)).toBeLessThanOrEqual(tolerance);
  });
});

// --- 7. the settled-bills list cuts days where the reports cut them -----------

describe("ListClosedBills day bounds (restaurant zone)", () => {
  // Accounting shows the settled-bills list directly under Sales/GST/P&L for the
  // SAME picked days. The list used to cut those days at UTC midnight, the
  // reports at local midnight, so a bill settled just after midnight in Kolkata
  // was listed under the previous date while the totals above counted it under
  // the right one. Production had 11 of 78 such bills for one tenant in 90 days.
  //
  //   late   2026-08-01T19:00Z = 2 Aug 00:30 IST  (the UTC date is still the 1st)
  //   noon   2026-08-02T06:30Z = 2 Aug 12:00 IST
  //   edge   2026-08-02T18:30Z = 3 Aug 00:00 IST  (exactly the exclusive end)
  const late: FixtureBill = {
    id: "late", bill_no: "21", settled_at: "2026-08-01T19:00:00Z", total_amt: 1060,
    tax_breakdown: [...gstLines(25), scLine(10)], payment_method: "Cash", covers: 2,
  };
  const noon: FixtureBill = {
    id: "noon", bill_no: "22", settled_at: "2026-08-02T06:30:00Z", total_amt: 530,
    tax_breakdown: [...gstLines(12.5), scLine(5)], payment_method: "UPI", covers: 2,
  };
  const edge: FixtureBill = {
    id: "edge", bill_no: "23", settled_at: "2026-08-02T18:30:00Z", total_amt: 2544,
    tax_breakdown: [...gstLines(60), scLine(24)], payment_method: "Card", covers: 4,
  };
  const fixture = (): FixtureDb => makeDb({ bills: [late, noon, edge], service_charge_percent: 0 });
  const ids = (page: { bills: { id: string }[] }) => page.bills.map((b) => b.id).sort();

  test("a 00:30 IST bill is listed under its IST day, exactly as GetSalesReport counts it", async () => {
    useFixtureDb(fixture());
    const list = await db.ListClosedBills(RID, { from: "2026-08-02", to: "2026-08-02", limit: 200 });
    useFixtureDb(fixture());
    const sales = await db.GetSalesReport(RID, "2026-08-02", "2026-08-02");

    expect(ids(list)).toEqual(["late", "noon"]);
    expect(list.total).toBe(2);
    expect(list.total).toBe(sales.bill_count);
    expect(sum(list.bills.map((b) => b.grand_total))).toBe(sales.total_sales);
  });

  test("the previous day no longer claims it", async () => {
    useFixtureDb(fixture());
    const list = await db.ListClosedBills(RID, { from: "2026-08-01", to: "2026-08-01", limit: 200 });
    useFixtureDb(fixture());
    const sales = await db.GetSalesReport(RID, "2026-08-01", "2026-08-01");

    expect(ids(list)).toEqual([]);
    expect(list.total).toBe(sales.bill_count);
  });

  test("the end is exclusive at the next local midnight, and `to` stays inclusive of its own day", async () => {
    useFixtureDb(fixture());
    const third = await db.ListClosedBills(RID, { from: "2026-08-03", to: "2026-08-03", limit: 200 });
    useFixtureDb(fixture());
    const both = await db.ListClosedBills(RID, { from: "2026-08-02", to: "2026-08-03", limit: 200 });

    expect(ids(third)).toEqual(["edge"]);
    expect(ids(both)).toEqual(["edge", "late", "noon"]);
  });

  test("one open end is still no bound on the other side", async () => {
    useFixtureDb(fixture());
    const since = await db.ListClosedBills(RID, { from: "2026-08-02", limit: 200 });
    useFixtureDb(fixture());
    const until = await db.ListClosedBills(RID, { to: "2026-08-01", limit: 200 });

    expect(ids(since)).toEqual(["edge", "late", "noon"]);
    expect(ids(until)).toEqual([]);
  });

  test("a full ISO instant keeps its literal meaning (no zone shift, inclusive `to`)", async () => {
    useFixtureDb(fixture());
    const list = await db.ListClosedBills(RID, {
      from: "2026-08-01T19:00:00.000Z", to: "2026-08-02T18:30:00.000Z", limit: 200,
    });
    expect(ids(list)).toEqual(["edge", "late", "noon"]);
  });
});

/** Sum every Tally ledger entry by ledger name (debits are stored negative). */
function tallyLedgerTotals(xml: string): Record<string, number> {
  const re =
    /<ALLLEDGERENTRIES\.LIST><LEDGERNAME>([^<]*)<\/LEDGERNAME><ISDEEMEDPOSITIVE>(?:Yes|No)<\/ISDEEMEDPOSITIVE><AMOUNT>(-?[\d.]+)<\/AMOUNT><\/ALLLEDGERENTRIES\.LIST>/g;
  const out: Record<string, number> = {};
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const name = m[1];
    out[name] = r2((out[name] ?? 0) + Number(m[2]));
  }
  return out;
}
