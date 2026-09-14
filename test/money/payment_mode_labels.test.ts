// A CUSTOM PAYMENT MODE ON THE CASH-UP SHEET — through the shipped readers.
//
// payment_methods.ts decides what a mode is called. What is unproved there is
// that the REPORTS use it: that a bill settled with an owner-added mode is
// grouped under its stored id (so a rename never splits a day's takings), that
// the row carries the owner's label beside it, and that none of it moves a rupee.
// Driven through GetSalesReport (bill_fixtures) and the Settlement / Counter
// Summary (mis_fixtures) over stubbed pools, the same posture as the agreement
// suites next door.

import { describe, test, expect, beforeAll, jest } from "@jest/globals";
import * as money from "./bill_fixtures";
import * as mis from "./mis_fixtures";

jest.mock("pg", () => {
  interface FixtureGlobal {
    __moneyFixtureQuery?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    __misFixtureQuery?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    __paymentLabelsFixture?: "money" | "mis";
  }
  const run = (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const g = globalThis as unknown as FixtureGlobal;
    const q = g.__paymentLabelsFixture === "mis" ? g.__misFixtureQuery : g.__moneyFixtureQuery;
    if (!q) {throw new Error("fixture harness was not loaded");}
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

const use = (which: "money" | "mis"): void => {
  (globalThis as unknown as { __paymentLabelsFixture?: string }).__paymentLabelsFixture = which;
};

type Readers = typeof import("../../database_supabase");
let db: Readers;

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../../database_supabase");
});

// The owner added "Swiggy Dineout" and later relabelled it — the id stays what
// the bills carry, the label is what the sheet should say.
const CONFIG = [
  { id: "Upi", label: "UPI", enabled: true, requires_screenshot: false },
  { id: "Swiggy Dineout", label: "Swiggy (Dineout)", enabled: true, requires_screenshot: true, custom: true },
];

describe("Sales report: by_method groups by id and carries the label", () => {
  const bills: money.FixtureBill[] = [
    { id: "a", bill_no: "1", settled_at: "2026-06-02T08:00:00.000Z", total_amt: 1000, tax_breakdown: [], payment_method: "Swiggy Dineout" },
    { id: "b", bill_no: "2", settled_at: "2026-06-02T09:00:00.000Z", total_amt: 500, tax_breakdown: [], payment_method: "Upi" },
    {
      id: "c", bill_no: "3", settled_at: "2026-06-02T10:00:00.000Z", total_amt: 300, tax_breakdown: [],
      payment_method: "Split", payment_splits: [{ method: "Swiggy Dineout", amount: 200 }, { method: "Cash", amount: 100 }],
    },
  ];

  test("a custom mode's money lands under its stored id, whole and split, with the owner's label", async () => {
    use("money");
    money.useFixtureDb(money.makeDb({ bills, payment_config: CONFIG }));
    const r = await db.GetSalesReport("zztest-money", "2026-06-01", "2026-06-03");
    const swiggy = r.by_method.find((m) => m.method === "Swiggy Dineout");
    expect(swiggy).toEqual({ method: "Swiggy Dineout", label: "Swiggy (Dineout)", sales: 1200, bills: 2 });
    expect(r.by_method.find((m) => m.method === "Upi")?.label).toBe("UPI");
    expect(r.by_method.find((m) => m.method === "Cash")?.label).toBe("Cash");
    // The label is display only: not one rupee moved.
    expect(r.by_method.reduce((s, m) => s + m.sales, 0)).toBe(r.total_sales);
  });

  test("with NO config the built-in labels are the defaults, and an unknown string labels itself", async () => {
    use("money");
    money.useFixtureDb(money.makeDb({ bills }));
    const r = await db.GetSalesReport("zztest-money", "2026-06-01", "2026-06-03");
    expect(r.by_method.find((m) => m.method === "Upi")?.label).toBe("UPI");
    expect(r.by_method.find((m) => m.method === "Swiggy Dineout")?.label).toBe("Swiggy Dineout");
  });
});

describe("Settlement and Counter Summary: the cash-up sheet names the mode", () => {
  const W = { from: "2026-06-01", to: "2026-06-15" };
  const misBill = (id: string, method: string, total: number, extra: Partial<mis.FixtureBill> = {}): mis.FixtureBill => ({
    id, bill_no: id, settled_at: "2026-06-02T08:00:00.000Z", total_amt: total, tax_breakdown: [],
    payment_method: method, table_name: "T1", session_id: `S-${id}`, covers: 2, ...extra,
  });

  test("rows keep grouping by id, add the label, and still sum to the bills", async () => {
    use("mis");
    mis.useFixtureDb(mis.makeDb({
      payment_config: CONFIG,
      bills: [
        misBill("m1", "Swiggy Dineout", 1000),
        misBill("m2", "Upi", 500),
        misBill("m3", "Split", 300, { payment_splits: [{ method: "Swiggy Dineout", amount: 200 }, { method: "Cash", amount: 100 }] }),
      ],
    }));
    const settle = await db.GetSettlementSummaryReport("zztest-mis", W);
    const row = settle.rows.find((r) => r.method === "Swiggy Dineout");
    expect(row?.label).toBe("Swiggy (Dineout)");
    // The "Payment mode" column both clients' report tables (and the CSV) render
    // is the label, and every row has one — a row without it would be a blank cell.
    expect(settle.columns.find((c) => c.label === "Payment mode")?.key).toBe("label");
    expect(settle.rows.every((r) => typeof r.label === "string" && r.label.length > 0)).toBe(true);
    expect(row?.amount).toBe(1200);
    expect(settle.rows.find((r) => r.method === "Upi")?.label).toBe("UPI");
    expect(settle.rows.reduce((s, r) => s + r.amount, 0)).toBe(1800);

    const counter = await db.GetCounterSummaryReport("zztest-mis", W);
    const methods = counter.rows.flatMap((r) => r.by_method);
    expect(methods.find((m) => m.method === "Swiggy Dineout")).toEqual({ method: "Swiggy Dineout", label: "Swiggy (Dineout)", amount: 1200 });
    // The one-cell spreadsheet cut reads the labels too, and still carries every rupee.
    const cell = counter.rows.map((r) => r.payment_modes).join(" | ");
    expect(cell).toContain("Swiggy (Dineout) 1200.00");
    expect(cell).toContain("UPI 500.00");
    expect(cell).not.toContain("Swiggy Dineout");
  });
});
