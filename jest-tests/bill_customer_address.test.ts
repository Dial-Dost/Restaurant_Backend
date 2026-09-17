// CLIENT ITEM 7 — THE GUEST'S ADDRESS ON A BILL, the data layer and the paper.
//
// "An option in the tables section to add the ADDRESS of a guest to the bill,
// like name and GSTIN, especially for corporate parties."
//
// ============================================================================
// WHAT EACH BLOCK PROVES
// ============================================================================
//   * THE RULE — line breaks kept, everything else tidied, blank clears, and
//     over 5 lines or 250 characters REFUSED with the one sentence (never cut).
//   * THE LIVE TABLE — every still-owing order carries the address beside the
//     name and GSTIN, the open bill row too; OMITTED touches nothing (a 2.0.1
//     till must never wipe an address a newer one saved); null clears both.
//   * THE PAST BILL — identity only. The write set is asserted statement by
//     statement and each rewritten food blob equals the original apart from the
//     three identity keys. The unchanged answer is read AFTER the commit.
//   * THE READS — the running bill and the settled detail carry
//     `customer_address` (column, then the picked orders, then the identity
//     window); the settled LIST does not, and now carries the NAME.
//   * A DATABASE WITHOUT 054 — an address write is a 503 before anything is
//     written; a name/GSTIN edit still works; a stale latch that meets a real
//     42703 degrades to the orders' copy.
//   * THE PAPER — "Address:" after the GSTIN and before the rule; the guest's
//     line breaks survive; every character prints, in order, on 48 and 32
//     columns; never on a KOT; on every split part; on the settled reprint and
//     the NC paper; and a bill WITHOUT one is byte-for-byte what 2.0.1 printed.
//   * NOT FOR THE GUEST — the QR bill (an allowlist) never carries it.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildReceiptBase64, buildSplitReceiptsBase64, type ReceiptOptions } from "../escpos";
import {
  CUSTOMER_ADDRESS_ERROR,
  CUSTOMER_ADDRESS_MAX_CHARS,
  CUSTOMER_ADDRESS_MAX_LINES,
  CUSTOMER_ADDRESS_SCHEMA_PENDING_ERROR,
  CustomerAddressInvalidError,
  CustomerAddressSchemaPendingError,
  customerAddressBillLines,
  normalizeCustomerAddress,
} from "../customer_address";
import { CUSTOMER_GSTIN_SCHEMA_PENDING_ERROR } from "../customer_gstin";
import { guestBillView } from "../guest_bill_view";
import { redactBillForTable } from "../price_scope";

const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";
const TABLE_ID = "33333333-3333-4333-8333-333333333333";
const BILL_ID = "55555555-5555-4555-8555-555555555555";
const GSTIN = "29ABCDE1234F1Z5";
const ADDRESS = "4th Floor, Prestige Tower\n12 Residency Road\nBengaluru 560025";

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const ESC = String.fromCharCode(0x1b);
const DEL = String.fromCharCode(0x7f);

interface Fx {
  sql: string[];
  gstinPresent: boolean;
  /** Does information_schema list "Bills".customer_address? */
  addressPresent: boolean;
  /** A statement naming the address column raises 42703 even though the catalogue said it exists. */
  address42703: boolean;
  liveOrders: { id: string; food: Record<string, unknown>; created_at?: Date }[];
  closedOrders: { id: string; food: Record<string, unknown>; created_at: Date; status: string }[];
  closedBill: Record<string, unknown> | null;
  storedGstin: string | null;
  storedAddress: string | null;
  /** What the list's orders statement answers, per bill id. */
  listFood: Record<string, { gstin?: string | null; customer?: string | null }>;
  orderWrites: { id: string; food: Record<string, unknown> }[];
  billWrites: { sql: string; params: unknown[] }[];
  billLocked: boolean;
}

const fx: Fx = {
  sql: [], gstinPresent: true, addressPresent: true, address42703: false, liveOrders: [], closedOrders: [],
  closedBill: null, storedGstin: null, storedAddress: null, listFood: {}, orderWrites: [], billWrites: [], billLocked: false,
};

const CLOSED_AT = new Date("2026-09-12T15:00:00.000Z");

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
  seated_at: CLOSED_AT, left_at: CLOSED_AT, round_off: 0,
});

jest.mock("pg", () => {
  const missing = (col: string) => Object.assign(new Error(`column "${col}" does not exist`), { code: "42703" });
  const query = async (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    fx.sql.push(q);
    const p = (params ?? []) as unknown[];
    if (/customer_address from "Bills"|set customer_address/i.test(q) && (!fx.addressPresent || fx.address42703)) {
      throw missing("customer_address");
    }
    if (/customer_gstin from "Bills"|set customer_gstin/i.test(q) && !fx.gstinPresent) {
      throw missing("customer_gstin");
    }
    if (/information_schema\.columns/i.test(q)) {
      if (/'customer_address'/.test(q)) { return { rows: fx.addressPresent ? [{ column_name: "customer_address" }] : [] }; }
      if (/'customer_gstin'/.test(q)) { return { rows: fx.gstinPresent ? [{ column_name: "customer_gstin" }] : [] }; }
      return { rows: [] };
    }
    if (/from "Restaurant" r/i.test(q)) {
      return { rows: [{
        res_id: RES, outlet_id: OUTLET, restaurant_slug: "gaia", restaurant_name: "Gaia",
        restaurant_main_office_add: null, restaurant_logo_url: null, timezone: "Asia/Kolkata",
      }] };
    }
    if (/^select service_charge from "Restaurant"/i.test(q)) { return { rows: [{ service_charge: 0 }] }; }
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
    if (/^select b\.id, b\.bill_no::text as bill_no, b\.table_id, t\.table_name, b\.closed_at from "Bills" b/i.test(q)) {
      return { rows: fx.closedBill ? [fx.closedBill] : [] };
    }
    if (/^select b\.id, b\.bill_no, b\.status/i.test(q)) { return { rows: fx.closedBill ? [closedBillSelectRow()] : [] }; }
    if (/^select count\(\*\)::text as total from "Bills"/i.test(q)) { return { rows: [{ total: fx.closedBill ? "1" : "0" }] }; }
    if (/as prev_closed from "Bills"/i.test(q)) { return { rows: [{ prev_closed: new Date(0) }] }; }
    if (/^select id, created_at, status, food from "Orders"/i.test(q)) {
      const statuses = (p[3] as string[]) ?? [];
      return { rows: fx.closedOrders.filter((o) => statuses.includes(o.status)) };
    }
    if (/^select id, customer_gstin from "Bills"/i.test(q)) {
      return { rows: fx.storedGstin ? [{ id: BILL_ID, customer_gstin: fx.storedGstin }] : [] };
    }
    if (/^select customer_gstin from "Bills"/i.test(q)) { return { rows: [{ customer_gstin: fx.storedGstin }] }; }
    if (/^select id, customer_address from "Bills"/i.test(q)) {
      return { rows: fx.storedAddress ? [{ id: BILL_ID, customer_address: fx.storedAddress }] : [] };
    }
    if (/^select b\.id::text as id, \(select nullif\(btrim\(o\.food::jsonb ->> 'customer_gstin'\)/i.test(q)) {
      const ids = (p[1] as string[]) ?? [];
      return { rows: ids.map((id) => ({ id, food_gstin: fx.listFood[id]?.gstin ?? null, food_customer: fx.listFood[id]?.customer ?? null })) };
    }
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
  db.resetBillCustomerAddressColumnCache();
  fx.sql = [];
  fx.gstinPresent = true;
  fx.addressPresent = true;
  fx.address42703 = false;
  fx.orderWrites = [];
  fx.billWrites = [];
  fx.billLocked = false;
  fx.storedGstin = null;
  fx.storedAddress = null;
  fx.listFood = {};
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

/** SQL statements that name the migration-054 COLUMN (not the JSON key inside food). */
const addressColumnStatements = (): string[] =>
  fx.sql.filter((q) => /customer_address from "Bills"|set customer_address/i.test(q));

// ===========================================================================
// THE RULE
// ===========================================================================
describe("address normalisation — one rule, mirrored by every client", () => {
  test("a tidy three-line address passes unchanged", () => {
    expect(normalizeCustomerAddress(ADDRESS)).toEqual({ ok: true, value: ADDRESS });
  });

  test("CRLF, CR and the Unicode line/paragraph separators all become LF", () => {
    expect(normalizeCustomerAddress("A\r\nB\rC")).toEqual({ ok: true, value: "A\nB\nC" });
    expect(normalizeCustomerAddress(`A${LS}B${PS}C`)).toEqual({ ok: true, value: "A\nB\nC" });
  });

  test("each line is trimmed, runs of spaces and tabs become one space, blank lines go", () => {
    expect(normalizeCustomerAddress("  4th  Floor,\t\tPrestige Tower  \n\n   \n12   Residency Road\n\n")).toEqual({
      ok: true, value: "4th Floor, Prestige Tower\n12 Residency Road",
    });
  });

  test("a tab between two words is a space, never a join", () => {
    expect(normalizeCustomerAddress("12\tMG Road")).toEqual({ ok: true, value: "12 MG Road" });
  });

  test("control characters are dropped (they would corrupt the printer's command stream)", () => {
    expect(normalizeCustomerAddress(`12 MG${NUL} Road${BEL}\nBengaluru${ESC}[1m${DEL}`)).toEqual({
      ok: true, value: "12 MG Road\nBengaluru[1m",
    });
  });

  test.each([[null], [undefined], [""], ["   "], ["\n\n\r\n"], [" \t "]])("%p CLEARS it", (raw) => {
    expect(normalizeCustomerAddress(raw)).toEqual({ ok: true, value: null });
  });

  test("any script is accepted as typed — the paper folds it, the store does not", () => {
    const hindi = "१२ एमजी रोड\nबेंगलुरु";
    expect(normalizeCustomerAddress(hindi)).toEqual({ ok: true, value: hindi });
  });

  test(`exactly ${CUSTOMER_ADDRESS_MAX_LINES} lines is fine; one more is REFUSED, not cut`, () => {
    const five = ["L1", "L2", "L3", "L4", "L5"].join("\n");
    expect(normalizeCustomerAddress(five)).toEqual({ ok: true, value: five });
    expect(normalizeCustomerAddress(`${five}\nL6`)).toEqual({ ok: false });
    // Blank lines are not lines.
    expect(normalizeCustomerAddress(`L1\n\n\nL2\n\nL3\nL4\n\n\nL5\n\n`)).toEqual({ ok: true, value: five });
  });

  test(`exactly ${CUSTOMER_ADDRESS_MAX_CHARS} characters (line breaks counted) is fine; one more is REFUSED`, () => {
    const line = "x".repeat(49);
    // 4 x 49, then 50, then the 4 breaks between the five lines = 250.
    const at = [line, line, line, line, `${line}x`].join("\n");
    expect(at.length).toBe(CUSTOMER_ADDRESS_MAX_CHARS);
    expect(normalizeCustomerAddress(at)).toEqual({ ok: true, value: at });
    expect(normalizeCustomerAddress(`${at}y`)).toEqual({ ok: false });
    expect(normalizeCustomerAddress("y".repeat(251))).toEqual({ ok: false });
    // Measured AFTER tidying: padding that normalisation removes does not count.
    expect(normalizeCustomerAddress(`   ${"z".repeat(250)}   \n\n`)).toEqual({ ok: true, value: "z".repeat(250) });
  });

  test.each([[12345], [true], [{ line1: "x" }], [["a", "b"]]])("a non-string %p is refused, never String()-ed onto paper", (raw) => {
    expect(normalizeCustomerAddress(raw)).toEqual({ ok: false });
  });

  test("the sentences are the contract's, verbatim — the 503 is the GSTIN's word for word", () => {
    expect(CUSTOMER_ADDRESS_ERROR).toBe("Address can be at most 5 lines and 250 characters");
    expect(CUSTOMER_ADDRESS_SCHEMA_PENDING_ERROR).toBe(CUSTOMER_GSTIN_SCHEMA_PENDING_ERROR);
    expect(new CustomerAddressInvalidError().message).toBe(CUSTOMER_ADDRESS_ERROR);
    expect(new CustomerAddressSchemaPendingError().message).toBe(CUSTOMER_ADDRESS_SCHEMA_PENDING_ERROR);
  });

  test("the paper's entries: one per stored line, only the first labelled", () => {
    expect(customerAddressBillLines(ADDRESS)).toEqual([
      "Address: 4th Floor, Prestige Tower", "12 Residency Road", "Bengaluru 560025",
    ]);
    for (const none of [null, undefined, "", "  ", "null", "undefined", "NULL"]) {
      expect(customerAddressBillLines(none)).toEqual([]);
    }
  });
});

// ===========================================================================
// THE LIVE TABLE
// ===========================================================================
describe("the running table's bill: the address rides with the name and GSTIN", () => {
  test("EVERY still-owing order carries it, and the open bill row gets it", async () => {
    const r = await db.SetBillCustomerName(RES, "T7", "Acme Pvt Ltd", GSTIN, "  4th Floor,  Prestige Tower\r\n12 Residency Road\r\nBengaluru 560025\r\n");
    expect(r).toEqual({ success: true, customer: "Acme Pvt Ltd", customer_gstin: GSTIN, customer_address: ADDRESS, orders_updated: 2 });
    expect(fx.orderWrites.map((w) => w.id).sort()).toEqual(["o1", "o2"]);
    for (const w of fx.orderWrites) {
      expect(w.food.customer_address).toBe(ADDRESS);
      expect(w.food.customer_gstin).toBe(GSTIN);
    }
    const addressWrite = fx.billWrites.find((w) => /set customer_address/.test(w.sql))!;
    expect(addressWrite.sql).toBe('update "Bills" set customer_address = $4 where table_id = $1 and res_id = $2 and outlet_id = $3 and closed_at is null');
    expect(addressWrite.params).toEqual([TABLE_ID, RES, OUTLET, ADDRESS]);
  });

  test("an address-only edit names only the address column, and moves nothing else on the orders", async () => {
    const before = fx.liveOrders.map((o) => ({ id: o.id, food: { ...o.food } }));
    await db.SetBillCustomerName(RES, "T7", "Acme", undefined, ADDRESS);
    expect(fx.billWrites.map((w) => w.sql)).toEqual([
      'update "Bills" set customer_address = $4 where table_id = $1 and res_id = $2 and outlet_id = $3 and closed_at is null',
    ]);
    for (const w of fx.orderWrites) {
      const { customer: _c, customer_address: _a, ...rest } = w.food;
      const { customer: _c0, ...restBefore } = before.find((b) => b.id === w.id)!.food;
      expect(rest).toEqual(restBefore);
    }
  });

  test("OMITTED leaves it alone — no key written, no row touched, no catalogue probe — and the answer reports what the table carries", async () => {
    fx.liveOrders = [
      { id: "o1", food: { customer: "Acme", customer_address: ADDRESS, items: [] } },
      { id: "o2", food: { customer: "Guest", items: [] } },
    ];
    const r = await db.SetBillCustomerName(RES, "T7", "Acme Pvt Ltd");
    expect(r.customer_address).toBe(ADDRESS);
    expect(fx.orderWrites.find((w) => w.id === "o1")!.food.customer_address).toBe(ADDRESS);
    expect("customer_address" in fx.orderWrites.find((w) => w.id === "o2")!.food).toBe(false);
    expect(fx.billWrites).toHaveLength(0);
    expect(fx.sql.some((q) => /information_schema/.test(q))).toBe(false);
  });

  test("an unchanged save is skipped order by order — the address is part of the comparison", async () => {
    fx.liveOrders = [
      { id: "o1", food: { customer: "Acme", customer_address: ADDRESS, items: [] } },
      { id: "o2", food: { customer: "Acme", items: [] } },
    ];
    const r = await db.SetBillCustomerName(RES, "T7", "Acme", undefined, ADDRESS);
    // o1 already says exactly this; o2 lacks the address, so only o2 is rewritten.
    expect(r.orders_updated).toBe(1);
    expect(fx.orderWrites.map((w) => w.id)).toEqual(["o2"]);
  });

  test("null and \"\" CLEAR it from every order and from the open bill row", async () => {
    for (const clear of [null, "", "  \n  "]) {
      fx.orderWrites = [];
      fx.billWrites = [];
      fx.liveOrders = [
        { id: "o1", food: { customer: "Acme", customer_address: ADDRESS, items: [] } },
        { id: "o2", food: { customer: "Acme", customer_address: ADDRESS, items: [] } },
      ];
      const r = await db.SetBillCustomerName(RES, "T7", "Acme", undefined, clear);
      expect(r.customer_address).toBeNull();
      expect(fx.orderWrites).toHaveLength(2);
      for (const w of fx.orderWrites) { expect("customer_address" in w.food).toBe(false); }
      expect(fx.billWrites[0].params[3]).toBeNull();
    }
  });

  test("an over-limit address is refused by the data layer too, before anything is written", async () => {
    await expect(db.SetBillCustomerName(RES, "T7", "Acme", undefined, "1\n2\n3\n4\n5\n6")).rejects.toThrow(CUSTOMER_ADDRESS_ERROR);
    await expect(db.SetBillCustomerName(RES, "T7", "Acme", undefined, 42 as unknown as string)).rejects.toBeInstanceOf(CustomerAddressInvalidError);
    expect(fx.orderWrites).toHaveLength(0);
    expect(fx.billWrites).toHaveLength(0);
  });

  test("a SETTLED table is still refused here — the past bill has its own door", async () => {
    fx.billLocked = true;
    await expect(db.SetBillCustomerName(RES, "T7", "Acme", undefined, ADDRESS)).rejects.toThrow(/locked/);
    expect(fx.orderWrites).toHaveLength(0);
  });
});

// ===========================================================================
// THE PAST BILL
// ===========================================================================
describe("a past (settled) bill: the address and nothing else", () => {
  test("writes it with the name and GSTIN, and answers with the contract's fields", async () => {
    const r = await db.SetClosedBillCustomerDetails(RES, BILL_ID, "Acme Pvt Ltd", GSTIN, ADDRESS);
    expect(r).toEqual({
      success: true, bill_id: BILL_ID, bill_no: "5910", table_name: "T7",
      customer: "Acme Pvt Ltd", customer_gstin: GSTIN, customer_address: ADDRESS, orders_updated: 1,
    });
    expect(fx.orderWrites[0].food.customer_address).toBe(ADDRESS);
  });

  test("MONEY, STATUS AND TIMESTAMPS ARE UNTOUCHED — exactly three statement shapes, three food keys", async () => {
    const before = JSON.parse(JSON.stringify(fx.closedOrders[0].food)) as Record<string, unknown>;
    await db.SetClosedBillCustomerDetails(RES, BILL_ID, "Acme Pvt Ltd", GSTIN, ADDRESS);
    const writes = fx.sql.filter((q) => /^(update|insert|delete)\b/i.test(q));
    expect(writes).toEqual([
      'update "Orders" set food = $4::json where id = $1 and res_id = $2 and outlet_id = $3',
      'update "Bills" set customer_gstin = $3 where id = $1 and res_id = $2',
      'update "Bills" set customer_address = $3 where id = $1 and res_id = $2',
    ]);
    for (const w of writes) {
      expect(w).not.toMatch(/total_amt|tax_breakdown|status|closed_at|admin_approved_at|waiter_confirmed_at|discount|refund|payment|round_off/i);
    }
    expect(fx.billWrites.find((w) => /customer_address/.test(w.sql))!.params).toEqual([BILL_ID, RES, ADDRESS]);
    const { customer: _c, customer_gstin: _g, customer_address: _a, ...after } = fx.orderWrites[0].food;
    const { customer: _c0, ...rest } = before;
    expect(after).toEqual(rest);
  });

  test("an address-only edit (GSTIN omitted) never names the GSTIN column", async () => {
    await db.SetClosedBillCustomerDetails(RES, BILL_ID, "Mr Sharma", undefined, ADDRESS);
    expect(fx.billWrites.map((w) => w.sql)).toEqual(['update "Bills" set customer_address = $3 where id = $1 and res_id = $2']);
    expect("customer_gstin" in fx.orderWrites[0].food).toBe(false);
  });

  test("OMITTED: no address written anywhere, and the answer is the stored one — read AFTER the commit", async () => {
    fx.storedAddress = ADDRESS;
    const r = await db.SetClosedBillCustomerDetails(RES, BILL_ID, "Acme Pvt Ltd", GSTIN);
    expect(r?.customer_address).toBe(ADDRESS);
    expect(fx.billWrites.some((w) => /customer_address/.test(w.sql))).toBe(false);
    expect("customer_address" in fx.orderWrites[0].food).toBe(false);
    const read = fx.sql.findIndex((q) => /^select id, customer_address from "Bills"/i.test(q));
    const commit = fx.sql.findIndex((q) => /^commit$/i.test(q));
    expect(commit).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(commit);
  });

  test("OMITTED with no column value: the orders' copy is the answer", async () => {
    fx.closedOrders[0].food.customer_address = ADDRESS;
    const r = await db.SetClosedBillCustomerDetails(RES, BILL_ID, "Acme Pvt Ltd");
    expect(r?.customer_address).toBe(ADDRESS);
    // …and it is carried through on the rewritten blob, not dropped.
    expect(fx.orderWrites[0].food.customer_address).toBe(ADDRESS);
  });

  test("clearing strips BOTH carriers, so the old address cannot come back from the other one", async () => {
    fx.closedOrders[0].food.customer_address = ADDRESS;
    const r = await db.SetClosedBillCustomerDetails(RES, BILL_ID, "Acme Pvt Ltd", undefined, null);
    expect(r?.customer_address).toBeNull();
    expect("customer_address" in fx.orderWrites[0].food).toBe(false);
    expect(fx.billWrites[0].params).toEqual([BILL_ID, RES, null]);
  });

  test("no settled bill with that id -> null (the route's 404); nothing written, nothing read after", async () => {
    fx.closedBill = null;
    expect(await db.SetClosedBillCustomerDetails(RES, BILL_ID, "Acme", undefined, ADDRESS)).toBeNull();
    expect(fx.orderWrites).toHaveLength(0);
    expect(fx.billWrites).toHaveLength(0);
    expect(fx.sql.some((q) => /^select id, customer_address/i.test(q))).toBe(false);
  });

  test("an over-limit address is refused before the bill is even looked up", async () => {
    await expect(db.SetClosedBillCustomerDetails(RES, BILL_ID, "Acme", undefined, "x".repeat(251))).rejects.toBeInstanceOf(CustomerAddressInvalidError);
    expect(fx.sql.filter((q) => /from "Bills"/.test(q))).toHaveLength(0);
  });
});

// ===========================================================================
// THE READS
// ===========================================================================
describe("reads carry customer_address — and the list carries the name instead", () => {
  test("GET /bill-for-table's reader: the first order that carries one, and no column statement", async () => {
    fx.liveOrders = [
      { id: "o1", food: { customer: "Acme", items: [{ name: "Paneer Tikka", price: 390, quantity: 1 }] } },
      { id: "o2", food: { customer: "Acme", customer_address: ADDRESS, items: [{ name: "Naan", price: 50, quantity: 1 }] } },
    ];
    const bill = await db.GetBillForTable(RES, "T7");
    expect(bill?.customer_address).toBe(ADDRESS);
    expect(addressColumnStatements()).toHaveLength(0);
  });

  test("…null when no order carries one, and a stray \"null\" string is none", async () => {
    expect((await db.GetBillForTable(RES, "T7"))?.customer_address).toBeNull();
    fx.liveOrders[0].food.customer_address = "null";
    expect((await db.GetBillForTable(RES, "T7"))?.customer_address).toBeNull();
  });

  test("the settled detail prefers the bill row's column", async () => {
    fx.storedAddress = ADDRESS;
    fx.closedOrders[0].food.customer_address = "Somewhere else";
    const bill = await db.GetClosedBill(RES, BILL_ID);
    expect(bill?.customer_address).toBe(ADDRESS);
    expect(bill?.customer).toBe("Mr Sharma");
  });

  test("…then the picked orders", async () => {
    fx.closedOrders[0].food.customer_address = ADDRESS;
    expect((await db.GetClosedBill(RES, BILL_ID))?.customer_address).toBe(ADDRESS);
  });

  test("…then the identity window (a released bill whose only orders are cancelled)", async () => {
    fx.closedOrders = [{
      id: "x1", created_at: new Date("2026-09-12T14:00:00.000Z"), status: "5",
      food: { customer: "Acme", customer_address: ADDRESS, items: [], subtotal: 0 },
    }];
    const bill = await db.GetClosedBill(RES, BILL_ID);
    expect(bill?.customer_address).toBe(ADDRESS);
    expect(bill?.customer).toBe("Acme");
  });

  test("the settled LIST never carries the address, but does carry the name (column GSTIN still wins)", async () => {
    fx.storedAddress = ADDRESS;
    fx.storedGstin = GSTIN;
    fx.listFood = { [BILL_ID]: { gstin: "27AAAAA0000A1Z5", customer: "Acme Pvt Ltd" } };
    const page = await db.ListClosedBills(RES, {});
    expect(page.bills[0]).not.toHaveProperty("customer_address");
    expect(page.bills[0].customer).toBe("Acme Pvt Ltd");
    expect(page.bills[0].customer_gstin).toBe(GSTIN);
    expect(addressColumnStatements()).toHaveLength(0);
    // Two statements for the page's identity, never one per bill.
    expect(fx.sql.filter((q) => /customer_gstin/.test(q) && /^select/i.test(q) && !/information_schema/.test(q))).toHaveLength(2);
  });

  test("a walk-in's list row has no name", async () => {
    fx.listFood = { [BILL_ID]: { customer: null } };
    expect((await db.ListClosedBills(RES, {})).bills[0].customer).toBeNull();
  });

  test("the list's name statement skips the placeholders in SQL, over the identity window", async () => {
    await db.ListClosedBills(RES, {});
    const stmt = fx.sql.find((q) => /as food_customer/.test(q))!;
    expect(stmt).toMatch(/not in \('', 'guest', 'qr guest', 'null', 'undefined'\)/);
    expect(stmt).toMatch(/coalesce\(o\.status::text, '1'\) = any\(\$3::text\[\]\)/);
  });

  test("C4's waiter redaction keeps it (not money: a waiter reads it on their own table)", () => {
    const out = redactBillForTable({ customer: "Acme", customer_address: ADDRESS, grand_total: 100, items: [] });
    expect(out.customer_address).toBe(ADDRESS);
  });

  test("the GUEST's QR bill never carries it — the projection is an allowlist", () => {
    const view = guestBillView({
      items: [{ name: "Naan", price: 50, quantity: 1 }], total_amt: 50, subtotal: 50, discount: 0, coupon_code: null,
      service_charge: 0, service_charge_percent: 0, taxes: [], tax_total: 0, round_off: 0, grand_total: 50, covers: 2,
      bill_no: "1", payment_method: null, payment_status: null,
      customer: "Acme", customer_gstin: GSTIN, customer_address: ADDRESS,
    } as never);
    expect(view).not.toHaveProperty("customer_address");
    expect(JSON.stringify(view)).not.toContain("Prestige");
    expect(readFileSync(join(__dirname, "..", "guest_bill_view.ts"), "utf8")).not.toMatch(/customer_address/);
  });
});

// ===========================================================================
// A DATABASE WITHOUT MIGRATION 054
// ===========================================================================
describe("migration 054 not there (42703 tolerance)", () => {
  beforeEach(() => { fx.addressPresent = false; });

  test("an address write on the live table is a 503 error BEFORE anything is written", async () => {
    const err = await db.SetBillCustomerName(RES, "T7", "Acme", GSTIN, ADDRESS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CustomerAddressSchemaPendingError);
    expect((err as Error).message).toBe(CUSTOMER_ADDRESS_SCHEMA_PENDING_ERROR);
    expect(fx.orderWrites).toHaveLength(0);
    expect(fx.billWrites).toHaveLength(0);
    expect(addressColumnStatements()).toHaveLength(0);
  });

  test("clearing is an address write too — refused, not half-done", async () => {
    await expect(db.SetBillCustomerName(RES, "T7", "Acme", undefined, null)).rejects.toBeInstanceOf(CustomerAddressSchemaPendingError);
    expect(fx.orderWrites).toHaveLength(0);
  });

  test("a name + GSTIN live edit (what every 2.0.1 till sends) still works", async () => {
    const r = await db.SetBillCustomerName(RES, "T7", "Acme", GSTIN);
    expect(r).toMatchObject({ success: true, customer: "Acme", customer_gstin: GSTIN, customer_address: null, orders_updated: 2 });
    expect(addressColumnStatements()).toHaveLength(0);
  });

  test("an address write on a past bill is refused before anything is written", async () => {
    await expect(db.SetClosedBillCustomerDetails(RES, BILL_ID, "Acme", undefined, ADDRESS)).rejects.toBeInstanceOf(CustomerAddressSchemaPendingError);
    expect(fx.orderWrites).toHaveLength(0);
    expect(fx.billWrites).toHaveLength(0);
  });

  test("a name + GSTIN past-bill edit still works, never names the column, and reports the orders' address", async () => {
    fx.closedOrders[0].food.customer_address = ADDRESS;
    const r = await db.SetClosedBillCustomerDetails(RES, BILL_ID, "Acme", GSTIN);
    expect(r).toMatchObject({ success: true, customer: "Acme", customer_gstin: GSTIN, customer_address: ADDRESS });
    expect(addressColumnStatements()).toHaveLength(0);
  });

  test("the settled detail reads without the column (the orders' copy) and the money is unmoved", async () => {
    fx.closedOrders[0].food.customer_address = ADDRESS;
    const detail = await db.GetClosedBill(RES, BILL_ID);
    expect(detail?.customer_address).toBe(ADDRESS);
    expect(detail?.grand_total).toBe(1050);
    expect(addressColumnStatements()).toHaveLength(0);
  });

  test("the latch RE-ASKS: once 054 lands, address writes work without a restart", async () => {
    await expect(db.SetBillCustomerName(RES, "T7", "Acme", undefined, ADDRESS)).rejects.toBeInstanceOf(CustomerAddressSchemaPendingError);
    fx.addressPresent = true;
    // Within the minute the answer is remembered…
    await expect(db.SetBillCustomerName(RES, "T7", "Acme", undefined, ADDRESS)).rejects.toBeInstanceOf(CustomerAddressSchemaPendingError);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 61_000;
      const r = await db.SetBillCustomerName(RES, "T7", "Acme", undefined, ADDRESS);
      expect(r.customer_address).toBe(ADDRESS);
    } finally {
      Date.now = realNow;
    }
  });

  test("a STALE 'column exists' that meets a real 42703 on read degrades instead of failing the bill", async () => {
    fx.addressPresent = true;  // the catalogue says yes…
    fx.address42703 = true;    // …the statement says no.
    fx.closedOrders[0].food.customer_address = ADDRESS;
    const detail = await db.GetClosedBill(RES, BILL_ID);
    expect(detail?.customer_address).toBe(ADDRESS);
    expect(detail?.grand_total).toBe(1050);
    // …and the latch now says absent, so the next address write refuses cleanly.
    await expect(db.SetBillCustomerName(RES, "T7", "Acme", undefined, ADDRESS)).rejects.toBeInstanceOf(CustomerAddressSchemaPendingError);
    expect(fx.orderWrites).toHaveLength(0);
  });

  test("…and a stale latch on the post-commit read of a past-bill edit costs the answer its column, not the edit", async () => {
    fx.addressPresent = true;
    fx.address42703 = true;
    fx.closedOrders[0].food.customer_address = ADDRESS;
    const r = await db.SetClosedBillCustomerDetails(RES, BILL_ID, "Acme", GSTIN);
    expect(r).toMatchObject({ success: true, customer_gstin: GSTIN, customer_address: ADDRESS });
    expect(fx.sql.some((q) => /^rollback$/i.test(q))).toBe(false);
  });
});

// ===========================================================================
// THE PAPER
// ===========================================================================
/**
 * The receipt as the paper reads it — bill_customer_gstin.test.ts's walker:
 * commands skipped, each GS v 0 raster one marker line ("<RULE>" for a rule).
 */
const printed = (b64: string): string => {
  const buf = Buffer.from(b64, "base64");
  const u16 = (at: number) => buf[at]! | (buf[at + 1]! << 8);
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    const cmd = buf[i + 1];
    if (b === 0x1b && cmd === 0x40) { i += 1; continue; }
    if (b === 0x1b && (cmd === 0x61 || cmd === 0x21 || cmd === 0x45)) { i += 2; continue; }
    if (b === 0x1d && cmd === 0x56) { i += 2; continue; }
    if (b === 0x1d && (cmd === 0x4c || cmd === 0x57)) { i += 3; continue; }
    if (b === 0x1d && cmd === 0x76 && buf[i + 2] === 0x30) {
      const widthBytes = u16(i + 4);
      const height = u16(i + 6);
      const rows = Array.from({ length: height }, (_, y) =>
        buf.subarray(i + 8 + y * widthBytes, i + 8 + (y + 1) * widthBytes));
      const inked = rows.map((r) => r.some((x) => x !== 0x00));
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

/** The golden fixture — the same bill scratchpad/u5ar/golden.mts rendered with the 2.0.1 escpos.ts. */
const golden: ReceiptOptions = {
  restaurantName: "Gaia", legalName: "Gaia Hospitality Pvt Ltd",
  address: "12 Mantri Square\n2nd Floor, Malleshwaram, Bengaluru 560003",
  phone: "080-4123 4567", gstin: "29AAAAA0000A1Z5",
  table: "21", covers: 2,
  items: [{ name: "Kronos", price: 390, quantity: 1 }, { name: "Garlic Naan", price: 60, quantity: 2 }],
  total: 510, grandTotal: 536, roundOff: 0.5, currency: "₹", kind: "bill",
  taxes: [{ name: "SGST", percentage: 2.5, amount: 12.75 }, { name: "CGST", percentage: 2.5, amount: 12.75 }],
  billNo: "5910", cashier: "JIM", printedAt: "06/09/26 21:06", kotNumbers: [214, 218],
};

/** The customer slot: from the "Name:" line to the rule that closes it. */
const slotOf = (out: string): string[] => {
  const lines = out.split("\n");
  const from = lines.findIndex((l) => /^Name:/.test(l));
  const to = lines.indexOf("<RULE>", from);
  return lines.slice(from, to + 1);
};

describe("the thermal bill prints the address in the customer slot", () => {
  test.each([[48, 44], [32, 32]])("%p columns: Name, GSTIN, then the address one line at a time, then the rule — inside the %p-cell area", (roll, area) => {
    const out = printed(buildReceiptBase64({ ...golden, customer: "Acme Pvt Ltd", customerGstin: GSTIN, customerAddress: ADDRESS }, roll));
    const slot = slotOf(out);
    expect(slot[0]).toBe("Name: Acme Pvt Ltd");
    expect(slot[1]).toBe(`Customer GSTIN: ${GSTIN}`);
    expect(slot[slot.length - 1]).toBe("<RULE>");
    const addressLines = slot.slice(2, -1);
    expect(addressLines[0]!.startsWith("Address: 4th Floor,")).toBe(true);
    // The guest's line breaks survive: each stored line starts a printed line.
    for (const stored of ["12 Residency Road", "Bengaluru 560025"]) {
      expect(addressLines).toContain(stored);
    }
    for (const l of slot) { expect(l.length).toBeLessThanOrEqual(area); }
    // Above the date block and the items, as the rest of the slot is.
    const lines = out.split("\n");
    expect(lines.indexOf("Bengaluru 560025")).toBeLessThan(lines.findIndex((l) => /Date: 06\/09\/26/.test(l)));
    expect(lines.indexOf("Bengaluru 560025")).toBeLessThan(lines.findIndex((l) => /Kronos/.test(l)));
  });

  test("with no GSTIN the address sits directly under the name", () => {
    const slot = slotOf(printed(buildReceiptBase64({ ...golden, customer: "Guest", customerAddress: "12 MG Road" })));
    expect(slot).toEqual(["Name:", "Address: 12 MG Road", "<RULE>"]);
  });

  test.each([48, 32])("NEVER CUT (%p columns): every character prints, in order — long words, a 60-char token, folded punctuation", (roll) => {
    const hostile = [
      "Flat 1204, Tower B, Brigade Metropolis Whitefield Main Road",
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz01234567",
      "Café Road – Near Old Airport",
      "Bengaluru, Karnataka 560048, India",
    ].join("\n");
    expect(normalizeCustomerAddress(hostile)).toEqual({ ok: true, value: hostile });
    const out = printed(buildReceiptBase64({ ...golden, customer: "Acme", customerAddress: hostile }, roll));
    const slot = slotOf(out).slice(1, -1);
    const squash = (s: string) => s.replace(/\s+/g, "");
    expect(squash(slot.join(""))).toBe(squash(`Address: ${hostile.replace("é", "e").replace("–", "-")}`));
    // The 60-character token is hard-split across lines, not dropped.
    expect(slot.join("")).toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz01234567");
    expect(slot.some((l) => l.length === (roll === 48 ? 44 : 32) && /^[A-Za-z]+$/.test(l))).toBe(true);
  });

  test("a script the printer cannot draw is folded to '?' like every other field, never dropped", () => {
    const slot = slotOf(printed(buildReceiptBase64({ ...golden, customer: "Acme", customerAddress: "१२ MG Road" })));
    expect(slot[1]).toBe("Address: ?? MG Road");
  });

  test("escpos.ts's own split IS customerAddressBillLines (the rule is spelled out there, held together here)", () => {
    for (const address of [ADDRESS, "One line", "  A  \n\n B \nC", "X\r\nY"]) {
      const slot = slotOf(printed(buildReceiptBase64({ ...golden, customer: "Acme", customerAddress: address }, 48)));
      expect(slot.slice(1, -1)).toEqual(customerAddressBillLines(address));
    }
  });

  test("the KOT never carries it", () => {
    const withAddress = buildReceiptBase64({ ...golden, kind: "kot", customer: "Acme", customerGstin: GSTIN, customerAddress: ADDRESS, station: null });
    const without = buildReceiptBase64({ ...golden, kind: "kot", customer: "Acme", customerGstin: GSTIN, station: null });
    expect(withAddress).toBe(without);
    expect(printed(withAddress)).not.toMatch(/Prestige|Address:/);
  });

  test("every part of a split bill carries it (the bill's identity, not a part's)", () => {
    const parts = buildSplitReceiptsBase64({ ...golden, customer: "Acme", customerGstin: GSTIN, customerAddress: ADDRESS }, [
      { key: "a", label: "A", subtotal: 390, grand_total: 410, items: [{ name: "Kronos", price: 390, quantity: 1 }] },
      { key: "b", label: "B", subtotal: 120, grand_total: 126, items: [{ name: "Garlic Naan", price: 60, quantity: 2 }] },
    ], 48);
    expect(parts).toHaveLength(2);
    for (const p of parts) { expect(slotOf(printed(p.escBase64)).slice(2, -1)).toEqual(customerAddressBillLines(ADDRESS)); }
  });

  test.each([null, undefined, "", "   ", "null", "undefined"])("an address of %p prints nothing — byte-identical to none at all", (none) => {
    const base = buildReceiptBase64({ ...golden, customer: "Acme", customerGstin: GSTIN });
    expect(buildReceiptBase64({ ...golden, customer: "Acme", customerGstin: GSTIN, customerAddress: none as string | null | undefined })).toBe(base);
  });

  describe("A BILL WITHOUT AN ADDRESS IS THE BILL 2.0.1 PRINTED (sha256 of the 2.0.1 renderer's bytes)", () => {
    const sha = (b64: string) => createHash("sha256").update(b64).digest("hex");
    const splitParts = (w: number) => buildSplitReceiptsBase64({ ...golden, customer: "Acme Pvt Ltd", customerGstin: GSTIN }, [
      { key: "a", label: "A", subtotal: 390, grand_total: 410, items: [{ name: "Kronos", price: 390, quantity: 1 }] },
      { key: "b", label: "B", subtotal: 120, grand_total: 126, items: [{ name: "Garlic Naan", price: 60, quantity: 2 }] },
    ], w).map((p) => p.escBase64).join("|");
    test.each([
      ["named, 80mm", () => buildReceiptBase64({ ...golden, customer: "Acme Pvt Ltd", customerGstin: GSTIN }, 48), "2244b08eba504a379327eeddb6f38264e058f9fcf25674bf22cb3ded120b2c07"],
      ["walk-in, 80mm", () => buildReceiptBase64({ ...golden, customer: "Guest" }, 48), "2c682b2bf963c302bf4f282ed00320680d6e2172ec2dc5065b76ca66507eb800"],
      ["reprint, 80mm", () => buildReceiptBase64({ ...golden, customer: "Acme Pvt Ltd", reprint: true }, 48), "11ed176de1004df8400bcbfd7f8f91265d8f01fb5509d202186eed6781b411ea"],
      ["split, 80mm", () => splitParts(48), "369cf572e2e917c3252cf91d6fa530761cc6f9696e634877e8d4db3e68d5cead"],
      ["named, 58mm", () => buildReceiptBase64({ ...golden, customer: "Acme Pvt Ltd", customerGstin: GSTIN }, 32), "d72b5f188ada8adaab44081531db2d1c1866b11994ca808b96286b81a9c2d55f"],
      ["walk-in, 58mm", () => buildReceiptBase64({ ...golden, customer: "Guest" }, 32), "ab3a178dabf956e0c67b841f404b14d8622ee07df3b7279768cbd2118784f20b"],
      ["reprint, 58mm", () => buildReceiptBase64({ ...golden, customer: "Acme Pvt Ltd", reprint: true }, 32), "4bc3cd04361ce3fb1f7fe23fe6a6d83c7a37deefcef29d8e7839f31e82ec8451"],
      ["split, 58mm", () => splitParts(32), "e8c42ec75fae2f80cce196745cf9ebc1b51026d28a7c250ac2a99abaf8447318"],
    ])("%s", (_label, render, expected) => {
      expect(sha(render())).toBe(expected);
    });
  });
});

describe("every bill print path hands the address to the renderer", () => {
  const source = (rel: string): string => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

  test("/print/bill, the settled reprint / NC paper builder and the split print all pass customerAddress", () => {
    const src = source(join("routes", "bills.ts"));
    expect(src.match(/customerAddress:\s*bill\.customer_address\s*\?\?\s*null/g)).toHaveLength(3);
    const options = src.slice(src.indexOf("export function settledBillReceiptOptions("));
    expect(options.slice(0, options.indexOf("\n}\n"))).toMatch(/customerAddress:\s*bill\.customer_address\s*\?\?\s*null/);
    const open = src.slice(src.indexOf("export async function printOpenTableBill("));
    expect(open.slice(0, open.indexOf("\n}\n"))).toMatch(/customerAddress:\s*bill\.customer_address\s*\?\?\s*null/);
    const split = src.slice(src.indexOf("buildSplitReceiptsBase64({"));
    expect(split.slice(0, split.indexOf("}, parts"))).toMatch(/customerAddress:\s*bill\.customer_address\s*\?\?\s*null/);
  });

  test("the settled detail reads the column (built AND called), and the NC settle prints through the same builder", () => {
    const dbSrc = source("database_supabase.ts");
    const detail = dbSrc.slice(dbSrc.indexOf("export async function GetClosedBill("));
    expect(detail.slice(0, detail.indexOf("\n}\n"))).toMatch(/readBillCustomerAddresses\(context, \[row\.id\]\)/);
    expect(source(join("routes", "nc_settle.ts"))).toMatch(/settledBillReceiptOptions\(bill, \{/);
  });
});

describe("the settled reprint and the NC paper print it (settledBillReceiptOptions, for real)", () => {
  const settings = { currency: "₹", bill_paper_width: "80mm", timezone: "Asia/Kolkata" } as never;
  const profile = { outlet_name: "Gaia", outlet_add: null, outlet_phone: null } as never;

  test("the reprint of a settled bill with an address carries the slot under the REPRINT banner", async () => {
    fx.storedAddress = ADDRESS;
    fx.storedGstin = GSTIN;
    const { settledBillReceiptOptions } = await import("../routes/bills");
    const bill = (await db.GetClosedBill(RES, BILL_ID))!;
    const out = printed(buildReceiptBase64(settledBillReceiptOptions(bill, { settings, profile, logo: null, reprint: true }), 48));
    expect(out).toContain("REPRINT");
    expect(slotOf(out)).toEqual(["Name: Mr Sharma", `Customer GSTIN: ${GSTIN}`, ...customerAddressBillLines(ADDRESS), "<RULE>"]);
  });

  test("…and the NC paper (the same builder, settlement given) carries it too", async () => {
    fx.closedOrders[0].food.customer_address = "12 MG Road";
    const { settledBillReceiptOptions } = await import("../routes/bills");
    const bill = (await db.GetClosedBill(RES, BILL_ID))!;
    const out = printed(buildReceiptBase64(settledBillReceiptOptions(bill, {
      settings, profile, logo: null, reprint: false,
      settlement: { kind: "Complimentary", authorisedBy: "manager01", wouldHaveCharged: 1050 },
    }), 48));
    expect(slotOf(out)).toEqual(["Name: Mr Sharma", "Address: 12 MG Road", "<RULE>"]);
  });
});
