// MOVING A PRINTED PARTY — client items 1 and 2 (app 2.0.2: a waiter moves
// tables, orange ones included).
//
// THE DEFECT THIS PINS SHUT. A bill printed on a table with no "Bills" row yet
// is filed in the print ledger as `<table>-<epoch>` and counted by the table's
// NAME (bill_print_state.ts). Production GGV filed 23 of its last 30 bill prints
// that way. MoveTableParty carried the orders, the bill row, the seating, the
// waiter, the booking and the OTP — and left those prints behind at the source.
// The printed party arrived at T2 reading "not printed": the orange tile went
// green under a guest already holding paper, and the next print there was an
// unmarked second copy.
//
// Over the REAL MoveTableParty and table_move_fixtures.ts (which models the
// statement's whole predicate, and rolls back like one Postgres connection):
//
//   1. the party's fallback prints follow it — plain and split shapes;
//   2. the PREVIOUS party's prints at the same number stay behind (seating bound);
//   3. a lookalike ("T1-A-…", "T10-…") is never dragged along (exact prefix + shape);
//   4. prints addressed to the bill's id need nothing — the bill row moved;
//   5. the answer says the party was printed;
//   6. the re-key is INSIDE the move's transaction — a later failure undoes it;
//   7. a database with no print ledger still moves the party;
//   8. the DESTINATION's previous party's prints are not the moved party's —
//      even when that party printed after the moved one sat down.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { billPrintJobBelongsToSeating, previousPartyPrintJobId } from "../bill_print_state";
import {
  RESTAURANT_SLUG,
  addBill,
  addOrder,
  addPrintJob,
  addTable,
  dropSessionsFor,
  failNextStatementContaining,
  orders,
  printJobs,
  resetStore,
  setPrintLedgerPresent,
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
  db.resetPrintJobPaperCache();
});

/**
 * A printed party at T1 with NO bill row (the GGV shape): seated 12:00, ordered
 * 12:05, printed 12:30 under the fallback id. T2 is free.
 */
function printedWithoutBillRow(): { t1: string; t2: string } {
  const t1 = addTable({ table_name: "T1", capacity: 4, is_occupied: true, num_covers: 3 });
  const t2 = addTable({ table_name: "T2", capacity: 4 });
  addOrder({ table_id: t1.id, created_at: "2026-09-09T12:05:00.000Z", food: { total: 700, subtotal: 700, table: "T1", items: [] } });
  addPrintJob({ bill_id: "T1-1789545774907", created_at: "2026-09-09T12:30:00.000Z" });
  return { t1: t1.id, t2: t2.id };
}

const ids = (): string[] => printJobs().map((j) => j.bill_id).sort();

describe("a printed party's paper moves with it", () => {
  test("the fallback-addressed print is re-addressed to the destination, and the answer says 'printed'", async () => {
    printedWithoutBillRow();
    const res = await db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2");
    expect(ids()).toEqual(["T2-1789545774907"]);
    expect(res).toMatchObject({ from_table: "T1", to_table: "T2", moved_prints: 1, printed: true });
  });

  test("a SPLIT print filed without a bill row moves too, part by part", async () => {
    printedWithoutBillRow();
    addPrintJob({ bill_id: "T1-split-1of2", created_at: "2026-09-09T12:31:00.000Z" });
    addPrintJob({ bill_id: "T1-split-2of2", created_at: "2026-09-09T12:31:00.000Z" });
    const res = await db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2");
    expect(ids()).toEqual(["T2-1789545774907", "T2-split-1of2", "T2-split-2of2"]);
    expect(res.moved_prints).toBe(3);
  });

  test("the PREVIOUS party's prints at T1 stay at T1 — the seating start bounds the re-key", async () => {
    printedWithoutBillRow();
    // Printed at 09:40, long before this party's first order at 12:05.
    addPrintJob({ bill_id: "T1-1789500000000", created_at: "2026-09-09T09:40:00.000Z" });
    await db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2");
    expect(ids()).toEqual(["T1-1789500000000", "T2-1789545774907"]);
  });

  test("lookalikes are never dragged along: another table's name, or a non-print suffix", async () => {
    printedWithoutBillRow();
    addTable({ table_name: "T10", capacity: 4 });
    addPrintJob({ bill_id: "T10-1789545774999", created_at: "2026-09-09T12:40:00.000Z" }); // table T10
    addPrintJob({ bill_id: "T1-A-1789545774999", created_at: "2026-09-09T12:40:00.000Z" }); // table "T1-A"
    addPrintJob({ bill_id: "T1-1789545774999-nc", created_at: "2026-09-09T12:40:00.000Z" }); // not a fallback shape
    addPrintJob({ bill_id: "T1-1789545775000", kind: "kot", created_at: "2026-09-09T12:40:00.000Z" }); // a docket
    await db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2");
    expect(ids()).toEqual(["T1-1789545774999-nc", "T1-1789545775000", "T1-A-1789545774999", "T10-1789545774999", "T2-1789545774907"]);
    // And both statements (the destination's retirement, then the party's
    // re-key) are the exact-prefix kind, never a LIKE.
    const rekey = statements().filter((q) => q.startsWith('update "printjobs"'));
    expect(rekey).toHaveLength(2);
    for (const q of rekey) {
      expect(q).toContain("starts_with(bill_id, $3)");
      expect(q).not.toMatch(/\blike\b/);
    }
  });

  test("prints addressed to the BILL'S ID need no re-key: the bill row itself moved", async () => {
    const t1 = addTable({ table_name: "T1", capacity: 4, is_occupied: true, num_covers: 2 });
    addTable({ table_name: "T2", capacity: 4 });
    addOrder({ table_id: t1.id, created_at: "2026-09-09T12:05:00.000Z" });
    const bill = addBill({ table_id: t1.id, created_at: "2026-09-09T12:06:00.000Z" });
    addPrintJob({ bill_id: bill.id, created_at: "2026-09-09T12:30:00.000Z" });
    const res = await db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2");
    expect(ids()).toEqual([bill.id]);
    expect(res).toMatchObject({ moved_prints: 0, printed: true, moved_bill: true });
  });

  test("an UNPRINTED party moves exactly as before, and says so", async () => {
    const t1 = addTable({ table_name: "T1", capacity: 4, is_occupied: true, num_covers: 2 });
    addTable({ table_name: "T2", capacity: 4 });
    addOrder({ table_id: t1.id });
    const res = await db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2");
    expect(res).toMatchObject({ moved_prints: 0, printed: false, printed_as: null });
  });

  test("a seated party with no order, no bill and no seating row has nothing to re-key — no ledger statement is issued", async () => {
    addTable({ table_name: "T1", capacity: 4, is_occupied: true, num_covers: 2 });
    addTable({ table_name: "T2", capacity: 4 });
    dropSessionsFor(tableByName("T1")!.id);
    const res = await db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2");
    expect(res.moved_prints).toBe(0);
    expect(statements().filter((q) => q.startsWith('update "printjobs"'))).toEqual([]);
  });

  test("a seated party with no order and no bill is still a SEATING: its prints are bounded by when it sat down", async () => {
    // Seated at 12:00 (the fixture's seating row). A print of T1 at 11:00 was the
    // previous party's; one at 12:30 is this party's paper and moves with it.
    addTable({ table_name: "T1", capacity: 4, is_occupied: true, num_covers: 2 });
    addTable({ table_name: "T2", capacity: 4 });
    const before = addPrintJob({ bill_id: "T1-1789500000000", created_at: "2026-09-09T11:00:00.000Z" });
    const mine = addPrintJob({ bill_id: "T1-1789545000000", created_at: "2026-09-09T12:30:00.000Z" });
    const res = await db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2");
    expect(res.moved_prints).toBe(1);
    expect(printJobs().find((j) => j.id === mine.id)?.bill_id).toBe("T2-1789545000000");
    expect(printJobs().find((j) => j.id === before.id)?.bill_id).toBe("T1-1789500000000");
  });
});

// THE DESTINATION'S HISTORY (review of 2.0.2). The moved party's orders keep
// their created_at, so its seating starts EARLIER than the move. At the
// destination that start used to count every `<dst>-<epoch>` print made after
// it — including the bill of the party that sat there, paid and left in the
// meantime. Production: 4 of the last 12 party moves had that shape (GGV
// 2026-09-10 32A -> 11, 2026-09-14 15 -> 12, 15 -> 14 and 41 -> 15).
describe("the destination's previous party keeps its own prints", () => {
  /** T2's previous party printed at 12:30 — after T1's party ordered at 12:05. */
  function destinationPrintedAfterPartySat(): void {
    addPrintJob({ bill_id: "T2-1789545774907", created_at: "2026-09-09T12:30:00.000Z" });
  }

  test("an UNPRINTED party moved there arrives unprinted — no orange tile, no next-party seat", async () => {
    const t1 = addTable({ table_name: "T1", capacity: 4, is_occupied: true, num_covers: 2 });
    addTable({ table_name: "T2", capacity: 4 });
    addOrder({ table_id: t1.id, created_at: "2026-09-09T12:05:00.000Z" });
    destinationPrintedAfterPartySat();
    const res = await db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2");
    // printed:false is what keeps POST /tables/move from opening "T2 #2".
    expect(res).toMatchObject({ to_table: "T2", moved_prints: 0, printed: false, printed_as: null });
    expect(ids()).toEqual([previousPartyPrintJobId("T2-1789545774907")]);
    // ...and the retired id is no seating's print, T2's included.
    const seating = { open_bill_id: null, table_name: "T2", seating_start: "2026-09-09T12:05:00.000Z" };
    expect(billPrintJobBelongsToSeating({ bill_id: ids()[0], created_at: "2026-09-09T12:30:00.000Z" }, seating)).toBe(false);
  });

  test("a PRINTED party moved there counts only its own paper", async () => {
    printedWithoutBillRow(); // T1-… at 12:30
    addPrintJob({ bill_id: "T2-1789546000000", created_at: "2026-09-09T12:40:00.000Z" }); // T2's previous party
    const res = await db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2");
    expect(res).toMatchObject({ moved_prints: 1, printed: true });
    expect(ids()).toEqual([previousPartyPrintJobId("T2-1789546000000"), "T2-1789545774907"].sort());
  });

  test("the retirement runs BEFORE the re-key, so the party's own prints are never retired with it", async () => {
    printedWithoutBillRow();
    destinationPrintedAfterPartySat();
    await db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2");
    const updates = statements().filter((q) => q.startsWith('update "printjobs"'));
    expect(updates[0]).toMatch(/^update "printjobs" set bill_id = \$4 \|\| bill_id /);
    expect(updates[1]).toMatch(/^update "printjobs" set bill_id = \$4 \|\| substr\(bill_id/);
    expect(ids()).toContain("T2-1789545774907");
  });

  test("the destination's OLDER prints, its lookalikes and its other kinds are left exactly as they were", async () => {
    printedWithoutBillRow();
    addTable({ table_name: "T2-A", capacity: 4 });
    addPrintJob({ bill_id: "T2-1789400000000", created_at: "2026-09-09T09:00:00.000Z" }); // before the party sat
    addPrintJob({ bill_id: "T2-A-1789546000000", created_at: "2026-09-09T12:40:00.000Z" }); // table "T2-A"
    addPrintJob({ bill_id: "T2-1789546000001", kind: "kot", created_at: "2026-09-09T12:40:00.000Z" }); // a docket
    addPrintJob({ bill_id: "T2-split-1of2", created_at: "2026-09-09T12:41:00.000Z" }); // previous party's split: retired
    await db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2");
    expect(ids()).toEqual([
      previousPartyPrintJobId("T2-split-1of2"),
      "T2-1789400000000", "T2-1789545774907", "T2-1789546000001", "T2-A-1789546000000",
    ].sort());
  });

  test("a move that fails later puts the destination's prints back too", async () => {
    printedWithoutBillRow();
    destinationPrintedAfterPartySat();
    failNextStatementContaining("set is_occupied = false");
    await expect(db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2")).rejects.toThrow();
    expect(ids()).toEqual(["T1-1789545774907", "T2-1789545774907"]);
  });
});

describe("the re-key is part of the move — all or nothing", () => {
  test("a failure AFTER the re-key (freeing the source) puts the prints back where they were", async () => {
    printedWithoutBillRow();
    failNextStatementContaining("set is_occupied = false");
    await expect(db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2")).rejects.toThrow();
    expect(ids()).toEqual(["T1-1789545774907"]);
    expect(orders().every((o) => o.table_id === tableByName("T1")!.id)).toBe(true);
  });

  test("a failing re-key (not a missing ledger) fails the whole move: a printed party must not arrive unprinted", async () => {
    printedWithoutBillRow();
    failNextStatementContaining('update "printjobs"');
    await expect(db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2")).rejects.toThrow();
    expect(ids()).toEqual(["T1-1789545774907"]);
    expect(tableByName("T1")!.is_occupied).toBe(true);
    expect(tableByName("T2")!.is_occupied).toBe(false);
  });

  test("a database with NO print ledger (027 unapplied) still moves the party — in a savepoint", async () => {
    printedWithoutBillRow();
    setPrintLedgerPresent(false);
    const res = await db.MoveTableParty(RESTAURANT_SLUG, "T1", "T2");
    expect(res).toMatchObject({ to_table: "T2", moved_prints: 0, printed: false });
    expect(tableByName("T2")!.is_occupied).toBe(true);
    const log = statements();
    const save = log.indexOf("savepoint move_party_print_rekey");
    expect(save).toBeGreaterThan(log.indexOf("begin"));
    expect(log.indexOf("rollback to savepoint move_party_print_rekey")).toBeGreaterThan(save);
    expect(log.filter((l) => l === "commit")).toHaveLength(1);
  });
});
