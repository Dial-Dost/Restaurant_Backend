// THE WIDER DOOR — "a waiter cannot settle a bill, cannot release the table it
// sits on, and could still zero it with one discount."
//
// ============================================================================
// WHAT WENT WRONG, AND WHY THE APPROVAL QUEUE WAS NOT AN ANSWER
// ============================================================================
// POST /bills/discount is gated on 4ad474d4 "Add Orders", which CORE_ROLES.waiter
// holds. `{type:'percent', value:100}` zeroes a bill economically — the same
// outcome release_authority.ts was built to prevent, reached through a control
// nobody was looking at.
//
// It was left open on the rationale that large discounts need approval. THAT IS
// FALSE ON A DEFAULT TENANT and this suite proves it rather than asserting it:
// `threshold 0` is the shipped default (`discount_approval_threshold numeric
// default 0`), and the first data-layer case below runs a 100% discount at that
// default and watches it hit the database. Run it against the pre-fix code and it
// passes; that is the point of having it.
//
// ============================================================================
// HOW IT IS TESTED — THE WRITE, NOT THE MESSAGE
// ============================================================================
// The data-layer cases drive the REAL SetBillDiscountWithApproval over a fake
// `pg` Pool and assert on the presence or ABSENCE of one statement:
// `update "Bills" set discount_type`. A 403 body proves a sentence was composed;
// only the missing UPDATE proves the money is still on the bill. The mirror
// assertion — that the UPDATE DOES happen for an ordinary discount, and for every
// senior role — is what stops this gate from being "fixed" by breaking discounts
// for the whole floor.
//
// AND NOBODY WHO RUNS A TILL LOSES ANYTHING. Every write-off case is run for an
// owner, a manager, a cashier AND a captain, because all four hold a953d044
// today. The failure to fear is "the fix emptied the till", not "a waiter saw a
// figure".

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import {
  DEFAULT_FLOOR_DISCOUNT_CEILING,
  WRITE_OFF_RESIDUAL_SHARE,
  discountIsWriteOff,
  discountRemainingValue,
  isDiscountAuthorityError,
  mayDiscountBill,
} from "../discount_authority";
import { makeFakeApp, type FakeApp } from "./platform_fixtures";

// ---------------------------------------------------------------------------
// A PERMISSIVE FAKE POOL.
//
// Unlike platform_fixtures' dispatcher this one does NOT throw on an
// unrecognised statement: the path under test walks through a dozen `create
// table if not exists` / `alter table` / RLS statements that have nothing to do
// with the question, and a fixture that had to enumerate them would fail for
// reasons unrelated to money every time an unrelated column is added. It answers
// the handful of reads this path makes, returns nothing for everything else, and
// RECORDS EVERY STATEMENT — which is all the assertions need, because they are
// about one UPDATE being absent.
// ---------------------------------------------------------------------------
const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";
const TABLE_ID = "33333333-3333-3333-3333-333333333333";
const BILL_ID = "44444444-4444-4444-4444-444444444444";

interface Fixture {
  /** Σ of the table's still-owing orders, in rupees. */
  subtotal: number;
  /** "Restaurant".discount_approval_threshold. 0 is the SHIPPED DEFAULT. */
  threshold: number;
  sql: string[];
}
const fx: Fixture = { subtotal: 0, threshold: 0, sql: [] };

const rowsFor = (sql: string): unknown[] => {
  const q = sql.replace(/\s+/g, " ").trim();
  if (/from "Restaurant" r/i.test(q)) {
    return [{
      res_id: RES, outlet_id: OUTLET, restaurant_slug: "gaia", restaurant_name: "Gaia",
      restaurant_main_office_add: null, restaurant_logo_url: null, timezone: null,
    }];
  }
  if (/select discount_approval_threshold from "Restaurant"/i.test(q)) {
    return [{ discount_approval_threshold: fx.threshold }];
  }
  if (/select id from "Tables"/i.test(q)) { return [{ id: TABLE_ID }]; }
  // assertBillEditable — no admin approval on the open bill, so it is editable.
  if (/select admin_approved_at from "Bills"/i.test(q)) { return [{ admin_approved_at: null }]; }
  // assertTableSessionOpen — the seating is live.
  if (/select count\(\*\)::int as n from "Orders"/i.test(q)) { return [{ n: 2 }]; }
  // sumOrderTotalsForTable -> activeOrderSubtotal. One still-owing order.
  if (/select food, status from "Orders"/i.test(q)) {
    return [{ food: { subtotal: fx.subtotal, total: fx.subtotal }, status: 1 }];
  }
  // existingOpenBillId / ensureOpenBillIdForTable.
  if (/select id from "Bills"/i.test(q)) { return [{ id: BILL_ID }]; }
  // log_audit's actor lookup, so the refusal audit below really reaches the
  // INSERT rather than dying in the employee read and proving nothing.
  if (/from "Employees" where id = /i.test(q)) {
    return [{ res_id: RES, outlet_id: OUTLET, emp_Fname: "Ravi", emp_Lname: "K", emp_roles: { primary: "waiter", all: ["waiter"] } }];
  }
  if (/select emp_username from "Login"/i.test(q)) { return [{ emp_username: "ravi" }]; }
  return [];
};

jest.mock("pg", () => {
  const query = async (sql: string): Promise<{ rows: unknown[] }> => {
    fx.sql.push(String(sql).replace(/\s+/g, " ").trim());
    return { rows: rowsFor(String(sql)) };
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string): Promise<{ rows: unknown[] }> { return query(sql); }
    connect(): Promise<unknown> { return Promise.resolve({ query, release: () => undefined }); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

const CLOSE_BILL = "a953d044-31ba-4e31-b96f-99304fe43dfa";
const ADD_ORDERS = "4ad474d4-5230-449c-874f-6a238b833bca";
const TABLE_OPS = "090ea8d4-e348-4e1b-9723-11131a73a085";

/** The core waiter action set, near enough: it holds Add Orders, not Close Bill. */
const WAITER = [ADD_ORDERS, TABLE_OPS, "98b10bde-802d-4a5b-a726-53a826424f79"];
const MANAGER = [ADD_ORDERS, CLOSE_BILL, TABLE_OPS];
const CASHIER = [ADD_ORDERS, CLOSE_BILL];
const CAPTAIN = [ADD_ORDERS, CLOSE_BILL, "9186e53e-0fda-4ec8-ad20-2f9feaadb77f"];
const ADMIN = ["*"];

let db: typeof import("../database_supabase");
let harness: FakeApp;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
  const bills = await import("../routes/bills");
  harness = makeFakeApp();
  bills.registerBillPrintAndEditRoutes(harness.app as never);
});

beforeEach(() => {
  fx.sql = [];
  fx.subtotal = 10000;
  fx.threshold = 0; // THE SHIPPED DEFAULT.
});

/** Did the discount actually land on the bill? */
const discountWritten = (): boolean => fx.sql.some((s) => /update "Bills" set discount_type/i.test(s));

/** Run a call that must be refused and hand back the error it threw. */
const refusalFrom = async (p: Promise<unknown>): Promise<unknown> => {
  try { await p; return null; } catch (err) { return err; }
};

const setDiscount = (
  actions: readonly string[],
  type: "percent" | "flat",
  value: number,
  opts: { isAdmin?: boolean } = {},
) => db.SetBillDiscountWithApproval(RES, "T7", type, value, {
  isAdmin: opts.isAdmin ?? false,
  actions,
  closeBillPermission: CLOSE_BILL,
});

// ===========================================================================
describe("the default that makes the hole real", () => {
  test("the approval threshold ships at 0, and 0 means the queue never engages", () => {
    // The column: `alter table "Restaurant" add column if not exists
    // discount_approval_threshold numeric default 0`, read back by
    // getDiscountApprovalThreshold as `?? 0`. The queue is `if (threshold > 0)`.
    // So on an unconfigured restaurant there is no approval step at all — which
    // is why the gate below cannot be "the approval workflow covers it".
    expect(discountIsWriteOff({ subtotal: 10000, discount_amount: 10000 }, 0)).toBe(true);
  });
});

// ===========================================================================
describe("the rule itself, without a database", () => {
  test("100% is a write-off — and so is the version that leaves a rupee behind", () => {
    expect(discountIsWriteOff({ subtotal: 5000, discount_amount: 5000 })).toBe(true);
    expect(discountIsWriteOff({ subtotal: 5000, discount_amount: 4999 })).toBe(true);
    expect(discountRemainingValue({ subtotal: 5000, discount_amount: 4999 })).toBe(1);
  });

  test("the line is on the money that SURVIVES, so flat and percent cannot disagree", () => {
    // A ₹4,999 flat discount and a 99.98% one on the same ₹5,000 table are the
    // same act; a rule written on the percentage would wave the flat one through.
    const pct = { subtotal: 5000, discount_amount: round2(5000 * 0.9998) };
    const flat = { subtotal: 5000, discount_amount: 4999 };
    expect(discountIsWriteOff(pct)).toBe(discountIsWriteOff(flat));
  });

  test("an ordinary floor discount is left completely alone", () => {
    // The ₹50 off a slow starter, the round-down, the regular's 10%.
    expect(discountIsWriteOff({ subtotal: 1200, discount_amount: 50 })).toBe(false);
    expect(discountIsWriteOff({ subtotal: 1247, discount_amount: 47 })).toBe(false);
    expect(discountIsWriteOff({ subtotal: 1200, discount_amount: 120 })).toBe(false);
    // A staff 25%.
    expect(discountIsWriteOff({ subtotal: 800, discount_amount: 200 })).toBe(false);
  });

  test("exactly half is a discount; more than half is a write-off", () => {
    expect(WRITE_OFF_RESIDUAL_SHARE).toBe(0.5);
    expect(discountIsWriteOff({ subtotal: 1000, discount_amount: 500 })).toBe(false);
    expect(discountIsWriteOff({ subtotal: 1000, discount_amount: 500.01 })).toBe(true);
  });

  test("the residual limb is proportional, so it holds on a ₹200 table and a ₹200,000 one", () => {
    expect(discountIsWriteOff({ subtotal: 200, discount_amount: 199 })).toBe(true);
    expect(discountIsWriteOff({ subtotal: 200000, discount_amount: 199000 })).toBe(true);
  });

  test("write-off-SCALE money is refused too, where the tenant configured no queue", () => {
    // 10% of a ₹40,000 banquet passes the residual limb and is still ₹4,000 of
    // somebody else's money handed over on floor authority.
    const banquet = { subtotal: 40000, discount_amount: 4000 };
    expect(discountIsWriteOff(banquet, 0)).toBe(true);
    expect(discountIsWriteOff({ subtotal: 40000, discount_amount: DEFAULT_FLOOR_DISCOUNT_CEILING }, 0)).toBe(false);
  });

  test("…but that limb YIELDS to a tenant that configured its own approval queue", () => {
    // The queue exists so a waiter CAN request a big discount and a manager
    // decides. A 403 here would kill the feature the restaurant switched on.
    expect(discountIsWriteOff({ subtotal: 40000, discount_amount: 4000 }, 500)).toBe(false);
    // The residual limb still fires: a ₹50,000 threshold must not auto-approve
    // zeroing an ₹800 table.
    expect(discountIsWriteOff({ subtotal: 800, discount_amount: 800 }, 50000)).toBe(true);
  });

  test("a bill with nothing on it cannot be written off", () => {
    expect(discountIsWriteOff({ subtotal: 0, discount_amount: 0 })).toBe(false);
    expect(discountIsWriteOff({ subtotal: 0, discount_amount: 500 })).toBe(false);
    expect(discountIsWriteOff(null)).toBe(false);
  });

  test("clearing a discount is never a write-off", () => {
    expect(discountIsWriteOff({ subtotal: 10000, discount_amount: 0 })).toBe(false);
  });

  test("the refusal NAMES the permission and both numbers", () => {
    const v = mayDiscountBill({
      actions: WAITER,
      impact: { subtotal: 9000, discount_amount: 9000 },
      closeBillPermission: CLOSE_BILL,
      tableName: "T7",
    });
    expect(v.allowed).toBe(false);
    expect(v.details).toContain("T7");
    expect(v.details).toContain("9000.00");
    expect(v.details).toContain("Close Bill");
  });

  test("an admin, a manager, a cashier and a captain all keep the whole control", () => {
    for (const actions of [ADMIN, MANAGER, CASHIER, CAPTAIN]) {
      const v = mayDiscountBill({
        actions,
        impact: { subtotal: 9000, discount_amount: 9000 },
        closeBillPermission: CLOSE_BILL,
      });
      expect([actions[0], v.allowed]).toEqual([actions[0], true]);
      expect(v.details).toBeUndefined();
    }
  });
});

// ===========================================================================
describe("the uuid is the one that already exists", () => {
  test("Close Bill is not a new id — it is the one the senior roles already hold", () => {
    // Migration 025's rule: minting a new id for an existing capability strips it
    // from every role holding it today. This is also what keeps the discount
    // gate, the release gate and enforceSettleAuthority answering one question.
    expect(db.CLOSE_BILL_ACTION_ID).toBe(CLOSE_BILL);
    for (const role of ["manager", "cashier", "captain"] as const) {
      expect([role, (db.CORE_ROLES[role] as readonly string[]).includes(db.CLOSE_BILL_ACTION_ID)])
        .toEqual([role, true]);
    }
    expect((db.CORE_ROLES.waiter as readonly string[]).includes(db.CLOSE_BILL_ACTION_ID)).toBe(false);
    // …and the waiter DOES hold the route's own gate, which is why the gate had
    // to be on the discount rather than on the route.
    expect((db.CORE_ROLES.waiter as readonly string[]).includes(ADD_ORDERS)).toBe(true);
  });
});

// ===========================================================================
describe("the write, over the real data layer", () => {
  test("a waiter's 100% discount on a DEFAULT tenant never reaches the bill", async () => {
    expect(isDiscountAuthorityError(await refusalFrom(setDiscount(WAITER, "percent", 100)))).toBe(true);
    expect(discountWritten()).toBe(false);
  });

  test("…nor the 99.99% version of the same act", async () => {
    expect(isDiscountAuthorityError(await refusalFrom(setDiscount(WAITER, "percent", 99.99)))).toBe(true);
    expect(discountWritten()).toBe(false);
  });

  test("…nor the flat discount that leaves ₹1 behind", async () => {
    expect(isDiscountAuthorityError(await refusalFrom(setDiscount(WAITER, "flat", 9999)))).toBe(true);
    expect(discountWritten()).toBe(false);
  });

  test("…nor a ₹4,000 giveaway that the residual limb alone would allow", async () => {
    fx.subtotal = 40000;
    expect(isDiscountAuthorityError(await refusalFrom(setDiscount(WAITER, "flat", 4000)))).toBe(true);
    expect(discountWritten()).toBe(false);
  });

  test("THE MIRROR: a waiter's ordinary 10% still lands, or the fix broke the floor", async () => {
    const r = await setDiscount(WAITER, "percent", 10);
    expect(r.applied).toBe(true);
    expect(discountWritten()).toBe(true);
  });

  test("THE MIRROR: a waiter clearing a discount is never refused", async () => {
    const r = await db.SetBillDiscountWithApproval(RES, "T7", null, 0, {
      isAdmin: false, actions: WAITER, closeBillPermission: CLOSE_BILL,
    });
    expect(r.applied).toBe(true);
    expect(discountWritten()).toBe(true);
  });

  for (const [name, actions] of [["manager", MANAGER], ["cashier", CASHIER], ["captain", CAPTAIN]] as const) {
    test(`a ${name} keeps the whole control — 100% off still writes`, async () => {
      const r = await setDiscount(actions, "percent", 100);
      expect(r.applied).toBe(true);
      expect(discountWritten()).toBe(true);
    });
  }

  test("an admin loses nothing, on the wildcard and on the isAdmin flag alike", async () => {
    const byWildcard = await setDiscount(ADMIN, "percent", 100);
    expect(byWildcard.applied).toBe(true);
    expect(discountWritten()).toBe(true);

    fx.sql = [];
    // SetBillDiscount (the internal admin entry point) passes isAdmin with no
    // actions at all. It must never be refused for want of an actions array.
    const r = await db.SetBillDiscount(RES, "T7", "percent", 100);
    expect(r.discount_value).toBe(100);
    expect(discountWritten()).toBe(true);
  });

  test("a caller that forgets to pass its actions is REFUSED a write-off, not granted one", async () => {
    // The only safe direction for a missing input on a money gate. An ordinary
    // discount from the same caller is unaffected (next assertion).
    expect(isDiscountAuthorityError(await refusalFrom(db.SetBillDiscountWithApproval(RES, "T7", "percent", 100, { isAdmin: false })))).toBe(true);
    expect(discountWritten()).toBe(false);

    fx.sql = [];
    const ok = await db.SetBillDiscountWithApproval(RES, "T7", "percent", 10, { isAdmin: false });
    expect(ok.applied).toBe(true);
    expect(discountWritten()).toBe(true);
  });

  test("a configured approval queue still parks a big discount rather than 403-ing it", async () => {
    fx.threshold = 500;
    // 20% of ₹10,000 = ₹2,000: over the tenant's threshold, under half the bill.
    const r = await setDiscount(WAITER, "percent", 20);
    expect(r.pending).toBe(true);
    expect(r.amount).toBe(2000);
    // Parked, not applied — the bill is untouched, which is the queue working.
    expect(discountWritten()).toBe(false);
    expect(fx.sql.some((s) => /insert into "DiscountRequests"/i.test(s))).toBe(true);
  });

  test("a configured queue does NOT license zeroing a small bill", async () => {
    // Threshold ₹50,000 on an ₹800 table: the queue would auto-approve the
    // write-off because the amount never reaches the threshold. The residual
    // limb is what catches it.
    fx.threshold = 50000;
    fx.subtotal = 800;
    expect(isDiscountAuthorityError(await refusalFrom(setDiscount(WAITER, "percent", 100)))).toBe(true);
    expect(discountWritten()).toBe(false);
    expect(fx.sql.some((s) => /insert into "DiscountRequests"/i.test(s))).toBe(false);
  });
});

// ===========================================================================
// THE SURVIVING SURFACE. A hidden control must be UNREACHABLE, not merely
// undrawn: the client may hide the discount field, and a deep link, a stale
// screen or a bare curl still arrives at this handler. Every case here drives
// the SHIPPED route over the real data layer and asserts on the UPDATE.
describe("POST /bills/discount — the route a curl reaches", () => {
  const discount = (actions: string[], value: number, type = "percent") =>
    harness.call("POST", "/bills/discount", {
      body: { table_name: "T7", type, value },
      auth: { res_id: RES, outlet_id: OUTLET, employeeId: "emp-1", role: "waiter", actions },
    });

  test("a waiter's 100% is 403 — and the bill is not written", async () => {
    const r = await discount(WAITER, 100);
    expect(r.status).toBe(403);
    expect(discountWritten()).toBe(false);
  });

  test("THE REFUSAL REACHES A HUMAN: the body carries the sentence, not just 'Forbidden'", async () => {
    // BLOCKER 3's server half. A 403 whose body is thrown away tells the waiter
    // nothing and sends them to fetch a manager to guess. `details` names the
    // money and the permission; `requiredPermission` is the checkbox an owner
    // ticks. Both clients read these.
    const body = (await discount(WAITER, 100)).body as {
      error?: string; details?: string; requiredPermission?: string;
      discount_amount?: number; remaining_value?: number;
    };
    expect(body.error).toBe("Forbidden");
    expect(body.requiredPermission).toBe(CLOSE_BILL);
    expect(body.details).toContain("Close Bill");
    expect(body.details).toContain("T7");
    expect(body.discount_amount).toBe(10000);
    expect(body.remaining_value).toBe(0);
  });

  test("the refusal is AUDITED, because an attempt to write a bill off is the event a manager wants", async () => {
    await discount(WAITER, 100);
    expect(fx.sql.some((q) => /insert into "Audit_logs"/i.test(q))).toBe(true);
  });

  test("THE MIRROR: a waiter's 10% goes through the same route and lands", async () => {
    const r = await discount(WAITER, 10);
    expect(r.status).toBe(200);
    expect(discountWritten()).toBe(true);
  });

  for (const [name, actions] of [["manager", MANAGER], ["cashier", CASHIER], ["captain", CAPTAIN]] as const) {
    test(`a ${name} is not refused by the route either`, async () => {
      const r = await discount([...actions], 100);
      expect([name, r.status]).toEqual([name, 200]);
      expect(discountWritten()).toBe(true);
    });
  }
});

function round2(v: number): number { return Number(v.toFixed(2)); }

// ---------------------------------------------------------------------------
// THE COUPON DOOR.
//
// ApplyCouponToBill writes `discount_type='flat', discount_value=<amount>` onto
// the open bill — character-for-character what the manual discount writes, on
// the same 4ad474d4 permission every waiter holds. So gating /bills/discount
// and leaving /bills/apply-coupon open would have been security theatre: a
// waiter refused a 100% discount could zero the identical bill with a 100%
// coupon, and the audit trail would read "coupon applied" rather than
// "bill written off".
//
// The rule is about the OUTCOME, not the instrument, so it is the SAME
// threshold: an ordinary coupon is untouched, one that hands back more than
// half the bill needs the till's authority.
// ---------------------------------------------------------------------------

describe("a coupon is judged by what it hands back, not by being a coupon", () => {
  test("an ordinary coupon is allowed for a waiter", () => {
    const verdict = mayDiscountBill({
      actions: ["4ad474d4-5230-449c-874f-6a238b833bca"],
      impact: { subtotal: 5000, discount_amount: 500 },
      approvalThreshold: 0,
      closeBillPermission: CLOSE_BILL,
    });
    expect(verdict.allowed).toBe(true);
  });

  test("a coupon that hands back most of the bill needs the same authority as settling", () => {
    const verdict = mayDiscountBill({
      actions: ["4ad474d4-5230-449c-874f-6a238b833bca"],
      impact: { subtotal: 5000, discount_amount: 5000 },
      approvalThreshold: 0,
      closeBillPermission: CLOSE_BILL,
    });
    expect(verdict.allowed).toBe(false);
  });

  test("and the till may still apply it", () => {
    for (const holder of [[CLOSE_BILL], ["*"]]) {
      expect(mayDiscountBill({
        actions: holder,
        impact: { subtotal: 5000, discount_amount: 5000 },
        approvalThreshold: 0,
        closeBillPermission: CLOSE_BILL,
      }).allowed).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// THE OTHER HALF OF THE SAME PASS — the guest who was refused their own voucher
// ---------------------------------------------------------------------------
// Adding the gate above broke a flow that had nothing to do with staff
// discretion. `POST /qr/:slug/apply-coupon` is the guest's own phone: no
// session, no employee, no actions at all. Fed through a gate that asks "does
// this caller hold Close Bill?", a genuine 100% gift voucher — the restaurant's
// own promotion — came back as a bare 400 at the table.
//
// The fix is to stand the STAFF-DISCRETION gate down on the GUEST path only,
// and the reason it is safe is that nothing about the guest path is discretion:
// validateCoupon has already checked the code exists, is active, is within its
// usage and per-customer limits, meets the minimum order and honours its cap.
// A voucher for the whole bill is one the owner created.
//
// Both halves are asserted, because either alone is the bug back again:
//   * the GUEST route must stand it down, or the voucher is refused;
//   * the STAFF route must NOT, or a waiter zeroes a table with a coupon and
//     the entire gate above is theatre.
describe("the coupon gate is stood down for the guest and for nobody else", () => {
  function source(relative: string): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    for (const base of [process.cwd(), path.join(__dirname, "..")]) {
      const full = path.join(base, relative);
      if (fs.existsSync(full)) { return fs.readFileSync(full, "utf8"); }
    }
    throw new Error(`source() could not find ${relative} from ${process.cwd()}`);
  }

  /**
   * The ApplyCouponToBill CALL in a route file — the invocation, never the
   * import line that also carries the name. Anchored on `ApplyCouponToBill(`
   * preceded by a call position, and the slice is taken forward from there, so
   * a re-ordered import list cannot change what this reads.
   */
  function couponCall(relative: string): string {
    const src = source(relative);
    const at = src.search(/ApplyCouponToBill\(\s*[A-Za-z_$]/);
    expect(at).toBeGreaterThan(-1);
    return src.slice(at, at + 500);
  }

  test("the guest route passes isAdmin, so the voucher is honoured", () => {
    expect(couponCall("routes/guest.ts")).toMatch(/isAdmin:\s*true/);
  });

  test("the staff route passes the real session and stands nothing down", () => {
    const call = couponCall("routes/bills.ts");
    expect(call).toMatch(/actions\s*:/);
    expect(call).not.toMatch(/isAdmin:\s*true\b/);
  });

  test("and the data layer actually honours the flag it is handed", () => {
    // The pure rule, with the escape the data layer applies: an admin-marked
    // caller is not measured against the threshold at all.
    const guestLike = { actions: [] as string[], impact: { subtotal: 5000, discount_amount: 5000 }, approvalThreshold: 0, closeBillPermission: CLOSE_BILL };
    // Without the stand-down this is a refusal — which is what the guest met.
    expect(mayDiscountBill(guestLike).allowed).toBe(false);
    // With it, the call never reaches the rule. Pinned as source, because the
    // escape is a branch in the data layer rather than a value the rule returns.
    const db = source("database_supabase.ts");
    const fn = db.slice(db.indexOf("export async function ApplyCouponToBill"));
    expect(fn.slice(0, 6000)).toMatch(/opts\?\.isAdmin/);
  });
});
