// THE LAST THREE DOORS THE CENSUS FOUND, and they are all ways of taking money
// off a bill without ever touching a gate that watches for it.
//
// The six doors closed before this one all LOOK like money leaving: a settle, a
// release, a discount, a coupon, a redemption, a stripped line. Each got a gate.
// These three do not look like money leaving at all:
//
//   1. A NEGATIVE LINE. `POST /orders` floors every line that resolves to a menu
//      row and bills an UNRESOLVED line exactly as typed — deliberately, because
//      a valet fee and an aggregator line are real charges that are not on the
//      menu. "Exactly as typed" accepted a negative number, so
//      { name: "Adjustment", price: -4000 } reduced the order subtotal, reduced
//      the table's bill, and was audited as an item being ADDED.
//
//   2. A MOVE THAT DOES NOT CONSERVE. `POST /bills/move-item` matches on NAME
//      alone when the caller omits a price, which the dashboard does. It removed
//      every matching line at its own price and rebuilt ONE line on the
//      destination at `lastMatchedPrice x totalQuantity`. Two "Biryani" lines at
//      two variation prices therefore left the source at 1,400 and arrived worth
//      800. Neither table looks stripped; the money simply is not there.
//
//   3. AN APPROVAL QUEUE WITH ONE PAIR OF EYES. A discount above the tenant's
//      threshold is parked for review. Nothing checked that the reviewer was not
//      the requester, and nothing re-judged the request against the table as it
//      stood at APPROVAL time — so a flat request sized against a large table
//      could be approved against a small one, by the person who raised it.
//
// WHAT THIS SUITE ASSERTS. Doors 1 and 2 are pure arithmetic over the real
// shipped functions, so they are tested directly with no database at all. Door 3
// is a transaction, so it is tested over a faked `pg` with the REAL
// DecideDiscountRequest running — and the assertion is about the WRITE, never
// about a response body: `update "Bills" set discount_type` either ran or it did
// not.
//
// AND NOBODY WHO RUNS A TILL LOSES ANYTHING. Every refusal case is paired with
// the same case for an admin, a manager, a cashier and a captain, because "the
// fix emptied the till" is the failure this whole block risks most.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { clampLineCharge, chargeableSubtotal } from "../billing_math";
import { isDiscountAuthorityError } from "../discount_authority";

const CLOSE_BILL = "a953d044-31ba-4e31-b96f-99304fe43dfa";
const APPROVE_DISCOUNTS = "9a3c6e81-7d40-4b52-8f19-2c6b4a0e7d35";

const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";
const TABLE_ID = "33333333-3333-3333-3333-333333333333";
const BILL_ID = "55555555-5555-5555-5555-555555555555";
const REQ_ID = "66666666-6666-6666-6666-666666666666";

// ===========================================================================
// DOOR 1 — A CHARGE IS NEVER NEGATIVE
// ===========================================================================
describe("a line can cost nothing and can never cost less than nothing", () => {
  test("a negative price is clamped to zero", () => {
    expect(clampLineCharge({ price: -4000, quantity: 1 })).toMatchObject({ price: 0, quantity: 1, clamped: true });
  });

  test("an ordinary line is untouched, and says so", () => {
    expect(clampLineCharge({ price: 390, quantity: 3 })).toEqual({ price: 390, quantity: 3, clamped: false });
  });

  test("a free line is allowed — zero is a price, negative is not", () => {
    expect(clampLineCharge({ price: 0, quantity: 1 })).toEqual({ price: 0, quantity: 1, clamped: false });
  });

  test("an off-menu charge keeps whatever positive price it was typed at", () => {
    // The valet fee, the aggregator line, the one-off open item. The clamp must
    // not become a floor: refusing these would break the till for a rule.
    for (const price of [1, 49.5, 12345.67]) {
      expect(clampLineCharge({ price, quantity: 1 }).price).toBe(price);
    }
  });

  test("a quantity that is not a quantity becomes one, so the ticket cannot print -3x", () => {
    expect(clampLineCharge({ price: 100, quantity: -3 })).toMatchObject({ price: 100, quantity: 1, clamped: true });
    expect(clampLineCharge({ price: 100, quantity: 0 })).toMatchObject({ quantity: 1, clamped: true });
  });

  test("but a FRACTION is left alone — selling half a kilo is ordinary", () => {
    // Rounding this up would double what the ticket says the guest ordered, which
    // is a worse bug than the one being fixed and in the guest's disfavour.
    expect(clampLineCharge({ price: 800, quantity: 0.5 })).toEqual({ price: 800, quantity: 0.5, clamped: false });
    expect(clampLineCharge({ price: 800, quantity: 2.25 })).toEqual({ price: 800, quantity: 2.25, clamped: false });
  });

  test("rubbish coerces to a free line rather than throwing at the pass", () => {
    // Order entry must never fail because one field was odd — the whole design of
    // applyMenuPriceFloor is that it degrades rather than blocks.
    for (const bad of [undefined, null, "", "abc", NaN, Infinity, -Infinity]) {
      const out = clampLineCharge({ price: bad, quantity: bad });
      expect(out.price).toBeGreaterThanOrEqual(0);
      expect(out.quantity).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(out.price)).toBe(true);
    }
  });

  test("THE DOOR ITSELF: a negative adjustment can no longer reduce an order", () => {
    const honest = [{ name: "Biryani", price: 1000, quantity: 1 }];
    const attack = [...honest, { name: "Adjustment", price: -900, quantity: 1 }];
    // What it used to do.
    expect(chargeableSubtotal(attack)).toBe(100);
    // What it does once every line goes through the clamp the order paths apply.
    const clamped = attack.map((l) => ({ ...l, ...clampLineCharge(l) }));
    expect(chargeableSubtotal(clamped)).toBe(1000);
  });

  test("and a negative quantity cannot reverse a line's sign either", () => {
    const attack = [{ name: "Biryani", price: 1000, quantity: 1 }, { name: "Biryani", price: 1000, quantity: -5 }];
    const clamped = attack.map((l) => ({ ...l, ...clampLineCharge(l) }));
    expect(chargeableSubtotal(clamped)).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// …AND THE ORDER PATH ACTUALLY APPLIES IT
// ---------------------------------------------------------------------------
// The tests above pin the RULE. A mutation survey then showed they do not pin
// the DOOR: gutting applyMenuPriceFloor's clamp so an off-menu line is billed
// as typed again left all of them green. That is this project's most repeated
// bug in miniature — a correct thing built, and nobody calling it — so the wiring
// gets its own assertion, over the real shipped function.
describe("applyMenuPriceFloor is where the clamp actually happens", () => {
  const BIRYANI = "aaaaaaaa-0000-0000-0000-000000000001";

  /** The real function, against a one-dish menu. */
  const floor = <T,>(items: T[]): Promise<T[]> => {
    fx.menu = [menuRow(BIRYANI, "Biryani", 390)];
    return db.applyMenuPriceFloor(RES, items);
  };

  test("THE DOOR: an off-menu line priced below zero is billed at zero", async () => {
    const [line] = await floor([{ name: "Adjustment", price: -4000, quantity: 1 }]);
    expect((line as { price: number }).price).toBe(0);
  });

  test("a genuine off-menu charge is still billed exactly as typed", async () => {
    // The valet fee and the aggregator line are the reason this path exists.
    const [line] = await floor([{ name: "Valet", price: 150, quantity: 1 }]);
    expect(line).toMatchObject({ name: "Valet", price: 150, quantity: 1 });
  });

  test("an on-menu line is still floored at its menu price, as it always was", async () => {
    const [line] = await floor([{ id: BIRYANI, name: "Biryani", price: 1, quantity: 3 }]);
    expect((line as { price: number }).price).toBe(390);
  });

  test("an on-menu line above the menu price keeps its upcharge", async () => {
    const [line] = await floor([{ id: BIRYANI, name: "Biryani", price: 450, quantity: 1 }]);
    expect((line as { price: number }).price).toBe(450);
  });

  test("and a NEGATIVE on-menu line cannot slip through the floor either", async () => {
    const [line] = await floor([{ id: BIRYANI, name: "Biryani", price: -5000, quantity: 1 }]);
    expect((line as { price: number }).price).toBe(390);
  });

  test("the whole attack, end to end: the order subtotal does not drop", async () => {
    const priced = await floor([
      { id: BIRYANI, name: "Biryani", price: 390, quantity: 1 },
      { name: "Adjustment", price: -300, quantity: 1 },
    ]);
    expect(chargeableSubtotal(priced as { price: number; quantity: number }[])).toBe(390);
  });
});

// ===========================================================================
// DOOR 2 — A MOVE CONSERVES
// ===========================================================================
//
// MoveBillItem is a transaction, but the defect and the fix are both arithmetic:
// the old code summarised N removed lines as { lastPrice, totalQty } and rebuilt
// `lastPrice x totalQty`. That is stated here as the invariant it broke, so the
// property is pinned independently of the SQL around it. The wiring itself —
// that MoveBillItem builds its destination items from `moved.lines` — is asserted
// against the shipped source, for the same reason the items-split call sites are:
// a field nobody passes is this project's most repeated bug.
describe("what the destination table gains is what the source table lost", () => {
  const value = (lines: { price: number; quantity: number }[]) =>
    Math.round(lines.reduce((s, l) => s + l.price * l.quantity, 0) * 100) / 100;

  /** The collapse that shipped: every line becomes one, at the LAST price. */
  const collapse = (lines: { name: string; price: number; quantity: number }[]) => {
    const last = lines[lines.length - 1];
    const qty = lines.reduce((s, l) => s + l.quantity, 0);
    return [{ name: last.name, price: last.price, quantity: qty }];
  };

  const twoVariations = [
    { name: "Biryani", price: 1000, quantity: 1 },
    { name: "Biryani", price: 400, quantity: 1 },
  ];

  test("the collapse destroyed 600 rupees, which is why this suite exists", () => {
    expect(value(twoVariations)).toBe(1400);
    expect(value(collapse(twoVariations))).toBe(800);
  });

  test("the collapse could also INVENT money, overcharging the destination guest", () => {
    const dearLast = [...twoVariations].reverse();
    expect(value(dearLast)).toBe(1400);
    expect(value(collapse(dearLast))).toBe(2000);
  });

  test("moving the lines as they stood conserves the value exactly", () => {
    expect(value(twoVariations)).toBe(value(twoVariations.map((l) => ({ ...l }))));
  });

  test("and it still conserves when one line carries several covers", () => {
    const lines = [
      { name: "Biryani", price: 1000, quantity: 3 },
      { name: "Biryani", price: 400, quantity: 2 },
    ];
    expect(value(lines)).toBe(3800);
    expect(value(collapse(lines))).toBe(2000); // what shipped
  });

  test("MoveBillItem builds its destination from every removed line, not a summary", () => {
    const src = readSource("database_supabase.ts");
    const fn = src.slice(src.indexOf("export async function MoveBillItem"));
    const body = fn.slice(0, 4000);
    expect(body).toMatch(/moved\.lines\.map/);
    // The exact expression that lost the money. If it ever comes back, so does
    // the bug, and nothing else in this suite would notice.
    expect(body).not.toMatch(/round2\(moved\.price \* moved\.quantity\)/);
  });

  test("and removeItemFromTableOrders returns those lines in the first place", () => {
    const src = readSource("database_supabase.ts");
    const fn = src.slice(src.indexOf("async function removeItemFromTableOrders"));
    expect(fn.slice(0, 4000)).toMatch(/lines: RemovedBillLine\[\]/);
  });
});

// ===========================================================================
// DOOR 3 — THE APPROVAL QUEUE NEEDS TWO PAIRS OF EYES
// ===========================================================================

/**
 * The outlet's menu, as GetMenuItems' join actually returns it. Empty = the
 * floor is a no-op, which is why every test that needs it sets one.
 *
 * The PRICE lives inside `description` — the menu row carries a JSON blob that
 * parseMenuDescription unpacks — so the fixture has to be shaped that way or the
 * floor reads every dish as costing nothing and the suite passes for the wrong
 * reason.
 */
interface MenuRow { id: string; name: string; description: string }

const menuRow = (id: string, name: string, price: number): MenuRow =>
  ({ id, name, description: JSON.stringify({ price, available: true }) });

interface DecideFixture {
  menu: MenuRow[];
  /** The parked request, as the update…returning row hands it back. */
  request: Record<string, unknown>;
  /** What the table is worth NOW — the number the re-judgement reads. */
  subtotalNow: number;
  billClosed: boolean;
  sql: string[];
  /** Every discount write. THE assertion: empty means the bill survived. */
  writes: { type: unknown; value: unknown }[];
}

const fx: DecideFixture = {
  menu: [],
  request: {},
  subtotalNow: 10000,
  billClosed: false,
  sql: [],
  writes: [],
};

jest.mock("pg", () => {
  const query = async (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    fx.sql.push(q);
    if (/from "Restaurant" r/i.test(q)) {
      return { rows: [{
        res_id: RES, outlet_id: OUTLET, restaurant_slug: "gaia", restaurant_name: "Gaia",
        restaurant_main_office_add: null, restaurant_logo_url: null, timezone: null,
      }] };
    }
    if (/from "Menu" m/i.test(q)) { return { rows: fx.menu }; }
    if (/update "DiscountRequests"/i.test(q)) { return { rows: [fx.request] }; }
    if (/from "Bills" where id = \$1/i.test(q)) {
      return { rows: [{ id: BILL_ID, table_id: TABLE_ID, closed_at: fx.billClosed ? new Date() : null }] };
    }
    // sumOrderTotalsForTable reads the table's still-owing orders.
    if (/from "Orders" where res_id/i.test(q)) {
      return { rows: [{ food: { subtotal: fx.subtotalNow, total: fx.subtotalNow }, status: 1 }] };
    }
    if (/^update "Bills" set discount_type/i.test(q)) {
      const p = (params ?? []) as unknown[];
      fx.writes.push({ type: p[0], value: p[1] });
      return { rows: [] };
    }
    if (/from "Employees"/i.test(q)) { return { rows: [] }; }
    if (/from "Bills"/i.test(q)) { return { rows: [{ id: BILL_ID }] }; }
    return { rows: [] };
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> { return query(sql, params); }
    connect(): Promise<unknown> { return Promise.resolve({ query, release: () => undefined }); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: jest.fn(), emitOutlet: jest.fn() }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: jest.fn() }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

/**
 * A shipped source file, read as text. Resolved off the repo root because these
 * tests run through jest's CommonJS transpile, where `import.meta` does not
 * exist; the throw matters as much as the read, since a path that silently
 * returned nothing would make every source assertion vacuously true.
 */
function readSource(relative: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  for (const base of [process.cwd(), path.join(__dirname, "..")]) {
    const full = path.join(base, relative);
    if (fs.existsSync(full)) { return fs.readFileSync(full, "utf8"); }
  }
  throw new Error(`readSource could not find ${relative} from ${process.cwd()}`);
}

let db: typeof import("../database_supabase");

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
});

/** A request for `amount` off a table that was worth `sizedAgainst` when raised. */
function park(opts: { by: string; type: "percent" | "flat"; value: number; amount: number }): void {
  fx.request = {
    id: REQ_ID, bill_id: BILL_ID, table_name: "T7", requested_by: opts.by,
    discount_type: opts.type, discount_value: opts.value, amount: opts.amount,
    reason: "guest complaint", status: "approved", decided_by: null,
    decided_at: new Date(), created_at: new Date(),
  };
}

beforeEach(() => {
  fx.menu = [];
  fx.sql = [];
  fx.writes = [];
  fx.subtotalNow = 10000;
  fx.billClosed = false;
  park({ by: "raju", type: "flat", value: 2000, amount: 2000 });
});

const decide = (decidedBy: string | null, actions: string[], isAdmin = false) =>
  db.DecideDiscountRequest(RES, REQ_ID, true, decidedBy, {
    isAdmin, actions, closeBillPermission: CLOSE_BILL,
  });

describe("nobody approves their own discount request", () => {
  test("the requester is refused, and the bill is not touched", async () => {
    await expect(decide("raju", [APPROVE_DISCOUNTS]))
      .rejects.toMatchObject({ code: "DISCOUNT_DECISION_REFUSED" });
    expect(fx.writes).toHaveLength(0);
  });

  test("the refusal names the requester, so the person holding the phone knows who to fetch", async () => {
    await expect(decide("raju", [APPROVE_DISCOUNTS])).rejects.toThrow(/requested by raju/i);
  });

  test("somebody else approves it perfectly well", async () => {
    await expect(decide("meena", [APPROVE_DISCOUNTS])).resolves.toBeTruthy();
    expect(fx.writes).toEqual([{ type: "flat", value: 2000 }]);
  });

  test("case and whitespace do not defeat it", async () => {
    park({ by: "  Raju ", type: "flat", value: 2000, amount: 2000 });
    await expect(decide("raju", [APPROVE_DISCOUNTS]))
      .rejects.toMatchObject({ code: "DISCOUNT_DECISION_REFUSED" });
    expect(fx.writes).toHaveLength(0);
  });

  test("REJECTING your own request is refused too — it would erase the evidence", async () => {
    await expect(db.DecideDiscountRequest(RES, REQ_ID, false, "raju", {
      isAdmin: false, actions: [APPROVE_DISCOUNTS], closeBillPermission: CLOSE_BILL,
    })).rejects.toMatchObject({ code: "DISCOUNT_DECISION_REFUSED" });
  });

  test("an admin is exempt — they never needed the queue at all", async () => {
    await expect(decide("raju", ["*"], true)).resolves.toBeTruthy();
    expect(fx.writes).toEqual([{ type: "flat", value: 2000 }]);
  });

  test("a request with no recorded requester is not refused on a null match", async () => {
    park({ by: null as unknown as string, type: "flat", value: 2000, amount: 2000 });
    await expect(decide("meena", [APPROVE_DISCOUNTS])).resolves.toBeTruthy();
  });
});

describe("the request is re-judged against the table as it stands at approval", () => {
  test("THE DRIFT: a 2,000 flat sized against 10,000 is refused once the table is 2,100", async () => {
    fx.subtotalNow = 2100;
    await expect(decide("meena", [APPROVE_DISCOUNTS]))
      .rejects.toMatchObject({ code: "DISCOUNT_WRITE_OFF_REFUSED" });
    expect(fx.writes).toHaveLength(0);
  });

  test("the refusal states BOTH numbers — what was asked for and what the table is now", async () => {
    // The flat clamp makes the AMOUNT identical in both cases (2,000 either way);
    // what moved is the table, so the message has to say so explicitly or the
    // manager being fetched cannot see why an approved-looking request failed.
    fx.subtotalNow = 2100;
    const err = await decide("meena", [APPROVE_DISCOUNTS]).catch((e: unknown) => e);
    expect(isDiscountAuthorityError(err)).toBe(true);
    const message = String((err as { details?: string }).details ?? "");
    expect(message).toMatch(/raised as a .*2000\.00 discount/);
    expect(message).toMatch(/table has changed to .*2100\.00/);
  });

  test("the same request against the table it was sized for is approved", async () => {
    fx.subtotalNow = 10000;
    await expect(decide("meena", [APPROVE_DISCOUNTS])).resolves.toBeTruthy();
    expect(fx.writes).toEqual([{ type: "flat", value: 2000 }]);
  });

  test("a percentage request re-scales with the table and stays ordinary", async () => {
    park({ by: "raju", type: "percent", value: 20, amount: 2000 });
    fx.subtotalNow = 2100;
    await expect(decide("meena", [APPROVE_DISCOUNTS])).resolves.toBeTruthy();
    expect(fx.writes).toEqual([{ type: "percent", value: 20 }]);
  });

  test("a 100% request is a write-off however it is dressed, and Approve Discounts is not enough", async () => {
    park({ by: "raju", type: "percent", value: 100, amount: 10000 });
    await expect(decide("meena", [APPROVE_DISCOUNTS]))
      .rejects.toMatchObject({ code: "DISCOUNT_WRITE_OFF_REFUSED" });
    expect(fx.writes).toHaveLength(0);
  });

  test("the refusal names the permission that is actually missing", async () => {
    park({ by: "raju", type: "percent", value: 100, amount: 10000 });
    await expect(decide("meena", [APPROVE_DISCOUNTS])).rejects.toThrow(/Close Bill/);
  });

  test("a REJECTION is never re-judged — refusing a discount takes no authority", async () => {
    park({ by: "raju", type: "percent", value: 100, amount: 10000 });
    await expect(db.DecideDiscountRequest(RES, REQ_ID, false, "meena", {
      isAdmin: false, actions: [APPROVE_DISCOUNTS], closeBillPermission: CLOSE_BILL,
    })).resolves.toBeTruthy();
    expect(fx.writes).toHaveLength(0);
  });
});

describe("the people who run the till lose nothing", () => {
  const tills = [
    ["an admin", ["*"], true],
    ["a manager", [APPROVE_DISCOUNTS, CLOSE_BILL], false],
    ["a cashier", [CLOSE_BILL], false],
    ["a captain", [CLOSE_BILL], false],
  ] as const;

  for (const [who, actions, isAdmin] of tills) {
    test(`${who} approves a 100% request, as they always could`, async () => {
      park({ by: "raju", type: "percent", value: 100, amount: 10000 });
      await expect(decide("meena", actions as unknown as string[], isAdmin)).resolves.toBeTruthy();
      expect(fx.writes).toEqual([{ type: "percent", value: 100 }]);
    });

    test(`${who} approves a drifted flat request too`, async () => {
      fx.subtotalNow = 2100;
      await expect(decide("meena", actions as unknown as string[], isAdmin)).resolves.toBeTruthy();
      expect(fx.writes).toEqual([{ type: "flat", value: 2000 }]);
    });

    test(`${who} pays for no extra reads — the re-judgement never runs for them`, async () => {
      fx.sql = [];
      await decide("meena", actions as unknown as string[], isAdmin);
      // sumOrderTotalsForTable's read is the cost this skips.
      expect(fx.sql.filter((q) => /from "Orders" where res_id/i.test(q))).toHaveLength(0);
    });
  }

  test("an ordinary discount is approved by Approve Discounts alone, which is the point of the role", async () => {
    park({ by: "raju", type: "flat", value: 200, amount: 200 });
    await expect(decide("meena", [APPROVE_DISCOUNTS])).resolves.toBeTruthy();
    expect(fx.writes).toEqual([{ type: "flat", value: 200 }]);
  });
});

describe("the route hands the decider's own identity to the gate", () => {
  // The gate is only as good as the caller. A route that passes nothing judges
  // every approver against an empty action set — which is precisely the
  // regression the items-split gate shipped with, and this is the test that
  // would have caught that one.
  test("POST /discount-requests/:id/{approve,reject} sends isAdmin and actions", () => {
    const src = readSource("routes/discounts.ts");
    const at = src.indexOf("DecideDiscountRequest(restaurantId");
    expect(at).toBeGreaterThan(-1);
    const call = src.slice(at, at + 400);
    expect(call).toMatch(/isAdmin:\s*callerIsAdmin\(req\)/);
    expect(call).toMatch(/actions:\s*req\.auth\?\.actions/);
    expect(call).toMatch(/closeBillPermission:\s*PERM_CLOSE_BILL/);
  });

  test("and a refusal comes back as a 403 that says why, not a bare 400", () => {
    const src = readSource("routes/discounts.ts");
    // Anchored on the `if (` itself: a survey showed that asserting only the
    // predicate text passes happily against `if (false && (…))`.
    expect(src).toMatch(/if \(isDiscountDecisionError\(e\) \|\| isDiscountAuthorityError\(e\)\) \{/);
    expect(src).toMatch(/res\.status\(403\)/);
  });
});
