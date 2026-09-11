// THE SIDE DOOR — "a waiter cannot settle a bill, and can still make it vanish."
//
// ============================================================================
// WHAT WENT WRONG, AND WHY A "findsNothing" TEST WOULD NOT HAVE CAUGHT IT
// ============================================================================
// C2 put all five settle paths behind PERM_CLOSE_BILL. POST /release-table was
// not one of them, and ReleaseTable voids every active order on a table AND
// closes its open bill at total_amt = 0. Its permission — 090ea8d4, "Table
// status/occupy/release" — is held by the CORE WAITER ROLE. So a waiter could
// not settle a ₹9,000 bill for ₹9,000, and could still make the same ₹9,000
// disappear for ₹0, through a door the restriction made everybody stop looking
// at.
//
// EVERY ROUTE CASE HERE DRIVES THE SHIPPED HANDLER AND ASSERTS THE WRITE NEVER
// HAPPENS. ReleaseTable is a mock, and `expect(ReleaseTable).not.toHaveBeenCalled()`
// is the assertion that matters: a 403 body proves a message was sent, and only
// the absence of the call proves the money is still there. The mirror assertion
// — that ReleaseTable WAS called — is what stops this gate from being "fixed" by
// breaking the route for everyone.
//
// AND AN ADMIN LOSES NOTHING. Every case is run for an owner and for the people
// who run the till too. The failure to fear is not "a waiter saw a figure"; it
// is "the fix emptied the till" — or, here, "the fix meant nobody could free a
// table".

import { describe, test, expect, beforeAll, beforeEach } from "@jest/globals";
import { makeFakeApp, type FakeApp } from "./platform_fixtures";
import {
  EMPTY_RELEASE_IMPACT,
  mayReleaseTable,
  releaseIsWriteOff,
  releaseWriteOffValue,
} from "../release_authority";

// The data layer is a mock in this suite ON PURPOSE: the question is not "does
// the SQL work" (table_move.test.ts and friends cover that) but "is the write
// reached at all". A stub makes the answer unambiguous.
const ReleaseTable = jest.fn();
const GetTableReleaseImpact = jest.fn();

jest.mock("../database_supabase", () => ({
  __esModule: true,
  Audit_log_category: { Tables: "Tables", Bill: "Bill", Orders: "Orders" },
  ReleaseTable: (...a: unknown[]) => ReleaseTable(...a),
  GetTableReleaseImpact: (...a: unknown[]) => GetTableReleaseImpact(...a),
  // Everything else routes/tables.ts imports. None of it is reached by the
  // release path; they exist so the module can load.
  AddTable: jest.fn(), DeleteTableSection: jest.fn(), GetBillForTable: jest.fn(),
  GetSeatingSuggestion: jest.fn(), GetTableSections: jest.fn(), GetTableStatus: jest.fn(),
  GetTables: jest.fn(), MoveOrderToTable: jest.fn(), MoveTableParty: jest.fn(),
  OccupyTable: jest.fn(), RemoveTable: jest.fn(), RenameTableSection: jest.fn(),
  ReorderTableSections: jest.fn(), TableSectionExists: jest.fn(), UpdateTable: jest.fn(),
  UpdateTableCovers: jest.fn(), normalizeTableSection: (s: unknown) => s,
  runTenantQuery: jest.fn(), runTenantTransaction: jest.fn(),
  // log_audit (routes/_shared.ts) reaches for this; returning undefined makes it
  // throw, which the handler already catches. An audit failure must never change
  // the verdict, and this suite proves it does not.
  GetEmployeeDetailsFromEmpID: jest.fn(),
  AddAuditLogEntry: jest.fn(),
  withTenant: jest.fn(),
  GetRestaurantSettings: jest.fn(), GetRestaurantProfile: jest.fn(),
  GetTableFeedbackContext: jest.fn(), AddNotification: jest.fn(), AddCustomer: jest.fn(),
  AddEmailToCustomer: jest.fn(), GetCustomerId: jest.fn(), GetDueBookingReminders: jest.fn(),
  GetMessagingConfig: jest.fn(), GetRestaurantLogoRaw: jest.fn(), GetRestaurantAccountStatus: jest.fn(),
  GetRestaurantRazorpayKeys: jest.fn(), GetSuperadminEmployeeId: jest.fn(),
  ListBillingCounters: jest.fn(), MarkBookingReminderSent: jest.fn(),
  RecordOutboundMessage: jest.fn(), SetOrderCustomerId: jest.fn(),
  UpdateCustomerDemographics: jest.fn(), sanitizeTimezone: (t: unknown) => t,
  zonedWallToUtc: jest.fn(),
}));
jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: jest.fn(), emitOutlet: jest.fn() }));
jest.mock("../kot_move", () => ({ __esModule: true, printKotTableChange: jest.fn() }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: jest.fn() }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

const CLOSE_BILL = "a953d044-31ba-4e31-b96f-99304fe43dfa";
const TABLE_OPS = "090ea8d4-e348-4e1b-9723-11131a73a085"; // what the waiter holds
const ADD_ORDERS = "4ad474d4-5230-449c-874f-6a238b833bca";

const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";
const identity = (actions: string[], role = "waiter") => ({
  res_id: RES, outlet_id: OUTLET, employeeId: "emp-1", role, actions,
});

/** The core waiter role's real action set, near enough — it holds 090ea8d4. */
const WAITER = identity([ADD_ORDERS, TABLE_OPS, "98b10bde-802d-4a5b-a726-53a826424f79"]);
const ADMIN = identity(["*"], "admin");
const MANAGER = identity([ADD_ORDERS, TABLE_OPS, CLOSE_BILL], "manager");
const CASHIER = identity([TABLE_OPS, CLOSE_BILL], "cashier");

/** A table with ₹4,250 of unpaid orders on it. */
const OWING = { table_id: "tbl-1", open_bill_total: 4250, active_order_total: 4250, active_order_count: 3, has_open_bill: true };
/** A table nobody ordered anything at — the commonest release there is. */
const EMPTY = { table_id: "tbl-1", open_bill_total: 0, active_order_total: 0, active_order_count: 0, has_open_bill: false };

let harness: FakeApp;

const releaseRefusal = (r: { status: number; body: unknown }): boolean =>
  r.status === 403 && (r.body as { requiredPermission?: string })?.requiredPermission === CLOSE_BILL;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  const tables = await import("../routes/tables");
  harness = makeFakeApp();
  tables.registerTableRoutes(harness.app as never);
});

beforeEach(() => {
  ReleaseTable.mockReset();
  GetTableReleaseImpact.mockReset();
  ReleaseTable.mockResolvedValue({ table_id: "tbl-1", is_occupied: false });
});

const release = (auth: ReturnType<typeof identity> | undefined, table = "T7") =>
  harness.call("POST", "/release-table", { body: { table_name: table }, auth });

// ---------------------------------------------------------------------------
describe("the rule itself, without a database", () => {
  test("value, not the mere existence of a bill, is what makes a release a write-off", () => {
    expect(releaseIsWriteOff(EMPTY)).toBe(false);
    // A ₹0 bill row generated by mistake destroys nothing when it closes, and a
    // waiter stuck in front of a table they cannot free and cannot explain is a
    // worse outcome than an audit line nobody needed.
    expect(releaseIsWriteOff({ ...EMPTY, has_open_bill: true })).toBe(false);
    expect(releaseIsWriteOff(OWING)).toBe(true);
  });

  test("the value is the GREATER of the bill and the orders, never one of them", () => {
    // THE CASE THAT MADE THIS NECESSARY: orders rung up, bill row never minted.
    // resyncOpenBillTotal deliberately does not create one for a table with no
    // bill yet, so reading total_amt alone reports ₹0 for exactly the table a
    // waiter would most like to make vanish.
    expect(releaseWriteOffValue({ open_bill_total: 0, active_order_total: 4250 })).toBe(4250);
    // And the mirror: a discounted or couponed bill carries a total the raw
    // order sum does not reproduce.
    expect(releaseWriteOffValue({ open_bill_total: 3800, active_order_total: 0 })).toBe(3800);
    expect(releaseWriteOffValue(EMPTY_RELEASE_IMPACT)).toBe(0);
    // Garbage in does not become permission out.
    expect(releaseWriteOffValue(null)).toBe(0);
    expect(releaseWriteOffValue({ open_bill_total: Number.NaN, active_order_total: -5 })).toBe(0);
  });

  test("the verdict follows the CAPABILITY, never the spelling of a role", () => {
    const ask = (actions: string[]) =>
      mayReleaseTable({ actions, impact: OWING, closeBillPermission: CLOSE_BILL, tableName: "T7" });
    expect(ask([TABLE_OPS]).allowed).toBe(false);
    expect(ask([TABLE_OPS, CLOSE_BILL]).allowed).toBe(true);
    expect(ask(["*"]).allowed).toBe(true);
    // A custom role is a uuid, and the tenant that granted it Close Bill has
    // already decided this question — see enforceSettleAuthority's header.
    expect(ask(["d2b1f0c4-0000-4000-8000-000000000001", CLOSE_BILL]).allowed).toBe(true);
  });

  test("the refusal names the permission, the table and the money", () => {
    const v = mayReleaseTable({ actions: [TABLE_OPS], impact: OWING, closeBillPermission: CLOSE_BILL, tableName: "T7" });
    expect(v.allowed).toBe(false);
    expect(v.write_off_value).toBe(4250);
    expect(v.details).toContain("T7");
    expect(v.details).toContain("Close Bill");
    expect(v.details).toContain("4250.00");
  });

  test("an empty table is allowed for EVERYBODY, permission or not", () => {
    for (const actions of [[TABLE_OPS], [TABLE_OPS, CLOSE_BILL], ["*"], []]) {
      expect(mayReleaseTable({ actions, impact: EMPTY, closeBillPermission: CLOSE_BILL }).allowed).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
describe("POST /release-table — the door itself", () => {
  test("a waiter releasing a table that OWES MONEY is refused, and nothing is written", async () => {
    GetTableReleaseImpact.mockResolvedValue(OWING);
    const r = await release(WAITER);
    expect(releaseRefusal(r)).toBe(true);
    // THE ASSERTION THAT MATTERS. A 403 body proves a message was sent; only
    // this proves the bill still exists.
    expect(ReleaseTable).not.toHaveBeenCalled();
    expect((r.body as { write_off_value?: number }).write_off_value).toBe(4250);
  });

  test("…including when the money is in ORDERS and no bill row exists yet", async () => {
    // The shape that reading "Bills".total_amt alone would have reported as ₹0.
    GetTableReleaseImpact.mockResolvedValue({
      table_id: "tbl-1", open_bill_total: 0, active_order_total: 4250,
      active_order_count: 3, has_open_bill: false,
    });
    const r = await release(WAITER);
    expect(releaseRefusal(r)).toBe(true);
    expect(ReleaseTable).not.toHaveBeenCalled();
  });

  test("a waiter releasing an EMPTY table still works — seating is not broken", async () => {
    // THE OTHER HALF OF THE RULE, and the one a narrow fix gets wrong. Freeing a
    // table nobody ordered at is the commonest floor action there is; a waiter
    // who has to find a manager for it will stop freeing tables.
    GetTableReleaseImpact.mockResolvedValue(EMPTY);
    const r = await release(WAITER);
    expect(releaseRefusal(r)).toBe(false);
    expect(r.status).toBe(200);
    expect(ReleaseTable).toHaveBeenCalledWith(RES, "T7");
  });

  test("a table that does not exist is ReleaseTable's 400, not a permission answer", async () => {
    GetTableReleaseImpact.mockResolvedValue(null);
    ReleaseTable.mockRejectedValue(new Error("Table not found"));
    const r = await release(WAITER);
    expect(releaseRefusal(r)).toBe(false);
    expect(r.status).toBe(400);
  });

  test("a waiter is refused when the impact read FAILS — a gate that cannot see, refuses", async () => {
    // Failing open here would mean an unreadable "Bills" table quietly restores
    // the exact hole this suite exists to close. A refused release costs one
    // escalation; an un-refused one can cost a service's takings.
    GetTableReleaseImpact.mockRejectedValue(new Error("connection terminated unexpectedly"));
    const r = await release(WAITER);
    expect(r.status).toBe(503);
    expect(ReleaseTable).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("the people who run the till lose nothing", () => {
  for (const [who, auth] of [["an admin", ADMIN], ["a manager", MANAGER], ["a cashier", CASHIER]] as const) {
    test(`${who} releases a table that owes money`, async () => {
      GetTableReleaseImpact.mockResolvedValue(OWING);
      const r = await release(auth);
      expect(releaseRefusal(r)).toBe(false);
      expect(ReleaseTable).toHaveBeenCalledWith(RES, "T7");
    });

    test(`${who} releases an empty table`, async () => {
      GetTableReleaseImpact.mockResolvedValue(EMPTY);
      const r = await release(auth);
      expect(ReleaseTable).toHaveBeenCalledWith(RES, "T7");
    });

    test(`${who} is NOT blocked when the impact read fails — they never needed it`, async () => {
      // The asymmetry is deliberate. To somebody who may already write a bill
      // off, a failed preflight costs one line of audit detail. To everybody
      // else it is the whole gate. An owner must never be locked out of their
      // own floor by a read they did not need.
      GetTableReleaseImpact.mockRejectedValue(new Error("connection terminated unexpectedly"));
      const r = await release(auth);
      expect(r.status).toBe(200);
      expect(ReleaseTable).toHaveBeenCalledWith(RES, "T7");
    });
  }
});
