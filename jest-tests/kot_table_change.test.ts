// THE CORRECTION DOCKET — what the kitchen sees when an order is moved to
// another table (item 22).
//
// WHY THIS NEEDS ITS OWN TESTS. Moving an order is instant and complete on every
// SCREEN; paper does not re-render. If the docket has already printed, the pass
// is holding a ticket that says T4 for food going to T7, and the system now
// believes the wrong ticket is right — which is worse than the mis-key that
// started it, because nobody is looking for it any more.
//
// What is pinned here, driven against the REAL AllocateKotNumber, the REAL
// LookupKotNumber and the REAL dispatchKot over the same fixture Pool
// kot_numbering.test.ts uses:
//
//   1. AN ALREADY-TICKETED ORDER GETS PAPER, and that paper carries the NEW
//      table in the big type, the OLD table in the context line, and THE SAME
//      KOT NUMBER — which is the only thing that lets a chef pair the two
//      pieces of paper.
//
//   2. AN ORDER THE KITCHEN NEVER SAW GETS NOTHING, and — the part that would
//      be easy to get wrong — asking the question does not BURN a number. A
//      lookup that allocated would leave a hole in the day's gapless sequence
//      for a docket that was never printed.
//
//   3. THE CORRECTION DOES NOT BECOME THE NEW TICKET. It must not memoise the
//      new table's fingerprint, or the order's own docket (when it finally
//      prints at the right table) would come back "already ticketed" and the
//      kitchen would never get it.

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
import { kotPaper } from "./kot_raster_read";

interface EnqueuedJob {
  outlet_id: string;
  bill_id: string;
  kind: string;
  station: string | null;
  esc_base64: string;
}
// The rows the queue was actually handed. THE SAME ARRAY the fixture appends to,
// not a copy — see printJobRows, which explains why the old print_jobs mock stopped
// seeing anything when the producers moved to dispatchPrintJob.
const enqueued: EnqueuedJob[] = printJobRows;
// SPREAD THE REAL MODULE, OVERRIDE TWO. A bare object here used to be enough,
// because dispatchKot only ever reached for enqueuePrintJob and printJobPayload.
// Since migration 042 it goes through print_routing.ts, which imports this
// module's schema-degradation helpers (isSchemaMissing, warnSchemaMissing and
// their routing supersets) — and a factory that omits them does not fail at
// import time, it fails deep inside a dispatch with "is not a function", which
// reads like a broken feature rather than a stale mock. Spreading the real
// module means the next import this file grows is covered before anyone notices.
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

/**
 * WHAT THE PASS CAN READ ON A DOCKET.
 *
 * It used to be `Buffer.from(b64,"base64").toString("utf8")`, which worked only
 * while the docket was ESC/POS TEXT. The docket a restaurant prints by default
 * is now the reference one — proportional type drawn as a GS v 0 raster — so
 * this reads the words back off the bitmap by matching the committed glyph
 * atlas (jest-tests/kot_raster_read.ts), and falls back to the plain decode for
 * a restaurant on 'classic'.
 *
 * The assertions below are unchanged, and deliberately so: they are questions
 * about the paper the kitchen is handed, and they are still asked of the paper
 * the kitchen is actually handed rather than of a model of it.
 */
const paper = (escBase64: string): string => kotPaper(escBase64, 48);

const TZ = "Asia/Kolkata";
const FIRED = new Date("2026-08-25T06:30:00Z"); // 12:00 on the 25th, IST
const T4 = "table-4";
const T7 = "table-7";

const ITEMS = [
  { name: "Paneer Tikka", quantity: 2 },
  { name: "Masala Papad", quantity: 1, note: "no onion" },
];

const keyFor = (tableId: string) =>
  kp.buildKotTicketKey({ outletId: OUTLET_ID, tableId, items: ITEMS, firedAt: FIRED, tz: TZ });

/** The correction docket, exactly as kot_move.ts builds it. */
async function correction(kotNo: number, wasTable: string) {
  return kp.dispatchKot({
    restaurantId: RESTAURANT_SLUG,
    outletId: OUTLET_ID,
    tableName: "T7",
    tableId: T7,
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
    pinnedKotNo: kotNo,
    contextLine: `*** TABLE CHANGED - WAS ${wasTable} ***`,
    skipIfTicketed: false,
  });
}

describe("an order the kitchen already has", () => {
  test("the lookup finds the number on the pass without minting a new one", async () => {
    seedMenu([]);
    // The original docket, printed for T4.
    const first = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(T4), FIRED);
    expect(first).toMatchObject({ kot_no: 1, reused: false });

    const found = await db.LookupKotNumber(RESTAURANT_SLUG, keyFor(T4), FIRED);
    expect(found).toMatchObject({ kot_no: 1 });
    // The day's counter did not move and no second memo row appeared: asking
    // "does the kitchen have this?" costs nothing.
    expect(counters()[0]!.seq).toBe(1);
    expect(tickets()).toHaveLength(1);
  });

  test("the correction names the new table BIG, the old one at the top, and keeps the number", async () => {
    seedMenu([]);
    const original = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(T4), FIRED);

    const out = await correction(original.kot_no, "T4");

    expect(out.tickets).toBe(1);
    expect(out.kotNo).toBe(1);
    // Reported as a reprint, because that is what it is: this number has been on
    // paper before.
    expect(out.reprint).toBe(true);
    const text = paper(enqueued[0]!.esc_base64);
    // FLATTENED, because the correction's context line is longer than the
    // reference docket's type lets one line be, and it wraps. That is the
    // accepted trade of the bigger type the client asked for twice — the words
    // are all there, and a chef reads a wrapped line fine. What would not be
    // fine is any of them MISSING, which is what these assert.
    const flat = text.replace(/\s+/g, " ");
    // The three things a chef has to read off it.
    expect(flat).toContain("TABLE CHANGED - WAS T4");
    expect(flat).toContain("KOT - 1");
    expect(flat).toContain("Table No: T7");
    // And the food, so the docket stands on its own if the old one is binned.
    expect(flat).toContain("Paneer Tikka");
    expect(flat).toContain("no onion");
    // The ordinary "Running Table" context line is REPLACED, not appended: the
    // top line has one job and it is now the correction.
    expect(text).not.toContain("Running Table");
  });

  test("printing the correction does not burn a number or memoise the new table", async () => {
    seedMenu([]);
    await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(T4), FIRED);
    await correction(1, "T4");

    // THE TRAP. If the correction had allocated against the NEW table's
    // fingerprint, the order's own docket at T7 would later come back "already
    // ticketed" and the kitchen would never be told about it properly — and the
    // day's sequence would carry a number nobody can find on paper.
    expect(counters()[0]!.seq).toBe(1);
    expect(tickets()).toHaveLength(1);
    expect(await db.LookupKotNumber(RESTAURANT_SLUG, keyFor(T7), FIRED)).toBeNull();
  });

  test("a second correction of the same move prints the same number again", async () => {
    // The pass jams, somebody presses it again. skipIfTicketed is deliberately
    // false for a correction, so it reprints rather than silently doing nothing.
    seedMenu([]);
    await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(T4), FIRED);
    const a = await correction(1, "T4");
    const b = await correction(1, "T4");
    expect(a.kotNo).toBe(1);
    expect(b.kotNo).toBe(1);
    expect(b.skipped).toBe(false);
    expect(enqueued).toHaveLength(2);
    expect(counters()[0]!.seq).toBe(1);
  });
});

describe("an order the kitchen has never seen", () => {
  test("the lookup answers null and mints nothing", async () => {
    seedMenu([]);
    expect(await db.LookupKotNumber(RESTAURANT_SLUG, keyFor(T4), FIRED)).toBeNull();
    // No counter row was even created: a question is not an allocation.
    expect(tickets()).toHaveLength(0);
  });

  test("and its docket, when it finally prints at the RIGHT table, is number 1", async () => {
    // The consequence of printing nothing on the move: the order still gets its
    // first ticket in the ordinary way, at the table it is actually on, at the
    // front of the day's sequence rather than behind a burnt number.
    seedMenu([]);
    const later = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(T7), FIRED);
    expect(later).toMatchObject({ kot_no: 1, reused: false });
  });
});

describe("the pinned number is narrow on purpose", () => {
  test("without it, the same dispatch allocates normally", async () => {
    // Guard against pinnedKotNo leaking into the ordinary path: every other
    // caller must still mint and memoise.
    seedMenu([]);
    const out = await kp.dispatchKot({
      restaurantId: RESTAURANT_SLUG,
      outletId: OUTLET_ID,
      tableName: "T7",
      tableId: T7,
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
    // ...and with no contextLine it is the ordinary running-table docket.
    expect(paper(enqueued[0]!.esc_base64)).toContain("Running Table");
  });

  test("a nonsense pinned number is ignored rather than printed", async () => {
    // Zero, negative and NaN are not KOT numbers. Printing one would put a
    // docket on the pass that names a ticket nobody can find.
    seedMenu([]);
    for (const bad of [0, -3, Number.NaN]) {
      resetStore();
      enqueued.length = 0;
      seedMenu([]);
      const out = await correction(bad, "T4");
      expect(out.kotNo).toBe(1); // allocated normally instead
      expect(out.reprint).toBe(false);
    }
  });
});
