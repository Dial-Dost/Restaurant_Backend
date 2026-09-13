// 6.4 — "Prominently display the gross sales specifically for currently running
// tables."
//
// ============================================================================
// WHAT WENT WRONG
// ============================================================================
// The live-gross box (web dashboard, above the tables) read GET /bills/open's
// `total` and `outstanding_total`, and both are counted over "Bills" rows. A
// table has no bill row until somebody generates one — so with T1–T3 eating off
// sent KOTs and nobody billed yet, the box said "₹0 · No tables are running".
// That is the single most consequential thing it could wrongly say.
//
// ============================================================================
// WHAT THIS SUITE PINS, driving the SHIPPED ListOpenBills over a fake Pool
// ============================================================================
//   1. A table with still-owing orders and NO bill is running, priced by the
//      same ladder the bill uses (subtotal → service charge → tax on both).
//   2. A table WITH an open bill keeps the bill's own figure (discount and all),
//      and its orders are not counted a second time.
//   3. Cancelled/paid/closed orders do not make a table run.
//   4. A takeaway/delivery bill (virtual table) is an open bill but not a
//      running TABLE, and `total`/`outstanding_total` keep meaning open bills.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { computeBillCharges } from "../billing_math";

const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";
const T1 = "33333333-3333-3333-3333-333333333331";
const T2 = "33333333-3333-3333-3333-333333333332";
const T3 = "33333333-3333-3333-3333-333333333333";
const TK = "33333333-3333-3333-3333-33333333333a"; // a takeaway's hidden table

const TAX = { CGST: 2.5, SGST: 2.5 };
const SC_PCT = 10;
const AT = "2026-09-11T12:00:00.000Z";

interface BillFx {
  id: string; table_id: string; table_name: string; virtual: boolean;
  total_amt: number; discount_type: string | null; discount_value: number;
  confirmed: boolean;
}
interface OrderFx { table_id: string; food: unknown; status: string }

const fx: { bills: BillFx[]; orders: OrderFx[]; sql: { q: string; params: unknown[] }[] } = { bills: [], orders: [], sql: [] };

jest.mock("pg", () => {
  const query = async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    fx.sql.push({ q, params });
    if (/from "Restaurant" r/i.test(q)) {
      return { rows: [{
        res_id: RES, outlet_id: OUTLET, restaurant_slug: "gaia", restaurant_name: "Gaia",
        restaurant_main_office_add: null, restaurant_logo_url: null, timezone: null,
      }] };
    }
    if (/select service_charge from "Restaurant"/i.test(q)) { return { rows: [{ service_charge: SC_PCT }] }; }
    if (/select id, default_tax from "Outlets"/i.test(q)) { return { rows: [{ id: OUTLET, default_tax: TAX }] }; }
    if (/from "Bills" b/i.test(q)) {
      return { rows: fx.bills.map((b) => ({
        id: b.id, bill_no: b.id, status: 1, outlet_id: OUTLET, table_id: b.table_id, table_name: b.table_name,
        table_is_virtual: b.virtual, total_amt: b.total_amt, tax_breakdown: [],
        discount_type: b.discount_type, discount_value: b.discount_value, coupon_code: null,
        payment_method: null, waiter_confirmed_at: b.confirmed ? new Date(AT) : null, admin_approved_at: null,
        created_at: new Date(AT), age_secs: 600, opened_by_fname: null, opened_by_lname: null,
      })) };
    }
    // The open bills' own orders — filtered by the table list, as the SQL is.
    if (/^select table_id, food, status, created_at from "Orders"/i.test(q)) {
      const ids = (params[1] as string[]) ?? [];
      return { rows: fx.orders.filter((o) => ids.includes(o.table_id)).map((o) => ({ ...o, created_at: new Date(AT) })) };
    }
    // 6.4's unbilled read. Deliberately does NOT apply the `not (table_id = any($3))`
    // exclusion: the TypeScript must not double-count a billed table even if the
    // SQL ever stops excluding it.
    if (/^select o\.table_id, o\.outlet_id, o\.food, o\.status/i.test(q)) {
      return { rows: fx.orders.map((o) => ({ ...o, outlet_id: OUTLET })) };
    }
    return { rows: [] };
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> { return query(sql, params); }
    connect(): Promise<unknown> { return Promise.resolve({ query, release: () => undefined }); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

let db: typeof import("../database_supabase");

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
});

beforeEach(() => {
  fx.bills = [];
  fx.orders = [];
  fx.sql = [];
});

/** What the bill screen would charge for this pre-tax subtotal — billing_math, not a copy. */
const gross = (subtotal: number, discount: { type: "flat" | "percent"; value: number } | null = null): number =>
  computeBillCharges(subtotal, TAX, SC_PCT, true, discount).grand_total;

describe("6.4 — running tables are tables with orders, not tables with bills", () => {
  test("THE REPORTED BUG: sent KOTs, no bill generated yet — the tables ARE running", async () => {
    fx.orders = [
      { table_id: T1, food: { subtotal: 1000, total: 1000 }, status: "1" },
      { table_id: T1, food: { subtotal: 500, total: 500 }, status: "2" },
      { table_id: T2, food: { subtotal: 800, total: 800 }, status: "1" },
      { table_id: T3, food: { subtotal: 300, total: 300 }, status: "3" },
    ];
    const page = await db.ListOpenBills(RES, { limit: 1 });
    // No bill rows, so the open-BILL figures stay exactly what they were…
    expect(page.total).toBe(0);
    expect(page.outstanding_total).toBe(0);
    // …and the floor is no longer reported empty.
    expect(page.running_tables).toBe(3);
    expect(page.running_total).toBe(Number((gross(1500) + gross(800) + gross(300)).toFixed(2)));
    // Money rules, spelled out once: 1500 → SC 150 → tax 5% of 1650 = 82.50.
    expect(gross(1500)).toBe(1732.5);
  });

  test("a table WITH an open bill keeps the bill's figure — discount included — and is counted once", async () => {
    fx.bills = [{ id: "B-2", table_id: T2, table_name: "T2", virtual: false, total_amt: 2000, discount_type: "flat", discount_value: 200, confirmed: false }];
    fx.orders = [
      { table_id: T2, food: { subtotal: 2000, total: 2000 }, status: "1" },
      { table_id: T1, food: { subtotal: 1500, total: 1500 }, status: "1" },
    ];
    const page = await db.ListOpenBills(RES, { limit: 1 });
    const billGross = gross(2000, { type: "flat", value: 200 });
    expect(page.outstanding_total).toBe(billGross);
    expect(page.running_tables).toBe(2);
    // T2 from its bill (NOT re-priced without the discount, NOT added twice), T1 live.
    expect(page.running_total).toBe(Number((billGross + gross(1500)).toFixed(2)));
    // …and the SQL is told which tables are already billed.
    const unbilled = fx.sql.find((s) => /^select o\.table_id, o\.outlet_id/i.test(s.q));
    expect(unbilled?.params[2]).toEqual([T2]);
  });

  test("a snapshotted bill's charged total is what counts, not a re-price of its orders", async () => {
    fx.bills = [{ id: "B-1", table_id: T1, table_name: "T1", virtual: false, total_amt: 1234.5, discount_type: null, discount_value: 0, confirmed: true }];
    fx.orders = [{ table_id: T1, food: { subtotal: 5000, total: 5000 }, status: "6" }];
    const page = await db.ListOpenBills(RES, { limit: 1 });
    expect(page.running_tables).toBe(1);
    expect(page.running_total).toBe(1234.5);
  });

  test("cancelled, paid and closed orders do not make a table run", async () => {
    fx.orders = [
      { table_id: T1, food: { subtotal: 900, total: 900 }, status: "5" },
      { table_id: T2, food: { subtotal: 900, total: 900 }, status: "4" },
      { table_id: T3, food: { subtotal: 900, total: 900 }, status: "7" },
    ];
    const page = await db.ListOpenBills(RES, { limit: 1 });
    expect(page.running_tables).toBe(0);
    expect(page.running_total).toBe(0);
    // …and the SQL asks for still-owing orders on real tables only.
    const unbilled = fx.sql.find((s) => /^select o\.table_id, o\.outlet_id/i.test(s.q));
    expect(unbilled?.q).toMatch(/not in \('4','5','7'\)/);
    expect(unbilled?.q).toMatch(/is_virtual/);
  });

  test("a takeaway bill is an open BILL but not a running TABLE", async () => {
    fx.bills = [{ id: "B-K", table_id: TK, table_name: "Takeaway-1", virtual: true, total_amt: 525, discount_type: null, discount_value: 0, confirmed: true }];
    const page = await db.ListOpenBills(RES, { limit: 1 });
    expect(page.total).toBe(1);
    expect(page.outstanding_total).toBe(525);
    expect(page.running_tables).toBe(0);
    expect(page.running_total).toBe(0);
  });

  test("a table whose orders are all comped is still running, at zero", async () => {
    fx.orders = [{ table_id: T1, food: { subtotal: 0, total: 0 }, status: "1" }];
    const page = await db.ListOpenBills(RES, { limit: 1 });
    expect(page.running_tables).toBe(1);
    expect(page.running_total).toBe(0);
  });
});
