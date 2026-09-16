// THE SETTINGS ROUTE HALF OF THE KOT DOCKET SWITCH.
//
// An owner whose kitchen printer is producing blank tickets has to be able to
// put that kitchen back on the text docket from the Settings screen, in the next
// minute, without anybody deploying anything. Everything this file pins is a way
// that could fail while LOOKING like it worked:
//
//   * the setting has to come back on the GET, and to EVERYONE who can open
//     Settings — the print page and the cashier read this document too, and a
//     value only an admin can see is a value the screen cannot render;
//   * WRITING it is admin work (PERM_SETTINGS), because it changes what an
//     entire kitchen's paper is made of;
//   * a value that is not one of the two styles is REFUSED OUT LOUD. This is the
//     one that matters: coercing it to the default would answer 200 to an owner
//     who just chose "Classic text docket" and leave the kitchen on the docket
//     it cannot print — and a save reporting success is exactly what stops
//     somebody looking for the real problem;
//   * omitting the key leaves the stored value alone, so an older client cannot
//     move a kitchen off the docket it is printing by not knowing about it;
//   * the change is AUDITED by name, because "why did the kitchen stop getting
//     paper on the 14th?" is answered by scanning audit entries.
//
// The REAL handler runs; only the reads and the write either side of it are
// stubbed, so what is asserted is what a `curl` would see.

import { describe, test, expect, beforeEach, jest } from "@jest/globals";

const RES = "11111111-1111-4111-8111-111111111111";
const OUTLET = "22222222-2222-4222-8222-222222222222";
const PERM_SETTINGS = "6d0f3a94-8b21-4c67-9e53-1a4d7b2f8c60";

/** Every opts object SetRestaurantSettings was handed. */
const mockSaved: Record<string, unknown>[] = [];
/** Every audit entry written. */
const mockAudits: { action: string; details: Record<string, unknown> | undefined }[] = [];
/** What the settings document currently says. */
const mockSettings: { value: Record<string, unknown> } = { value: {} };

jest.mock("../database_supabase", () => {
  const actual = jest.requireActual("../database_supabase") as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    GetRestaurantSettings: () => Promise.resolve({
      currency: "₹", bill_paper_width: "80mm", timezone: "Asia/Kolkata",
      auto_push_orders: true, kot_auto_print: true, bill_show_qr: true,
      kot_print_style: "reference",
      ...mockSettings.value,
    }),
    SetRestaurantSettings: (_id: string, opts: Record<string, unknown>) => {
      mockSaved.push(opts);
      return Promise.resolve({
        currency: "₹", auto_push_orders: true,
        // What the data layer would report back after the write: the stored
        // style, or the one it already had when this request did not touch it.
        kot_print_style: typeof opts.kot_print_style === "string" ? opts.kot_print_style : "reference",
      });
    },
    GetEmployeeDetailsFromEmpID: () => Promise.resolve({
      id: "emp-1", res_id: RES, outlet_id: OUTLET, username: "owner", emp_Fname: "Owner", emp_Lname: "One",
    }),
    AddAuditLogEntry: (
      _res: string, _outlet: string, _emp: string, _action: string,
      description: string, _category: unknown, details?: Record<string, unknown>,
    ) => { mockAudits.push({ action: description, details }); return Promise.resolve(undefined); },
  };
});

type Next = (err?: unknown) => void;
type Handler = (req: any, res: any, next: Next) => unknown;
const registered: { method: string; path: string; handlers: Handler[] }[] = [];
const record = (method: string) => (path: string, ...handlers: Handler[]): unknown => { registered.push({ method, path, handlers }); return fakeApp; };
const fakeApp = { get: record("GET"), post: record("POST"), put: record("PUT"), patch: record("PATCH"), delete: record("DELETE"), use: (): unknown => fakeApp };

const identity = (actions: string[]) => ({
  res_id: RES, outlet_id: OUTLET, employeeId: "3f3f3f3f-1111-4111-8111-3f3f3f3f3f3f",
  employeeUsername: "someone", role: "employee", actions,
});
/** The owner. Admin expands to the wildcard at login. */
const ADMIN = identity(["*"]);
/** A cashier who can open Settings but cannot change them. */
const CASHIER = identity(["98b10bde-802d-4a5b-a726-53a826424f79"]);

async function callRoute(
  method: "GET" | "POST",
  body: Record<string, unknown>,
  auth: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const route = registered.find((r) => r.method === method && r.path === "/restaurant/settings");
  if (!route) { throw new Error(`${method} /restaurant/settings not registered`); }
  const out: { status: number; body: any } = { status: 200, body: undefined };
  let ended = false;
  const res = {
    status(code: number) { out.status = code; return res; },
    json(p: unknown) { if (!ended) { out.body = p; ended = true; } return res; },
    send(p: unknown) { if (!ended) { out.body = p; ended = true; } return res; },
    setHeader() { return res; }, end() { ended = true; return res; },
  };
  const req = { params: {}, body, query: {}, headers: {}, auth };
  for (const h of route.handlers) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (ended || !advanced) { break; }
  }
  return out;
}

const getSettings = (auth = ADMIN) => callRoute("GET", {}, auth);
const postSettings = (body: Record<string, unknown>, auth = ADMIN) => callRoute("POST", body, auth);

beforeEach(async () => {
  if (registered.length === 0) {
    process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
    const settings = await import("../routes/settings");
    settings.registerSettingsRoutes(fakeApp as never);
  }
  mockSaved.length = 0;
  mockAudits.length = 0;
  mockSettings.value = {};
});

describe("GET /restaurant/settings carries the KOT docket style", () => {
  test("an admin sees it", async () => {
    mockSettings.value = { kot_print_style: "classic" };
    const r = await getSettings();
    expect(r.status).toBe(200);
    expect(r.body.kot_print_style).toBe("classic");
  });

  test("so does a cashier — it is an operational field, not a credential", async () => {
    // The redacted (non-admin) document is what the print page and every POS
    // screen read. A setting only an admin can SEE is a setting the Settings
    // screen renders blank for everyone else, and one the print path could not
    // read if it ever needed to.
    mockSettings.value = { kot_print_style: "classic" };
    const r = await getSettings(CASHIER);
    expect(r.status).toBe(200);
    expect(r.body.kot_print_style).toBe("classic");
  });
});

describe("POST /restaurant/settings writes the KOT docket style", () => {
  test("choosing the classic docket reaches the data layer", async () => {
    const r = await postSettings({ kot_print_style: "classic" });
    expect(r.status).toBe(200);
    expect(mockSaved).toHaveLength(1);
    expect(mockSaved[0]!.kot_print_style).toBe("classic");
  });

  test("choosing the reference docket back again reaches it too", async () => {
    const r = await postSettings({ kot_print_style: "reference" });
    expect(r.status).toBe(200);
    expect(mockSaved[0]!.kot_print_style).toBe("reference");
  });

  test("a value that is not a style is refused out loud, and nothing is written", async () => {
    // The sentence has to name the accepted values: the person reading it is
    // standing at a printer that is not printing.
    const r = await postSettings({ kot_print_style: "raster" });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("classic");
    expect(String(r.body.error)).toContain("reference");
    expect(mockSaved).toHaveLength(0);
  });

  test("an empty string is refused rather than read as the default", async () => {
    // "" is what a half-built form sends. Treating it as "reference" would turn
    // a broken screen into a silent docket change.
    const r = await postSettings({ kot_print_style: "" });
    expect(r.status).toBe(400);
    expect(mockSaved).toHaveLength(0);
  });

  test("an explicit null is 'unchanged', not a bad value", async () => {
    // A client that READS the settings document and posts it back sends what the
    // server gave it. Refusing its null would turn every such save into a 400
    // over a switch that client has never heard of — and null and 'reference'
    // mean the same thing in the column, so nothing is being lost.
    const r = await postSettings({ kot_print_style: null });
    expect(r.status).toBe(200);
    expect(mockSaved).toHaveLength(1);
    expect(mockSaved[0]!.kot_print_style).toBeNull();
  });

  test("a request that does not mention it leaves the stored value alone", async () => {
    // An older client saving the currency must not move a kitchen off the docket
    // it is printing.
    const r = await postSettings({ currency: "₹" });
    expect(r.status).toBe(200);
    expect(mockSaved).toHaveLength(1);
    expect(mockSaved[0]).not.toHaveProperty("kot_print_style", "reference");
    expect(mockSaved[0]!.kot_print_style).toBeUndefined();
  });
});

describe("only an admin can change what the kitchen's paper is made of", () => {
  test("a cashier is refused, and nothing is written", async () => {
    const r = await postSettings({ kot_print_style: "classic" }, CASHIER);
    expect(r.status).toBe(403);
    expect(mockSaved).toHaveLength(0);
  });

  test("the permission checked is the settings one", async () => {
    // Pinned so a future re-gate has to be deliberate: this switch travels in
    // the settings document and must not become readable-to-write.
    const r = await postSettings({ kot_print_style: "classic" }, identity([PERM_SETTINGS]));
    expect(r.status).toBe(200);
    expect(mockSaved[0]!.kot_print_style).toBe("classic");
  });
});

describe("the change is audited", () => {
  test("the entry names the style that is now in force", async () => {
    await postSettings({ kot_print_style: "classic" });
    expect(mockAudits).toHaveLength(1);
    expect(mockAudits[0]!.details?.kot_print_style).toBe("classic");
  });

  test("a save that did not touch it does not claim it did", async () => {
    // An audit line that named this setting on every currency change would be
    // noise in the one log somebody scans to answer "when did the dockets
    // change?".
    await postSettings({ currency: "₹" });
    expect(mockAudits).toHaveLength(1);
    expect(mockAudits[0]!.details).not.toHaveProperty("kot_print_style");
  });

  test("a refused value is never audited — nothing happened", async () => {
    await postSettings({ kot_print_style: "raster" });
    expect(mockAudits).toHaveLength(0);
  });
});
