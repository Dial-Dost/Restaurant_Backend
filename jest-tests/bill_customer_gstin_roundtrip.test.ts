// ROUND 2 ITEM 1 — A PAST-BILL EDIT MUST READ BACK EVERYWHERE THE BILL IS READ.
//
// ============================================================================
// THE BUG THIS PINS (found live on the docker stack)
// ============================================================================
// POST /bills/<id>/customer-details on a RELEASED bill (table T3 cleared without
// payment: closed_at set, total 0, every order in its window Cancelled) answered
// 200 with the new name and GSTIN. GET /bills/closed/<id> then said
// `customer: null` and `customer_gstin: "29AAXFN2701Q1ZF"`.
//
// The writer renamed every order in the window, settled AND cancelled. The detail
// read took the name only from the set it picked for the MONEY — settled orders,
// or the cancelled-inclusive set only when that set reconciles the total — and on
// a zero-total bill with only cancelled orders neither set reconciles, so it kept
// the (empty) settled set and found no name. The GSTIN survived only because it
// also lives on the bill row's column.
//
// ============================================================================
// WHAT THIS SUITE DOES DIFFERENTLY
// ============================================================================
// Nothing in the data layer or the routes is mocked. The fake `pg` below is a
// tiny STATEFUL store: the writer's UPDATEs change the rows the readers then
// select, so the only way a case passes is for the write and every read to agree
// about where the name and GSTIN live. Each case goes through the real HTTP
// handlers:
//
//   POST /bills/:billId/customer-details   -> GET /bills/closed/:id
//                                          -> GET /bills/closed (the list row)
//                                          -> POST /print/bill/settled (the paper)

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { makeFakeApp, type FakeApp } from "./platform_fixtures";

const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";
const T3 = "33333333-3333-4333-8333-333333333333";
const RELEASED_BILL = "c10c81ea-46ca-4218-9a0b-2d45acdd9ba0";
const PAID_BILL = "66666666-6666-4666-8666-666666666666";
const PREVIOUS_BILL = "77777777-7777-4777-8777-777777777777";
const ACCOUNTING = "df75119b-e5f1-4f38-aba5-78a1cf182f56";
const VIEW_BILL = "98b10bde-802d-4a5b-a726-53a826424f79";
const NAME = "Navkrish Hospitality";
const GSTIN = "29AAXFN2701Q1ZF";

interface StoreBill {
  id: string; bill_no: string; table_id: string; closed_at: Date; created_at: Date;
  total_amt: number; tax_breakdown: unknown[]; closed_by_username: string; customer_gstin: string | null;
  admin_approved_at: Date | null;
}
interface StoreOrder { id: string; table_id: string; status: string; created_at: Date; food: Record<string, unknown> }

interface Store { bills: StoreBill[]; orders: StoreOrder[]; dispatched: string[] }
const store: Store = { bills: [], orders: [], dispatched: [] };

const t = (iso: string): Date => new Date(iso);

function seed(): void {
  store.dispatched = [];
  store.bills = [
    // An earlier seating on T3, so the window has a real lower bound.
    {
      id: PREVIOUS_BILL, bill_no: "4", table_id: T3, created_at: t("2026-09-13T10:55:09.900Z"),
      closed_at: t("2026-09-13T10:55:10.163Z"), total_amt: 0, tax_breakdown: [], closed_by_username: "released",
      customer_gstin: null, admin_approved_at: null,
    },
    // THE LIVE REPRO: released, zero total, only a cancelled order in its window.
    {
      id: RELEASED_BILL, bill_no: "5", table_id: T3, created_at: t("2026-09-13T10:55:33.479Z"),
      closed_at: t("2026-09-13T10:55:33.594Z"), total_amt: 0, tax_breakdown: [], closed_by_username: "released",
      customer_gstin: null, admin_approved_at: null,
    },
    // A normally PAID bill on T3 afterwards: one paid order and one voided in the same window.
    {
      id: PAID_BILL, bill_no: "6", table_id: T3, created_at: t("2026-09-13T12:10:00.000Z"),
      closed_at: t("2026-09-13T12:30:00.000Z"), total_amt: 1050, tax_breakdown: [{ name: "GST", percentage: 5, amount: 50 }],
      closed_by_username: "admin", customer_gstin: null, admin_approved_at: t("2026-09-13T12:30:00.000Z"),
    },
  ];
  store.orders = [
    { id: "o-prev", table_id: T3, status: "5", created_at: t("2026-09-13T10:55:09.663Z"), food: { customer: "Guest", items: [{ name: "Tea", price: 50, quantity: 1 }], subtotal: 50, total: 50 } },
    { id: "o-released", table_id: T3, status: "5", created_at: t("2026-09-13T10:55:33.101Z"), food: { customer: "Guest", items: [{ name: "Kronos", price: 390, quantity: 1 }], subtotal: 390, total: 390 } },
    // The voided round is OLDER than the paid one, and still says "Guest".
    { id: "o-void", table_id: T3, status: "5", created_at: t("2026-09-13T12:05:00.000Z"), food: { customer: "Guest", items: [{ name: "Naan", price: 60, quantity: 1 }], subtotal: 60, total: 60 } },
    { id: "o-paid", table_id: T3, status: "4", created_at: t("2026-09-13T12:10:00.000Z"), food: { customer: "Guest", items: [{ name: "Biryani", price: 500, quantity: 2 }], subtotal: 1000, total: 1000 } },
  ];
}

/** The row CLOSED_BILL_SELECT produces for a stored bill. */
const selectRow = (b: StoreBill) => ({
  id: b.id, bill_no: b.bill_no, status: b.total_amt > 0 ? 7 : 1, reason: null, table_id: b.table_id, table_name: "T3",
  total_amt: b.total_amt, tax_breakdown: b.tax_breakdown, payment_method: b.total_amt > 0 ? "Cash" : null,
  payment_splits: null, payment_proof_screenshot_url: null, discount_type: null, discount_value: 0,
  discount_applied_at: null, coupon_code: null, waiter_confirmed_at: b.admin_approved_at, waiter_confirmed_by_username: null,
  admin_approved_at: b.admin_approved_at, admin_approved_by_username: null, closed_at: b.closed_at,
  closed_by_username: b.closed_by_username, refunded_at: null, refunded_by_username: null, refund_amount: 0,
  refund_reason: null, refund_ref: null, created_at: b.created_at, created_by_fname: "Jim", created_by_lname: "",
  session_covers: 2, seated_at: b.created_at, left_at: b.closed_at,
});

/** ordersForClosedBill's window, evaluated over the store. */
function windowOrders(bill: StoreBill, statuses: string[]): StoreOrder[] {
  const prev = store.bills
    .filter((p) => p.table_id === bill.table_id && p.id !== bill.id && p.closed_at <= bill.closed_at)
    .reduce((m, p) => (p.closed_at > m ? p.closed_at : m), new Date(0));
  return store.orders
    .filter((o) => o.table_id === bill.table_id && statuses.includes(o.status) && o.created_at > prev && o.created_at <= bill.closed_at)
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
}

jest.mock("pg", () => {
  const query = async (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    const p = (params ?? []) as unknown[];
    const billById = (id: unknown) => store.bills.find((b) => b.id === id);
    if (/information_schema\.columns/i.test(q)) {
      return { rows: /'customer_gstin'/.test(q) ? [{ column_name: "customer_gstin" }] : [] };
    }
    if (/from "Restaurant" r/i.test(q)) {
      return { rows: [{
        res_id: RES, outlet_id: OUTLET, restaurant_slug: "gaia", restaurant_name: "Gaia",
        restaurant_main_office_add: null, restaurant_logo_url: null, timezone: "Asia/Kolkata",
      }] };
    }
    if (/^select service_charge from "Restaurant"/i.test(q)) { return { rows: [{ service_charge: 0 }] }; }
    // Writer: the settled-bill lookup.
    if (/^select b\.id, b\.bill_no::text as bill_no, b\.table_id, t\.table_name, b\.closed_at from "Bills" b/i.test(q)) {
      const b = billById(p[0]);
      return { rows: b ? [{ id: b.id, bill_no: b.bill_no, table_id: b.table_id, table_name: "T3", closed_at: b.closed_at }] : [] };
    }
    // Readers: CLOSED_BILL_SELECT — the detail (by id) and the list (the page).
    if (/^select b\.id, b\.bill_no, b\.status/i.test(q)) {
      if (/where b\.id = \$1/.test(q)) { const b = billById(p[0]); return { rows: b ? [selectRow(b)] : [] }; }
      return { rows: [...store.bills].sort((a, b) => b.closed_at.getTime() - a.closed_at.getTime()).map(selectRow) };
    }
    if (/^select count\(\*\)::text as total from "Bills"/i.test(q)) { return { rows: [{ total: String(store.bills.length) }] }; }
    if (/as prev_closed from "Bills"/i.test(q)) {
      const bill = billById(p[3])!;
      const prev = store.bills
        .filter((x) => x.table_id === bill.table_id && x.id !== bill.id && x.closed_at <= bill.closed_at)
        .reduce((m, x) => (x.closed_at > m ? x.closed_at : m), new Date(0));
      return { rows: [{ prev_closed: prev }] };
    }
    if (/^select id, created_at, status, food from "Orders"/i.test(q)) {
      const statuses = p[3] as string[];
      const closedAt = p[5] as Date;
      const bill = store.bills.find((b) => b.table_id === p[2] && b.closed_at.getTime() === closedAt.getTime())!;
      return { rows: windowOrders(bill, statuses).map((o) => ({ id: o.id, created_at: o.created_at, status: o.status, food: o.food })) };
    }
    if (/^select id, customer_gstin from "Bills"/i.test(q)) {
      const ids = p[1] as string[];
      return { rows: store.bills.filter((b) => ids.includes(b.id) && b.customer_gstin).map((b) => ({ id: b.id, customer_gstin: b.customer_gstin })) };
    }
    if (/^select customer_gstin from "Bills"/i.test(q)) {
      return { rows: [{ customer_gstin: billById(p[0])?.customer_gstin ?? null }] };
    }
    // The list's orders fallback, evaluated the way its SQL is written: the
    // identity statuses it is handed, settled before cancelled, oldest first.
    if (/^select b\.id::text as id, \(select nullif\(btrim\(o\.food::jsonb ->> 'customer_gstin'\)/i.test(q)) {
      expect(q).toMatch(/order by \(coalesce\(o\.status::text, '1'\) = '5'\) asc, o\.created_at asc/);
      const statuses = p[2] as string[];
      return { rows: (p[1] as string[]).map((id) => {
        const bill = billById(id)!;
        const hit = windowOrders(bill, statuses)
          .filter((o) => String(o.food.customer_gstin ?? "").trim())
          .sort((a, b) => Number(a.status === "5") - Number(b.status === "5"))[0];
        return { id, food_gstin: hit ? hit.food.customer_gstin : null };
      }) };
    }
    // Writes land in the store.
    if (/^update "Orders" set food/i.test(q)) {
      const o = store.orders.find((x) => x.id === p[0]);
      if (o) { o.food = JSON.parse(String(p[3])) as Record<string, unknown>; }
      return { rows: [] };
    }
    if (/^update "Bills" set customer_gstin = \$3 where id = \$1/i.test(q)) {
      const b = billById(p[0]);
      if (b) { b.customer_gstin = (p[2] as string | null) ?? null; }
      return { rows: [] };
    }
    if (/^(update|insert|delete)\b/i.test(q) && /"Bills"|"Orders"/.test(q)) {
      throw new Error(`round-trip fixture: unexpected write — ${q.slice(0, 160)}`);
    }
    return { rows: [] };
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> { return query(sql, params); }
    connect(): Promise<unknown> { return Promise.resolve({ query, release: () => undefined }); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

jest.mock("../print_routing", () => ({
  __esModule: true,
  dispatchPrintJob: jest.fn(async (_res: unknown, job: { esc_base64: string }) => {
    store.dispatched.push(job.esc_base64);
    return { jobId: "job-1", decision: { destinationName: "Front Till" }, assignedDeviceId: null };
  }),
}));
jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: jest.fn(), emitOutlet: jest.fn() }));
jest.mock("../storage_bucket_supabase", () => ({ __esModule: true, uploadScreenshot: jest.fn(), downloadFile: jest.fn() }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: jest.fn() }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

const ACCOUNTANT = { res_id: RES, outlet_id: OUTLET, employeeId: "emp-1", role: "manager", role_all: ["manager"], actions: [ACCOUNTING, VIEW_BILL] };

let harness: FakeApp;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  const bills = await import("../routes/bills");
  harness = makeFakeApp();
  bills.registerBillRoutes(harness.app as never);
  bills.registerBillPrintAndEditRoutes(harness.app as never);
  bills.registerBillOpsRoutes(harness.app as never);
});

beforeEach(() => { seed(); });

const edit = (billId: string, body: Record<string, unknown>) =>
  harness.call("POST", "/bills/:billId/customer-details", { params: { billId }, body, auth: ACCOUNTANT as never });
const detail = async (billId: string) =>
  (await harness.call("GET", "/bills/closed/:id", { params: { id: billId }, auth: ACCOUNTANT as never })).body as Record<string, unknown>;
const listRow = async (billId: string) =>
  ((await harness.call("GET", "/bills/closed", { query: {}, auth: ACCOUNTANT as never })).body as { bills: Record<string, unknown>[] })
    .bills.find((b) => b.id === billId)!;
const reprint = (billId: string) =>
  harness.call("POST", "/print/bill/settled", { body: { bill_id: billId }, auth: ACCOUNTANT as never });
const paper = (b64: string): string =>
  Buffer.from(b64, "base64").toString("latin1").replace(/\x1b@/g, "").replace(/\x1b[a!E][\s\S]/g, "").replace(/\x1dV[\s\S]/g, "");

describe("the live repro: a RELEASED bill whose only orders are cancelled", () => {
  test("write -> closed detail and list read back BOTH the name and the GSTIN", async () => {
    const w = await edit(RELEASED_BILL, { customer: NAME, customer_gstin: GSTIN });
    expect(w.status).toBe(200);
    expect(w.body).toEqual({ success: true, bill_id: RELEASED_BILL, customer: NAME, customer_gstin: GSTIN });

    const d = await detail(RELEASED_BILL);
    expect(d.customer).toBe(NAME);           // was null: the bug
    expect(d.customer_gstin).toBe(GSTIN);
    expect(d.grand_total).toBe(0);           // money is what it was

    expect((await listRow(RELEASED_BILL)).customer_gstin).toBe(GSTIN);
  });

  test("the name also reads back when the GSTIN is cleared (so nothing props it up from the column)", async () => {
    await edit(RELEASED_BILL, { customer: NAME, customer_gstin: GSTIN });
    await edit(RELEASED_BILL, { customer: NAME, customer_gstin: null });
    const d = await detail(RELEASED_BILL);
    expect(d.customer).toBe(NAME);
    expect(d.customer_gstin).toBeNull();
    expect((await listRow(RELEASED_BILL)).customer_gstin).toBeNull();
  });

  test("before migration-046's column holds anything, the list still finds the orders' copy", async () => {
    await edit(RELEASED_BILL, { customer: NAME, customer_gstin: GSTIN });
    store.bills.find((b) => b.id === RELEASED_BILL)!.customer_gstin = null; // only the orders carry it
    expect((await listRow(RELEASED_BILL)).customer_gstin).toBe(GSTIN);
    expect((await detail(RELEASED_BILL)).customer_gstin).toBe(GSTIN);
  });

  test("its reprint is still refused for having no settled lines — unchanged, and nothing prints", async () => {
    await edit(RELEASED_BILL, { customer: NAME, customer_gstin: GSTIN });
    const r = await reprint(RELEASED_BILL);
    expect(r.status).toBe(400);
    expect(store.dispatched).toHaveLength(0);
  });

  test("editing it does not leak into the neighbouring bills on the same table", async () => {
    await edit(RELEASED_BILL, { customer: NAME, customer_gstin: GSTIN });
    expect((await detail(PREVIOUS_BILL)).customer).toBeNull();
    expect((await detail(PAID_BILL)).customer).toBeNull();
    expect((await detail(PAID_BILL)).customer_gstin).toBeNull();
  });
});

describe("a normally PAID bill with a voided round in its window", () => {
  test("write -> closed detail, list row AND the settled reprint all carry both", async () => {
    const w = await edit(PAID_BILL, { customer: NAME, customer_gstin: "29aaxfn 2701q1zf" });
    expect(w.body).toEqual({ success: true, bill_id: PAID_BILL, customer: NAME, customer_gstin: GSTIN });

    const d = await detail(PAID_BILL);
    expect(d.customer).toBe(NAME);
    expect(d.customer_gstin).toBe(GSTIN);
    expect(d.grand_total).toBe(1050);
    expect(d.totals_reconciled).toBe(true);
    expect((await listRow(PAID_BILL)).customer_gstin).toBe(GSTIN);

    const r = await reprint(PAID_BILL);
    expect(r.status).toBe(200);
    expect(store.dispatched).toHaveLength(1);
    const out = paper(store.dispatched[0]);
    expect(out).toMatch(new RegExp(`^Customer Name: ${NAME}$`, "m"));
    expect(out).toMatch(new RegExp(`^Customer GSTIN: ${GSTIN}$`, "m"));
    expect(out).toContain("REPRINT");
  });

  test("the voided round is renamed too, so the name cannot depend on which set a reader picks", async () => {
    await edit(PAID_BILL, { customer: NAME, customer_gstin: GSTIN });
    for (const id of ["o-void", "o-paid"]) {
      const o = store.orders.find((x) => x.id === id)!;
      expect(o.food.customer).toBe(NAME);
      expect(o.food.customer_gstin).toBe(GSTIN);
    }
    // And the other seatings' orders are untouched.
    expect(store.orders.find((x) => x.id === "o-released")!.food.customer).toBe("Guest");
  });

  test("a name-only edit reprints the new name with the GSTIN it already had", async () => {
    await edit(PAID_BILL, { customer: "Old Name", customer_gstin: GSTIN });
    await edit(PAID_BILL, { customer: NAME });
    const out = paper((await reprint(PAID_BILL), store.dispatched[store.dispatched.length - 1]));
    expect(out).toMatch(new RegExp(`^Customer Name: ${NAME}$`, "m"));
    expect(out).toMatch(new RegExp(`^Customer GSTIN: ${GSTIN}$`, "m"));
    expect(out).not.toContain("Old Name");
  });
});
