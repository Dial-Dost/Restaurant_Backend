// Moving a party (items 10/21) and moving one KOT (item 22), against the REAL
// MoveTableParty and MoveOrderToTable in database_supabase.ts over a fake Pool.
//
// WHAT IS UNDER TEST, in order of how much it would cost to get wrong:
//
//   1. ATOMICITY. A half-moved guest — orders on T2, seating still on T1 — is a
//      worse outcome than no feature at all: the bill splits across two tables
//      and the covers behind APC are counted against a table nobody is sitting
//      at. Every step is failed in turn and the floor is asserted UNCHANGED.
//
//   2. COVERS, AND THEREFORE APC. "TableSessions" holds one row per seating and
//      APC is the bill over those covers. The obvious implementation of a move
//      (free one table, occupy the other) makes the database trigger write TWO
//      seatings for one party, which doubles their covers and halves their APC.
//      The tests below count open sessions after a move and demand exactly one,
//      still carrying the instant the party actually sat down.
//
//   3. THE BILL ROW SURVIVES. A move is not a merge: the same party is still
//      running the same bill, so its number, discount and coupon must travel
//      with it rather than being closed and rebuilt.
//
//   4. THE REFUSALS. An occupied destination is refused and the message names
//      Merge; an over-capacity move is refused; a settled order cannot be moved.
//
// See table_move_fixtures.ts for what the fake models (a real rollback, and the
// "TableSessions" trigger) and what it deliberately does not (isolation, RLS).

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import {
  RESTAURANT_SLUG,
  addAssignment,
  addBill,
  addBooking,
  addOrder,
  addTable,
  assignments,
  dropSessionsFor,
  bills,
  bookings,
  failNextStatementContaining,
  openSessions,
  orders,
  resetStore,
  sessions,
  statements,
  tableByName,
} from "./table_move_fixtures";

jest.mock("pg", () => {
  interface FixtureGlobal {
    __tableMoveFixtureConnect?: () => { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; release: () => void };
  }
  const conn = () => {
    const make = (globalThis as unknown as FixtureGlobal).__tableMoveFixtureConnect;
    if (!make) {throw new Error("table move fixture harness was not loaded");}
    return make();
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> { return conn().query(sql, params); }
    connect(): Promise<unknown> { return Promise.resolve(conn()); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

type Db = typeof import("../database_supabase");
let db: Db;

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
});

beforeEach(() => {
  resetStore();
  db.__resetSectionOrderProbe();
});

/** A party of four at T1, mid-meal: two orders, an open bill with a number on
 *  it, a waiter, and the seating row the trigger wrote when they sat down. */
function seatedParty(): { t1: string; t2: string } {
  const t1 = addTable({ table_name: "T1", capacity: 4, is_occupied: true, num_covers: 4, order_otp: "4821" });
  const t2 = addTable({ table_name: "T2", capacity: 6 });
  addOrder({ table_id: t1.id, food: { total: 300, subtotal: 300, table: "T1", items: [] } });
  addOrder({ table_id: t1.id, food: { total: 200, subtotal: 200, table: "T1", items: [] } });
  addBill({ table_id: t1.id, total_amt: 500, bill_no: "B-42" });
  addAssignment(t1.id, "emp-7");
  return { t1: t1.id, t2: t2.id };
}

describe("MoveTableParty — the whole party arrives together", () => {
  test("orders, bill, seating, covers, waiter and OTP all land on the destination", async () => {
    const { t1, t2 } = seatedParty();

    const res = await db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2");

    expect(res).toMatchObject({
      from_table: "T1", to_table: "T2", covers: 4, moved_orders: 2,
      moved_bill: true, moved_session: true, moved_waiter: true, total_amt: 500,
    });
    // Every order, by id AND by the name that gets printed on the docket.
    expect(orders().every((o) => o.table_id === t2)).toBe(true);
    expect(orders().every((o) => o.food.table === "T2")).toBe(true);
    // The bill ROW moved. Same row, same number — not a rebuild.
    expect(bills()).toHaveLength(1);
    expect(bills()[0]).toMatchObject({ table_id: t2, bill_no: "B-42", closed_at: null, total_amt: 500 });
    // The floor.
    expect(tableByName("T1")).toMatchObject({ is_occupied: false, num_covers: 1, order_otp: null });
    expect(tableByName("T2")).toMatchObject({ is_occupied: true, num_covers: 4, order_otp: "4821" });
    // The waiter came with them.
    expect(assignments()).toHaveLength(1);
    expect(assignments()[0]).toMatchObject({ table_id: t2, employee_id: "emp-7" });
    expect(t1).not.toBe(t2);
  });

  test("ONE seating, not two — the covers behind APC are not doubled", async () => {
    const { t2 } = seatedParty();
    expect(openSessions()).toHaveLength(1);

    await db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2");

    // THE MONEY ASSERTION. Two open sessions here would mean this party is
    // counted as eight covers, and every APC that divides by them halves.
    const open = openSessions();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ table_id: t2, table_name: "T2", covers: 4 });
    // ...and it is the ORIGINAL seating, so turnaround still measures from when
    // the party actually sat down rather than restarting at the move.
    expect(open[0].seated_at).toBe("2026-09-09T12:00:00.000Z");
    // Nothing was left closed behind them either: one party, one row, full stop.
    expect(sessions()).toHaveLength(1);
  });

  test("the trigger really does fire — the fixture is not flattering the code", async () => {
    // GUARD AGAINST A FALSE PASS. "One open session after a move" would also be
    // true of a fake that simply never wrote the second one, which would make
    // the covers assertion above worthless. So: a source with NO open session
    // (a table occupied before the trigger existed) has nothing to carry across,
    // and the row the TRIGGER opens on the destination is the only one there is.
    // If the trigger were not modelled, this would find zero sessions.
    const { t2 } = seatedParty();
    dropSessionsFor(tableByName("T1")!.id);
    expect(openSessions()).toHaveLength(0);

    const res = await db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2");

    expect(res.moved_session).toBe(false);
    const open = openSessions();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ table_id: t2, covers: 4 });
    // The trigger opened it at the move (13:00), and the move then took it back
    // to the party's OWN start — its first order at 12:05, the bound the print
    // re-key used — so the destination's print bound (seatingStartFor) is the
    // party's and its paper still counts. Never earlier than anything the party
    // did: no history is invented.
    expect(open[0].seated_at).toBe("2026-09-09T12:05:00.000Z");
    expect(statements()).toContain('update "tablesessions" set seated_at = least(seated_at, $2::timestamptz) where table_id = $1 and left_at is null');
  });

  test("…and a party with nothing on it (no order, no bill, no seating) keeps the row the trigger opened", async () => {
    addTable({ table_name: "T1", capacity: 4, is_occupied: true, num_covers: 2 });
    addTable({ table_name: "T2", capacity: 4 });
    dropSessionsFor(tableByName("T1")!.id);
    await db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2");
    expect(openSessions()).toMatchObject([{ table_id: tableByName("T2")!.id, seated_at: "2026-09-09T13:00:00.000Z" }]);
    expect(statements().some((q) => q.startsWith('update "tablesessions" set seated_at'))).toBe(false);
  });

  test("a seated reservation follows the party to the new table", async () => {
    const { t2 } = seatedParty();
    addBooking(tableByName("T1")!.id, "Seated");

    await db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2");

    expect(bookings()[0].table_id).toBe(t2);
  });

  test("a FUTURE reservation for the old table stays on the old table", async () => {
    // Somebody else has booked T1 for later. The party leaving does not take
    // that reservation with them.
    const { t1 } = seatedParty();
    addBooking(t1, "Confirmed");

    await db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2");

    expect(bookings()[0].table_id).toBe(t1);
  });
});

describe("MoveTableParty — what it refuses, and why", () => {
  test("an OCCUPIED destination is refused, and the message names Merge", async () => {
    addTable({ table_name: "T1", capacity: 4, is_occupied: true, num_covers: 2 });
    addTable({ table_name: "T2", capacity: 4, is_occupied: true, num_covers: 2 });
    addOrder({ table_id: tableByName("T1")!.id });

    await expect(db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2")).rejects.toThrow(/Merge/);
    // And nothing moved on the way to the refusal.
    expect(orders()[0].table_id).toBe(tableByName("T1")!.id);
    expect(openSessions()).toHaveLength(2);
  });

  test("a party that does not fit the destination is refused, in seating's own words", async () => {
    addTable({ table_name: "T1", capacity: 6, is_occupied: true, num_covers: 6 });
    addTable({ table_name: "T2", capacity: 2 });

    await expect(db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2")).rejects.toThrow(/seats up to 2/);
  });

  test("an APPROVED bill is locked — the table cannot be moved out from under it", async () => {
    const t1 = addTable({ table_name: "T1", capacity: 4, is_occupied: true, num_covers: 2 });
    addTable({ table_name: "T2", capacity: 4 });
    addOrder({ table_id: t1.id });
    addBill({ table_id: t1.id, admin_approved_at: "2026-09-09T12:50:00.000Z" });

    await expect(db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2")).rejects.toThrow(/approved/i);
  });

  test("a free destination that still has an open bill is refused, naming the fix", async () => {
    const t1 = addTable({ table_name: "T1", capacity: 4, is_occupied: true, num_covers: 2 });
    const t2 = addTable({ table_name: "T2", capacity: 4 });
    addOrder({ table_id: t1.id });
    addBill({ table_id: t2.id, total_amt: 0 });

    await expect(db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2")).rejects.toThrow(/Release T2 first/);
  });

  test("an unseated source has nothing to move", async () => {
    addTable({ table_name: "T1", capacity: 4 });
    addTable({ table_name: "T2", capacity: 4 });
    await expect(db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2")).rejects.toThrow(/not seated/);
  });

  test("a takeaway's hidden table is not somewhere a party can sit", async () => {
    addTable({ table_name: "T1", capacity: 4, is_occupied: true, num_covers: 2 });
    addTable({ table_name: "Takeaway 8891", capacity: 1, is_virtual: true });
    await expect(db.MoveTableParty(RESTAURANT_SLUG, "T1", "Takeaway 8891")).rejects.toThrow(/Takeaway and delivery/);
  });

  test("moving a table onto itself is refused before anything is read", async () => {
    addTable({ table_name: "T1", capacity: 4, is_occupied: true, num_covers: 2 });
    await expect(db.MoveTableParty(RESTAURANT_SLUG, "T1", "t1")).rejects.toThrow(/different table/);
  });
});

describe("MoveTableParty — ATOMIC, proved by failing every step in turn", () => {
  // The statement fragments below are the move, step by step. Each one is made
  // to throw and the floor is then asserted to be EXACTLY as it started: this is
  // the half-moved-guest outcome, and it must be unreachable at every point.
  const steps: [string, string][] = [
    ["the orders are being moved", 'update "orders" set table_id ='],
    ["the bill row is being moved", 'update "bills" set table_id ='],
    ["the destination is being seated", "set is_occupied = true, num_covers = $4"],
    ["the source is being freed", "set is_occupied = false"],
    ["the seating is being re-pointed", 'update "tablesessions" set table_id ='],
    ["the waiter is being re-pointed", 'update "table_assignments" set table_id ='],
  ];

  for (const [when, needle] of steps) {
    test(`nothing moves when it fails while ${when}`, async () => {
      const { t1 } = seatedParty();
      const before = {
        orders: orders(), bills: bills(), sessions: sessions(),
        assignments: assignments(), t1: tableByName("T1"), t2: tableByName("T2"),
      };

      failNextStatementContaining(needle);
      await expect(db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2")).rejects.toThrow();

      expect(orders()).toEqual(before.orders);
      expect(bills()).toEqual(before.bills);
      expect(sessions()).toEqual(before.sessions);
      expect(assignments()).toEqual(before.assignments);
      expect(tableByName("T1")).toEqual(before.t1);
      expect(tableByName("T2")).toEqual(before.t2);
      // Specifically: the party is still whole, at the table they started at.
      expect(orders().every((o) => o.table_id === t1)).toBe(true);
      expect(openSessions()).toHaveLength(1);
      expect(openSessions()[0].table_id).toBe(t1);
    });
  }

  test("the whole move is ONE transaction, and it rolls back", async () => {
    seatedParty();
    failNextStatementContaining('update "tablesessions" set table_id =');
    await expect(db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2")).rejects.toThrow();

    const log = statements();
    const begins = log.filter((l) => l === "begin").length;
    const commits = log.filter((l) => l === "commit").length;
    const rollbacks = log.filter((l) => l === "rollback").length;
    expect(begins).toBe(1);
    expect(commits).toBe(0);
    expect(rollbacks).toBe(1);
    // Every write is inside it — nothing was applied before the BEGIN.
    const firstWrite = log.findIndex((l) => /^(update|insert|delete)/.test(l));
    expect(firstWrite).toBeGreaterThan(log.indexOf("begin"));
  });
});

describe("MoveOrderToTable — one KOT, moved off the wrong table", () => {
  test("the order moves, the source stays seated, the destination is seated", async () => {
    const t4 = addTable({ table_name: "T4", capacity: 4, is_occupied: true, num_covers: 2 });
    const t7 = addTable({ table_name: "T7", capacity: 4 });
    const wrong = addOrder({ table_id: t4.id, food: { total: 450, subtotal: 450, table: "T4", items: [] } });
    const theirs = addOrder({ table_id: t4.id, food: { total: 250, subtotal: 250, table: "T4", items: [] } });

    const res = await db.MoveOrderToTable(RESTAURANT_SLUG, wrong.id, "T7");

    expect(res).toMatchObject({
      from_table: "T4", to_table: "T7", seated_destination: true,
      total_amt: 450, source_now_empty: false,
    });
    expect(orders().find((o) => o.id === wrong.id)).toMatchObject({ table_id: t7.id });
    expect(orders().find((o) => o.id === wrong.id)!.food.table).toBe("T7");
    // The party at T4 is untouched: still seated, still holding their own order.
    expect(tableByName("T4")).toMatchObject({ is_occupied: true, num_covers: 2 });
    expect(orders().find((o) => o.id === theirs.id)).toMatchObject({ table_id: t4.id });
    expect(tableByName("T7")!.is_occupied).toBe(true);
  });

  test("the source is NOT released even when its last order leaves", async () => {
    // The guests are still sitting there. Freeing the table would cancel their
    // session and close their bill over one mis-keyed ticket.
    const t4 = addTable({ table_name: "T4", capacity: 4, is_occupied: true, num_covers: 3 });
    addTable({ table_name: "T7", capacity: 4 });
    const only = addOrder({ table_id: t4.id });

    const res = await db.MoveOrderToTable(RESTAURANT_SLUG, only.id, "T7");

    expect(res.source_now_empty).toBe(true);
    expect(tableByName("T4")).toMatchObject({ is_occupied: true, num_covers: 3 });
    // Their seating is intact, so their covers are still counted once.
    expect(openSessions().filter((s) => s.table_id === t4.id)).toHaveLength(1);
  });

  test("a destination that is ALREADY seated keeps its own head count", async () => {
    // The APC denominator must not be rewritten by a ticket correction.
    const t4 = addTable({ table_name: "T4", capacity: 4, is_occupied: true, num_covers: 2 });
    addTable({ table_name: "T7", capacity: 6, is_occupied: true, num_covers: 5 });
    const wrong = addOrder({ table_id: t4.id });

    const res = await db.MoveOrderToTable(RESTAURANT_SLUG, wrong.id, "T7");

    expect(res.seated_destination).toBe(false);
    expect(tableByName("T7")!.num_covers).toBe(5);
    expect(openSessions().filter((s) => s.table_id === tableByName("T7")!.id)).toHaveLength(1);
  });

  test("both bills are re-summed, and the source keeps its bill row", async () => {
    const t4 = addTable({ table_name: "T4", capacity: 4, is_occupied: true, num_covers: 2 });
    const t7 = addTable({ table_name: "T7", capacity: 4, is_occupied: true, num_covers: 2 });
    const wrong = addOrder({ table_id: t4.id, food: { total: 450, subtotal: 450, table: "T4", items: [] } });
    addBill({ table_id: t4.id, total_amt: 450, bill_no: "B-11" });
    addBill({ table_id: t7.id, total_amt: 0, bill_no: "B-12" });

    await db.MoveOrderToTable(RESTAURANT_SLUG, wrong.id, "T7");

    const t4Bill = bills().find((b) => b.bill_no === "B-11");
    const t7Bill = bills().find((b) => b.bill_no === "B-12");
    // The source's bill is emptied but NOT closed — the party is still there and
    // their bill number, discount and coupon have to survive.
    expect(t4Bill).toMatchObject({ table_id: t4.id, total_amt: 0, closed_at: null });
    expect(t7Bill).toMatchObject({ table_id: t7.id, total_amt: 450 });
  });

  test("a SETTLED order cannot be moved", async () => {
    const t4 = addTable({ table_name: "T4", capacity: 4, is_occupied: true, num_covers: 2 });
    addTable({ table_name: "T7", capacity: 4 });
    const paid = addOrder({ table_id: t4.id, status: "4" });

    await expect(db.MoveOrderToTable(RESTAURANT_SLUG, paid.id, "T7"))
      .rejects.toThrow(/settled or cancelled/);
    expect(orders()[0].table_id).toBe(t4.id);
  });

  test("moving an order to the table it is already on is refused", async () => {
    const t4 = addTable({ table_name: "T4", capacity: 4, is_occupied: true, num_covers: 2 });
    const o = addOrder({ table_id: t4.id });
    await expect(db.MoveOrderToTable(RESTAURANT_SLUG, o.id, "T4")).rejects.toThrow(/already on this table/);
  });

  test("it is atomic too — a failure mid-move leaves the ticket where it was", async () => {
    const t4 = addTable({ table_name: "T4", capacity: 4, is_occupied: true, num_covers: 2 });
    addTable({ table_name: "T7", capacity: 4 });
    const wrong = addOrder({ table_id: t4.id });
    addBill({ table_id: t4.id, total_amt: 500 });
    const before = { orders: orders(), bills: bills(), sessions: sessions(), t4: tableByName("T4"), t7: tableByName("T7") };

    failNextStatementContaining("set is_occupied = true, num_covers = greatest");
    await expect(db.MoveOrderToTable(RESTAURANT_SLUG, wrong.id, "T7")).rejects.toThrow();

    expect(orders()).toEqual(before.orders);
    expect(bills()).toEqual(before.bills);
    expect(sessions()).toEqual(before.sessions);
    expect(tableByName("T4")).toEqual(before.t4);
    expect(tableByName("T7")).toEqual(before.t7);
  });
});
