// C4 — "Hide Prices for Waiters: when a waiter is taking an order at a table,
// remove the prices from the list of ordered dishes displayed on the right side.
// Only the dish name and quantity should remain visible."
//
// ============================================================================
// WHY THIS SUITE EXISTS: THE RULE WAS DRAWN, NOT ENFORCED
// ============================================================================
// The Flutter app hides the figures with `RoleScope.showsMoney`, which is
// literally `!isWaiterOnly`. The SERVER sent every one of them to every role, so
// the restriction was worth exactly as much as the client drawing it: one
// devtools tab, one `curl` with the waiter's OWN token, or one build of the app
// from a release that predates the gate, and the table's takings are back.
//
// That is the same defect as C3's device-remembered "once" and the same defect
// as the client-side `roles.every(r => r == 'waiter')` that role_scope.ts exists
// to kill. A HIDDEN FIGURE MUST BE ABSENT, NOT MERELY UNPAINTED — so every case
// here drives the SHIPPED handler and asserts on the RESPONSE BODY, which is the
// only thing a curl can see.
//
// AND THE MIRROR HALF, in every case: a manager, cashier, captain or admin gets
// the payload they got before this existed, key for key. A redaction that costs
// the people who run the floor their numbers is not a smaller feature, it is an
// outage.
//
// ============================================================================
// THE THREE SURFACES, AND WHY ALL THREE
// ============================================================================
// A half-redacted surface is worse than none, because it teaches people the rule
// works. A table's running bill is the SUM of its active orders, so:
//
//   GET /bill-for-table   the merged running bill — the list the requirement names
//   GET /orders           the same lines again, per ticket, with their own totals
//   GET /get-tables       the same money again as table_total / table_apc, on the
//                         most-polled endpoint in the product
//
// Redacting any two of those and leaving the third is redacting nothing.

import { describe, test, expect, beforeAll, beforeEach } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFakeApp, type FakeApp } from "./platform_fixtures";
import {
  REDACTED_BILL_MONEY_KEYS,
  REDACTED_ITEM_MONEY_KEYS,
  REDACTED_ORDER_MONEY_KEYS,
  REDACTED_TABLE_ROW_MONEY_KEYS,
  hidesPrices,
  redactBillForTable,
  redactMoveAnswer,
} from "../price_scope";

const GetBillForTable = jest.fn();
const GetTables = jest.fn();
const GetOrders = jest.fn();

jest.mock("../database_supabase", () => ({
  __esModule: true,
  Audit_log_category: { Bill: "Bill", Orders: "Orders", Tables: "Tables" },
  GetBillForTable: (...a: unknown[]) => GetBillForTable(...a),
  GetTables: (...a: unknown[]) => GetTables(...a),
  GetOrders: (...a: unknown[]) => GetOrders(...a),
  // routes/tables.ts's other imports.
  AddTable: jest.fn(), DeleteTableSection: jest.fn(), GetSeatingSuggestion: jest.fn(),
  GetTableReleaseImpact: jest.fn(), GetTableSections: jest.fn(), GetTableStatus: jest.fn(),
  MoveOrderToTable: jest.fn(), MoveTableParty: jest.fn(), OccupyTable: jest.fn(),
  ReleaseTable: jest.fn(), RemoveTable: jest.fn(), RenameTableSection: jest.fn(),
  ReorderTableSections: jest.fn(), TableSectionExists: jest.fn(), UpdateTable: jest.fn(),
  UpdateTableCovers: jest.fn(), normalizeTableSection: (s: unknown) => s,
  runTenantQuery: jest.fn(), runTenantTransaction: jest.fn(),
  // routes/orders.ts's other imports.
  AddOrder: jest.fn(), AddTakeawayOrder: jest.fn(), BARK_ORDER_ACTION_ID: "bark",
  BarkOrder: jest.fn(), DeleteOrder: jest.fn(), FIRE_COURSE_ACTION_ID: "fire",
  FireOrderItems: jest.fn(), GetOrderKotContext: jest.fn(), GetOrdersScope: jest.fn(),
  IsOrderItemServed: jest.fn(), OrderTimingAction: jest.fn(), RecordOrderVoid: jest.fn(),
  SetOrderStatus: jest.fn(), UpdateOrderItemsSplit: jest.fn(), applyMenuPriceFloor: jest.fn(),
  // routes/_shared.ts's own imports.
  AddAuditLogEntry: jest.fn(), AddCustomer: jest.fn(), AddEmailToCustomer: jest.fn(),
  AddNotification: jest.fn(), GetCustomerId: jest.fn(), GetDueBookingReminders: jest.fn(),
  GetEmployeeDetailsFromEmpID: jest.fn(async () => null), GetMessagingConfig: jest.fn(),
  GetRestaurantLogoRaw: jest.fn(async () => null), GetRestaurantAccountStatus: jest.fn(),
  GetRestaurantProfile: jest.fn(async () => null), GetRestaurantRazorpayKeys: jest.fn(),
  GetRestaurantSettings: jest.fn(async () => ({ currency: "₹" })),
  GetSuperadminEmployeeId: jest.fn(), GetTableFeedbackContext: jest.fn(async () => null),
  ListBillingCounters: jest.fn(), MarkBookingReminderSent: jest.fn(),
  RecordOutboundMessage: jest.fn(), SetOrderCustomerId: jest.fn(),
  UpdateCustomerDemographics: jest.fn(), sanitizeTimezone: (t: unknown) => t,
  withTenant: jest.fn(), zonedWallToUtc: jest.fn(),
}));
jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: jest.fn(), emitOutlet: jest.fn() }));
jest.mock("../kot_move", () => ({ __esModule: true, printKotTableChange: jest.fn() }));
jest.mock("../kot_print", () => ({
  __esModule: true, autoPrintOrderKot: jest.fn(), dispatchCancellationKot: jest.fn(),
  dispatchKot: jest.fn(), logKotDispatched: jest.fn(),
}));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: jest.fn() }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

const VIEW_BILL = "98b10bde-802d-4a5b-a726-53a826424f79";
const TABLES = "090ea8d4-e348-4e1b-9723-11131a73a085";
const VIEW_ORDERS = "b7f78d0f-323d-4622-8d05-aa2f82d54b2e";
const ADD_ORDERS = "4ad474d4-5230-449c-874f-6a238b833bca";
const CLOSE_BILL = "a953d044-31ba-4e31-b96f-99304fe43dfa";

const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";

const READS = [VIEW_BILL, TABLES, VIEW_ORDERS, ADD_ORDERS];
const identity = (role: string, role_all: string[], actions: string[] = READS) => ({
  res_id: RES, outlet_id: OUTLET, employeeId: "emp-1", role, role_all, actions,
});

/** A plain waiter — the only identity C4 narrows. */
const WAITER = identity("waiter", ["waiter"]);
/**
 * THE csrorganics SHAPE. A waiter granted any custom role carries a UUID in
 * role_all, and under the old client-side `roles.every(r => r == 'waiter')` test
 * every restriction evaporated for exactly this person — including `showsMoney`,
 * which is defined as `!isWaiterOnly`. If this gate ever goes back to asking
 * about spelling, this identity walks through it.
 */
const WAITER_WITH_CUSTOM_ROLE = identity("waiter", ["waiter", "d2b1f0c4-0000-4000-8000-000000000001"]);
/** parseEmployeeRoles's fallback for a missing primary. Still a waiter. */
const WAITER_WITH_PLACEHOLDER = identity("employee", ["employee", "waiter"]);

const SENIORS = [
  ["a manager", identity("manager", ["manager"], [...READS, CLOSE_BILL])],
  ["a cashier", identity("cashier", ["cashier"], [...READS, CLOSE_BILL])],
  ["a captain", identity("captain", ["captain"], [...READS, CLOSE_BILL])],
  ["a waiter who is ALSO a manager", identity("waiter", ["waiter", "manager"], READS)],
  ["an admin", identity("admin", ["admin"], ["*"])],
] as const;

/**
 * The till's bill, with every key GetBillForTable really returns that this rule
 * has an opinion about. Written out rather than trimmed so that a field going
 * missing from the redaction list fails here rather than in a restaurant.
 */
const BILL = () => ({
  bill_id: "bill-1",
  table_id: "tbl-1",
  total_amt: 4250,
  subtotal: 4250,
  discount: 250,
  discount_type: "flat" as const,
  discount_value: 250,
  service_charge: 400,
  service_charge_percent: 10,
  service_charge_waived: false,
  service_charge_waiver: null,
  taxes: [{ name: "CGST", percentage: 2.5, amount: 100 }, { name: "SGST", percentage: 2.5, amount: 100 }],
  tax_total: 200,
  grand_total: 4600,
  nc_total: 120,
  covers: 4,
  apc: 1150,
  target_apc: 900,
  order_ids: ["ord-1"],
  kot_nos: [214],
  order_notes: ["no onions"],
  items: [
    { name: "Paneer Tikka", price: 425, quantity: 10, note: "extra spicy", variation: "Half", menu_id: "m-1" },
    { name: "Gulab Jamun", price: 60, quantity: 2 },
  ],
  apc_status: "green",
  apc_suggestions: ["Suggest a dessert"],
  payment_method: null,
  payment_status: "pending",
  screenshot_url: null,
  bill_no: "B-1",
  customer: "Anita",
  coupon_code: null,
  bill_created_at: "2026-09-11T12:00:00.000Z",
  first_order_at: "2026-09-11T12:04:00.000Z",
  service: { started_at: "2026-09-11T12:04:00.000Z", settled_at: null },
  print_count: 1,
  bill_printed_at: "2026-09-11T13:40:00.000Z",
  printed_at: "2026-09-11T13:40:00.000Z",
  // Migration 055 (client items 1 and 2): what the latest paper said. The
  // digest is the data layer's and never leaves the route; the printed total
  // is money.
  last_paper_digest: null as string | null,
  printed_total: 4600 as number | null,
  printed_as: null as string | null,
});

/**
 * What GET /bill-for-table answers a senior with: the bill as the data layer
 * read it, less the paper fingerprint it keeps to itself, plus `paper_stale`
 * (null here: this print's content was never recorded).
 */
const SENIOR_BILL = () => {
  const { last_paper_digest: _digest, ...rest } = BILL();
  void _digest;
  return { ...rest, paper_stale: null };
};

const TABLE_ROWS = () => [
  {
    table_name: "T7", capacity: 4, occupied: true, seated: true, has_order: true,
    covers: 4, payment_pending: true, table_total: 4600, table_apc: 1150, target_apc: 900,
    apc_status: "green", qr_sig: "sig", otp_required: false, order_otp: null,
    print_count: 1, bill_printed_at: "2026-09-11T13:40:00.000Z", printed_at: "2026-09-11T13:40:00.000Z",
  },
  { table_name: "T8", capacity: 2, occupied: false, table_total: 0, table_apc: 0, target_apc: 900, apc_status: "neutral", print_count: 0, bill_printed_at: null, printed_at: null },
];

const ORDER_ROWS = () => [
  {
    id: "ord-1", table: "T7", customer: "Anita", status: "Preparing",
    items: [
      { id: "li-1", name: "Paneer Tikka", quantity: 10, price: 425, orderedAt: "2026-09-11T12:04:00.000Z", note: "extra spicy", station: "tandoor", variation: "Half" },
    ],
    subtotal: 4250, total: 4600, applyServiceCharge: true, serviceChargePercentage: 10,
    taxes: [{ id: "t-1", name: "CGST", percentage: 2.5 }],
    barked_at: null, created_at: "2026-09-11T12:04:00.000Z", kot_nos: [214],
  },
];

let harness: FakeApp;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  const tables = await import("../routes/tables");
  const orders = await import("../routes/orders");
  harness = makeFakeApp();
  tables.registerTableRoutes(harness.app as never);
  tables.registerTableListRoute(harness.app as never);
  orders.registerOrderRoutes(harness.app as never);
});

beforeEach(() => {
  GetBillForTable.mockReset();
  GetTables.mockReset();
  GetOrders.mockReset();
  GetBillForTable.mockResolvedValue(BILL());
  GetTables.mockResolvedValue(TABLE_ROWS());
  GetOrders.mockResolvedValue(ORDER_ROWS());
});

const billFor = (auth: unknown) =>
  harness.call("GET", "/bill-for-table", { query: { table_name: "T7" }, auth: auth as never });
const tablesFor = (auth: unknown) => harness.call("GET", "/get-tables", { auth: auth as never });
const ordersFor = (auth: unknown) => harness.call("GET", "/orders", { auth: auth as never });

const asMap = (body: unknown): Record<string, unknown> => body as Record<string, unknown>;
const items = (body: unknown): Record<string, unknown>[] =>
  (asMap(body).items as Record<string, unknown>[]) ?? [];

// ---------------------------------------------------------------------------
describe("a waiter is not told what the table is worth — GET /bill-for-table", () => {
  test("the PRICE is gone from every ordered dish, and the dish is not", async () => {
    // The requirement, literally: "only the dish name and quantity should remain
    // visible". The note and the variation stay with them — that is the TICKET,
    // and a waiter who cannot read the ticket cannot work the table.
    const r = await billFor(WAITER);
    expect(r.status).toBe(200);
    expect(items(r.body)).toHaveLength(2);
    for (const it of items(r.body)) {
      expect(Object.prototype.hasOwnProperty.call(it, "price")).toBe(false);
    }
    expect(items(r.body)[0].name).toBe("Paneer Tikka");
    expect(items(r.body)[0].quantity).toBe(10);
    expect(items(r.body)[0].note).toBe("extra spicy");
    expect(items(r.body)[0].variation).toBe("Half");
  });

  test("THE SUM IS GONE TOO — hiding the lines and shipping their total hides nothing", async () => {
    // `RoleScope.showsMoney` takes the whole Subtotal/Discount/Service
    // charge/Tax/TOTAL PAYABLE card off a waiter's screen as a unit. A server
    // that redacted the line prices and sent grand_total would have left the
    // number the guest actually pays one curl away.
    const body = asMap((await billFor(WAITER)).body);
    for (const key of REDACTED_BILL_MONEY_KEYS) {
      expect([key, Object.prototype.hasOwnProperty.call(body, key)]).toEqual([key, false]);
    }
  });

  test("THE FALLBACK CHAIN IS CLOSED — total_amt cannot be read as the subtotal", async () => {
    // The shipped client reads `subtotal ?? total_amt` and `grand_total ??
    // total_amt`. Redacting two of the three would have published the bill under
    // the name the client falls back to, which is the failure mode that makes
    // half-redaction worse than none.
    const body = asMap((await billFor(WAITER)).body);
    expect(body.subtotal).toBeUndefined();
    expect(body.grand_total).toBeUndefined();
    expect(body.total_amt).toBeUndefined();
  });

  test("the tax AMOUNTS go and the tax RATES stay — a rate is not this table's money", async () => {
    // The percentage is printed on the guest's copy and readable from GET
    // /restaurant/settings by every role. It says what the restaurant charges,
    // not what this table owes.
    const taxes = asMap((await billFor(WAITER)).body).taxes as Record<string, unknown>[];
    expect(taxes).toHaveLength(2);
    expect(taxes[0]).toEqual({ name: "CGST", percentage: 2.5 });
    expect(asMap((await billFor(WAITER)).body).service_charge_percent).toBe(10);
  });

  test("a waiter can still see THAT the table owes money and that its bill is printed", async () => {
    // The line drawn: they see the STATE, never the AMOUNT. The figure a guest
    // is handed comes off the printed bill, which this route does not render.
    const body = asMap((await billFor(WAITER)).body);
    expect(body.payment_status).toBe("pending");
    expect(body.bill_no).toBe("B-1");
    expect(body.covers).toBe(4);
    expect(body.print_count).toBe(1);
    expect(body.bill_printed_at).toBe("2026-09-11T13:40:00.000Z");
    expect(body.printed_at).toBe("2026-09-11T13:40:00.000Z");
    expect(body.service).toEqual({ started_at: "2026-09-11T12:04:00.000Z", settled_at: null });
  });

  test("the upsell coaching survives — the app shows it to a waiter on purpose", async () => {
    // table_bill.dart's suggestion card sits OUTSIDE the money gate. "Suggest a
    // dessert" is coaching, and removing it would take away a feature rather
    // than a figure.
    const body = asMap((await billFor(WAITER)).body);
    expect(body.apc_status).toBe("green");
    expect(body.apc_suggestions).toEqual(["Suggest a dessert"]);
  });

  test("A CUSTOM ROLE DOES NOT UN-SCOPE A WAITER — the csrorganics shape", async () => {
    const body = asMap((await billFor(WAITER_WITH_CUSTOM_ROLE)).body);
    expect(body.grand_total).toBeUndefined();
    expect(items(body)[0].price).toBeUndefined();
  });

  test("the 'employee' placeholder does not un-scope a waiter either", async () => {
    const body = asMap((await billFor(WAITER_WITH_PLACEHOLDER)).body);
    expect(body.grand_total).toBeUndefined();
    expect(items(body)[0].price).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("nobody senior loses a figure they have today", () => {
  for (const [who, auth] of SENIORS) {
    test(`${who} gets the payload byte-for-byte as it was before C4`, async () => {
      const r = await billFor(auth);
      expect(r.status).toBe(200);
      // The strongest form of "a manager response must be byte-identical": the
      // whole object, not a spot check of the fields this change touched.
      expect(r.body).toEqual(SENIOR_BILL());
    });

    test(`${who} still sees the floor grid's totals and the orders feed's`, async () => {
      expect((await tablesFor(auth)).body).toEqual(TABLE_ROWS());
      expect((await ordersFor(auth)).body).toEqual(ORDER_ROWS());
    });
  }
});

// ---------------------------------------------------------------------------
describe("the floor grid carries the same money under other names — GET /get-tables", () => {
  test("table_total, table_apc and target_apc are gone for a waiter", async () => {
    // This is the most-polled endpoint in the product, so it is the easiest of
    // the three to read off the wire. Redacting /bill-for-table and leaving this
    // one would have left the running total of every table on the floor one poll
    // away.
    const rows = (await tablesFor(WAITER)).body as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      for (const key of REDACTED_TABLE_ROW_MONEY_KEYS) {
        expect([row.table_name, key, Object.prototype.hasOwnProperty.call(row, key)])
          .toEqual([row.table_name, key, false]);
      }
    }
  });

  test("the tile still says which tables are seated, owe money and are printed", async () => {
    const rows = (await tablesFor(WAITER)).body as Record<string, unknown>[];
    expect(rows[0].occupied).toBe(true);
    expect(rows[0].payment_pending).toBe(true);
    expect(rows[0].covers).toBe(4);
    expect(rows[0].apc_status).toBe("green");
    // C3's three spellings must survive C4 — the floor grid clears a printed
    // table off a waiter's view by reading exactly these.
    expect(rows[0].print_count).toBe(1);
    expect(rows[0].bill_printed_at).toBe("2026-09-11T13:40:00.000Z");
    expect(rows[0].printed_at).toBe("2026-09-11T13:40:00.000Z");
  });
});

// ---------------------------------------------------------------------------
describe("a table's bill is the sum of its orders — GET /orders", () => {
  test("the line price and the ticket's own subtotal/total are all gone", async () => {
    // Leaving this feed alone would have meant a waiter refused the prices on
    // /bill-for-table could read the same numbers, line for line, off the orders
    // grid they already have open.
    const rows = (await ordersFor(WAITER)).body as Record<string, unknown>[];
    const order = rows[0];
    for (const key of REDACTED_ORDER_MONEY_KEYS) {
      expect([key, Object.prototype.hasOwnProperty.call(order, key)]).toEqual([key, false]);
    }
    const line = (order.items as Record<string, unknown>[])[0];
    expect(Object.prototype.hasOwnProperty.call(line, "price")).toBe(false);
    expect(line.name).toBe("Paneer Tikka");
    expect(line.quantity).toBe(10);
  });

  test("THE KITCHEN HALF IS UNTOUCHED — the KDS reads this same endpoint", async () => {
    // Station, prep state, notes, variations and the KOT number are not money,
    // and a kitchen display that lost them would be a real outage produced by a
    // money rule.
    const rows = (await ordersFor(WAITER)).body as Record<string, unknown>[];
    const line = (rows[0].items as Record<string, unknown>[])[0];
    expect(line.station).toBe("tandoor");
    expect(line.variation).toBe("Half");
    expect(line.note).toBe("extra spicy");
    expect(rows[0].status).toBe("Preparing");
    expect(rows[0].kot_nos).toEqual([214]);
    // Rates and configuration are not amounts.
    expect(rows[0].serviceChargePercentage).toBe(10);
    expect(rows[0].taxes).toEqual([{ id: "t-1", name: "CGST", percentage: 2.5 }]);
  });
});

// ---------------------------------------------------------------------------
describe("the rule itself, without a route in the way", () => {
  test("hidesPrices IS isWaiterOnly — an admin wildcard is never scoped", () => {
    // One rule, one place. If this ever stops delegating, the button the client
    // hides and the field the server withholds become two rules that will drift.
    expect(hidesPrices({ role: "waiter", role_all: ["waiter"], actions: [] })).toBe(true);
    expect(hidesPrices({ role: "waiter", role_all: ["waiter", "manager"], actions: [] })).toBe(false);
    expect(hidesPrices({ role: "admin", role_all: ["admin"], actions: ["*"] })).toBe(false);
    expect(hidesPrices({ role: "waiter", role_all: ["waiter"], actions: ["*"] })).toBe(false);
  });

  test("an unreadable or absent identity is NOT scoped — a floor that cannot work is the worse outage", () => {
    expect(hidesPrices(null)).toBe(false);
    expect(hidesPrices(undefined)).toBe(false);
    expect(hidesPrices({})).toBe(false);
    expect(hidesPrices({ role: "", role_all: [], actions: [] })).toBe(false);
  });

  test("the redactor COPIES — it must never take the prices off the object the printer holds", () => {
    // GetBillForTable's result is handed to the ESC/POS renderer, the split and
    // every settle path in other handlers. A redactor that deleted keys in place
    // would eventually strip a guest's receipt, and the discovery would be on
    // paper, in a restaurant.
    const source = BILL();
    const redacted = redactBillForTable(source as unknown as Record<string, unknown>);
    expect(redacted).not.toBe(source);
    expect(source.grand_total).toBe(4600);
    expect(source.items[0].price).toBe(425);
    expect((source.taxes[0] as Record<string, unknown>).amount).toBe(100);
    expect(redacted.items).not.toBe(source.items);
  });

  test("a key the reader gains that nobody listed SURVIVES — the lists are the contract", () => {
    // Stated out loud because it is the one thing a delete-list is dishonest
    // about if it is not: a new money field added to GetBillForTable is NOT
    // redacted until somebody adds it to REDACTED_BILL_MONEY_KEYS.
    const out = redactBillForTable({ ...BILL(), tip_total: 200 } as unknown as Record<string, unknown>);
    expect(out.tip_total).toBe(200);
    expect(REDACTED_BILL_MONEY_KEYS).not.toContain("tip_total");
    expect(REDACTED_ITEM_MONEY_KEYS).toEqual(["price"]);
  });
});

// CLIENT ITEM 4, REVIEW FINDING — the two move answers carried money: the
// destination's running bill (`total_amt`) and the removal summary's prices.
describe("a move's answer, as a waiter-only session is told it", () => {
  test("the amounts go; the dishes, the ticket and the print outcome stay", () => {
    const answer = {
      success: true, order_id: "o-65", from_table: "12", to_table: "15", total_amt: 3763,
      items: [{ name: "KUNAFA BIRDS NEST", variation: null, quantity: 1 }],
      kot_no: 65, print: { printed: true, kot_no: 65, tickets: 1 },
      reprint_needed: true, reprint_table: "15", reprint_message: "Reprint 15",
    };
    const out = redactMoveAnswer(answer);
    expect(out).not.toHaveProperty("total_amt");
    const { total_amt: _gone, ...rest } = answer;
    expect(out).toEqual(rest);
    // A COPY: the audit line is written from the same object.
    expect(answer.total_amt).toBe(3763);
  });

  test("the dish move's summary loses its price, its value and each line's price", () => {
    const answer = {
      success: true,
      moved: { name: "Dal", price: 200, quantity: 2, value: 440, lines: [{ name: "Dal", price: 200, quantity: 1 }, { name: "Dal", price: 240, quantity: 1 }] },
      items: [{ name: "Dal", variation: "Half", quantity: 2 }],
      destinations: [{ order_id: "d", source_order_id: "s", kot_nos: [7], items: [] }],
      prints: [{ order_id: "d", printed: true, kot_no: 7, tickets: 1 }],
      kot_nos: [7],
    };
    const out = redactMoveAnswer(answer);
    expect(out.moved).toEqual({ name: "Dal", quantity: 2, lines: [{ name: "Dal", quantity: 1 }, { name: "Dal", quantity: 1 }] });
    expect(out.items).toBe(answer.items);
    expect(out.destinations).toBe(answer.destinations);
    expect(answer.moved.price).toBe(200);
    expect(answer.moved.lines[0]!.price).toBe(200);
  });

  test("anything that is not an answer object passes through", () => {
    expect(redactMoveAnswer(null)).toBeNull();
    expect(redactMoveAnswer([1])).toEqual([1]);
    expect(redactMoveAnswer("x")).toBe("x");
    expect(redactMoveAnswer({ moved: null })).toEqual({ moved: null });
  });

  test("both move routes redact through it for a waiter-only session (the wiring)", () => {
    const read = (rel: string): string => readFileSync(join(__dirname, "..", rel), "utf8");
    const tables = read("routes/tables.ts");
    const moveOrder = tables.slice(tables.indexOf('app.post("/tables/move-order"'));
    expect(moveOrder.slice(0, moveOrder.indexOf("\napp."))).toMatch(/res\.json\(hidesPrices\(req\.auth\) \? redactMoveAnswer\(answer\) : answer\)/);
    const bills = read("routes/bills.ts");
    const moveItem = bills.slice(bills.indexOf("app.post('/bills/move-item'"));
    expect(moveItem.slice(0, moveItem.indexOf("\napp."))).toMatch(/res\.json\(hidesPrices\(req\.auth\) \? redactMoveAnswer\(answer\) : answer\)/);
  });
});
