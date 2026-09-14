// PAYMENT MODES, FROM THE ROUTES' SIDE — and the proof that they are CALLED.
//
// payment_methods.ts is proved in jest-tests/payment_methods.test.ts. This file
// pins the two things the pure rules cannot prove about themselves:
//
//   1. THE WIRING. The settle route tells the data layer when a method is the
//      mirror of tenders ALREADY on the bill (mirrorsLedger), and ONLY then — a
//      mode switched off after a guest paid part of a bill with it must not
//      strand the bill, and a plain settle's call must stay the six arguments
//      every shipped client has always produced. The settings route turns a
//      refused save into a 400 carrying the sentences, not a 500.
//   2. "BUILT BUT NEVER CALLED" — this codebase's most repeated defect. Source
//      guards fail if a writer stops resolving methods against the tenant's
//      config, if the old compiled-in alias table creeps back, or if nothing in
//      shipping code imports the module at all.
//
// The real handlers from routes/bills.ts and routes/settings.ts run over a fake
// Express app; only the data-layer functions on the far side are replaced.

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PaymentConfigError } from "../../payment_methods";

jest.mock("pg", () => {
  class FakePool {
    on(): this { return this; }
    query(): Promise<never> { return Promise.reject(new Error("payment modes route fixture: no query is stubbed")); }
    connect(): Promise<never> { return Promise.reject(new Error("payment modes route fixture: pool.connect() is not stubbed")); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

interface MockCall { fn: string; args: unknown[] }
const mockCalls: MockCall[] = [];
const mockNext: {
  ledger: Record<string, unknown>;
  tenderState: Record<string, unknown>;
  settingsThrows: Error | null;
} = { ledger: {}, tenderState: {}, settingsThrows: null };

jest.mock("../../database_supabase", () => {
  const actual = jest.requireActual("../../database_supabase") as Record<string, unknown>;
  const rec = (fn: string, args: unknown[], value: unknown): Promise<unknown> => {
    mockCalls.push({ fn, args });
    return Promise.resolve(value);
  };
  return {
    __esModule: true,
    ...actual,
    GetBillPaymentLedger: (...args: unknown[]) => rec("GetBillPaymentLedger", args, mockNext.ledger),
    ConfirmBillPaymentByWaiter: (...args: unknown[]) => rec("ConfirmBillPaymentByWaiter", args, { success: true, payment_method: String(args[3] ?? "") }),
    RecordBillTenders: (...args: unknown[]) => rec("RecordBillTenders", args, mockNext.tenderState),
    SetBillCounter: (...args: unknown[]) => rec("SetBillCounter", args, true),
    ListBillingCounters: (...args: unknown[]) => rec("ListBillingCounters", args, []),
    GetRestaurantSettings: (...args: unknown[]) => rec("GetRestaurantSettings", args, { currency: "₹", payment_methods: [] }),
    SetRestaurantSettings: (...args: unknown[]) => {
      mockCalls.push({ fn: "SetRestaurantSettings", args });
      return mockNext.settingsThrows ? Promise.reject(mockNext.settingsThrows) : Promise.resolve({ currency: "₹", payment_methods: [] });
    },
    GetEmployeeDetailsFromEmpID: (...args: unknown[]) => rec("GetEmployeeDetailsFromEmpID", args, {
      id: "emp-1", res_id: "res-1", outlet_id: "out-1", username: "cashier1", name: "Cashier One",
    }),
    AddAuditLogEntry: (...args: unknown[]) => rec("AddAuditLogEntry", args, undefined),
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

const RES = "res-1";
const ORDER = "order-1";
const EMP = "3f3f3f3f-1111-4111-8111-3f3f3f3f3f3f";
const AUTH = {
  res_id: RES, outlet_id: "out-1", employeeId: EMP,
  employeeUsername: "cashier1", role: "admin", actions: ["*"],
};

async function call(method: string, path: string, opts: { params?: Record<string, string>; body?: unknown } = {}): Promise<Answer> {
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
  const req = { params: opts.params ?? {}, body: opts.body ?? {}, query: {}, headers: {}, auth: AUTH };
  for (const h of route.handlers) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (ended || !advanced) { break; }
  }
  return out;
}

const settle = (body: unknown): Promise<Answer> =>
  call("POST", "/bills/order/:orderId/waiter-confirm-payment", { params: { orderId: ORDER }, body });
const argsOf = (fn: string): unknown[] => mockCalls.find((c) => c.fn === fn)?.args ?? [];

const NO_LEDGER = { bill_id: "bill-1", live_count: 0, tendered: 0, tips_total: 0, payment_method: null, payment_splits: [] };

beforeEach(async () => {
  if (registered.length === 0) {
    process.env.SUPABASE_DIRECT_URL =
      process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
    const bills = await import("../../routes/bills");
    bills.registerBillPaymentRoutes(fakeApp as never);
    const settings = await import("../../routes/settings");
    settings.registerSettingsRoutes(fakeApp as never);
  }
  mockCalls.length = 0;
  mockNext.ledger = { ...NO_LEDGER };
  mockNext.tenderState = {};
  mockNext.settingsThrows = null;
});

describe("the settle route tells the data layer when a method mirrors a ledger — and only then", () => {
  test("a NEW settle in a custom mode passes the same six arguments, no mirror flag", async () => {
    const answer = await settle({ payment_method: "Swiggy Dineout" });
    expect(answer.status).toBe(200);
    const args = argsOf("ConfirmBillPaymentByWaiter");
    expect(args).toHaveLength(6);
    expect(args[3]).toBe("Swiggy Dineout");
  });

  test("tenders recorded by this settle: the mirror is passed WITH mirrorsLedger", async () => {
    mockNext.tenderState = {
      bill_id: "bill-1", grand_total: 1000, tenders: [], tendered: 1000, outstanding: 0,
      exact: true, partial: false, over: false, tips_total: 0,
      payment_method: "Swiggy Dineout", payment_splits: [],
    };
    await settle({ tenders: [{ method: "Swiggy Dineout", amount: 1000 }] });
    const args = argsOf("ConfirmBillPaymentByWaiter");
    expect(args[3]).toBe("Swiggy Dineout");
    expect(args[6]).toEqual({ mirrorsLedger: true });
  });

  test("a ledger already on the bill: its mirror is passed WITH mirrorsLedger, whatever the body said", async () => {
    mockNext.ledger = { ...NO_LEDGER, live_count: 1, tendered: 1000, payment_method: "Swiggy Dineout" };
    await settle({ payment_method: "Cash" });
    const args = argsOf("ConfirmBillPaymentByWaiter");
    expect(args[3]).toBe("Swiggy Dineout");
    expect(args[6]).toEqual({ mirrorsLedger: true });
  });
});

describe("a refused payment-modes save is a 400 with the sentences", () => {
  test("PaymentConfigError -> 400 {error, details, errors}", async () => {
    const reason = "\"Complimentary\" can't be a payment mode: a free meal is not money collected.";
    mockNext.settingsThrows = new PaymentConfigError([reason, "Second reason."]);
    const answer = await call("POST", "/restaurant/settings", { body: { payment_methods: [{ id: "Complimentary", custom: true }] } });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe("Invalid payment modes");
    expect(answer.body.details).toBe(`${reason} Second reason.`);
    expect(answer.body.errors).toEqual([reason, "Second reason."]);
    // The array reached the data layer untouched — the merge and the refusal are its job.
    expect((argsOf("SetRestaurantSettings")[1] as { payment_methods: unknown }).payment_methods).toEqual([{ id: "Complimentary", custom: true }]);
  });

  test("any other failure is still the 500 it always was", async () => {
    mockNext.settingsThrows = new Error("connection reset");
    const answer = await call("POST", "/restaurant/settings", { body: { currency: "₹" } });
    expect(answer.status).toBe(500);
  });
});

// ============================================================================
// SOURCE GUARDS — database_supabase.ts cannot run its SQL under jest
// ============================================================================

const ROOT = join(__dirname, "..", "..");
const src = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/** The body of one top-level function, from its signature to the next top-level declaration. */
function bodyOf(file: string, signature: string): string {
  const start = file.indexOf(signature);
  if (start < 0) {throw new Error(`not found: ${signature}`);}
  const rest = file.slice(start + signature.length);
  const next = rest.search(/\n(export )?(async )?function |\nexport (interface|type|const) /);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("BUILT AND CALLED: every writer resolves against the tenant's config", () => {
  const db = src("database_supabase.ts");

  test("the compiled-in alias table and proof set are gone from the data layer", () => {
    expect(db).not.toMatch(/function normalizePaymentMethod\(/);
    expect(db).not.toMatch(/PROOF_REQUIRED_METHODS/);
    expect(db).not.toMatch(/paymentRequiresProof\(/);
    expect(db).toMatch(/from "\.\/payment_methods\.js"/);
  });

  test.each([
    ["export async function ConfirmBillPaymentByWaiter(", ["loadPaymentConfig(context, client)", "resolvePaymentMethod(", "paymentMethodRefusal(", "methodRequiresProof("]],
    ["export async function SubmitCustomerPayment(", ["loadPaymentConfig(context, client)", "resolvePaymentMethod(", "show_to_guests", "methodRequiresProof("]],
    ["export async function ApproveBillPaymentByAdmin(", ["loadPaymentConfig(context, client)", "methodRequiresProof("]],
    ["export async function RecordBillTenders(", ["loadPaymentConfig(context, client)", "resolvePaymentMethod(", "paymentMethodRefusal("]],
    ["function normalizePaymentSplits(", ["resolvePaymentMethod(", "paymentMethodRefusal("]],
    ["export async function SetRestaurantSettings(", ["planPaymentConfigSave(", "PaymentConfigError", "for update"]],
    ["async function writeRestaurantSettingsForUndo(", ["paymentConfigUndoValue(context, value, client)"]],
    ["async function paymentConfigUndoValue(", ["paymentConfigForUndo(", "for update"]],
  ])("%s", (signature, needles) => {
    const body = bodyOf(db, signature);
    for (const needle of needles) {expect(body).toContain(needle);}
  });

  test("a settings save writes payment modes in the SAME transaction as every other setting", () => {
    const body = bodyOf(db, "export async function SetRestaurantSettings(");
    // No write of its own ahead of the settings update: that one committed
    // before the big update ran, so a failure there left an unaudited change live.
    expect(body).not.toMatch(/set payment_config = \$2/);
    expect(body).toContain("payment_config = coalesce($4::jsonb, payment_config)");
    const txn = body.slice(body.indexOf("const rows = await withTransaction(async (client) => {"));
    expect(txn.indexOf("planPaymentConfigSave(")).toBeGreaterThan(0);
    expect(txn).toContain("return updateSettingsRow(paymentConfig, client);");
    expect(body).toMatch(/paymentConfig, \/\/ null = unchanged/);
  });

  test("a split sent as parts answers to its parts' screenshot rules — but not the ledger mirror", () => {
    const body = bodyOf(db, "export async function ConfirmBillPaymentByWaiter(");
    expect(body).toContain("splitPartsNeedingProof(splits, paymentConfig)");
    expect(body).toContain("splits.length > 0 && opts.mirrorsLedger !== true");
    expect(body).toMatch(/requiresProof = methodRequiresProof\(paymentMethod, paymentConfig\) \|\| proofParts\.length > 0/);
  });

  test("the cash-up sheets show the owner's label where a person reads the mode", () => {
    expect(db).toMatch(/const SETTLEMENT_COLUMNS: MisColumn\[\] = \[[^\]]*\{ key: "label", label: "Payment mode", type: "text" \}/);
    expect(bodyOf(db, "export async function GetCounterSummaryReport(")).toContain("formatMethodSplit(parts.map((p) => ({ method: labelOf(p.method), amount: p.amount })))");
  });

  test("approval never refuses a disabled mode (it would strand a paid bill)", () => {
    expect(bodyOf(db, "export async function ApproveBillPaymentByAdmin(")).not.toContain("paymentMethodRefusal(");
  });

  test("the four readers pass a custom mode through", () => {
    expect((db.match(/payment_method: displayPaymentMethod\(row\.payment_method\)/g) ?? []).length).toBe(4);
  });

  test("the guest QR payment lists only modes that are on AND offered to guests", () => {
    expect(bodyOf(db, "export async function GetPublicBranding(")).toContain("m.enabled && m.show_to_guests !== false");
    const guest = src("routes/guest.ts");
    expect(guest).toContain("resolvePaymentMethod(method, settings.payment_methods");
    expect(guest).toContain("cfg.show_to_guests === false");
  });

  test("the four report readers attach the label", () => {
    for (const sig of [
      "export async function GetSalesReport(",
      "export async function GetReconciliation(",
      "export async function GetSettlementSummaryReport(",
      "export async function GetCounterSummaryReport(",
    ]) {
      expect(bodyOf(db, sig)).toContain("paymentLabelsFor(");
    }
  });

  test("the settle route passes mirrorsLedger, the settings route maps the refusal", () => {
    expect(src("routes/bills.ts")).toContain("mirrorsLedger ? [{ mirrorsLedger: true }] : []");
    expect(src("routes/settings.ts")).toContain("err instanceof PaymentConfigError");
  });
});
