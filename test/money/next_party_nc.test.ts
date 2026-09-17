// SETTLE AS NC (client item 5) MEETS THE NEXT-PARTY SEAT (client item 6).
//
// Each feature was built and tested on its own lane, over its own fixture:
// nc_settle_fixture has one table and no migration 053, next_party_fixtures had
// no migration 052. So nothing drove the two together, and the release merge
// added code that lives only in the combination — SettleBillAsNonChargeable's
// post-commit afterTableFreed. This file drives the SHIPPED paths
// (SettleBillAsNonChargeable, ApproveBillPaymentByAdmin, EnsureNextPartyTable,
// ReopenBill, GetBillForTable, GetOrderingPrintGuard, GetTables) over ONE floor
// that models both (jest-tests/next_party_fixtures.ts):
//
//   * an NC settle frees its seat and tidies the family exactly as the other
//     settle paths do — a free root retires an idle "12 #2", a busy root keeps
//     one free seat — and comps nobody else's food;
//   * RE-OPENING A SETTLED BILL NEVER PUTS ITS FOOD ON A NEW PARTY'S BILL. A
//     party that has sat down has no "Bills" row until a print, a waiver or a
//     settle makes one, and the next print brings a retired "12 #2" back under
//     the SAME row id — so neither "the table has an open bill" nor the
//     retired-seat revive could see it. The re-open is refused, in words, and
//     nothing moves;
//   * an NC bill's 0.00 paper is not a print of that bill: re-opened, the bill
//     reads unprinted — no 423 for a waiter, no next-party seat backfilled.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import {
  SLUG,
  addBill,
  addOrder,
  addPrint,
  addTable,
  bills,
  liveSiblingsOf,
  liveTable,
  markWaiterConfirmed,
  ncRows,
  orders,
  resetStore,
  seat,
  sessions,
  tables,
  tick,
} from "../../jest-tests/next_party_fixtures";
import { billPrintJobBelongsToSeating, ncSettlementPrintJobId } from "../../bill_print_state";

jest.mock("pg", () => {
  interface Fx {
    connect: () => unknown;
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  }
  const floor = (): Fx => {
    const f = (globalThis as unknown as { __nextPartyFixture?: Fx }).__nextPartyFixture;
    if (!f) {throw new Error("next party fixture was not loaded");}
    return f;
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]) { return floor().query(sql, params); }
    connect() { return Promise.resolve(floor().connect()); }
    end() { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

type Db = typeof import("../../database_supabase");
let db: Db;

const MANAGER = "e0000000-0000-4000-8000-000000000001";
const ACTOR = {
  employee_id: MANAGER,
  username: "nirav",
  authorised_by_employee_id: MANAGER,
  authorised_by_username: "nirav",
};

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../../database_supabase");
});

beforeEach(() => {
  resetStore();
  db.resetTableNextPartyCache();
});

/** 12 printed (before any bill row: the fallback id) owing ₹1000; the next party on "12 #2" owing ₹600. */
async function printedTwelveWithNextParty() {
  addTable({ table_name: "12", capacity: 4 });
  seat("12", 4);
  const first = addOrder("12", 1000);
  tick(4);
  addPrint(`12-${String(Date.parse("2026-09-16T08:04:00.000Z"))}`);
  expect(await db.EnsureNextPartyTable(SLUG, "12")).toMatchObject({ table_name: "12 #2", created: true });
  tick(2);
  seat("12 #2", 2);
  const second = addOrder("12 #2", 600);
  return { first, second };
}

const settleNc = (orderId: string, expected: number) => db.SettleBillAsNonChargeable(SLUG, {
  order_id: orderId, nc_kind: "complimentary", reason: "Owner's guests", actor: ACTOR, expected_value: expected,
});

/** 12 settled the ordinary way (Cash, approved), leaving "12 #2" owing. */
async function settleTwelveCash(firstOrderId: string) {
  const bill = addBill("12");
  markWaiterConfirmed(bill.id, "Cash");
  tick(5);
  await db.ApproveBillPaymentByAdmin(SLUG, firstOrderId, "nirav");
  return bills().find((b) => b.id === bill.id)!;
}

/** 12 settled, then "12 #2" settled as NC — so "12 #2" is retired. Returns the NC settle. */
async function ncSettledRetiredSeat() {
  const ids = await printedTwelveWithNextParty();
  await settleTwelveCash(ids.first.id);
  tick(10);
  const out = await settleNc(ids.second.id, 600);
  expect(liveSiblingsOf("12")).toEqual([]);
  return { ...ids, out };
}

const statusOf = (orderId: string) => orders().find((o) => o.id === orderId)?.status;
const reopen = (billId: string) => db.ReopenBill(SLUG, billId, MANAGER, "nirav");

describe("an NC settle on a next-party family", () => {
  test("NC on '12 #2' while 12 still owes: only the seat's ₹600 is comped, and it stays as 12's free seat", async () => {
    const { first, second } = await printedTwelveWithNextParty();
    tick(10);
    const out = await settleNc(second.id, 600);
    expect(out).toMatchObject({ payment_method: "NC", table_name: "12 #2", nc_value: 600, total_amt: 0 });
    expect(ncRows().map((r) => r.order_id)).toEqual([second.id]);
    expect(statusOf(first.id)).toBe("2");
    expect((await db.GetBillForTable(SLUG, "12"))?.subtotal).toBe(1000);
    expect(liveSiblingsOf("12").map((t) => [t.table_name, t.is_occupied])).toEqual([["12 #2", false]]);
  });

  test("NC on '12 #2' once 12 is free: the settle's post-commit tidy retires the seat", async () => {
    const { first, second } = await printedTwelveWithNextParty();
    await settleTwelveCash(first.id);
    // 12 is free; its seat is kept because its party is still there.
    expect(liveSiblingsOf("12").map((t) => t.table_name)).toEqual(["12 #2"]);
    tick(10);
    await settleNc(second.id, 600);
    expect(liveSiblingsOf("12")).toEqual([]);
    expect(tables().find((t) => t.table_name === "12 #2")?.is_deleted).toBe(true);
  });

  test("NC on 12 while '12 #2' is seated: the seat's food is not comped, and the seat stays", async () => {
    const { first, second } = await printedTwelveWithNextParty();
    tick(10);
    await settleNc(first.id, 1000);
    expect(ncRows().map((r) => r.order_id)).toEqual([first.id]);
    expect(statusOf(second.id)).toBe("2");
    expect((await db.GetBillForTable(SLUG, "12 #2"))?.subtotal).toBe(600);
    expect(liveSiblingsOf("12").map((t) => [t.table_name, t.is_occupied])).toEqual([["12 #2", true]]);
  });

  test("NC on 12 while '12 #2' is idle: the idle seat is retired", async () => {
    addTable({ table_name: "12", capacity: 4 });
    seat("12", 4);
    const first = addOrder("12", 1000);
    tick(4);
    addPrint(`12-${String(Date.now())}`);
    await db.EnsureNextPartyTable(SLUG, "12");
    expect(liveSiblingsOf("12").map((t) => t.table_name)).toEqual(["12 #2"]);
    tick(5);
    await settleNc(first.id, 1000);
    expect(liveSiblingsOf("12")).toEqual([]);
  });

  test("each party keeps its own seating and covers", async () => {
    const { first, second } = await printedTwelveWithNextParty();
    tick(10);
    await settleNc(second.id, 600);
    await settleNc(first.id, 1000);
    expect(sessions().map((x) => [x.table_name, x.covers, x.left_at !== null])).toEqual([
      ["12", 4, true],
      ["12 #2", 2, true],
    ]);
    expect(bills().filter((b) => b.payment_method === "NC")).toHaveLength(2);
  });
});

describe("re-opening a settled bill whose table has a NEW party", () => {
  const REFUSED = /has a new party since this bill was closed\. Settle, move or release .+ first, then re-open this bill\./;

  test("the seat retired and still free: the re-open brings it back owing ₹600 again", async () => {
    const { second, out } = await ncSettledRetiredSeat();
    tick(3);
    const re = await reopen(out.bill_id);
    expect(re.bill.table_name).toBe("12 #2");
    expect(re.nc_reversed?.lines).toBe(1);
    expect(statusOf(second.id)).toBe("2");
    expect((await db.GetBillForTable(SLUG, "12 #2"))?.subtotal).toBe(600);
  });

  test("NC bill, seat RECYCLED under the same row id for a fourth party with no bill row: refused, nothing moves", async () => {
    const { second, out } = await ncSettledRetiredSeat();
    tick(5);
    // A third party at 12 is printed, which revives "12 #2" — the SAME row.
    seat("12", 3);
    addOrder("12", 900);
    tick(3);
    addPrint(`12-${String(Date.parse("2026-09-16T09:00:00.000Z"))}`);
    expect(await db.EnsureNextPartyTable(SLUG, "12")).toMatchObject({ table_name: "12 #2", created: true });
    expect(liveTable("12 #2").id).toBe(second.table_id);
    tick(1);
    seat("12 #2", 2);
    const fourth = addOrder("12 #2", 450);
    tick(2);

    await expect(reopen(out.bill_id)).rejects.toThrow(
      "12 #2 has a new party since this bill was closed. Settle, move or release 12 #2 first, then re-open this bill.",
    );
    const bill = await db.GetBillForTable(SLUG, "12 #2");
    expect(bill?.subtotal).toBe(450);
    expect(bill?.order_ids).toEqual([fourth.id]);
    // The NC settle stands whole: bill closed, comps live, food paid.
    expect(bills().find((b) => b.id === out.bill_id)).toMatchObject({ payment_method: "NC", total_amt: 0 });
    expect(bills().find((b) => b.id === out.bill_id)?.closed_at).not.toBeNull();
    expect(ncRows().every((r) => r.reversed_at === null)).toBe(true);
    expect(statusOf(second.id)).toBe("4");
  });

  test("…the same for a CASH bill on a recycled seat", async () => {
    const { first, second } = await printedTwelveWithNextParty();
    await settleTwelveCash(first.id);
    tick(5);
    await db.FinalizeOnlinePayment(SLUG, "12 #2", "pay_b");
    const paid = bills().find((b) => b.payment_proof_screenshot_url === "pay_b")!;
    expect(liveSiblingsOf("12")).toEqual([]);
    tick(5);
    seat("12", 3);
    addOrder("12", 900);
    tick(3);
    addPrint(`12-${String(Date.parse("2026-09-16T09:00:00.000Z"))}`);
    await db.EnsureNextPartyTable(SLUG, "12");
    expect(liveTable("12 #2").id).toBe(second.table_id);
    seat("12 #2", 2);
    addOrder("12 #2", 450);

    await expect(reopen(paid.id)).rejects.toThrow(REFUSED);
    expect((await db.GetBillForTable(SLUG, "12 #2"))?.subtotal).toBe(450);
    expect(statusOf(second.id)).toBe("4");
  });

  test("a KEPT seat (12 still printed) that seated a new party: refused", async () => {
    const { second } = await printedTwelveWithNextParty();
    tick(10);
    const out = await settleNc(second.id, 600);
    expect(liveSiblingsOf("12").map((t) => t.table_name)).toEqual(["12 #2"]);
    tick(3);
    seat("12 #2", 3);
    addOrder("12 #2", 450);
    await expect(reopen(out.bill_id)).rejects.toThrow(REFUSED);
    expect((await db.GetBillForTable(SLUG, "12 #2"))?.subtotal).toBe(450);
  });

  test("a new party that has ORDERED but whose seating flag is not set is still a new party", async () => {
    const { second } = await printedTwelveWithNextParty();
    tick(10);
    const out = await settleNc(second.id, 600);
    tick(3);
    // An order placed on the free seat (the guest QR path, say) before anyone seated it.
    addOrder("12 #2", 450);
    expect(liveTable("12 #2").is_occupied).toBe(false);
    await expect(reopen(out.bill_id)).rejects.toThrow(REFUSED);
  });

  test("a SEATED new party with nothing ordered yet is still a new party", async () => {
    const { second } = await printedTwelveWithNextParty();
    tick(10);
    const out = await settleNc(second.id, 600);
    tick(3);
    seat("12 #2", 2);
    await expect(reopen(out.bill_id)).rejects.toThrow(REFUSED);
  });

  test("the ROOT table after an NC settle, re-seated with an order: refused", async () => {
    addTable({ table_name: "12", capacity: 4 });
    seat("12", 4);
    const first = addOrder("12", 1000);
    tick(10);
    const out = await settleNc(first.id, 1000);
    tick(5);
    seat("12", 2);
    addOrder("12", 450);
    await expect(reopen(out.bill_id)).rejects.toThrow(
      "12 has a new party since this bill was closed. Settle, move or release 12 first, then re-open this bill.",
    );
    expect((await db.GetBillForTable(SLUG, "12"))?.subtotal).toBe(450);
    expect(statusOf(first.id)).toBe("4");
  });

  test("the ROOT table after a CASH settle, re-seated with an order: refused, statuses untouched", async () => {
    addTable({ table_name: "12", capacity: 4 });
    seat("12", 4);
    const first = addOrder("12", 1000);
    const paid = await settleTwelveCash(first.id);
    tick(5);
    seat("12", 2);
    const next = addOrder("12", 450);
    await expect(reopen(paid.id)).rejects.toThrow(REFUSED);
    expect(orders().map((o) => [o.id, o.status])).toEqual([[first.id, "4"], [next.id, "2"]]);
    expect((await db.GetBillForTable(SLUG, "12"))?.subtotal).toBe(450);
  });

  test("the ROOT table after a CASH settle and still free: the re-open is exactly what it was", async () => {
    addTable({ table_name: "12", capacity: 4 });
    seat("12", 4);
    const first = addOrder("12", 1000);
    const paid = await settleTwelveCash(first.id);
    tick(5);
    const re = await reopen(paid.id);
    expect(re.bill.table_name).toBe("12");
    expect(re.restored_orders).toBe(1);
    expect(statusOf(first.id)).toBe("6");
    expect(liveTable("12").is_occupied).toBe(true);
  });
});

describe("an NC bill's paper is not a print of that bill", () => {
  test("the id it is filed under belongs to no seating — not the bill's, not a split's, not the table's fallback", () => {
    const bill = "b1110000-0000-4000-8000-000000000042";
    const seating = { open_bill_id: bill, table_name: "12", seating_start: null };
    expect(ncSettlementPrintJobId(bill)).toBe(`${bill}-nc`);
    expect(billPrintJobBelongsToSeating({ bill_id: ncSettlementPrintJobId(bill), created_at: null }, seating)).toBe(false);
    expect(billPrintJobBelongsToSeating({ bill_id: bill, created_at: null }, seating)).toBe(true);
  });

  test("re-opened after its NC paper printed, the bill reads UNPRINTED: no refusal, no seat backfilled", async () => {
    addTable({ table_name: "12", capacity: 4 });
    seat("12", 4);
    const first = addOrder("12", 1000);
    tick(10);
    const out = await settleNc(first.id, 1000);
    // The route's paper (routes/nc_settle.ts), delivered.
    addPrint(ncSettlementPrintJobId(out.bill_id));
    tick(3);
    await reopen(out.bill_id);
    expect((await db.GetOrderingPrintGuard(SLUG, "12"))?.print_count).toBe(0);
    expect((await db.GetBillForTable(SLUG, "12"))?.print_count).toBe(0);
    const floor = await db.GetTables(SLUG);
    expect((floor ?? []).map((t) => t.table_name)).toEqual(["12"]);
    expect(liveSiblingsOf("12")).toEqual([]);
  });

  test("…whereas a paper filed under the bill's own id WOULD have counted (why the id differs)", async () => {
    addTable({ table_name: "12", capacity: 4 });
    seat("12", 4);
    const first = addOrder("12", 1000);
    tick(10);
    const out = await settleNc(first.id, 1000);
    addPrint(out.bill_id);
    tick(3);
    await reopen(out.bill_id);
    expect((await db.GetOrderingPrintGuard(SLUG, "12"))?.print_count).toBe(1);
  });

  test("a real print of the re-opened bill still counts", async () => {
    addTable({ table_name: "12", capacity: 4 });
    seat("12", 4);
    const first = addOrder("12", 1000);
    tick(10);
    const out = await settleNc(first.id, 1000);
    addPrint(ncSettlementPrintJobId(out.bill_id));
    tick(3);
    await reopen(out.bill_id);
    tick(1);
    addPrint(out.bill_id);
    expect((await db.GetBillForTable(SLUG, "12"))?.print_count).toBe(1);
  });
});
