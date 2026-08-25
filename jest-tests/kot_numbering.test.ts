// Per-day Kitchen Order Ticket numbers: allocation, the restaurant-midnight
// reset, behaviour under concurrent prints, and reprint idempotence.
//
// Driven against the REAL AllocateKotNumber in database_supabase.ts over the
// fixture Pool, so what is under test is the SQL — the `for update` on the day's
// counter, the memo lookup's position relative to it, and which day key the
// parameters carry — and not a TypeScript restatement of any of it.
//
// THE FOUR CLAIMS THE FEATURE MAKES, one describe block each:
//   1. numbers are sequential within an outlet's business day;
//   2. the day rolls over at the RESTAURANT's midnight, in the RESTAURANT's zone;
//   3. concurrent prints never collide and never leave a gap;
//   4. a reprint gets the number already on paper, including when the reprint
//      races the original.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import {
  OUTLET_ID,
  RESTAURANT_SLUG,
  breakKotTables,
  seedTicket,
  counters,
  resetStore,
  setTimezone,
  tickets,
} from "./kot_number_fixtures";

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
    // Pool-level query = a checkout the caller never sees. Only the context
    // lookup takes this path; it holds no locks, so a throwaway connection is
    // faithful.
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> { return conn().query(sql, params); }
    connect(): Promise<unknown> { return Promise.resolve(conn()); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

type Db = typeof import("../database_supabase");
type Kot = typeof import("../kot_numbers");
let db: Db;
let kot: Kot;

beforeAll(async () => {
  // A connection string is required at import time; the pool is faked, so the
  // value is never dialled.
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
  kot = await import("../kot_numbers");
});

beforeEach(() => { resetStore(); });

/** A distinct ticket, i.e. a genuinely different order. */
const keyFor = (n: number, day = "2026-08-25") =>
  kot.kotTicketKey({ outletId: OUTLET_ID, businessDay: day, tableId: `table-${n}`, items: [{ name: "Paneer Tikka", quantity: n }] });

const NOON_IST = new Date("2026-08-25T06:30:00Z"); // 12:00 on the 25th in IST

// ---------------------------------------------------------------------------
// 1. Sequential within a business day
// ---------------------------------------------------------------------------

describe("allocation is sequential within an outlet's business day", () => {
  test("the first three tickets of the day are 1, 2, 3", async () => {
    const a = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(1), NOON_IST);
    const b = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(2), NOON_IST);
    const c = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(3), NOON_IST);
    expect([a.kot_no, b.kot_no, c.kot_no]).toEqual([1, 2, 3]);
    expect([a.reused, b.reused, c.reused]).toEqual([false, false, false]);
    // All three belong to the restaurant's 25th.
    expect(new Set([a.business_day, b.business_day, c.business_day])).toEqual(new Set(["2026-08-25"]));
    // ONE counter row for the outlet-day, sitting at the last number issued.
    expect(counters()).toHaveLength(1);
    expect(counters()[0]!.seq).toBe(3);
    expect(tickets()).toHaveLength(3);
  });

  test("a ticket key is refused when empty — a number must belong to something", async () => {
    await expect(db.AllocateKotNumber(RESTAURANT_SLUG, "   ", NOON_IST)).rejects.toThrow(/ticket key/i);
    expect(counters()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. The reset happens at the RESTAURANT's midnight
// ---------------------------------------------------------------------------

describe("the counter resets at the restaurant's midnight, not the server's", () => {
  // 18:29Z and 18:31Z straddle 00:00 IST (UTC+05:30) on 2026-08-26. Both
  // instants are the SAME UTC day, so anything bucketing on UTC — or on the
  // server clock, which is UTC on this fleet — puts them in one day and keeps
  // counting.
  const LATE_IST = new Date("2026-08-25T18:29:00Z"); // 23:59 on the 25th, IST
  const EARLY_IST = new Date("2026-08-25T18:31:00Z"); // 00:01 on the 26th, IST

  test("23:59 and 00:01 IST are different business days and both start at 1", async () => {
    const last = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(1, "2026-08-25"), LATE_IST);
    const first = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(1, "2026-08-26"), EARLY_IST);

    expect(last).toMatchObject({ kot_no: 1, business_day: "2026-08-25" });
    expect(first).toMatchObject({ kot_no: 1, business_day: "2026-08-26" });
    // Two counter rows — the new day did not inherit the old day's seq.
    expect(counters().map((c) => c.business_day).sort()).toEqual(["2026-08-25", "2026-08-26"]);
    expect(counters().every((c) => c.seq === 1)).toBe(true);
  });

  test("the SAME two instants stay on one business day for a tenant in New York", async () => {
    // 18:29Z and 18:31Z are both mid-afternoon on the 25th in America/New_York,
    // so this tenant is still on one ticket run and the second docket is 2.
    // This is the assertion that fails if the day key is ever hardcoded to IST
    // or derived from the server clock instead of "Restaurant".timezone.
    setTimezone("America/New_York");
    const a = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(1), LATE_IST);
    const b = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(2), EARLY_IST);
    expect(a).toMatchObject({ kot_no: 1, business_day: "2026-08-25" });
    expect(b).toMatchObject({ kot_no: 2, business_day: "2026-08-25" });
    expect(counters()).toHaveLength(1);
  });

  test("yesterday's number can be re-read after the rollover without disturbing today", async () => {
    const yKey = keyFor(9, "2026-08-25");
    const issued = await db.AllocateKotNumber(RESTAURANT_SLUG, yKey, LATE_IST);
    await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(1, "2026-08-26"), EARLY_IST);
    // A late reprint of yesterday's docket returns yesterday's number, and today
    // is untouched.
    const reprint = await db.AllocateKotNumber(RESTAURANT_SLUG, yKey, EARLY_IST);
    expect(reprint).toMatchObject({ kot_no: issued.kot_no, reused: true });
    const today = counters().find((c) => c.business_day === "2026-08-26");
    expect(today?.seq).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Concurrency
// ---------------------------------------------------------------------------

describe("concurrent prints never collide and never leave a gap", () => {
  test("twenty tills firing at once take exactly 1..20", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(i + 1), NOON_IST)),
    );
    const issued = results.map((r) => r.kot_no).sort((a, b) => a - b);
    // Exactly the run 1..20: no duplicate (which would print two "KOT 7"s) and
    // no hole (which is what a bump-then-check allocator leaves behind).
    expect(issued).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(issued).size).toBe(20);
    expect(counters()[0]!.seq).toBe(20);
    expect(tickets()).toHaveLength(20);
  });

  test("a failure after the bump rolls the number back rather than burning it", async () => {
    await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(1), NOON_IST); // -> 1
    expect(counters()[0]!.seq).toBe(1);

    // Occupy the number the allocator is about to hand out, so its memo insert
    // trips kottickets_no_unique. The bump and the insert are in ONE
    // transaction, so the failure must take the bump with it.
    seedTicket({ res_id: counters()[0]!.res_id, outlet_id: OUTLET_ID, business_day: "2026-08-25", kot_no: 2, ticket_key: "squatter" });
    await expect(db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(2), NOON_IST)).rejects.toThrow(/kottickets_no_unique/);

    // The counter is back where it was: the next print takes 2, not 3. Without
    // the shared transaction it would sit at 2 here and the series would gap.
    expect(counters()[0]!.seq).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Reprints
// ---------------------------------------------------------------------------

describe("a reprint gets the number that is already on paper", () => {
  test("printing the same ticket again reuses the number and does not advance the counter", async () => {
    const key = keyFor(1);
    const first = await db.AllocateKotNumber(RESTAURANT_SLUG, key, NOON_IST);
    const second = await db.AllocateKotNumber(RESTAURANT_SLUG, key, NOON_IST);
    const third = await db.AllocateKotNumber(RESTAURANT_SLUG, key, NOON_IST);

    expect(first).toMatchObject({ kot_no: 1, reused: false });
    expect(second).toMatchObject({ kot_no: 1, reused: true });
    expect(third).toMatchObject({ kot_no: 1, reused: true });
    // The counter never moved, so the NEXT genuine ticket is 2 — not 4.
    expect(counters()[0]!.seq).toBe(1);
    expect(tickets()).toHaveLength(1);
    const next = await db.AllocateKotNumber(RESTAURANT_SLUG, keyFor(2), NOON_IST);
    expect(next.kot_no).toBe(2);
  });

  test("a double-press that RACES itself still yields one number and one row", async () => {
    // This is the case the row lock exists for. Both calls miss the memo if they
    // read before the other commits; only the lock — taken BEFORE the memo
    // lookup — makes the loser see the winner's row and reuse it.
    const key = keyFor(1);
    const [a, b] = await Promise.all([
      db.AllocateKotNumber(RESTAURANT_SLUG, key, NOON_IST),
      db.AllocateKotNumber(RESTAURANT_SLUG, key, NOON_IST),
    ]);
    expect(a.kot_no).toBe(1);
    expect(b.kot_no).toBe(1);
    // Exactly one of them did the allocating.
    expect([a.reused, b.reused].filter(Boolean)).toHaveLength(1);
    expect(counters()[0]!.seq).toBe(1);
    expect(tickets()).toHaveLength(1);
  });

  test("adding a dish makes it a NEW ticket that takes the next number", async () => {
    const base = { outletId: OUTLET_ID, businessDay: "2026-08-25", tableId: "t-12" };
    const before = kot.kotTicketKey({ ...base, items: [{ name: "Naan", quantity: 2 }] });
    const after = kot.kotTicketKey({ ...base, items: [{ name: "Naan", quantity: 2 }, { name: "Dal", quantity: 1 }] });
    expect(await db.AllocateKotNumber(RESTAURANT_SLUG, before, NOON_IST)).toMatchObject({ kot_no: 1 });
    expect(await db.AllocateKotNumber(RESTAURANT_SLUG, after, NOON_IST)).toMatchObject({ kot_no: 2, reused: false });
  });
});

// ---------------------------------------------------------------------------
// The ticket key itself
// ---------------------------------------------------------------------------

describe("kotTicketKey", () => {
  const base = { outletId: OUTLET_ID, businessDay: "2026-08-25", tableId: "t-12" };

  test("is insensitive to item ORDER — the same dishes are the same ticket", () => {
    const a = kot.kotTicketKey({ ...base, items: [{ name: "Naan", quantity: 2 }, { name: "Dal", quantity: 1 }] });
    const b = kot.kotTicketKey({ ...base, items: [{ name: "Dal", quantity: 1 }, { name: "Naan", quantity: 2 }] });
    expect(a).toBe(b);
  });

  test("is sensitive to quantity, to notes, to the table and to the day", () => {
    const a = kot.kotTicketKey({ ...base, items: [{ name: "Naan", quantity: 2 }] });
    expect(kot.kotTicketKey({ ...base, items: [{ name: "Naan", quantity: 3 }] })).not.toBe(a);
    expect(kot.kotTicketKey({ ...base, items: [{ name: "Naan", quantity: 2, note: "no butter" }] })).not.toBe(a);
    expect(kot.kotTicketKey({ ...base, tableId: "t-13", items: [{ name: "Naan", quantity: 2 }] })).not.toBe(a);
    // THE DAY IS IN THE KEY, which is what stops a table that orders the same
    // thing every evening reusing last night's number for ever.
    expect(kot.kotTicketKey({ ...base, businessDay: "2026-08-26", items: [{ name: "Naan", quantity: 2 }] })).not.toBe(a);
  });

  test("ignores case and incidental whitespace in dish names", () => {
    const a = kot.kotTicketKey({ ...base, items: [{ name: "Paneer Tikka", quantity: 1 }] });
    const b = kot.kotTicketKey({ ...base, items: [{ name: "  paneer   tikka ", quantity: 1 }] });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Degradation — migration 029 not applied
// ---------------------------------------------------------------------------

describe("an unmigrated deployment still prints", () => {
  test("allocateKotNumber returns null instead of failing the print", async () => {
    breakKotTables();
    await expect(kot.allocateKotNumber(RESTAURANT_SLUG, keyFor(1), NOON_IST)).resolves.toBeNull();
  });

  test("only 42P01/42501 degrade — a real fault still throws", async () => {
    // An empty key is a caller bug, not a missing migration, and must not be
    // swallowed into a silently unnumbered ticket.
    await expect(kot.allocateKotNumber(RESTAURANT_SLUG, "", NOON_IST)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Header presentation — pure, no database
// ---------------------------------------------------------------------------

describe("kotStamp", () => {
  test("prints DD/MM/YY HH:mm in the restaurant's zone", () => {
    // 09:53Z is 15:23 in IST — the reference receipt's own stamp shape.
    expect(kot.kotStamp(new Date("2026-08-25T09:53:00Z"), "Asia/Kolkata")).toBe("25/08/26 15:23");
  });

  test("the zone is the RESTAURANT's — the same instant reads differently elsewhere", () => {
    const at = new Date("2026-08-25T18:31:00Z");
    expect(kot.kotStamp(at, "Asia/Kolkata")).toBe("26/08/26 00:01");
    expect(kot.kotStamp(at, "America/New_York")).toBe("25/08/26 14:31");
    expect(kot.kotStamp(at, "UTC")).toBe("25/08/26 18:31");
  });

  test("midnight prints as 00:xx, never 24:xx or 12:xx AM", () => {
    expect(kot.kotStamp(new Date("2026-08-25T18:30:00Z"), "Asia/Kolkata")).toBe("26/08/26 00:00");
  });

  test("an unusable zone falls back rather than printing nothing", () => {
    expect(kot.kotStamp(new Date("2026-08-25T09:53:00Z"), "Not/AZone")).toBe("25/08/26 15:23");
    expect(kot.kotStamp(new Date("2026-08-25T09:53:00Z"), "")).toBe("25/08/26 15:23");
  });
});

describe("serviceModeLabel / kotOrderContext", () => {
  test("maps the stored order_type tokens to kitchen wording", () => {
    expect(kot.serviceModeLabel("dine_in")).toBe("Dine In");
    expect(kot.serviceModeLabel(null)).toBe("Dine In"); // AddOrder's default
    expect(kot.serviceModeLabel("takeaway")).toBe("Takeaway");
    expect(kot.serviceModeLabel("delivery")).toBe("Delivery");
    expect(kot.serviceModeLabel("swiggy")).toBe("Delivery (Swiggy)");
    expect(kot.serviceModeLabel("zomato")).toBe("Delivery (Zomato)");
  });

  test("an unknown channel is title-cased, never silently read as dine-in", () => {
    expect(kot.serviceModeLabel("drive_thru")).toBe("Drive Thru");
  });

  test("a physical table is a running table; a virtual one announces its channel", () => {
    expect(kot.kotOrderContext(false, "Dine In")).toBe("Running Table");
    expect(kot.kotOrderContext(true, "Takeaway")).toBe("Takeaway");
  });
});
