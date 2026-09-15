// "ROUND OFF THE FINAL AMOUNT ALWAYS IN FINAL BILL" — THE READERS, DRIVEN
// (migration 048).
//
// bill_round_off_wiring.test.ts pins that every reader SELECTS round_off and
// that every closedBillCharges call has four arguments. Neither catches the
// reader that selects the column and then passes the WRONG round-off — a literal
// 0, or the stored column where the live figure belongs. Review proved it: five
// such mutations survived every related suite, because a four-argument call
// with a 0 in it satisfies both guards.
//
// What the wrong round-off costs is always the same shape. Everything above a
// settled total is recovered by SUBTRACTION, so a missing -0.26 lands in the
// food base: Gaia's 4745 reads back as 4744.74, and APC, pre-tax spend, the
// simulator's revenue baseline and a reconstructed percentage discount all move
// with it. Silently, by paise — which is exactly why it is pinned here with the
// client's own receipt rather than trusted.
//
// Each reader below runs as shipped over a stubbed pg that answers round_off
// ONLY when the statement names it, the way Postgres would. One fixture, the
// client's receipt: 4745 of food + SGST 118.63 + CGST 118.63 = 4982.26, settled
// as 4982.00 with a round off of -0.26.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";

const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";
const T_LIVE = "33333333-3333-4333-8333-333333333331";
const T_SNAP = "33333333-3333-4333-8333-333333333332";
const EMP = "44444444-4444-4444-8444-444444444444";
const CUST = "66666666-6666-4666-8666-666666666666";

const TAX = { SGST: 2.5, CGST: 2.5 };
const LINES = [
  { name: "SGST", percentage: 2.5, amount: 118.63 },
  { name: "CGST", percentage: 2.5, amount: 118.63 },
];
const FOOD = 4745;
const GRAND = 4982;
const ROUND_OFF = -0.26;

const fx: { sql: string[]; settledAt: Date } = { sql: [], settledAt: new Date() };

/** The column, answered only when the statement names it — as Postgres would. */
const roundOffIfSelected = (q: string, value: number | null): Record<string, string | null> =>
  /\bround_off\b/.test(q) ? { round_off: value === null ? null : value.toFixed(2) } : {};

jest.mock("pg", () => {
  const query = async (sql: string): Promise<{ rows: unknown[] }> => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    fx.sql.push(q);
    if (/from "Restaurant" r/i.test(q)) {
      return { rows: [{
        res_id: RES, outlet_id: OUTLET, restaurant_slug: "gaia", restaurant_name: "Gaia",
        restaurant_main_office_add: null, restaurant_logo_url: null, timezone: "Asia/Kolkata",
      }] };
    }
    // Gaia charges no restaurant_percent service charge; the ladder is food + GST.
    if (/^select service_charge from "Restaurant"/i.test(q)) { return { rows: [{ service_charge: 0 }] }; }
    if (/^select now\(\) as now/i.test(q)) { return { rows: [{ now: new Date() }] }; }

    // --- ListOpenBills -------------------------------------------------------
    if (/^select b\.id, b\.bill_no, b\.status, b\.outlet_id/i.test(q)) {
      const base = {
        status: 1, outlet_id: OUTLET, table_is_virtual: false,
        discount_type: null, discount_value: 0, coupon_code: null, payment_method: null,
        admin_approved_at: null, created_at: new Date(), age_secs: 600,
        opened_by_fname: "Jim", opened_by_lname: "",
      };
      return { rows: [
        // Still re-priced from its orders: the stored total is the pre-tax running
        // sum and its round_off column is NULL (every re-sync clears it). The
        // round-off that belongs to it is the LIVE computation's.
        { ...base, id: "B-LIVE", bill_no: "1", table_id: T_LIVE, table_name: "T1", total_amt: FOOD, tax_breakdown: [],
          ...roundOffIfSelected(q, null), waiter_confirmed_at: null },
        // Snapshotted by the payment workflow: total, taxes and round-off written together.
        { ...base, id: "B-SNAP", bill_no: "2", table_id: T_SNAP, table_name: "T2", total_amt: GRAND.toFixed(2), tax_breakdown: LINES,
          ...roundOffIfSelected(q, ROUND_OFF), waiter_confirmed_at: new Date() },
      ] };
    }
    if (/^select table_id, food, status, created_at from "Orders"/i.test(q)) {
      return { rows: [{ table_id: T_LIVE, food: { subtotal: FOOD, total: FOOD }, status: "1", created_at: new Date() }] };
    }
    if (/^select distinct on \(table_id\) table_id, covers from "TableSessions"/i.test(q)) {
      return { rows: [{ table_id: T_LIVE, covers: 2 }, { table_id: T_SNAP, covers: 2 }] };
    }
    if (/^select id, default_tax from "Outlets"/i.test(q)) { return { rows: [{ id: OUTLET, default_tax: TAX }] }; }

    // --- GetDiscountsReport ----------------------------------------------------
    if (/^select total_amt, tax_breakdown,.* discount_type, discount_value, coupon_code from "Bills"/i.test(q)) {
      return { rows: [{
        total_amt: GRAND.toFixed(2), tax_breakdown: LINES, ...roundOffIfSelected(q, ROUND_OFF),
        // A raw percentage: the money it took off was never stored, so the report
        // reconstructs it from the settled total.
        discount_type: "percent", discount_value: "10", coupon_code: null,
      }] };
    }

    // --- GetStaffPerformance ---------------------------------------------------
    if (/^select id, "emp_Fname" as fname, "emp_Lname" as lname, emp_roles from "Employees"/i.test(q)) {
      return { rows: [{ id: EMP, fname: "Asha", lname: "Rao", emp_roles: { primary: "waiter" } }] };
    }
    if (/^select b\.emp_id, b\.total_amt::text, b\.tax_breakdown/i.test(q)) {
      return { rows: [{
        emp_id: EMP, total_amt: GRAND.toFixed(2), tax_breakdown: LINES, ...roundOffIfSelected(q, ROUND_OFF),
        session_id: "S1", covers: "2",
      }] };
    }

    // --- GetSimulationRawStats -------------------------------------------------
    if (/^select b\.total_amt, b\.tax_breakdown,.* coalesce\(s\.covers, 1\)::int as covers/i.test(q)) {
      return { rows: [{ total_amt: GRAND.toFixed(2), tax_breakdown: LINES, ...roundOffIfSelected(q, ROUND_OFF), covers: 2 }] };
    }

    // --- GetCustomerSegments ---------------------------------------------------
    if (/^select id, "cust_Fname" as fname/i.test(q)) {
      return { rows: [{ id: CUST, fname: "Meera", lname: "Iyer", phone: "9876500001", email: null }] };
    }
    if (/^select i\.ident, i\.table_id::text as table_id/i.test(q)) {
      return { rows: [{
        ident: `c:${CUST}`, table_id: T_SNAP, bill_created_at: fx.settledAt, seated_at: fx.settledAt,
        settled_at: fx.settledAt, total_amt: GRAND.toFixed(2), tax_breakdown: LINES, ...roundOffIfSelected(q, ROUND_OFF),
      }] };
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

jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: jest.fn(), emitOutlet: jest.fn() }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: jest.fn() }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

let db: typeof import("../database_supabase");

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
});

beforeEach(() => {
  fx.sql = [];
  // An hour ago: inside every reader's window, whatever day the suite runs.
  fx.settledAt = new Date(Date.now() - 60 * 60 * 1000);
  db.__poolHygieneTestSeam.resetDdlMemo();
});

describe("the open-bill list takes the round-off from whichever total it used", () => {
  test("a LIVE bill uses the live computation's round-off, not the stored column (NULL on a running bill)", async () => {
    const page = await db.ListOpenBills(RES);
    const live = page.bills.find((b) => b.id === "B-LIVE")!;
    expect(live.totals_snapshotted).toBe(false);
    expect(live.grand_total).toBe(GRAND);
    expect(live.round_off).toBe(ROUND_OFF);
    // Reading the NULL column here gives 4744.74: every running bill's base
    // shifted by its own round-off.
    expect(live.taxable_base).toBe(FOOD);
    expect(live.apc).toBe(2372.5);
  });

  test("a SNAPSHOTTED bill uses the round-off the workflow wrote beside its total", async () => {
    const page = await db.ListOpenBills(RES);
    const snap = page.bills.find((b) => b.id === "B-SNAP")!;
    expect(snap.totals_snapshotted).toBe(true);
    expect(snap.grand_total).toBe(GRAND);
    expect(snap.round_off).toBe(ROUND_OFF);
    expect(snap.taxable_base).toBe(FOOD);
    expect(snap.apc).toBe(2372.5);
  });

  test("both bills' ladders close to the paisa: base + service + tax + round off = total", async () => {
    const page = await db.ListOpenBills(RES);
    for (const b of page.bills) {
      const p = (n: number): number => Math.round(n * 100);
      expect(p(b.taxable_base) + p(b.service_charge) + p(b.tax_total) + p(b.round_off)).toBe(p(b.grand_total));
    }
  });
});

describe("settled-bill readers subtract the recorded round-off before they reach the base", () => {
  test("GetDiscountsReport reconstructs a percentage discount from the base, not the base plus the paise", async () => {
    const report = await db.GetDiscountsReport(RES);
    expect(report.estimated_bills).toBe(1);
    // discounted base 4745 at 10% off: 4745 x 10 / 90 = 527.22. With the
    // round-off left in, (4982 - 237.26) x 10 / 90 = 527.19.
    expect(report.total_discount).toBe(527.22);
    expect(report.manual_discount).toBe(527.22);
    expect(report.total_sales).toBe(GRAND);
    // The notes never call these totals "net of discount": Net is the defined
    // word for item total less discount (client item 1), and total_sales is Gross.
    expect(report.notes.join(" ")).not.toMatch(/\bnet of\b/i);
    expect(report.notes[0]).toMatch(/stored after discount/);
  });

  test("GetStaffPerformance: APC is pre-tax food per cover — 4745 / 2, for the waiter and the house", async () => {
    const perf = await db.GetStaffPerformance(RES, 30);
    expect(perf.benchmarks.apc).toBe(2372.5);
    const row = perf.rows.find((r) => r.employee_id === EMP)!;
    expect(row.components.apc.value).toBe(2372.5);
  });

  test("GetSimulationRawStats: the what-if baseline's revenue is the food, not the food less the paise", async () => {
    const stats = await db.GetSimulationRawStats(RES);
    expect(stats.bill_count).toBe(1);
    expect(stats.pretax_revenue_total).toBe(FOOD);
    expect(stats.covers_total).toBe(2);
  });

  test("GetCustomerSegments: a guest's pre-tax spend is what they ate; their total spend is what they paid", async () => {
    const page = await db.GetCustomerSegments(RES, { days: 30 });
    const guest = page.customers.find((c) => c.customer_id === CUST)!;
    expect(guest.bills).toBe(1);
    expect(guest.total_spend).toBe(GRAND);
    expect(guest.total_tax).toBe(237.26);
    expect(guest.pre_tax_spend).toBe(FOOD);
  });
});
