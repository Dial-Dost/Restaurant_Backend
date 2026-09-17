// ROUND 2 ITEM 1 — THE CUSTOMER'S NAME AND GSTIN ON A BILL, the data layer half.
//
// "Enable Customer Name Editing ... This also includes customer GST number for
// corporate parties. This option has to come in the past bills section in
// accounting and in live tables."
//
// ============================================================================
// WHAT EACH BLOCK PROVES
// ============================================================================
//   * THE RULE — one validator, and the exact shapes the three clients mirror:
//     lowercase and spaced input normalizes, blank clears, anything else is the
//     one 400 sentence.
//   * THE LIVE TABLE — every still-owing order carries the GSTIN beside the
//     name (the carrier the name already uses), the open bill row too, and an
//     OMITTED GSTIN touches nothing: a till built before this field existed must
//     not wipe a GSTIN somebody else typed.
//   * THE PAST BILL — it changes the two fields and NOTHING ELSE. The write set
//     is asserted statement by statement, and every rewritten food blob is
//     asserted equal to the original with only those two keys moved.
//   * THE READS — the running bill, the settled detail and the settled list all
//     carry `customer_gstin`, by the same read rule.
//   * THE PAPER — "Customer GSTIN:" directly under the "Name:" slot, only when
//     there is one to print; a walk-in's slot left blank rather than reading
//     "Guest"; both inside the roll's text area, and never on a KOT.
//   * A DATABASE WITHOUT MIGRATION 046 — the build ships first. Reads degrade to
//     the orders' copy without ever naming the column; a GSTIN write is refused
//     (503) before anything at all is written; a name-only edit still works; and
//     a stale "the column exists" that meets a real 42703 degrades too.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { buildReceiptBase64, buildSplitReceiptsBase64, type ReceiptOptions } from "../escpos";
import {
  CUSTOMER_GSTIN_ERROR,
  CUSTOMER_GSTIN_SCHEMA_PENDING_ERROR,
  CustomerGstinSchemaPendingError,
  normalizeCustomerGstin,
} from "../customer_gstin";
import { redactBillForTable } from "../price_scope";

const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";
const TABLE_ID = "33333333-3333-4333-8333-333333333333";
const BILL_ID = "55555555-5555-4555-8555-555555555555";
const GSTIN = "29ABCDE1234F1Z5";

interface Fx {
  sql: string[];
  /** Does information_schema list "Bills".customer_gstin? */
  columnPresent: boolean;
  /** A statement naming the column raises 42703 even though the catalogue said it exists. */
  column42703: boolean;
  /** The running table's still-owing orders. */
  liveOrders: { id: string; food: Record<string, unknown>; created_at?: Date }[];
  /** The settled bill's orders (the closed-bill window). */
  closedOrders: { id: string; food: Record<string, unknown>; created_at: Date; status: string }[];
  /** The settled bill row, or null for "no such settled bill". */
  closedBill: Record<string, unknown> | null;
  /** "Bills".customer_gstin on the settled bill. */
  storedGstin: string | null;
  /** What the list's orders fallback answers, per bill id. */
  listFoodGstin: Record<string, string | null>;
  orderWrites: { id: string; food: Record<string, unknown> }[];
  billWrites: { sql: string; params: unknown[] }[];
  billLocked: boolean;
}

const fx: Fx = {
  sql: [], columnPresent: true, column42703: false, liveOrders: [], closedOrders: [], closedBill: null,
  storedGstin: null, listFoodGstin: {}, orderWrites: [], billWrites: [], billLocked: false,
};

const CLOSED_AT = new Date("2026-09-12T15:00:00.000Z");

/** The row CLOSED_BILL_SELECT produces, for the detail and the list. */
const closedBillSelectRow = () => ({
  id: BILL_ID, bill_no: "5910", status: 7, reason: null, table_id: TABLE_ID, table_name: "T7",
  total_amt: 1050, tax_breakdown: [{ name: "GST", percentage: 5, amount: 50 }],
  payment_method: "Cash", payment_splits: null, payment_proof_screenshot_url: null,
  discount_type: null, discount_value: 0, discount_applied_at: null, coupon_code: null,
  waiter_confirmed_at: CLOSED_AT, waiter_confirmed_by_username: null,
  admin_approved_at: CLOSED_AT, admin_approved_by_username: null,
  closed_at: CLOSED_AT, closed_by_username: "admin",
  refunded_at: null, refunded_by_username: null, refund_amount: 0, refund_reason: null, refund_ref: null,
  created_at: CLOSED_AT, created_by_fname: "Jim", created_by_lname: "", session_covers: 2,
  seated_at: CLOSED_AT, left_at: CLOSED_AT,
});

jest.mock("pg", () => {
  const query = async (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    fx.sql.push(q);
    const p = (params ?? []) as unknown[];
    const namesColumn = /customer_gstin from "Bills"|set customer_gstin/i.test(q);
    if (namesColumn && (!fx.columnPresent || fx.column42703)) {
      throw Object.assign(new Error('column "customer_gstin" does not exist'), { code: "42703" });
    }
    if (/information_schema\.columns/i.test(q)) {
      return { rows: /'customer_gstin'/.test(q) && fx.columnPresent ? [{ column_name: "customer_gstin" }] : [] };
    }
    if (/from "Restaurant" r/i.test(q)) {
      return { rows: [{
        res_id: RES, outlet_id: OUTLET, restaurant_slug: "gaia", restaurant_name: "Gaia",
        restaurant_main_office_add: null, restaurant_logo_url: null, timezone: "Asia/Kolkata",
      }] };
    }
    if (/^select service_charge from "Restaurant"/i.test(q)) { return { rows: [{ service_charge: 0 }] }; }
    // Running table.
    if (/^select id from "Tables"/i.test(q)) { return { rows: [{ id: TABLE_ID }] }; }
    if (/^select id, coalesce\(num_covers, 1\) as num_covers from "Tables"/i.test(q)) {
      return { rows: [{ id: TABLE_ID, num_covers: 2 }] };
    }
    if (/admin_approved_at from "Bills"/i.test(q)) {
      return { rows: [{ admin_approved_at: fx.billLocked ? new Date() : null }] };
    }
    if (/^select id, food from "Orders"/i.test(q)) { return { rows: fx.liveOrders }; }
    if (/^select id, food, created_at from "Orders"/i.test(q)) {
      return { rows: fx.liveOrders.map((o) => ({ ...o, created_at: o.created_at ?? CLOSED_AT })) };
    }
    // Settled bill.
    if (/^select b\.id, b\.bill_no::text as bill_no, b\.table_id, t\.table_name, b\.closed_at from "Bills" b/i.test(q)) {
      return { rows: fx.closedBill ? [fx.closedBill] : [] };
    }
    if (/^select b\.id, b\.bill_no, b\.status/i.test(q)) { return { rows: fx.closedBill ? [closedBillSelectRow()] : [] }; }
    if (/^select count\(\*\)::text as total from "Bills"/i.test(q)) { return { rows: [{ total: fx.closedBill ? "1" : "0" }] }; }
    if (/as prev_closed from "Bills"/i.test(q)) { return { rows: [{ prev_closed: new Date(0) }] }; }
    if (/^select id, created_at, status, food from "Orders"/i.test(q)) { return { rows: fx.closedOrders }; }
    if (/^select id, customer_gstin from "Bills"/i.test(q)) {
      return { rows: fx.storedGstin ? [{ id: BILL_ID, customer_gstin: fx.storedGstin }] : [] };
    }
    if (/^select customer_gstin from "Bills"/i.test(q)) { return { rows: [{ customer_gstin: fx.storedGstin }] }; }
    if (/^select b\.id::text as id, \(select nullif\(btrim\(o\.food::jsonb ->> 'customer_gstin'\)/i.test(q)) {
      const ids = (p[1] as string[]) ?? [];
      return { rows: ids.map((id) => ({ id, food_gstin: fx.listFoodGstin[id] ?? null })) };
    }
    // Writes.
    if (/^update "Orders" set food/i.test(q)) {
      fx.orderWrites.push({ id: String(p[0]), food: JSON.parse(String(p[3])) as Record<string, unknown> });
      return { rows: [] };
    }
    if (/^update "Bills"/i.test(q)) {
      fx.billWrites.push({ sql: q, params: p });
      return { rows: [] };
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

jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: jest.fn(), emitOutlet: jest.fn() }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: jest.fn() }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

let db: typeof import("../database_supabase");

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
});

beforeEach(() => {
  db.resetBillCustomerGstinColumnCache();
  fx.sql = [];
  fx.columnPresent = true;
  fx.column42703 = false;
  fx.orderWrites = [];
  fx.billWrites = [];
  fx.billLocked = false;
  fx.storedGstin = null;
  fx.listFoodGstin = {};
  fx.liveOrders = [
    { id: "o1", food: { customer: "Guest", items: [{ name: "Paneer Tikka", price: 390, quantity: 1 }], subtotal: 390, total: 390 } },
    { id: "o2", food: { customer: "Guest", items: [{ name: "Garlic Naan", price: 199, quantity: 2 }], subtotal: 398, total: 398 } },
  ];
  fx.closedOrders = [
    {
      id: "c1", created_at: new Date("2026-09-12T14:00:00.000Z"), status: "7",
      food: {
        customer: "Mr Sharma", taken_by_employee_name: "Jim", note: "no onions",
        items: [{ name: "Biryani", price: 500, quantity: 2, note: "mild" }], subtotal: 1000, total: 1000,
      },
    },
  ];
  fx.closedBill = { id: BILL_ID, bill_no: "5910", table_id: TABLE_ID, table_name: "T7", closed_at: CLOSED_AT };
});

/** SQL statements that name the migration-046 COLUMN (not the JSON key inside food). */
const columnStatements = (): string[] =>
  fx.sql.filter((q) => /customer_gstin from "Bills"|set customer_gstin/i.test(q));

// ===========================================================================
// THE RULE
// ===========================================================================
describe("GSTIN validation — one rule, mirrored by every client", () => {
  test("a valid GSTIN passes unchanged", () => {
    expect(normalizeCustomerGstin(GSTIN)).toEqual({ ok: true, value: GSTIN });
  });

  test("lowercase is uppercased", () => {
    expect(normalizeCustomerGstin("29abcde1234f1z5")).toEqual({ ok: true, value: GSTIN });
  });

  test("surrounding and internal spaces are stripped (typed off a visiting card)", () => {
    expect(normalizeCustomerGstin("  29ABCDE 1234 F1Z5 ")).toEqual({ ok: true, value: GSTIN });
    expect(normalizeCustomerGstin("29 abcde\t1234 f 1 z 5")).toEqual({ ok: true, value: GSTIN });
  });

  test("blank, whitespace and null CLEAR it", () => {
    expect(normalizeCustomerGstin("")).toEqual({ ok: true, value: null });
    expect(normalizeCustomerGstin("    ")).toEqual({ ok: true, value: null });
    expect(normalizeCustomerGstin(null)).toEqual({ ok: true, value: null });
    expect(normalizeCustomerGstin(undefined)).toEqual({ ok: true, value: null });
  });

  test.each([
    ["too short", "29ABCDE1234F1Z"],
    ["too long", "29ABCDE1234F1Z55"],
    ["letters where the state code goes", "AAABCDE1234F1Z5"],
    ["digit where the PAN letters go", "2912CDE1234F1Z5"],
    ["zero as the entity number", "29ABCDE1234F0Z5"],
    ["no Z in the 14th place", "29ABCDE1234F1X5"],
    ["punctuation", "29ABCDE-1234F1Z5"],
    ["a number", 291234567890123],
  ])("%s is refused", (_label, raw) => {
    expect(normalizeCustomerGstin(raw)).toEqual({ ok: false });
  });

  test("the refusal sentence is the contract's, verbatim", () => {
    expect(CUSTOMER_GSTIN_ERROR).toBe("GSTIN must be 15 characters, e.g. 29ABCDE1234F1Z5");
    expect(CUSTOMER_GSTIN_SCHEMA_PENDING_ERROR).toBe("This server has not finished updating — try again shortly");
  });
});

// ===========================================================================
// THE LIVE TABLE
// ===========================================================================
describe("the running table's bill: name + GSTIN", () => {
  test("EVERY still-owing order carries the GSTIN beside the name, and the open bill row gets it", async () => {
    const r = await db.SetBillCustomerName(RES, "T7", "Acme Pvt Ltd", "29abcde 1234f1z5");
    expect(r).toEqual({ success: true, customer: "Acme Pvt Ltd", customer_gstin: GSTIN, customer_address: null, orders_updated: 2 });
    expect(fx.orderWrites.map((w) => w.id).sort()).toEqual(["o1", "o2"]);
    for (const w of fx.orderWrites) {
      expect(w.food.customer).toBe("Acme Pvt Ltd");
      expect(w.food.customer_gstin).toBe(GSTIN);
    }
    expect(fx.billWrites).toHaveLength(1);
    expect(fx.billWrites[0].sql).toMatch(/^update "Bills" set customer_gstin = \$4 where table_id = \$1 and res_id = \$2 and outlet_id = \$3 and closed_at is null$/);
    expect(fx.billWrites[0].params).toEqual([TABLE_ID, RES, OUTLET, GSTIN]);
  });

  test("the items and money on each order are carried through untouched", async () => {
    const before = fx.liveOrders.map((o) => ({ id: o.id, food: { ...o.food } }));
    await db.SetBillCustomerName(RES, "T7", "Acme Pvt Ltd", GSTIN);
    for (const w of fx.orderWrites) {
      const { customer: _c, customer_gstin: _g, ...rest } = w.food;
      const { customer: _c0, ...restBefore } = before.find((b) => b.id === w.id)!.food;
      expect(rest).toEqual(restBefore);
    }
  });

  test("OMITTED leaves the GSTIN alone — no key written, no bill row touched, no catalogue probe", async () => {
    fx.liveOrders = [
      { id: "o1", food: { customer: "Acme", customer_gstin: GSTIN, items: [] } },
      { id: "o2", food: { customer: "Guest", items: [] } },
    ];
    const r = await db.SetBillCustomerName(RES, "T7", "Acme Pvt Ltd");
    expect(r.customer_gstin).toBe(GSTIN); // reports what the table still carries
    expect(fx.orderWrites.find((w) => w.id === "o1")!.food.customer_gstin).toBe(GSTIN);
    expect("customer_gstin" in fx.orderWrites.find((w) => w.id === "o2")!.food).toBe(false);
    expect(fx.billWrites).toHaveLength(0);
    expect(fx.sql.some((q) => /information_schema/.test(q))).toBe(false);
  });

  test("null and \"\" CLEAR it from every order and from the open bill row", async () => {
    for (const clear of [null, ""]) {
      fx.orderWrites = [];
      fx.billWrites = [];
      fx.liveOrders = [
        { id: "o1", food: { customer: "Acme", customer_gstin: GSTIN, items: [] } },
        { id: "o2", food: { customer: "Acme", customer_gstin: GSTIN, items: [] } },
      ];
      const r = await db.SetBillCustomerName(RES, "T7", "Acme", clear);
      expect(r.customer_gstin).toBeNull();
      expect(fx.orderWrites).toHaveLength(2);
      for (const w of fx.orderWrites) { expect("customer_gstin" in w.food).toBe(false); }
      expect(fx.billWrites[0].params[3]).toBeNull();
    }
  });

  test("an invalid GSTIN is refused by the data layer too, before anything is written", async () => {
    await expect(db.SetBillCustomerName(RES, "T7", "Acme", "not-a-gstin")).rejects.toThrow(CUSTOMER_GSTIN_ERROR);
    expect(fx.orderWrites).toHaveLength(0);
    expect(fx.billWrites).toHaveLength(0);
  });

  test("a SETTLED table is still refused here — the past bill has its own door", async () => {
    fx.billLocked = true;
    await expect(db.SetBillCustomerName(RES, "T7", "Acme", GSTIN)).rejects.toThrow(/locked/);
    expect(fx.orderWrites).toHaveLength(0);
  });
});

// ===========================================================================
// THE PAST BILL
// ===========================================================================
describe("a past (settled) bill: name + GSTIN and nothing else", () => {
  test("writes the name and GSTIN, returns the contract's fields", async () => {
    const r = await db.SetClosedBillCustomerDetails(RES, BILL_ID, "  Acme   Pvt Ltd ", GSTIN);
    expect(r).toMatchObject({ success: true, bill_id: BILL_ID, bill_no: "5910", table_name: "T7", customer: "Acme Pvt Ltd", customer_gstin: GSTIN });
    expect(fx.orderWrites).toHaveLength(1);
    expect(fx.orderWrites[0].food.customer).toBe("Acme Pvt Ltd");
    expect(fx.orderWrites[0].food.customer_gstin).toBe(GSTIN);
    expect(fx.billWrites).toHaveLength(1);
    expect(fx.billWrites[0].params).toEqual([BILL_ID, RES, GSTIN]);
  });

  test("MONEY, STATUS AND TIMESTAMPS ARE UNTOUCHED — the write set is exactly two statement shapes", async () => {
    const before = JSON.parse(JSON.stringify(fx.closedOrders[0].food)) as Record<string, unknown>;
    await db.SetClosedBillCustomerDetails(RES, BILL_ID, "Acme Pvt Ltd", GSTIN);
    const writes = fx.sql.filter((q) => /^(update|insert|delete)\b/i.test(q));
    expect(writes).toEqual([
      'update "Orders" set food = $4::json where id = $1 and res_id = $2 and outlet_id = $3',
      'update "Bills" set customer_gstin = $3 where id = $1 and res_id = $2',
    ]);
    // Nothing that is money, status or a bill timestamp is named by any write.
    for (const w of writes) {
      expect(w).not.toMatch(/total_amt|tax_breakdown|status|closed_at|admin_approved_at|waiter_confirmed_at|discount|refund|payment/i);
    }
    // And the one rewritten blob moved only the two keys.
    const { customer: _c, customer_gstin: _g, ...after } = fx.orderWrites[0].food;
    const { customer: _c0, ...rest } = before;
    expect(after).toEqual(rest);
  });

  test("a name-only edit (GSTIN omitted) leaves the GSTIN and the bill row alone, and reports the stored one", async () => {
    fx.storedGstin = GSTIN;
    const r = await db.SetClosedBillCustomerDetails(RES, BILL_ID, "Acme Pvt Ltd");
    expect(r?.customer_gstin).toBe(GSTIN);
    expect(fx.billWrites).toHaveLength(0);
    expect("customer_gstin" in fx.orderWrites[0].food).toBe(false);
  });

  test("clearing strips BOTH carriers, so the old GSTIN cannot come back from the other one", async () => {
    fx.closedOrders[0].food.customer_gstin = GSTIN;
    const r = await db.SetClosedBillCustomerDetails(RES, BILL_ID, "Acme Pvt Ltd", null);
    expect(r?.customer_gstin).toBeNull();
    expect("customer_gstin" in fx.orderWrites[0].food).toBe(false);
    expect(fx.billWrites[0].params).toEqual([BILL_ID, RES, null]);
  });

  test("blank name restores the Guest placeholder, exactly as the live route does", async () => {
    const r = await db.SetClosedBillCustomerDetails(RES, BILL_ID, "   ", GSTIN);
    expect(r?.customer).toBeNull();
    expect(fx.orderWrites[0].food.customer).toBe("Guest");
  });

  test("no settled bill with that id -> null (the route's 404); nothing written", async () => {
    fx.closedBill = null;
    expect(await db.SetClosedBillCustomerDetails(RES, BILL_ID, "Acme", GSTIN)).toBeNull();
    expect(fx.orderWrites).toHaveLength(0);
    expect(fx.billWrites).toHaveLength(0);
  });

  test("the bill lookup only matches a SETTLED bill of THIS tenant", async () => {
    await db.SetClosedBillCustomerDetails(RES, BILL_ID, "Acme", GSTIN);
    const lookup = fx.sql.find((q) => /^select b\.id, b\.bill_no::text as bill_no/i.test(q))!;
    expect(lookup).toMatch(/b\.res_id = \$2/);
    expect(lookup).toMatch(/b\.closed_at is not null or b\.admin_approved_at is not null/);
  });

  test("a bill id that is not a uuid is 'not found', never a 500 from the uuid cast", async () => {
    expect(await db.SetClosedBillCustomerDetails(RES, "not-a-uuid", "Acme", GSTIN)).toBeNull();
    expect(fx.sql.filter((q) => /from "Bills"/.test(q))).toHaveLength(0);
  });
});

// ===========================================================================
// THE READS
// ===========================================================================
describe("reads carry customer_gstin", () => {
  test("GET /bill-for-table's reader: the first order that carries one", async () => {
    fx.liveOrders = [
      { id: "o1", food: { customer: "Acme", items: [{ name: "Paneer Tikka", price: 390, quantity: 1 }] } },
      { id: "o2", food: { customer: "Acme", customer_gstin: GSTIN, items: [{ name: "Naan", price: 50, quantity: 1 }] } },
    ];
    const bill = await db.GetBillForTable(RES, "T7");
    expect(bill?.customer).toBe("Acme");
    expect(bill?.customer_gstin).toBe(GSTIN);
    // The hot-polled reader hangs no statement off the 046 column.
    expect(columnStatements()).toHaveLength(0);
  });

  test("…and null when no order carries one", async () => {
    const bill = await db.GetBillForTable(RES, "T7");
    expect(bill?.customer_gstin).toBeNull();
  });

  test("the settled detail prefers the bill row's column", async () => {
    fx.storedGstin = GSTIN;
    fx.closedOrders[0].food.customer_gstin = "27AAAAA0000A1Z5";
    const bill = await db.GetClosedBill(RES, BILL_ID);
    expect(bill?.customer).toBe("Mr Sharma");
    expect(bill?.customer_gstin).toBe(GSTIN);
  });

  test("the settled detail falls back to the orders when the row holds none", async () => {
    fx.closedOrders[0].food.customer_gstin = GSTIN;
    const bill = await db.GetClosedBill(RES, BILL_ID);
    expect(bill?.customer_gstin).toBe(GSTIN);
  });

  test("the settled list carries it, column first, orders second", async () => {
    fx.storedGstin = GSTIN;
    let page = await db.ListClosedBills(RES, {});
    expect(page.bills[0].customer_gstin).toBe(GSTIN);

    fx.storedGstin = null;
    fx.listFoodGstin = { [BILL_ID]: "27AAAAA0000A1Z5" };
    page = await db.ListClosedBills(RES, {});
    expect(page.bills[0].customer_gstin).toBe("27AAAAA0000A1Z5");

    fx.listFoodGstin = {};
    page = await db.ListClosedBills(RES, {});
    expect(page.bills[0].customer_gstin).toBeNull();
  });

  test("C4's waiter redaction does NOT remove it — it is not money", () => {
    const out = redactBillForTable({ customer: "Acme", customer_gstin: GSTIN, grand_total: 100, items: [] });
    expect(out.customer_gstin).toBe(GSTIN);
    expect(out.customer).toBe("Acme");
  });
});

// ===========================================================================
// A DATABASE WITHOUT MIGRATION 046
// ===========================================================================
describe("migration 046 not applied yet (42703 tolerance)", () => {
  beforeEach(() => { fx.columnPresent = false; });

  test("a GSTIN write on the live table is refused with the 503 error BEFORE anything is written", async () => {
    const err = await db.SetBillCustomerName(RES, "T7", "Acme", GSTIN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CustomerGstinSchemaPendingError);
    expect((err as Error).message).toBe(CUSTOMER_GSTIN_SCHEMA_PENDING_ERROR);
    expect(fx.orderWrites).toHaveLength(0);
    expect(fx.billWrites).toHaveLength(0);
    expect(columnStatements()).toHaveLength(0);
  });

  test("clearing a GSTIN is a GSTIN write too — refused, not silently half-done", async () => {
    await expect(db.SetBillCustomerName(RES, "T7", "Acme", null)).rejects.toBeInstanceOf(CustomerGstinSchemaPendingError);
    expect(fx.orderWrites).toHaveLength(0);
  });

  test("a NAME-ONLY live edit still works", async () => {
    const r = await db.SetBillCustomerName(RES, "T7", "Acme");
    expect(r).toMatchObject({ success: true, customer: "Acme", customer_gstin: null, orders_updated: 2 });
    expect(columnStatements()).toHaveLength(0);
  });

  test("a GSTIN write on a past bill is refused with the 503 error before anything is written", async () => {
    await expect(db.SetClosedBillCustomerDetails(RES, BILL_ID, "Acme", GSTIN)).rejects.toBeInstanceOf(CustomerGstinSchemaPendingError);
    expect(fx.orderWrites).toHaveLength(0);
    expect(fx.billWrites).toHaveLength(0);
  });

  test("a NAME-ONLY past-bill edit still works, and never names the column", async () => {
    const r = await db.SetClosedBillCustomerDetails(RES, BILL_ID, "Acme");
    expect(r).toMatchObject({ success: true, customer: "Acme", customer_gstin: null });
    expect(fx.orderWrites).toHaveLength(1);
    expect(columnStatements()).toHaveLength(0);
  });

  test("the settled detail and list read without the column (null / the orders' copy)", async () => {
    const detail = await db.GetClosedBill(RES, BILL_ID);
    expect(detail?.customer_gstin).toBeNull();
    expect(detail?.grand_total).toBe(1050);
    const page = await db.ListClosedBills(RES, {});
    expect(page.bills[0].customer_gstin).toBeNull();
    expect(columnStatements()).toHaveLength(0);
  });

  test("the running bill reads without the column", async () => {
    const bill = await db.GetBillForTable(RES, "T7");
    expect(bill?.customer_gstin).toBeNull();
    expect(columnStatements()).toHaveLength(0);
  });

  test("the latch RE-ASKS: once 046 lands, GSTIN writes start working without a restart", async () => {
    await expect(db.SetBillCustomerName(RES, "T7", "Acme", GSTIN)).rejects.toBeInstanceOf(CustomerGstinSchemaPendingError);
    fx.columnPresent = true;
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 61_000;
      const r = await db.SetBillCustomerName(RES, "T7", "Acme", GSTIN);
      expect(r.customer_gstin).toBe(GSTIN);
    } finally {
      Date.now = realNow;
    }
  });

  test("a STALE 'column exists' that meets a real 42703 on read degrades instead of failing the bill", async () => {
    fx.columnPresent = true;   // the catalogue says yes…
    fx.column42703 = true;     // …the statement says no.
    fx.closedOrders[0].food.customer_gstin = GSTIN;
    const detail = await db.GetClosedBill(RES, BILL_ID);
    expect(detail?.customer_gstin).toBe(GSTIN); // the orders' copy
    expect(detail?.grand_total).toBe(1050);
    // …and the latch now says absent, so the next GSTIN write refuses cleanly.
    await expect(db.SetBillCustomerName(RES, "T7", "Acme", GSTIN)).rejects.toBeInstanceOf(CustomerGstinSchemaPendingError);
    expect(fx.orderWrites).toHaveLength(0);
  });
});

// ===========================================================================
// THE PAPER
// ===========================================================================
/**
 * The receipt as the paper reads it: the ESC/POS commands walked out of the
 * stream, each GS v 0 raster replaced by one marker line.
 *
 * Walked, not pattern-stripped, because the bill's rules are rasters now and a
 * thin rule's header carries a height byte of 0x0a — the "\n" a line split
 * looks for. A raster is skipped by the length its own header states (8 +
 * widthBytes x height); a rule (blank rows around 2 or 4 solid ones) reads as
 * "<RULE>" / "<RULE:THICK>", anything else (the logo) as "<IMAGE>".
 */
const printed = (b64: string): string => {
  const buf = Buffer.from(b64, "base64");
  const u16 = (at: number) => buf[at]! | (buf[at + 1]! << 8);
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    const cmd = buf[i + 1];
    if (b === 0x1b && cmd === 0x40) { i += 1; continue; }                                    // ESC @
    if (b === 0x1b && (cmd === 0x61 || cmd === 0x21 || cmd === 0x45)) { i += 2; continue; }  // ESC a/!/E n
    if (b === 0x1d && cmd === 0x56) { i += 2; continue; }                                    // GS V n  cut
    if (b === 0x1d && (cmd === 0x4c || cmd === 0x57)) { i += 3; continue; }                  // GS L / GS W  margins
    if (b === 0x1d && cmd === 0x76 && buf[i + 2] === 0x30) {                                 // GS v 0 raster
      const widthBytes = u16(i + 4);
      const height = u16(i + 6);
      const rows = Array.from({ length: height }, (_, y) =>
        buf.subarray(i + 8 + y * widthBytes, i + 8 + (y + 1) * widthBytes));
      const inked = rows.map((r) => r.some((x) => x !== 0x00));
      // Every inked row full edge to edge (a last byte may keep only its leading
      // bits), and the inked rows one unbroken band.
      const solid = rows.every((r, y) => !inked[y] || r.subarray(0, widthBytes - 1).every((x) => x === 0xff));
      const ink = inked.filter(Boolean).length;
      const band = inked.lastIndexOf(true) - inked.indexOf(true) + 1 === ink;
      const marker = !solid || !band ? "<IMAGE>" : ink === 2 ? "<RULE>" : ink === 4 ? "<RULE:THICK>" : "<IMAGE>";
      out += `${out === "" || out.endsWith("\n") ? "" : "\n"}${marker}\n`;
      i += 7 + widthBytes * height;
      continue;
    }
    out += String.fromCharCode(b);
  }
  return out;
};

const bill: ReceiptOptions = {
  restaurantName: "Gaia", table: "21", covers: 2,
  items: [{ name: "Kronos", price: 390, quantity: 1 }],
  total: 390, grandTotal: 409.5, currency: "₹", kind: "bill",
  billNo: "5910", cashier: "JIM", printedAt: "06/09/26 21:06", kotNumbers: [214, 218],
};

/** Any line that is a customer-name slot, in the wording of this bill or an older one. */
const NAME_SLOT = /^(Customer( Name)?|Name):/;

describe("the thermal bill prints who the invoice is made out to", () => {
  test("the GSTIN sits directly under the Name slot, above the date block (the client's bill layout)", () => {
    const out = printed(buildReceiptBase64({ ...bill, customer: "Acme Pvt Ltd", customerGstin: GSTIN }));
    const lines = out.split("\n");
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    expect(at(/^Name: Acme Pvt Ltd$/)).toBeGreaterThan(-1);
    expect(at(/^Customer GSTIN: 29ABCDE1234F1Z5$/)).toBe(at(/^Name: /) + 1);
    // Above the date / bill-no block and the items, as on the client's paper.
    expect(at(/^Customer GSTIN: /)).toBeLessThan(at(/Date: 06\/09\/26 21:06/));
    expect(at(/^Customer GSTIN: /)).toBeLessThan(at(/Bill No\.: 5910/));
    expect(at(/^Customer GSTIN: /)).toBeLessThan(at(/Kronos/));
    // The name is printed ONCE — no second customer line lower down.
    expect(lines.filter((l) => NAME_SLOT.test(l))).toHaveLength(1);
    // The restaurant's own GSTIN label is untouched and distinct.
    expect(out).not.toMatch(/GSTN : 29ABCDE1234F1Z5/);
  });

  test.each(["Guest", "QR Guest", "", "null", null, undefined])("a walk-in (name %p) leaves the Name slot blank, with no GSTIN line", (name) => {
    // The client's bill: a bare "Name:" for a guest who gave none. The ordering
    // flows' "Guest" placeholder is not a name and must not print as one.
    const out = printed(buildReceiptBase64({ ...bill, customer: name as string | null | undefined }));
    const lines = out.split("\n");
    const slot = lines.findIndex((l) => NAME_SLOT.test(l));
    expect(lines[slot]).toBe("Name:");
    expect(lines.filter((l) => NAME_SLOT.test(l))).toHaveLength(1);
    // Nothing stray fills the blank: the rule closing the block comes next.
    expect(lines[slot + 1]).toBe("<RULE>");
    expect(out).not.toMatch(/guest|null|undefined/i);
    expect(out).not.toContain("Customer GSTIN");
  });

  test("no GSTIN prints no GSTIN line — not a bare label", () => {
    for (const g of [null, undefined, "", "null"]) {
      const out = printed(buildReceiptBase64({ ...bill, customer: "Acme", customerGstin: g }));
      const lines = out.split("\n");
      const slot = lines.indexOf("Name: Acme");
      expect(slot).toBeGreaterThan(-1);
      expect(lines[slot + 1]).toBe("<RULE>");
      expect(out).not.toContain("Customer GSTIN");
    }
  });

  test("a GSTIN with a Guest name still prints the GSTIN, directly under the blank slot", () => {
    const out = printed(buildReceiptBase64({ ...bill, customer: "Guest", customerGstin: GSTIN }));
    const lines = out.split("\n");
    expect(lines.indexOf("Customer GSTIN: 29ABCDE1234F1Z5")).toBe(lines.indexOf("Name:") + 1);
    expect(lines.indexOf("Name:")).toBeGreaterThan(-1);
  });

  test.each([
    // The roll, and the cells a line may use on it: 80mm keeps a two-cell margin
    // either side (48 - 4 = 44), 58mm keeps none.
    [48, 44],
    [32, 32],
  ])("a long name wraps inside the %p-column roll's %p-cell text area instead of running off it", (roll, area) => {
    const name = "Navkrish Hospitality Private Limited Corporate Account";
    const out = printed(buildReceiptBase64({ ...bill, customer: name, customerGstin: GSTIN }, roll));
    const lines = out.split("\n");
    const from = lines.findIndex((l) => l.startsWith("Name: "));
    const to = lines.findIndex((l) => l.startsWith("Customer GSTIN: "));
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const block = lines.slice(from, to + 1);
    expect(block.slice(0, -1).join(" ")).toBe(`Name: ${name}`);
    for (const l of block) { expect(l.length).toBeLessThanOrEqual(area); }
  });

  test("the KOT never carries them", () => {
    const out = printed(buildReceiptBase64({ ...bill, kind: "kot", customer: "Acme", customerGstin: GSTIN }));
    expect(out).not.toContain("Customer GSTIN");
    expect(out).not.toMatch(new RegExp(NAME_SLOT.source, "m"));
    expect(out).not.toContain("Acme");
  });

  test("every part of a split bill carries them (the bill's identity, not a part's)", () => {
    const parts = buildSplitReceiptsBase64({ ...bill, customer: "Acme", customerGstin: GSTIN }, [
      { key: "a", label: "A", subtotal: 200, grand_total: 210, items: [{ name: "Kronos", price: 200, quantity: 1 }] },
      { key: "b", label: "B", subtotal: 190, grand_total: 199.5, items: [{ name: "Naan", price: 190, quantity: 1 }] },
    ], 48);
    expect(parts).toHaveLength(2);
    for (const p of parts) { expect(printed(p.escBase64)).toMatch(/^Customer GSTIN: 29ABCDE1234F1Z5$/m); }
  });

  test("a bill with neither is unchanged apart from nothing — no new line at all", () => {
    const withNeither = printed(buildReceiptBase64({ ...bill, customer: "Guest" }));
    const explicitNulls = printed(buildReceiptBase64({ ...bill, customer: "Guest", customerGstin: null }));
    expect(explicitNulls).toBe(withNeither);
  });
});

describe("every bill print path hands the GSTIN to the renderer", () => {
  function source(): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const file = [process.cwd(), path.join(__dirname, "..")]
      .map((b) => path.join(b, "routes", "bills.ts"))
      .find((f) => fs.existsSync(f))!;
    return fs.readFileSync(file, "utf8");
  }

  test("/print/bill, /print/bill/settled and the split print all pass customerGstin", () => {
    const src = source();
    expect(src.match(/customerGstin:\s*bill\.customer_gstin\s*\?\?\s*null/g)).toHaveLength(3);
    // The settled reprint (and the NC settle's paper) build their options in
    // settledBillReceiptOptions; the route must hand it the settled bill.
    const settled = src.slice(src.indexOf("app.post('/print/bill/settled'"));
    expect(settled.slice(0, settled.indexOf("\n});"))).toMatch(/settledBillReceiptOptions\(bill, \{/);
    const options = src.slice(src.indexOf("export function settledBillReceiptOptions("));
    expect(options.slice(0, /\r?\n\}\r?\n/.exec(options)?.index ?? 0)).toMatch(/customerGstin:\s*bill\.customer_gstin/);
  });
});
