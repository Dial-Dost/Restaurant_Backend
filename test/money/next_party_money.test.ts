// TWO PARTIES AT "TABLE 12" MUST NEVER SHARE A RUPEE.
//
// Client item 6 gives the next party at a printed table its own seat, "12 #2":
// a second "Tables" row whose parent is 12. The whole design rests on one claim
// — that because the sibling has its OWN table_id, every money path in the
// system keeps the two parties apart without being told they exist. This file
// is that claim, driven through the SHIPPED paths over an in-memory floor
// (jest-tests/next_party_fixtures.ts), and nothing is mirrored:
//
//   * the printed party's bill never includes an order taken on "12 #2";
//   * each settle path — admin approval, close, online payment — and the
//     release close ONLY their own table's orders, and "12 #2" keeps owing;
//   * approval re-prices from 12's orders alone, even when "12 #2" orders
//     between the waiter's confirm and the manager's approval;
//   * what 12's paper said is what 12's bill settled for, and what the sales
//     report then books — paper == drawer == report, per party;
//   * covers are counted once per SEATING, one seating per row;
//   * the tidy-up after a settle retires only an IDLE sibling, never one with a
//     party on it.
//
// THE PRODUCTION SHAPE. Gaia Global Vegetarian, 2026-09-16: waiter Atsu seated
// four at 12 at 07:58 and printed at 08:02 — before any "Bills" row existed, so
// the job was filed under the fallback id "12-<epoch>". The next party is two.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import {
  SLUG,
  addAssignment,
  addBill,
  addOrder,
  addPrint,
  addTable,
  bills,
  liveSiblingsOf,
  liveTable,
  markWaiterConfirmed,
  orders,
  resetStore,
  seat,
  sessions,
  tables,
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
    __nextPartyPgMode?: "floor" | "reports";
  }
  const g = () => globalThis as unknown as G;
  const floor = (): Fx => {
    const f = g().__nextPartyFixture;
    if (!f) {throw new Error("next party fixture was not loaded");}
    return f;
  };
  // ONE fake pool, two stores: the floor the settle paths write, and the
  // report fixture the sales readers read. A test switches between them.
  const reports = (sql: string, params?: unknown[]) => {
    const q = g().__moneyFixtureQuery;
    if (!q) {throw new Error("money report fixture was not loaded");}
    return q(sql, params);
  };
  const isReports = () => g().__nextPartyPgMode === "reports";
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]) { return isReports() ? reports(sql, params) : floor().query(sql, params); }
    connect() {
      return Promise.resolve(isReports()
        ? { query: reports, release: () => undefined }
        : floor().connect());
    }
    end() { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

const mode = (m: "floor" | "reports") => {
  (globalThis as unknown as { __nextPartyPgMode?: string }).__nextPartyPgMode = m;
};

type Db = typeof import("../../database_supabase");
let db: Db;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../../database_supabase");
});

beforeEach(() => {
  mode("floor");
  resetStore();
  db.resetTableNextPartyCache();
});

/**
 * 12 printed with four guests on a ₹1,000 bill; the next party of two seated at
 * "12 #2" with ₹600 ordered; table 15 idle. Returns the ids a test needs.
 */
async function printedTwelveWithNextParty() {
  addTable({ table_name: "12", capacity: 4 });
  addTable({ table_name: "15", capacity: 4 });
  seat("12", 4);
  const first = addOrder("12", 1000);
  addAssignment("12", "e0000000-0000-4000-8000-00000000a750");
  tick(4);
  // The waiter's print, before any bill row: the fallback id.
  addPrint(`12-${String(Date.parse("2026-09-16T08:04:00.000Z"))}`);
  const seatInfo = await db.EnsureNextPartyTable(SLUG, "12");
  expect(seatInfo).toMatchObject({ table_name: "12 #2", parent_table: "12", party_no: 2, created: true });
  tick(10);
  seat("12 #2", 2);
  const second = addOrder("12 #2", 600);
  return { first, second };
}

const statusOf = (orderId: string) => orders().find((o) => o.id === orderId)?.status;
const billOn = (tableName: string) => bills().filter((b) => b.table_id === liveOrAny(tableName).id);
const liveOrAny = (name: string) => tables().find((t) => t.table_name === name)!;

describe("the printed party's bill never contains the next party's order", () => {
  test("GetBillForTable('12') is 12's orders alone; '12 #2' is its own bill with its own covers", async () => {
    const { first, second } = await printedTwelveWithNextParty();
    const twelve = await db.GetBillForTable(SLUG, "12");
    const next = await db.GetBillForTable(SLUG, "12 #2");

    expect(twelve?.order_ids).toEqual([first.id]);
    expect(twelve?.subtotal).toBe(1000);
    expect(twelve?.grand_total).toBe(1050);
    expect(twelve?.covers).toBe(4);
    // 12 is printed; the next party's table is not.
    expect(twelve?.print_count).toBe(1);

    expect(next?.order_ids).toEqual([second.id]);
    expect(next?.subtotal).toBe(600);
    expect(next?.grand_total).toBe(630);
    expect(next?.covers).toBe(2);
    expect(next?.print_count).toBe(0);
  });

  test("a print of '12 #2' is its own: the '12-' fallback prefix never claims it, nor it '12-'", async () => {
    await printedTwelveWithNextParty();
    addPrint(`12 #2-${String(Date.now())}`);
    expect((await db.GetBillForTable(SLUG, "12"))?.print_count).toBe(1);
    expect((await db.GetBillForTable(SLUG, "12 #2"))?.print_count).toBe(1);
  });
});

describe("each settle path closes only its own table's orders", () => {
  test("ADMIN APPROVAL of 12 — 12 is paid and free, '12 #2' keeps owing, seated and served", async () => {
    const { first, second } = await printedTwelveWithNextParty();
    const bill = addBill("12");
    markWaiterConfirmed(bill.id);
    const printed = (await db.GetBillForTable(SLUG, "12"))!.grand_total;

    await db.ApproveBillPaymentByAdmin(SLUG, first.id, "nirav");

    const settled = bills().find((b) => b.id === bill.id)!;
    expect(settled.closed_at).not.toBeNull();
    // PAPER == DRAWER for 12, and neither contains a rupee of "12 #2".
    expect(settled.total_amt).toBe(printed);
    expect(settled.total_amt).toBe(1050);
    expect(statusOf(first.id)).toBe("4");
    expect(statusOf(second.id)).toBe("2");
    expect(liveTable("12").is_occupied).toBe(false);
    expect(liveTable("12 #2").is_occupied).toBe(true);
    expect(await db.GetBillForTable(SLUG, "12 #2")).toMatchObject({ order_ids: [second.id], subtotal: 600 });
    // Occupied siblings are never retired: 12 is free, "12 #2" stays.
    expect(liveSiblingsOf("12").map((t) => t.table_name)).toEqual(["12 #2"]);
  });

  test("approval RE-PRICES from 12 alone, even when '12 #2' orders between confirm and approve", async () => {
    const { first } = await printedTwelveWithNextParty();
    const bill = addBill("12");
    markWaiterConfirmed(bill.id);
    tick(2);
    addOrder("12 #2", 900); // the next party's second round, mid-approval
    await db.ApproveBillPaymentByAdmin(SLUG, first.id, "nirav");
    expect(bills().find((b) => b.id === bill.id)?.total_amt).toBe(1050);
  });

  test("…while an addition to 12 ITSELF in that window is still priced in (the existing re-price)", async () => {
    const { first } = await printedTwelveWithNextParty();
    const bill = addBill("12");
    markWaiterConfirmed(bill.id);
    addOrder("12", 200); // a manager's late addition to the printed party
    await db.ApproveBillPaymentByAdmin(SLUG, first.id, "nirav");
    expect(bills().find((b) => b.id === bill.id)?.total_amt).toBe(1260);
  });

  test("CLOSE of 12's approved bill — 12's orders close, '12 #2''s do not", async () => {
    const { first, second } = await printedTwelveWithNextParty();
    const bill = addBill("12", { admin_approved_at: "2026-09-16T08:20:00.000Z", total_amt: 1050, status: 2 });
    await db.CloseBillByOrder(SLUG, first.id, "nirav");
    expect(bills().find((b) => b.id === bill.id)?.closed_at).not.toBeNull();
    expect(statusOf(first.id)).toBe("7");
    expect(statusOf(second.id)).toBe("2");
    expect(liveTable("12 #2").is_occupied).toBe(true);
  });

  test("ONLINE PAYMENT for 12 — the gateway total is 12's, and '12 #2' keeps owing", async () => {
    const { first, second } = await printedTwelveWithNextParty();
    const printed = (await db.GetBillForTable(SLUG, "12"))!.grand_total;
    const out = await db.FinalizeOnlinePayment(SLUG, "12", "pay_ggv_12");
    expect(out.total_amt).toBe(printed);
    expect(out.total_amt).toBe(1050);
    expect(statusOf(first.id)).toBe("4");
    expect(statusOf(second.id)).toBe("2");
    const paid = billOn("12").find((b) => b.payment_proof_screenshot_url === "pay_ggv_12");
    expect(paid?.total_amt).toBe(1050);
    expect(billOn("12 #2")).toEqual([]);
  });

  test("RELEASE of 12 voids 12's orders only; '12 #2''s party keeps its food and its bill", async () => {
    const { first, second } = await printedTwelveWithNextParty();
    await db.ReleaseTable(SLUG, "12");
    expect(statusOf(first.id)).toBe("5");
    expect(statusOf(second.id)).toBe("2");
    expect((await db.GetBillForTable(SLUG, "12 #2"))?.subtotal).toBe(600);
  });

  test("and the other way round: settling '12 #2' leaves 12's printed bill exactly as printed", async () => {
    const { first, second } = await printedTwelveWithNextParty();
    const before = await db.GetBillForTable(SLUG, "12");
    await db.FinalizeOnlinePayment(SLUG, "12 #2", "pay_ggv_12_2");
    expect(statusOf(second.id)).toBe("4");
    expect(statusOf(first.id)).toBe("2");
    const after = await db.GetBillForTable(SLUG, "12");
    expect(after?.grand_total).toBe(before?.grand_total);
    expect(after?.print_count).toBe(1);
  });
});

describe("paper == drawer == report, one party at a time", () => {
  test("both parties settle; the sales report books exactly the two printed totals", async () => {
    const { first, second } = await printedTwelveWithNextParty();
    const printed12 = (await db.GetBillForTable(SLUG, "12"))!.grand_total;
    const printedNext = (await db.GetBillForTable(SLUG, "12 #2"))!.grand_total;

    const b12 = addBill("12");
    markWaiterConfirmed(b12.id);
    await db.ApproveBillPaymentByAdmin(SLUG, first.id, "nirav");
    tick(5);
    const bNext = addBill("12 #2");
    markWaiterConfirmed(bNext.id);
    await db.ApproveBillPaymentByAdmin(SLUG, second.id, "nirav");

    const settled = bills().filter((b) => b.closed_at !== null);
    expect(settled.map((b) => b.total_amt).sort()).toEqual([printed12, printedNext].sort());

    // THE REPORT READS WHAT THE SETTLE WROTE — the shipped GetSalesReport over
    // the rows the shipped settle paths produced.
    const asReported: FixtureBill[] = settled.map((b) => ({
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
    const sales = await db.GetSalesReport("zztest-money", "2026-09-16", "2026-09-17");
    mode("floor");
    expect(sales.total_sales).toBe(1050 + 630);
    expect(sales.total_sales).toBe(printed12 + printedNext);
  });
});

describe("covers: one seating per row, counted once", () => {
  test("two TableSessions rows, 4 and 2 covers, each closed by its own settle", async () => {
    const { first, second } = await printedTwelveWithNextParty();
    const open = () => sessions().filter((x) => x.left_at === null);
    expect(open().map((x) => `${x.table_name}:${String(x.covers)}`).sort()).toEqual(["12 #2:2", "12:4"]);

    await db.FinalizeOnlinePayment(SLUG, "12", "pay_a");
    expect(open().map((x) => x.table_name)).toEqual(["12 #2"]);
    expect(sessions().find((x) => x.table_name === "12")?.covers).toBe(4);

    await db.FinalizeOnlinePayment(SLUG, "12 #2", "pay_b");
    expect(open()).toEqual([]);
    expect(sessions().map((x) => x.covers).sort()).toEqual([2, 4]);
    void first; void second;
  });
});

describe("the tidy-up after a settle retires only what is idle", () => {
  test("12 settles with '12 #2' seated: nothing retires. '12 #2' settles: it retires, 12 is the free seat", async () => {
    await printedTwelveWithNextParty();
    await db.FinalizeOnlinePayment(SLUG, "12", "pay_a");
    expect(liveSiblingsOf("12").map((t) => t.table_name)).toEqual(["12 #2"]);
    await db.FinalizeOnlinePayment(SLUG, "12 #2", "pay_b");
    expect(liveSiblingsOf("12")).toEqual([]);
    // Retired, not deleted: the row, its settled bill and its orders are history.
    const retired = tables().find((t) => t.table_name === "12 #2");
    expect(retired?.is_deleted).toBe(true);
    expect(billOn("12 #2").every((b) => b.closed_at !== null)).toBe(true);
  });

  test("a sibling with an OPEN BILL but nobody seated is never retired — that is money", async () => {
    await printedTwelveWithNextParty();
    const t = liveTable("12 #2");
    // The party left without paying and someone freed the seat by hand.
    t.is_occupied = false;
    await db.FinalizeOnlinePayment(SLUG, "12", "pay_a");
    expect(liveSiblingsOf("12").map((x) => x.table_name)).toEqual(["12 #2"]);
  });

  test("a failed tidy-up never undoes the settle it followed", async () => {
    const { first } = await printedTwelveWithNextParty();
    await db.FinalizeOnlinePayment(SLUG, "12 #2", "pay_b");
    const { failNextStatementContaining } = await import("../../jest-tests/next_party_fixtures");
    failNextStatementContaining('update "tables" t set is_deleted = true');
    const out = await db.FinalizeOnlinePayment(SLUG, "12", "pay_a");
    expect(out.total_amt).toBe(1050);
    expect(statusOf(first.id)).toBe("4");
    expect(billOn("12").some((b) => b.closed_at !== null && b.total_amt === 1050)).toBe(true);
    // The idle sibling survived this time; the next release of the family tidies it.
    expect(liveSiblingsOf("12").map((x) => x.table_name)).toEqual(["12 #2"]);
    await db.ReleaseTable(SLUG, "12");
    expect(liveSiblingsOf("12")).toEqual([]);
  });
});
