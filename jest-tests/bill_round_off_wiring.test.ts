// "ROUND OFF THE FINAL AMOUNT ALWAYS IN FINAL BILL" — THE WIRING (migration 048).
//
// The rounding itself is one pure function (billing_math.roundBillTotal, pinned
// in billing_math.test.ts). What can go wrong around it is all WIRING, and every
// failure is silent:
//
//   * A SETTLED-BILL READER THAT DOES NOT SELECT round_off. Everything above a
//     settled total is recovered by subtraction, so the paise land in the food
//     base — net sales, APC and GST turnover move, and past the 0.05 tolerance
//     the bill is flagged "no longer adds up" on web and app. closedBillCharges'
//     roundOff is a REQUIRED parameter so tsc names such a reader; this file pins
//     the other half, that the reader actually SELECTS the column.
//   * A SETTLE WRITER THAT DOES NOT WRITE IT, so the bill is rounded and the
//     adjustment is lost at the one moment it becomes a record.
//   * A READER OR WRITER THAT RUNS BEFORE THE COLUMN EXISTS. This code reaches
//     production before migration 048 is applied by hand, and "column round_off
//     does not exist" on the settled-bill list is the Accounting screen, the MIS
//     pack and the overview failing together. Every function that names the
//     column in SQL must await an ensure first, and the boot step must run one.
//   * A PAYLOAD THAT DROPS IT: the bill view, the guest's allowlist, the waiter
//     redaction, the paper.
//
// Source guards where the thing cannot be driven under jest, behaviour where it
// can (the settled-bill detail read, over a stubbed pg that answers round_off
// ONLY when the SQL selects it — the way Postgres would).

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redactBillForTable, REDACTED_BILL_MONEY_KEYS } from "../price_scope";
import { guestBillView } from "../guest_bill_view";

const ROOT = join(__dirname, "..");
const DB_SRC = readFileSync(join(ROOT, "database_supabase.ts"), "utf8").replace(/\r\n/g, "\n");
const BILLS_SRC = readFileSync(join(ROOT, "routes", "bills.ts"), "utf8").replace(/\r\n/g, "\n");
const INDEX_SRC = readFileSync(join(ROOT, "index.ts"), "utf8").replace(/\r\n/g, "\n");

/** Top-level function bodies of database_supabase.ts, by name. */
function functionChunks(src: string): Map<string, string> {
  const re = /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)\s*[(<]/gm;
  const starts: { name: string; at: number }[] = [];
  for (let m = re.exec(src); m; m = re.exec(src)) { starts.push({ name: m[1]!, at: m.index }); }
  const out = new Map<string, string>();
  starts.forEach((s, i) => {
    // A chunk ends at the next top-level declaration of ANY kind, so an
    // interface or const between two functions is not read as the first one's.
    const nextFn = starts[i + 1]?.at ?? src.length;
    const tail = src.slice(s.at + 1, nextFn);
    const decl = /^(?:export )?(?:interface|type|const|let|class) /m.exec(tail);
    out.set(s.name, src.slice(s.at, decl ? s.at + 1 + decl.index : nextFn));
  });
  return out;
}

/**
 * The column named IN SQL — in a select list, a coalesce, or an assignment. Not
 * a JS property read (`parseNumeric(b.round_off)`, `b.total_amt - b.round_off`),
 * which is why the select-list form insists on the comma before it.
 */
const SQL_ROUND_OFF = /(,\s*[bi]\.round_off\b|coalesce\(round_off|\bround_off\s*=\s*(\$\d+|null|case\b))/;
const ENSURE = /await ensureBill(?:WorkflowColumns|RoundOffColumn)\(/;

const CHUNKS = functionChunks(DB_SRC);

/**
 * THE ENUMERATION. Every function that names "Bills".round_off in SQL. Adding a
 * new one fails the equality below on purpose: whoever adds it has to read this
 * file, and the next test then holds them to the ensure.
 */
const ROUND_OFF_SQL_FUNCTIONS = [
  // readers
  "GetClosedBill", "ListClosedBills", // via CLOSED_BILL_SELECT
  "ListOpenBills", "getSettledBills", "GetDiscountsReport", "GetCustomerSegments",
  "GetStaffPerformance", "GetSimulationRawStats", "fetchMisBills", "GetDiscountReport",
  "GetOrderSummaryReport", "GetOverviewHeadline",
  // the four settle writers
  "ConfirmBillPaymentByWaiter", "SubmitCustomerPayment", "ApproveBillPaymentByAdmin", "FinalizeOnlinePayment",
  // every writer that rewrites total_amt as something other than a charged grand total
  "ReleaseTable", "AddOrder", "removeItemFromTableOrders", "MoveBillItem", "MergeTableBills",
  "resyncOpenBillTotal", "AddBill", "ReplaceBill", "MarkOrderItemNonChargeable", "ReverseNonChargeable",
].sort();

describe("every function that names round_off in SQL is enumerated, and ensures the column first", () => {
  test("the set of functions is exactly the reviewed list", () => {
    const found = [...CHUNKS.entries()]
      .filter(([, body]) => SQL_ROUND_OFF.test(body) || body.includes("${CLOSED_BILL_SELECT}"))
      .map(([name]) => name)
      .sort();
    expect(found).toEqual(ROUND_OFF_SQL_FUNCTIONS);
  });

  test.each(ROUND_OFF_SQL_FUNCTIONS)("%s awaits an ensure BEFORE its first round_off statement", (name) => {
    const body = CHUNKS.get(name) ?? "";
    const firstUse = Math.min(
      ...[SQL_ROUND_OFF.exec(body)?.index, body.indexOf("${CLOSED_BILL_SELECT}")]
        .filter((i): i is number => typeof i === "number" && i >= 0),
    );
    const ensure = ENSURE.exec(body);
    expect({ name, ensured: ensure !== null }).toEqual({ name, ensured: true });
    expect(ensure!.index).toBeLessThan(firstUse);
  });

  test("CLOSED_BILL_SELECT itself selects the column", () => {
    const select = /const CLOSED_BILL_SELECT = `([\s\S]*?)`;/.exec(DB_SRC)?.[1] ?? "";
    expect(select).toMatch(/\bb\.round_off\b/);
  });

  test("ensureBillWorkflowColumns awaits the round-off ensure, which issues the column exactly", () => {
    const workflow = CHUNKS.get("ensureBillWorkflowColumns") ?? "";
    expect(workflow).toMatch(/await ensureBillRoundOffColumn\(client\)/);
    const own = CHUNKS.get("ensureBillRoundOffColumn") ?? "";
    expect(own).toContain(`alter table "Bills" add column if not exists round_off numeric(12,2)`);
    // Own memo key, so the boot step and the hot writers ensure ONE statement.
    expect(own).toContain(`ensureLazyTable("Bills.round_off"`);
  });

  test("the boot step runs it before the server listens", () => {
    const boot = INDEX_SRC.indexOf("await InitBillRoundOffSchema()");
    expect(boot).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(INDEX_SRC.indexOf("httpServer.listen("));
  });

  test("if migration 048 is present, it adds the same column the runtime ensure adds", () => {
    const file = join(ROOT, "migrations", "048_bill_round_off.sql");
    if (!existsSync(file)) { return; } // shipped in its own commit, applied by hand
    expect(readFileSync(file, "utf8")).toMatch(/alter table "Bills" add column if not exists round_off numeric\(12,2\)/i);
  });
});

describe("the settle writers record the round-off beside the total they write", () => {
  test.each([
    ["ConfirmBillPaymentByWaiter", /round_off = \$10/, /charges\.round_off/],
    ["SubmitCustomerPayment", /round_off = \$8/, /\[total, taxJson, paymentMethod, screenshotUrl \|\| null, billId, context\.res_id, context\.outlet_id, round_off\]/],
    ["ApproveBillPaymentByAdmin", /round_off = \$7/, /chargesAtApproval\.round_off/],
    ["FinalizeOnlinePayment", /round_off = \$7/, /\[total, taxJson, paymentRef, billId, context\.res_id, context\.outlet_id, round_off\]/],
  ])("%s", (name, sql, param) => {
    const body = CHUNKS.get(name) ?? "";
    expect(body).toMatch(sql);
    expect(body).toMatch(param);
  });

  test("a bill closed at zero (released unpaid, merged away) clears its round-off with its total", () => {
    expect(CHUNKS.get("ReleaseTable")).toMatch(/round_off = case when admin_approved_at is null then null else round_off end/);
    expect(CHUNKS.get("MergeTableBills")).toMatch(/closed_by_username = 'merge', total_amt = 0, tax_breakdown = '\[\]'::jsonb, round_off = null/);
  });

  test("no open-bill re-sync writes total_amt without clearing round_off", () => {
    // `set total_amt = $1 where` is the pre-tax re-sync shape. Every one of them
    // must now be `set total_amt = $1, round_off = null where`.
    expect(DB_SRC.match(/set total_amt = \$1 where/g) ?? []).toEqual([]);
  });

  test("every closedBillCharges call passes the round-off (four arguments)", () => {
    const calls: string[] = [];
    const re = /(?<!function )closedBillCharges\(/g;
    for (let m = re.exec(DB_SRC); m; m = re.exec(DB_SRC)) {
      let depth = 1; let i = m.index + m[0].length; const start = i;
      while (i < DB_SRC.length && depth > 0) {
        if (DB_SRC[i] === "(") {depth += 1;} else if (DB_SRC[i] === ")") {depth -= 1;}
        i += 1;
      }
      calls.push(DB_SRC.slice(start, i - 1));
    }
    const topLevelArgs = (s: string) => {
      let depth = 0; let n = 1;
      for (const ch of s) {
        if ("([{".includes(ch)) {depth += 1;} else if (")]}".includes(ch)) {depth -= 1;} else if (ch === "," && depth === 0) {n += 1;}
      }
      return n;
    };
    expect(calls.length).toBeGreaterThanOrEqual(10);
    for (const c of calls) { expect({ call: c, args: topLevelArgs(c) }).toEqual({ call: c, args: 4 }); }
  });
});

describe("the payloads carry it", () => {
  test("GetBillForTable returns round_off beside grand_total", () => {
    const body = CHUNKS.get("GetBillForTable") ?? "";
    expect(body).toMatch(/round_off: number; grand_total: number;/);
    // Destructured from the charges AND put on the returned object — the second
    // is the one that reaches the app, the web and the Razorpay order.
    expect(body).toMatch(/\n\s+round_off,\n\s+grand_total,\n\s+\} = computeBillCharges\(/);
    expect(body).toMatch(/\n\s+round_off,\n\s+grand_total,\n\s+\/\/ Migration 034: the menu value/);
  });

  test("the guest is shown it — it is on their paper", () => {
    const view = guestBillView({
      items: [], total_amt: 4745, subtotal: 4745, discount: 0, coupon_code: null,
      service_charge: 0, service_charge_percent: 0, taxes: [], tax_total: 237.26,
      round_off: -0.26, grand_total: 4982, covers: 2, bill_no: "1", payment_method: null, payment_status: null,
    });
    expect(view.round_off).toBe(-0.26);
  });

  test("a waiter-only session is not: it is an amount", () => {
    expect(REDACTED_BILL_MONEY_KEYS).toContain("round_off");
    expect(redactBillForTable({ grand_total: 4982, round_off: -0.26, covers: 2 })).toEqual({ covers: 2 });
  });

  test("all three bill papers pass it: the open bill, the settled reprint, the split's whole bill", () => {
    expect(BILLS_SRC).toMatch(/roundOff: charges\.round_off,/);
    expect(BILLS_SRC.match(/roundOff: bill\.round_off,/g) ?? []).toHaveLength(2);
  });
});

// ============================================================================
// THE SETTLED-BILL DETAIL READ, DRIVEN
// ============================================================================

const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";
const TABLE_ID = "33333333-3333-4333-8333-333333333333";
const BILL_ID = "55555555-5555-4555-8555-555555555555";
const CLOSED_AT = new Date("2026-09-14T15:00:00.000Z");

const mockFx: { sql: string[]; roundOff: number | null } = { sql: [], roundOff: -0.26 };

jest.mock("pg", () => {
  const query = async (sql: string): Promise<{ rows: unknown[] }> => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    mockFx.sql.push(q);
    if (/from "Restaurant" r/i.test(q)) {
      return { rows: [{
        res_id: RES, outlet_id: OUTLET, restaurant_slug: "gaia", restaurant_name: "Gaia",
        restaurant_main_office_add: null, restaurant_logo_url: null, timezone: "Asia/Kolkata",
      }] };
    }
    if (/^select service_charge from "Restaurant"/i.test(q)) { return { rows: [{ service_charge: 0 }] }; }
    if (/^select b\.id, b\.bill_no, b\.status/i.test(q)) {
      return { rows: [{
        id: BILL_ID, bill_no: "5910", status: 7, reason: null, table_id: TABLE_ID, table_name: "T7",
        // The client's receipt, settled: 4745 + SGST 118.63 + CGST 118.63 = 4982.26 -> 4982.00.
        total_amt: "4982.00",
        tax_breakdown: [{ name: "SGST", percentage: 2.5, amount: 118.63 }, { name: "CGST", percentage: 2.5, amount: 118.63 }],
        // Answered ONLY when the statement selects it, as Postgres would.
        ...(/\bb\.round_off\b/.test(q) ? { round_off: mockFx.roundOff === null ? null : mockFx.roundOff.toFixed(2) } : {}),
        payment_method: "Cash", payment_splits: null, payment_proof_screenshot_url: null,
        discount_type: null, discount_value: 0, discount_applied_at: null, coupon_code: null,
        waiter_confirmed_at: CLOSED_AT, waiter_confirmed_by_username: null,
        admin_approved_at: CLOSED_AT, admin_approved_by_username: null,
        closed_at: CLOSED_AT, closed_by_username: "admin",
        refunded_at: null, refunded_by_username: null, refund_amount: 0, refund_reason: null, refund_ref: null,
        created_at: CLOSED_AT, created_by_fname: "Jim", created_by_lname: "", session_covers: 2,
        seated_at: CLOSED_AT, left_at: CLOSED_AT,
      }] };
    }
    if (/^select count\(\*\)::text as total from "Bills"/i.test(q)) { return { rows: [{ total: "1" }] }; }
    if (/as prev_closed from "Bills"/i.test(q)) { return { rows: [{ prev_closed: new Date(0) }] }; }
    if (/^select id, created_at, status, food from "Orders"/i.test(q)) {
      return { rows: [{
        id: "c1", created_at: new Date("2026-09-14T14:00:00.000Z"), status: "7",
        food: { customer: "Guest", items: [{ name: "Thali", price: 4745, quantity: 1 }], subtotal: 4745, total: 4745 },
      }] };
    }
    return { rows: [] };
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string): Promise<{ rows: unknown[] }> { return query(sql); }
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
  mockFx.sql = [];
  mockFx.roundOff = -0.26;
  db.__poolHygieneTestSeam.resetDdlMemo();
});

describe("the settled bill reads back as the food it was, with its round-off beside it", () => {
  test("GetClosedBill on Gaia's rounded bill: base 4745, round off -0.26, and it RECONCILES", async () => {
    const bill = await db.GetClosedBill(RES, BILL_ID);
    expect(bill).not.toBeNull();
    expect(bill!.grand_total).toBe(4982);
    expect(bill!.tax_total).toBe(237.26);
    expect(bill!.round_off).toBe(-0.26);
    // Without the round-off this is 4744.74, which is 0.26 off the items — past
    // the 0.05 tolerance, so the bill would be flagged as no longer adding up.
    expect(bill!.taxable_base).toBe(4745);
    expect(bill!.totals_reconciled).toBe(true);
    expect(bill!.apc).toBe(2372.5);
    expect(Math.round(bill!.taxable_base * 100) + Math.round(bill!.service_charge * 100)
      + Math.round(bill!.tax_total * 100) + Math.round(bill!.round_off * 100)).toBe(Math.round(bill!.grand_total * 100));
  });

  test("ListClosedBills agrees with the detail read", async () => {
    const page = await db.ListClosedBills(RES, { limit: 10 });
    expect(page.bills).toHaveLength(1);
    expect(page.bills[0]!.round_off).toBe(-0.26);
    expect(page.bills[0]!.taxable_base).toBe(4745);
  });

  test("a bill settled before rounding (NULL) reads exactly as it always did", async () => {
    mockFx.roundOff = null;
    const bill = await db.GetClosedBill(RES, BILL_ID);
    expect(bill!.round_off).toBe(0);
    expect(bill!.taxable_base).toBe(4744.74);
  });

  test("the column is ensured before the first statement that selects it", async () => {
    await db.GetClosedBill(RES, BILL_ID);
    const alter = mockFx.sql.findIndex((q) => /^alter table "Bills" add column if not exists round_off numeric\(12,2\)$/i.test(q));
    const select = mockFx.sql.findIndex((q) => /\bb\.round_off\b/.test(q));
    expect(alter).toBeGreaterThan(-1);
    expect(select).toBeGreaterThan(alter);
  });
});
