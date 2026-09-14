// GET /bills/closed CUTS DAYS IN THE RESTAURANT'S ZONE — the HTTP half.
//
// Accounting lists settled bills directly under Sales/GST/P&L for the same
// picked days. The list used to widen `to=YYYY-MM-DD` to T23:59:59.999Z in the
// ROUTE and bind a bare `from` for Postgres to cast in the session zone (UTC),
// so for a Kolkata tenant "2 Aug" listed 05:30 on the 2nd to 05:29 on the 3rd
// while the reports counted 00:00 to 23:59 IST. test/money/report_agreement
// proves ListClosedBills and GetSalesReport now agree about a 00:30 IST bill;
// this suite pins the other half — that the ROUTE hands the day keys through
// untouched, so the zone cut actually happens. Re-adding endOfDayBound here
// turns `to` into a UTC instant, and the bound below stops being local midnight.
//
// Nothing in the data layer or the routes is mocked: the fake `pg` records the
// bound parameters of ListClosedBills' two statements (count + page).

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { makeFakeApp, type FakeApp } from "./platform_fixtures";

const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";
const VIEW_BILL = "98b10bde-802d-4a5b-a726-53a826424f79";

interface Captured { sql: string; params: unknown[] }
const seen: Captured[] = [];

jest.mock("pg", () => {
  const query = async (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    const p = (params ?? []) as unknown[];
    if (/from "Restaurant" r/i.test(q)) {
      return { rows: [{
        res_id: RES, outlet_id: OUTLET, restaurant_slug: "gaia", restaurant_name: "Gaia",
        restaurant_main_office_add: null, restaurant_logo_url: null, timezone: "Asia/Kolkata",
      }] };
    }
    if (/^select service_charge from "Restaurant"/i.test(q)) { return { rows: [{ service_charge: 0 }] }; }
    if (/^select count\(\*\)::text as total from "Bills"/i.test(q)) {
      seen.push({ sql: q, params: p });
      return { rows: [{ total: "0" }] };
    }
    if (/^select b\.id, b\.bill_no, b\.status/i.test(q)) {
      seen.push({ sql: q, params: p });
      return { rows: [] };
    }
    if (/^(update|insert|delete)\b/i.test(q) && /"Bills"|"Orders"/.test(q)) {
      throw new Error(`closed-bill bounds fixture: unexpected write — ${q.slice(0, 160)}`);
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

jest.mock("../print_routing", () => ({ __esModule: true, dispatchPrintJob: jest.fn() }));
jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: jest.fn(), emitOutlet: jest.fn() }));
jest.mock("../storage_bucket_supabase", () => ({ __esModule: true, uploadScreenshot: jest.fn(), downloadFile: jest.fn() }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: jest.fn() }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

const ACCOUNTANT = { res_id: RES, outlet_id: OUTLET, employeeId: "emp-1", role: "manager", role_all: ["manager"], actions: [VIEW_BILL] };

let harness: FakeApp;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  const bills = await import("../routes/bills");
  harness = makeFakeApp();
  bills.registerBillRoutes(harness.app as never);
});

beforeEach(() => { seen.length = 0; });

const list = (query: Record<string, string>) =>
  harness.call("GET", "/bills/closed", { query, auth: ACCOUNTANT as never });

/** The (operator, bound) pairs ListClosedBills put on the settle instant. */
function dayBounds(c: Captured): [string, unknown][] {
  const re = /coalesce\(b\.closed_at, b\.admin_approved_at, b\.created_at\) (>=|<=|<) \$(\d+)/g;
  const out: [string, unknown][] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(c.sql)) !== null) { out.push([m[1], c.params[Number(m[2]) - 1]]); }
  return out;
}

describe("GET /bills/closed day bounds", () => {
  test("a picked day is [local midnight, next local midnight) in Asia/Kolkata, on BOTH statements", async () => {
    const r = await list({ restaurantId: RES, from: "2026-08-02", to: "2026-08-02" });
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(2); // count + page, same predicate
    for (const c of seen) {
      expect(dayBounds(c)).toEqual([
        [">=", "2026-08-01T18:30:00.000Z"], // 2 Aug 00:00 IST
        ["<", "2026-08-02T18:30:00.000Z"],  // 3 Aug 00:00 IST, exclusive
      ]);
    }
  });

  test("a range's `to` is inclusive of its own last day", async () => {
    await list({ restaurantId: RES, from: "2026-08-01", to: "2026-08-15" });
    expect(dayBounds(seen[0])).toEqual([
      [">=", "2026-07-31T18:30:00.000Z"],
      ["<", "2026-08-15T18:30:00.000Z"],
    ]);
  });

  test("no from/to is still no date bound at all (History lists everything)", async () => {
    await list({ restaurantId: RES });
    expect(seen).toHaveLength(2);
    for (const c of seen) { expect(dayBounds(c)).toEqual([]); }
  });

  test("a full ISO instant is bound as that instant, inclusive", async () => {
    await list({ restaurantId: RES, from: "2026-08-01T19:00:00.000Z", to: "2026-08-02T18:30:00.000Z" });
    expect(dayBounds(seen[0])).toEqual([
      [">=", "2026-08-01T19:00:00.000Z"],
      ["<=", "2026-08-02T18:30:00.000Z"],
    ]);
  });
});
