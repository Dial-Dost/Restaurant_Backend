// READING "Restaurant".kot_print_style WHEN THE DATABASE IS NOT COOPERATING.
//
// This column is the owner's escape hatch from a kitchen printer that answers a
// raster docket with blank paper, and it is read ONCE PER DOCKET on the path
// that puts paper on the pass. So the read has one hard requirement: it must
// always produce an answer, and the answer must not be dangerous.
//
// "Not dangerous" is asymmetric, and that asymmetry is the whole point of this
// file. A restaurant only ever chooses 'classic' BECAUSE its printer cannot draw
// the raster docket. Answering a failed read with the default therefore hands
// exactly that kitchen a docket it prints as nothing — the failure mode the
// switch exists to end. So:
//
//   * a column that does not exist yet (42703 — the backend ships before
//     migration 050 is applied by hand on the VPS) is "nobody can have chosen",
//     which really is the default;
//   * a read that FAILED is "I cannot tell", and the honest answer to that is
//     the last style this process actually saw for this restaurant.
//
// Driven against the REAL GetKotPrintStyle over a fixture Pool, because what is
// under test is the SQL and its error handling — a restatement of either in a
// mock would pass while the shipped read threw.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";

const RES = "11111111-1111-4111-8111-111111111111";
const OUTLET = "22222222-2222-4222-8222-222222222222";
const SLUG = "fixture";

/** What the `select kot_print_style` statement does. */
type StyleAnswer =
  | { kind: "value"; value: unknown }
  | { kind: "throw"; err: unknown };

const styleAnswer: { value: StyleAnswer } = { value: { kind: "value", value: null } };
/** How many times the column was actually asked for. */
const styleReads = { n: 0 };

jest.mock("pg", () => {
  const answer = (sql: string): unknown[] => {
    const q = String(sql);
    if (q.includes("select kot_print_style")) {
      styleReads.n += 1;
      const a = styleAnswer.value;
      if (a.kind === "throw") { throw a.err; }
      return [{ kot_print_style: a.value }];
    }
    if (q.includes('from "Restaurant" r')) {
      return [{
        res_id: RES, outlet_id: OUTLET,
        restaurant_slug: SLUG, restaurant_name: "Fixture Diner",
        restaurant_main_office_add: null, restaurant_logo_url: null,
        timezone: "Asia/Kolkata",
      }];
    }
    // Everything this read touches is answered above. Anything else is the test
    // drifting off the statement it means to drive.
    throw new Error(`kot_print_style fixture: no answer for: ${q.replace(/\s+/g, " ").trim().slice(0, 140)}`);
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string): Promise<{ rows: unknown[] }> {
      // Thrown synchronously inside `answer`, returned as a rejection — which is
      // how `pg` surfaces a failed statement.
      try { return Promise.resolve({ rows: answer(sql) }); }
      catch (err) { return Promise.reject(err); }
    }
    connect(): Promise<never> { return Promise.reject(new Error("kot_print_style fixture: pool.connect() is not stubbed")); }
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
  styleAnswer.value = { kind: "value", value: null };
  styleReads.n = 0;
});

/** A `pg` error for a column that is not there. */
const undefinedColumn = (): Error & { code: string } =>
  Object.assign(new Error(`column "kot_print_style" does not exist`), { code: "42703" });

describe("GetKotPrintStyle", () => {
  test("reads the restaurant's choice", async () => {
    styleAnswer.value = { kind: "value", value: "classic" };
    await expect(db.GetKotPrintStyle(SLUG)).resolves.toBe("classic");
    expect(styleReads.n).toBe(1);
  });

  test("a NULL column is a restaurant that has never chosen — the default", async () => {
    styleAnswer.value = { kind: "value", value: null };
    await expect(db.GetKotPrintStyle(SLUG)).resolves.toBe("reference");
  });

  test("a value nobody recognises is also the default, not an error", async () => {
    // Written by hand, or by a version of this product that is not this one. A
    // docket that refused to print over an unreadable settings string would be a
    // worse outage than any layout question.
    styleAnswer.value = { kind: "value", value: "raster-v2" };
    await expect(db.GetKotPrintStyle(SLUG)).resolves.toBe("reference");
  });

  test("case and stray whitespace in the stored value still select the docket it names", async () => {
    styleAnswer.value = { kind: "value", value: " Classic " };
    await expect(db.GetKotPrintStyle(SLUG)).resolves.toBe("classic");
  });

  test("a column that does not exist yet reads as the default and never throws", async () => {
    // THE DEPLOY WINDOW. The backend ships, migration 050 is applied by hand on
    // the VPS afterwards, and every KOT in between goes through this read. If it
    // threw, dispatchKot would throw, autoPrintOrderKot would log
    // order_auto_print_failed, and no kitchen in the estate would get paper.
    styleAnswer.value = { kind: "throw", err: undefinedColumn() };
    await expect(db.GetKotPrintStyle(SLUG)).resolves.toBe("reference");
    // And again — repeating is normal in that window, and must stay silent after
    // the first warn (the log is what an operator is reading at that moment).
    await expect(db.GetKotPrintStyle(SLUG)).resolves.toBe("reference");
  });

  test("a failed read answers with the last style this process actually saw", async () => {
    // THE CASE THIS FUNCTION EXISTS FOR. A dispatch can reach here with the
    // database unwell — withStations swallows its own settings failure and
    // prints an unsplit docket rather than none — so "the read failed" and "the
    // kitchen is still printing" happen together. Answering 'reference' to a
    // restaurant that had chosen 'classic' is the blank ticket.
    styleAnswer.value = { kind: "value", value: "classic" };
    await expect(db.GetKotPrintStyle(SLUG)).resolves.toBe("classic");

    styleAnswer.value = { kind: "throw", err: new Error("connection terminated unexpectedly") };
    await expect(db.GetKotPrintStyle(SLUG)).resolves.toBe("classic");

    // ...and it is a fallback, not a cache: the moment the database answers
    // again, the answer is whatever the column now says.
    styleAnswer.value = { kind: "value", value: "reference" };
    await expect(db.GetKotPrintStyle(SLUG)).resolves.toBe("reference");
  });

  test("nothing is served from memory while the database can be read", async () => {
    // An owner flips this switch standing at a printer that is producing blank
    // tickets. "The next KOT prints as text again" has to be literally true, so
    // there is no positive TTL to wait out.
    styleAnswer.value = { kind: "value", value: "reference" };
    await db.GetKotPrintStyle(SLUG);
    styleAnswer.value = { kind: "value", value: "classic" };
    await expect(db.GetKotPrintStyle(SLUG)).resolves.toBe("classic");
    expect(styleReads.n).toBe(2);
  });
});
