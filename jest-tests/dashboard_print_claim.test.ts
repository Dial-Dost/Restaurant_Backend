// C3, THE WEB DASHBOARD'S HALF — "a waiter may execute Print Bill ONCE" on the
// one client nobody had looked at.
//
// ============================================================================
// WHY THIS SUITE EXISTS: THE RULE STOPPED AT THE BROWSER
// ============================================================================
// POST /print/bill enforces the once-only rule off the durable "PrintJobs"
// ledger, and print_once_authority.test.ts pins it. The WEB DASHBOARD never
// called it: its Print Bill button renders an HTML page and calls
// `window.print()`, so the paper came out of the browser's own printer and the
// server was never told. A waiter on the dashboard therefore printed as many
// copies as they liked, and none of them existed as far as the floor tablets,
// the audit log or the next reprint check were concerned.
//
// A rule enforced on one CLIENT and not another is the same defect as a rule
// enforced on one DEVICE and not another — the defect C3 was written to end. It
// was just harder to see, because the dashboard's print works.
//
// ============================================================================
// WHAT EACH CASE PROVES
// ============================================================================
//   * the claim RECORDS — the count moves, durably, in the same ledger
//     /bill-for-table and the floor grid read;
//   * the SECOND claim by a waiter is refused, in the IDENTICAL 403 body
//     /print/bill returns, asserted field by field against the other route's
//     own answer rather than against a copy of it written here;
//   * a senior role is not refused, on either route;
//   * NOTHING REACHES A PRINTER. No dispatch, no `bill:print`, no socket emit
//     of any kind. A dashboard print that also reached the printer agent would
//     put a second, thermal copy of the guest's bill on every till bound to the
//     outlet, which is the failure this endpoint exists to avoid;
//   * the ledger row is written in a TERMINAL status, derived from migration
//     027's CHECK constraint and from the two rules that consume it, so that
//     the replay path can never hand it to a till hours later.

import { describe, test, expect, beforeAll, beforeEach } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFakeApp, type FakeApp } from "./platform_fixtures";
import { COUNTED_PRINT_JOB_STATUSES } from "../bill_print_state";

const GetBillForTable = jest.fn();
const RecordClientRenderedBillPrint = jest.fn();
const dispatchPrintJob = jest.fn();
const dispatchKot = jest.fn();
const emitRestaurant = jest.fn();
const emitOutlet = jest.fn();
const AddAuditLogEntry = jest.fn();

jest.mock("../database_supabase", () => ({
  __esModule: true,
  Audit_log_category: { Bill: "Bill", Orders: "Orders", Tables: "Tables" },
  BILL_SECTION_AXES: ["course", "seat"],
  GetBillForTable: (...a: unknown[]) => GetBillForTable(...a),
  RecordClientRenderedBillPrint: (...a: unknown[]) => RecordClientRenderedBillPrint(...a),
  GetRestaurantSettings: jest.fn(async () => ({ currency: "₹", bill_paper_width: "80mm", timezone: "Asia/Kolkata" })),
  GetRestaurantProfile: jest.fn(async () => ({ outlet_name: "Fixture", outlet_add: null, outlet_phone: null })),
  GetBillChargeConfigForTable: jest.fn(async () => ({
    taxConfig: [], scPct: 0, includeServiceCharge: false, basis: "none",
    service_charge_removed: false, service_charge_applied: false,
    service_charge_percent: 0, waiver: null,
  })),
  computeBillCharges: jest.fn(() => ({
    subtotal: 4250, discount: 0, service_charge: 0, service_charge_percent: 0,
    taxes: [], tax_total: 0, grand_total: 4250,
  })),
  AddBill: jest.fn(), AddNotification: jest.fn(), ApplyCouponToBill: jest.fn(),
  ApproveBillPaymentByAdmin: jest.fn(), CloseBillByOrder: jest.fn(),
  ConfirmBillPaymentByWaiter: jest.fn(), GetBillByOrder: jest.fn(),
  GetBillPaymentLedger: jest.fn(), GetBillTenderState: jest.fn(), GetClosedBill: jest.fn(),
  GetTipLedger: jest.fn(),
  // Returns a real record rather than null: log_audit refuses to file a line
  // it cannot attribute, so a null here would make every audit assertion below
  // pass vacuously against a route that never logged anything.
  GetEmployeeDetailsFromEmpID: jest.fn(async () => ({
    res_id: "11111111-1111-1111-1111-111111111111", emp_Fname: "Ana", emp_Lname: "K",
  })),
  GetKotTableContext: jest.fn(async () => null),
  GetOrderKotContext: jest.fn(), GetOutlets: jest.fn(), GetRestaurantRazorpayKeys: jest.fn(),
  GetTableFeedbackContext: jest.fn(async () => null), ListBillingCounters: jest.fn(), ListClosedBills: jest.fn(),
  ListOpenBills: jest.fn(), MergeTableBills: jest.fn(), MoveBillItem: jest.fn(),
  RecordBillTenders: jest.fn(), RefundBill: jest.fn(), RemoveBillItem: jest.fn(),
  ReopenBill: jest.fn(), ReplaceBill: jest.fn(), SetBillCounter: jest.fn(),
  SetBillCustomerName: jest.fn(),
  SetBillDiscountWithApproval: jest.fn(), SetBillItemNote: jest.fn(), SetBillRefundRef: jest.fn(),
  SplitBillForTable: jest.fn(), SplitBillForTableBySection: jest.fn(),
  UpdateBillStatusByOrder: jest.fn(), UpdateOrderItemsSplit: jest.fn(),
  UpsertBillingCounter: jest.fn(), VoidBillTender: jest.fn(),
  // routes/_shared.ts's own imports.
  AddAuditLogEntry: (...a: unknown[]) => AddAuditLogEntry(...a),
  AddCustomer: jest.fn(), AddEmailToCustomer: jest.fn(),
  GetCustomerId: jest.fn(), GetDueBookingReminders: jest.fn(), GetMessagingConfig: jest.fn(),
  GetRestaurantLogoRaw: jest.fn(async () => null), GetRestaurantAccountStatus: jest.fn(),
  GetSuperadminEmployeeId: jest.fn(), MarkBookingReminderSent: jest.fn(),
  RecordOutboundMessage: jest.fn(), SetOrderCustomerId: jest.fn(),
  UpdateCustomerDemographics: jest.fn(), sanitizeTimezone: (t: unknown) => t,
  withTenant: jest.fn(), zonedWallToUtc: jest.fn(),
}));
jest.mock("../print_routing", () => ({
  __esModule: true,
  dispatchPrintJob: (...a: unknown[]) => dispatchPrintJob(...a),
}));
jest.mock("../kot_print", () => ({
  __esModule: true,
  dispatchKot: (...a: unknown[]) => dispatchKot(...a),
  logKotDispatched: jest.fn(),
}));
jest.mock("../escpos", () => ({ __esModule: true, buildReceiptBase64: () => "ZXNj" }));
jest.mock("../realtime", () => ({
  __esModule: true,
  emitRestaurant: (...a: unknown[]) => emitRestaurant(...a),
  emitOutlet: (...a: unknown[]) => emitOutlet(...a),
}));
jest.mock("../print_jobs", () => ({
  __esModule: true,
  ackPrintJob: jest.fn(),
  isSchemaMissing: (err: unknown) => {
    const code = (err as { code?: unknown } | null)?.code;
    return code === "42P01" || code === "42501";
  },
  warnSchemaMissing: jest.fn(),
}));
jest.mock("../storage_bucket_supabase", () => ({ __esModule: true, uploadScreenshot: jest.fn() }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: jest.fn() }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

const ADD_ORDERS = "4ad474d4-5230-449c-874f-6a238b833bca";
const CLOSE_BILL = "a953d044-31ba-4e31-b96f-99304fe43dfa";
const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";

const identity = (role: string, role_all: string[], actions: string[] = [ADD_ORDERS]) => ({
  res_id: RES, outlet_id: OUTLET, employeeId: "emp-1", role, role_all, actions,
});

const WAITER = identity("waiter", ["waiter"]);
/** The csrorganics shape — a waiter carrying a custom role UUID. */
const WAITER_WITH_CUSTOM_ROLE = identity("waiter", ["waiter", "d2b1f0c4-0000-4000-8000-000000000001"]);
/** parseEmployeeRoles's "employee" fallback. Still a waiter. */
const WAITER_WITH_PLACEHOLDER = identity("employee", ["employee", "waiter"]);

const SENIORS = [
  ["a manager", identity("manager", ["manager"], [ADD_ORDERS, CLOSE_BILL])],
  ["a cashier", identity("cashier", ["cashier"], [ADD_ORDERS, CLOSE_BILL])],
  ["a captain", identity("captain", ["captain"], [ADD_ORDERS, CLOSE_BILL])],
  ["a waiter who is ALSO a manager", identity("waiter", ["waiter", "manager"], [ADD_ORDERS])],
  ["an admin", identity("admin", ["admin"], ["*"])],
] as const;

const PRINTED_AT = "2026-09-11T13:40:00.000Z";
const CLAIMED_AT = "2026-09-11T14:05:00.000Z";

const billWith = (printCount: number) => ({
  bill_id: "bill-1", table_id: "tbl-1", items: [{ name: "Paneer Tikka", price: 425, quantity: 10 }],
  subtotal: 4250, total_amt: 4250, covers: 4, discount_value: 0, discount_type: null,
  order_notes: [], order_ids: [], kot_nos: [], customer: null, bill_no: "B-1", coupon_code: null,
  print_count: printCount,
  bill_printed_at: printCount > 0 ? PRINTED_AT : null,
  printed_at: printCount > 0 ? PRINTED_AT : null,
});

let harness: FakeApp;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  const bills = await import("../routes/bills");
  harness = makeFakeApp();
  bills.registerBillPrintAndEditRoutes(harness.app as never);
});

beforeEach(() => {
  GetBillForTable.mockReset();
  RecordClientRenderedBillPrint.mockReset();
  dispatchPrintJob.mockReset();
  dispatchKot.mockReset();
  emitRestaurant.mockReset();
  emitOutlet.mockReset();
  AddAuditLogEntry.mockReset();
  RecordClientRenderedBillPrint.mockResolvedValue({ id: "job-claim-1", created_at: CLAIMED_AT });
  dispatchPrintJob.mockResolvedValue({ jobId: "job-1", decision: { destinationName: "Front Till" }, assignedDeviceId: "dev-1" });
  dispatchKot.mockResolvedValue({ tickets: 1, stations: ["main"], kotNo: 7, businessDay: "2026-09-11", reprint: false });
});

const claim = (auth: unknown, body: Record<string, unknown> = { table_name: "T7" }) =>
  harness.call("POST", "/print/bill/claim", { body, auth: auth as never });
const thermal = (auth: unknown, body: Record<string, unknown> = { table_name: "T7" }) =>
  harness.call("POST", "/print/bill", { body, auth: auth as never });

const isReprintRefusal = (r: { status: number; body: unknown }): boolean =>
  r.status === 403 && (r.body as { reprint_needs_senior?: boolean })?.reprint_needs_senior === true;

const asMap = (body: unknown): Record<string, unknown> => body as Record<string, unknown>;

// ---------------------------------------------------------------------------
describe("the dashboard's print becomes a fact on the server", () => {
  test("the FIRST claim is recorded in the durable ledger and the count moves", async () => {
    // The whole point. Before this route the browser printed and the backend
    // heard nothing, so print_count stayed at 0 for ever and the "once" was
    // unenforceable on this client.
    GetBillForTable.mockResolvedValue(billWith(0));
    const r = await claim(WAITER);
    expect(r.status).toBe(200);
    expect(RecordClientRenderedBillPrint).toHaveBeenCalledTimes(1);
    const [resId, job] = RecordClientRenderedBillPrint.mock.calls[0] as [string, Record<string, unknown>];
    expect(resId).toBe(RES);
    expect(job.outlet_id).toBe(OUTLET);
    // The SAME bill_id shape /print/bill writes, so a claim and a thermal print
    // of one seating land in one count rather than two.
    expect(job.bill_id).toBe("bill-1");
    expect(asMap(r.body).print_count).toBe(1);
    expect(asMap(r.body).printed_at).toBe(CLAIMED_AT);
    expect(asMap(r.body).bill_printed_at).toBe(CLAIMED_AT);
    expect(asMap(r.body).recorded).toBe(true);
    expect(asMap(r.body).jobId).toBe("job-claim-1");
  });

  test("NOTHING REACHES A PRINTER — no dispatch, no bill:print, no socket emit at all", async () => {
    // A dashboard print that also reached the printer agent would put a SECOND,
    // thermal copy of the guest's bill on every till bound to this outlet. The
    // 200 proves a message; these four assertions prove no paper.
    GetBillForTable.mockResolvedValue(billWith(0));
    await claim(WAITER);
    expect(dispatchPrintJob).not.toHaveBeenCalled();
    expect(dispatchKot).not.toHaveBeenCalled();
    expect(emitOutlet).not.toHaveBeenCalled();
    expect(emitRestaurant).not.toHaveBeenCalled();
  });

  test("the print is written to the audit log, under the same Action id /print/bill files", async () => {
    GetBillForTable.mockResolvedValue(billWith(0));
    await claim(WAITER);
    expect(AddAuditLogEntry).toHaveBeenCalled();
    const line = JSON.stringify(AddAuditLogEntry.mock.calls[0]);
    expect(line).toContain(ADD_ORDERS);
    expect(line).toContain("T7");
    expect(line).toContain("web_dashboard");
  });

  test("a table with nothing on it answers 'nothing to print', not a permission verdict", async () => {
    GetBillForTable.mockResolvedValue(null);
    const r = await claim(WAITER);
    expect(r.status).toBe(400);
    expect(RecordClientRenderedBillPrint).not.toHaveBeenCalled();
  });

  test("table_name is required — the route never guesses which table printed", async () => {
    GetBillForTable.mockResolvedValue(billWith(0));
    const r = await claim(WAITER, {});
    expect(r.status).toBe(400);
    expect(RecordClientRenderedBillPrint).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("the SECOND dashboard print is somebody else's, exactly as on a tablet", () => {
  test("a waiter's second claim is refused and NOTHING IS RECORDED", async () => {
    GetBillForTable.mockResolvedValue(billWith(1));
    const r = await claim(WAITER);
    expect(isReprintRefusal(r)).toBe(true);
    // The assertion that matters. A 403 that still wrote the row would burn the
    // waiter's attempt twice and leave the ledger describing a print nobody made.
    expect(RecordClientRenderedBillPrint).not.toHaveBeenCalled();
    expect(dispatchPrintJob).not.toHaveBeenCalled();
  });

  test("THE REFUSAL IS THE SAME OBJECT /print/bill RETURNS — not a second copy of it", async () => {
    // Asserted against the OTHER ROUTE'S OWN ANSWER rather than against a body
    // written out here, because a literal in this file would go on passing while
    // the two routes drifted. Both are produced by refuseWaiterBillReprint.
    GetBillForTable.mockResolvedValue(billWith(2));
    const viaClaim = await claim(WAITER);
    GetBillForTable.mockResolvedValue(billWith(2));
    const viaThermal = await thermal(WAITER);
    expect(viaClaim.status).toBe(viaThermal.status);
    expect(viaClaim.body).toEqual(viaThermal.body);
    const body = asMap(viaClaim.body);
    expect(body.reprint_needs_senior).toBe(true);
    expect(body.print_count).toBe(2);
    expect(body.bill_printed_at).toBe(PRINTED_AT);
    expect(body.details).toContain("manager");
    expect(body.allowed_roles).toEqual(expect.arrayContaining(["manager", "cashier", "captain", "admin"]));
  });

  test("A CUSTOM ROLE DOES NOT UN-SCOPE A WAITER — the csrorganics shape", async () => {
    GetBillForTable.mockResolvedValue(billWith(1));
    const r = await claim(WAITER_WITH_CUSTOM_ROLE);
    expect(isReprintRefusal(r)).toBe(true);
    expect(RecordClientRenderedBillPrint).not.toHaveBeenCalled();
  });

  test("the 'employee' placeholder does not un-scope a waiter either", async () => {
    GetBillForTable.mockResolvedValue(billWith(1));
    const r = await claim(WAITER_WITH_PLACEHOLDER);
    expect(isReprintRefusal(r)).toBe(true);
    expect(RecordClientRenderedBillPrint).not.toHaveBeenCalled();
  });

  test("a claim on a bill a TILL already printed is refused — one ledger, both clients", async () => {
    // The count comes off "PrintJobs", which both routes write to and both read
    // from, so a waiter cannot print once on the tablet and once on the laptop.
    GetBillForTable.mockResolvedValue(billWith(1));
    expect(isReprintRefusal(await claim(WAITER))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("nobody senior loses a reprint they have today", () => {
  for (const [who, auth] of SENIORS) {
    test(`${who} claims a bill that has already been printed five times`, async () => {
      GetBillForTable.mockResolvedValue(billWith(5));
      const r = await claim(auth);
      expect(isReprintRefusal(r)).toBe(false);
      expect(r.status).toBe(200);
      expect(RecordClientRenderedBillPrint).toHaveBeenCalledTimes(1);
      expect(asMap(r.body).print_count).toBe(6);
      // A senior's sixth print is still a BROWSER print — it must not suddenly
      // also come out of the till.
      expect(dispatchPrintJob).not.toHaveBeenCalled();
      expect(emitOutlet).not.toHaveBeenCalled();
    });
  }

  test("the thermal route is untouched by any of this — a senior still prints paper", async () => {
    GetBillForTable.mockResolvedValue(billWith(5));
    const r = await thermal(SENIORS[0][1]);
    expect(r.status).toBe(200);
    expect(dispatchPrintJob).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe("an unmigrated deployment still prints the guest's bill", () => {
  test("migration 027 missing degrades to recorded:false — it does not refuse the print", async () => {
    // A restaurant that cannot bill a table is a far worse outage than a rule
    // that is temporarily as weak as it was last week. Same posture as
    // billPrintStateForSeatings, which answers "not printed" on the same error.
    GetBillForTable.mockResolvedValue(billWith(0));
    RecordClientRenderedBillPrint.mockRejectedValue(Object.assign(new Error("relation does not exist"), { code: "42P01" }));
    const r = await claim(WAITER);
    expect(r.status).toBe(200);
    expect(asMap(r.body).recorded).toBe(false);
    expect(asMap(r.body).jobId).toBeNull();
    // NOT optimistically incremented: reporting a count the ledger does not hold
    // is how a client disables a button the server would still allow.
    expect(asMap(r.body).print_count).toBe(0);
  });

  test("a REAL failure is not swallowed into a success", async () => {
    GetBillForTable.mockResolvedValue(billWith(0));
    RecordClientRenderedBillPrint.mockRejectedValue(Object.assign(new Error("deadlock detected"), { code: "40P01" }));
    const r = await claim(WAITER);
    expect(r.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// THE LEDGER ROW IS TERMINAL — derived, not asserted against a literal.
//
// The guarantee lives in one INSERT's `status`, and it has to satisfy two rules
// that live in two other files. So this reads the CHECK constraint out of
// migration 027, the replay predicate out of ClaimPrintJobsForAgent and the
// counted set out of bill_print_state.ts, and shows that the value the shipped
// statement writes is the ONLY member of the CHECK that is both outside the
// replay set and inside the counted one. Delete 'acked' from
// COUNTED_PRINT_JOB_STATUSES, or widen the replay filter, and this fails —
// which is the point: a literal `expect("acked")` would go on passing.
describe("the claim's ledger row can never become a surprise thermal receipt", () => {
  const source = readFileSync(join(__dirname, "..", "database_supabase.ts"), "utf8");
  const insert = (() => {
    const at = source.indexOf("export async function RecordClientRenderedBillPrint(");
    expect(at).toBeGreaterThan(-1);
    const end = source.indexOf("\n// --- reading the numbers back", at);
    return source.slice(at, end === -1 ? at + 4000 : end);
  })();

  const checkStatuses = (() => {
    const migration = readFileSync(join(__dirname, "..", "migrations", "027_print_jobs.sql"), "utf8");
    const m = /CHECK \(status IN \(([^)]*)\)\)/.exec(migration);
    expect(m).not.toBeNull();
    return (m as RegExpExecArray)[1].split(",").map((s) => s.trim().replace(/'/g, ""));
  })();

  const replayStatuses = (() => {
    const at = source.indexOf("export async function ClaimPrintJobsForAgent(");
    expect(at).toBeGreaterThan(-1);
    const body = source.slice(at, at + 4000);
    const m = /status in \(([^)]*)\)/.exec(body);
    expect(m).not.toBeNull();
    return (m as RegExpExecArray)[1].split(",").map((s) => s.trim().replace(/'/g, ""));
  })();

  test("migration 027 still offers exactly one status that is terminal AND counted", () => {
    const terminalAndCounted = checkStatuses
      .filter((s) => !replayStatuses.includes(s))
      .filter((s) => COUNTED_PRINT_JOB_STATUSES.includes(s));
    expect(terminalAndCounted).toEqual(["acked"]);
  });

  test("the claim's INSERT writes that status, and an ack_result to match", () => {
    const terminalAndCounted = checkStatuses
      .filter((s) => !replayStatuses.includes(s))
      .filter((s) => COUNTED_PRINT_JOB_STATUSES.includes(s));
    expect(insert).toContain(`'${terminalAndCounted[0]}'`);
    expect(insert).toContain("'printed'");
    // Retention is measured from settled_at, and a terminal row with a null one
    // is never collected — an immortal row for every dashboard print ever made.
    expect(insert).toContain("settled_at");
  });

  test("it writes NO ESC/POS bytes — the second lock behind the status", () => {
    // There is nothing to print: the browser rendered the paper. An empty
    // payload means that even a future replay path with a widened filter could
    // only hand a till an empty document, never a copy of a guest's bill.
    expect(/values \(\$1,\$2,\$3,'bill',null,'',/.test(insert.replace(/\s+/g, " "))).toBe(true);
  });

  test("it does NOT write the statuses the replay path takes", () => {
    for (const s of replayStatuses) {
      expect([s, insert.includes(`'${s}'`)]).toEqual([s, false]);
    }
  });

  test("bill_print_state.ts still counts the status this row is written in", () => {
    // The mirror half: a row outside the counted set would increment nothing, and
    // the second dashboard print would be allowed.
    expect(COUNTED_PRINT_JOB_STATUSES).toContain("acked");
  });
});
