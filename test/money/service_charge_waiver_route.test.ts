// THE WAIVER'S TWO NUMBERS, AFTER ROUNDING (migration 048) — what the route
// records and what it says.
//
// A service-charge waiver produces two different figures and, since every bill
// is rounded to the rupee, they are no longer the same thing:
//
//   * grand_total_reduction — the charge plus the tax that rode on it, measured
//     on the totals BEFORE round-off (quoteServiceChargeWaiver). It is exact:
//     amount_waived + tax_on_waived equals it to the paisa, and the control
//     report sums it.
//   * grand_total_before / grand_total_after — what the guest is asked to pay
//     either side of the waiver, each rounded to the rupee.
//
// Their gap differs from the reduction by the two round-offs. On 5499 of food
// with a 10% charge and 5% GST that is 6351 -> 5774 (the guest pays 577.00 less)
// against a recorded 577.40. The audit line used to call 577.40 "grand total
// −₹577.40", which is a sentence in a control ledger contradicting the two
// totals written beside it. This pins the route's audit line and response on
// both tax shapes the fleet runs, driving the REAL handler over a fake Express
// app with the quote computed by billing_math, not typed in.

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { quoteServiceChargeWaiver } from "../../billing_math";

jest.mock("pg", () => {
  class FakePool {
    on(): this { return this; }
    query(): Promise<never> { return Promise.reject(new Error("waiver route fixture: no query is stubbed")); }
    connect(): Promise<never> { return Promise.reject(new Error("waiver route fixture: pool.connect() is not stubbed")); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

jest.mock("../../realtime", () => ({ __esModule: true, emitRestaurant: jest.fn(), emitOutlet: jest.fn() }));

interface MockCall { fn: string; args: unknown[] }
const mockCalls: MockCall[] = [];
const mockNext: { waive: unknown } = { waive: null };

jest.mock("../../database_supabase", () => {
  const actual = jest.requireActual("../../database_supabase") as Record<string, unknown>;
  const record = (fn: string, args: unknown[], value: unknown): Promise<unknown> => {
    mockCalls.push({ fn, args });
    return Promise.resolve(value);
  };
  return {
    __esModule: true,
    ...actual,
    ResolveAuthoriser: (...args: unknown[]) => record("ResolveAuthoriser", args, {
      ok: true, identity: { employee_id: "emp-2", username: "manager01", display_name: "Manager One" },
    }),
    WaiveServiceCharge: (...args: unknown[]) => record("WaiveServiceCharge", args, mockNext.waive),
    GetEmployeeDetailsFromEmpID: (...args: unknown[]) => record("GetEmployeeDetailsFromEmpID", args, {
      id: "emp-1", res_id: "res-1", outlet_id: "out-1", username: "cashier1", name: "Cashier One",
    }),
    AddAuditLogEntry: (...args: unknown[]) => record("AddAuditLogEntry", args, undefined),
  };
});

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
  res_id: "res-1", outlet_id: "out-1", employeeId: "3f3f3f3f-1111-4111-8111-3f3f3f3f3f3f",
  employeeUsername: "cashier1", role: "admin", actions: ["*"],
};

async function waive(overrides: Record<string, unknown> = {}): Promise<Answer> {
  const route = registered.find((r) => r.method === "POST" && r.path === "/bills/service-charge-waiver");
  if (!route) { throw new Error("no route registered for POST /bills/service-charge-waiver"); }
  const out: Answer = { status: 200, body: undefined };
  let ended = false;
  const res = {
    status(code: number) { out.status = code; return res; },
    json(payload: unknown) { if (!ended) { out.body = payload; ended = true; } return res; },
    send(payload: unknown) { if (!ended) { out.body = payload; ended = true; } return res; },
    setHeader() { return res; },
    end() { ended = true; return res; },
  };
  const req = {
    params: {}, query: {}, headers: {}, auth: AUTH,
    body: { table_name: "T15", waiver_kind: "guest_request", reason: "Guest asked", authorised_by: "manager01", ...overrides },
  };
  for (const h of route.handlers) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (ended || !advanced) { break; }
  }
  return out;
}

/** WaiveServiceCharge's result, from the real quote — exactly as the data layer builds it. */
function waiverResult(quote: ReturnType<typeof quoteServiceChargeWaiver>): unknown {
  return {
    record: {
      id: "w-1", bill_id: "bill-1", table_id: "t-15", waiver_kind: "guest_request", reason: "Guest asked",
      basis: quote.basis, basis_percent: quote.basis_percent, basis_amount: quote.basis_amount,
      amount_waived: quote.amount_waived, tax_on_waived: quote.tax_on_waived,
      grand_total_reduction: quote.grand_total_reduction,
      waived_by_username: "cashier1", authorised_by_username: "manager01",
    },
    grand_total_before: quote.grand_total_with,
    grand_total_after: quote.grand_total_without,
  };
}

const auditLine = (): string => String(mockCalls.find((c) => c.fn === "AddAuditLogEntry")?.args[4] ?? "");
const auditDetails = (): Record<string, unknown> =>
  (mockCalls.find((c) => c.fn === "AddAuditLogEntry")?.args[6] ?? {}) as Record<string, unknown>;

beforeEach(async () => {
  if (registered.length === 0) {
    process.env.SUPABASE_DIRECT_URL =
      process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
    const routes = await import("../../routes/mis_capture");
    routes.registerMisCaptureRoutes(fakeApp as never);
  }
  mockCalls.length = 0;
});

describe("GST rides on the charge (restaurant_percent): 577.40 recorded, 577.00 off what the guest pays", () => {
  const quote = quoteServiceChargeWaiver(5499, { SGST: 2.5, CGST: 2.5 }, 10);

  test("the quote itself: the two figures really do differ once the bill is rounded", () => {
    expect(quote.amount_waived).toBe(549.9);
    expect(quote.tax_on_waived).toBe(27.5);
    expect(quote.grand_total_reduction).toBe(577.4);
    expect([quote.grand_total_with, quote.grand_total_without]).toEqual([6351, 5774]);
  });

  test("the response carries the exact record AND the two payable totals, unchanged", async () => {
    mockNext.waive = waiverResult(quote);
    const answer = await waive();
    expect(answer.status).toBe(201);
    expect(answer.body.waiver.grand_total_reduction).toBe(577.4);
    expect(answer.body.grand_total_before).toBe(6351);
    expect(answer.body.grand_total_after).toBe(5774);
  });

  test("the audit line names the reduction as charge-and-tax before round-off, and the totals as totals", async () => {
    mockNext.waive = waiverResult(quote);
    await waive();
    const line = auditLine();
    expect(line).toContain("Waived the service charge (₹549.90; ₹577.40 with its tax, before round-off; grand total ₹6351.00 → ₹5774.00)");
    // The sentence it replaced: the pre-round figure presented as the change in
    // the grand total, beside totals that moved by 577.00.
    expect(line).not.toMatch(/grand total −₹/);
    expect(line).toContain("authorised by manager01");
    // The structured details keep every exact figure for the report and undo.
    expect(auditDetails()).toMatchObject({
      amount_waived: 549.9, tax_on_waived: 27.5, grand_total_reduction: 577.4,
      grand_total_before: 6351, grand_total_after: 5774,
    });
  });
});

describe("the charge IS a tax line (Gaia): the client's receipt, 5457 -> 4982", () => {
  const quote = quoteServiceChargeWaiver(
    4745,
    [{ name: "SGST", percentage: 2.5 }, { name: "CGST", percentage: 2.5 }, { name: "Service Charge", percentage: 10 }],
    0,
  );

  test("the audit line reads the payable totals the till showed", async () => {
    expect(quote.grand_total_reduction).toBe(474.5);
    mockNext.waive = waiverResult(quote);
    await waive();
    expect(auditLine()).toContain("(₹474.50; ₹474.50 with its tax, before round-off; grand total ₹5457.00 → ₹4982.00)");
  });
});

describe("the reason is optional (client item, 2.0.1): the route hands it on and lets the data layer decide", () => {
  // Whether a reasonless waiver may be STORED is the column's answer (migration
  // 051), and WaiveServiceCharge asks it — pinned in
  // service_charge_waiver_reason_optional.test.ts. The route must not refuse a
  // missing reason itself, or 051 could never turn the feature on.
  const quote = quoteServiceChargeWaiver(5499, { SGST: 2.5, CGST: 2.5 }, 10);
  const sentReason = (): unknown =>
    (mockCalls.find((c) => c.fn === "WaiveServiceCharge")?.args[1] as Record<string, unknown> | undefined)?.reason;

  test.each([
    ["absent", { reason: undefined }, null],
    ["null", { reason: null }, null],
    ["empty", { reason: "" }, ""],
    ["whitespace", { reason: "   " }, "   "],
  ])("reason %s reaches WaiveServiceCharge (which stores none as NULL)", async (_label, overrides, expected) => {
    mockNext.waive = waiverResult(quote);
    const answer = await waive(overrides);
    expect(answer.status).toBe(201);
    expect(sentReason()).toBe(expected);
  });

  test("a waiver the data layer refuses for want of a reason is its clean 400, verbatim", async () => {
    // What WaiveServiceCharge throws where the column is still NOT NULL.
    mockNext.waive = Promise.reject(new Error("A reason is required to waive the service charge."));
    (mockNext.waive as Promise<unknown>).catch(() => undefined);
    const answer = await waive({ reason: undefined });
    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ error: "A reason is required to waive the service charge." });
    expect(mockCalls.some((c) => c.fn === "AddAuditLogEntry")).toBe(false);
  });

  test("the kind and the authoriser are still required by the schema", async () => {
    expect((await waive({ waiver_kind: undefined, reason: undefined })).status).toBe(400);
    expect((await waive({ authorised_by: undefined, reason: undefined })).status).toBe(400);
    expect((await waive({ reason: "x".repeat(401) })).status).toBe(400);
    expect(mockCalls.some((c) => c.fn === "WaiveServiceCharge")).toBe(false);
  });

  test("the audit line of a reasonless waiver says reason: null, and its sentence never names one", async () => {
    const result = waiverResult(quote) as { record: Record<string, unknown> };
    result.record.reason = null;
    mockNext.waive = result;
    await waive({ reason: undefined });
    expect(auditDetails()).toMatchObject({ reason: null, waiver_kind: "guest_request" });
    expect(auditLine()).not.toMatch(/null|undefined/);
  });
});
