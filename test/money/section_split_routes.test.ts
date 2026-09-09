// THE SPLIT ROUTE AFTER THE SECTION MODE — and, first of all, THE PROOF THAT IT
// DID NOT CHANGE.
//
// POST /bills/split is what every shipped till calls to divide a bill by head
// count. It now also divides one by the part of the MENU the food came from. The
// first thing asserted here is a NEGATIVE: a request that says nothing about
// sections reaches SplitBillForTable with the same four arguments it always did
// and gets that function's own object back. The by-covers split is the mode on
// real tills today and it is not being renegotiated by a new feature.
//
// WHY THE HANDLER AND NOT THE MATH. billing_math's allocation is proved to the
// paisa in jest-tests/bill_section_split.test.ts and test/money/money_invariants.
// What is unproved is the WIRING: which axis a body resolves to, what happens to
// an axis this build has never heard of, and whether the till is warned when a
// split produces more parts than a bill can be settled across. Those are the
// things that put a guest at a counter with an amount nobody can take.
//
// `pg` is mocked to a pool that refuses every query, so a handler that reached
// the database through an unstubbed path fails loudly here.

import { describe, test, expect, beforeEach, jest } from "@jest/globals";

jest.mock("pg", () => {
  class FakePool {
    on(): this { return this; }
    query(): Promise<never> { return Promise.reject(new Error("split route fixture: no query is stubbed")); }
    connect(): Promise<never> { return Promise.reject(new Error("split route fixture: pool.connect() is not stubbed")); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

interface MockCall { fn: string; args: unknown[] }
const mockCalls: MockCall[] = [];

const mockNext: { split: unknown; sectionSplit: Record<string, unknown>; throws: string | null } = {
  split: {},
  sectionSplit: {},
  throws: null,
};

jest.mock("../../database_supabase", () => {
  const actual = jest.requireActual("../../database_supabase") as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    SplitBillForTable: (...args: unknown[]) => {
      mockCalls.push({ fn: "SplitBillForTable", args });
      return Promise.resolve(mockNext.split);
    },
    SplitBillForTableBySection: (...args: unknown[]) => {
      mockCalls.push({ fn: "SplitBillForTableBySection", args });
      if (mockNext.throws) { return Promise.reject(new Error(mockNext.throws)); }
      return Promise.resolve(mockNext.sectionSplit);
    },
    GetEmployeeDetailsFromEmpID: (...args: unknown[]) => {
      mockCalls.push({ fn: "GetEmployeeDetailsFromEmpID", args });
      return Promise.resolve({ id: "emp-1", res_id: "res-1", outlet_id: "out-1", username: "cashier1", name: "Cashier One" });
    },
    AddAuditLogEntry: (...args: unknown[]) => {
      mockCalls.push({ fn: "AddAuditLogEntry", args });
      return Promise.resolve(undefined);
    },
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
const AUTH = {
  res_id: RES, outlet_id: "out-1", employeeId: "3f3f3f3f-1111-4111-8111-3f3f3f3f3f3f",
  employeeUsername: "cashier1", role: "admin", actions: ["*"],
};

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

const split = (body: unknown): Promise<Answer> => call("POST", "/bills/split", body);
const callsTo = (fn: string): MockCall[] => mockCalls.filter((c) => c.fn === fn);
const argsOf = (fn: string): unknown[] => callsTo(fn)[0]?.args ?? [];

/** A section split as the data layer returns it: two paying sections. */
const TWO_SECTIONS = {
  mode: "section",
  axis: "category",
  grand_total: 1155,
  payable_parts: 2,
  notes: ["Sections are the menu categories already on the menu screen (sub-category, falling back to main)."],
  parts: [
    { key: "category:mains", label: "Mains", gap: false, total: 808.5, grand_total: 808.5 },
    { key: "category:bar", label: "Bar", gap: false, total: 346.5, grand_total: 346.5 },
  ],
};

beforeEach(async () => {
  if (registered.length === 0) {
    process.env.SUPABASE_DIRECT_URL =
      process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
    const bills = await import("../../routes/bills");
    bills.registerBillOpsRoutes(fakeApp as never);
  }
  mockCalls.length = 0;
  mockNext.split = { mode: "even", grand_total: 1000, parts: [] };
  mockNext.sectionSplit = { ...TWO_SECTIONS };
  mockNext.throws = null;
});

describe("PARITY: the by-covers split is untouched", () => {
  test("THE HEADLINE: a body with no mode still reaches SplitBillForTable with the same four arguments, and its OWN object comes back", async () => {
    const answer = await split({ table_name: "T1", parts: 3 });

    expect(answer.status).toBe(200);
    expect(argsOf("SplitBillForTable")).toEqual([RES, "T1", "even", { parts: 3, groups: undefined }]);
    // The same object, not a copy: a handler that had started composing a richer
    // response would fail here even if every field happened to match.
    expect(answer.body).toBe(mockNext.split);
    expect(callsTo("SplitBillForTableBySection")).toHaveLength(0);
  });

  test("the item mode still reaches the same function with its groups", async () => {
    const groups = [{ label: "A", items: [{ name: "x", price: 10, quantity: 1 }] }];
    await split({ table_name: "T1", mode: "item", groups });
    expect(argsOf("SplitBillForTable")).toEqual([RES, "T1", "item", { parts: undefined, groups }]);
    expect(callsTo("SplitBillForTableBySection")).toHaveLength(0);
  });

  test("a mode this build does not know still falls back to the by-covers split, never to sections", async () => {
    await split({ table_name: "T1", mode: "by_planet" });
    expect(argsOf("SplitBillForTable")[2]).toBe("even");
    expect(callsTo("SplitBillForTableBySection")).toHaveLength(0);
  });

  test("table_name is still required, in both modes", async () => {
    expect((await split({ mode: "section" })).status).toBe(400);
    expect((await split({})).status).toBe(400);
    expect(mockCalls).toHaveLength(0);
  });
});

describe("the section mode: which axis a body resolves to", () => {
  test("no axis at all means CATEGORY — the cut that works before anything is configured", async () => {
    const answer = await split({ table_name: "T1", mode: "section" });
    expect(answer.status).toBe(200);
    expect(argsOf("SplitBillForTableBySection")).toEqual([RES, "T1", "category"]);
    expect(callsTo("SplitBillForTable")).toHaveLength(0);
  });

  test("each axis is reachable, under the words a till is likely to send", async () => {
    const wanted: [string, string][] = [
      ["category", "category"], ["Categories", "category"], ["menu_category", "category"],
      ["revenue_group", "revenue_group"], ["revenue", "revenue_group"], ["Group", "revenue_group"],
      ["production_group", "production_group"], ["production", "production_group"],
      ["  Revenue Group  ", "revenue_group"], ["production-group", "production_group"],
    ];
    for (const [sent, resolved] of wanted) {
      mockCalls.length = 0;
      await split({ table_name: "T1", mode: "section", axis: sent });
      expect(argsOf("SplitBillForTableBySection")[2]).toBe(resolved);
    }
  });

  test("`by` is accepted as well as `axis`, because both read naturally on the wire", async () => {
    await split({ table_name: "T1", mode: "section", by: "revenue" });
    expect(argsOf("SplitBillForTableBySection")[2]).toBe("revenue_group");
  });

  test("AN AXIS THIS BUILD HAS NEVER HEARD OF IS REFUSED, not quietly answered along a different one", async () => {
    const answer = await split({ table_name: "T1", mode: "section", axis: "allergen" });
    expect(answer.status).toBe(400);
    // The refusal names the three, so the till can offer them.
    expect(String(answer.body.error)).toContain("category");
    expect(String(answer.body.error)).toContain("revenue_group");
    expect(String(answer.body.error)).toContain("production_group");
    // Nothing was computed and nothing was read.
    expect(mockCalls).toHaveLength(0);
  });

  test("a table with no open bill answers 400 with the data layer's own sentence", async () => {
    mockNext.throws = "No open bill for this table";
    const answer = await split({ table_name: "T9", mode: "section" });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe("No open bill for this table");
  });

  test("the split reads a bill but changes nothing — no audit entry, no write", async () => {
    await split({ table_name: "T1", mode: "section" });
    expect(callsTo("AddAuditLogEntry")).toHaveLength(0);
  });
});

describe("the tender ceiling is said up front, not discovered at the till", () => {
  test("a split within the ceiling passes the data layer's parts and notes through unchanged", async () => {
    const answer = await split({ table_name: "T1", mode: "section" });
    expect(answer.body.parts).toEqual(TWO_SECTIONS.parts);
    expect(answer.body.axis).toBe("category");
    expect(answer.body.tender_ceiling).toBe(6);
    expect(answer.body.exceeds_tender_ceiling).toBe(false);
    expect(answer.body.notes).toEqual(TWO_SECTIONS.notes);
  });

  test("EXACTLY six payable sections is still settleable — the boundary is not off by one", async () => {
    mockNext.sectionSplit = { ...TWO_SECTIONS, payable_parts: 6 };
    const answer = await split({ table_name: "T1", mode: "section" });
    expect(answer.body.exceeds_tender_ceiling).toBe(false);
    expect(answer.body.notes).toEqual(TWO_SECTIONS.notes);
  });

  test("a SEVENTH payable section is flagged, with a sentence saying what to do about it", async () => {
    mockNext.sectionSplit = { ...TWO_SECTIONS, payable_parts: 7 };
    const answer = await split({ table_name: "T1", mode: "section" });
    expect(answer.body.exceeds_tender_ceiling).toBe(true);
    expect(answer.body.notes).toHaveLength(TWO_SECTIONS.notes.length + 1);
    const added = String(answer.body.notes[answer.body.notes.length - 1]);
    expect(added).toContain("7");
    expect(added).toContain("6");
    // The parts themselves are NOT trimmed to fit: the split still says what the
    // sections came to. Folding two of them together is a decision for the person
    // at the till, because it decides who pays for whose food.
    expect(answer.body.parts).toEqual(TWO_SECTIONS.parts);
  });

  test("a fully comped section does not count against the ceiling — payable_parts is the data layer's own count", async () => {
    mockNext.sectionSplit = { ...TWO_SECTIONS, payable_parts: 0 };
    const answer = await split({ table_name: "T1", mode: "section" });
    expect(answer.body.exceeds_tender_ceiling).toBe(false);
  });
});
