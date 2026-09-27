// ROUND 4 ITEM 2 — "changes should be made accordingly for the reprint of that
// edited KOT too."
//
// ============================================================================
// WHAT WAS ACTUALLY WRONG, AND WHY IT IS NOT WHAT IT LOOKS LIKE
// ============================================================================
// The CONTENT of the reprint was already right. POST /print/kot/order/:id
// builds its docket from GetOrderKotContext, which reads "Orders".food live, so
// a dish taken off by POST /bills/remove-item was gone from the paper the moment
// it was gone from the bill. Nothing replayed a stored original.
//
// The NUMBER was wrong, and that is worse. The number came from
// allocateKotNumber against the ticket key — a fingerprint of the item SET — so
// the instant one line left, the key stopped matching and the "reprint" minted
// the next gapless number. Measured against the live stack on 2026-09-27, one
// ticket of three dishes:
//
//     punch                 -> KOT-12
//     reprint (unchanged)   -> KOT-12, reprint:true        correct
//     remove one dish       -> CANCELLED slip for KOT-12   correct
//     reprint               -> KOT-13, reprint:false       <- a NEW TICKET
//     remove another        -> CANCELLED slip for KOT-13   <- names the wrong paper
//     reprint               -> KOT-14, reprint:false
//
// The pass holding KOT-12 is handed a KOT-13 listing the surviving dishes. That
// is not a correction, it is a second order for food already being cooked —
// exactly the defect the client reported for table moves in round 3 item 6,
// arriving through a different door. And because each mint MEMOISES the edited
// set, the next removal's CANCELLED slip resolves to the ticket the reprint had
// just invented instead of the paper on the rail.
//
// ============================================================================
// WHAT IS PINNED HERE
// ============================================================================
//   1. THE REPRINT OF AN EDITED TICKET IS STILL THAT TICKET. Same number, one
//      removal or two, and the removed dishes are off the paper.
//   2. IT MINTS NOTHING. The day's counter does not move and no memo row
//      appears, so the number the kitchen counts by stays gapless and honest.
//   3. AN UNCHANGED REPRINT IS BYTE-FOR-BYTE WHAT IT WAS.
//   4. THE LAST LINE. A ticket with nothing left does not reprint at all.
//   5. THE CANCELLED SLIP FROM #28 IS UNCHANGED, and the number on it now
//      survives a second removal.
//
// Driven against the REAL AllocateKotNumber / LookupKotNumber / dispatchKot /
// GetOrderKotNumbers over the same fixture Pool kot_numbering.test.ts uses, and
// the words are read back off the bitmap the printer is actually handed.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OUTLET_ID,
  RESTAURANT_SLUG,
  counters,
  printJobRows,
  resetStore,
  seedMenu,
  tickets,
} from "./kot_number_fixtures";
import { kotPaper } from "./kot_raster_read";

// THE SAME ARRAY the fixture appends to, not a copy — see printJobRows.
const enqueued = printJobRows;

jest.mock("pg", () => {
  interface FixtureGlobal {
    __kotFixtureConnect?: () => { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; release: () => void };
  }
  const conn = () => {
    const make = (globalThis as unknown as FixtureGlobal).__kotFixtureConnect;
    if (!make) {throw new Error("kot numbering fixture harness was not loaded");}
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
type KotPrint = typeof import("../kot_print");
let db: Db;
let kp: KotPrint;

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
  kp = await import("../kot_print");
});

beforeEach(() => {
  resetStore();
  enqueued.length = 0;
  // Migration 043 is applied here, which is what makes "PrintJobs".kot_no
  // readable — the whole mechanism under test. The false side has its own test
  // at the foot of this file.
  db.__kotNumberLinkTestSeam.setSchemaReady(true);
});

const TZ = "Asia/Kolkata";
const FIRED = new Date("2026-08-25T06:30:00Z"); // 12:00 on the 25th, IST
const T4 = "table-4";
const ORDER = "o-47";

/** The ticket as it was punched: three dishes on one order. */
const WHOLE = [
  { name: "Paneer Tikka", quantity: 2 },
  { name: "Tandoori Roti", quantity: 1, note: "extra butter" },
  { name: "Dark Chocolate Mousse", quantity: 1 },
];
/** After the Roti is removed. */
const AFTER_ONE = [WHOLE[0]!, WHOLE[2]!];
/** After the Mousse goes too. */
const AFTER_TWO = [WHOLE[0]!];

const keyFor = (items = WHOLE, scope: string | null = null) =>
  kp.buildKotTicketKey({ outletId: OUTLET_ID, tableId: T4, items, firedAt: FIRED, tz: TZ, scope });

/**
 * A docket for this order, exactly as POST /print/kot/order/:id dispatches one.
 *
 * `onPaper` is what the route now resolves through kotNumberOnPaperForOrder and
 * spreads in; passing null is the route as it stood before this change, which is
 * how the tests below show the defect and the fix side by side over the same
 * code path rather than over a description of it.
 */
async function reprint(items: { name: string; quantity: number; note?: string }[], onPaper: number | null) {
  return kp.dispatchKot({
    restaurantId: RESTAURANT_SLUG,
    outletId: OUTLET_ID,
    tableName: "T4",
    tableId: T4,
    section: null,
    covers: 2,
    isVirtual: false,
    orderType: "dine_in",
    items,
    assignedTo: null,
    captain: null,
    orderNote: null,
    billId: `order-${ORDER}`,
    restaurantName: "Gaia",
    currency: "₹",
    cols: 48,
    tz: TZ,
    firedAt: FIRED,
    ...(onPaper !== null ? { pinnedKotNo: onPaper, neverAllocate: true } : {}),
  });
}

/** The punch: what autoPrintOrderKot puts on the pass when the order is placed. */
async function punch() {
  seedMenu([]);
  return reprint(WHOLE, null);
}

const paper = (escBase64: string): string => kotPaper(escBase64, 48);
const lastPaper = (): string => paper(enqueued.at(-1)!.esc_base64);

// ---------------------------------------------------------------------------
// 1. The defect, in the terms the live stack showed it in.
// ---------------------------------------------------------------------------

describe("the ticket key cannot name an edited ticket", () => {
  test("a removal changes the fingerprint, so allocating again MINTS rather than reuses", async () => {
    // This is the whole mechanism of the bug in two lines. It is asserted, not
    // narrated, because the fix is built on it being true: if a removal ever
    // stopped moving the key, the pin below would be redundant rather than
    // load-bearing and a future reader deserves to be told which.
    const punched = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(WHOLE), FIRED);
    expect(punched).toMatchObject({ kot_no: 1, reused: false });
    expect(await db.LookupKotNumber(RESTAURANT_SLUG, keyFor(AFTER_ONE), FIRED)).toBeNull();

    const reallocated = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(AFTER_ONE), FIRED);
    expect(reallocated).toMatchObject({ kot_no: 2, reused: false });
  });

  test("the reprint the route used to make: a second number, and the kitchen is never told it is a reprint", async () => {
    await punch();
    expect(enqueued.at(-1)!.kot_no).toBe(1);

    // Exactly the old call — no pin, so dispatchKot allocates against the
    // edited set. THE REPORTED BEHAVIOUR.
    const stale = await reprint(AFTER_ONE, null);
    expect(stale.kotNo).toBe(2);
    expect(stale.reprint).toBe(false);
    expect(lastPaper()).toContain("KOT - 2");
    // And the sequence the kitchen counts by has been spent on a ticket that
    // does not exist.
    expect(counters()[0]!.seq).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. The fix: the number is READ BACK, not minted.
// ---------------------------------------------------------------------------

describe("the number already on the paper is readable after an edit", () => {
  test("kotNumberOnPaperForOrder answers from PrintJobs, which an edit cannot move", async () => {
    await punch();
    // The key has stopped matching; the print queue has not.
    expect(await db.LookupKotNumber(RESTAURANT_SLUG, keyFor(AFTER_ONE), FIRED)).toBeNull();
    expect(await kp.kotNumberOnPaperForOrder(RESTAURANT_SLUG, ORDER)).toBe(1);
  });

  test("it is a pure read — nothing minted, nothing memoised", async () => {
    await punch();
    await kp.kotNumberOnPaperForOrder(RESTAURANT_SLUG, ORDER);
    expect(counters()[0]!.seq).toBe(1);
    expect(tickets()).toHaveLength(1);
  });

  test("an order that has never been ticketed has no number, and says so", async () => {
    seedMenu([]);
    expect(await kp.kotNumberOnPaperForOrder(RESTAURANT_SLUG, "o-never")).toBeNull();
  });

  test("THE FIRST number, not the last: an added line's own docket does not rename the ticket", async () => {
    // POST /orders/:id/items prints the added line alone, scoped by its id, and
    // that docket is enqueued under the SAME bill_id. The pass still calls the
    // ticket by the number on its placement docket, so that is the one a whole
    // ticket reprints under.
    await punch();
    await kp.dispatchKot({
      restaurantId: RESTAURANT_SLUG, outletId: OUTLET_ID, tableName: "T4", tableId: T4,
      section: null, covers: 2, isVirtual: false, orderType: "dine_in",
      items: [{ name: "Gulab Jamun", quantity: 1 }], assignedTo: null, captain: null,
      billId: `order-${ORDER}`, restaurantName: "Gaia", currency: "₹", cols: 48, tz: TZ,
      firedAt: FIRED, scope: "line-7",
    });
    expect(enqueued.at(-1)!.kot_no).toBe(2);
    expect(await kp.kotNumberOnPaperForOrder(RESTAURANT_SLUG, ORDER)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. The paper the kitchen is handed.
// ---------------------------------------------------------------------------

describe("reprinting an edited KOT", () => {
  test("after ONE removal: the same number, and the removed dish is off the paper", async () => {
    await punch();
    const onPaper = await kp.kotNumberOnPaperForOrder(RESTAURANT_SLUG, ORDER);

    const out = await reprint(AFTER_ONE, onPaper);

    expect(out.kotNo).toBe(1);
    // `reprint:true` is what both clients turn into "KOT-1 sent again" rather
    // than announcing a new ticket to the floor.
    expect(out.reprint).toBe(true);
    const text = lastPaper();
    expect(text).toContain("KOT - 1");
    expect(text).toContain("Table No: T4");
    expect(text).toContain("Paneer Tikka");
    expect(text).toContain("Dark Chocolate Mousse");
    // THE POINT OF THE WHOLE ITEM: the dish the admin took off the ticket is
    // not on the ticket.
    expect(text).not.toContain("Tandoori Roti");
    // And it is not a cancellation — this is the live ticket, not a correction.
    expect(text).not.toContain("CANCELLED");
  });

  test("after TWO removals: still the same number, and both dishes are gone", async () => {
    await punch();
    const first = await reprint(AFTER_ONE, await kp.kotNumberOnPaperForOrder(RESTAURANT_SLUG, ORDER));
    expect(first.kotNo).toBe(1);

    // The number is resolved again from scratch, exactly as the route does on
    // every press — a reprint must not depend on the previous reprint.
    const second = await reprint(AFTER_TWO, await kp.kotNumberOnPaperForOrder(RESTAURANT_SLUG, ORDER));
    expect(second).toMatchObject({ kotNo: 1, reprint: true });
    const text = lastPaper();
    expect(text).toContain("KOT - 1");
    expect(text).toContain("Paneer Tikka");
    expect(text).not.toContain("Tandoori Roti");
    expect(text).not.toContain("Dark Chocolate Mousse");
  });

  test("no number is burned, however many times it is reprinted", async () => {
    await punch();
    for (const items of [AFTER_ONE, AFTER_TWO, AFTER_TWO]) {
      await reprint(items, await kp.kotNumberOnPaperForOrder(RESTAURANT_SLUG, ORDER));
    }
    // The day's sequence stopped at the punch, and the memo still holds exactly
    // the one ticket that was actually punched.
    expect(counters()[0]!.seq).toBe(1);
    expect(tickets()).toHaveLength(1);
    expect(tickets()[0]!.ticket_key).toBe(keyFor(WHOLE));
    // Every docket that went out carried the one number.
    expect(enqueued.map((j) => j.kot_no)).toEqual([1, 1, 1, 1]);
  });

  test("an UNCHANGED reprint is what it always was — same number, same bytes", async () => {
    await punch();
    const original = enqueued.at(-1)!.esc_base64;

    const out = await reprint(WHOLE, await kp.kotNumberOnPaperForOrder(RESTAURANT_SLUG, ORDER));

    expect(out).toMatchObject({ kotNo: 1, reprint: true });
    // Byte-for-byte, not merely equivalent-looking: the reference docket is a
    // bitmap, and "the same docket" is a claim about the paper.
    expect(enqueued.at(-1)!.esc_base64).toBe(original);
  });

  test("the station split still shares the one number", async () => {
    seedMenu([
      { id: "m1", name: "Paneer Tikka", station: "TANDOOR" },
      { id: "m2", name: "Tandoori Roti", station: "TANDOOR" },
      { id: "m3", name: "Dark Chocolate Mousse", station: "PASTRY" },
    ]);
    await reprint(WHOLE, null);
    expect(enqueued).toHaveLength(2);
    const punched = enqueued.length;

    // The Roti goes; the TANDOOR ticket shrinks, PASTRY is untouched, and both
    // dockets still carry the ticket's one number.
    const out = await reprint(AFTER_ONE, await kp.kotNumberOnPaperForOrder(RESTAURANT_SLUG, ORDER));
    expect(out.kotNo).toBe(1);
    const again = enqueued.slice(punched);
    expect(again.map((j) => j.station).sort()).toEqual(["PASTRY", "TANDOOR"]);
    expect(again.every((j) => j.kot_no === 1)).toBe(true);
    const tandoor = paper(again.find((j) => j.station === "TANDOOR")!.esc_base64);
    expect(tandoor).toContain("Paneer Tikka");
    expect(tandoor).not.toContain("Tandoori Roti");
  });
});

// ---------------------------------------------------------------------------
// 4. The last line off the ticket.
// ---------------------------------------------------------------------------

describe("when every dish has been taken off the KOT", () => {
  test("the route refuses to reprint, and says which of the two reasons it is", async () => {
    // THE DECISION, stated here because it is a judgement and not a mechanism:
    // there is nothing to reprint. RemoveBillItem flips an emptied order to
    // Cancelled(5) and the pass has already been handed the CANCELLED slip for
    // the last dish, so the ticket is dead. Re-issuing an EMPTY docket under its
    // number would put a piece of paper on the rail that looks like an order and
    // asks for nothing — the one thing worse than no paper.
    const src = readFileSync(join(__dirname, "..", "routes", "bills.ts"), "utf8");
    const handler = src.slice(src.indexOf("app.post('/print/kot/order/:id'"));
    expect(handler.slice(0, 2000)).toContain("order.items.length === 0");
    expect(handler.slice(0, 2000)).toContain("nothing to reprint");
  });

  test("the guard is the ONLY thing stopping a blank docket, which is why it is a guard", async () => {
    // The renderer does not refuse an empty item list — it lays out a perfectly
    // well-formed docket with a heading, a table number and no food, and the
    // queue takes it. So "nothing to reprint" cannot be left to fall out of the
    // layers below: it is a decision, and it is made at the door.
    seedMenu([]);
    const out = await reprint([], null);
    expect(out.tickets).toBe(1);
    expect(paper(enqueued.at(-1)!.esc_base64)).toContain("Table No: T4");
  });
});

// ---------------------------------------------------------------------------
// 5. The CANCELLED slip from PR #28 — unchanged, and now numbered on the
//    second removal as well.
// ---------------------------------------------------------------------------

describe("the cancellation slip", () => {
  test("still resolves through the ticket key first, which is unchanged", async () => {
    await punch();
    const order = { order_id: ORDER, outlet_id: OUTLET_ID, table_id: T4, items: WHOLE } as never;
    // The pre-read the route makes: the order as it stood BEFORE the line left.
    expect(await kp.resolveCancelledKotNumber(RESTAURANT_SLUG, order, {
      cancelledLines: [WHOLE[1]!], itemId: "r2", firedAt: FIRED, tz: TZ,
    })).toBe(1);
  });

  test("a SECOND removal is no longer unnumbered — PrintJobs answers what the key cannot", async () => {
    await punch();
    // One dish has already gone, so the order's item set no longer hashes to
    // the ticket it was minted under and the key candidates both miss.
    const edited = { order_id: ORDER, outlet_id: OUTLET_ID, table_id: T4, items: AFTER_ONE } as never;
    expect(await kp.resolveCancelledKotNumber(RESTAURANT_SLUG, edited, {
      cancelledLines: [AFTER_ONE[1]!], itemId: "m3", firedAt: FIRED, tz: TZ,
    })).toBeNull();
    // …and the fallback the slip now makes finds the paper that is on the rail.
    expect(await kp.kotNumberOnPaperForOrder(RESTAURANT_SLUG, ORDER)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. The unmigrated deployment.
// ---------------------------------------------------------------------------

describe("a deployment where migration 043 has not been applied", () => {
  test("no number is readable, and the reprint allocates exactly as it did before", async () => {
    await punch();
    db.__kotNumberLinkTestSeam.setSchemaReady(false);

    expect(await kp.kotNumberOnPaperForOrder(RESTAURANT_SLUG, ORDER)).toBeNull();
    // Which is the route's `onPaper === null` arm: no pin, today's behaviour to
    // the character. A tenant without 043 is no worse off than it is now.
    const out = await reprint(WHOLE, null);
    expect(out).toMatchObject({ kotNo: 1, reprint: true });
  });
});
