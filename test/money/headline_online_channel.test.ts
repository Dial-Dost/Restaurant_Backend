// ONLINE MEANS THE BILL'S OWN ORDER — NOT ITS TABLE'S HISTORY.
//
// The Overview headline's two Online figures used to call a bill online when
// ANY order its table had ever had — with no window at all — was not a walk-in.
// One delivery ticket rung on a table would have turned every later dine-in
// bill on that table into online trade, on the till's home screen, forever.
// No live tenant has such an order today (verified read-only on 2026-09-17:
// 0 delivery or aggregator orders in 60 days), so nothing shipped has been
// wrong yet; this is the fix before it can be.
//
// The read now takes the order the bill was raised from — the rule the Sales
// Summary's order-type split states — so Online (gross) and its bills ARE that
// split's delivery + other rows for the day. The fixture models the old,
// table-wide read from the SQL text too, so a reader that slid back fails here
// on the numbers rather than on a shape check.
//
// Driven through the REAL readers over mis_fixtures.ts (only `pg` is faked).

import { describe, test, expect, beforeAll, jest } from "@jest/globals";
import { makeDb, useFixtureDb, type FixtureBill, type FixtureDb, type FixtureOrder } from "./mis_fixtures";

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

function paid(food: number): Pick<FixtureBill, "total_amt" | "tax_breakdown"> {
  const g = r2(food * 0.025);
  return {
    total_amt: r2(food + g + g),
    tax_breakdown: [{ name: "SGST", percentage: 2.5, amount: g }, { name: "CGST", percentage: 2.5, amount: g }],
  };
}

function order(id: string, at: string, over: Partial<FixtureOrder> = {}): FixtureOrder {
  return { id, created_at: at, status: 7, table_name: "T1", order_type: "dine_in", items: [], ...over };
}

function day(): { db: FixtureDb; today: string } {
  const today = db.dayKeyOf(new Date(), IST);
  const at = (min: number): string => new Date(new Date(`${today}T12:00:00+05:30`).getTime() + min * 60_000).toISOString();
  return {
    today,
    db: makeDb({
      timezone: IST,
      bills: [
        // Dine-in on T1, the table that took a delivery ticket last year.
        { id: "d1", bill_no: "7001", settled_at: at(0), ...paid(1000), round_off: 0, payment_method: "Cash", table_name: "T1", order_id: "o1" },
        // A real delivery bill.
        { id: "d2", bill_no: "7002", settled_at: at(5), ...paid(400), round_off: 0, payment_method: "Upi", table_name: "T2", order_id: "o2" },
        // A bill whose order row is gone: in neither the split nor Online.
        { id: "d3", bill_no: "7003", settled_at: at(10), ...paid(300), round_off: 0, payment_method: "Cash", table_name: "T2", order_id: "o-gone" },
        // A bill that names no order at all (ensureOpenBillIdForTable writes these).
        { id: "d4", bill_no: "7004", settled_at: at(15), ...paid(200), round_off: 0, payment_method: "Cash", table_name: "T2", order_id: null },
      ],
      orders: [
        order("ox", "2025-01-10T08:00:00.000Z", { order_type: "delivery", table_name: "T1" }),
        order("o1", at(-30), { table_name: "T1" }),
        order("o2", at(-30), { table_name: "T2", order_type: "delivery" }),
      ],
    }),
  };
}

describe("Online (gross) is the Sales Summary's delivery + other split for the day", () => {
  test("a table's old delivery ticket does not make today's dine-in bill online", async () => {
    const { db: fixture, today } = day();
    useFixtureDb(fixture);
    const head = await db.GetOverviewHeadline(RID);
    expect(head.today_bills).toBe(4);
    expect(head.online_gross.value).toBe(paid(400).total_amt);
    expect(head.online_net.value).toBe(400);
    const sales = await db.GetSalesSummaryReport(RID, { from: today, to: today });
    const online = sales.by_order_type.filter((r) => !WALK_IN.has(r.order_type));
    expect(sum(online.map((r) => r.grand_total))).toBe(head.online_gross.value);
    expect(online.map((r) => r.bills)).toEqual([1]);
  });

  test("only T1's bill, and T1 once took a delivery: nothing online", async () => {
    const { db: fixture } = day();
    useFixtureDb({ ...fixture, bills: fixture.bills.filter((b) => b.id === "d1") });
    const head = await db.GetOverviewHeadline(RID);
    expect(head.today_bills).toBe(1);
    expect(head.online_gross.value).toBe(0);
    expect(head.online_net.value).toBe(0);
  });

  test("the walk-in spellings are isOnlineChannel's: case and padding change nothing", async () => {
    const { db: fixture } = day();
    useFixtureDb({
      ...fixture,
      orders: fixture.orders.map((o) => (o.id === "o1" ? { ...o, order_type: " DINE_IN " } : o.id === "o2" ? { ...o, order_type: "Swiggy" } : o)),
    });
    const head = await db.GetOverviewHeadline(RID);
    expect(head.online_gross.value).toBe(paid(400).total_amt);
  });
});
