// THE SETTLE ROUTE AFTER MIGRATIONS 037 AND 038 — and, first of all, THE PROOF
// THAT IT DID NOT CHANGE.
//
// Every shipped Flutter build and the whole web dashboard settle bills by
// POSTing { payment_method } (or { splits }) to
// /bills/order/:orderId/waiter-confirm-payment. None of them knows what a tender,
// a tip or a counter is, and none of them is going to be re-released before this
// ships. So the first and largest thing this file asserts is a NEGATIVE: that for
// a request carrying none of the three new fields, the handler hands the data
// layer the same six arguments it always handed it, and hands the caller back the
// data layer's own result object — the same object, not a copy of it.
//
// WHY THE HANDLERS AND NOT THE MATH. billing_math's reconciliation is already
// proved to the paisa in mis_capture_money.test.ts. What is unproved, and what
// broke real money the last time it was changed, is the WIRING: which arguments
// the route builds, in which order, and what it does when the ledger and the body
// disagree. So these tests register the REAL route handlers from routes/bills.ts
// over a fake Express app and drive them with real requests. Only the data-layer
// functions on the far side are replaced, and each one records exactly what it
// was called with, because "what did the route pass down" IS the assertion.
//
// `pg` is mocked to a pool that refuses every query, which is deliberate: if a
// handler ever reaches the database through a path this file has not stubbed, it
// fails loudly here instead of passing on a stub that quietly returned nothing.

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { allocateTenderAmounts, reconcileTenders, toPaisa } from "../../billing_math";

jest.mock("pg", () => {
  class FakePool {
    on(): this { return this; }
    query(): Promise<never> { return Promise.reject(new Error("money route fixture: no query is stubbed")); }
    connect(): Promise<never> { return Promise.reject(new Error("money route fixture: pool.connect() is not stubbed")); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

// --- what the stubbed data layer records and returns -------------------------
//
// Named with the `mock` prefix because jest hoists the factory below above these
// declarations; the factory only READS them when a handler calls, by which time
// they are initialised.

interface MockCall { fn: string; args: unknown[] }
const mockCalls: MockCall[] = [];

const mockNext: {
  ledger: Record<string, unknown>;
  confirm: unknown;
  tenderState: Record<string, unknown>;
  counters: { id: string; code: string; active: boolean }[];
  recordThrows: string | null;
} = {
  ledger: {},
  confirm: {},
  tenderState: {},
  counters: [],
  recordThrows: null,
};

const mockRecord = (fn: string, args: unknown[], value: unknown): unknown => {
  mockCalls.push({ fn, args });
  return value;
};

jest.mock("../../database_supabase", () => {
  const actual = jest.requireActual("../../database_supabase") as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    GetBillPaymentLedger: (...args: unknown[]) => Promise.resolve(mockRecord("GetBillPaymentLedger", args, mockNext.ledger)),
    ConfirmBillPaymentByWaiter: (...args: unknown[]) => Promise.resolve(mockRecord("ConfirmBillPaymentByWaiter", args, mockNext.confirm)),
    RecordBillTenders: (...args: unknown[]) => {
      mockCalls.push({ fn: "RecordBillTenders", args });
      if (mockNext.recordThrows) { return Promise.reject(new Error(mockNext.recordThrows)); }
      return Promise.resolve(mockNext.tenderState);
    },
    SetBillCounter: (...args: unknown[]) => Promise.resolve(mockRecord("SetBillCounter", args, true)),
    ListBillingCounters: (...args: unknown[]) => Promise.resolve(mockRecord("ListBillingCounters", args, mockNext.counters)),
    // log_audit's two hops. Stubbed rather than left to fail so the audit branch
    // is really executed on every settle in this suite.
    GetEmployeeDetailsFromEmpID: (...args: unknown[]) => Promise.resolve(mockRecord("GetEmployeeDetailsFromEmpID", args, {
      id: "emp-1", res_id: "res-1", outlet_id: "out-1", username: "cashier1", name: "Cashier One",
    })),
    AddAuditLogEntry: (...args: unknown[]) => Promise.resolve(mockRecord("AddAuditLogEntry", args, undefined)),
  };
});

// --- the fake Express app ----------------------------------------------------

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

async function call(method: string, path: string, opts: {
  params?: Record<string, string>;
  body?: unknown;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  auth?: unknown;
} = {}): Promise<Answer> {
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
  const req = {
    params: opts.params ?? {},
    body: opts.body ?? {},
    query: opts.query ?? {},
    headers: opts.headers ?? {},
    auth: opts.auth,
  };
  for (const h of route.handlers) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (ended || !advanced) { break; }
  }
  return out;
}

const SETTLE = "/bills/order/:orderId/waiter-confirm-payment";
const settle = (body: unknown, headers?: Record<string, string>): Promise<Answer> =>
  call("POST", SETTLE, { params: { orderId: ORDER }, body, auth: AUTH, ...(headers ? { headers } : {}) });

const callsTo = (fn: string): MockCall[] => mockCalls.filter((c) => c.fn === fn);
const argsOf = (fn: string): unknown[] => callsTo(fn)[0]?.args ?? [];

/** An untendered bill: what GetBillPaymentLedger returns for every bill today. */
const NO_LEDGER = {
  bill_id: "bill-1", live_count: 0, tendered: 0, tips_total: 0,
  payment_method: null, payment_splits: [],
};

beforeEach(async () => {
  if (registered.length === 0) {
    // database_supabase.ts refuses to load without a connection string. Nothing
    // here ever connects (the pool above rejects every query); this only gets the
    // module past its own boot check, exactly as the other money suites do.
    process.env.SUPABASE_DIRECT_URL =
      process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
    const bills = await import("../../routes/bills");
    bills.registerBillPaymentRoutes(fakeApp as never);
    bills.registerTenderRoutes(fakeApp as never);
  }
  mockCalls.length = 0;
  mockNext.ledger = { ...NO_LEDGER };
  mockNext.confirm = { success: true, payment_method: "Cash" };
  mockNext.tenderState = {};
  mockNext.counters = [];
  mockNext.recordThrows = null;
});

// ============================================================================
// THE PARITY CONTRACT — the shipped clients must not be able to tell
// ============================================================================

describe("PARITY: a client that knows nothing about tenders, tips or tills", () => {
  test("THE HEADLINE: a single-method settle passes the SAME six arguments and returns the data layer's OWN object", async () => {
    const answer = await settle({ payment_method: "Cash" });

    expect(answer.status).toBe(200);
    // The six arguments, in order, exactly as this route has always built them.
    expect(argsOf("ConfirmBillPaymentByWaiter")).toEqual([RES, ORDER, EMP, "Cash", null, undefined]);
    // Not merely deep-equal to the data layer's result — the same object. A
    // handler that had started composing a richer response would fail here even
    // if every field happened to match.
    expect(answer.body).toBe(mockNext.confirm);
    // Nothing from either new migration was touched.
    expect(callsTo("RecordBillTenders")).toHaveLength(0);
    expect(callsTo("SetBillCounter")).toHaveLength(0);
  });

  test("a legacy SPLIT settle passes its parts through untouched", async () => {
    const splits = [{ method: "Cash", amount: 500 }, { method: "Card", amount: 255.55 }];
    const answer = await settle({ splits });

    expect(answer.status).toBe(200);
    // payment_method stays the empty string the handler has always derived from
    // an absent body field; the parts are the caller's own array, not a rebuild.
    expect(argsOf("ConfirmBillPaymentByWaiter")).toEqual([RES, ORDER, EMP, "", null, splits]);
    expect((argsOf("ConfirmBillPaymentByWaiter")[5] as unknown[])).toBe(splits);
    expect(answer.body).toBe(mockNext.confirm);
  });

  test("a proof-bearing method still carries its screenshot URL in argument five", async () => {
    await settle({ payment_method: "Zomato", payment_proof_screenshot_url: " https://p/1.jpg " });
    expect(argsOf("ConfirmBillPaymentByWaiter")).toEqual([RES, ORDER, EMP, "Zomato", "https://p/1.jpg", undefined]);
  });

  test("the missing-identity 400 is unchanged, word for word", async () => {
    const answer = await call("POST", SETTLE, { params: { orderId: ORDER }, body: {}, auth: AUTH });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe("Missing orderId, payment_method, or employee identity");
    expect(callsTo("ConfirmBillPaymentByWaiter")).toHaveLength(0);
  });

  test("the ONE added call on the legacy path is the ledger consult, and it changes nothing", async () => {
    await settle({ payment_method: "Cash" });
    // Named explicitly so the cost of the parity guarantee stays visible: one
    // narrow read, before the settle, that answers `live_count: 0` for every
    // bill on every tenant that has never recorded a tender.
    const moneyPath = mockCalls.map((c) => c.fn).filter((f) => f === "GetBillPaymentLedger" || f === "RecordBillTenders" || f === "ConfirmBillPaymentByWaiter" || f === "SetBillCounter");
    expect(moneyPath).toEqual(["GetBillPaymentLedger", "ConfirmBillPaymentByWaiter"]);
    expect(argsOf("GetBillPaymentLedger")).toEqual([RES, { order_id: ORDER }]);
  });
});

// ============================================================================
// TENDERS AT SETTLE — the parts must reconstruct the total, to the paisa
// ============================================================================

describe("037 at the door: N tenders settle one bill", () => {
  // THE FLOAT TRAP, restated where the route can see it. 1230.30 split three
  // ways is 410.10 apiece and those three doubles do NOT add up to 1230.30.
  const TOTAL = 1230.30;
  const PARTS = allocateTenderAmounts(TOTAL, 3);

  test("a three-way split of an odd amount is exact in paisa and NOT in floats", () => {
    expect(PARTS).toEqual([410.10, 410.10, 410.10]);
    // The drift, demonstrated rather than asserted in prose: a naive
    // `sum === total` here REJECTS a correct split, and a naive tolerance
    // ACCEPTS a wrong one. Whole paisa is the only arithmetic that does neither.
    expect(PARTS[0] + PARTS[1] + PARTS[2]).not.toBe(TOTAL);
    expect(reconcileTenders(TOTAL, PARTS).exact).toBe(true);
    expect(reconcileTenders(TOTAL, PARTS).outstanding).toBe(0);
    // The uneven remainder case: 100 over three is 33.33 / 33.33 / 33.34, and
    // the odd paisa goes to the last part rather than evaporating.
    expect(allocateTenderAmounts(100, 3)).toEqual([33.33, 33.33, 33.34]);
    expect(reconcileTenders(100, allocateTenderAmounts(100, 3)).exact).toBe(true);
    // A paisa either way is not "close enough" — it is a different bill.
    expect(reconcileTenders(TOTAL, [410.10, 410.10, 410.09]).exact).toBe(false);
    expect(reconcileTenders(TOTAL, [410.10, 410.10, 410.11]).over).toBe(true);
  });

  test("the tenders reach the data layer verbatim, with require_full and a session actor", async () => {
    mockNext.tenderState = {
      bill_id: "bill-1", grand_total: TOTAL, tenders: [], tendered: TOTAL, outstanding: 0,
      exact: true, partial: false, over: false, tips_total: 0,
      payment_method: "Split",
      payment_splits: PARTS.map((amount, i) => ({ method: ["Card", "Upi", "Cash"][i], amount })),
    };
    mockNext.confirm = { success: true, payment_method: "Split" };

    const answer = await settle({
      tenders: [
        { method: "Card", amount: PARTS[0], txn_ref: "auth-1" },
        { method: "Upi", amount: PARTS[1], txn_ref: "rrn-2" },
        { method: "Cash", amount: PARTS[2] },
      ],
    });

    expect(answer.status).toBe(200);
    const rec = argsOf("RecordBillTenders")[1] as Record<string, unknown>;
    expect(rec.order_id).toBe(ORDER);
    // The bill must be fully reconstructed or nothing is written — the settle is
    // not a place a partial payment is allowed to land.
    expect(rec.require_full).toBe(true);
    // The actor is the VERIFIED SESSION's username. There is no body field for it.
    expect(rec.settled_by_username).toBe("cashier1");
    expect(rec.settled_by_employee_id).toBe(EMP);
    expect(rec.tenders).toEqual([
      { method: "Card", amount: 410.10, txn_ref: "auth-1", tip_amount: 0, tip_mode: null, tip_credited_to_employee_id: null, tip_credited_to_username: null },
      { method: "Upi", amount: 410.10, txn_ref: "rrn-2", tip_amount: 0, tip_mode: null, tip_credited_to_employee_id: null, tip_credited_to_username: null },
      { method: "Cash", amount: 410.10, txn_ref: null, tip_amount: 0, tip_mode: null, tip_credited_to_employee_id: null, tip_credited_to_username: null },
    ]);
  });

  test("the settle is then driven by the LEDGER'S mirror, and the mirror sums to the bill", async () => {
    const splits = PARTS.map((amount, i) => ({ method: ["Card", "Upi", "Cash"][i], amount }));
    mockNext.tenderState = {
      bill_id: "bill-1", grand_total: TOTAL, tenders: [], tendered: TOTAL, outstanding: 0,
      exact: true, partial: false, over: false, tips_total: 0,
      payment_method: "Split", payment_splits: splits,
    };
    mockNext.confirm = { success: true, payment_method: "Split" };

    await settle({ tenders: PARTS.map((amount, i) => ({ method: ["Card", "Upi", "Cash"][i], amount })) });

    const args = argsOf("ConfirmBillPaymentByWaiter");
    expect(args[3]).toBe("Split");
    expect(args[5]).toBe(splits);
    // In paisa, because that is the only arithmetic that may decide this — the
    // same three numbers added as doubles miss by a hundred-billionth.
    const paisa = splits.reduce((s, p) => s + toPaisa(p.amount), 0);
    expect(paisa).toBe(toPaisa(TOTAL));
    expect(splits.reduce((s, p) => s + p.amount, 0)).not.toBe(TOTAL);
  });

  test("an UNDER-tender at settle is refused by the data layer and surfaced verbatim", async () => {
    mockNext.recordThrows = "The tenders add up to 900 but the bill is 1000 — 100 is still outstanding.";
    const answer = await settle({ tenders: [{ method: "Cash", amount: 900 }] });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toMatch(/still outstanding/);
    // Nothing settled. The bill stays open and the guest still owes the balance.
    expect(callsTo("ConfirmBillPaymentByWaiter")).toHaveLength(0);
  });

  test("an OVER-tender is refused rather than netted off — change is cash, not a tender", async () => {
    mockNext.recordThrows = "Those tenders come to 1100, which is more than the bill's 1000. Change is handed back in cash, not recorded as a tender.";
    const answer = await settle({ tenders: [{ method: "Cash", amount: 1100 }] });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toMatch(/more than the bill/);
    expect(callsTo("ConfirmBillPaymentByWaiter")).toHaveLength(0);
  });

  test("if the settle fails AFTER the tenders were written, the answer says how to recover", async () => {
    mockNext.tenderState = {
      bill_id: "bill-1", grand_total: TOTAL, tenders: [], tendered: TOTAL, outstanding: 0,
      exact: true, partial: false, over: false, tips_total: 0,
      payment_method: "Zomato", payment_splits: [],
    };
    // RecordBillTenders commits in its own transaction; this one fails after it.
    const boom = new Error("Payment proof screenshot is required for Dineout, Zomato, EasyDiner or District");
    mockNext.confirm = Promise.reject(boom) as never;
    // Swallow the rejection the stub is about to hand over, so the runtime does
    // not report it as unhandled before the handler awaits it.
    (mockNext.confirm as unknown as Promise<never>).catch(() => undefined);

    const answer = await settle({ tenders: [{ method: "Zomato", amount: TOTAL }] });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toMatch(/payments were recorded/);
    expect(answer.body.error).toMatch(/screenshot is required/);
    expect(answer.body.error).toMatch(/WITHOUT the tenders field/);
  });

  test("`tenders: []` is a 400 about tenders, never a silent fall back to the legacy path", async () => {
    const answer = await settle({ payment_method: "Cash", tenders: [] });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe("At least one tender is required");
    expect(callsTo("ConfirmBillPaymentByWaiter")).toHaveLength(0);
  });

  test("Razorpay may settle a bill ALONE but never as one of several", async () => {
    // "BillTenders".method accepts it; "Bills".payment_splits does not. Recording
    // it beside another tender would mirror down into a part the settle path then
    // refuses — a fully paid bill stranded open. Refused before it is written.
    mockNext.ledger = { ...NO_LEDGER, live_count: 1, payment_method: "Cash", payment_splits: [] };
    const beside = await settle({ tenders: [{ method: "Razorpay", amount: 500 }] });
    expect(beside.status).toBe(400);
    expect(beside.body.error).toMatch(/settles a bill on its own/);
    expect(callsTo("RecordBillTenders")).toHaveLength(0);

    // The reverse direction: an existing lone Razorpay tender blocks a second
    // tender of any kind, because the pair is what cannot be mirrored.
    mockCalls.length = 0;
    mockNext.ledger = { ...NO_LEDGER, live_count: 1, payment_method: "Razorpay", payment_splits: [] };
    const after = await settle({ tenders: [{ method: "Cash", amount: 500 }] });
    expect(after.status).toBe(400);
    expect(after.body.error).toMatch(/Razorpay cannot be one of several payments/);
    expect(callsTo("RecordBillTenders")).toHaveLength(0);

    // Alone, it is a perfectly ordinary settle: one tender, no parts to mirror.
    mockCalls.length = 0;
    mockNext.ledger = { ...NO_LEDGER };
    mockNext.tenderState = {
      bill_id: "bill-1", grand_total: 500, tenders: [], tendered: 500, outstanding: 0,
      exact: true, partial: false, over: false, tips_total: 0,
      payment_method: "Razorpay", payment_splits: [],
    };
    mockNext.confirm = { success: true, payment_method: "Razorpay" };
    const alone = await settle({ tenders: [{ method: "Razorpay", amount: 500 }] });
    expect(alone.status).toBe(200);
    expect(argsOf("ConfirmBillPaymentByWaiter")[3]).toBe("Razorpay");
    expect(argsOf("ConfirmBillPaymentByWaiter")[5]).toBeUndefined();
  });

  test("a seventh tender is refused BEFORE anything is written", async () => {
    // payment_splits — the compatibility column every settlement reader still
    // uses — takes 2..6 parts. A seventh would be recordable and unsettleable.
    mockNext.ledger = { ...NO_LEDGER, live_count: 5 };
    const answer = await settle({
      tenders: [{ method: "Cash", amount: 1 }, { method: "Card", amount: 1 }],
    });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toMatch(/at most 6 tenders/);
    expect(callsTo("RecordBillTenders")).toHaveLength(0);
    expect(callsTo("ConfirmBillPaymentByWaiter")).toHaveLength(0);
  });
});

// ============================================================================
// A TIP IS NOT REVENUE
// ============================================================================

describe("037: the tip rides on the tender and enters no sales figure", () => {
  test("the arithmetic: folding a tip into the amount makes a correct bill read as over-tendered", () => {
    const taken = [{ amount: 500, tip: 50 }, { amount: 500, tip: 0 }];
    expect(reconcileTenders(1000, taken.map((t) => t.amount)).exact).toBe(true);
    expect(reconcileTenders(1000, taken.map((t) => t.amount + t.tip)).over).toBe(true);
  });

  test("the route: the tip travels on the tender and NEVER into the settled parts", async () => {
    const splits = [{ method: "Card", amount: 1000 }];
    mockNext.tenderState = {
      bill_id: "bill-1", grand_total: 1000, tenders: [{ id: "t1", tip_amount: 50 }],
      tendered: 1000, outstanding: 0, exact: true, partial: false, over: false,
      tips_total: 50, payment_method: "Card", payment_splits: [],
    };
    mockNext.confirm = { success: true, payment_method: "Card" };

    const answer = await settle({
      tenders: [{
        method: "Card", amount: 1000, tip_amount: 50,
        tip_mode: "card", tip_credited_to_username: "pool",
      }],
    });

    // Down to the data layer: amount and tip are two fields, never one number.
    const sent = (argsOf("RecordBillTenders")[1] as { tenders: Record<string, unknown>[] }).tenders[0];
    expect(sent.amount).toBe(1000);
    expect(sent.tip_amount).toBe(50);
    expect(sent.tip_mode).toBe("card");
    expect(sent.tip_credited_to_username).toBe("pool");

    // Into the bill: one tender, so the mirror is the single method with no
    // parts, and the amount the bill is settled at is the bill's, not 1050.
    const args = argsOf("ConfirmBillPaymentByWaiter");
    expect(args[3]).toBe("Card");
    expect(args[5]).toBeUndefined();

    // Out to the caller: the tip is reported SEPARATELY from what was tendered.
    expect(answer.body.tendered).toBe(1000);
    expect(answer.body.tips_total).toBe(50);
    expect(toPaisa(answer.body.tendered)).toBe(toPaisa(1000));
    expect(splits.reduce((s, p) => s + toPaisa(p.amount), 0)).toBe(toPaisa(1000));

    // And into the audit line: tips are logged, never added to `tendered`.
    const audit = callsTo("AddAuditLogEntry")[0]?.args ?? [];
    const details = JSON.stringify(audit);
    expect(details).toContain("tips_total");
    expect(answer.body.tendered).not.toBe(1050);
  });
});

// ============================================================================
// THE LEDGER IS THE AUTHORITY ON HOW A BILL WAS PAID
// ============================================================================

describe("a ledger recorded out of band is not overwritten by a legacy settle", () => {
  test("tenders taken through POST /bills/tenders drive the settle even when the body says otherwise", async () => {
    const splits = [{ method: "Cash", amount: 500 }, { method: "Card", amount: 500 }];
    mockNext.ledger = {
      bill_id: "bill-1", live_count: 2, tendered: 1000, tips_total: 0,
      payment_method: "Split", payment_splits: splits,
    };
    mockNext.confirm = { success: true, payment_method: "Split" };

    // A caller that took the two payments through the tender route and then
    // settled the old way. Taking its word would blank payment_splits and book
    // the whole bill to Cash.
    await settle({ payment_method: "Cash" });

    const args = argsOf("ConfirmBillPaymentByWaiter");
    expect(args[3]).toBe("Split");
    expect(args[5]).toBe(splits);
    // The ledger was read, not rewritten: no tender is recorded by a settle that
    // did not carry any.
    expect(callsTo("RecordBillTenders")).toHaveLength(0);
  });
});

// ============================================================================
// 038 — THE TILL
// ============================================================================

describe("038: the counter a sale was rung on", () => {
  const COUNTER = "c0c0c0c0-1111-4111-8111-c0c0c0c0c0c0";

  test("X-Counter-Id attributes the settled bill to that till", async () => {
    mockNext.counters = [{ id: COUNTER, code: "C1", active: true }];
    const answer = await settle({ payment_method: "Cash" }, { "x-counter-id": COUNTER });

    expect(answer.status).toBe(200);
    expect(argsOf("SetBillCounter")).toEqual([RES, "bill-1", COUNTER]);
    expect(answer.body.counter_id).toBe(COUNTER);
    // The settle itself is untouched by the attribution.
    expect(argsOf("ConfirmBillPaymentByWaiter")).toEqual([RES, ORDER, EMP, "Cash", null, undefined]);
  });

  test("an UNKNOWN till is refused BEFORE any money moves", async () => {
    mockNext.counters = [{ id: "some-other-till", code: "C2", active: true }];
    const answer = await settle({ payment_method: "Cash" }, { "x-counter-id": COUNTER });

    expect(answer.status).toBe(400);
    expect(answer.body.error).toMatch(/No billing counter/);
    // The whole point of checking first: a misconfigured terminal must not be
    // able to settle a bill and attribute the sale to nothing.
    expect(callsTo("ConfirmBillPaymentByWaiter")).toHaveLength(0);
    expect(callsTo("SetBillCounter")).toHaveLength(0);
  });

  test("no counter on the request means the outlet's single till, and nothing is written", async () => {
    await settle({ payment_method: "Cash" });
    expect(callsTo("ListBillingCounters")).toHaveLength(0);
    expect(callsTo("SetBillCounter")).toHaveLength(0);
  });

  test("an inactive till still settles — retiring a counter must not strand a guest at it", async () => {
    mockNext.counters = [{ id: COUNTER, code: "C1", active: false }];
    const answer = await settle({ payment_method: "Cash" }, { "x-counter-id": COUNTER });
    expect(answer.status).toBe(200);
    expect(argsOf("SetBillCounter")).toEqual([RES, "bill-1", COUNTER]);
  });
});
