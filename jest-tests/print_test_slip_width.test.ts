// POST /print/test PRINTS ON THE RESTAURANT'S OWN ROLL.
//
// The test slip is the restaurant's reference docket, and a raster docket's
// width is its image's width in dots — 576 on an 80mm roll (48 columns), 384 on
// 58mm (32). The slip was built at a fixed 48 columns, so a 58mm printer, which
// prints every real docket at 384 dots, was sent a 576-dot image it drops or
// crops: the one button that answers "does paper come out of that machine?"
// said no on a printer that works, and pointed the owner at the Classic switch.
//
// The REAL handler runs over a fake Express app; the data layer's reads, the
// dispatcher and the realtime layer are stubbed, and what is asserted is the
// raster header of the bytes that would reach the printer.

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { kotPaper } from "./kot_raster_read";

const RES = "11111111-1111-4111-8111-111111111111";
const OUTLET = "22222222-2222-4222-8222-222222222222";
const PERM_PRINT = "4ad474d4-5230-449c-874f-6a238b833bca";

const mockJobs: { bill_id: string; kind: string; station: string | null; esc_base64: string }[] = [];
const mockSettings: { value: Record<string, unknown> | Error } = { value: {} };
const mockStyle: { value: string } = { value: "reference" };

jest.mock("pg", () => {
  class FakePool {
    on(): this { return this; }
    query(): Promise<never> { return Promise.reject(new Error("print test fixture: no query is stubbed")); }
    connect(): Promise<never> { return Promise.reject(new Error("print test fixture: pool.connect() is not stubbed")); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

jest.mock("../realtime", () => ({
  __esModule: true,
  getIo: () => null,
  outletDeviceSockets: () => Promise.resolve([]),
  realtimeAdapterReady: () => false,
  syncDeviceRooms: () => Promise.resolve(),
  emitRestaurant: jest.fn(),
  emitOutlet: jest.fn(),
}));

jest.mock("../print_routing", () => ({
  __esModule: true,
  dispatchPrintJob: (_res: string, job: { bill_id: string; kind: string; station: string | null; esc_base64: string }) => {
    mockJobs.push(job);
    return Promise.resolve({
      jobId: `job-${String(mockJobs.length)}`, assignedDeviceId: null,
      decision: { mode: "broadcast", reason: "no_rule", destinationName: null, destinationId: null },
    });
  },
}));

jest.mock("../database_supabase", () => {
  const actual = jest.requireActual("../database_supabase") as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    GetRestaurantProfile: () => Promise.resolve({ outlet_name: "Gaia", restaurant_name: "Gaia" }),
    GetKotPrintStyle: () => Promise.resolve(mockStyle.value),
    GetKotTextSize: () => Promise.resolve("standard"),
    GetRestaurantSettings: () => (mockSettings.value instanceof Error
      ? Promise.reject(mockSettings.value)
      : Promise.resolve({ currency: "₹", timezone: "Asia/Kolkata", ...mockSettings.value })),
    ListPrintRoutes: () => Promise.resolve([]),
    GetEmployeeDetailsFromEmpID: () => Promise.resolve({ id: "emp-1", res_id: RES, outlet_id: OUTLET, username: "owner" }),
    AddAuditLogEntry: () => Promise.resolve(undefined),
  };
});

type Next = (err?: unknown) => void;
type Handler = (req: any, res: any, next: Next) => unknown;
const registered: { method: string; path: string; handlers: Handler[] }[] = [];
const record = (method: string) => (path: string, ...handlers: Handler[]): unknown => { registered.push({ method, path, handlers }); return fakeApp; };
const fakeApp = { get: record("GET"), post: record("POST"), put: record("PUT"), patch: record("PATCH"), delete: record("DELETE"), use: (): unknown => fakeApp };

const OWNER = { res_id: RES, outlet_id: OUTLET, employeeId: "3f3f3f3f-1111-4111-8111-3f3f3f3f3f3f", role: "admin", actions: [PERM_PRINT] };

async function pressTest(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const route = registered.find((r) => r.method === "POST" && r.path === "/print/test");
  if (!route) { throw new Error("POST /print/test not registered"); }
  const out: { status: number; body: any } = { status: 200, body: undefined };
  let ended = false;
  const res = {
    status(code: number) { out.status = code; return res; },
    json(p: unknown) { if (!ended) { out.body = p; ended = true; } return res; },
    send(p: unknown) { if (!ended) { out.body = p; ended = true; } return res; },
    setHeader() { return res; }, end() { ended = true; return res; },
  };
  const req = { params: {}, body, query: {}, headers: {}, auth: OWNER };
  for (const h of route.handlers) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (ended || !advanced) { break; }
  }
  return out;
}

/** The dot width of the first GS v 0 block in a job's bytes, or null for a text slip. */
function rasterWidthDots(b64: string): number | null {
  const b = Buffer.from(b64, "base64");
  for (let i = 0; i + 7 < b.length; i++) {
    if (b[i] === 0x1d && b[i + 1] === 0x76 && b[i + 2] === 0x30) {
      return ((b[i + 4] ?? 0) | ((b[i + 5] ?? 0) << 8)) * 8;
    }
  }
  return null;
}

beforeEach(async () => {
  if (registered.length === 0) {
    process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
    const printing = await import("../routes/printing");
    printing.registerPrintRoutingRoutes(fakeApp as never);
  }
  mockJobs.length = 0;
  mockSettings.value = {};
  mockStyle.value = "reference";
});

describe("the test slip is as wide as the restaurant's roll", () => {
  test.each([
    ["58mm", 384, 32],
    ["80mm", 576, 48],
  ] as const)("a %s restaurant's slip is a %i-dot raster", async (width, dots, cols) => {
    mockSettings.value = { bill_paper_width: width };
    const r = await pressTest({ role: "kot" });
    expect(r.status).toBe(200);
    expect(mockJobs).toHaveLength(1);
    expect(rasterWidthDots(mockJobs[0]!.esc_base64)).toBe(dots);
    // …and it reads back on that roll as the slip it is.
    expect(kotPaper(mockJobs[0]!.esc_base64, cols)).toContain("PRINTER TEST");
  });

  test("a restaurant that never chose a width, or whose settings cannot be read, gets 80mm — as before", async () => {
    mockSettings.value = { bill_paper_width: null };
    await pressTest({ role: "bill" });
    mockSettings.value = new Error("connection terminated unexpectedly");
    const r = await pressTest({ role: "kot:BAR" });
    expect(r.status).toBe(200);
    expect(mockJobs.map((j) => rasterWidthDots(j.esc_base64))).toEqual([576, 576]);
  });

  test("the Classic docket's slip is text at the roll's own width", async () => {
    mockStyle.value = "classic";
    mockSettings.value = { bill_paper_width: "58mm" };
    await pressTest({ role: "kot" });
    const text = Buffer.from(mockJobs[0]!.esc_base64, "base64").toString("latin1");
    expect(rasterWidthDots(mockJobs[0]!.esc_base64)).toBeNull();
    // Its rules are the 32-column roll's, not the 48-column one's.
    const rules = (text.match(/-{10,}/g) ?? []).map((r) => r.length);
    expect(rules.length).toBeGreaterThan(0);
    expect(new Set(rules)).toEqual(new Set([32]));
  });
});
