// CLIENT ITEM 3 (2026-09-17) — "On the waiter dashboard, Cancel KOT option
// should be removed."
//
// ============================================================================
// WHY THE SERVER, AND WHY EVERY DOOR
// ============================================================================
// Production (GGV, read-only): two waiter-only logins cancelled PRINTED dockets
// through PATCH /orders/:id/status — Pritam on 2026-09-14 (KOT 14, reason
// "Other") and Atsu on 2026-09-16 (KOT 3, reason "Aaa", 27 seconds after the
// order went in). Both "OrderVoids" rows were authorised by the person who made
// them. The button is on the app's table sheet, the app's stage sheet, the web
// kitchen board and the web table preview; the act is also reachable through
// the POST /orders upsert (status "Cancelled" — no reason, no void row, no
// slip), POST /orders/:id/void (for a tenant that grants it) and DELETE
// /orders/:id/items/:itemId. Installed 2.0.1 apps will keep drawing the button
// until they update, so the control is here, and the sentence has to reach the
// waiter.
//
// WHAT A WAITER KEEPS: "Decline" on a PENDING order (status 8) — never ticketed.
// WHAT NOBODY ELSE LOSES: a manager, cashier, captain or admin cancels exactly
// as before; a waiter who also holds one of those roles is not a waiter-only
// login.
//
// THE CHECK IS INSIDE THE WRITER, so these tests drive the REAL SetOrderStatus,
// AddOrder and VoidOrderWithReason over a fake pool that models the order's
// status — including one that changes between the read and the write.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFakeApp, type FakeApp } from "./platform_fixtures";
import { CANCEL_NEEDS_SENIOR, PENDING_ORDER_STATUS_CODE, ROLES_OUTRANKING_WAITER, mayCancelKot, mayCancelTicketed, mayPutBackToPending } from "../role_scope";
import {
  CancelNeedsSeniorError,
  cancelNeedsSeniorBody,
  cancelNeedsSeniorSentence,
  isCancelNeedsSeniorError,
  seniorRolesPhrase,
} from "../cancel_authority";

const ADD_ORDERS = "4ad474d4-5230-449c-874f-6a238b833bca";
const TABLE_OCC = "090ea8d4-e348-4e1b-9723-11131a73a085";
const VOID_ORDER = "c1f83b26-5a97-4e40-b8d3-7e02a9c4f156";
const CLOSE_BILL = "a953d044-31ba-4e31-b96f-99304fe43dfa";
const RES = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OUTLET = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ORDER = "e1e7c076-0000-4000-8000-000000000001";
const TABLE = "cccccccc-3333-4333-8333-cccccccccccc";
const CUSTOM_ROLE = "d2b1f0c4-5a97-4e40-b8d3-7e02a9c4f156";

// ===========================================================================
// THE FAKE POOL — an order whose status the tests set, and a SQL log
// ===========================================================================
interface Fx {
  /** Extra keys on the stored order's food (client item 4's move history). */
  foodExtra: Record<string, unknown>;
  status: number;
  /** When set, the status the order has by the time the UPDATE runs. */
  statusAtWrite: number | null;
  exists: boolean;
  /** KOT numbers PrintJobs holds for the order (migration 043's link). */
  printed: number[];
  sql: { q: string; params: unknown[] }[];
}
const fx: Fx = { foodExtra: {}, status: 1, statusAtWrite: null, exists: true, printed: [], sql: [] };

jest.mock("pg", () => {
  const query = async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    fx.sql.push({ q, params });
    if (/from "Restaurant" r/i.test(q)) {
      return { rows: [{ res_id: RES, outlet_id: OUTLET, restaurant_slug: "ggv", restaurant_name: "GGV", restaurant_main_office_add: null, restaurant_logo_url: null, timezone: "Asia/Kolkata" }] };
    }
    if (/^select status from "Orders" where id = \$1/i.test(q)) {
      return { rows: fx.exists ? [{ status: fx.status }] : [] };
    }
    if (/^update "Orders" set status = \$1, food = jsonb_set/i.test(q)) {
      if (fx.statusAtWrite !== null) { fx.status = fx.statusAtWrite; fx.statusAtWrite = null; }
      const pin = params[5];
      if (!fx.exists || (pin !== null && pin !== undefined && String(fx.status) !== String(pin))) { return { rows: [] }; }
      fx.status = Number(params[0]);
      return { rows: [{ id: params[2] }] };
    }
    if (/^select id, coalesce\(is_occupied, false\) as is_occupied from "Tables"/i.test(q)) {
      return { rows: [{ id: TABLE, is_occupied: true }] };
    }
    if (/^select food, barked_at, status from "Orders"/i.test(q)) {
      return { rows: fx.exists ? [{ food: { table: "11", items: [{ id: "l1", name: "HARA DHANIYA PULAO", price: 629, quantity: 1 }], ...fx.foodExtra }, barked_at: new Date(), status: fx.status }] : [] };
    }
    // AddOrder's upsert: `where $9 is null or status = $9` on the conflict, and
    // `returning id` — a pinned write that no longer matches returns nothing.
    if (/^insert into "Orders" \(id, created_at, res_id, outlet_id, food, table_id, status, cust_id, barked_at\)/i.test(q)) {
      if (fx.statusAtWrite !== null) { fx.status = fx.statusAtWrite; fx.statusAtWrite = null; }
      const pin = params[8];
      if (fx.exists && pin !== null && pin !== undefined && String(fx.status) !== String(pin)) { return { rows: [] }; }
      fx.status = Number(params[5]);
      return { rows: [{ id: params[0] }] };
    }
    if (/^select bill_id, kot_no from "PrintJobs"/i.test(q)) {
      return { rows: fx.printed.map((n) => ({ bill_id: `order-${ORDER}`, kot_no: n })) };
    }
    return { rows: [] };
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]) { return query(sql, params); }
    connect() { return Promise.resolve({ query, release: () => undefined }); }
    end() { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

type AnyAsync = (...a: unknown[]) => Promise<unknown>;
const mockRecordVoid = jest.fn<AnyAsync>();
const mockAudit = jest.fn<AnyAsync>();
const mockKotNos = jest.fn<AnyAsync>();
const mockGuard = jest.fn<AnyAsync>();
const mockResolveAuthoriser = jest.fn<AnyAsync>();
const mockCancelSlip = jest.fn<AnyAsync>();

jest.mock("../database_supabase", () => {
  const actual = jest.requireActual("../database_supabase") as Record<string, unknown>;
  return {
    ...actual,
    __esModule: true,
    RecordOrderVoid: (...a: unknown[]) => mockRecordVoid(...a),
    AddAuditLogEntry: (...a: unknown[]) => mockAudit(...a),
    GetEmployeeDetailsFromEmpID: async () => ({ res_id: RES, outlet_id: OUTLET }),
    GetOrderKotNumbers: (...a: unknown[]) => mockKotNos(...a),
    GetOrderingPrintGuard: (...a: unknown[]) => mockGuard(...a),
    ResolveAuthoriser: (...a: unknown[]) => mockResolveAuthoriser(...a),
    GetTableNameById: async () => "11",
    applyMenuPriceFloor: async (_r: unknown, items: unknown[]) => items,
    AddNotification: async () => undefined,
    GetRestaurantAccountStatus: async () => "active",
    withTenant: async (_ctx: unknown, work: () => unknown) => work(),
  };
});
jest.mock("../kot_print", () => ({
  __esModule: true,
  dispatchKot: async () => ({ tickets: 0, stations: [], kotNo: null }),
  logKotDispatched: () => undefined,
  autoPrintOrderKot: async () => ({ printed: false, kot_no: null, tickets: 0, reason: "disabled" }),
  dispatchCancellationKot: (...a: unknown[]) => mockCancelSlip(...a),
}));
jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: () => undefined, emitOutlet: () => undefined }));
jest.mock("../storage_bucket_supabase", () => ({ __esModule: true, uploadScreenshot: async () => null }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: async () => undefined }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

// The stock waiter's resolved action set (database_supabase.ts CORE_ROLES.waiter).
const WAITER_ACTIONS = [ADD_ORDERS, TABLE_OCC, "c7699d46-0e2f-4448-b325-8ca490a5296b", "b7f78d0f-323d-4622-8d05-aa2f82d54b2e", "f4177b38-77fa-4d8c-9fbd-c4f06bf28610", "98b10bde-802d-4a5b-a726-53a826424f79"];
const who = (role: string, roleAll: string[], actions: string[]) => ({
  res_id: RES, outlet_id: OUTLET, employeeId: `emp-${role}`, employeeUsername: role, role, role_all: roleAll, actions,
});
const WAITER = who("waiter", ["waiter"], WAITER_ACTIONS);
const WAITER_WITH_VOID = who("waiter", ["waiter"], [...WAITER_ACTIONS, VOID_ORDER]);
const WAITER_CUSTOM = who("waiter", ["waiter", CUSTOM_ROLE], WAITER_ACTIONS);
const WAITER_EMPLOYEE = who("employee", ["employee", "waiter"], WAITER_ACTIONS);
const SENIORS = [
  ["a manager", who("manager", ["manager"], [ADD_ORDERS, CLOSE_BILL, VOID_ORDER])],
  ["a cashier", who("cashier", ["cashier"], [ADD_ORDERS, CLOSE_BILL])],
  ["a captain", who("captain", ["captain"], [ADD_ORDERS])],
  ["an admin", who("admin", ["admin"], ["*"])],
  ["a waiter who is also a captain", who("waiter", ["waiter", "captain"], WAITER_ACTIONS)],
] as const;

let db: typeof import("../database_supabase");
let h: FakeApp;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
  const orders = await import("../routes/orders");
  const mis = await import("../routes/mis_capture");
  h = makeFakeApp();
  orders.registerOrderRoutes(h.app as never);
  mis.registerMisCaptureRoutes(h.app as never);
});

beforeEach(() => {
  fx.foodExtra = {};
  fx.status = 1;
  fx.statusAtWrite = null;
  fx.exists = true;
  fx.printed = [];
  fx.sql = [];
  db.__kotNumberLinkTestSeam.setSchemaReady(false);
  for (const m of [mockRecordVoid, mockAudit, mockKotNos, mockGuard, mockResolveAuthoriser, mockCancelSlip]) { m.mockReset(); }
  mockRecordVoid.mockResolvedValue({ id: "void-1", void_kind: "other", stage: "after_print" });
  mockAudit.mockResolvedValue(true);
  mockKotNos.mockResolvedValue(new Map([[ORDER, [3]]]));
  mockGuard.mockResolvedValue(null);
  mockResolveAuthoriser.mockResolvedValue({ ok: true, identity: { employee_id: "emp-m", username: "manager", display_name: "Manager" } });
  mockCancelSlip.mockResolvedValue({ printed: true, kot_no: 3, tickets: 1 });
});

const statusWrites = () => fx.sql.filter((s) => /^update "Orders" set status = \$1/i.test(s.q));
const orderInserts = () => fx.sql.filter((s) => /^insert into "Orders"/i.test(s.q));
const auditLines = (): string[] => mockAudit.mock.calls.map((c) => String(c[4]));
const SENTENCE_KOT3 = "KOT-3 has gone to the kitchen. Only a manager, cashier, captain or admin can cancel it — ask one of them.";
const SENTENCE_KOT3_REWIND = "KOT-3 has gone to the kitchen, so it cannot be put back to Pending. Only a manager, cashier, captain or admin can change that — ask one of them.";

// ===========================================================================
describe("the rule and its words", () => {
  test("a waiter-only login may cancel only what the kitchen was never told about", () => {
    for (const code of [1, 2, 3, 6, 4, 7, null, undefined]) {
      expect(mayCancelTicketed({ role: "waiter", role_all: ["waiter"], actions: [ADD_ORDERS] }, code)).toBe(false);
    }
    expect(mayCancelTicketed({ role: "waiter", role_all: ["waiter"], actions: [ADD_ORDERS] }, PENDING_ORDER_STATUS_CODE)).toBe(true);
    expect(PENDING_ORDER_STATUS_CODE).toBe(8);
  });

  test("REVIEW — a Pending order with a KOT number on paper WAS ticketed, and a waiter does not cancel it", () => {
    const waiter = { role: "waiter", role_all: ["waiter"], actions: [ADD_ORDERS] };
    expect(mayCancelTicketed(waiter, 8, [14])).toBe(false);
    expect(mayCancelTicketed(waiter, 8, [])).toBe(true);
    // Only a real number counts: garbage from the reader never refuses a decline.
    expect(mayCancelTicketed(waiter, 8, [0, -1, Number.NaN])).toBe(true);
    // A senior is not judged by it.
    expect(mayCancelTicketed({ role: "manager", role_all: ["manager"], actions: [] }, 1, [14])).toBe(true);
  });

  test("REVIEW — a waiter-only login may name Pending only for an order that already is Pending", () => {
    const waiter = { role: "waiter", role_all: ["waiter"], actions: [ADD_ORDERS] };
    for (const code of [1, 2, 3, 6, null, undefined]) {
      expect({ code, allowed: mayPutBackToPending(waiter, code) }).toEqual({ code, allowed: false });
    }
    expect(mayPutBackToPending(waiter, 8)).toBe(true);
    for (const [, auth] of SENIORS) {
      expect(mayPutBackToPending(auth, 1)).toBe(true);
    }
  });

  test("the scoping is the server's isWaiterOnly — custom roles and the 'employee' fallback do not lift it; a senior role does", () => {
    const w = (roleAll: string[], actions: string[] = [ADD_ORDERS]) => mayCancelTicketed({ role: roleAll[0], role_all: roleAll, actions }, 1);
    expect(w(["waiter", CUSTOM_ROLE])).toBe(false);
    expect(w(["employee", "waiter"])).toBe(false);
    expect(w(["waiter", VOID_ORDER], [ADD_ORDERS, VOID_ORDER])).toBe(false);
    for (const senior of ROLES_OUTRANKING_WAITER) { expect(w(["waiter", senior])).toBe(true); }
    expect(w(["waiter"], ["*"])).toBe(true);
    expect(w(["cook"])).toBe(true);
    expect(mayCancelKot({ role: "waiter", role_all: ["waiter"], actions: [] })).toBe(false);
    expect(mayCancelKot({ role: "manager", role_all: ["manager"], actions: [] })).toBe(true);
  });

  test("the sentence names the ticket the way the pass does, and who to ask", () => {
    expect(seniorRolesPhrase()).toBe("a manager, cashier, captain or admin");
    expect(cancelNeedsSeniorSentence([3])).toBe(SENTENCE_KOT3);
    expect(cancelNeedsSeniorSentence([])).toBe("This order has gone to the kitchen. Only a manager, cashier, captain or admin can cancel it — ask one of them.");
    expect(cancelNeedsSeniorSentence([5, 5, 7])).toBe("KOT-5, KOT-7 have gone to the kitchen. Only a manager, cashier, captain or admin can cancel it — ask one of them.");
    expect(cancelNeedsSeniorSentence([9], "remove_line")).toBe("KOT-9 has gone to the kitchen, so a dish cannot be taken off it here. Only a manager, cashier, captain or admin can do that — ask one of them.");
    expect(cancelNeedsSeniorSentence([0, -1, Number.NaN])).toMatch(/^This order has gone/);
    expect(cancelNeedsSeniorSentence([3], "rewind")).toBe(SENTENCE_KOT3_REWIND);
  });

  test("the error is tagged, and the body carries the code, the sentence and the machine list", () => {
    const e = new CancelNeedsSeniorError(ORDER);
    expect(isCancelNeedsSeniorError(e)).toBe(true);
    expect(isCancelNeedsSeniorError({ code: CANCEL_NEEDS_SENIOR })).toBe(true);
    expect(isCancelNeedsSeniorError(new Error("x"))).toBe(false);
    expect(isCancelNeedsSeniorError(null)).toBe(false);
    expect(e.status).toBe(403);
    expect(cancelNeedsSeniorBody(e, [3])).toEqual({
      error: "Forbidden", code: "cancel_needs_senior", details: SENTENCE_KOT3,
      allowed_roles: ROLES_OUTRANKING_WAITER, order_id: ORDER, kot_nos: [3],
    });
  });
});

// ===========================================================================
describe("SetOrderStatus — the check is beside the read and before the write", () => {
  const asWaiter = { actor: { role: "waiter", role_all: ["waiter"], actions: WAITER_ACTIONS } };

  test.each([[1, "Preparing"], [2, "Served"], [3, "Bill Verification"]])("a ticketed order (status %s) is refused and NOTHING is written", async (code) => {
    fx.status = code;
    await expect(db.SetOrderStatus(RES, ORDER, "Cancelled", asWaiter)).rejects.toMatchObject({ code: "cancel_needs_senior", order_id: ORDER });
    expect(statusWrites()).toEqual([]);
    expect(fx.status).toBe(code);
  });

  test("a Pending order is declined, and the write is pinned to Pending", async () => {
    fx.status = 8;
    await expect(db.SetOrderStatus(RES, ORDER, "Cancelled", asWaiter)).resolves.toEqual({ ok: true, changed: true, previous_status: "Pending" });
    expect(statusWrites()).toHaveLength(1);
    expect(statusWrites()[0]!.params[5]).toBe("8");
    expect(fx.status).toBe(5);
  });

  test("THE RACE: accepted to the kitchen between the read and the write — refused, not cancelled", async () => {
    fx.status = 8;
    fx.statusAtWrite = 1;
    await expect(db.SetOrderStatus(RES, ORDER, "Cancelled", asWaiter)).rejects.toMatchObject({ code: "cancel_needs_senior" });
    expect(fx.status).toBe(1);
  });

  test("an outbox REPLAY of a cancel that already landed stays a harmless no-op, never a 403", async () => {
    fx.status = 5;
    await expect(db.SetOrderStatus(RES, ORDER, "Cancelled", asWaiter)).resolves.toEqual({ ok: true, changed: false, previous_status: "Cancelled" });
    expect(statusWrites()).toEqual([]);
  });

  test("a waiter's everyday transitions are untouched", async () => {
    fx.status = 1;
    await expect(db.SetOrderStatus(RES, ORDER, "Preparing", asWaiter)).resolves.toMatchObject({ ok: true, changed: true });
    expect(statusWrites()[0]!.params[5]).toBeNull();
  });

  test("no actor = no role rule, for every caller that is not a person", async () => {
    fx.status = 1;
    await expect(db.SetOrderStatus(RES, ORDER, "Cancelled")).resolves.toMatchObject({ ok: true, changed: true });
    expect(statusWrites()[0]!.params[5]).toBeNull();
  });

  test("a missing order is still not-found, not a refusal", async () => {
    fx.exists = false;
    await expect(db.SetOrderStatus(RES, ORDER, "Cancelled", asWaiter)).resolves.toEqual({ ok: false, changed: false, previous_status: null });
  });

  // REVIEW FINDING — THE TWO-REQUEST CANCEL. "Pending" is what makes a waiter's
  // cancel a decline, and it was a status any Add Orders holder could write
  // back: Preparing -> Pending -> Cancelled, and no slip on the way.
  test.each([[1], [2], [3], [6]])("a ticket (status %s) is NOT put back to Pending — refused as a rewind, nothing written", async (code) => {
    fx.status = code;
    await expect(db.SetOrderStatus(RES, ORDER, "Pending", asWaiter)).rejects.toMatchObject({ code: "cancel_needs_senior", act: "rewind", order_id: ORDER });
    expect(statusWrites()).toEqual([]);
    expect(fx.status).toBe(code);
  });

  test("a Pending order named Pending again is pinned to Pending, so it cannot undo an acceptance that lands first", async () => {
    fx.status = 8;
    fx.statusAtWrite = 1;
    await expect(db.SetOrderStatus(RES, ORDER, "Pending", asWaiter)).rejects.toMatchObject({ code: "cancel_needs_senior", act: "rewind" });
    expect(statusWrites()[0]!.params[5]).toBe("8");
    expect(fx.status).toBe(1);
  });

  test("a senior role's stage changes are not judged by the waiter rule", async () => {
    fx.status = 1;
    await expect(db.SetOrderStatus(RES, ORDER, "Pending", { actor: { role: "manager", role_all: ["manager"], actions: [ADD_ORDERS] } }))
      .resolves.toMatchObject({ ok: true, changed: true });
    expect(statusWrites()[0]!.params[5]).toBeNull();
  });

  test("the decline also asks PrintJobs: a Pending order with a KOT number was ticketed, and is refused before anything is written", async () => {
    db.__kotNumberLinkTestSeam.setSchemaReady(true);
    fx.status = 8;
    fx.printed = [3];
    await expect(db.SetOrderStatus(RES, ORDER, "Cancelled", asWaiter)).rejects.toMatchObject({ code: "cancel_needs_senior", act: "cancel" });
    expect(statusWrites()).toEqual([]);
    expect(fx.status).toBe(8);
    expect(fx.sql.some((s) => /from "PrintJobs"/i.test(s.q))).toBe(true);
  });

  test("…and the read is made only for a waiter's decline — a ticketed cancel and a senior never ask it", async () => {
    db.__kotNumberLinkTestSeam.setSchemaReady(true);
    fx.status = 1;
    await expect(db.SetOrderStatus(RES, ORDER, "Cancelled", asWaiter)).rejects.toMatchObject({ code: "cancel_needs_senior" });
    await db.SetOrderStatus(RES, ORDER, "Cancelled", { actor: { role: "manager", role_all: ["manager"], actions: [ADD_ORDERS] } });
    expect(fx.sql.some((s) => /from "PrintJobs"/i.test(s.q))).toBe(false);
  });

  test("REVIEW FINDING — declined by somebody else between the read and the write: a harmless no-op, not a 403", async () => {
    fx.status = 8;
    fx.statusAtWrite = 5;
    await expect(db.SetOrderStatus(RES, ORDER, "Cancelled", asWaiter)).resolves.toEqual({ ok: true, changed: false, previous_status: "Cancelled" });
    expect(fx.status).toBe(5);
  });

  test("a settled or cancelled order keeps the house words, for a cancel and for a rewind", async () => {
    fx.status = 4;
    await expect(db.SetOrderStatus(RES, ORDER, "Cancelled", asWaiter)).rejects.toThrow(/already settled and locked/);
    await expect(db.SetOrderStatus(RES, ORDER, "Pending", asWaiter)).rejects.toThrow(/already settled and locked/);
    fx.status = 5;
    const err = await db.SetOrderStatus(RES, ORDER, "Pending", asWaiter).then(() => null, (e: unknown) => e as { code?: unknown; message?: unknown });
    expect(err?.code).toBeUndefined();
    expect(String(err?.message)).toMatch(/cancel/i);
    expect(statusWrites()).toEqual([]);
  });
});

// ===========================================================================
describe("PATCH /orders/:id/status — what the waiter is told", () => {
  const cancel = (auth: unknown, body: Record<string, unknown> = { status: "Cancelled", reason: "Aaa", cancel_kind: "other" }) =>
    h.call("PATCH", "/orders/:id/status", { params: { id: ORDER }, body, auth: auth as never });

  test.each([["the stock waiter", WAITER], ["a waiter granted Void Orders", WAITER_WITH_VOID], ["a waiter with a custom role", WAITER_CUSTOM], ["a waiter on the 'employee' fallback", WAITER_EMPLOYEE]])(
    "%s: 403 cancel_needs_senior, no status write, no void row, no slip — and the attempt is on the record",
    async (_l, auth) => {
      const r = await cancel(auth);
      expect(r.status).toBe(403);
      expect(r.body).toEqual({
        error: "Forbidden", code: "cancel_needs_senior", details: SENTENCE_KOT3,
        allowed_roles: ROLES_OUTRANKING_WAITER, order_id: ORDER, kot_nos: [3],
      });
      expect(statusWrites()).toEqual([]);
      expect(mockRecordVoid).not.toHaveBeenCalled();
      expect(mockCancelSlip).not.toHaveBeenCalled();
      expect(auditLines()).toEqual([`REFUSED cancel of order ${ORDER} (KOT-3) — it has gone to the kitchen and a waiter cannot cancel it`]);
      // Starts "REFUSED", so neither Bill Edit nor the Void KOT join reads it as a cancel.
      expect(auditLines()[0]).not.toMatch(/^Order .* -> Cancel/i);
    },
  );

  test("an unreadable KOT number costs the number, never the refusal", async () => {
    mockKotNos.mockRejectedValue(new Error("PrintJobs unreadable"));
    const r = await cancel(WAITER);
    expect(r.status).toBe(403);
    expect((r.body as { details: string }).details).toMatch(/^This order has gone to the kitchen/);
  });

  test("a failed audit write does not turn the 403 into a 500", async () => {
    mockAudit.mockRejectedValue(new Error("audit down"));
    expect((await cancel(WAITER)).status).toBe(403);
  });

  test("the waiter still DECLINES a Pending order: 200, recorded, and the slip is asked with previous_status Pending", async () => {
    fx.status = 8;
    const r = await cancel(WAITER);
    expect(r.status).toBe(200);
    expect(fx.status).toBe(5);
    expect(mockRecordVoid).toHaveBeenCalledTimes(1);
    expect(mockCancelSlip).toHaveBeenCalledWith(expect.objectContaining({ orderId: ORDER, previousStatus: "Pending" }));
  });

  test("REVIEW FINDING — THE TWO-STEP REWIND: Pending is refused, so the cancel after it is refused too, and nothing prints", async () => {
    fx.status = 1;
    const rewind = await cancel(WAITER, { status: "Pending" });
    expect(rewind.status).toBe(403);
    expect(rewind.body).toEqual({
      error: "Forbidden", code: "cancel_needs_senior", details: SENTENCE_KOT3_REWIND,
      allowed_roles: ROLES_OUTRANKING_WAITER, order_id: ORDER, kot_nos: [3],
    });
    expect(fx.status).toBe(1);
    const then = await cancel(WAITER);
    expect(then.status).toBe(403);
    expect(fx.status).toBe(1);
    expect(statusWrites()).toEqual([]);
    expect(mockRecordVoid).not.toHaveBeenCalled();
    expect(mockCancelSlip).not.toHaveBeenCalled();
    expect(auditLines()).toEqual([
      `REFUSED move back to Pending of order ${ORDER} (KOT-3) — it has gone to the kitchen and a waiter cannot put it back to Pending`,
      `REFUSED cancel of order ${ORDER} (KOT-3) — it has gone to the kitchen and a waiter cannot cancel it`,
    ]);
  });

  test("REVIEW FINDING — a decline that lost the race to another decline: 200 unchanged, nothing refused on the record, no slip", async () => {
    fx.status = 8;
    fx.statusAtWrite = 5;
    const r = await cancel(WAITER);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, unchanged: true });
    expect(auditLines()).toEqual([]);
    expect(mockRecordVoid).not.toHaveBeenCalled();
    expect(mockCancelSlip).not.toHaveBeenCalled();
  });

  test.each(SENIORS)("%s cancels a ticketed order exactly as before", async (_l, auth) => {
    fx.status = 1;
    const r = await cancel(auth);
    expect(r.status).toBe(200);
    expect(fx.status).toBe(5);
    expect(mockCancelSlip).toHaveBeenCalledTimes(1);
    expect(auditLines()[0]).toBe(`Order ${ORDER} -> Cancelled — reason: Aaa`);
  });
});

// ===========================================================================
describe("POST /orders — the upsert side door", () => {
  const upsert = (auth: unknown, status: string, id: string = ORDER) => h.call("POST", "/orders", {
    body: { id, table: "11", status, items: [{ id: "l1", name: "HARA DHANIYA PULAO", price: 629, quantity: 1 }] },
    auth: auth as never,
  });

  test("a waiter resending a ticketed order as 'Cancelled' is refused, and nothing is written", async () => {
    const r = await upsert(WAITER, "Cancelled");
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: "cancel_needs_senior", order_id: ORDER, details: SENTENCE_KOT3 });
    expect(orderInserts()).toEqual([]);
    expect(mockCancelSlip).not.toHaveBeenCalled();
  });

  test("…a Pending one goes through, as the decline it is — pinned to Pending", async () => {
    fx.status = 8;
    const r = await upsert(WAITER, "Cancelled");
    expect(r.status).toBe(201);
    expect(orderInserts()).toHaveLength(1);
    expect(orderInserts()[0]!.params[5]).toBe(5);
    expect(orderInserts()[0]!.params[8]).toBe("8");
    expect(fx.status).toBe(5);
  });

  test("REVIEW FINDING — THE REWIND THROUGH THE UPSERT: the stored stage is kept, so the cancel after it is still refused", async () => {
    fx.status = 1;
    const rewind = await upsert(WAITER, "Pending");
    expect(rewind.status).toBe(201);
    expect(orderInserts()).toHaveLength(1);
    expect(orderInserts()[0]!.params[5]).toBe(1);
    // Nothing the rule rests on, so nothing is pinned.
    expect(orderInserts()[0]!.params[8]).toBeNull();
    expect((JSON.parse(String(orderInserts()[0]!.params[3])) as { status: string }).status).toBe("Preparing");
    expect(fx.status).toBe(1);
    fx.sql = [];
    const then = await upsert(WAITER, "Cancelled");
    expect(then.status).toBe(403);
    expect(orderInserts()).toEqual([]);
    expect(fx.status).toBe(1);
    expect(mockCancelSlip).not.toHaveBeenCalled();
  });

  test("…a stale Pending resend is an ordinary edit of what the order really is (Served stays Served)", async () => {
    fx.status = 2;
    const r = await upsert(WAITER, "Pending");
    expect(r.status).toBe(201);
    expect(orderInserts()[0]!.params[5]).toBe(2);
    expect((JSON.parse(String(orderInserts()[0]!.params[3])) as { status: string }).status).toBe("Served");
  });

  test("a senior's upsert may still name Pending (not judged by the waiter rule)", async () => {
    fx.status = 1;
    const r = await upsert(SENIORS[0][1], "Pending");
    expect(r.status).toBe(201);
    expect(orderInserts()[0]!.params[5]).toBe(8);
    expect(orderInserts()[0]!.params[8]).toBeNull();
  });

  test("THE RACE ON THE UPSERT: a decline that lands after an acceptance matches nothing and is refused", async () => {
    fx.status = 8;
    fx.statusAtWrite = 1;
    const r = await upsert(WAITER, "Cancelled");
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: "cancel_needs_senior", order_id: ORDER });
    expect(fx.status).toBe(1);
  });

  test("…a Pending resend that lands after an acceptance matches nothing and asks for a refresh", async () => {
    fx.status = 8;
    fx.statusAtWrite = 1;
    const r = await upsert(WAITER, "Pending");
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "This order was sent to the kitchen while it was being edited. Refresh it and try again." });
    expect(fx.status).toBe(1);
  });

  test("…and a decline that lands after another decline gets the house words, not a refusal", async () => {
    fx.status = 8;
    fx.statusAtWrite = 5;
    const r = await upsert(WAITER, "Cancelled");
    expect(r.status).toBe(400);
    expect((r.body as { code?: unknown }).code).toBeUndefined();
    expect(String((r.body as { error?: unknown }).error)).toMatch(/cancel/i);
    expect(auditLines().some((l) => l.startsWith("REFUSED"))).toBe(false);
  });

  test("the upsert's decline asks PrintJobs too: a Pending order with a KOT number is refused, nothing written", async () => {
    db.__kotNumberLinkTestSeam.setSchemaReady(true);
    fx.status = 8;
    fx.printed = [3];
    const r = await upsert(WAITER, "Cancelled");
    expect(r.status).toBe(403);
    expect(orderInserts()).toEqual([]);
    expect(fx.status).toBe(8);
  });

  test("CLIENT ITEM 4 — an upsert keeps the move history the server stamped, and a client cannot write one", async () => {
    fx.foodExtra = {
      moves: [{ from_table: "12", to_table: "11", at: "2026-09-14T16:32:00.000Z", by: "vineet" }],
      moved_from: { table: "12A", order_id: "src", kot_nos: [3], at: "t", by: null },
    };
    const r = await h.call("POST", "/orders", {
      body: {
        id: ORDER, table: "11", status: "Served",
        items: [{ id: "l1", name: "HARA DHANIYA PULAO", price: 629, quantity: 1 }],
        moves: [{ from_table: "forged" }], moved_items: [{ name: "forged" }],
      },
      auth: SENIORS[0][1] as never,
    });
    expect(r.status).toBe(201);
    const stored = JSON.parse(String(orderInserts()[0]!.params[3])) as Record<string, unknown>;
    expect(stored.moves).toEqual(fx.foodExtra.moves);
    expect(stored.moved_from).toEqual(fx.foodExtra.moved_from);
    expect(stored.moved_items).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain("forged");
  });

  test("a senior role's upsert to 'Cancelled' is written as before", async () => {
    const r = await upsert(SENIORS[0][1], "Cancelled");
    expect(r.status).toBe(201);
    expect(orderInserts()[0]!.params[5]).toBe(5);
  });

  test("a waiter's ordinary resend (Served) is not a cancel and is written", async () => {
    const r = await upsert(WAITER, "Served");
    expect(r.status).toBe(201);
    expect(orderInserts()).toHaveLength(1);
  });

  test("THE MONEY HOLE BESIDE IT: 'Paid' / 'Closed' through the upsert needs Close Bill", async () => {
    for (const status of ["Paid", "closed"]) {
      fx.sql = [];
      const r = await upsert(WAITER, status);
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ error: "Forbidden", requiredPermission: CLOSE_BILL });
      expect(orderInserts()).toEqual([]);
    }
    const ok = await upsert(SENIORS[1][1], "Paid");
    expect(ok.status).toBe(201);
    expect(orderInserts()[0]!.params[5]).toBe(4);
  });
});

// ===========================================================================
describe("POST /orders/:id/void — the grant does not outrank the role here", () => {
  const voidIt = (auth: unknown) => h.call("POST", "/orders/:id/void", {
    params: { id: ORDER }, body: { void_kind: "wrong_entry", reason: "rang twice", authorised_by: "manager" }, auth: auth as never,
  });

  test("a waiter granted Void Orders, naming a manager, is refused inside the transaction — no row, no slip", async () => {
    const r = await voidIt(WAITER_WITH_VOID);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: "cancel_needs_senior", details: SENTENCE_KOT3 });
    expect(mockRecordVoid).not.toHaveBeenCalled();
    expect(mockCancelSlip).not.toHaveBeenCalled();
    expect(statusWrites()).toEqual([]);
    const qs = fx.sql.map((s) => s.q);
    expect(qs.some((q) => /^select status from "Orders" where id = \$1 .* for update$/i.test(q))).toBe(true);
    expect(qs.indexOf("BEGIN")).toBeGreaterThan(-1);
    expect(qs.lastIndexOf("ROLLBACK")).toBeGreaterThan(qs.indexOf("BEGIN"));
  });

  test("the stock waiter is still refused at the permission, before anything is read", async () => {
    const r = await voidIt(WAITER);
    expect(r.status).toBe(403);
    expect(mockResolveAuthoriser).not.toHaveBeenCalled();
  });

  // Past the check, VoidOrderWithReason records the void through its OWN (real)
  // ledger writer, which this fake pool cannot serve — so these two assert the
  // check was passed (the next read ran, and the answer is not the refusal),
  // not the ledger write mis_capture.test.ts already owns.
  const passedTheCheck = (body: unknown): void => {
    expect((body as { code?: unknown } | undefined)?.code).not.toBe("cancel_needs_senior");
    const after = fx.sql.map((s) => s.q).filter((q) => /^select status from "Orders" where id = \$1 and res_id = \$2 and outlet_id = \$3 limit 1$/i.test(q));
    expect(after.length).toBeGreaterThan(0);
  };

  test("a Pending order with a KOT number on paper is refused — the number read BEFORE the transaction opens", async () => {
    db.__kotNumberLinkTestSeam.setSchemaReady(true);
    fx.status = 8;
    fx.printed = [3];
    const r = await voidIt(WAITER_WITH_VOID);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: "cancel_needs_senior" });
    expect(mockRecordVoid).not.toHaveBeenCalled();
    const qs = fx.sql.map((s) => s.q);
    const printRead = qs.findIndex((q) => /from "PrintJobs"/i.test(q));
    expect(printRead).toBeGreaterThan(-1);
    expect(printRead).toBeLessThan(qs.indexOf("BEGIN"));
  });

  test("a Pending order passes the waiter check (the void itself then runs as before)", async () => {
    fx.status = 8;
    const r = await voidIt(WAITER_WITH_VOID);
    expect(r.status).not.toBe(403);
    passedTheCheck(r.body);
  });

  test("a manager is not judged by the waiter rule at all — no locking read", async () => {
    const r = await voidIt(SENIORS[0][1]);
    expect(r.status).not.toBe(403);
    passedTheCheck(r.body);
    expect(fx.sql.some((s) => /for update$/i.test(s.q))).toBe(false);
  });
});

// ===========================================================================
describe("the wiring — nothing here is built and never called", () => {
  const read = (rel: string): string => readFileSync(join(__dirname, "..", rel), "utf8");
  const handler = (src: string, start: string): string => {
    const at = src.indexOf(start);
    expect({ start, found: at > -1 }).toEqual({ start, found: true });
    const end = src.indexOf("\napp.", at + 1);
    return src.slice(at, end < 0 ? undefined : end);
  };

  test("every door that can cancel hands the session down and answers the refusal", () => {
    const orders = read("routes/orders.ts");
    const status = handler(orders, 'app.patch("/orders/:id/status"');
    expect(status).toMatch(/SetOrderStatus\(restaurantId, orderId, status, \{ actor: actorOf\(req\) \}\)/);
    expect(status).toMatch(/isCancelNeedsSeniorError\(error\)\) \{ await refuseTicketedCancel\(req, res, error\)/);
    const upsert = handler(orders, 'app.post("/orders",');
    expect(upsert).toMatch(/AddOrder\(restaurantId, body, \{ actor: actorOf\(req\) \}\)/);
    expect(upsert).toMatch(/isCancelNeedsSeniorError\(error\)\) \{ await refuseTicketedCancel\(req, res, error\)/);
    expect(upsert).toMatch(/\["paid", "closed"\]\.includes\(upsertStatus\) && !\(await enforceSettleAuthority\(req, res\)\)/);
    const del = handler(orders, "app.delete('/orders/:id/items/:itemId'");
    expect(del).toMatch(/actor: actorOf\(req\),/);
    expect(del).toMatch(/isCancelNeedsSeniorError\(e\)\) \{ await refuseTicketedCancel\(req, res, e\)/);
    const voidRoute = handler(read("routes/mis_capture.ts"), 'app.post("/orders/:id/void"');
    expect(voidRoute).toMatch(/\{ actor: \{ role: req\.auth\?\.role, role_all: req\.auth\?\.role_all, actions: req\.auth\?\.actions \} \}/);
    expect(voidRoute).toMatch(/isCancelNeedsSeniorError\(err\)\) \{ await refuseTicketedCancel\(req, res, err\)/);
  });

  test("both session payloads ship cancel_kot from the roles AND the actions", () => {
    const auth = read("routes/auth.ts");
    expect(auth).toMatch(/sessionCapabilities\(\{ role: user\.role, role_all: user\.role_all, actions: Array\.from\(user\.actions_set\) \}\)/);
    expect(auth).toMatch(/sessionCapabilities\(\{ role: session\.role, role_all: session\.role_all, actions: session\.actions \}\)/);
    expect(auth).not.toMatch(/sessionCapabilities\(\{ actions:/);
  });

  test("every writer's cancel check goes through waiterMayCancel (the PrintJobs half included)", () => {
    const src = read("database_supabase.ts");
    // SetOrderStatus, AddOrder, UpdateOrderItemsSplit and VoidOrderWithReason.
    expect(src.match(/await waiterMayCancel\(/g)?.length).toBe(4);
    // No writer judges the bare status any more: the one call is inside waiterMayCancel.
    expect(src.match(/mayCancelTicketed\(/g)?.length).toBe(1);
    expect(src).toMatch(/!mayPutBackToPending\(opts\.actor, previousCode\)/);
    expect(src).toMatch(/!mayPutBackToPending\(upsertActor, storedCode\)/);
  });

  test("the refusal's pieces are reached from shipping code, not only from this suite", () => {
    const shipping = ["routes/_shared.ts", "routes/orders.ts", "routes/mis_capture.ts", "database_supabase.ts"].map(read).join("\n");
    for (const symbol of ["CancelNeedsSeniorError", "cancelNeedsSeniorBody", "isCancelNeedsSeniorError", "refuseTicketedCancel", "mayCancelTicketed", "mayCancelKot", "mayPutBackToPending", "waiterMayCancel"]) {
      expect({ symbol, used: shipping.includes(`${symbol}(`) }).toEqual({ symbol, used: true });
    }
  });
});
