// CLIENT ITEM 4 — WHAT GET /orders TELLS A SCREEN ABOUT A MOVE, through the
// REAL GetOrders over a fake pool.
//
// The table sheet's "KOT 65 · from 12", the Orders screen's "Moved → 31: NOT
// YOUR PUCHKA ×1" (where it used to say "Cancelled · 0 item(s)") and a moved
// dish's KOT number all come off this one read. Pinned: the keys are there when
// the order moved and absent when it did not; they carry no price, so the
// waiter redaction has nothing to add; and a dish moved while dockets were off
// still reads under the number the kitchen cooked it as — a printed number
// always winning over the recorded one.
import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { redactOrderList } from "../price_scope";

const RES = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OUTLET = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

interface Row { id: string; food: Record<string, unknown>; status: number }
const fx: { rows: Row[]; printJobs: { bill_id: string; kot_no: number }[]; kotColumn: boolean } = { rows: [], printJobs: [], kotColumn: false };

jest.mock("pg", () => {
  const query = async (sql: string): Promise<{ rows: unknown[] }> => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    if (/from "Restaurant" r/i.test(q)) {
      return { rows: [{ res_id: RES, outlet_id: OUTLET, restaurant_slug: "ggv", restaurant_name: "GGV", restaurant_main_office_add: null, restaurant_logo_url: null, timezone: "Asia/Kolkata" }] };
    }
    if (/table_name = 'PrintJobs' and column_name = 'kot_no'/i.test(q)) {
      return { rows: fx.kotColumn ? [{ column_name: "kot_no" }] : [] };
    }
    if (/from "Orders" o/i.test(q) && /left join lateral/i.test(q) && /b\.closed_by_username/i.test(q)) {
      return {
        rows: fx.rows.map((r) => ({
          id: r.id, food: r.food, status: r.status, timing: null, barked_at: null,
          created_at: "2026-09-14T15:16:31.000Z", updated_at: null, table_name: String(r.food.table ?? ""),
          bill_id: null, bill_status: null, payment_method: null, payment_proof_screenshot_url: null,
          waiter_confirmed_at: null, waiter_confirmed_by_username: null, admin_approved_at: null,
          admin_approved_by_username: null, closed_at: null, closed_by_username: null,
        })),
      };
    }
    if (/from "PrintJobs"/i.test(q) && /bill_id = any/i.test(q)) {
      return { rows: fx.printJobs };
    }
    return { rows: [] };
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string) { return query(sql); }
    connect() { return Promise.resolve({ query, release: () => undefined }); }
    end() { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

let db: typeof import("../database_supabase");
beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
});
beforeEach(async () => {
  fx.rows = [];
  fx.printJobs = [];
  fx.kotColumn = false;
  await db.initKotNumberLinkSchema();
});

const byId = async (): Promise<Map<string, Record<string, unknown>>> =>
  new Map((await db.GetOrders(RES)).map((o) => [o.id, o as unknown as Record<string, unknown>]));

describe("GET /orders — the move provenance", () => {
  test("an order that never moved gains no key at all", async () => {
    fx.rows = [{ id: "plain", status: 1, food: { table: "12", items: [{ id: "a", name: "Dal", price: 200, quantity: 1 }], subtotal: 200 } }];
    const o = (await byId()).get("plain")!;
    for (const key of ["moved_from", "moved_at", "emptied_by", "moved_items"]) {
      expect([key, key in o]).toEqual([key, false]);
    }
  });

  test("a moved ticket says where it came from, and when", async () => {
    fx.rows = [{
      id: "kot65", status: 1,
      food: { table: "15", items: [{ id: "a", name: "KUNAFA BIRDS NEST", price: 489, quantity: 1 }], subtotal: 489,
        moves: [{ from_table: "12", to_table: "15", at: "2026-09-14T16:32:00.000Z", by: "vineet" }] },
    }];
    expect((await byId()).get("kot65")).toMatchObject({ table: "15", moved_from: "12", moved_at: "2026-09-14T16:32:00.000Z" });
  });

  test("a ticket a dish move emptied names what left and where — and no price, even before redaction", async () => {
    fx.rows = [{
      id: "src", status: 5,
      food: { table: "31A", items: [], subtotal: 0, emptied_by: "move",
        moved_items: [{ id: "l1", name: "NOT YOUR PUCHKA", price: 469, quantity: 1, moved_at: "2026-09-14T15:16:31.000Z", to_table: "31", to_order_id: "new" }] },
    }];
    const o = (await byId()).get("src")!;
    expect(o).toMatchObject({
      status: "Cancelled", emptied_by: "move",
      moved_items: [{ name: "NOT YOUR PUCHKA", variation: null, quantity: 1, to_table: "31", moved_at: "2026-09-14T15:16:31.000Z" }],
    });
    expect(JSON.stringify(o.moved_items)).not.toMatch(/469|price/);
    // The waiter's copy is the same block, untouched.
    const redacted = redactOrderList([o]) as Record<string, unknown>[];
    expect(redacted[0]!.moved_items).toEqual(o.moved_items);
  });

  test("a dish-move ticket reads under the KOT it was cooked as when no docket carried a number", async () => {
    fx.rows = [{
      id: "new", status: 1,
      food: { table: "31", customer: "Guest", items: [{ id: "l1", name: "NOT YOUR PUCHKA", price: 469, quantity: 1 }], subtotal: 469,
        moved_from: { table: "31A", order_id: "src", kot_nos: [35], at: "2026-09-14T15:16:31.000Z", by: null } },
    }];
    const o = (await byId()).get("new")!;
    expect(o).toMatchObject({ moved_from: "31A", moved_at: "2026-09-14T15:16:31.000Z", kot_nos: [35], customer: "Guest" });
  });

  test("…and a printed number always wins over the recorded one", async () => {
    fx.kotColumn = true;
    await db.initKotNumberLinkSchema();
    fx.printJobs = [{ bill_id: "order-new", kot_no: 36 }];
    fx.rows = [
      { id: "new", status: 1, food: { table: "31", items: [], moved_from: { table: "31A", kot_nos: [35], at: "t" } } },
      { id: "other", status: 1, food: { table: "31", items: [], moved_from: { table: "31A", kot_nos: [40], at: "t" } } },
    ];
    const m = await byId();
    expect(m.get("new")!.kot_nos).toEqual([36]);
    expect(m.get("other")!.kot_nos).toEqual([40]);
  });
});
