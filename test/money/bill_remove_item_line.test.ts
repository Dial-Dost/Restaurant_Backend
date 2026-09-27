// CLIENT ITEM 1 — "if we try deleting 1 item, the whole KOT (all items in the
// KOT) gets deleted. That's if we use the Remove from bill option (before bill
// printing)."
//
// ============================================================================
// WHAT WAS ACTUALLY HAPPENING
// ============================================================================
// "Remove from bill" is drawn PER LINE, inside a KOT block, so the admin taps
// one dish on one ticket. The request carried only that dish's name and its
// price, and removeItemFromTableOrders took every line on the table answering
// to that name — on EVERY order, because one order is one KOT.
//
// A table holding Tandoori Roti on KOT 2 and on KOT 3 therefore lost both for
// one tap (twice the money off the bill). And when the other ticket held
// nothing else, emptying it flipped it to Cancelled(5) — which is off every
// screen, out of the table preview and out of the bill. To the floor, one tap
// deleted a whole KOT. Verbatim, that is the report.
//
// Reproduced on the local stack before the fix: a table with KOT 2
// (Masala Chai x2, Tandoori Roti), KOT 3 (Paneer Tikka, Tandoori Roti) and
// KOT 4 (Paneer Tikka, Dark Chocolate Mousse). Removing ONE Paneer Tikka off
// KOT 4 answered `quantity: 2, value: 640` and left KOT 3 Cancelled with no
// lines at all.
//
// ============================================================================
// WHAT THESE TESTS PIN
// ============================================================================
//   * ONE line comes off, on ONE ticket: the one `order_id` + `item_id` name.
//   * Every other ticket — and every other line on the same ticket — is left
//     exactly as it was, including its status.
//   * The money is recomputed by the SAME helpers as before: the order's stored
//     subtotal over chargeable lines, and the open bill's pre-tax running sum.
//   * Emptying a ticket still cancels THAT ticket, and only that one.
//   * A till that sends no ids (every shipped 2.0.2 build) still takes one line.
//   * An id that is no longer on the table is "not found", never "the next
//     thing with this name" — that fallback would strike a dish being eaten.
//   * A MOVE is untouched: it still carries every matching line, which is the
//     money-conservation rule removeItemFromTableOrders' header exists for.
//
// The REAL RemoveBillItem / MoveBillItem run over nc_settle_fixture's fake pg,
// which already models this path (see its header).

import { describe, test, expect, beforeAll, jest } from "@jest/globals";
import {
  TABLE_ID,
  current,
  makeState,
  useState,
  type NcFixtureLine,
  type NcFixtureOrder,
} from "./nc_settle_fixture";

jest.mock("pg", () => {
  interface FixtureGlobal { __ncFixtureQuery?: (sql: string, params?: unknown[]) => { rows: unknown[] } }
  const run = (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const q = (globalThis as unknown as FixtureGlobal).__ncFixtureQuery;
    if (!q) {return Promise.reject(new Error("nc fixture harness was not loaded"));}
    try { return Promise.resolve(q(sql, params)); } catch (err) { return Promise.reject(err); }
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> { return run(sql, params); }
    connect(): Promise<{ query: typeof run; release: () => void }> {
      return Promise.resolve({ query: run, release: () => { /* pooled */ } });
    }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

type Db = typeof import("../../database_supabase");
let db: Db;
const RID = "zztest-remove";
const TABLE = "T7";

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL ?? "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../../database_supabase");
});

const KOT2 = "22222222-1111-4111-8111-222222222222";
const KOT3 = "33333333-1111-4111-8111-333333333333";
const KOT4 = "44444444-1111-4111-8111-444444444444";
const BILL = "b0000000-0000-4000-8000-000000000001";

const CHAI = (id: string): NcFixtureLine => ({ id, name: "Masala Chai", price: 60, quantity: 2 });
const ROTI = (id: string): NcFixtureLine => ({ id, name: "Tandoori Roti", price: 130, quantity: 1 });
const PANEER = (id: string): NcFixtureLine => ({ id, name: "Paneer Tikka", price: 320, quantity: 1 });
const MOUSSE = (id: string): NcFixtureLine => ({ id, name: "Dark Chocolate Mousse", price: 469, quantity: 1 });

const ticket = (id: string, at: string, items: NcFixtureLine[]): NcFixtureOrder => ({
  id, status: 1, created_at: at, items,
});

const openBill = (total: number) => ({
  id: BILL, bill_no: 55, created_at: "2026-09-16T08:01:00Z",
  table_id: TABLE_ID, status: 1, total_amt: total, tax_breakdown: [], round_off: 3,
  payment_method: null, payment_splits: null, payment_proof_screenshot_url: null,
  waiter_confirmed_at: null, waiter_confirmed_by_username: null,
  admin_approved_at: null, admin_approved_by_username: null, closed_at: null, closed_by_username: null,
  discount_type: null, discount_value: 0, coupon_code: null,
});

/** The floor as the bug was reproduced on it: three tickets, two sharing dishes. */
const threeTickets = () => makeState({
  orders: [
    ticket(KOT2, "2026-09-16T08:02:00Z", [CHAI("c1"), ROTI("r1")]),
    ticket(KOT3, "2026-09-16T08:03:00Z", [PANEER("p1"), ROTI("r2")]),
    ticket(KOT4, "2026-09-16T08:04:00Z", [PANEER("p2"), MOUSSE("m1")]),
  ],
  bills: [openBill(1429)],
});

const byId = (id: string): NcFixtureOrder => {
  const o = current().orders.find((x) => x.id === id);
  if (!o) {throw new Error(`no ticket ${id}`);}
  return o;
};
const namesOn = (id: string): string[] => byId(id).items.map((i) => i.name);

describe("removing one line takes one line — the ticket it is on keeps the rest, and so does every other ticket", () => {
  test("the dish the admin tapped, and nothing else: the twin on the next KOT stays", async () => {
    // THE BUG, as one call. Tandoori Roti sits on KOT 2 and on KOT 3; the admin
    // tapped the one on KOT 3.
    useState(threeTickets());
    const out = await db.RemoveBillItem(RID, TABLE, "Tandoori Roti", 130, { orderId: KOT3, itemId: "r2" });

    expect(out.removed).toMatchObject({ name: "Tandoori Roti", price: 130, quantity: 1, value: 130 });
    expect(out.taken).toHaveLength(1);
    expect(out.taken[0]!.order_id).toBe(KOT3);
    // The tapped ticket keeps its other dish; the other tickets are untouched.
    expect(namesOn(KOT3)).toEqual(["Paneer Tikka"]);
    expect(namesOn(KOT2)).toEqual(["Masala Chai", "Tandoori Roti"]);
    expect(namesOn(KOT4)).toEqual(["Paneer Tikka", "Dark Chocolate Mousse"]);
    // And every ticket is still live. Before the fix KOT 2 lost its Roti too.
    expect(current().orders.map((o) => o.status)).toEqual([1, 1, 1]);
  });

  test("the whole-KOT deletion itself: one Paneer Tikka off KOT 4 no longer empties KOT 3", async () => {
    // The floor's sentence, reproduced. KOT 3 held Paneer Tikka and nothing
    // else once its Roti had gone, so the second match emptied it and the
    // empty-order branch flipped it to Cancelled — the whole ticket, gone.
    useState(makeState({
      orders: [
        ticket(KOT3, "2026-09-16T08:03:00Z", [PANEER("p1")]),
        ticket(KOT4, "2026-09-16T08:04:00Z", [PANEER("p2"), MOUSSE("m1")]),
      ],
      bills: [openBill(1109)],
    }));
    const out = await db.RemoveBillItem(RID, TABLE, "Paneer Tikka", 320, { orderId: KOT4, itemId: "p2" });

    expect(out.removed).toMatchObject({ quantity: 1, value: 320 });
    expect(namesOn(KOT3)).toEqual(["Paneer Tikka"]);
    expect(byId(KOT3).status).toBe(1);
    expect(namesOn(KOT4)).toEqual(["Dark Chocolate Mousse"]);
  });

  test("the money: the tapped ticket is re-priced and the open bill re-summed, nothing else moves", async () => {
    useState(threeTickets());
    await db.RemoveBillItem(RID, TABLE, "Paneer Tikka", 320, { orderId: KOT4, itemId: "p2" });

    // The order's own stored figures, by the same rule every order writer uses.
    expect(byId(KOT4)).toMatchObject({ subtotal: 469, total: 469 });
    expect(byId(KOT2)).not.toHaveProperty("subtotal");
    // The open bill's pre-tax running sum: 250 + 450 + 469. And the stale
    // round-off is dropped, because the sum it belonged to has changed.
    expect(current().bills[0]).toMatchObject({ total_amt: 1169, round_off: null });
  });

  test("two identical lines on the SAME ticket: one goes, one stays — on the split too", async () => {
    // Ordered twice through "add an item", so the ticket carries the dish
    // twice, with a course split over the same lines.
    useState(makeState({
      orders: [{
        id: KOT2, status: 1, created_at: "2026-09-16T08:02:00Z",
        items: [ROTI("r1"), ROTI("r2"), CHAI("c1")],
        items_split: [["Served", [ROTI("r1")]], ["Preparing", [ROTI("r2"), CHAI("c1")]]],
      }],
      bills: [openBill(380)],
    }));
    const out = await db.RemoveBillItem(RID, TABLE, "Tandoori Roti", 130, { orderId: KOT2, itemId: "r2" });

    expect(out.removed).toMatchObject({ quantity: 1, value: 130 });
    expect(byId(KOT2).items.map((i) => i.id)).toEqual(["r1", "c1"]);
    // The Served course keeps the one that was served.
    expect(byId(KOT2).items_split).toEqual([["Served", [ROTI("r1")]], ["Preparing", [CHAI("c1")]]]);
    expect(current().bills[0]!.total_amt).toBe(250);
  });

  test("the last line off a ticket still cancels THAT ticket, and only that one", async () => {
    useState(threeTickets());
    await db.RemoveBillItem(RID, TABLE, "Paneer Tikka", 320, { orderId: KOT3, itemId: "p1" });
    await db.RemoveBillItem(RID, TABLE, "Tandoori Roti", 130, { orderId: KOT3, itemId: "r2" });

    expect(byId(KOT3)).toMatchObject({ status: 5, items: [] });
    expect(byId(KOT2).status).toBe(1);
    expect(byId(KOT4).status).toBe(1);
    // The void report still reads what came off it (stampLineRemoval).
    expect(byId(KOT3)).toMatchObject({ emptied_by: "remove" });
    expect((byId(KOT3) as unknown as { removed_items: { name: string }[] }).removed_items.map((l) => l.name))
      .toEqual(["Paneer Tikka", "Tandoori Roti"]);
    // 250 left on the table: the Chai and the Roti on KOT 2, plus KOT 4's 789.
    expect(current().bills[0]!.total_amt).toBe(1039);
  });
});

describe("a till that names no line", () => {
  test("no ids at all: the FIRST match on the oldest ticket, one line, not every copy", async () => {
    // Every shipped 2.0.2 build (and the Flutter owner app) sends name + price
    // only. It must not keep taking two dishes for one tap.
    useState(threeTickets());
    const out = await db.RemoveBillItem(RID, TABLE, "Tandoori Roti", 130);

    expect(out.removed).toMatchObject({ quantity: 1, value: 130 });
    expect(namesOn(KOT2)).toEqual(["Masala Chai"]);
    expect(namesOn(KOT3)).toEqual(["Paneer Tikka", "Tandoori Roti"]);
  });

  test("the ticket but no line id: the first match on THAT ticket", async () => {
    useState(threeTickets());
    const out = await db.RemoveBillItem(RID, TABLE, "Tandoori Roti", 130, { orderId: KOT3, itemId: null });

    expect(out.taken[0]!.order_id).toBe(KOT3);
    expect(namesOn(KOT2)).toEqual(["Masala Chai", "Tandoori Roti"]);
    expect(namesOn(KOT3)).toEqual(["Paneer Tikka"]);
  });

  test("a line id the table no longer holds is NOT FOUND — never the next dish with that name", async () => {
    // Two admins on the same table, or a stale sheet. Falling back to the name
    // would take a dish somebody is eating off a bill they are going to pay.
    useState(threeTickets());
    await expect(db.RemoveBillItem(RID, TABLE, "Tandoori Roti", 130, { orderId: null, itemId: "gone" }))
      .rejects.toThrow("Item not found on this table's bill");
    expect(namesOn(KOT2)).toEqual(["Masala Chai", "Tandoori Roti"]);
    expect(namesOn(KOT3)).toEqual(["Paneer Tikka", "Tandoori Roti"]);
    expect(current().bills[0]!.total_amt).toBe(1429);
  });

  test("an approved bill is still final for every shape of the request", async () => {
    // The gate is unchanged by any of this: assertBillEditable runs first.
    useState(makeState({
      orders: [ticket(KOT3, "2026-09-16T08:03:00Z", [PANEER("p1"), ROTI("r2")])],
      bills: [{ ...openBill(450), admin_approved_at: "2026-09-16T09:00:00Z" }],
    }));
    await expect(db.RemoveBillItem(RID, TABLE, "Paneer Tikka", 320, { orderId: KOT3, itemId: "p1" }))
      .rejects.toThrow("approved and is locked");
    expect(namesOn(KOT3)).toEqual(["Paneer Tikka", "Tandoori Roti"]);
  });
});

describe("the move is NOT narrowed — value is still conserved across every copy", () => {
  test("a move still reads every matching line off the table, on every ticket", () => {
    // removeItemFromTableOrders' header is about the 400 rupees a collapsed
    // move let out of the house: a move takes the whole dish wherever it sits,
    // and only the REMOVE was ever meant to take one line. The move's own
    // writer needs two tables, which this one-table fixture does not model, so
    // what is asserted here is the pre-read the move route resolves its KOT
    // numbers from — the same statement and the same matcher, unnarrowed.
    useState(threeTickets());
    return db.GetMovableLineSources(RID, TABLE, "Tandoori Roti", 130).then((sources) => {
      expect(sources.map((x) => x.order_id)).toEqual([KOT2, KOT3]);
      expect(sources.flatMap((x) => x.lines)).toHaveLength(2);
    });
  });
});
