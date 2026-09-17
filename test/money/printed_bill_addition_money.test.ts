// ADDING TO A PRINTED BILL MUST NEVER LET THE PAPER, THE DRAWER AND THE REPORT
// DISAGREE UNNOTICED — client items 1 and 2 (app 2.0.2, migration 055).
//
// Gaia Global Vegetarian settles at night. A printed table is now a pending bill
// the waiter can still add to (after confirming), so the paper in the guest's
// hand can fall behind the bill. The design's money claim, driven through the
// SHIPPED paths over the in-memory floor (jest-tests/next_party_fixtures.ts) —
// the print's own fingerprint (routes/bills.ts currentPaperDigest), the real
// GetBillForTable / GetTables / ApproveBillPaymentByAdmin, and the real
// GetSalesReport over the rows the settle wrote:
//
//   THE LADDER: print (₹1,050) -> add a dish -> the paper is STALE (bill ₹1,260,
//   paper ₹1,050) on the bill read AND the floor tile -> the updated print ->
//   the paper is CURRENT again and says ₹1,260 -> settle -> the drawer books
//   ₹1,260 -> the sales report books ₹1,260. Printed total == drawer == report.
//
//   SETTLE ANYWAY: the cashier settles without the updated print. The drawer
//   still books the CURRENT total (never the paper's), the report books what
//   the drawer booked, and the only thing that disagreed — the paper — was
//   flagged stale on every read before the settle.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import {
  SLUG,
  addBill,
  addOrder,
  addPrint,
  addTable,
  bills,
  markWaiterConfirmed,
  resetStore,
  seat,
  tick,
} from "../../jest-tests/next_party_fixtures";
import { makeDb, useFixtureDb, type FixtureBill } from "./bill_fixtures";

jest.mock("pg", () => {
  interface Fx {
    connect: () => unknown;
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  }
  interface G {
    __nextPartyFixture?: Fx;
    __moneyFixtureQuery?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    __printedBillPgMode?: "floor" | "reports";
  }
  const g = () => globalThis as unknown as G;
  const floor = (): Fx => {
    const f = g().__nextPartyFixture;
    if (!f) {throw new Error("next party fixture was not loaded");}
    return f;
  };
  const reports = (sql: string, params?: unknown[]) => {
    const q = g().__moneyFixtureQuery;
    if (!q) {throw new Error("money report fixture was not loaded");}
    return q(sql, params);
  };
  const isReports = () => g().__printedBillPgMode === "reports";
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]) { return isReports() ? reports(sql, params) : floor().query(sql, params); }
    connect() {
      return Promise.resolve(isReports() ? { query: reports, release: () => undefined } : floor().connect());
    }
    end() { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});
jest.mock("../../realtime", () => ({ __esModule: true, emitRestaurant: () => undefined, emitOutlet: () => undefined }));

const mode = (m: "floor" | "reports") => {
  (globalThis as unknown as { __printedBillPgMode?: string }).__printedBillPgMode = m;
};

type Db = typeof import("../../database_supabase");
type Bills = typeof import("../../routes/bills");
type Digest = typeof import("../../bill_paper_digest");
let db: Db;
let routes: Bills;
let digest: Digest;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../../database_supabase");
  routes = await import("../../routes/bills");
  digest = await import("../../bill_paper_digest");
});

beforeEach(() => {
  mode("floor");
  resetStore();
  db.resetTableNextPartyCache();
  db.resetPrintJobPaperCache();
});

/**
 * THE PRINT, as printOpenTableBill files it: a ledger row, then what its paper
 * said — the fingerprint from the SAME function the gate and the bill read use.
 */
async function printBill(atMs: number): Promise<number> {
  const bill = (await db.GetBillForTable(SLUG, "12"))!;
  const job = addPrint(`12-${String(atMs)}`);
  await db.RecordBillPrintPaper(SLUG, [job.id!], {
    bill_digest: await routes.currentPaperDigest(SLUG, "12", bill),
    lines_digest: digest.billLinesDigest(bill.items),
    bill_grand_total: bill.grand_total,
    table_name: "12",
  });
  return bill.grand_total;
}

const staleNow = async (): Promise<boolean | null> => {
  const bill = (await db.GetBillForTable(SLUG, "12"))!;
  return routes.billPaperStale(SLUG, "12", bill);
};
const tile = async () => (await db.GetTables(SLUG))!.find((r) => r.table_name === "12")!;

/** 12 seated with four, ₹1,000 of food (₹1,050 with CGST+SGST at 2.5% each). */
async function seatedTwelve(): Promise<{ firstOrderId: string }> {
  addTable({ table_name: "12", capacity: 4 });
  seat("12", 4);
  const first = addOrder("12", 1000);
  tick(4);
  return { firstOrderId: first.id };
}

async function reportTotal(): Promise<number> {
  const asReported: FixtureBill[] = bills().filter((b) => b.closed_at !== null).map((b) => ({
    id: b.id,
    bill_no: String(b.bill_no),
    settled_at: String(b.closed_at),
    total_amt: b.total_amt,
    tax_breakdown: b.tax_breakdown as FixtureBill["tax_breakdown"],
    round_off: b.round_off,
    payment_method: b.payment_method,
  }));
  mode("reports");
  useFixtureDb(makeDb({ bills: asReported }));
  try {
    return (await db.GetSalesReport("zztest-money", "2026-09-16", "2026-09-17")).total_sales;
  } finally {
    mode("floor");
  }
}

describe("print -> add -> stale -> updated print -> settle: paper == drawer == report", () => {
  test("the whole ladder", async () => {
    const { firstOrderId } = await seatedTwelve();

    // 1. THE PRINT. Nothing has changed since: the paper is current everywhere.
    const firstPaper = await printBill(Date.parse("2026-09-16T08:04:00.000Z"));
    expect(firstPaper).toBe(1050);
    expect(await staleNow()).toBe(false);
    expect(await tile()).toMatchObject({ print_count: 1, paper_stale: false });

    // 2. THE WAITER ADDS A DISH (the confirmed addition the route lets through).
    tick(20);
    addOrder("12", 200);
    const grown = (await db.GetBillForTable(SLUG, "12"))!;
    expect(grown.grand_total).toBe(1260);
    // 3. STALE — on the bill read (the sheet, the print gate) and the floor tile.
    expect(await staleNow()).toBe(true);
    expect(grown.printed_total).toBe(1050);
    expect(await tile()).toMatchObject({ print_count: 1, paper_stale: true });

    // 4. THE UPDATED PRINT.
    tick(1);
    const updatedPaper = await printBill(Date.parse("2026-09-16T08:25:00.000Z"));
    expect(updatedPaper).toBe(1260);
    const reprinted = (await db.GetBillForTable(SLUG, "12"))!;
    expect(reprinted).toMatchObject({ print_count: 2, printed_total: 1260, grand_total: 1260 });
    expect(await staleNow()).toBe(false);
    expect(await tile()).toMatchObject({ print_count: 2, paper_stale: false });

    // 5. SETTLE.
    const bill = addBill("12");
    markWaiterConfirmed(bill.id);
    await db.ApproveBillPaymentByAdmin(SLUG, firstOrderId, "nirav");
    const settled = bills().find((b) => b.id === bill.id)!;
    expect(settled.closed_at).not.toBeNull();

    // THE INVARIANT: the paper in the guest's hand, the drawer and the report.
    expect(settled.total_amt).toBe(reprinted.printed_total);
    expect(await reportTotal()).toBe(settled.total_amt);
    expect(await reportTotal()).toBe(1260);
  });

  test("SETTLE ANYWAY: the drawer books the CURRENT total, the report books the drawer, and the stale paper was flagged first", async () => {
    const { firstOrderId } = await seatedTwelve();
    await printBill(Date.parse("2026-09-16T08:04:00.000Z"));
    tick(20);
    addOrder("12", 200);

    // What the settle sheet reads before the cashier presses "Settle anyway".
    const before = (await db.GetBillForTable(SLUG, "12"))!;
    expect(await staleNow()).toBe(true);
    expect(before).toMatchObject({ printed_total: 1050, grand_total: 1260 });

    const bill = addBill("12");
    markWaiterConfirmed(bill.id);
    await db.ApproveBillPaymentByAdmin(SLUG, firstOrderId, "nirav");
    const settled = bills().find((b) => b.id === bill.id)!;
    // Never the paper's number: the till takes what is owed.
    expect(settled.total_amt).toBe(before.grand_total);
    expect(settled.total_amt).not.toBe(before.printed_total);
    expect(await reportTotal()).toBe(settled.total_amt);
  });

  test("a discount after the print is stale on the bill read too — the fingerprint is the whole ladder", async () => {
    await seatedTwelve();
    await printBill(Date.parse("2026-09-16T08:04:00.000Z"));
    expect(await staleNow()).toBe(false);
    // The open bill row with a flat ₹100 off — the shape SetBillDiscountWithApproval leaves.
    addBill("12", { discount_type: "flat", discount_value: 100 });
    const discounted = (await db.GetBillForTable(SLUG, "12"))!;
    expect(discounted.grand_total).toBe(945);
    expect(await staleNow()).toBe(true);
    // The tile compares the LINES only, and no line changed: the sheet is where
    // a ladder-only change shows (bill_paper_digest.ts says why).
    expect((await tile()).paper_stale).toBe(false);
  });

  test("the gate and the paper cannot disagree: the digest the print files IS the one the read compares", async () => {
    await seatedTwelve();
    const bill = (await db.GetBillForTable(SLUG, "12"))!;
    const a = await routes.currentPaperDigest(SLUG, "12", bill);
    const b = await routes.currentPaperDigest(SLUG, "12", (await db.GetBillForTable(SLUG, "12"))!);
    expect(a).toBe(b);
    // And it is the ladder GetBillForTable itself shows — the paper is the till's.
    expect(a).toBe(digest.billPaperDigest({
      items: bill.items,
      charges: { subtotal: bill.subtotal, discount: bill.discount, service_charge: bill.service_charge, service_charge_percent: bill.service_charge_percent, taxes: bill.taxes, round_off: bill.round_off, grand_total: bill.grand_total },
      customerGstin: bill.customer_gstin,
    }));
  });
});
