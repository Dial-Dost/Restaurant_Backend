// THE SIXTH DOOR — "a waiter cannot settle a bill, cannot release a table that
// owes money, cannot discount it to nothing and cannot coupon it to nothing…
// and can still take every line off it, one at a time."
//
// ============================================================================
// WHY THIS ONE IS THE WORST OF THE SIX
// ============================================================================
// The other five doors go AROUND the settle gate. This one DEFEATS a gate the
// same block had just built. UpdateOrderItemsSplit re-prices an order to
// whatever lines remain, so stripping every line leaves subtotal 0 and total 0
// WHILE THE ORDER STAYS ACTIVE. It is not a cancellation:
//
//   * no reason is recorded,
//   * no "OrderVoids" row is written (migration 035 names this very route as one
//     of the two writes it exists to record — it was simply never wired to it),
//   * so nothing reaches the void report, and
//   * GetTableReleaseImpact then computes 0 for the table, the release write-off
//     gate finds nothing to protect, and the SAME waiter frees the table with an
//     audit line that reads like an ordinary release of an empty one.
//
// Its route, DELETE /orders/:id/items/:itemId, is gated on 4ad474d4 "Add
// Orders", which CORE_ROLES.waiter holds.
//
// ============================================================================
// HOW THIS SUITE IS BUILT, AND WHY IT IS BUILT THAT WAY
// ============================================================================
// A HIDDEN CONTROL IS NOT A GATE, so the assertion that matters is about the
// WRITE, never about a response body. `pg` is the ONLY thing faked: the REAL
// UpdateOrderItemsSplit, the REAL GetTableReleaseImpact and the REAL route
// handler all run, and `fx.writes` collects every
// `update "Orders" set food = …` — the statement that re-prices the order.
// Empty means the money is still on the bill. A 403 proves a message was sent;
// only the absent statement proves the bill survived.
//
// The data layer is therefore NOT stubbed out from under the route. Four things
// in routes/orders.ts ARE stubbed and each for a stated reason: GetOrders
// (reconstructing its join in a fixture would test the fixture), the audit
// writer and the employee lookup (so the audit LINE can be read), the KOT
// dispatcher (no printer), and RecordOrderVoid (so the ledger call can be
// observed without asserting migration 035's SQL, which mis_capture.test.ts
// already owns). Everything the gate itself touches is real.
//
// AND NOBODY WHO RUNS A TILL LOSES ANYTHING. Every case is run for an admin, a
// manager, a cashier and a captain too. "The fix emptied the till" — or here,
// "the fix meant a waiter could no longer correct a mis-keyed line" — is the
// failure this block risks most, so the ordinary one-line correction is pinned
// as hard as the refusal is.

import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from "@jest/globals";
import { makeFakeApp, type FakeApp } from "./platform_fixtures";
import {
  DEFAULT_FLOOR_DISCOUNT_CEILING,
  discountIsWriteOff,
  discountRemainingValue,
  isDiscountAuthorityError,
  mayDiscountBill,
} from "../discount_authority";

const CLOSE_BILL = "a953d044-31ba-4e31-b96f-99304fe43dfa";
const ADD_ORDERS = "4ad474d4-5230-449c-874f-6a238b833bca";
const VIEW_BILL = "98b10bde-802d-4a5b-a726-53a826424f79";
const TABLE_OPS = "090ea8d4-e348-4e1b-9723-11131a73a085";

const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";
const TABLE_ID = "33333333-3333-3333-3333-333333333333";
const ORDER_ID = "44444444-4444-4444-4444-444444444444";

// ===========================================================================
// THE FAKE POOL — the only thing that is not the shipped code
// ===========================================================================

interface StripFixture {
  /** The order being edited: its blob, its table, its raw status code. */
  order: { food: unknown; table_id: string | null; status: unknown };
  /** The table's still-owing orders, as the gate's baseline read returns them. */
  siblings: { food: unknown; status: unknown }[];
  /** What "OrderVoids" reports as already stripped off this seating. */
  stripped: { value: number; lines: number };
  /** Simulate migration 035 being unapplied on this deployment. */
  voidsTableMissing: boolean;
  sql: string[];
  /** Every re-pricing write the data layer issued. THE assertion of this suite. */
  writes: { food: string; status: number }[];
}

const fx: StripFixture = {
  order: { food: {}, table_id: TABLE_ID, status: 1 },
  siblings: [],
  stripped: { value: 0, lines: 0 },
  voidsTableMissing: false,
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
    // assertOrderStatusEditable
    if (/^select status from "Orders" where id = /i.test(q)) {
      return { rows: [{ status: fx.order.status }] };
    }
    // the order being edited
    if (/^select food, table_id from "Orders"/i.test(q)) {
      return { rows: [{ food: fx.order.food, table_id: fx.order.table_id }] };
    }
    // isOrderBarked — barked, so an order emptied down to "Served" is not refused
    // for a DIFFERENT reason and the write-off verdict is what the test observes.
    if (/^select barked_at from "Orders"/i.test(q)) {
      return { rows: [{ barked_at: new Date() }] };
    }
    // the table's still-owing orders — the gate's baseline, and the release
    // preflight's active_order_total
    if (/^select food, status from "Orders" where res_id/i.test(q)) {
      return { rows: fx.siblings };
    }
    if (/"OrderVoids"/i.test(q)) {
      if (fx.voidsTableMissing) {
        const err = new Error('relation "OrderVoids" does not exist') as Error & { code?: string };
        err.code = "42P01";
        throw err;
      }
      return { rows: [{ value: fx.stripped.value, lines: fx.stripped.lines }] };
    }
    if (/^select id from "Tables"/i.test(q)) { return { rows: [{ id: TABLE_ID }] }; }
    if (/^select table_name from "Tables"/i.test(q)) { return { rows: [{ table_name: "T7" }] }; }
    if (/^select total_amt from "Bills"/i.test(q)) { return { rows: [] }; }
    // THE WRITE. The whole suite is about whether this statement ever runs.
    if (/^update "Orders" set food = \$1::json, status = \$2/i.test(q)) {
      const p = (params ?? []) as unknown[];
      fx.writes.push({ food: String(p[0]), status: Number(p[1]) });
      // The write is guarded and says whether it landed; this order is live.
      return { rows: [{ id: p[2] }] };
    }
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

// The five stubs, and nothing else. See the header for why each one.
const GetOrders = jest.fn();
const RecordOrderVoid = jest.fn();
const AddAuditLogEntry = jest.fn();
const GetEmployeeDetailsFromEmpID = jest.fn();

jest.mock("../database_supabase", () => {
  const actual = jest.requireActual("../database_supabase") as Record<string, unknown>;
  return {
    ...actual,
    __esModule: true,
    GetOrders: (...a: unknown[]) => GetOrders(...a),
    RecordOrderVoid: (...a: unknown[]) => RecordOrderVoid(...a),
    AddAuditLogEntry: (...a: unknown[]) => AddAuditLogEntry(...a),
    GetEmployeeDetailsFromEmpID: (...a: unknown[]) => GetEmployeeDetailsFromEmpID(...a),
    GetOrderKotContext: () => Promise.resolve(null),
  };
});

const dispatchCancellationKot = jest.fn();
jest.mock("../kot_print", () => ({
  __esModule: true,
  autoPrintOrderKot: () => Promise.resolve({ printed: false, kot_no: null, tickets: [] }),
  dispatchCancellationKot: (...a: unknown[]) => dispatchCancellationKot(...a),
}));
jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: jest.fn(), emitOutlet: jest.fn() }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: jest.fn() }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

// ---------------------------------------------------------------------------

/** A line as it sits in "Orders".food.items. */
const line = (id: string, name: string, price: number, quantity = 1, nc = false) =>
  ({ id, name, price, quantity, ...(nc ? { nc: true } : {}) });

/** An items_split with everything in the Preparing tuple. */
const splitOf = (items: unknown[]) => [["Served", []], ["Preparing", items]];

const remove = (items: ReturnType<typeof line>[], ...ids: string[]) =>
  splitOf(items.filter((i) => !ids.includes(i.id)));

const asWaiter = { actions: [ADD_ORDERS, TABLE_OPS, VIEW_BILL], closeBillPermission: CLOSE_BILL };
const tills = [
  ["an admin", { actions: ["*"], closeBillPermission: CLOSE_BILL }],
  ["a manager", { actions: [ADD_ORDERS, TABLE_OPS, CLOSE_BILL], closeBillPermission: CLOSE_BILL }],
  ["a cashier", { actions: [ADD_ORDERS, TABLE_OPS, CLOSE_BILL, VIEW_BILL], closeBillPermission: CLOSE_BILL }],
  ["a captain", { actions: [ADD_ORDERS, VIEW_BILL, CLOSE_BILL], closeBillPermission: CLOSE_BILL }],
] as const;

let db: typeof import("../database_supabase");
let harness: FakeApp;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
  const orders = await import("../routes/orders");
  harness = makeFakeApp();
  orders.registerOrderRoutes(harness.app as never);
});

beforeEach(() => {
  fx.sql = [];
  fx.writes = [];
  fx.stripped = { value: 0, lines: 0 };
  fx.voidsTableMissing = false;
  fx.order = { food: {}, table_id: TABLE_ID, status: 1 };
  fx.siblings = [];

  GetOrders.mockReset();
  RecordOrderVoid.mockReset();
  AddAuditLogEntry.mockReset();
  GetEmployeeDetailsFromEmpID.mockReset();
  dispatchCancellationKot.mockReset();

  RecordOrderVoid.mockResolvedValue({ id: "void-1", void_kind: "other", stage: "after_print" });
  AddAuditLogEntry.mockResolvedValue(undefined);
  GetEmployeeDetailsFromEmpID.mockResolvedValue({ res_id: RES, outlet_id: OUTLET, username: "raju" });
  dispatchCancellationKot.mockResolvedValue({ printed: false, kot_no: null, tickets: [] });
});

/**
 * The status code `seat()` gives the order. 1 (Preparing) everywhere except the
 * route suites below, which run a WAITER against a PENDING (8) order: client
 * item 3 (2026-09-17) refuses a waiter-only login any removal from a ticket the
 * kitchen holds, so a never-ticketed order is the only one a waiter's write-off
 * can still be judged on. The ticketed case has its own suite at the end.
 */
let seatStatus = 1;

/**
 * Seat a table: the order's own lines, and what the REST of the table is worth.
 * Sets both the pool fixture (what the real gate reads) and the GetOrders stub
 * (what the route reads), so the two can never describe different tables.
 */
function seat(items: ReturnType<typeof line>[], otherOrdersWorth = 0): ReturnType<typeof line>[] {
  const own = items.reduce((s, i) => s + (i.nc === true ? 0 : i.price * i.quantity), 0);
  fx.order = {
    food: { items, items_split: splitOf(items), subtotal: own, total: own },
    table_id: TABLE_ID,
    status: seatStatus,
  };
  fx.siblings = [
    { food: { subtotal: own, total: own }, status: 1 },
    ...(otherOrdersWorth > 0 ? [{ food: { subtotal: otherOrdersWorth, total: otherOrdersWorth }, status: 2 }] : []),
  ];
  GetOrders.mockResolvedValue([{
    id: ORDER_ID, table: "T7", items, items_split: splitOf(items),
    subtotal: own, total: own, status: seatStatus === 8 ? "Pending" : "Preparing",
  }]);
  return items;
}

/** A 4,000 table: four 1,000 lines on one order, nothing else on the table. */
const fourThousand = () => seat([
  line("i1", "Biryani", 1000),
  line("i2", "Kebab", 1000),
  line("i3", "Naan", 1000),
  line("i4", "Lassi", 1000),
]);

// ===========================================================================
// PART 1 — THE RULE, WITHOUT A DATABASE
// ===========================================================================
//
// There is no new rule to test. The point of this door's fix is that it answers
// to the SAME judgement the discount and coupon doors answer to —
// mayDiscountBill, sized in rupees on what is HANDED BACK — so what is pinned
// here is the ARITHMETIC this route feeds it, which is the part that is new:
// the cumulative baseline.
describe("the judgement is the discount rule, fed the table's CUMULATIVE loss", () => {
  /**
   * What the gate computes. `tableWorthNow` is the table BEFORE this removal —
   * the sibling read runs before the write — so the baseline is that plus
   * everything already ledgered as stripped, and the money handed back is that
   * ledger plus this line.
   */
  const strip = (tableWorthNow: number, alreadyStripped: number, thisLine: number) => ({
    subtotal: Math.round((tableWorthNow + alreadyStripped) * 100) / 100,
    discount_amount: Math.round((alreadyStripped + thisLine) * 100) / 100,
  });

  test("one mis-keyed line off a healthy table is ordinary floor work", () => {
    // THE HALF A NARROW FIX GETS WRONG. A waiter who must fetch a manager to take
    // off a wrongly-rung 180 starter will stop correcting wrong entries, and a
    // worked-around rule protects nothing.
    expect(discountIsWriteOff(strip(4000, 0, 180), 0)).toBe(false);
    expect(mayDiscountBill({
      actions: [ADD_ORDERS], impact: strip(4000, 0, 180), closeBillPermission: CLOSE_BILL,
    }).allowed).toBe(true);
  });

  test("stripping MOST of the table is a write-off, at any size of table", () => {
    // Proportional on purpose: it holds on a 200 table and on a 200,000 one.
    expect(discountIsWriteOff(strip(200, 0, 150), 0)).toBe(true);
    expect(discountIsWriteOff(strip(200000, 0, 150000), 0)).toBe(true);
    // …and an exact half is still a discount a floor gives.
    expect(discountIsWriteOff(strip(4000, 0, 2000), 0)).toBe(false);
  });

  test("SIX DELETIONS OF A SIXTH EACH — the obvious evasion of a per-line rule", () => {
    // A 6,000 table, 1,000 at a time. Judged per LINE against what is LEFT, every
    // one of the first five is a fraction of a shrinking bill and is waved
    // through — 5,000 is gone before the rule fires at all.
    const naive = [1, 2, 3, 4, 5, 6].map((n) => discountIsWriteOff(
      { subtotal: 6000 - (n - 1) * 1000, discount_amount: 1000 }, 0,
    ));
    expect(naive).toEqual([false, false, false, false, false, true]);

    // Judged CUMULATIVELY the baseline stays 6,000 and the running total is what
    // is measured, so the THIRD strip is refused: by then 3,000 has come off,
    // which is write-off-scale money (limb 2) on its way to being half the table
    // (limb 1). Two ordinary corrections on one table remain ordinary.
    const cumulative = [1, 2, 3, 4, 5, 6].map((n) => discountIsWriteOff(
      strip(6000 - (n - 1) * 1000, (n - 1) * 1000, 1000), 0,
    ));
    expect(cumulative).toEqual([false, false, true, true, true, true]);
  });

  test("and a per-line rule alone still makes ZERO unreachable — the backstop", () => {
    // Stated because the cumulative read degrades to 0 on a tenant that has not
    // applied migration 035. Even with it dead, the removal that EMPTIES a table
    // is by definition 100% of what is left, which is the residual limb's
    // clearest case. Losing the ledger costs the "strip it to a fifth and then
    // release it" case; it never costs the "strip it to nothing" one.
    expect(discountIsWriteOff({ subtotal: 1000, discount_amount: 1000 }, 0)).toBe(true);
  });

  test("write-off-scale money is refused whatever fraction of the bill it is", () => {
    // 10% of a 40,000 banquet is 4,000 of somebody's money, and the residual limb
    // alone would pass it.
    expect(discountIsWriteOff(strip(40000, 0, DEFAULT_FLOOR_DISCOUNT_CEILING + 1), 0)).toBe(true);
    expect(discountIsWriteOff(strip(40000, 0, DEFAULT_FLOOR_DISCOUNT_CEILING - 1), 0)).toBe(false);
  });

  test("the verdict follows the CAPABILITY, never the spelling of a role", () => {
    const ask = (actions: string[]) => mayDiscountBill({
      actions, impact: strip(4000, 0, 3900), closeBillPermission: CLOSE_BILL,
    }).allowed;
    expect(ask([ADD_ORDERS])).toBe(false);            // the core waiter
    expect(ask([ADD_ORDERS, CLOSE_BILL])).toBe(true); // manager / captain
    expect(ask([CLOSE_BILL])).toBe(true);             // cashier
    expect(ask(["*"])).toBe(true);                    // admin
    // A custom role is a uuid, and a tenant that granted it Close Bill has
    // already answered this question.
    expect(ask(["d2b1f0c4-0000-4000-8000-000000000001", CLOSE_BILL])).toBe(true);
  });

  test("an empty ticket cannot be written off, so removing from one is allowed", () => {
    expect(discountIsWriteOff(strip(0, 0, 0), 0)).toBe(false);
    expect(discountRemainingValue(strip(4000, 0, 4000))).toBe(0);
  });
});

// ===========================================================================
// PART 2 — THE SHIPPED WRITE
// ===========================================================================
describe("UpdateOrderItemsSplit — the write itself", () => {
  test("a waiter taking ONE line off a 4,000 table still works, instantly", async () => {
    const items = fourThousand();
    await expect(db.UpdateOrderItemsSplit(RES, ORDER_ID, remove(items, "i4"), asWaiter))
      .resolves.toBe(true);
    expect(fx.writes).toHaveLength(1);
    // …and it re-prices to what is left, which is the behaviour being protected.
    expect(JSON.parse(fx.writes[0].food).subtotal).toBe(3000);
  });

  test("a waiter stripping the table to NOTHING is refused, and NOTHING is written", async () => {
    fourThousand();
    await expect(db.UpdateOrderItemsSplit(RES, ORDER_ID, splitOf([]), asWaiter))
      .rejects.toMatchObject({ code: "DISCOUNT_WRITE_OFF_REFUSED" });
    // THE ASSERTION THAT MATTERS. A thrown error proves a message exists; only
    // this proves the 4,000 is still on the bill.
    expect(fx.writes).toEqual([]);
  });

  test("…and stripping MOST of it is refused for the same reason", async () => {
    const items = fourThousand();
    await expect(db.UpdateOrderItemsSplit(RES, ORDER_ID, remove(items, "i1", "i2", "i3"), asWaiter))
      .rejects.toMatchObject({ code: "DISCOUNT_WRITE_OFF_REFUSED" });
    expect(fx.writes).toEqual([]);
  });

  test("the refusal names the permission, the table, the money and what is left", async () => {
    fourThousand();
    const err = await db.UpdateOrderItemsSplit(RES, ORDER_ID, splitOf([]), asWaiter).catch((e: unknown) => e);
    expect(isDiscountAuthorityError(err)).toBe(true);
    const e = err as { details: string; requiredPermission: string; discount_amount: number; remaining_value: number };
    expect(e.requiredPermission).toBe(CLOSE_BILL);
    expect(e.details).toContain("T7");
    expect(e.details).toContain("Close Bill");
    expect(e.details).toContain("4000.00");
    expect(e.discount_amount).toBe(4000);
    expect(e.remaining_value).toBe(0);
  });

  test("THE CUMULATIVE RULE: the fourth sixth is refused, not only the sixth", async () => {
    // A 6,000 table stripped 1,000 at a time. Three strips are already ledgered
    // in "OrderVoids" and 3,000 is left. Judged per line this is a third of what
    // remains and would be waved through; judged against the table the guest sat
    // down to it is the fourth 1,000 of 6,000, which crosses half.
    const items = [1, 2, 3].map((n) => line(`r${String(n)}`, `Dish ${String(n)}`, 1000));
    seat(items);
    fx.stripped = { value: 3000, lines: 3 };
    await expect(db.UpdateOrderItemsSplit(RES, ORDER_ID, remove(items, "r1"), asWaiter))
      .rejects.toMatchObject({ code: "DISCOUNT_WRITE_OFF_REFUSED" });
    expect(fx.writes).toEqual([]);

    // The SAME removal with nothing previously stripped is ordinary floor work —
    // which is what proves the refusal above came from the cumulative baseline
    // and not from the line itself.
    fx.stripped = { value: 0, lines: 0 };
    await expect(db.UpdateOrderItemsSplit(RES, ORDER_ID, remove(items, "r1"), asWaiter))
      .resolves.toBe(true);
    expect(fx.writes).toHaveLength(1);
  });

  test("the refusal says how much had already come off the table", async () => {
    const items = [1, 2, 3].map((n) => line(`r${String(n)}`, `Dish ${String(n)}`, 1000));
    seat(items);
    fx.stripped = { value: 3000, lines: 3 };
    const err = await db.UpdateOrderItemsSplit(RES, ORDER_ID, remove(items, "r1"), asWaiter)
      .catch((e: unknown) => e) as { details: string };
    expect(err.details).toContain("3000.00");
    expect(err.details).toContain("3 line(s)");
  });

  test("the WHOLE TABLE is the baseline, not the order being edited", async () => {
    // One 1,000 order on a 9,000 table. Emptying it is 100% of the ORDER and a
    // ninth of the TABLE; a gate that judged the order would refuse the ordinary
    // correction of a small ticket on a large table.
    seat([line("s1", "Soda", 1000)], 8000);
    await expect(db.UpdateOrderItemsSplit(RES, ORDER_ID, splitOf([]), asWaiter)).resolves.toBe(true);
    expect(fx.writes).toHaveLength(1);
  });

  test("ADDING a line, and pure re-labelling, cost nothing and read nothing", async () => {
    const items = fourThousand();
    fx.sql = [];
    // Drag every line from Preparing to Served: same items, same money.
    await expect(db.UpdateOrderItemsSplit(RES, ORDER_ID, [["Served", items], ["Preparing", []]], asWaiter))
      .resolves.toBe(true);
    expect(fx.writes).toHaveLength(1);
    // The gate's reads are never issued: nothing was handed back, so there is
    // nothing to judge, and the everyday path stays as fast as it was.
    expect(fx.sql.some((q) => /"OrderVoids"/i.test(q))).toBe(false);

    fx.writes = [];
    fx.sql = [];
    await expect(db.UpdateOrderItemsSplit(RES, ORDER_ID, splitOf([...items, line("i5", "Gulab Jamun", 200)]), asWaiter))
      .resolves.toBe(true);
    expect(fx.writes).toHaveLength(1);
    expect(fx.sql.some((q) => /"OrderVoids"/i.test(q))).toBe(false);
  });

  test("removing a COMPED line hands nothing back — it was already given away", async () => {
    // Marking a dish non-chargeable already required PERM_NON_CHARGEABLE, the
    // giveaway is already ledgered (migration 034) and the money is already out of
    // every figure the table is judged by. Making a waiter fetch a manager to tidy
    // the line away afterwards would be a rule about bookkeeping, not about money.
    const items = [line("c1", "Comped Dessert", 4000, 1, true), line("c2", "Chai", 40)];
    seat(items);
    await expect(db.UpdateOrderItemsSplit(RES, ORDER_ID, remove(items, "c1"), asWaiter)).resolves.toBe(true);
    expect(fx.writes).toHaveLength(1);
  });

  test("a dead \"OrderVoids\" read loses the cumulative limb and NOTHING else", async () => {
    // Migration 035 unapplied. The prior-strip figure degrades to 0 (loudly) and
    // the residual limb still measures this write against what remains — so the
    // table still cannot be taken to zero.
    fx.voidsTableMissing = true;
    fourThousand();
    await expect(db.UpdateOrderItemsSplit(RES, ORDER_ID, splitOf([]), asWaiter))
      .rejects.toMatchObject({ code: "DISCOUNT_WRITE_OFF_REFUSED" });
    expect(fx.writes).toEqual([]);
  });

  test("a caller that passes NO actions is refused a write-off, never granted one", async () => {
    // The same posture, and for the same reason, as SetBillDiscountWithApproval's
    // own `actions` parameter: a missing input on a money gate may only fail in
    // the safe direction. One caller is currently un-wired —
    // PATCH /bills/order/:orderId/status, which exists to move lines between the
    // Served and Preparing tuples and hands back nothing when it does that.
    fourThousand();
    await expect(db.UpdateOrderItemsSplit(RES, ORDER_ID, splitOf([])))
      .rejects.toMatchObject({ code: "DISCOUNT_WRITE_OFF_REFUSED" });
    expect(fx.writes).toEqual([]);
  });

  test("STATUS 6: lines cannot be stripped between waiter-confirm and admin-approve", async () => {
    // ApproveBillPaymentByAdmin RE-PRICES at approval. A line removed in this
    // window settles the bill at a number the guest has already overpaid, with
    // nothing anywhere saying a line went. Refused for EVERYBODY — this is not a
    // permission question, it is a "the money has already been taken" question.
    const items = fourThousand();
    fx.order.status = 6;
    for (const [, opts] of [["a waiter", asWaiter], ...tills] as const) {
      fx.writes = [];
      await expect(db.UpdateOrderItemsSplit(RES, ORDER_ID, remove(items, "i4"), opts))
        .rejects.toThrow(/awaiting approval/i);
      expect(fx.writes).toEqual([]);
    }
  });

  test("a cancelled order and a settled one stay refused, exactly as before", async () => {
    const items = fourThousand();
    fx.order.status = 5;
    await expect(db.UpdateOrderItemsSplit(RES, ORDER_ID, remove(items, "i4"), asWaiter)).rejects.toThrow(/cancelled/i);
    fx.order.status = 4;
    await expect(db.UpdateOrderItemsSplit(RES, ORDER_ID, remove(items, "i4"), asWaiter)).rejects.toThrow(/settled/i);
    expect(fx.writes).toEqual([]);
  });
});

describe("the people who run the till lose nothing, at the write", () => {
  for (const [who, opts] of tills) {
    test(`${who} may strip the table to nothing, and the write happens`, async () => {
      fourThousand();
      await expect(db.UpdateOrderItemsSplit(RES, ORDER_ID, splitOf([]), opts)).resolves.toBe(true);
      expect(fx.writes).toHaveLength(1);
      expect(JSON.parse(fx.writes[0].food).subtotal).toBe(0);
    });

    test(`${who} takes one line off, as they always could`, async () => {
      const items = fourThousand();
      await expect(db.UpdateOrderItemsSplit(RES, ORDER_ID, remove(items, "i4"), opts)).resolves.toBe(true);
      expect(fx.writes).toHaveLength(1);
    });

    test(`${who} pays for no extra reads — the gate never runs for them`, async () => {
      fourThousand();
      fx.sql = [];
      await db.UpdateOrderItemsSplit(RES, ORDER_ID, splitOf([]), opts);
      expect(fx.sql.some((q) => /"OrderVoids"/i.test(q))).toBe(false);
      expect(fx.sql.some((q) => /^select table_name from "Tables"/i.test(q))).toBe(false);
    });
  }
});

// ===========================================================================
// PART 3 — THE PREFLIGHT IS NO LONGER BLIND
// ===========================================================================
describe("GetTableReleaseImpact and the hollowed-out table", () => {
  test("it reports what has already come off the table, BESIDE the live figures", async () => {
    fx.siblings = [];                       // every line stripped: the table reads as 0
    fx.stripped = { value: 4000, lines: 4 };
    const impact = await db.GetTableReleaseImpact(RES, "T7");
    expect(impact?.active_order_total).toBe(0);
    expect(impact?.stripped_value).toBe(4000);
    expect(impact?.stripped_line_count).toBe(4);
  });

  test("…and NEVER folds it into them, or an empty table stops being releasable", async () => {
    // releaseWriteOffValue takes the greater of the bill and the orders. Adding
    // already-destroyed money into either would refuse the release of a table
    // that genuinely has nothing left on it — a waiter stuck in front of a table
    // they cannot free is a worse outcome than the bug (release_authority.ts).
    fx.siblings = [];
    fx.stripped = { value: 4000, lines: 4 };
    const impact = await db.GetTableReleaseImpact(RES, "T7");
    expect(impact?.active_order_total).toBe(0);
    expect(impact?.open_bill_total).toBe(0);
  });

  test("it degrades to zero rather than failing when migration 035 is unapplied", async () => {
    fx.voidsTableMissing = true;
    fx.siblings = [{ food: { subtotal: 900, total: 900 }, status: 1 }];
    const impact = await db.GetTableReleaseImpact(RES, "T7");
    expect(impact?.active_order_total).toBe(900);
    expect(impact?.stripped_value).toBe(0);
  });
});

// ===========================================================================
// PART 4 — THE ROUTE, END TO END
// ===========================================================================
//
// The route hands the gate the caller's real identity and turns the tagged
// refusal into the 403 shape every other money gate in this codebase answers
// with. Nothing here is stubbed between the handler and the write, so a waiter
// refused below is refused by the SHIPPED gate reading the SHIPPED numbers.

const identity = (actions: string[], role = "waiter") => ({
  res_id: RES, outlet_id: OUTLET, employeeId: "emp-1", role, actions,
});
const WAITER = identity([ADD_ORDERS, TABLE_OPS, VIEW_BILL]);
const ADMIN = identity(["*"], "admin");
const MANAGER = identity([ADD_ORDERS, TABLE_OPS, CLOSE_BILL], "manager");
const CASHIER = identity([ADD_ORDERS, TABLE_OPS, CLOSE_BILL, VIEW_BILL], "cashier");
const CAPTAIN = identity([ADD_ORDERS, VIEW_BILL, CLOSE_BILL], "captain");

const del = (auth: ReturnType<typeof identity> | undefined, itemId = "i1", body?: unknown) =>
  harness.call("DELETE", "/orders/:id/items/:itemId", {
    params: { id: ORDER_ID, itemId }, body: body ?? {}, auth,
  });

/** The audit descriptions written during one call. */
const auditLines = (): string[] => AddAuditLogEntry.mock.calls.map((c) => String((c as unknown[])[4]));

/** A 4,000 table whose i1 line alone is worth 3,000 — a write-off to strip. */
const bigLineTable = () => seat([line("i1", "Whole Lamb", 1500, 2), line("i2", "Chai", 1000)]);

// A waiter's route calls are made against a PENDING order — see seatStatus.
const onPendingOrders = (): void => {
  beforeEach(() => { seatStatus = 8; });
  afterEach(() => { seatStatus = 1; });
};

describe("DELETE /orders/:id/items/:itemId — the door itself", () => {
  onPendingOrders();
  test("a waiter takes ONE ordinary line off, and it is written", async () => {
    fourThousand();
    const r = await del(WAITER);
    expect(r.status).toBe(200);
    expect(fx.writes).toHaveLength(1);
  });

  test("a waiter stripping most of the table is 403'd and NOTHING is written", async () => {
    bigLineTable();
    const r = await del(WAITER);
    expect(r.status).toBe(403);
    expect(fx.writes).toEqual([]);
    expect(r.body).toMatchObject({
      error: "Forbidden",
      requiredPermission: CLOSE_BILL,
      value_removed: 3000,
      write_off_value: 3000,
      remaining_value: 1000,
    });
  });

  test("THE IDENTITY REALLY TRAVELS — the same request succeeds for a manager", async () => {
    // A gate that is never handed the caller's actions refuses everybody or
    // nobody; this pair is what proves the route passed the real ones down.
    bigLineTable();
    expect((await del(WAITER)).status).toBe(403);
    expect(fx.writes).toEqual([]);
    bigLineTable();
    expect((await del(MANAGER)).status).toBe(200);
    expect(fx.writes).toHaveLength(1);
  });

  test("a REFUSED removal writes no void row and prints no cancellation slip", async () => {
    bigLineTable();
    await del(WAITER);
    // Nothing happened, so nothing may be recorded as having happened: a void
    // ledger that names an employee for a removal that was refused is worse than
    // no ledger, and a slip would tell the kitchen to stop cooking a dish that is
    // still on the bill and still coming to the table.
    expect(RecordOrderVoid).not.toHaveBeenCalled();
    expect(dispatchCancellationKot).not.toHaveBeenCalled();
  });

  test("…but the ATTEMPT is audited, because a refusal with no trace never happened", async () => {
    bigLineTable();
    await del(WAITER);
    const refused = auditLines().find((l) => l.startsWith("REFUSED")) ?? "";
    expect(refused).toContain("REFUSED removal");
    expect(refused).toContain("Whole Lamb");
    expect(refused).toContain("3000.00");
    expect(refused).toContain("Close Bill");
  });

  test("an audit write that FAILS does not turn the 403 into a 500", async () => {
    bigLineTable();
    GetEmployeeDetailsFromEmpID.mockRejectedValue(new Error("audit down"));
    expect((await del(WAITER)).status).toBe(403);
    expect(fx.writes).toEqual([]);
  });

  test("a request for an order that does not exist is still a 404", async () => {
    fourThousand();
    GetOrders.mockResolvedValue([]);
    expect((await del(WAITER)).status).toBe(404);
  });
});

describe("a permitted removal is now traceable", () => {
  onPendingOrders();
  test("it writes an item-scope \"OrderVoids\" row carrying the dish and the money", async () => {
    fourThousand();
    await del(WAITER);
    expect(RecordOrderVoid).toHaveBeenCalledWith(RES, expect.objectContaining({
      order_id: ORDER_ID, scope: "item", item_id: "i1", item_name: "Biryani", value_voided: 1000,
    }));
  });

  test("a reason the client sends is recorded; one it does not send is recorded as absent", async () => {
    fourThousand();
    await del(WAITER, "i1", { reason: "guest changed their mind", void_kind: "guest_changed_mind" });
    expect(RecordOrderVoid).toHaveBeenCalledWith(RES, expect.objectContaining({
      reason: "guest changed their mind", void_kind: "guest_changed_mind",
    }));

    RecordOrderVoid.mockClear();
    fourThousand();
    await del(WAITER);
    // RECORD WHAT YOU ARE GIVEN. No shipped till sends a reason on this route
    // yet; a 400 would mean a live floor cannot correct a mis-keyed line, and a
    // skipped row would mean the worst of the six doors keeps leaving no trace.
    expect(RecordOrderVoid).toHaveBeenCalledWith(RES, expect.objectContaining({
      reason: expect.stringContaining("no reason given"), void_kind: "other",
    }));
  });

  test("the actor comes from the session and is recorded as its own authoriser", async () => {
    fourThousand();
    await del(WAITER);
    const arg = RecordOrderVoid.mock.calls[0][1] as { actor: Record<string, unknown> };
    expect(arg.actor.employee_id).toBe("emp-1");
    expect(arg.actor.authorised_by_employee_id).toBe("emp-1");
  });

  test("the audit line names the dish, the quantity, the money and the table", async () => {
    seat([line("i1", "Biryani", 1000, 2), line("i2", "Kebab", 3000)]);
    await del(WAITER);
    const written = auditLines().join(" | ");
    expect(written).toContain("Biryani");
    expect(written).toContain("2x");
    expect(written).toContain("2000.00");
    expect(written).toContain("T7");
    // The bare-uuid line this replaces told a manager nothing at all.
    expect(written).not.toMatch(/Deleted item i1 from order/);
  });

  test("a failed ledger write does not fail the removal, and the body says so", async () => {
    fourThousand();
    RecordOrderVoid.mockRejectedValue(new Error("OrderVoids missing"));
    const r = await del(WAITER);
    expect(r.status).toBe(200);
    expect(fx.writes).toHaveLength(1);
    expect(r.body).toMatchObject({ success: true, void_recorded: false, value_removed: 1000 });
  });

  test("a comped line is removed freely and recorded as worth nothing", async () => {
    seat([line("c1", "Comped Dessert", 4000, 1, true), line("c2", "Chai", 40)]);
    const r = await del(WAITER, "c1");
    expect(r.status).toBe(200);
    expect(RecordOrderVoid).toHaveBeenCalledWith(RES, expect.objectContaining({ value_voided: 0 }));
  });

  test("an item id that is not on the order changes nothing and records nothing", async () => {
    fourThousand();
    const r = await del(WAITER, "not-on-this-order");
    expect(r.status).toBe(200);
    expect(RecordOrderVoid).not.toHaveBeenCalled();
    expect(dispatchCancellationKot).not.toHaveBeenCalled();
    expect((r.body as Record<string, unknown>).value_removed).toBeUndefined();
  });
});

// CLIENT ITEM 3 — "On the waiter dashboard, Cancel KOT option should be
// removed." Taking a dish off a ticket the kitchen holds is the same act one
// line wide, so a waiter-only login is refused it — with the sentence, before
// anything is written, and on the record. A Pending order (never ticketed) is
// still theirs to correct; the senior roles lose nothing (next suite).
describe("client item 3 — a waiter never takes a dish off a ticket the kitchen holds", () => {
  for (const [label, code, wire] of [["Preparing", 1, "Preparing"], ["Served", 2, "Served"]] as const) {
    test(`${label}: 403 cancel_needs_senior, nothing written, no void row, no slip`, async () => {
      fourThousand();
      fx.order.status = code;
      GetOrders.mockResolvedValue([{ id: ORDER_ID, table: "T7", items: [], status: wire }] as never);
      const r = await del(WAITER);
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ error: "Forbidden", code: "cancel_needs_senior", order_id: ORDER_ID });
      expect(String((r.body as Record<string, unknown>).details)).toMatch(/has gone to the kitchen, so a dish cannot be taken off it here/);
      expect(fx.writes).toEqual([]);
      expect(RecordOrderVoid).not.toHaveBeenCalled();
      expect(dispatchCancellationKot).not.toHaveBeenCalled();
      expect(auditLines().some((l) => l.startsWith(`REFUSED removal of a dish from order ${ORDER_ID}`))).toBe(true);
    });
  }

  test("a waiter granted Void Orders is refused all the same — the role, not the grant", async () => {
    fourThousand();
    const r = await del(identity([ADD_ORDERS, "c1f83b26-5a97-4e40-b8d3-7e02a9c4f156"]));
    expect(r.status).toBe(403);
    expect(fx.writes).toEqual([]);
  });

  test("a waiter who also holds a senior role is not a waiter-only login", async () => {
    fourThousand();
    const both = { ...identity([ADD_ORDERS, TABLE_OPS, VIEW_BILL]), role_all: ["waiter", "captain"] };
    expect((await del(both)).status).toBe(200);
    expect(fx.writes).toHaveLength(1);
  });

  test("a Pending order is still the waiter's to correct", async () => {
    seatStatus = 8;
    try {
      fourThousand();
      expect((await del(WAITER)).status).toBe(200);
      expect(fx.writes).toHaveLength(1);
    } finally { seatStatus = 1; }
  });
});

describe("the route loses nothing for the people who run the till", () => {
  for (const [who, auth] of [["an admin", ADMIN], ["a manager", MANAGER], ["a cashier", CASHIER], ["a captain", CAPTAIN]] as const) {
    test(`${who} removes a write-off-sized line, and it is written and recorded`, async () => {
      bigLineTable();
      const r = await del(auth);
      expect(r.status).toBe(200);
      expect(fx.writes).toHaveLength(1);
      expect(RecordOrderVoid).toHaveBeenCalledWith(RES, expect.objectContaining({ item_id: "i1", value_voided: 3000 }));
      expect(auditLines().join(" ")).toContain("Whole Lamb");
    });

    test(`${who} removes an ordinary line, as they always could`, async () => {
      fourThousand();
      const r = await del(auth);
      expect(r.status).toBe(200);
      expect(fx.writes).toHaveLength(1);
    });
  }
});

/**
 * A shipped source file, read as text.
 *
 * Resolved off the REPO ROOT rather than off this file, because these tests run
 * through jest's CommonJS transpile where `import.meta` does not exist. The
 * throw matters as much as the read: a path that silently returns nothing would
 * make every assertion below vacuously true, which is the same false green a
 * `--check` with no baseline gave.
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

// ===========================================================================
// PART 5 — THE REGRESSION THIS GATE CAUSED, PINNED SO IT CANNOT RETURN
// ===========================================================================
// The gate above was added to this suite's block and, in the same pass, BROKE A
// LEGITIMATE FLOW: `PATCH /bills/order/:orderId/status` called
// UpdateOrderItemsSplit with no identity at all, so the gate judged an ADMIN
// against an empty action set and refused them their own items-split.
//
// That is the failure mode this block risks most — "the fix emptied the till" —
// and it survived the first six adversarial passes because every one of them
// asked "can a waiter still get the money off?". None asked "did anybody LOSE a
// capability?". These tests ask the second question.
//
// TWO ASSERTIONS, because the bug had two halves and either alone is a false
// green:
//
//   1. THE DATA LAYER honours `isAdmin` — the same escape the discount, coupon
//      and loyalty gates already carry. `callerIsAdmin()` reads the ROLE, and an
//      owner resolved that way does not always carry a literal "*" in `actions`,
//      so asking the action set alone is precisely the question that got this
//      wrong.
//   2. EVERY CALL SITE ACTUALLY SENDS IT. A parameter nobody passes is the
//      recurring shape of this whole project's bugs — a migration nothing wrote
//      to, a renderer field no caller supplied, capability flags nobody parsed.
//      The data-layer test above passes perfectly while the route sends nothing,
//      which is exactly the state production was in. So the source of every
//      caller is read and checked.
describe("nobody who runs the till lost the items-split", () => {
  const adminNoActions = { isAdmin: true, actions: [] as string[], closeBillPermission: CLOSE_BILL };

  test("an admin with an EMPTY action set still strips the table — the regression itself", async () => {
    fourThousand();
    await expect(db.UpdateOrderItemsSplit(RES, ORDER_ID, splitOf([]), adminNoActions)).resolves.toBe(true);
    expect(fx.writes).toHaveLength(1);
    expect(JSON.parse(fx.writes[0].food).subtotal).toBe(0);
  });

  test("an admin with no `actions` key at all is still not refused", async () => {
    fourThousand();
    await expect(
      db.UpdateOrderItemsSplit(RES, ORDER_ID, splitOf([]), { isAdmin: true, closeBillPermission: CLOSE_BILL }),
    ).resolves.toBe(true);
    expect(fx.writes).toHaveLength(1);
  });

  test("an admin pays for no extra reads either — the gate never runs for them", async () => {
    fourThousand();
    fx.sql = [];
    await db.UpdateOrderItemsSplit(RES, ORDER_ID, splitOf([]), adminNoActions);
    expect(fx.sql.some((q) => /"OrderVoids"/i.test(q))).toBe(false);
  });

  test("`isAdmin: false` changes nothing — a waiter is still refused", async () => {
    fourThousand();
    await expect(
      db.UpdateOrderItemsSplit(RES, ORDER_ID, splitOf([]), { ...asWaiter, isAdmin: false }),
    ).rejects.toMatchObject({ code: "DISCOUNT_WRITE_OFF_REFUSED" });
    expect(fx.writes).toHaveLength(0);
  });

  test("and the flag is not a bypass a client can ask for — it is only ever set server-side", async () => {
    // Stated as a source fact because there is no runtime assertion that can
    // make it: `isAdmin` is computed by callerIsAdmin(req) from the SESSION, and
    // must never be read off a request body. If this ever fails, a caller has
    // started trusting the client to say it is an admin.
    for (const f of ["routes/bills.ts", "routes/orders.ts", "routes/guest.ts"]) {
      expect(readSource(f)).not.toMatch(/isAdmin:\s*(?:!!)?\s*(?:body|req\.body|req\.query)/);
    }
  });
});

describe("every items-split caller sends an identity", () => {
  // THE TEST THAT WOULD HAVE CAUGHT IT. The gate is only as good as the weakest
  // caller, and the weakest caller was one that passed nothing — which no
  // data-layer test can see. Reading the source is crude and it is also the only
  // thing that fails when a new route is added and forgets.
  test("no route calls UpdateOrderItemsSplit without opts", async () => {
    const files = ["routes/bills.ts", "routes/orders.ts"];
    const found: string[] = [];
    for (const f of files) {
      const src = readSource(f);
      // Every call, with whatever follows it up to the closing paren of the args.
      const re = /UpdateOrderItemsSplit\(([\s\S]{0,600}?)\n\s*\}?\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const args = m[1];
        found.push(`${f}: ${args.slice(0, 60).replace(/\s+/g, " ")}`);
        expect(args).toMatch(/actions\s*:/);
        expect(args).toMatch(/closeBillPermission\s*:/);
      }
    }
    // Guards against the regex silently matching nothing and the test passing by
    // finding no callers at all — the same false green that let a `--check` with
    // no baseline exit 0.
    expect(found.length).toBeGreaterThanOrEqual(3);
  });

  test("the bills route — the one that regressed — sends isAdmin", async () => {
    const src = readSource("routes/bills.ts");
    const call = /UpdateOrderItemsSplit\(([\s\S]{0,600}?)\n\s*\}?\)/.exec(src);
    expect(call).not.toBeNull();
    expect(call![1]).toMatch(/isAdmin:\s*callerIsAdmin\(req\)/);
  });
});
