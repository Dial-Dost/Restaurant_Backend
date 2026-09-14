// THE GRAND TOTAL ON THE PAPER IS THE GRAND TOTAL THE GUEST IS CHARGED.
//
// That one sentence is this whole file. Everything below exists because it was
// FALSE on the shipped code, in the shape most tenants are on, by ₹549.90 on a
// ₹5,499 bill.
//
// THE FAILURE, NAMED. /print/bill accepts `no_service_charge`. After F2 that flag
// correctly removes BOTH legs of the service charge from the PRINTED ladder — the
// tax line and the "Restaurant".service_charge percent. No settle path has ever
// heard of it: ConfirmBillPaymentByWaiter, ApproveBillPaymentByAdmin and the two
// customer-payment paths all resolve their charge through
// `openBillChargeConfig(context, tableId, client)` with NO options, so they price
// the bill WITH the charge. On the shipped seed's tax shape at 10%:
//
//     subtotal 5499  ->  the guest is CHARGED   6323.84
//                        the guest is HANDED    5773.94
//
// (Both figures are whole rupees since migration 048 — 6324.00 and 5774.00, with
// round-offs of +0.16 and +0.06 — and the round-off is a second number the paper
// and the drawer must agree on; see "the round-off is the drawer's".)
//
// It was already true for restaurant_percent tenants before F2; F2 extended it to
// tax_line tenants, which is the seeded shape (migrations/000_base_schema.sql:266)
// and therefore most of them. A guest holding a bill for less than the till took
// is the worst outcome this system has: it is a wrong number, it is on a tax
// document, and nobody finds out until the guest is at the counter.
//
// THE RESOLUTION THIS FILE PINS — option (ii). `no_service_charge` stops being a
// way to reduce a total. The ONE way the charge comes off a bill is the recorded
// waiver (migration 036): quoteServiceChargeWaiver prices it, "ServiceChargeWaivers"
// records who allowed it and why, and openBillChargeConfig honours it on EVERY
// read — the bill view, the print and the settle alike. A waived bill therefore
// prints less AND charges less AND says who allowed it. An un-waived bill prints
// what the guest owes, and the flag becomes what its name says only on a bill that
// already carries a waiver.
//
// WHY THE ROUTE AND NOT THE MATH. billing_math's two-leg removal is proved to the
// paisa in service_charge_off.test.ts beside this. What broke real money is the
// WIRING: which of the two doors to "without the charge" the PRINT route opens,
// and whether the SETTLE side can see through it. So this registers the REAL
// /print/bill handler from routes/bills.ts, keeps the REAL charge resolver
// (GetBillChargeConfigForTable -> openBillChargeConfig -> resolveServiceChargeConfig)
// and the REAL computeBillCharges, and stubs only the reads either side of them.
//
// THE ONE THING HERE THAT IS A MIRROR RATHER THAN THE SHIPPED CODE is the drawer
// total: settle computes it deep inside a transaction in database_supabase.ts and
// standing that up would be a fixture larger than the thing it tests. So
// `drawerGrandTotal()` below makes the SAME four-argument call the three settle
// sites make, off the SAME resolver, and a source guard at the bottom of this file
// pins the only property of those sites that this mirror depends on: that none of
// them asks for the charge off at compute time. If that guard ever fails, this
// mirror has stopped being one and the equality above proves nothing.
//
// `pg` is a fixture pool that THROWS on any query it does not recognise, so a path
// that starts reading something new fails loudly here instead of silently
// receiving no rows.

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// --- the tenant the fixture pool serves --------------------------------------
//
// `mock`-prefixed because jest hoists the jest.mock factories below above these
// declarations; the factories only READ them when a handler calls, by which time
// the module body has finished.

const mockIds = {
  res: "11111111-1111-4111-8111-111111111111",
  outlet: "22222222-2222-4222-8222-222222222222",
  table: "33333333-3333-4333-8333-333333333333",
  bill: "44444444-4444-4444-8444-444444444444",
};

/** Everything about this tenant that the charge resolver can see. */
const mockDb: {
  /** Outlets.default_tax, verbatim. May carry the charge as a tax line (shape b). */
  taxConfig: Record<string, number> | null;
  /** "Restaurant".service_charge — the percent leg (shape a). */
  scPct: number;
  /** A LIVE row in "ServiceChargeWaivers" for this table's open bill, or none. */
  waiver: Record<string, unknown> | null;
  /** The table's pre-tax subtotal. The same number both ladders are built on. */
  subtotal: number;
  /** The open bill's discount, as both ladders read it. */
  discount: { type: "percent" | "flat"; value: number } | null;
} = { taxConfig: null, scPct: 0, waiver: null, subtotal: 0, discount: null };

/** Every AddAuditLogEntry the print made, so "a manager can see it" is testable. */
const mockAudit: unknown[][] = [];
/** Every ReceiptOptions handed to the ESC/POS renderer. THIS IS THE PAPER. */
const mockReceipts: Record<string, unknown>[] = [];

jest.mock("pg", () => {
  const answer = (sql: string): unknown[] => {
    const q = String(sql);
    // Order matters: the two "Restaurant" queries and the two "Outlets" queries
    // are distinguished by their select list, so the narrow markers come first.
    if (q.includes('select default_tax from "Outlets"')) {
      return [{ default_tax: mockDb.taxConfig }];
    }
    if (q.includes('select service_charge from "Restaurant"')) {
      return [{ service_charge: mockDb.scPct }];
    }
    if (q.includes('from "Restaurant" r')) {
      return [{
        res_id: mockIds.res, outlet_id: mockIds.outlet,
        restaurant_slug: "fixture", restaurant_name: "Fixture Diner",
        restaurant_main_office_add: null, restaurant_logo_url: null,
        timezone: "Asia/Kolkata",
      }];
    }
    if (q.includes('from "Tables"')) { return [{ id: mockIds.table }]; }
    if (q.includes('from "Bills"')) { return [{ id: mockIds.bill }]; }
    if (q.includes('from "ServiceChargeWaivers"')) {
      return mockDb.waiver ? [mockDb.waiver] : [];
    }
    throw new Error(`paper_equals_drawer fixture: no answer for: ${q.replace(/\s+/g, " ").trim().slice(0, 140)}`);
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string): Promise<{ rows: unknown[] }> {
      return Promise.resolve({ rows: answer(sql) });
    }
    connect(): Promise<never> {
      return Promise.reject(new Error("paper_equals_drawer fixture: pool.connect() is not stubbed"));
    }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

jest.mock("../../database_supabase", () => {
  const actual = jest.requireActual("../../database_supabase") as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    // GetBillChargeConfigForTable and computeBillCharges are DELIBERATELY NOT
    // overridden: they are the code under test.
    //
    // The bill the printer renders. `subtotal` and the discount are the fixture's
    // own, so both ladders are built on one base and the only thing that can
    // separate them is the service charge — which is the whole question here.
    GetBillForTable: () => Promise.resolve({
      bill_id: mockIds.bill,
      table_id: mockIds.table,
      total_amt: mockDb.subtotal,
      subtotal: mockDb.subtotal,
      discount_type: mockDb.discount?.type ?? null,
      discount_value: mockDb.discount?.value ?? 0,
      items: [{ name: "Dal Makhani", price: mockDb.subtotal, quantity: 1 }],
      covers: 2,
      customer: null,
      bill_no: "B-1",
      coupon_code: null,
      order_notes: [] as string[],
    }),
    GetRestaurantSettings: () => Promise.resolve({
      currency: "₹", bill_paper_width: "80mm", timezone: "Asia/Kolkata",
    }),
    GetRestaurantProfile: () => Promise.resolve({
      outlet_name: "Fixture Diner", outlet_add: null, outlet_phone: null,
    }),
    // The feedback QR and the logo are not money; they are stubbed to nothing so
    // the fixture pool is never asked a question this file does not care about.
    GetTableFeedbackContext: () => Promise.resolve(null),
    GetRestaurantLogoRaw: () => Promise.resolve(null),
    GetEmployeeDetailsFromEmpID: () => Promise.resolve({
      id: "emp-1", res_id: mockIds.res, outlet_id: mockIds.outlet,
      username: "cashier1", emp_Fname: "Cashier", emp_Lname: "One",
    }),
    AddAuditLogEntry: (...args: unknown[]) => { mockAudit.push(args); return Promise.resolve(undefined); },
  };
});

jest.mock("../../escpos", () => {
  const actual = jest.requireActual("../../escpos") as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    // The renderer is not under test; WHAT IT IS HANDED is. `grandTotal` is the
    // number that gets printed in the largest type on the paper.
    buildReceiptBase64: (opts: Record<string, unknown>) => { mockReceipts.push(opts); return "RVND"; },
  };
});

jest.mock("../../print_routing", () => ({
  __esModule: true,
  dispatchPrintJob: () => Promise.resolve({
    jobId: "job-1", decision: { destinationName: "Counter" }, assignedDeviceId: null,
  }),
}));

// --- the fake Express app (same harness as tender_routes.test.ts) -------------

type Next = (err?: unknown) => void;
type Handler = (req: any, res: any, next: Next) => unknown;
interface Registered { method: string; path: string; handlers: Handler[] }
interface Answer { status: number; body: any }

const registered: Registered[] = [];
const record = (method: string) => (path: string, ...handlers: Handler[]): unknown => {
  registered.push({ method, path, handlers });
  return fakeApp;
};
const fakeApp = {
  get: record("GET"), post: record("POST"), put: record("PUT"),
  patch: record("PATCH"), delete: record("DELETE"), use: (): unknown => fakeApp,
};

const AUTH = {
  res_id: mockIds.res, outlet_id: mockIds.outlet,
  employeeId: "3f3f3f3f-1111-4111-8111-3f3f3f3f3f3f",
  employeeUsername: "cashier1", role: "admin", actions: ["*"],
};
const TABLE_NAME = "T1";

async function call(method: string, path: string, body: unknown): Promise<Answer> {
  const route = registered.find((r) => r.method === method && r.path === path);
  if (!route) { throw new Error(`no route registered for ${method} ${path}`); }
  const out: Answer = { status: 200, body: undefined };
  let ended = false;
  const res = {
    status(code: number) { out.status = code; return res; },
    json(payload: unknown) { if (!ended) { out.body = payload; ended = true; } return res; },
    send(payload: unknown) { if (!ended) { out.body = payload; ended = true; } return res; },
    setHeader() { return res; },
    end() { ended = true; return res; },
  };
  const req = { params: {}, body: body ?? {}, query: {}, headers: {}, auth: AUTH };
  for (const h of route.handlers) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (ended || !advanced) { break; }
  }
  return out;
}

// --- THE PAPER and THE DRAWER ------------------------------------------------

/**
 * THE PAPER. Drives the real /print/bill handler and returns the grand total it
 * handed the ESC/POS renderer — the number the guest reads.
 */
async function printedBill(body: Record<string, unknown>): Promise<{ answer: Answer; grandTotal: number; roundOff: number; receipt: Record<string, unknown> }> {
  mockReceipts.length = 0;
  mockAudit.length = 0;
  const answer = await call("POST", "/print/bill", { table_name: TABLE_NAME, ...body });
  if (answer.status !== 200) {
    throw new Error(`/print/bill refused the print: ${answer.status} ${JSON.stringify(answer.body)}`);
  }
  const receipt = mockReceipts[0];
  if (!receipt) { throw new Error("/print/bill rendered no receipt"); }
  // `roundOff` is what the renderer prints as "Round off" above the total
  // (migration 048). Absent is treated as 0, which is also what it prints.
  return { answer, grandTotal: Number(receipt.grandTotal), roundOff: Number(receipt.roundOff ?? 0), receipt };
}

/**
 * THE DRAWER. The grand total the guest is CHARGED.
 *
 * This is the mirror described in the file header: the same four-argument
 * computeBillCharges call that ConfirmBillPaymentByWaiter (database_supabase.ts,
 * "Snapshot the charged grand total"), ApproveBillPaymentByAdmin ("Re-price at
 * approval time") and the two customer-payment paths all make, off the SAME
 * resolver. GetBillChargeConfigForTable with NO options is documented as, and is,
 * the addressed-by-name form of `openBillChargeConfig(context, tableId, client)`
 * — which is exactly what those sites call. The source guard at the bottom of
 * this file is what keeps that true.
 */
async function drawerCharges(): Promise<ReturnType<typeof import("../../billing_math").computeBillCharges>> {
  const db = await import("../../database_supabase");
  const cfg = await db.GetBillChargeConfigForTable(mockIds.res, TABLE_NAME);
  return db.computeBillCharges(
    mockDb.subtotal, cfg.taxConfig, cfg.scPct, cfg.includeServiceCharge,
    mockDb.discount ?? undefined,
  );
}
async function drawerGrandTotal(): Promise<number> {
  return (await drawerCharges()).grand_total;
}

// --- THE THREE CHARGE SHAPES -------------------------------------------------
//
// Identical to service_charge_off.test.ts's, because a fix that closed the gap in
// one shape and left it open in another is the F2 bug wearing a new coat.

interface Shape { name: string; taxConfig: Record<string, number>; scPct: number }
const SHAPES: Shape[] = [
  // The charge sits UNDER the tax. This shape was ALREADY diverging before F2.
  { name: "restaurant_percent", taxConfig: { SGST: 2.5, CGST: 2.5 }, scPct: 10 },
  // The shipped seed: the charge IS a tax line. F2 extended the divergence here.
  { name: "tax_line", taxConfig: { SGST: 2.5, CGST: 2.5, "Service Charge": 10 }, scPct: 0 },
  // Charging twice. Both legs have to come off together or one survives.
  { name: "both shapes at once", taxConfig: { SGST: 2.5, CGST: 2.5, "Service Charge": 10 }, scPct: 10 },
];

/** Subtotals a real bill lands on, including ones that force a half-paisa. */
const SUBTOTALS = [1, 9.99, 333.33, 1234.56, 5499, 87654.32];

/** A live, un-reversed "ServiceChargeWaivers" row for this table's open bill. */
function liveWaiverRow(): Record<string, unknown> {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    created_at: new Date("2026-09-11T10:00:00Z"),
    outlet_id: mockIds.outlet, bill_id: mockIds.bill, table_id: mockIds.table,
    waived_at: new Date("2026-09-11T10:00:00Z"),
    basis: "tax_line", basis_percent: 10, basis_amount: 0,
    amount_waived: 0, tax_on_waived: 0, grand_total_reduction: 0,
    waiver_kind: "guest_complaint", reason: "Late service, manager approved",
    waived_by_username: "cashier1", authorised_by_username: "manager1",
    reversed_at: null, reversed_by_username: null, reversal_reason: null,
  };
}

beforeEach(async () => {
  if (registered.length === 0) {
    // database_supabase.ts refuses to load without a connection string. Nothing
    // here connects — the fixture pool above answers from memory — this only gets
    // the module past its own boot check, exactly as the other money suites do.
    process.env.SUPABASE_DIRECT_URL =
      process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
    const bills = await import("../../routes/bills");
    bills.registerBillPrintAndEditRoutes(fakeApp as never);
  }
  mockDb.taxConfig = null;
  mockDb.scPct = 0;
  mockDb.waiver = null;
  mockDb.subtotal = 0;
  mockDb.discount = null;
  mockAudit.length = 0;
  mockReceipts.length = 0;
});

// ============================================================================
// THE INVARIANT
// ============================================================================

describe("THE PAPER IS THE DRAWER — the printed grand total equals the settled grand total", () => {
  for (const shape of SHAPES) {
    describe(shape.name, () => {
      beforeEach(() => { mockDb.taxConfig = shape.taxConfig; mockDb.scPct = shape.scPct; });

      test.each(SUBTOTALS)("subtotal %p, no waiver, no flag: paper == drawer", async (subtotal) => {
        mockDb.subtotal = subtotal;
        const paper = await printedBill({});
        const drawer = await drawerCharges();
        expect(paper.grandTotal).toBe(drawer.grand_total);
        // The round-off is the drawer's too (migration 048): the line the paper
        // prints above the total is the adjustment settle records, not one the
        // route or the renderer worked out for itself.
        expect(paper.roundOff).toBe(drawer.round_off);
      });

      test.each(SUBTOTALS)(
        "subtotal %p, NO WAIVER but no_service_charge SET: paper == drawer  <-- THE BLOCKER",
        async (subtotal) => {
          mockDb.subtotal = subtotal;
          const paper = await printedBill({ no_service_charge: true });
          const drawer = await drawerGrandTotal();
          // On the shipped code this was the ₹549.90 gap on a ₹5,499 bill: the
          // print took both legs off and no settle path knew the flag existed.
          expect(paper.grandTotal).toBe(drawer);
        },
      );

      test.each(SUBTOTALS)(
        "subtotal %p, WAIVER RECORDED, no flag: paper == drawer, and both came down",
        async (subtotal) => {
          mockDb.subtotal = subtotal;
          const charged = await drawerCharges();          // with the charge
          mockDb.waiver = liveWaiverRow();                // the authorised removal
          const paper = await printedBill({});
          const drawer = await drawerCharges();
          expect(paper.grandTotal).toBe(drawer.grand_total);
          expect(paper.roundOff).toBe(drawer.round_off);
          // The reduction is REAL on both sides, not merely consistent: a fix
          // that made the paper agree by never removing anything would pass the
          // equality above and fail here. Compared BEFORE the rupee rounding: a
          // one-rupee bill's ten-paise charge can round away on both totals.
          if (subtotal > 0) {
            expect(drawer.pre_round_total).toBeLessThan(charged.pre_round_total);
            expect(drawer.grand_total).toBeLessThanOrEqual(charged.grand_total);
          }
        },
      );

      test.each(SUBTOTALS)(
        "subtotal %p, WAIVER RECORDED and the flag set: paper == drawer, removed once",
        async (subtotal) => {
          mockDb.subtotal = subtotal;
          mockDb.waiver = liveWaiverRow();
          const paper = await printedBill({ no_service_charge: true });
          const drawer = await drawerGrandTotal();
          expect(paper.grandTotal).toBe(drawer);
          // There is only one charge to remove. The flag arriving on top of a
          // waiver must be a no-op, not a second subtraction.
          mockDb.waiver = liveWaiverRow();
          const paperWithoutFlag = await printedBill({});
          expect(paper.grandTotal).toBe(paperWithoutFlag.grandTotal);
        },
      );

      test("a discounted bill keeps the invariant (the charge rides on the discounted base)", async () => {
        mockDb.subtotal = 5499;
        mockDb.discount = { type: "percent", value: 15 };
        expect((await printedBill({ no_service_charge: true })).grandTotal).toBe(await drawerGrandTotal());
        mockDb.waiver = liveWaiverRow();
        expect((await printedBill({ no_service_charge: true })).grandTotal).toBe(await drawerGrandTotal());
      });
    });
  }

  test("the client's own bill: the seeded shape at 10% on 5499", async () => {
    // The literal numbers from the report, kept as literals precisely because
    // they are what a human can check against the paper in their hand.
    mockDb.taxConfig = { SGST: 2.5, CGST: 2.5, "Service Charge": 10 };
    mockDb.scPct = 0;
    mockDb.subtotal = 5499;

    // 6323.84 before the rupee rounding of migration 048; 6324.00 payable.
    expect(await drawerGrandTotal()).toBe(6324);
    expect((await drawerCharges()).round_off).toBe(0.16);
    // WAS 5773.94 — a bill for ₹549.90 less than the till would take.
    const unwaived = await printedBill({ no_service_charge: true });
    expect(unwaived.grandTotal).toBe(6324);
    expect(unwaived.roundOff).toBe(0.16);

    mockDb.waiver = liveWaiverRow();
    // With the waiver recorded, 5773.94 -> 5774.00 is on the paper AND in the drawer.
    expect(await drawerGrandTotal()).toBe(5774);
    expect((await drawerCharges()).round_off).toBe(0.06);
    expect((await printedBill({ no_service_charge: true })).grandTotal).toBe(5774);
    const waived = await printedBill({});
    expect(waived.grandTotal).toBe(5774);
    expect(waived.roundOff).toBe(0.06);
  });

  test("the round-off is the drawer's: Gaia's receipt, 4745 + SGST 118.63 + CGST 118.63 = 4982.00", async () => {
    // The client's reference receipt, as literals a human can hold the paper
    // against: "Round off -0.26", "Grand Total 4982.00".
    mockDb.taxConfig = { SGST: 2.5, CGST: 2.5 };
    mockDb.scPct = 0;
    mockDb.subtotal = 4745;

    const drawer = await drawerCharges();
    expect(drawer.taxes.map((t) => t.amount)).toEqual([118.63, 118.63]);
    expect(drawer.pre_round_total).toBe(4982.26);
    expect(drawer.grand_total).toBe(4982);
    expect(drawer.round_off).toBe(-0.26);

    const paper = await printedBill({});
    expect(paper.grandTotal).toBe(4982);
    expect(paper.roundOff).toBe(-0.26);
    // And the rungs the paper prints reach the total it prints, to the paisa.
    const taxes = (paper.receipt.taxes as { amount: number }[]).reduce((s, t) => s + Math.round(t.amount * 100), 0);
    expect(Math.round(Number(paper.receipt.total) * 100) + taxes + Math.round(paper.roundOff * 100))
      .toBe(Math.round(paper.grandTotal * 100));
  });
});

// ============================================================================
// A REDUCTION NOBODY AUTHORISED IS VISIBLE TO A MANAGER
// ============================================================================
//
// The invariant above is satisfiable by a route that silently ignores the flag,
// and silence is not good enough: a waiter who asked for a bill without the
// charge, and handed over one with it, has to be able to find out why, and a
// manager has to be able to see that it was asked for.

describe("the refused removal is reported and audited", () => {
  beforeEach(() => {
    mockDb.taxConfig = { SGST: 2.5, CGST: 2.5, "Service Charge": 10 };
    mockDb.subtotal = 5499;
  });

  test("no waiver + the flag: the response says the charge is still on and a waiver is required", async () => {
    const { answer } = await printedBill({ no_service_charge: true });
    expect(answer.body.service_charge_removed).toBe(false);
    expect(answer.body.service_charge_waiver_required).toBe(true);
  });

  test("no waiver + the flag: the audit entry records the refusal", async () => {
    await printedBill({ no_service_charge: true });
    // AddAuditLogEntry(res, outlet, emp, action, description, category, details)
    const entry = mockAudit.find((a) => String(a[4]).length > 0);
    expect(entry).toBeDefined();
    const description = String(entry![4]);
    const details = entry![6] as Record<string, unknown>;
    expect(description.toLowerCase()).toContain("service charge");
    expect(details.no_service_charge).toBe(true);
    expect(details.service_charge_removed).toBe(false);
    expect(details.service_charge_waiver_required).toBe(true);
  });

  test("a recorded waiver is NOT a refusal — the reduction is authorised", async () => {
    mockDb.waiver = liveWaiverRow();
    const { answer } = await printedBill({ no_service_charge: true });
    expect(answer.body.service_charge_removed).toBe(true);
    expect(answer.body.service_charge_waiver_required).toBe(false);
  });

  test("a tenant with no charge at all is untouched by any of this", async () => {
    mockDb.taxConfig = { SGST: 2.5, CGST: 2.5 };
    mockDb.scPct = 0;
    const { answer, grandTotal } = await printedBill({ no_service_charge: true });
    expect(grandTotal).toBe(await drawerGrandTotal());
    // Nothing was removed and nothing needs authorising: there is no charge.
    expect(answer.body.service_charge_removed).toBe(false);
    expect(answer.body.service_charge_waiver_required).toBe(false);
  });
});

// ============================================================================
// THE SOURCE GUARD — what the drawer mirror rests on
// ============================================================================
//
// A PRINT MUST NEVER BE THE THING THAT DECIDES WHAT A GUEST PAYS.
//
// `openBillChargeConfig`'s `withoutServiceCharge` option is a PRINT-TIME request:
// it is not stored, it carries no reason and no authoriser, and no report can see
// it. The moment a settle path passes it, the till starts taking whatever the last
// caller asked for, and the moment the print route passes it, the paper stops
// being the drawer — which is the defect this file exists for. Neither file may
// contain the option as a caller-supplied key.
//
// Checked in the source rather than in behaviour because there is no request that
// can reach the settle sites from here, and because it is the one assumption
// `drawerGrandTotal()` above is built on.

describe("no money path asks for the service charge off at compute time", () => {
  const BACKEND = join(__dirname, "..", "..");

  test.each([
    ["database_supabase.ts", "every settle path re-prices through openBillChargeConfig; a print-time flag must not reach it"],
    ["routes/bills.ts", "the printed ladder is the charged ladder — the print may not build its own"],
  ])("%s never passes withoutServiceCharge", (file, why) => {
    const src = readFileSync(join(BACKEND, file), "utf8");
    // The option as a CALLER would supply it: a bare object-literal key. The
    // optional-property DECLARATION in openBillChargeConfig's own options
    // interface is `withoutServiceCharge?:` and the `?` keeps it out of this
    // match, so the declaration and its single read (`opts?.withoutServiceCharge`)
    // are untouched — only somebody passing it is caught.
    const passes = src.match(/withoutServiceCharge\s*:/g) ?? [];
    expect({ file, why, passes: passes.length }).toEqual({ file, why, passes: 0 });
  });
});
