// Auto-printing the kitchen docket when an order REACHES THE KITCHEN.
//
// THE TRIGGER MOVED, and this file moved with it. It used to be the bark and
// only the bark; it is now order placed (and, for an order held at the approval
// gate, order approved), with the bark left in as a fallback for anything those
// never ticketed.
//
// THE DEFECT THE ORIGINAL CHANGE CLOSED. Barking stamps "Orders".barked_at and
// rebases every prep timer — the kitchen clock starts there — but nothing was
// printed. Someone had to remember to press Print KOT afterwards, and on a busy
// pass that is the thing that gets forgotten.
//
// THE DEFECT MOVING IT OPENS, and what most of the new cases below are about:
// with two triggers on one order, the SECOND one must produce no paper. Place
// then bark has to be one docket carrying one number, not two.
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
  printJobRows,
  resetStore,
  seedMenu,
  tickets,
} from "./kot_number_fixtures";
import { kotPaper } from "./kot_raster_read";

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

/**
 * THE SETTING HAS TO REACH THE PAPER, or it is a switch wired to nothing.
 *
 * The reference docket is a GS v 0 raster, and a kitchen printer that ignores
 * GS v 0 prints a BLANK ticket from it — order loss, silently. 'classic' is the
 * escape hatch, and an escape hatch that no test drives is one nobody finds out
 * is broken until a kitchen stops getting paper.
 */
describe("dispatchKot — which docket the restaurant gets", () => {
  const isRaster = (b64: string) => Buffer.from(b64, "base64").includes(Buffer.from([0x1d, 0x76, 0x30, 0x00]));

  test("by default — no setting anywhere — the kitchen gets the reference docket", async () => {
    await kp.dispatchKot(dispatch());
    expect(isRaster(enqueued[0]!.esc_base64)).toBe(true);
    expect(paper(enqueued[0]!.esc_base64)).toContain("Table No: 12");
  });

  test("'classic' reaches the renderer and puts the text docket on the roll", async () => {
    await kp.dispatchKot(dispatch({ kotPrintStyle: "classic" }));
    expect(isRaster(enqueued[0]!.esc_base64)).toBe(false);
    expect(Buffer.from(enqueued[0]!.esc_base64, "base64").toString("latin1")).toContain("Table No: 12");
  });

  test("every station's docket of one press obeys the setting, not just the first", async () => {
    seedMenu([
      { id: "m1", name: "Paneer Tikka", station: "TANDOOR" },
      { id: "m2", name: "Masala Papad", station: "COLD" },
    ]);
    await kp.dispatchKot(dispatch({ kotPrintStyle: "classic" }));
    expect(enqueued.length).toBeGreaterThan(1);
    expect(enqueued.map((j) => isRaster(j.esc_base64))).toEqual(enqueued.map(() => false));
  });
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

  // --- Held courses, end to end ---------------------------------------------
  // The reads that feed this (GetBillForTable, GetOrderKotContext) merge order
  // lines by name/price/nc/variation and DELIBERATELY do not key on held-ness —
  // a bill line must not split in two while a course waits and re-merge when it
  // is fired. So a merged line arrives here as "3, of which 1 is held", and this
  // is the only place that becomes two lines of paper.
  test("a partly-held line becomes two docket lines: cook these now, hold that one", async () => {
    await kp.dispatchKot(dispatch({
      items: [{ name: "Gulab Jamun", quantity: 3, held_qty: 1 }],
    }));
    const out = paper(enqueued[0]!.esc_base64);
    // Two to cook on line 1; one waiting on line 2, whose "[Hold]" tag hangs
    // UNDER it the way a note does (item 2) — never a banner before it.
    const hold = out.indexOf("[Hold]");
    expect(hold).toBeGreaterThan(-1);
    expect(out).not.toContain("** HOLD **");
    expect(out.slice(0, hold).match(/Gulab Jamun/g)).toHaveLength(2);
    // …and the totals say so on their own. (\s+ rather than a counted run of
    // spaces: the reference docket sets these in proportional type, where the
    // gap is dots and not columns. What is asserted is what was always meant —
    // the figure stands apart from its label, in the quantity column.)
    expect(out).toMatch(/Total Qty\s+2/);
    expect(out).toMatch(/Hold Qty\s+1/);
  });

  test("a wholly held line never appears in the cook-now list", async () => {
    await kp.dispatchKot(dispatch({
      items: [{ name: "Paneer Tikka", quantity: 2 }, { name: "Gulab Jamun", quantity: 3, held_qty: 3 }],
    }));
    const out = paper(enqueued[0]!.esc_base64);
    // It is not counted as cook-now: Total Qty is the Paneer alone, and the
    // dessert is marked "[Hold]" directly under its own line.
    const dish = out.indexOf("Gulab Jamun");
    const hold = out.indexOf("[Hold]");
    expect(dish).toBeGreaterThan(-1);
    expect(hold).toBeGreaterThan(dish);
    expect(out.slice(dish, hold)).not.toMatch(/Paneer Tikka/);
    expect(out).toMatch(/Total Qty\s+2/);
    expect(out).toMatch(/Hold Qty\s+3/);
  });

  test("holding a course does NOT mint a new KOT number", async () => {
    // The ticket key is (outlet, business day, table, item set) and held-ness is
    // deliberately not in it. Two reasons, and the second is the one that
    // matters: adding a field to the key would change the hash of EVERY ticket,
    // so the first reprint of anything printed before the deploy would miss the
    // migration-029 memo and burn a fresh number — gaps and duplicates at the
    // pass, on the day of the release, for a formatting change. A fired course
    // reprinting under its original number is the correct reading anyway: it is
    // the same order, further along.
    const held = await kp.dispatchKot(dispatch({ items: [{ name: "Gulab Jamun", quantity: 3, held_qty: 3 }] }));
    const fired = await kp.dispatchKot(dispatch({ items: [{ name: "Gulab Jamun", quantity: 3 }] }));
    expect(held.kotNo).toBe(1);
    expect(fired).toMatchObject({ kotNo: 1, reprint: true });
    // Same number, and the paper is honestly different: the second docket has
    // released the course.
    expect(paper(enqueued[0]!.esc_base64)).toContain("[Hold]");
    expect(paper(enqueued[1]!.esc_base64)).not.toContain("[Hold]");
    expect(counters()[0]!.seq).toBe(1);
  });

  test("a restaurant that never holds a course gets the paper it always got", async () => {
    // held_qty absent everywhere is the only state the overwhelming majority of
    // tenants are ever in, and it must not be able to produce a hold block.
    await kp.dispatchKot(dispatch());
    const out = paper(enqueued[0]!.esc_base64);
    expect(out).not.toMatch(/hold/i);
    expect(out).toMatch(/Total Qty\s+3/); // 2 Paneer + 1 Papad
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

// ---------------------------------------------------------------------------
// 6. THE TRIGGER MOVED TO ORDER PLACED. Two triggers now fire on one order —
//    placement and (later) the bark — and the whole safety of that rests on the
//    second one producing NO PAPER. These drive skipIfTicketed, the interlock
//    that makes it so.
// ---------------------------------------------------------------------------

describe("place, then bark", () => {
  test("the bark prints nothing and reports the number already on the paper", async () => {
    // The order is placed. This is the print the restaurant asked for.
    const placed = await kp.dispatchKot(dispatch({ skipIfTicketed: true }));
    expect(placed).toMatchObject({ tickets: 1, kotNo: 1, reprint: false, skipped: false });
    expect(enqueued).toHaveLength(1);

    // The expo barks it forty seconds later. barked_at is stamped and the prep
    // timers rebase — but the kitchen already has the paper, so nothing is
    // built and nothing is queued.
    const barked = await kp.dispatchKot(dispatch({ skipIfTicketed: true }));
    expect(barked).toMatchObject({ tickets: 0, kotNo: 1, reprint: true, skipped: true });
    expect(barked.stations).toEqual([]);
    expect(barked.jobIds).toEqual([]);

    // ONE docket on the pass, ONE number consumed, ONE memo row.
    expect(enqueued).toHaveLength(1);
    expect(counters()[0]!.seq).toBe(1);
    expect(tickets()).toHaveLength(1);
  });

  test("suppression is per CONTENT, so a second order on the table still prints", async () => {
    await kp.dispatchKot(dispatch({ skipIfTicketed: true }));
    // A genuinely different order on the same table is different content, so it
    // is not suppressed — the interlock must not degrade into "one KOT a day".
    const mains = await kp.dispatchKot(dispatch({ items: MAINS, billId: "order-B", skipIfTicketed: true }));
    expect(mains).toMatchObject({ tickets: 1, kotNo: 2, skipped: false });
    expect(enqueued).toHaveLength(2);
  });

  test("the manual reprint is NOT suppressed — it is the recovery path", async () => {
    const placed = await kp.dispatchKot(dispatch({ skipIfTicketed: true }));
    expect(placed.kotNo).toBe(1);

    // POST /print/kot/order/:id leaves the flag off, because a reprint button
    // that refused to reprint would be a dead control. The paper it produces is
    // the SAME paper — same number, same bytes — not a new ticket.
    const reprint = await kp.dispatchKot(dispatch());
    expect(reprint).toMatchObject({ tickets: 1, kotNo: 1, reprint: true, skipped: false });
    expect(enqueued).toHaveLength(2);
    expect(enqueued[1]!.esc_base64).toBe(enqueued[0]!.esc_base64);
    expect(counters()[0]!.seq).toBe(1);
  });

  test("an unticketed order still prints on the bark — the fallback is real", async () => {
    // Nothing was dispatched at placement (auto-print was off at the time, or
    // the placement print died before it could allocate). The bark is the only
    // trigger left, and it must still put paper on the pass.
    const barked = await kp.dispatchKot(dispatch({ skipIfTicketed: true }));
    expect(barked).toMatchObject({ tickets: 1, kotNo: 1, skipped: false });
    expect(enqueued).toHaveLength(1);
  });

  test("suppression cannot fire on an unnumbered ticket", async () => {
    // No table id means no key and no allocation, so `reused` is never true and
    // the flag can never turn into a silent drop. An outlet running ahead of
    // migration 029 (allocateKotNumber returns null) is the same case.
    const a = await kp.dispatchKot(dispatch({ tableId: "", skipIfTicketed: true }));
    const b = await kp.dispatchKot(dispatch({ tableId: "", skipIfTicketed: true }));
    expect(a).toMatchObject({ kotNo: null, tickets: 1, skipped: false });
    expect(b).toMatchObject({ kotNo: null, tickets: 1, skipped: false });
    expect(enqueued).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 7. ADDING A LINE TO AN ORDER ALREADY ON THE PASS.
// ---------------------------------------------------------------------------

/** The sweet a waiter adds to a table that is already eating. */
const ADDED = [{ name: "Gulab Jamun", quantity: 1 }];

describe("a line added to a running order", () => {
  test("the docket carries the added line and NOT the food already cooking", async () => {
    await kp.dispatchKot(dispatch({ skipIfTicketed: true }));

    // POST /orders/:id/items dispatches only the line it just added, scoped by
    // that line's id.
    const added = await kp.dispatchKot(dispatch({
      items: ADDED, scope: "line-1", skipIfTicketed: false,
    }));
    expect(added).toMatchObject({ tickets: 1, kotNo: 2, skipped: false });

    const paperOut = paper(enqueued[1]!.esc_base64);
    expect(paperOut).toContain("Gulab Jamun");
    // THE COST OF GETTING THIS WRONG. Re-printing the whole order would ask the
    // kitchen to cook the starters a second time and the restaurant would eat
    // them.
    expect(paperOut).not.toContain("Paneer Tikka");
    expect(paperOut).not.toContain("Masala Papad");
  });

  test("two separate adds of the SAME dish are two tickets, not one lost sweet", async () => {
    // Byte-identical item sets. Without the line id in the key the second add
    // hashes to the first one's ticket, comes back reused, and the kitchen is
    // never told about the second Gulab Jamun.
    const first = await kp.dispatchKot(dispatch({ items: ADDED, scope: "line-1", skipIfTicketed: false }));
    const second = await kp.dispatchKot(dispatch({ items: ADDED, scope: "line-2", skipIfTicketed: false }));
    expect(first).toMatchObject({ kotNo: 1, reprint: false });
    expect(second).toMatchObject({ kotNo: 2, reprint: false });
    expect(enqueued).toHaveLength(2);
    expect(counters()[0]!.seq).toBe(2);
  });

  test("the same add replayed is the same ticket, so a retry cannot double-cook", async () => {
    // The line id is stable, so an outbox replay or a socket retry that somehow
    // got past idempotent() still resolves to the ticket already on paper.
    const a = await kp.dispatchKot(dispatch({ items: ADDED, scope: "line-1", skipIfTicketed: false }));
    const b = await kp.dispatchKot(dispatch({ items: ADDED, scope: "line-1", skipIfTicketed: false }));
    expect(a.kotNo).toBe(1);
    expect(b).toMatchObject({ kotNo: 1, reprint: true });
    expect(counters()[0]!.seq).toBe(1);
    expect(tickets()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 8. THE SCOPE FIELD MUST NOT MOVE ANY EXISTING KEY.
//    Every live table's docket was keyed without it. If adding the field
//    changed those hashes, the first reprint after the deploy would burn a
//    second number for a docket already on the pass.
// ---------------------------------------------------------------------------

describe("scope is additive", () => {
  test("absent, empty and whitespace scopes all hash to the pre-change key", () => {
    const base = keyFor(STARTERS);
    const mk = (scope: string | null | undefined) =>
      kp.buildKotTicketKey({ outletId: OUTLET_ID, tableId: TABLE, items: STARTERS, firedAt: FIRED, tz: TZ, scope });
    expect(mk(undefined)).toBe(base);
    expect(mk(null)).toBe(base);
    expect(mk("")).toBe(base);
    expect(mk("   ")).toBe(base);
  });

  test("a real scope is a different ticket, and two scopes are two tickets", () => {
    const base = keyFor(STARTERS);
    const mk = (scope: string) =>
      kp.buildKotTicketKey({ outletId: OUTLET_ID, tableId: TABLE, items: STARTERS, firedAt: FIRED, tz: TZ, scope });
    expect(mk("line-1")).not.toBe(base);
    expect(mk("line-1")).not.toBe(mk("line-2"));
    // Normalised like every other component, so casing and padding are noise.
    expect(mk(" LINE-1 ")).toBe(mk("line-1"));
  });
});

// ---------------------------------------------------------------------------
// 9. THE ROUTING KEY. "The beverage KOT goes to one printer and the food KOT
//    goes to another" is a question about what the backend PUTS ON THE WIRE:
//    one job per station, each stamped with its own station. The agent's side
//    of it — station -> printer, and the fallback that stops an unmatched
//    docket being dropped — is pinned in printer_routing_test.dart.
// ---------------------------------------------------------------------------

describe("what the printer agent is given to route on", () => {
  test("one order becomes one job per station, each carrying its own station", async () => {
    seedMenu([
      { id: "m1", name: "Paneer Tikka", station: "TANDOOR" },
      { id: "m2", name: "Masala Papad", station: "TANDOOR" },
      { id: "m3", name: "Fresh Lime Soda", station: "BAR" },
    ]);

    const result = await kp.dispatchKot(dispatch({
      items: [...STARTERS, { name: "Fresh Lime Soda", quantity: 2 }],
      skipIfTicketed: true,
    }));

    // TWO dockets, and the station is what tells them apart on the wire.
    expect(result.tickets).toBe(2);
    expect([...result.stations].sort()).toEqual(["BAR", "TANDOOR"]);
    expect(enqueued.map((j) => j.station).sort()).toEqual(["BAR", "TANDOOR"]);

    // The drink is on the bar's docket and nowhere else; the food is on the
    // kitchen's. A split that leaked either way would print the whole order at
    // both printers.
    const bar = paper(enqueued.find((j) => j.station === "BAR")!.esc_base64);
    const tandoor = paper(enqueued.find((j) => j.station === "TANDOOR")!.esc_base64);
    expect(bar).toContain("Fresh Lime Soda");
    expect(bar).not.toContain("Paneer Tikka");
    expect(tandoor).toContain("Paneer Tikka");
    expect(tandoor).not.toContain("Fresh Lime Soda");

    // ONE number across both, so the pass can pair them.
    expect(result.kotNo).toBe(1);
    expect(counters()[0]!.seq).toBe(1);
  });

  test("a dish with no station still names a station, so no docket is unroutable", async () => {
    // The routing key is never null. An unassigned dish falls under "General",
    // which the agent matches with the any-kitchen rule and, failing that, the
    // default printer — see printer_routing_test.dart.
    seedMenu([{ id: "m1", name: "Paneer Tikka", station: "TANDOOR" }]);
    const result = await kp.dispatchKot(dispatch({ skipIfTicketed: true }));
    expect([...result.stations].sort()).toEqual(["General", "TANDOOR"]);
    expect(enqueued.every((j) => typeof j.station === "string" && j.station.length > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. THE ORDER-LEVEL NOTE reaching the paper.
//
//     escpos.test.ts pins that the RENDERER draws the banner and that the bill
//     branch cannot. What is pinned HERE is the wiring between them — that
//     dispatchKot actually hands the note to every station's docket — because
//     that is the half that was missing for the entire life of the feature: the
//     string was captured by both clients, stored in "Orders".food.note, and
//     then passed to no renderer by any caller.
//
//     The ticket KEY deliberately excludes it (see KotDispatchInput.orderNote),
//     so the last case here is the one that would catch someone "fixing" that:
//     an edited note must not mint a second KOT number for food the kitchen is
//     already cooking.
// ---------------------------------------------------------------------------

describe("the order-level note on the docket", () => {
  test("reaches every station's docket, not just the first", async () => {
    seedMenu([
      { id: "m1", name: "Paneer Tikka", station: "TANDOOR" },
      { id: "m3", name: "Fresh Lime Soda", station: "BAR" },
    ]);

    const result = await kp.dispatchKot(dispatch({
      items: [{ name: "Paneer Tikka", quantity: 1 }, { name: "Fresh Lime Soda", quantity: 2 }],
      orderNote: "allergy: peanuts",
      skipIfTicketed: true,
    }));

    expect(result.tickets).toBe(2);
    // The bar pours as well as the kitchen cooks. A docket that omits the
    // allergy is the one that serves it.
    for (const job of enqueued) {
      expect(paper(job.esc_base64)).toContain("allergy: peanuts");
    }
  });

  test("no note leaves the docket exactly as it was before the field existed", async () => {
    seedMenu([{ id: "m1", name: "Paneer Tikka", station: "TANDOOR" }]);
    const withoutNote = await kp.dispatchKot(dispatch({ skipIfTicketed: false }));
    const bytesWithout = enqueued.map((j) => j.esc_base64);
    expect(withoutNote.tickets).toBeGreaterThan(0);

    enqueued.length = 0;
    const withBlank = await kp.dispatchKot(dispatch({ orderNote: "   ", skipIfTicketed: false }));
    expect(withBlank.tickets).toBe(withoutNote.tickets);
    expect(enqueued.map((j) => j.esc_base64)).toEqual(bytesWithout);
  });

  test("editing the note does NOT mint a second KOT number for unchanged food", async () => {
    // The memo maps one FOOD CONTENT to one number forever; that is what makes
    // a reprint reuse its number rather than putting a second ticket for the
    // same dishes on the pass. The note rides on the docket, so folding it into
    // the key would re-ticket an order whose food has not moved.
    seedMenu([{ id: "m1", name: "Paneer Tikka", station: "TANDOOR" }]);
    const first = await kp.dispatchKot(dispatch({ orderNote: "no onions", skipIfTicketed: true }));
    expect(first).toMatchObject({ kotNo: 1, reprint: false });

    const second = await kp.dispatchKot(dispatch({ orderNote: "no onions, no garlic", skipIfTicketed: true }));
    expect(second.kotNo).toBe(1);
    expect(second.reprint).toBe(true);
    expect(counters()[0]!.seq).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 11. STATION IDENTITY. Two bugs that were cosmetic while every station had its
//     own printer, and stop being cosmetic the moment sections are GROUPED onto
//     one — because grouping is exactly the configuration that lands them on the
//     same roll.
// ---------------------------------------------------------------------------

describe("station identity", () => {
  test("two casings of one station are ONE docket, not two half-tickets", async () => {
    // The renderer buckets on the raw string and the printer agent upper-cases
    // its rule key, so "Bar" and "bar" used to mint two dockets that both
    // resolved to the same printer.
    seedMenu([
      { id: "m1", name: "Mojito", station: "Bar" },
      { id: "m2", name: "Fresh Lime Soda", station: "bar" },
    ]);

    const result = await kp.dispatchKot(dispatch({
      items: [{ name: "Mojito", quantity: 1 }, { name: "Fresh Lime Soda", quantity: 2 }],
      skipIfTicketed: true,
    }));

    expect(result.tickets).toBe(1);
    expect(result.stations).toHaveLength(1);
    const only = paper(enqueued[0]!.esc_base64);
    expect(only).toContain("Mojito");
    expect(only).toContain("Fresh Lime Soda");
  });

  test("an unmanaged station still collapses, settling on the first spelling seen", async () => {
    // No vocabulary to appeal to, so the two spellings agree on one of
    // themselves rather than staying apart.
    seedMenu([
      { id: "m1", name: "Mojito", station: "poolside" },
      { id: "m2", name: "Iced Tea", station: "POOLSIDE" },
    ]);
    const result = await kp.dispatchKot(dispatch({
      items: [{ name: "Mojito", quantity: 1 }, { name: "Iced Tea", quantity: 1 }],
      skipIfTicketed: true,
    }));
    expect(result.stations).toEqual(["poolside"]);
  });

  test("a dish RENAMED since it was ordered still reaches its own station", async () => {
    // The name lookup cannot find it any more, so without the id it would fall
    // into "General" — which under a grouped scheme is almost certainly the hot
    // kitchen. A renamed cocktail would print at the pass and the bar would
    // never learn it was ordered.
    seedMenu([
      { id: "m1", name: "Mojito Classico", station: "Bar" },   // renamed on the menu
      { id: "m2", name: "Paneer Tikka", station: "TANDOOR" },
    ]);

    const result = await kp.dispatchKot(dispatch({
      items: [
        // The order line still says what it said when it was taken, but carries
        // the server-stamped menu_id.
        { name: "Mojito", quantity: 1, menu_id: "m1" },
        { name: "Paneer Tikka", quantity: 1 },
      ],
      skipIfTicketed: true,
    }));

    expect([...result.stations].sort()).toEqual(["Bar", "TANDOOR"]);
    const bar = paper(enqueued.find((j) => j.station === "Bar")!.esc_base64);
    expect(bar).toContain("Mojito");
    expect(bar).not.toContain("Paneer Tikka");
  });

  test("without a menu_id the name is still the key, exactly as before", async () => {
    seedMenu([{ id: "m1", name: "Mojito", station: "Bar" }]);
    const result = await kp.dispatchKot(dispatch({
      items: [{ name: "Mojito", quantity: 1 }],
      skipIfTicketed: true,
    }));
    expect(result.stations).toEqual(["Bar"]);
  });
});

// ---------------------------------------------------------------------------
// 12. THE NUMBER REACHES THE QUEUE.
//
//     Migration 043 adds "PrintJobs".kot_no so a printed docket can be found
//     again by the number the kitchen calls it by — that is what puts a KOT
//     number on a kitchen card, on an order row, and in a bill's Token No. line.
//     The column, the reads and all three screens were built in one pass; the
//     single line that WRITES it was not, and 043 sat completely inert as a
//     result: the column existed, every read returned empty, and no number
//     reached any screen.
//
//     One line is exactly the kind of thing that regresses without a witness.
// ---------------------------------------------------------------------------

describe("the KOT number on the print job", () => {
  // THE LATCH IS OFF BY DEFAULT AND THAT IS THE SHIPPED BEHAVIOUR. It is set
  // once at boot by probing the catalogue, so in a test it is false — which is
  // the pre-043 tenant, and worth pinning in its own right (last test below).
  beforeEach(() => { db.__kotNumberLinkTestSeam.setSchemaReady(true); });
  afterEach(() => { db.__kotNumberLinkTestSeam.setSchemaReady(false); });

  test("every docket of a ticket carries the number that ticket was allocated", async () => {
    seedMenu([
      { id: "m1", name: "Paneer Tikka", station: "TANDOOR" },
      { id: "m3", name: "Fresh Lime Soda", station: "BAR" },
    ]);

    const result = await kp.dispatchKot(dispatch({
      items: [{ name: "Paneer Tikka", quantity: 1 }, { name: "Fresh Lime Soda", quantity: 2 }],
      skipIfTicketed: true,
    }));

    // ONE number across both station dockets — they are one ticket, and the
    // pass pairs them by that number.
    expect(result.tickets).toBe(2);
    expect(enqueued.map((j) => j.kot_no)).toEqual([result.kotNo, result.kotNo]);
    expect(result.kotNo).toBe(1);
  });

  test("an unnumbered ticket enqueues with no number rather than a fabricated one", async () => {
    // A docket with no table row cannot be keyed, so it prints unnumbered. A
    // zero or a -1 here would become a KOT number on a kitchen card that names
    // no ticket at all.
    seedMenu([{ id: "m1", name: "Paneer Tikka", station: "TANDOOR" }]);
    const result = await kp.dispatchKot(dispatch({ tableId: "", skipIfTicketed: true }));
    expect(result.kotNo).toBeNull();
    expect(enqueued.every((j) => j.kot_no === null)).toBe(true);
  });

  test("a tenant whose 043 has not applied enqueues exactly today's row", async () => {
    // The whole degradation contract in one assertion: with the column absent,
    // EnqueuePrintJob issues the statement it always did, the docket still
    // prints, and nothing anywhere carries a number.
    db.__kotNumberLinkTestSeam.setSchemaReady(false);
    seedMenu([{ id: "m1", name: "Paneer Tikka", station: "TANDOOR" }]);
    const result = await kp.dispatchKot(dispatch({ skipIfTicketed: true }));
    expect(result.tickets).toBeGreaterThan(0);
    expect(result.kotNo).toBe(1);
    expect(enqueued.every((j) => j.kot_no === null)).toBe(true);
  });
});
