// THE CANCELLATION SLIP — what the kitchen sees when food stops being cooked
// (requirement A1).
//
// WHY THIS NEEDS ITS OWN TESTS, AND WHY THEY ARE MOSTLY ABOUT NUMBERING.
// Cancelling is instant on every screen and invisible on paper: the KDS card
// goes, the table clears, and the docket stays on the rail, so the dish is
// cooked for a table that has cancelled it. Printing a slip fixes that — but the
// slip is a piece of paper ABOUT ANOTHER piece of paper, and the only handle it
// has on the one it cancels is the KOT number. Which puts it one line away from
// the most dangerous thing in this system to perturb: AllocateKotNumber is
// gapless per outlet-day, and a kitchen calls a ticket BY its number.
//
// So what is pinned here, driven against the REAL AllocateKotNumber, the REAL
// LookupKotNumber and the REAL dispatchKot over the same fixture Pool
// kot_numbering.test.ts uses:
//
//   1. THE SLIP NAMES THE TICKET IT CANCELS. Same number, the big table line,
//      the dishes, and "CANCELLED" where the ordinary "Running Table" context
//      line would be.
//
//   2. IT NEVER MINTS. Not with a resolved number, not without one, and not
//      when the pin handed to it is nonsense — which is the case that separates
//      `neverAllocate` from `pinnedKotNo`, because a null pin on its own falls
//      through to allocation.
//
//   3. NO NUMBER IS BETTER THAN A GUESSED ONE. An unresolvable ticket prints a
//      bare "KOT" heading rather than the next number in the sequence.
//
//   4. IT GOES TO THE KITCHEN COOKING THE FOOD. Routed as kind "kot" with the
//      cancelled line's own station, so cancelling a cocktail reaches the bar
//      and not the bill printer.
//
//   5. THE ORDINARY DOCKET IS UNTOUCHED. `neverAllocate` absent still allocates
//      and still memoises, and a docket with no cancellation flag prints the
//      bytes it printed before this existed.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import {
  OUTLET_ID,
  RESTAURANT_SLUG,
  counters,
  printJobRows,
  resetStore,
  seedMenu,
  tickets,
} from "./kot_number_fixtures";

interface EnqueuedJob {
  outlet_id: string;
  bill_id: string;
  kind: string;
  station: string | null;
  esc_base64: string;
}
// THE SAME ARRAY the fixture appends to, not a copy — see printJobRows.
const enqueued: EnqueuedJob[] = printJobRows;
// Spread the real module and override two, for the reason kot_table_change.test.ts
// spells out: print_routing.ts imports this module's schema-degradation helpers,
// and a factory that omits them fails deep inside a dispatch rather than at import.
jest.mock("../print_jobs.js", () => ({
  ...(jest.requireActual("../print_jobs.js") as Record<string, unknown>),
  enqueuePrintJob: (_resId: string, job: EnqueuedJob): Promise<string> => {
    enqueued.push(job);
    return Promise.resolve(`job-${String(enqueued.length)}`);
  },
  printJobPayload: (p: Record<string, unknown>): Record<string, unknown> => p,
}));

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

beforeEach(() => { resetStore(); enqueued.length = 0; });

/** What the pass can read on a docket: the ESC/POS bytes as printable text. */
const paper = (escBase64: string): string => Buffer.from(escBase64, "base64").toString("utf8");

const TZ = "Asia/Kolkata";
const FIRED = new Date("2026-08-25T06:30:00Z"); // 12:00 on the 25th, IST
const T4 = "table-4";

const ITEMS = [
  { name: "Paneer Tikka", quantity: 2 },
  { name: "Masala Papad", quantity: 1, note: "no onion" },
];

const keyFor = (items = ITEMS, scope: string | null = null) =>
  kp.buildKotTicketKey({ outletId: OUTLET_ID, tableId: T4, items, firedAt: FIRED, tz: TZ, scope });

/**
 * The slip, exactly as dispatchCancellationKot builds it.
 *
 * Spelled out here rather than calling dispatchCancellationKot itself because
 * that function reads settings, the order, the profile and the table's waiter —
 * four reads this fixture Pool does not model. What IS under test is every
 * decision it makes about the DOCKET, and all of those arrive as these
 * arguments. The one thing this cannot pin is the number RESOLUTION, which is a
 * LookupKotNumber call the tests below make directly, in the same order the
 * resolver makes it.
 */
async function slip(kotNo: number | null, items = ITEMS) {
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
    billId: "order-o1",
    restaurantName: "Gaia",
    currency: "₹",
    cols: 48,
    tz: TZ,
    firedAt: FIRED,
    pinnedKotNo: kotNo,
    neverAllocate: true,
    cancelled: true,
    contextLine: "*** CANCELLED ***",
    skipIfTicketed: false,
  });
}

describe("cancelling a ticket the kitchen is holding", () => {
  test("the number the kitchen already has is found by a pure read", async () => {
    seedMenu([]);
    const original = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(), FIRED);
    expect(original).toMatchObject({ kot_no: 1, reused: false });

    // The resolver's second candidate: the whole-order ticket, no scope.
    expect(await db.LookupKotNumber(RESTAURANT_SLUG, keyFor(), FIRED)).toMatchObject({ kot_no: 1 });
    // Asking cost nothing — the counter did not move and no memo row appeared.
    expect(counters()[0]!.seq).toBe(1);
    expect(tickets()).toHaveLength(1);
  });

  test("an added line is found under its OWN scope, which is the ticket it printed as", async () => {
    // POST /orders/:id/items dispatches the added line alone, scoped by the line
    // id — so cancelling that line has to look there FIRST. Under the whole-order
    // key it does not exist, which is the miss this candidate exists to avoid.
    seedMenu([]);
    const added = [{ name: "Gulab Jamun", quantity: 1 }];
    await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(added, "line-7"), FIRED);

    expect(await db.LookupKotNumber(RESTAURANT_SLUG, keyFor(added, "line-7"), FIRED)).toMatchObject({ kot_no: 1 });
    expect(await db.LookupKotNumber(RESTAURANT_SLUG, keyFor(added, null), FIRED)).toBeNull();
  });

  test("the slip says CANCELLED, names the ticket and the table, and lists the dishes", async () => {
    seedMenu([]);
    const original = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(), FIRED);

    const out = await slip(original.kot_no);

    expect(out.tickets).toBe(1);
    expect(out.kotNo).toBe(1);
    const text = paper(enqueued[0]!.esc_base64);
    expect(text).toContain("CANCELLED");
    expect(text).toContain("KOT - 1");
    expect(text).toContain("Table No: T4");
    // The food, so a chef can find the plate that is already on the pass.
    expect(text).toContain("Paneer Tikka");
    expect(text).toContain("Masala Papad");
    // The ordinary context line is REPLACED, not appended: the top line has one
    // job and on this docket it is the cancellation.
    expect(text).not.toContain("Running Table");
  });

  test("printing it burns nothing and memoises nothing", async () => {
    // THE TRAP THIS WHOLE FILE EXISTS FOR. A slip that allocated would put a
    // number in the day's gapless sequence for a docket that orders no food —
    // the pass would count 1, 2, 3 and find only two tickets — and it would
    // memoise the cancelled content, so a re-order of the same food would come
    // back "already ticketed" and never reach the kitchen.
    seedMenu([]);
    await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(), FIRED);
    await slip(1);

    expect(counters()[0]!.seq).toBe(1);
    expect(tickets()).toHaveLength(1);
  });

  test("it is routed as a KOT, to the station cooking the cancelled dish", async () => {
    // Not to the bill printer. Cancelling a cocktail has to reach the bar, which
    // is the whole reason the slip goes through the same station split as the
    // docket it cancels.
    seedMenu([
      { id: "m1", name: "Paneer Tikka", station: "Tandoor" },
      { id: "m2", name: "Masala Papad", station: "Tandoor" },
      { id: "m3", name: "Old Fashioned", station: "Bar" },
    ]);
    await slip(1, [{ name: "Old Fashioned", quantity: 1 }]);

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.kind).toBe("kot");
    expect(enqueued[0]!.station).toBe("Bar");
  });
});

describe("a ticket whose number cannot be resolved", () => {
  test("the lookup answers null and mints nothing", async () => {
    seedMenu([]);
    expect(await db.LookupKotNumber(RESTAURANT_SLUG, keyFor(), FIRED)).toBeNull();
    // Not even a counter row: a question is not an allocation.
    expect(tickets()).toHaveLength(0);
  });

  test("the slip prints WITHOUT a number rather than with the next one", async () => {
    seedMenu([]);
    const out = await slip(null);

    expect(out.kotNo).toBeNull();
    const text = paper(enqueued[0]!.esc_base64);
    // A bare heading. An honest docket with no number beats one naming a ticket
    // that does not exist, which is the number a chef would go looking for.
    expect(text).toContain("KOT");
    expect(text).not.toContain("KOT - ");
    expect(text).toContain("CANCELLED");
    expect(text).toContain("Table No: T4");
    // And the day's sequence is untouched, so the NEXT real order is KOT 1.
    expect(tickets()).toHaveLength(0);
    expect(await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(), FIRED)).toMatchObject({ kot_no: 1 });
  });

  test("a nonsense pin does not fall through to allocation", async () => {
    // THE DIFFERENCE BETWEEN pinnedKotNo AND neverAllocate, in one test. Zero,
    // negative and NaN are not KOT numbers, so dispatchKot ignores the pin — and
    // on every OTHER caller it then allocates one (kot_table_change.test.ts pins
    // exactly that). Here it must not.
    for (const bad of [0, -3, Number.NaN]) {
      resetStore();
      enqueued.length = 0;
      seedMenu([]);
      const out = await slip(bad);
      expect(out.kotNo).toBeNull();
      expect(out.reprint).toBe(false);
      expect(tickets()).toHaveLength(0);
    }
  });
});

describe("the ordinary docket is untouched", () => {
  test("without neverAllocate the same dispatch still mints and memoises", async () => {
    // Guard against the flag leaking into the ordinary path: every other caller
    // must keep minting, or the kitchen stops getting numbered tickets.
    seedMenu([]);
    const out = await kp.dispatchKot({
      restaurantId: RESTAURANT_SLUG,
      outletId: OUTLET_ID,
      tableName: "T4",
      tableId: T4,
      section: null,
      covers: 2,
      isVirtual: false,
      orderType: "dine_in",
      items: ITEMS,
      assignedTo: null,
      captain: null,
      billId: "order-o1",
      restaurantName: "Gaia",
      currency: "₹",
      cols: 48,
      tz: TZ,
      firedAt: FIRED,
    });
    expect(out.kotNo).toBe(1);
    expect(out.reprint).toBe(false);
    expect(tickets()).toHaveLength(1);
    const text = paper(enqueued[0]!.esc_base64);
    expect(text).toContain("Running Table");
    expect(text).not.toContain("CANCELLED");
  });
});
