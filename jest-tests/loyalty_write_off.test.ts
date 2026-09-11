// THE FIFTH DOOR — "a waiter cannot settle a bill, cannot release the table,
// cannot discount it to nothing and cannot coupon it to nothing… and could still
// redeem it to nothing."
//
// ============================================================================
// WHAT WAS OPEN, AND WHY IT IS THE SAME HOLE AS THE OTHER TWO
// ============================================================================
// POST /loyalty/redeem is gated on 4ad474d4 "Add Orders", which CORE_ROLES.waiter
// holds, and it ends in `applyDiscountToOpenBill(…, "flat", discount, …)` — the
// SAME statement SetBillDiscountWithApproval and ApplyCouponToBill end in. Both
// of those now ask discount_authority.ts whether the money being handed back is
// a write-off. This one asked nothing. Its only clamp was
// `if (discount > subtotal) throw`, which PERMITS a redemption exactly equal to
// the subtotal: the bill reached zero by design, on floor authority, through the
// one door nobody had looked at.
//
// It also skipped assertTableSessionOpen — the post-settle lock both siblings
// carry — so a redemption could be applied to an already-settled session, burn
// the customer's points and mint a phantom bill on the closed seating.
//
// AND THE DEFAULT MAKES IT REAL. "Restaurant".loyalty_point_value DEFAULTS TO 1
// (`alter table "Restaurant" add column if not exists loyalty_point_value numeric
// default 1`, read back as `?? 1`), so redemption is ON for every tenant that has
// never opened the settings page. The first case below pins that default rather
// than asserting it in prose.
//
// ============================================================================
// HOW IT IS TESTED — THE WRITE, NOT THE MESSAGE
// ============================================================================
// A HIDDEN CONTROL IS NOT A GATE. Every case drives the REAL RedeemLoyaltyPoints
// (and, for the route cases, the SHIPPED handler in routes/loyalty.ts) over a
// fake `pg` Pool and asserts on the presence or ABSENCE of one statement:
// `update "Bills" set discount_type`. A 403 body proves a sentence was composed;
// only the missing UPDATE proves the money is still on the bill.
//
// AND NOBODY WHO RUNS A TILL LOSES ANYTHING. Every refused case is re-run for an
// owner, a manager, a cashier AND a captain — all four hold a953d044 today — and
// the ordinary 200-point redemption is asserted to still land for a plain
// waiter. "The fix emptied the till" is the failure this suite exists to catch.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { isDiscountAuthorityError } from "../discount_authority";
import { makeFakeApp, type FakeApp } from "./platform_fixtures";

// ---------------------------------------------------------------------------
// A PERMISSIVE FAKE POOL — same shape and same reasoning as
// discount_write_off.test.ts: the path under test walks a dozen `create table if
// not exists` / `alter table` / RLS statements that have nothing to do with the
// question, so the fixture answers the handful of reads it makes, returns
// nothing for everything else, and RECORDS EVERY STATEMENT.
// ---------------------------------------------------------------------------
const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";
const TABLE_ID = "33333333-3333-3333-3333-333333333333";
const BILL_ID = "44444444-4444-4444-4444-444444444444";

interface Fixture {
  /** Σ of the table's still-owing orders, in rupees. */
  subtotal: number;
  /** "Restaurant".loyalty_point_value. 1 is the SHIPPED DEFAULT. */
  pointValue: number;
  /** The customer's accumulated balance, in points. */
  balance: number;
  /** "Restaurant".discount_approval_threshold. 0 is the SHIPPED DEFAULT. */
  threshold: number;
  /** Orders still owing on the table — 0 means the session is SETTLED. */
  openOrders: number;
  /** customer_phone values carried by the table's live session, if any. */
  sessionPhones: string[];
  sql: string[];
}
const fx: Fixture = {
  subtotal: 0, pointValue: 1, balance: 0, threshold: 0, openOrders: 2, sessionPhones: [], sql: [],
};

const rowsFor = (sql: string): unknown[] => {
  const q = sql.replace(/\s+/g, " ").trim();
  if (/from "Restaurant" r/i.test(q)) {
    return [{
      res_id: RES, outlet_id: OUTLET, restaurant_slug: "gaia", restaurant_name: "Gaia",
      restaurant_main_office_add: null, restaurant_logo_url: null, timezone: null,
    }];
  }
  if (/select loyalty_earn_per_100, loyalty_point_value from "Restaurant"/i.test(q)) {
    return [{ loyalty_earn_per_100: 5, loyalty_point_value: fx.pointValue }];
  }
  if (/select discount_approval_threshold from "Restaurant"/i.test(q)) {
    return [{ discount_approval_threshold: fx.threshold }];
  }
  if (/coalesce\(sum\(points\), 0\) as balance from "LoyaltyLedger"/i.test(q)) {
    return [{ balance: fx.balance }];
  }
  if (/select points, kind, note, bill_id, created_at from "LoyaltyLedger"/i.test(q)) {
    return [{ points: 500, kind: "earn", note: "Earned on bill settle (₹10000)", bill_id: BILL_ID, created_at: new Date() }];
  }
  if (/select id from "Tables"/i.test(q)) { return [{ id: TABLE_ID }]; }
  // assertBillEditable — no admin approval on the open bill, so it is editable.
  if (/select admin_approved_at from "Bills"/i.test(q)) { return [{ admin_approved_at: null }]; }
  // assertTableSessionOpen — is the seating still live?
  if (/select count\(\*\)::int as n from "Orders"/i.test(q)) { return [{ n: fx.openOrders }]; }
  // tableSessionCustomerPhones — who does the session say is sitting here?
  if (/select distinct nullif\(trim\(\(food\)::jsonb->>'customer_phone'\)/i.test(q)) {
    return fx.sessionPhones.map((phone) => ({ phone }));
  }
  // sumOrderTotalsForTable -> activeOrderSubtotal. One still-owing order.
  if (/select food, status from "Orders"/i.test(q)) {
    return [{ food: { subtotal: fx.subtotal, total: fx.subtotal }, status: 1 }];
  }
  // existingOpenBillId / ensureOpenBillIdForTable.
  if (/select id from "Bills"/i.test(q)) { return [{ id: BILL_ID }]; }
  // log_audit's actor lookup, so a refusal audit really reaches the INSERT.
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
const VIEW_BILL = "98b10bde-802d-4a5b-a726-53a826424f79";

/** The core waiter action set, near enough: it holds Add Orders, not Close Bill. */
const WAITER = [ADD_ORDERS, TABLE_OPS, VIEW_BILL];
const MANAGER = [ADD_ORDERS, CLOSE_BILL, TABLE_OPS, VIEW_BILL];
const CASHIER = [ADD_ORDERS, CLOSE_BILL];
const CAPTAIN = [ADD_ORDERS, CLOSE_BILL, "9186e53e-0fda-4ec8-ad20-2f9feaadb77f"];
const ADMIN = ["*"];
/** A logged-in session with NOTHING granted — a valet, a kitchen tablet, a
 *  freshly-made custom role. `validate` let this read a customer's history. */
const NOBODY: string[] = [];

const PHONE = "9876543210";

let db: typeof import("../database_supabase");
let harness: FakeApp;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
  const loyalty = await import("../routes/loyalty");
  harness = makeFakeApp();
  loyalty.registerLoyaltyRoutes(harness.app as never);
});

beforeEach(() => {
  fx.sql = [];
  fx.subtotal = 10000;
  fx.pointValue = 1;      // THE SHIPPED DEFAULT — redemption is ON.
  fx.balance = 50000;     // a long-standing regular's accumulated balance.
  fx.threshold = 0;       // THE SHIPPED DEFAULT — no approval queue.
  fx.openOrders = 2;      // the seating is live.
  fx.sessionPhones = [];  // POS-punched orders carry no phone (the usual case).
});

/** Did the redemption actually land on the bill? */
const discountWritten = (): boolean => fx.sql.some((s) => /update "Bills" set discount_type/i.test(s));
/** Was the customer's balance actually spent? */
const ledgerWritten = (): boolean => fx.sql.some((s) => /insert into "LoyaltyLedger"/i.test(s));

/** Run a call that must be refused and hand back the error it threw. */
const refusalFrom = async (p: Promise<unknown>): Promise<unknown> => {
  try { await p; return null; } catch (err) { return err; }
};

const redeem = (
  actions: readonly string[] | null | undefined,
  points: number,
  opts: { isAdmin?: boolean; phone?: string; table?: string } = {},
) => db.RedeemLoyaltyPoints(RES, {
  phone: opts.phone ?? PHONE,
  points,
  table_name: opts.table ?? "T7",
  isAdmin: opts.isAdmin ?? false,
  actions: actions ?? undefined,
  closeBillPermission: CLOSE_BILL,
});

// ===========================================================================
describe("the default that makes the hole real", () => {
  test("point_value ships at 1, so redemption is ON for a tenant that never configured it", async () => {
    // `alter table "Restaurant" add column if not exists loyalty_point_value
    // numeric default 1`, read back by getLoyaltyConfig as `?? 1`. The feature is
    // not opt-in, so "most tenants have loyalty switched off" is not a defence.
    const settings = await db.GetLoyaltyAccount(RES, PHONE);
    expect(settings.point_value).toBe(1);
  });

  test("the OLD clamp let a redemption land exactly on zero — that is the bug, stated", () => {
    // The shipped guard was `if (discount > subtotal) throw`. STRICTLY greater:
    // 10,000 points × ₹1 against a ₹10,000 bill passed it and zeroed the bill.
    const discount = 10000 * 1;
    expect(discount > fx.subtotal).toBe(false);        // the old clamp allows it…
    expect(discount >= fx.subtotal * 0.5).toBe(true);  // …and it is a write-off.
  });
});

// ===========================================================================
describe("the write, over the real data layer", () => {
  test("a waiter redeeming the WHOLE subtotal never reaches the bill", async () => {
    const err = await refusalFrom(redeem(WAITER, 10000));
    expect(isDiscountAuthorityError(err)).toBe(true);
    expect(discountWritten()).toBe(false);
    // And the customer's points are still theirs — the refusal is before both writes.
    expect(ledgerWritten()).toBe(false);
  });

  test("…nor the version that leaves ₹1 behind", async () => {
    expect(isDiscountAuthorityError(await refusalFrom(redeem(WAITER, 9999)))).toBe(true);
    expect(discountWritten()).toBe(false);
  });

  test("…nor more than half the bill, which is where the line actually sits", async () => {
    expect(isDiscountAuthorityError(await refusalFrom(redeem(WAITER, 5001)))).toBe(true);
    expect(discountWritten()).toBe(false);
  });

  test("…nor ₹4,000 off a ₹40,000 banquet, which the residual limb alone would allow", async () => {
    fx.subtotal = 40000;
    expect(isDiscountAuthorityError(await refusalFrom(redeem(WAITER, 4000)))).toBe(true);
    expect(discountWritten()).toBe(false);
  });

  test("a high point_value cannot smuggle the same write-off past the gate", async () => {
    // The rule is on the MONEY HANDED BACK, not on the points: 100 points at
    // ₹100 each is the same ₹10,000 as 10,000 points at ₹1.
    fx.pointValue = 100;
    expect(isDiscountAuthorityError(await refusalFrom(redeem(WAITER, 100)))).toBe(true);
    expect(discountWritten()).toBe(false);
  });

  test("THE MIRROR: a waiter's ordinary 200-point redemption still lands", async () => {
    const r = await redeem(WAITER, 200);
    expect(r.discount).toBe(200);
    expect(discountWritten()).toBe(true);
    expect(ledgerWritten()).toBe(true);
  });

  test("THE MIRROR: exactly half the bill is still a floor redemption", async () => {
    // `>` not `>=` in limb 1: the round number everybody types is a discount, not
    // a write-off. ₹1,500 also stays under the ₹2,000 magnitude ceiling, so this
    // is the case both limbs agree is ordinary.
    fx.subtotal = 3000;
    const r = await redeem(WAITER, 1500);
    expect(r.discount).toBe(1500);
    expect(discountWritten()).toBe(true);
  });

  test("…and write-off-SCALE money is refused even at exactly half, where no queue exists", async () => {
    // Limb 2. ₹5,000 off a ₹10,000 table survives limb 1 by a hair and is still
    // ₹5,000 of somebody's money handed over on floor authority.
    expect(isDiscountAuthorityError(await refusalFrom(redeem(WAITER, 5000)))).toBe(true);
    expect(discountWritten()).toBe(false);
    // The same redemption on a tenant that HAS an approval queue is ordinary
    // again — limb 2 yields, exactly as it does for a discount and a coupon.
    fx.sql = [];
    fx.threshold = 500;
    expect((await redeem(WAITER, 5000)).discount).toBe(5000);
    expect(discountWritten()).toBe(true);
  });

  for (const [name, actions] of [["manager", MANAGER], ["cashier", CASHIER], ["captain", CAPTAIN]] as const) {
    test(`a ${name} keeps the whole control — the full-bill redemption still writes`, async () => {
      const r = await redeem(actions, 10000);
      expect([name, r.discount]).toEqual([name, 10000]);
      expect(discountWritten()).toBe(true);
      expect(ledgerWritten()).toBe(true);
    });
  }

  test("an admin loses nothing, on the wildcard and on the isAdmin flag alike", async () => {
    expect((await redeem(ADMIN, 10000)).discount).toBe(10000);
    expect(discountWritten()).toBe(true);

    fx.sql = [];
    expect((await redeem(NOBODY, 10000, { isAdmin: true })).discount).toBe(10000);
    expect(discountWritten()).toBe(true);
  });

  test("a caller that forgets to pass its actions is REFUSED a write-off, not granted one", async () => {
    // The only safe direction for a missing input on a money gate — the same
    // direction SetBillDiscountWithApproval and ApplyCouponToBill take.
    expect(isDiscountAuthorityError(await refusalFrom(
      db.RedeemLoyaltyPoints(RES, { phone: PHONE, points: 10000, table_name: "T7" }),
    ))).toBe(true);
    expect(discountWritten()).toBe(false);

    fx.sql = [];
    const ok = await db.RedeemLoyaltyPoints(RES, { phone: PHONE, points: 200, table_name: "T7" });
    expect(ok.discount).toBe(200);
    expect(discountWritten()).toBe(true);
  });

  test("a configured approval threshold does NOT license zeroing a small bill", async () => {
    // Limb 2 yields to a tenant with a queue; limb 1 never does. A ₹50,000
    // threshold on an ₹800 table must not auto-approve the write-off — and
    // loyalty has no queue to park it in anyway.
    fx.threshold = 50000;
    fx.subtotal = 800;
    expect(isDiscountAuthorityError(await refusalFrom(redeem(WAITER, 800)))).toBe(true);
    expect(discountWritten()).toBe(false);
  });

  test("the refusal NAMES the money and the permission", async () => {
    const err = await refusalFrom(redeem(WAITER, 10000)) as {
      details: string; requiredPermission: string; discount_amount: number; remaining_value: number;
    };
    expect(err.requiredPermission).toBe(CLOSE_BILL);
    expect(err.details).toContain("Close Bill");
    expect(err.details).toContain("T7");
    expect(err.discount_amount).toBe(10000);
    expect(err.remaining_value).toBe(0);
  });
});

// ===========================================================================
// THE POST-SETTLE LOCK — the second thing this door was missing.
describe("a settled session is closed to redemption, as it is to a discount and a coupon", () => {
  test("redeeming on a settled table is refused, and mints no phantom bill", async () => {
    fx.openOrders = 0; // every order Paid/Closed/Cancelled — the session is over.
    const err = await refusalFrom(redeem(WAITER, 200)) as Error;
    expect(String(err?.message)).toMatch(/already settled and closed/i);
    expect(discountWritten()).toBe(false);
    expect(ledgerWritten()).toBe(false);
  });

  test("…and the lock holds for the till too — it is a bill-state rule, not a permission", async () => {
    fx.openOrders = 0;
    for (const actions of [MANAGER, CASHIER, CAPTAIN, ADMIN]) {
      fx.sql = [];
      expect(String((await refusalFrom(redeem(actions, 200)) as Error)?.message)).toMatch(/already settled and closed/i);
      expect(discountWritten()).toBe(false);
    }
    // The admin path (isAdmin, no actions) is locked by the same rule.
    fx.sql = [];
    expect(String((await refusalFrom(redeem(NOBODY, 200, { isAdmin: true })) as Error)?.message))
      .toMatch(/already settled and closed/i);
    expect(discountWritten()).toBe(false);
  });
});

// ===========================================================================
// THE TABLE/ACCOUNT LINK. The table comes from the body, the account from a
// phone, and nothing tied them together. The guard fires ONLY where the session
// positively names somebody else — see LoyaltyAccountMismatchError's header for
// why it stays silent on an ordinary POS-punched table.
describe("whose points are being spent, on whose table", () => {
  test("a POS table with no phone on it is left alone — this is the ordinary till case", async () => {
    fx.sessionPhones = [];
    expect((await redeem(WAITER, 200)).discount).toBe(200);
    expect(discountWritten()).toBe(true);
  });

  test("the guest's own number matches, whatever formatting it was captured in", async () => {
    fx.sessionPhones = ["+91 98765 43210"];
    expect((await redeem(WAITER, 200)).discount).toBe(200);
    expect(discountWritten()).toBe(true);
  });

  test("a waiter cannot spend a stranger's points on a table the session says is someone else's", async () => {
    fx.sessionPhones = ["9000000001"];
    const err = await refusalFrom(redeem(WAITER, 200));
    expect(db.isLoyaltyAccountMismatchError(err)).toBe(true);
    expect(discountWritten()).toBe(false);
    expect(ledgerWritten()).toBe(false);
  });

  test("…but the till may still do it, so no legitimate case is dead-ended", async () => {
    fx.sessionPhones = ["9000000001"];
    for (const actions of [MANAGER, CASHIER, CAPTAIN, ADMIN]) {
      fx.sql = [];
      expect([actions[0], (await redeem(actions, 200)).discount]).toEqual([actions[0], 200]);
      expect(discountWritten()).toBe(true);
    }
    fx.sql = [];
    expect((await redeem(NOBODY, 200, { isAdmin: true })).discount).toBe(200);
    expect(discountWritten()).toBe(true);
  });
});

// ===========================================================================
// THE SURVIVING SURFACE. A hidden control must be UNREACHABLE, not merely
// undrawn: a deep link, a stale screen or a bare curl still arrives here.
describe("POST /loyalty/redeem — the route a curl reaches", () => {
  const call = (actions: string[], points: number, role = "waiter") =>
    harness.call("POST", "/loyalty/redeem", {
      body: { phone: PHONE, table_name: "T7", points },
      auth: { res_id: RES, outlet_id: OUTLET, employeeId: "emp-1", role, actions },
    });

  test("a waiter zeroing the bill with points is 403 — and the bill is not written", async () => {
    const r = await call(WAITER, 10000);
    expect(r.status).toBe(403);
    expect(discountWritten()).toBe(false);
    expect(ledgerWritten()).toBe(false);
  });

  test("THE REFUSAL REACHES A HUMAN: the body carries the sentence, not just 'Forbidden'", async () => {
    const body = (await call(WAITER, 10000)).body as {
      error?: string; details?: string; requiredPermission?: string;
      discount_amount?: number; remaining_value?: number;
    };
    expect(body.error).toBe("Forbidden");
    expect(body.requiredPermission).toBe(CLOSE_BILL);
    expect(body.details).toContain("Close Bill");
    expect(body.discount_amount).toBe(10000);
    expect(body.remaining_value).toBe(0);
  });

  test("the refusal is AUDITED — an attempt to write a bill off is the event a manager wants", async () => {
    await call(WAITER, 10000);
    expect(fx.sql.some((q) => /insert into "Audit_logs"/i.test(q))).toBe(true);
  });

  test("the mismatch refusal is a 403 with a body too", async () => {
    fx.sessionPhones = ["9000000001"];
    const r = await call(WAITER, 200);
    expect(r.status).toBe(403);
    expect((r.body as { details?: string }).details).toContain("Close Bill");
    expect(discountWritten()).toBe(false);
  });

  test("THE MIRROR: a waiter's 200-point redemption goes through the same route and lands", async () => {
    const r = await call(WAITER, 200);
    expect(r.status).toBe(200);
    expect(discountWritten()).toBe(true);
    expect(ledgerWritten()).toBe(true);
  });

  for (const [name, actions, role] of [
    ["manager", MANAGER, "manager"], ["cashier", CASHIER, "cashier"], ["captain", CAPTAIN, "captain"],
  ] as const) {
    test(`a ${name} is not refused by the route either`, async () => {
      const r = await call([...actions], 10000, role);
      expect([name, r.status]).toEqual([name, 200]);
      expect(discountWritten()).toBe(true);
    });
  }

  test("an admin keeps the full-bill redemption through the route", async () => {
    const r = await call([...ADMIN], 10000, "admin");
    expect(r.status).toBe(200);
    expect(discountWritten()).toBe(true);
  });
});

// ===========================================================================
// DOOR 5b — the read. `validate` is `next()`, so this was open to every
// authenticated session in the tenant, granted nothing at all.
describe("GET /loyalty/:phone — a balance is customer data, a history is a profile", () => {
  const look = (actions: string[], role = "waiter") =>
    harness.call("GET", "/loyalty/:phone", {
      params: { phone: PHONE },
      auth: { res_id: RES, outlet_id: OUTLET, employeeId: "emp-1", role, actions },
    });

  test("a session with NOTHING granted is refused — and the ledger is never read", async () => {
    const r = await look(NOBODY, "employee");
    expect(r.status).toBe(403);
    // The gate is the guard, not a filter on the response: the query must not run.
    expect(fx.sql.some((q) => /from "LoyaltyLedger"/i.test(q))).toBe(false);
  });

  test("the refusal names the checkbox an owner has to tick", async () => {
    const body = (await look(NOBODY, "employee")).body as { requiredPermission?: string };
    expect(body.requiredPermission).toBe(ADD_ORDERS);
  });

  for (const [name, actions, role] of [
    ["waiter", WAITER, "waiter"], ["cashier", CASHIER, "cashier"],
    ["captain", CAPTAIN, "captain"], ["manager", MANAGER, "manager"], ["admin", ADMIN, "admin"],
  ] as const) {
    test(`a ${name} can still look a balance up at the till`, async () => {
      const r = await look([...actions], role);
      expect([name, r.status]).toEqual([name, 200]);
      expect((r.body as { balance?: number }).balance).toBe(50000);
    });
  }
});

// ===========================================================================
describe("the uuid is the one that already exists", () => {
  test("the gate reuses Close Bill — no new Action is minted for this door", () => {
    // Migration 025's rule: a new id for an existing capability strips it from
    // every role that holds it today. Three doors onto one write, one question.
    expect(db.CLOSE_BILL_ACTION_ID).toBe(CLOSE_BILL);
    for (const role of ["manager", "cashier", "captain"] as const) {
      expect([role, (db.CORE_ROLES[role] as readonly string[]).includes(db.CLOSE_BILL_ACTION_ID)])
        .toEqual([role, true]);
    }
    expect((db.CORE_ROLES.waiter as readonly string[]).includes(db.CLOSE_BILL_ACTION_ID)).toBe(false);
  });

  test("the read's gate is one every till role already holds — nobody is locked out on deploy", () => {
    for (const role of ["waiter", "cashier", "captain", "manager"] as const) {
      expect([role, (db.CORE_ROLES[role] as readonly string[]).includes(ADD_ORDERS)]).toEqual([role, true]);
    }
  });
});
