// CLIENT ITEM 3 — "More than the covers defined on the table, the KOT won't get
// punched."
//
// WHAT THE FLOOR ACTUALLY DID, and why it read as a kitchen failure rather than
// a seating one. T1 is set for 2. Six people sit at it. The waiter opens the
// order pad, types the dishes, hits Send, and the pad asks how many guests —
// six. The pad then does what both clients do, in this order, deliberately
// (order_entry.dart:419, order-pad.tsx:394):
//
//     1. POST /occupy-table  { table_name: "T1", num_covers: 6 }
//     2. POST /orders        { table: "T1", items: [...] }
//
// Step 1 answered 400 "T1 seats up to 2. To seat 6, raise this table's max
// seats …", step 2 was never reached, and the kitchen never got the order. The
// refusal was about SEATING; what the waiter saw was a KOT that would not punch.
// Reproduced against the shipped stack before this fix:
//   POST /occupy-table {"table_name":"T1","num_covers":6}  -> 400
//   PATCH /table-covers {"table_name":"T1","num_covers":6} -> 400 (same sentence)
//   POST /orders {"table":"T1", …}                         -> 201 (never blocked)
//
// THE RULE THIS SUITE PINS. Capacity is a seating guide, not a gate between a
// guest and the kitchen: an over-capacity party is SEATED, its TRUE covers are
// written, and the caller is handed `covers_warning` to show. Two things it must
// not do, both of which would be worse than the bug:
//   * clamp covers down to the table's max — covers is the APC denominator, and
//     six guests recorded as two doubles the APC of every bill on that table;
//   * relax the destination check on MOVE, which refuses for a different reason
//     (see table_move.test.ts: a party may not be moved onto a table that cannot
//     hold it, and that refusal costs the kitchen nothing).

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADMIN_EMP_ID,
  RESTAURANT_SLUG,
  TABLE1_ID,
  addEmployee,
  addTable,
  resetStore,
  tableById,
} from "./table_assignment_fixtures";

jest.mock("pg", () => {
  interface FixtureGlobal {
    __tableAssignFixtureConnect?: () => { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; release: () => void };
  }
  const conn = () => {
    const make = (globalThis as unknown as FixtureGlobal).__tableAssignFixtureConnect;
    if (!make) {throw new Error("table assignment fixture harness was not loaded");}
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

/** The demo floor's T1: capacity 2, max 2 — the table the client reported on. */
beforeEach(() => {
  resetStore();
  addEmployee({ id: ADMIN_EMP_ID, username: "csr_admin", fname: "Admin", lname: "-", roles: { primary: "admin", all: ["admin"] } });
  addTable({ id: TABLE1_ID, table_name: "T1", capacity: 2, max_capacity: 2 });
});

// ---------------------------------------------------------------------------
describe("item 3 — covers never stand between a guest and the kitchen", () => {
  test("REGRESSION: seating six at a two-top succeeds instead of refusing the send", async () => {
    // Pre-fix this rejected with "T1 seats up to 2. To seat 6, raise this
    // table's max seats …" and the order that was queued behind it never left
    // the pad.
    const out = await db.OccupyTable(RESTAURANT_SLUG, "T1", 6, null, ADMIN_EMP_ID);

    expect(out.is_occupied).toBe(true);
    expect(out.num_covers).toBe(6);
  });

  test("the six covers are RECORDED, not rounded down to the table's max", async () => {
    await db.OccupyTable(RESTAURANT_SLUG, "T1", 6, null, ADMIN_EMP_ID);

    // The stored row is what TableSessions.covers mirrors and what every APC
    // reader divides by. Two here would double the APC of the whole party.
    expect(tableById(TABLE1_ID)?.num_covers).toBe(6);
  });

  test("the caller is WARNED — the seating is allowed, but it is not silent", async () => {
    const out = await db.OccupyTable(RESTAURANT_SLUG, "T1", 6, null, ADMIN_EMP_ID);

    expect(out.covers_warning).toEqual(expect.stringContaining("T1"));
    expect(out.covers_warning).toEqual(expect.stringContaining("2"));
    expect(out.covers_warning).toEqual(expect.stringContaining("6"));
  });

  test("BOUNDARY: covers exactly equal to the max is not over capacity and carries no warning", async () => {
    const out = await db.OccupyTable(RESTAURANT_SLUG, "T1", 2, null, ADMIN_EMP_ID);

    expect(out.num_covers).toBe(2);
    expect(out.covers_warning).toBeNull();
  });

  test("BOUNDARY: one over the max is over capacity — seated, recorded, warned", async () => {
    const out = await db.OccupyTable(RESTAURANT_SLUG, "T1", 3, null, ADMIN_EMP_ID);

    expect(out.num_covers).toBe(3);
    expect(tableById(TABLE1_ID)?.num_covers).toBe(3);
    expect(out.covers_warning).not.toBeNull();
  });

  test("the extra chairs a table is allowed to squeeze in still count as within capacity", async () => {
    // max_capacity is the override a manager already has (PATCH /table/:name);
    // it must keep meaning "no warning up to here".
    addTable({ id: "11111111-7777-4777-8777-111111111111", table_name: "T9", capacity: 2, max_capacity: 6 });
    const out = await db.OccupyTable(RESTAURANT_SLUG, "T9", 6, null, ADMIN_EMP_ID);

    expect(out.num_covers).toBe(6);
    expect(out.covers_warning).toBeNull();
  });

  test("the order flow's covers-less re-occupy neither warns nor disturbs the recorded covers", async () => {
    // Every order save re-occupies the table to link the new order id, with no
    // covers at all. It must not invent a warning about a party it never counted.
    await db.OccupyTable(RESTAURANT_SLUG, "T1", 6, null, ADMIN_EMP_ID);
    const linked = await db.OccupyTable(RESTAURANT_SLUG, "T1", null, "order-1", ADMIN_EMP_ID);

    expect(linked.covers_warning).toBeNull();
    expect(linked.num_covers).toBe(6);
    expect(tableById(TABLE1_ID)?.num_covers).toBe(6);
  });
});

// ---------------------------------------------------------------------------
describe("item 3 — correcting the head count on a seated table", () => {
  test("REGRESSION: PATCH /table-covers can raise covers past the table's max", async () => {
    // The other half of the same refusal: the party grew after they sat down, a
    // waiter corrected the count, and the same sentence came back — leaving the
    // bill to be settled against a head count everyone on the floor knew was wrong.
    await db.OccupyTable(RESTAURANT_SLUG, "T1", 2, null, ADMIN_EMP_ID);
    const out = await db.UpdateTableCovers(RESTAURANT_SLUG, "T1", 6);

    expect(out.num_covers).toBe(6);
    expect(tableById(TABLE1_ID)?.num_covers).toBe(6);
    expect(out.covers_warning).not.toBeNull();
  });

  test("a correction back within capacity carries no warning", async () => {
    await db.OccupyTable(RESTAURANT_SLUG, "T1", 6, null, ADMIN_EMP_ID);
    const out = await db.UpdateTableCovers(RESTAURANT_SLUG, "T1", 2);

    expect(out.num_covers).toBe(2);
    expect(out.covers_warning).toBeNull();
  });

  test("a covers figure below one is still rejected — zero guests is not a head count", async () => {
    await expect(db.UpdateTableCovers(RESTAURANT_SLUG, "T1", 0)).rejects.toThrow(/at least 1/);
  });
});

// ---------------------------------------------------------------------------
// The blast radius, held in place by reading the shipped source. These paths
// refuse for reasons that have nothing to do with a KOT, and relaxing them was
// never asked for — table_move.test.ts asserts the move refusal end to end.
describe("item 3 — the seating cap survives everywhere it was not the problem", () => {
  const DB = readFileSync(join(__dirname, "..", "database_supabase.ts"), "utf8");

  /** The body of a top-level `export async function NAME(` / `function NAME(`. */
  const chunk = (name: string): string => {
    const at = DB.search(new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`));
    if (at < 0) {throw new Error(`${name} not found in database_supabase.ts`);}
    const next = DB.slice(at + 1).search(/\n(?:export )?(?:async )?function /);
    return next < 0 ? DB.slice(at) : DB.slice(at, at + 1 + next);
  };

  test("MoveTableParty still refuses a destination that cannot hold the party", () => {
    expect(chunk("MoveTableParty")).toMatch(/assertCoversFitTable\(dst\.table_name/);
  });

  test("SeatWaitlistEntry still refuses to seat a queued party past the table's max", () => {
    expect(chunk("SeatWaitlistEntry")).toMatch(/assertCoversFitTable\(trows\[0\]\.table_name/);
  });

  test("the seating cap is still ONE rule — the throwing form and the warning share a wording", () => {
    // Both come off effectiveMaxCapacity, so "T1 seats up to 2" and the covers
    // warning can never disagree about what the table holds.
    expect(chunk("assertCoversFitTable")).toMatch(/coversOverCapacity\(/);
  });
});
