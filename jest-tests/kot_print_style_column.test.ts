// "Restaurant".kot_print_style AGAINST A DATABASE — the read when the database
// is not cooperating, and the write that is the owner's way out.
//
// Both halves are driven against the REAL functions over a fixture Pool, because
// what is under test is SQL: a restatement of either statement in a mock would
// pass while the shipped one did nothing. The fixture therefore behaves like the
// column rather than like a script — what the write stores is what the next read
// answers — so a save that stops writing is a save that reads back wrong.
//
// THE READ.
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
// THE WRITE.
//
// One statement inside SetRestaurantSettings' transaction persists the choice,
// and it is the entire escape hatch: if it stops running, an owner standing at a
// printer that is producing blank tickets picks "Classic text docket", is told
// the settings were saved, and the next KOT is blank again. Nothing on any
// screen would say otherwise — the route answers 200, the audit entry is
// written, and the setting reads back as whatever it already was.
//
// So the write is exercised here, not restated: the real SetRestaurantSettings
// runs, and what is asserted is the statement it issued, the connection it
// issued it on, and the value the caller is handed back afterwards.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";

const RES = "11111111-1111-4111-8111-111111111111";
const OUTLET = "22222222-2222-4222-8222-222222222222";
const SLUG = "fixture";

/** What the `select kot_print_style` statement does. */
type StyleAnswer =
  | { kind: "value"; value: unknown }
  | { kind: "throw"; err: unknown };

/**
 * WHAT THE COLUMN CURRENTLY HOLDS.
 *
 * The write path sets this, the read path answers from it — the fixture models
 * the column rather than scripting each statement, so "the save stored it" and
 * "the read gives it back" are the same fact here that they are in Postgres.
 */
const styleAnswer: { value: StyleAnswer } = { value: { kind: "value", value: null } };
/** How many times the column was actually asked for. */
const styleReads = { n: 0 };
/**
 * "Restaurant".kot_text_size, modelled the same way — its own cell, its own
 * reads — because the whole point of its separate statement is that it can be
 * missing or failing while the style is fine.
 */
const sizeAnswer: { value: StyleAnswer } = { value: { kind: "value", value: null } };
const sizeReads = { n: 0 };

/** One statement the code under test issued, and the connection it went out on. */
interface Statement { sql: string; params: unknown[]; on: "pool" | "transaction" }
/** Every statement, in order. Reset per test. */
const statements: Statement[] = [];

/**
 * What the big settings UPDATE returns. Only its shape matters: the fields this
 * file asserts on are read separately (the style) or defaulted (everything
 * else). msg_webhook_secret is already minted so no save mints a second one.
 */
const SETTINGS_ROW: Record<string, unknown> = {
  auto_push_orders: true, currency: "₹", payment_config: null,
  razorpay_key_id: null, razorpay_key_secret: null, service_charge: 0,
  discount_approval_threshold: 0, bill_reopen_window_min: 240,
  alert_discount_pct: 10, alert_void_count: 5,
  loyalty_earn_per_100: 0, loyalty_point_value: 1,
  booking_deposit_amount: 0, booking_deposit_min_party: 0,
  booking_cancel_window_hours: 24, booking_min_spend: 0,
  msg_provider: "none", msg_sender: null, msg_key_id: null, msg_key_secret: null,
  msg_reminder_hours: 2, msg_webhook_secret: "already-minted",
  feedback_config: null, bill_logo_svg: null, bill_paper_width: "80mm",
  bill_legal_name: null, bill_gstin: null, bill_qr_note: null,
  kitchen_sections: null, inventory_categories: null, timezone: "Asia/Kolkata",
  require_table_otp: false, kot_auto_print: true, bill_show_qr: true,
  theme_color: null, brand_config: null,
};

jest.mock("pg", () => {
  const answer = (sql: string, params: unknown[]): unknown[] => {
    const q = String(sql);
    // ensureBrandingColumns' DDL and the transaction verbs. Recorded (so the
    // tests can see the ordering) but there is nothing to answer with.
    if (/^\s*(alter table|begin|commit|rollback|savepoint|release|set )/i.test(q)) { return []; }
    if (q.includes("select kot_print_style")) {
      styleReads.n += 1;
      const a = styleAnswer.value;
      if (a.kind === "throw") { throw a.err; }
      return [{ kot_print_style: a.value }];
    }
    // THE WRITE — matched before the big settings update below, which also
    // begins `update "Restaurant" set`. Storing it here is what makes the read
    // after a save answer what the owner chose.
    if (q.includes("set kot_print_style")) {
      styleAnswer.value = { kind: "value", value: params[1] };
      return [];
    }
    if (q.includes("select kot_text_size")) {
      sizeReads.n += 1;
      const a = sizeAnswer.value;
      if (a.kind === "throw") { throw a.err; }
      return [{ kot_text_size: a.value }];
    }
    if (q.includes("set kot_text_size")) {
      sizeAnswer.value = { kind: "value", value: params[1] };
      return [];
    }
    if (q.includes('from "Restaurant" r')) {
      return [{
        res_id: RES, outlet_id: OUTLET,
        restaurant_slug: SLUG, restaurant_name: "Fixture Diner",
        restaurant_main_office_add: null, restaurant_logo_url: null,
        timezone: "Asia/Kolkata",
      }];
    }
    if (q.includes('update "Restaurant" set')) { return [{ ...SETTINGS_ROW }]; }
    // GetRestaurantSettings' own row. The two docket columns are NOT in it —
    // they are read through the statements above — so answering it with the
    // settings row is enough for the settings document to be built for real.
    if (/^\s*select auto_push_orders,/i.test(q)) { return [{ ...SETTINGS_ROW }]; }
    if (q.includes('select default_tax from "Outlets"')) { return [{ default_tax: null }]; }
    // Everything these two paths touch is answered above. Anything else is the
    // test drifting off the statements it means to drive.
    throw new Error(`kot_print_style fixture: no answer for: ${q.replace(/\s+/g, " ").trim().slice(0, 140)}`);
  };
  const run = (on: "pool" | "transaction") => (sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
    statements.push({ sql: String(sql), params, on });
    // Thrown synchronously inside `answer`, returned as a rejection — which is
    // how `pg` surfaces a failed statement.
    try { return Promise.resolve({ rows: answer(String(sql), params) }); }
    catch (err) { return Promise.reject(err); }
  };
  /** A checked-out client — i.e. the connection a transaction runs on. */
  class FakeClient {
    query = run("transaction");
    release(): void { /* back to the pool */ }
  }
  class FakePool {
    on(): this { return this; }
    query = run("pool");
    connect(): Promise<FakeClient> { return Promise.resolve(new FakeClient()); }
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
  sizeAnswer.value = { kind: "value", value: null };
  sizeReads.n = 0;
  statements.length = 0;
});

/** A `pg` error for a column that is not there. */
const undefinedColumn = (column = "kot_print_style"): Error & { code: string } =>
  Object.assign(new Error(`column "${column}" does not exist`), { code: "42703" });

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

// ============================================================================
// THE WRITE: the statement that actually persists the owner's escape hatch
// ============================================================================

/** Every statement that touched the column, in order. */
const styleWrites = (): Statement[] => statements.filter((s) => s.sql.includes("set kot_print_style"));
/** The transaction's statements, whitespace-flattened, in order. */
const txnStatements = (): string[] =>
  statements.filter((s) => s.on === "transaction").map((s) => s.sql.replace(/\s+/g, " ").trim());

describe("SetRestaurantSettings stores the choice", () => {
  test("THE ESCAPE HATCH: choosing the classic docket is WRITTEN, inside the save's transaction", async () => {
    // If this statement stops running, an owner standing at a printer that is
    // producing blank tickets picks "Classic text docket", is told the settings
    // were saved, and the next KOT is blank again.
    await db.SetRestaurantSettings(SLUG, { kot_print_style: "classic" });

    const writes = styleWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.sql).toContain(`update "Restaurant" set kot_print_style = $2 where id = $1`);
    expect(writes[0]!.params).toEqual([RES, "classic"]);
    // ON THE TRANSACTION'S CLIENT, not the pool: the choice and the rest of the
    // save commit or roll back together, so a save that answers 500 has not
    // quietly moved a kitchen onto a different docket.
    expect(writes[0]!.on).toBe("transaction");
  });

  test("...and it is the whole transaction's business, in order", async () => {
    await db.SetRestaurantSettings(SLUG, { kot_print_style: "classic" });

    const order = txnStatements();
    const write = order.findIndex((s) => s.includes("set kot_print_style"));
    const settingsRow = order.findIndex((s) => s.includes("auto_push_orders = coalesce"));
    expect(order[0]).toMatch(/^BEGIN$/i);
    expect(write).toBeGreaterThan(0);
    // The big settings update stays this transaction's LAST statement — the
    // invariant test/money/payment_modes_routes.test.ts pins from the source
    // side, because payment modes must be written in the same transaction as
    // every other setting.
    expect(settingsRow).toBeGreaterThan(write);
    expect(settingsRow).toBe(order.length - 2);
    expect(order[order.length - 1]).toMatch(/^COMMIT$/i);
  });

  test("the settings the caller is handed back say what was just stored", async () => {
    // The route echoes this document to the dashboard, which renders the radio
    // from it. A save that stored nothing but reported 'classic' would put a
    // checked radio in front of an owner whose kitchen is still blank-ticketing.
    const saved = await db.SetRestaurantSettings(SLUG, { kot_print_style: "classic" });
    expect(saved.kot_print_style).toBe("classic");
  });

  test("and back again: choosing the reference docket is just as much a write", async () => {
    // The way out has to work in both directions — a kitchen whose printer was
    // replaced goes back to the docket the client asked for.
    styleAnswer.value = { kind: "value", value: "classic" };
    const saved = await db.SetRestaurantSettings(SLUG, { kot_print_style: "reference" });
    expect(styleWrites().map((s) => s.params)).toEqual([[RES, "reference"]]);
    expect(saved.kot_print_style).toBe("reference");
  });

  test("A SAVE THAT DOES NOT MENTION THE SWITCH ISSUES NO STATEMENT AT ALL", async () => {
    // Two reasons this matters. The column ships as runtime DDL and migration
    // 050 is applied by hand, so naming it in a save that did not ask for it
    // would make an unrelated setting fail in that window. And a kitchen that
    // has chosen 'classic' must not be moved back onto the docket it cannot
    // print by somebody changing the currency.
    styleAnswer.value = { kind: "value", value: "classic" };
    const saved = await db.SetRestaurantSettings(SLUG, { currency: "INR" });
    expect(styleWrites()).toHaveLength(0);
    expect(saved.kot_print_style).toBe("classic");
  });

  test("a value that is not one of the two styles writes nothing", async () => {
    // The route refuses this with a 400 before it gets here (see
    // kot_print_style_route.test.ts); parseKotPrintStyle refusing it again is
    // what stops any OTHER caller of the data layer coercing a kitchen's docket.
    styleAnswer.value = { kind: "value", value: "classic" };
    const saved = await db.SetRestaurantSettings(SLUG, { kot_print_style: "raster-v2" });
    expect(styleWrites()).toHaveLength(0);
    expect(saved.kot_print_style).toBe("classic");
  });
});

// ============================================================================
// "Restaurant".kot_text_size — how large the reference docket's type is
// ============================================================================
//
// The same two halves as the style, with one extra property that is the reason
// the size has a statement of its own: it can be missing or failing while the
// style is fine, and the style — the escape hatch — must not notice.

describe("GetKotTextSize", () => {
  test("reads the restaurant's choice", async () => {
    sizeAnswer.value = { kind: "value", value: "small" };
    await expect(db.GetKotTextSize(SLUG)).resolves.toBe("small");
    expect(sizeReads.n).toBe(1);
  });

  test("NULL, and anything unrecognised, is the standard size — the client's reference ticket", async () => {
    for (const value of [null, "", "medium", "SMALLER", 24]) {
      sizeAnswer.value = { kind: "value", value };
      await expect(db.GetKotTextSize(SLUG)).resolves.toBe("standard");
    }
  });

  test("case and stray whitespace still select the size they name", async () => {
    sizeAnswer.value = { kind: "value", value: " Large " };
    await expect(db.GetKotTextSize(SLUG)).resolves.toBe("large");
  });

  test("a column that does not exist yet reads as standard and never throws", async () => {
    // The deploy window again: every KOT goes through this read.
    sizeAnswer.value = { kind: "throw", err: undefinedColumn("kot_text_size") };
    await expect(db.GetKotTextSize(SLUG)).resolves.toBe("standard");
    await expect(db.GetKotTextSize(SLUG)).resolves.toBe("standard");
  });

  test("a failed read answers with the last size this process saw, then follows the database again", async () => {
    sizeAnswer.value = { kind: "value", value: "large" };
    await expect(db.GetKotTextSize(SLUG)).resolves.toBe("large");
    sizeAnswer.value = { kind: "throw", err: new Error("connection terminated unexpectedly") };
    await expect(db.GetKotTextSize(SLUG)).resolves.toBe("large");
    sizeAnswer.value = { kind: "value", value: "small" };
    await expect(db.GetKotTextSize(SLUG)).resolves.toBe("small");
  });

  test("nothing is served from memory while the database can be read", async () => {
    // An owner who picks "Small" and presses Print test must see small type.
    sizeAnswer.value = { kind: "value", value: "standard" };
    await db.GetKotTextSize(SLUG);
    sizeAnswer.value = { kind: "value", value: "small" };
    await expect(db.GetKotTextSize(SLUG)).resolves.toBe("small");
    expect(sizeReads.n).toBe(2);
  });

  test("A MISSING SIZE COLUMN NEVER TOUCHES THE STYLE: a classic kitchen stays classic", async () => {
    // The reason the two columns are read by two statements. A database that
    // has kot_print_style but not kot_text_size (the runtime DDL adds them in
    // that order, and the second can fail alone) must still hand the escape
    // hatch back exactly — a combined read would have 42703'd both.
    styleAnswer.value = { kind: "value", value: "classic" };
    sizeAnswer.value = { kind: "throw", err: undefinedColumn("kot_text_size") };
    await expect(db.GetKotPrintStyle(SLUG)).resolves.toBe("classic");
    await expect(db.GetKotTextSize(SLUG)).resolves.toBe("standard");
    const reads = statements.map((s) => s.sql).filter((sql) => /select kot_/.test(sql));
    expect(reads.some((sql) => sql.includes("kot_print_style") && sql.includes("kot_text_size"))).toBe(false);
  });
});

/** Every statement that wrote the size, in order. */
const sizeWrites = (): Statement[] => statements.filter((s) => s.sql.includes("set kot_text_size"));

describe("SetRestaurantSettings stores the text size", () => {
  test("choosing a size is WRITTEN, on the transaction's client", async () => {
    await db.SetRestaurantSettings(SLUG, { kot_text_size: "small" });
    const writes = sizeWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.sql).toContain(`update "Restaurant" set kot_text_size = $2 where id = $1`);
    expect(writes[0]!.params).toEqual([RES, "small"]);
    expect(writes[0]!.on).toBe("transaction");
  });

  test("…before the settings row, which stays the transaction's last statement", async () => {
    await db.SetRestaurantSettings(SLUG, { kot_text_size: "large" });
    const order = txnStatements();
    const write = order.findIndex((s) => s.includes("set kot_text_size"));
    const settingsRow = order.findIndex((s) => s.includes("auto_push_orders = coalesce"));
    expect(write).toBeGreaterThan(0);
    expect(settingsRow).toBeGreaterThan(write);
    expect(settingsRow).toBe(order.length - 2);
    expect(order[order.length - 1]).toMatch(/^COMMIT$/i);
  });

  test("the settings handed back say what was just stored", async () => {
    const saved = await db.SetRestaurantSettings(SLUG, { kot_text_size: "large" });
    expect(saved.kot_text_size).toBe("large");
    // …and back to standard is just as much a write.
    const again = await db.SetRestaurantSettings(SLUG, { kot_text_size: "standard" });
    expect(sizeWrites().map((s) => s.params)).toEqual([[RES, "large"], [RES, "standard"]]);
    expect(again.kot_text_size).toBe("standard");
  });

  test("a save that does not mention the size issues no size statement, and keeps the stored size", async () => {
    sizeAnswer.value = { kind: "value", value: "small" };
    const saved = await db.SetRestaurantSettings(SLUG, { currency: "INR" });
    expect(sizeWrites()).toHaveLength(0);
    expect(saved.kot_text_size).toBe("small");
  });

  test("a value that is not a size writes nothing", async () => {
    sizeAnswer.value = { kind: "value", value: "large" };
    const saved = await db.SetRestaurantSettings(SLUG, { kot_text_size: "huge" });
    expect(sizeWrites()).toHaveLength(0);
    expect(saved.kot_text_size).toBe("large");
  });

  test("the size and the style are separate writes, and one never carries the other", async () => {
    await db.SetRestaurantSettings(SLUG, { kot_text_size: "small" });
    expect(styleWrites()).toHaveLength(0);
    statements.length = 0;
    await db.SetRestaurantSettings(SLUG, { kot_print_style: "classic" });
    expect(sizeWrites()).toHaveLength(0);
    statements.length = 0;
    const both = await db.SetRestaurantSettings(SLUG, { kot_print_style: "reference", kot_text_size: "large" });
    expect(styleWrites().map((s) => s.params)).toEqual([[RES, "reference"]]);
    expect(sizeWrites().map((s) => s.params)).toEqual([[RES, "large"]]);
    expect([both.kot_print_style, both.kot_text_size]).toEqual(["reference", "large"]);
  });

  test("a style save still succeeds on a database that has no size column yet", async () => {
    // The deploy window from the other side: the owner flips to classic, the
    // size column is missing, and the save must neither fail nor lie.
    sizeAnswer.value = { kind: "throw", err: undefinedColumn("kot_text_size") };
    const saved = await db.SetRestaurantSettings(SLUG, { kot_print_style: "classic" });
    expect(saved.kot_print_style).toBe("classic");
    expect(saved.kot_text_size).toBe("standard");
  });
});

// ============================================================================
// THE READ THAT SEEDS BOTH CARDS: GET /restaurant/settings
// ============================================================================
//
// The web dashboard's "KOT print style" card and the app's Settings card are
// both seeded from this document, and both treat it as the truth. A settings
// read that reported the DEFAULTS instead of the stored words would put
// "Standard" in front of an owner whose kitchen prints Small (or "reference" in
// front of a kitchen on the classic docket), and the next pick would be made
// against a value that is not there. kot_print_style_route.test.ts mocks this
// function, so the document is built for real here, from the same column cells
// the saves above write.

describe("GetRestaurantSettings reports what the restaurant stored", () => {
  test("a stored size and a stored style are what the document says", async () => {
    sizeAnswer.value = { kind: "value", value: "small" };
    styleAnswer.value = { kind: "value", value: "classic" };
    const settings = await db.GetRestaurantSettings(SLUG);
    expect(settings.kot_text_size).toBe("small");
    expect(settings.kot_print_style).toBe("classic");
    // …each through its own statement, as the dispatcher reads them.
    expect(sizeReads.n).toBe(1);
    expect(styleReads.n).toBe(1);
  });

  test("the other stored words come back too — not whichever is the default", async () => {
    // 'standard' / 'reference' are the defaults, so they cannot tell a real read
    // from a hardcoded one; 'large' and 'classic' (above: 'small') can.
    sizeAnswer.value = { kind: "value", value: "large" };
    styleAnswer.value = { kind: "value", value: "reference" };
    const settings = await db.GetRestaurantSettings(SLUG);
    expect([settings.kot_print_style, settings.kot_text_size]).toEqual(["reference", "large"]);
  });

  test("what a save stored is what the next settings read reports", async () => {
    await db.SetRestaurantSettings(SLUG, { kot_text_size: "small" });
    await db.SetRestaurantSettings(SLUG, { kot_print_style: "classic" });
    const settings = await db.GetRestaurantSettings(SLUG);
    expect([settings.kot_print_style, settings.kot_text_size]).toEqual(["classic", "small"]);
  });

  test("both keys are ALWAYS in the document, even before migration 050 is applied", async () => {
    // The clients detect this backend by the keys being present (an older one
    // never sends them, and prints only the classic docket). A missing column
    // is the default, never an absent key or a 500.
    styleAnswer.value = { kind: "throw", err: undefinedColumn() };
    sizeAnswer.value = { kind: "throw", err: undefinedColumn("kot_text_size") };
    const settings = await db.GetRestaurantSettings(SLUG);
    expect(settings).toHaveProperty("kot_print_style", "reference");
    expect(settings).toHaveProperty("kot_text_size", "standard");
  });
});
