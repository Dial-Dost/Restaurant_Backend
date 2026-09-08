// Auto-printing the kitchen docket when an order is barked.
//
// THE DEFECT THIS CLOSES. Barking stamps "Orders".barked_at and rebases every
// prep timer — the kitchen clock starts there — but nothing was printed. Someone
// had to remember to press Print KOT afterwards, and on a busy pass that is the
// thing that gets forgotten: every timer in the system says the order is in the
// kitchen and there is no paper on the pass saying so.
//
// THE TRAP THE FIX HAS TO SURVIVE is KOT numbering. AllocateKotNumber is
// per-outlet, per-business-day and gapless, and "KotTickets" memoises one
// content fingerprint to one number FOR EVER so a reprint is idempotent. Auto
// printing must not mint a second number for an order that already has one, and
// barking twice must not put two differently-numbered dockets on the pass.
//
// Driven against the REAL AllocateKotNumber over the same fixture Pool
// kot_numbering.test.ts uses, so what is under test is the SQL and the real key
// derivation — not a restatement of either.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import {
  OUTLET_ID,
  RESTAURANT_SLUG,
  counters,
  resetStore,
  seedMenu,
  tickets,
} from "./kot_number_fixtures";

/**
 * The durable print queue, replaced by a recorder.
 *
 * NOT because the queue is uninteresting — print_jobs.test.ts drives the real
 * statements over its own fixture — but because what is under test HERE is what
 * dispatchKot HANDS it: how many dockets one bark produces, which stations they
 * carry, and whether a second bark produces different paper. Recording the
 * argument list answers all three exactly; letting it reach SQL would only add a
 * second fixture's worth of noise to the failure message when it breaks.
 */
interface EnqueuedJob {
  outlet_id: string;
  bill_id: string;
  kind: string;
  station: string | null;
  esc_base64: string;
}
const enqueued: EnqueuedJob[] = [];
jest.mock("../print_jobs.js", () => ({
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
const TABLE = "table-12";

/** The starters, as they sit on order A. */
const STARTERS = [
  { name: "Paneer Tikka", quantity: 2 },
  { name: "Masala Papad", quantity: 1, note: "no onion" },
];
/** The mains, as they sit on order B — a SECOND order on the SAME table. */
const MAINS = [
  { name: "Dal Makhani", quantity: 1 },
  { name: "Butter Naan", quantity: 4 },
];

const keyFor = (items: { name: string; quantity: number; note?: string }[], tableId = TABLE) =>
  kp.buildKotTicketKey({ outletId: OUTLET_ID, tableId, items, firedAt: FIRED, tz: TZ });

// ---------------------------------------------------------------------------
// 1. Barking twice must not produce two dockets with two numbers.
// ---------------------------------------------------------------------------

describe("barking twice", () => {
  test("the second bark lands on the number already on paper, and mints nothing", async () => {
    const key = keyFor(STARTERS);

    const first = await db.AllocateKotNumber(RESTAURANT_SLUG, key, FIRED);
    expect(first).toMatchObject({ kot_no: 1, reused: false });

    // The second bark. In production BarkOrder's compare-and-set on a null
    // barked_at stops this ever being reached; this asserts the SECOND,
    // independent interlock — the content fingerprint — because that is the one
    // that has to hold when two replicas race the FIRST bark, or when an
    // offline outbox replay arrives carrying a fresh idempotency key.
    const second = await db.AllocateKotNumber(RESTAURANT_SLUG, key, FIRED);
    expect(second).toMatchObject({ kot_no: 1, reused: true });

    // The day's counter did not advance and there is exactly one memo row: no
    // number was burned on the duplicate.
    expect(counters()[0]!.seq).toBe(1);
    expect(tickets()).toHaveLength(1);
  });

  test("two barks racing each other still yield one number and one row", async () => {
    const key = keyFor(STARTERS);
    const [a, b] = await Promise.all([
      db.AllocateKotNumber(RESTAURANT_SLUG, key, FIRED),
      db.AllocateKotNumber(RESTAURANT_SLUG, key, FIRED),
    ]);
    expect(a.kot_no).toBe(1);
    expect(b.kot_no).toBe(1);
    expect([a.reused, b.reused].filter(Boolean)).toHaveLength(1);
    expect(counters()[0]!.seq).toBe(1);
    expect(tickets()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. The manual button is a REPRINT, not a second ticket.
// ---------------------------------------------------------------------------

describe("the manual reprint after an auto-print", () => {
  test("POST /print/kot/order/:id resolves to the auto-printed number", async () => {
    // The bark.
    const barked = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(STARTERS), FIRED);
    expect(barked.kot_no).toBe(1);

    // The printer jammed; the pass asks for the docket again. Same order, same
    // items, same day, so the same key — and therefore the same paper.
    const reprint = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(STARTERS), FIRED);
    expect(reprint).toMatchObject({ kot_no: 1, reused: true });
    expect(counters()[0]!.seq).toBe(1);
  });

  test("a genuinely different order on the same table takes the NEXT number", async () => {
    const a = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(STARTERS), FIRED);
    const b = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(MAINS), FIRED);
    expect(a.kot_no).toBe(1);
    expect(b).toMatchObject({ kot_no: 2, reused: false });
  });
});

// ---------------------------------------------------------------------------
// 3. WHY THE BARK DOCKET IS ORDER-SCOPED. This is the reason the bark path does
//    not simply call the table-scoped printer.
// ---------------------------------------------------------------------------

describe("order-scoped vs table-scoped tickets", () => {
  test("the table aggregate is a DIFFERENT ticket from either order on it", () => {
    // What the manual TABLE print would send once both orders are live:
    // GetBillForTable aggregates every active order, so its item set is A + B.
    const tableAggregate = keyFor([...STARTERS, ...MAINS]);
    expect(keyFor(STARTERS)).not.toBe(tableAggregate);
    expect(keyFor(MAINS)).not.toBe(tableAggregate);
  });

  test("auto-printing the TABLE on the second bark would re-send the first order's food", async () => {
    // Order A is barked, cooked and eaten.
    const a = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(STARTERS), FIRED);
    expect(a.kot_no).toBe(1);

    // Order B is barked 40 minutes later. THE ORDER-SCOPED DOCKET carries only
    // the mains, so the kitchen is asked to cook the mains and nothing else.
    const orderScoped = keyFor(MAINS);
    // THE TABLE-SCOPED DOCKET would carry the starters as well — food that is
    // already on the guest's table. It is also a brand new ticket number, so
    // nothing downstream would flag it as a repeat.
    const tableScoped = keyFor([...STARTERS, ...MAINS]);
    expect(orderScoped).not.toBe(tableScoped);

    const b = await db.AllocateKotNumber(RESTAURANT_SLUG, orderScoped, FIRED);
    expect(b).toMatchObject({ kot_no: 2, reused: false });
  });

  test("a single-order table's bark docket IS the table docket — same number", async () => {
    // The common case, and the one where the two scopes coincide: while A is
    // the only order on the table, its item set and the table aggregate are the
    // same set. Pressing the table's Print KOT after a bark must therefore be a
    // reprint, not a new ticket.
    const bark = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(STARTERS), FIRED);
    const tablePrint = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor([...STARTERS]), FIRED);
    expect(bark.kot_no).toBe(1);
    expect(tablePrint).toMatchObject({ kot_no: 1, reused: true });
  });
});

// ---------------------------------------------------------------------------
// 4. The key's own properties, as the bark path relies on them.
// ---------------------------------------------------------------------------

describe("buildKotTicketKey", () => {
  test("ONE key covers all N station dockets — the split happens after numbering", () => {
    // dispatchKot computes the key over the whole item set and only then calls
    // buildKotBase64, which splits per station. A key computed per station would
    // give the bar and the kitchen different numbers for one order.
    const whole = keyFor([...STARTERS, ...MAINS]);
    const kitchenOnly = keyFor(STARTERS);
    const barOnly = keyFor(MAINS);
    expect(whole).not.toBe(kitchenOnly);
    expect(whole).not.toBe(barOnly);
  });

  test("keys on the table ID, so renaming a table mid-service is not a new ticket", () => {
    // The printed name changes; "Tables".id does not. dispatchKot is handed the
    // id for exactly this reason.
    expect(keyFor(STARTERS, "tbl-uuid")).toBe(keyFor(STARTERS, "tbl-uuid"));
    expect(keyFor(STARTERS, "tbl-uuid")).not.toBe(keyFor(STARTERS, "tbl-other"));
  });

  test("is insensitive to the order the lines arrive in", () => {
    expect(keyFor([...STARTERS].reverse())).toBe(keyFor(STARTERS));
  });

  test("a changed quantity or note is a genuinely new ticket", () => {
    expect(keyFor([{ name: "Paneer Tikka", quantity: 3 }])).not.toBe(keyFor([{ name: "Paneer Tikka", quantity: 2 }]));
    expect(keyFor([{ name: "Paneer Tikka", quantity: 2, note: "extra spicy" }]))
      .not.toBe(keyFor([{ name: "Paneer Tikka", quantity: 2 }]));
  });

  test("an untabled order cannot be keyed, and the caller must not print it numbered", async () => {
    // GetOrderKotContext returns "" for an order with no "Tables" row at all.
    // dispatchKot declines to allocate on an empty table id rather than letting
    // every unkeyable ticket in the outlet collapse onto one shared key — which
    // would hand them all the SAME number.
    const empty = kp.buildKotTicketKey({ outletId: OUTLET_ID, tableId: "", items: STARTERS, firedAt: FIRED, tz: TZ });
    const real = keyFor(STARTERS);
    expect(empty).not.toBe(real);
    // And the guard is in dispatchKot, not here: an empty key is a caller bug,
    // so AllocateKotNumber is right to reject it rather than silently number it.
    await expect(db.AllocateKotNumber(RESTAURANT_SLUG, "", FIRED)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. THE DOCKET, not just the number. Everything above proves the allocator
//    hands back one number; these drive dispatchKot itself — the function both
//    the bark and the reprint go through — and assert what comes off the roll.
// ---------------------------------------------------------------------------

/** One order's worth of dispatch input, with only the parts a test varies. */
const dispatch = (over: Partial<Parameters<KotPrint["dispatchKot"]>[0]> = {}) => ({
  restaurantId: RESTAURANT_SLUG,
  outletId: OUTLET_ID,
  tableName: "12",
  tableId: TABLE,
  section: null,
  covers: 4,
  isVirtual: false,
  orderType: "dine_in",
  items: STARTERS,
  assignedTo: "Ravi",
  captain: null,
  billId: "order-A",
  restaurantName: "Navkrish",
  currency: "\u20b9",
  cols: 48,
  tz: TZ,
  firedAt: FIRED,
  ...over,
});

describe("dispatchKot — what the kitchen actually gets", () => {
  test("a second bark of an unchanged order reprints the SAME paper, and mints nothing", async () => {
    const first = await kp.dispatchKot(dispatch());
    expect(first).toMatchObject({ tickets: 1, kotNo: 1, reprint: false });

    // The duplicate. In production BarkOrder's compare-and-set stops this ever
    // running; what is asserted here is that it would be HARMLESS if it did —
    // two replicas racing the first bark, or an outbox replay with a fresh
    // idempotency key, must not put a second ticket on the pass.
    const second = await kp.dispatchKot(dispatch());
    expect(second).toMatchObject({ tickets: 1, kotNo: 1, reprint: true });

    // Not merely "the same number": the same DOCKET, byte for byte. A ticket
    // that carried KOT-1 but listed different food would satisfy the number
    // assertion and still be a second, contradictory instruction to the kitchen.
    expect(enqueued).toHaveLength(2);
    expect(enqueued[1]!.esc_base64).toBe(enqueued[0]!.esc_base64);
    expect(paper(enqueued[0]!.esc_base64)).toContain("KOT - 1");

    // And the day's series did not move.
    expect(counters()[0]!.seq).toBe(1);
    expect(tickets()).toHaveLength(1);
  });

  test("the per-station split shares ONE number across every docket", async () => {
    seedMenu([
      { id: "m1", name: "Paneer Tikka", station: "TANDOOR" },
      { id: "m2", name: "Masala Papad", station: "COLD" },
    ]);

    const result = await kp.dispatchKot(dispatch());
    // Two kitchens, two dockets — and one ticket, because the number is
    // allocated over the whole item set BEFORE buildKotBase64 splits it.
    expect(result.tickets).toBe(2);
    expect(result.stations.sort()).toEqual(["COLD", "TANDOOR"]);
    expect(result.kotNo).toBe(1);
    expect(enqueued).toHaveLength(2);
    for (const job of enqueued) {
      expect(paper(job.esc_base64)).toContain("KOT - 1");
    }
    // One number consumed, not one per station.
    expect(counters()[0]!.seq).toBe(1);
    expect(tickets()).toHaveLength(1);
  });

  test("the second order on a table is a new ticket carrying only ITS food", async () => {
    const a = await kp.dispatchKot(dispatch());
    expect(a.kotNo).toBe(1);

    const b = await kp.dispatchKot(dispatch({ items: MAINS, billId: "order-B" }));
    expect(b).toMatchObject({ kotNo: 2, reprint: false });

    // THE REASON THE BARK DOCKET IS ORDER-SCOPED. The starters were cooked and
    // eaten forty minutes ago; the mains docket must not ask for them again.
    const mains = paper(enqueued[1]!.esc_base64);
    expect(mains).toContain("Dal Makhani");
    expect(mains).not.toContain("Paneer Tikka");
  });

  test("an order with no table row prints unnumbered rather than sharing a number", async () => {
    // GetOrderKotContext returns "" for an order with no "Tables" row at all.
    // Every such order would key identically, so dispatchKot declines to
    // allocate instead of handing them all KOT-1.
    const result = await kp.dispatchKot(dispatch({ tableId: "" }));
    expect(result.kotNo).toBeNull();
    expect(result.tickets).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(paper(enqueued[0]!.esc_base64)).not.toContain("KOT - ");
    // Nothing was allocated, so the day's first real ticket is still number 1.
    expect(counters()).toHaveLength(0);
    expect(tickets()).toHaveLength(0);
  });

  test("every docket of one press is grouped under the caller's bill id", async () => {
    seedMenu([
      { id: "m1", name: "Paneer Tikka", station: "TANDOOR" },
      { id: "m2", name: "Masala Papad", station: "COLD" },
    ]);
    await kp.dispatchKot(dispatch({ billId: "order-A" }));
    // Shared on purpose: bill_id says "these came from one press". The job uuid,
    // not this, is what dedup and acknowledgement key on — deduplicating on
    // bill_id would print the tandoor's docket and drop the cold section's.
    expect(enqueued.map((j) => j.bill_id)).toEqual(["order-A", "order-A"]);
    expect(enqueued.every((j) => j.kind === "kot")).toBe(true);
  });
});
