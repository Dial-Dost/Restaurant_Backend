// CLIENT ITEM 6 — THE KITCHEN'S HALF OF MOVING A WHOLE PARTY (kot_move.ts).
//
// "After we move a table, the entire order of the table gets reprinted, which
// the kitchen will consider a new order during busy times."
//
// Two failures sit behind that one sentence, and they are opposite failures:
//
//   * POST /tables/move — "Move table", the button the floor actually presses,
//     the whole party and everything they own — printed NOTHING. Every docket
//     on the rail still said 15 after the party arrived at 12, and the system
//     now believed 15 was right, so nobody was looking for it.
//
//   * POST /tables/move-order DID print, and printed the ORDINARY docket with
//     a context line on top: a numbered dish list under a KOT header, which is
//     what an order looks like to a pass reading forty an hour.
//
// This file pins the first route's printer, printKotPartyMove. The docket's own
// shape — the banner and the missing dish list — is pinned on real paper in
// kot_table_change.test.ts; here it is the DECISIONS that are under test, so
// dispatchKot is a spy and the assertions are about what it was asked for.
//
//   1. ONE DOCKET PER MOVE, naming every ticket that travelled. The party moved
//      once, to one table, at one moment.
//   2. THE KEY IS BUILT FROM THE TABLE THEY LEFT. A KOT is keyed to the table it
//      printed FROM, and the orders are all on the destination by the time this
//      runs — so a key built from the current table looks up paper that has
//      never existed and concludes, wrongly, that the kitchen has none.
//   3. NOTHING PRINTS WHEN THERE IS NOTHING ON THE PASS, and nothing is minted
//      while finding that out.
//   4. NOTHING HERE EVER THROWS AT THE ROUTE: the party has already moved.
import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";

type AnyAsync = (...a: unknown[]) => Promise<unknown>;
const mockCtx = jest.fn<AnyAsync>();
const mockSettings = jest.fn<AnyAsync>();
const mockLookup = jest.fn<AnyAsync>();
const mockAllocate = jest.fn<AnyAsync>();
const mockDispatch = jest.fn<AnyAsync>();

jest.mock("pg", () => {
  class FakePool {
    on(): this { return this; }
    query() { return Promise.resolve({ rows: [] }); }
    connect() { return Promise.resolve({ query: () => Promise.resolve({ rows: [] }), release: () => undefined }); }
    end() { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});
jest.mock("../database_supabase", () => {
  // The real module (kot_print reads its day-key helpers), less the reads.
  const actual = jest.requireActual("../database_supabase") as Record<string, unknown>;
  return {
    ...actual,
    __esModule: true,
    GetOrderKotContext: (...a: unknown[]) => mockCtx(...a),
    GetRestaurantSettings: (...a: unknown[]) => mockSettings(...a),
    GetRestaurantProfile: async () => ({ outlet_name: "GGV" }),
    GetTableFeedbackContext: async () => ({ employee_name: "Atsu", employee_role: "waiter" }),
    LookupKotNumber: (...a: unknown[]) => mockLookup(...a),
    AllocateKotNumber: (...a: unknown[]) => mockAllocate(...a),
  };
});
jest.mock("../kot_print", () => {
  const actual = jest.requireActual("../kot_print") as Record<string, unknown>;
  return { ...actual, __esModule: true, dispatchKot: (...a: unknown[]) => mockDispatch(...a) };
});
jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: () => undefined, emitOutlet: () => undefined }));

let km: typeof import("../kot_move");
let kp: typeof import("../kot_print");

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  km = await import("../kot_move");
  kp = await import("../kot_print");
});

const OUTLET = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const WAS = "t-15";

/** One of the party's orders, as it reads AFTER the move — already on 12. */
const ctx = (over: Record<string, unknown> = {}) => ({
  order_id: "o1", outlet_id: OUTLET, table_id: "t-12", table_name: "12", section: "Patio", covers: 4,
  is_virtual: false, order_type: "dine_in", awaiting_approval: false, order_note: "NUT ALLERGY",
  items: [{ name: "Dal Makhani", price: 320, quantity: 2 }],
  ...over,
});

/** Answer GetOrderKotContext per order id. */
const ordersAre = (byId: Record<string, ReturnType<typeof ctx> | null>): void => {
  mockCtx.mockImplementation(async (_res: unknown, id: unknown) => byId[String(id)] ?? null);
};
const keyOf = (order: ReturnType<typeof ctx>, tableId: string, firedAt: Date): string =>
  kp.buildKotTicketKey({ outletId: OUTLET, tableId, items: order.items, firedAt, tz: "Asia/Kolkata", scope: null });
/** The Date printKotPartyMove stamped this run with — every read shares one. */
const firedAt = (): Date => mockLookup.mock.calls[0]![2] as Date;
const dispatched = () => mockDispatch.mock.calls[0]![0] as Record<string, unknown>;

const move = (orderIds: string[]) =>
  km.printKotPartyMove({ restaurantId: "ggv", orderIds, previousTableId: WAS, previousTableName: "15" });

beforeEach(() => {
  for (const m of [mockCtx, mockSettings, mockLookup, mockAllocate, mockDispatch]) { m.mockReset(); }
  mockSettings.mockResolvedValue({ timezone: "Asia/Kolkata", currency: "₹", bill_paper_width: "80mm", kot_auto_print: true });
  mockLookup.mockResolvedValue(null);
  mockDispatch.mockResolvedValue({ tickets: 1, stations: ["General"], kotNo: 5, businessDay: "2026-09-27", reprint: true, jobIds: [], devices: [], skipped: false, billId: "x" });
});

describe("a party whose tickets the kitchen is holding", () => {
  test("one correction docket, pinned to the number on the pass, naming both tables", async () => {
    const order = ctx();
    ordersAre({ o1: order });
    mockLookup.mockImplementation(async (_r: unknown, key: unknown, when: unknown) =>
      String(key) === keyOf(order, WAS, when as Date) ? { kot_no: 5, business_day: "2026-09-27" } : null);

    const out = await move(["o1"]);

    expect(out).toEqual({ printed: true, kot_no: 5, kot_nos: [5], tickets: 1 });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(dispatched()).toMatchObject({
      restaurantId: "ggv",
      outletId: OUTLET,
      // The DESTINATION, in the biggest type on the docket.
      tableName: "12",
      tableId: "t-12",
      pinnedKotNo: 5,
      movedKots: [5],
      moved: true,
      contextLine: "*** WAS 15 - NOW 12 ***",
      billId: "order-o1",
      // A correction is BY DEFINITION a docket whose content has already been
      // ticketed today — that is the reason it is printing.
      skipIfTicketed: false,
    });
  });

  test("the key is built from the table the party LEFT, never the one they are on", async () => {
    const order = ctx();
    ordersAre({ o1: order });
    await move(["o1"]);
    const when = firedAt();
    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(String(mockLookup.mock.calls[0]![1])).toBe(keyOf(order, WAS, when));
    expect(String(mockLookup.mock.calls[0]![1])).not.toBe(keyOf(order, "t-12", when));
  });

  test("the items ride along UNPRINTED, because they are what the station split is computed from", async () => {
    // The renderer drops them (ReceiptOptions.moved); dispatchKot still needs
    // them to decide how many dockets this becomes and which rail each is aimed
    // at. A correction for a ticket that printed at the bar has to reach the bar.
    const order = ctx({ items: [{ name: "Dal Makhani", price: 320, quantity: 2 }, { name: "Negroni", price: 550, quantity: 1 }] });
    ordersAre({ o1: order });
    mockLookup.mockResolvedValue({ kot_no: 5, business_day: "2026-09-27" });
    await move(["o1"]);
    expect(dispatched().items).toEqual(order.items);
  });

  test("no order note: this docket does not ask for food to be cooked", async () => {
    // The allergy is on the ticket the kitchen is still holding. Reprinting it
    // under a "do not cook" banner is at best noise — the same call the
    // cancellation slip makes.
    ordersAre({ o1: ctx() });
    mockLookup.mockResolvedValue({ kot_no: 5, business_day: "2026-09-27" });
    await move(["o1"]);
    expect(dispatched().orderNote).toBeNull();
  });
});

describe("a party with several tickets", () => {
  test("ONE docket names them all, in order, and its items are the union", async () => {
    const o1 = ctx({ order_id: "o1", items: [{ name: "Dal Makhani", price: 320, quantity: 2 }] });
    const o2 = ctx({ order_id: "o2", items: [{ name: "Negroni", price: 550, quantity: 1 }] });
    const o3 = ctx({ order_id: "o3", items: [{ name: "Kulfi", price: 180, quantity: 3 }] });
    ordersAre({ o1, o2, o3 });
    mockLookup.mockImplementation(async (_r: unknown, key: unknown, when: unknown) => {
      const k = String(key);
      if (k === keyOf(o1, WAS, when as Date)) { return { kot_no: 9, business_day: "d" }; }
      if (k === keyOf(o2, WAS, when as Date)) { return { kot_no: 5, business_day: "d" }; }
      if (k === keyOf(o3, WAS, when as Date)) { return { kot_no: 7, business_day: "d" }; }
      return null;
    });

    const out = await move(["o1", "o2", "o3"]);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ printed: true, kot_nos: [5, 7, 9] });
    expect(dispatched()).toMatchObject({ movedKots: [5, 7, 9], pinnedKotNo: 5 });
    expect(dispatched().items).toEqual([...o1.items, ...o2.items, ...o3.items]);
  });

  test("two rounds of the identical food share one number, and it is named once", async () => {
    // Identical item sets hash to one ticket key, so they ARE one ticket. "KOT -
    // 5, 5" would have the pass hunting for a second piece of paper that was
    // never fired.
    ordersAre({ o1: ctx({ order_id: "o1" }), o2: ctx({ order_id: "o2" }) });
    mockLookup.mockResolvedValue({ kot_no: 5, business_day: "d" });
    const out = await move(["o1", "o2"]);
    expect(out.kot_nos).toEqual([5]);
    expect(dispatched().movedKots).toEqual([5]);
  });

  test("the round still awaiting approval is left out of it entirely", async () => {
    // Paper on the pass IS the kitchen being told, and a Pending order has
    // deliberately not been. It has nothing to correct and no business on this
    // docket; its own trigger prints it later, at the right table.
    const o1 = ctx({ order_id: "o1" });
    const o2 = ctx({ order_id: "o2", awaiting_approval: true, items: [{ name: "Kulfi", price: 180, quantity: 3 }] });
    ordersAre({ o1, o2 });
    mockLookup.mockResolvedValue({ kot_no: 5, business_day: "d" });
    const out = await move(["o1", "o2"]);
    expect(out.kot_nos).toEqual([5]);
    expect(mockLookup).toHaveBeenCalledTimes(1); // o2 was never even asked about
    expect(dispatched().items).toEqual(o1.items);
  });
});

describe("nothing on the pass, nothing on the printer", () => {
  test("a party moved before the kitchen was ever told gets no paper at all", async () => {
    ordersAre({ o1: ctx() });
    mockLookup.mockResolvedValue(null);
    expect(await move(["o1"])).toEqual({ printed: false, kot_no: null, tickets: 0, reason: "never_ticketed" });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test("asking does not MINT: a never-ticketed party burns no number", async () => {
    ordersAre({ o1: ctx(), o2: ctx({ order_id: "o2" }) });
    await move(["o1", "o2"]);
    expect(mockAllocate).not.toHaveBeenCalled();
  });

  test("every round still Pending: nothing is asked and nothing prints", async () => {
    ordersAre({ o1: ctx({ awaiting_approval: true }) });
    expect(await move(["o1"])).toMatchObject({ printed: false, reason: "never_ticketed" });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  test("a party with no orders at all: no reads, no docket", async () => {
    expect(await move([])).toEqual({ printed: false, kot_no: null, tickets: 0, reason: "no_orders" });
    expect(mockCtx).not.toHaveBeenCalled();
    expect(mockSettings).not.toHaveBeenCalled();
  });

  test("automatic dockets switched off (migration 040): the move is silent", async () => {
    mockSettings.mockResolvedValue({ timezone: "Asia/Kolkata", currency: "₹", kot_auto_print: false });
    ordersAre({ o1: ctx() });
    expect(await move(["o1"])).toMatchObject({ printed: false, reason: "disabled" });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test("an order with no items, or one that has vanished, is skipped rather than fatal", async () => {
    ordersAre({ o1: ctx({ items: [] }), o2: null });
    expect(await move(["o1", "o2"])).toMatchObject({ printed: false, reason: "never_ticketed" });
  });
});

describe("the move has already committed, so nothing here may throw", () => {
  test("an unreadable numbering table is 'no paper', not an error", async () => {
    ordersAre({ o1: ctx() });
    mockLookup.mockRejectedValue(new Error("relation \"KotTickets\" does not exist"));
    expect(await move(["o1"])).toMatchObject({ printed: false, reason: "never_ticketed" });
  });

  test("an unreadable order is skipped", async () => {
    mockCtx.mockRejectedValue(new Error("db down"));
    expect(await move(["o1"])).toMatchObject({ printed: false, reason: "never_ticketed" });
  });

  test("a jammed printer is reported, never raised", async () => {
    ordersAre({ o1: ctx() });
    mockLookup.mockResolvedValue({ kot_no: 5, business_day: "d" });
    mockDispatch.mockRejectedValue(new Error("printer on fire"));
    expect(await move(["o1"])).toEqual({ printed: false, kot_no: null, tickets: 0, reason: "print_failed" });
  });

  test("unreadable settings are reported, never raised", async () => {
    mockSettings.mockRejectedValue(new Error("db down"));
    expect(await move(["o1"])).toMatchObject({ printed: false, reason: "print_failed" });
  });
});
