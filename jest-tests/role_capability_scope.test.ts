// C5 / C6 / C7 — the access-control surface, and the capability block the
// clients are meant to OBEY instead of deriving.
//
// ============================================================================
// WHAT EACH PART PROVES
// ============================================================================
//
// sessionCapabilities  — the server ships ANSWERS ("may I settle", "may I delete
//   a table") rather than the uuids to test against. If every client tested the
//   uuid itself, the constant would be written out in Dart, in TypeScript and in
//   whatever ships next, the route's gate would be free to move, and the three
//   would drift. That is the csrorganics failure mode with a different constant.
//
// CORE_ROLES — the role definitions that decide who can do what out of the box.
//   Two properties are load-bearing and neither is obvious from reading the
//   array: a WAITER must hold no settle capability (C2), and a MANAGER must hold
//   one (also C2 — a rule that stops waiters settling while leaving managers
//   unable to settle leaves nobody at the till but the owner).
//
// POST /roles — C5 opens role editing to managers, which turns "edit a role"
//   into "grant myself anything" unless delegation is bounded. The guard is that
//   a non-admin may only put into a role what they already hold.
//
// GET /core-roles — C6. The rows must be readable without a second call to a
//   differently-permissioned endpoint, and must never quietly shorten.

import { describe, test, expect, beforeAll } from "@jest/globals";
import { makeFakeApp, type FakeApp } from "./platform_fixtures";

jest.mock("pg", () => {
  interface FixtureGlobal {
    __platformFixtureConnect?: () => { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; release: () => void };
  }
  const conn = () => {
    const make = (globalThis as unknown as FixtureGlobal).__platformFixtureConnect;
    if (!make) {throw new Error("platform fixture harness was not loaded");}
    return make();
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> { return conn().query(sql, params); }
    connect(): Promise<unknown> { return Promise.resolve(conn()); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

const CLOSE_BILL = "a953d044-31ba-4e31-b96f-99304fe43dfa";
const DELETE_TABLE = "5777c4aa-29df-4ea1-9c45-c1038d25f746";
const GET_ROLES = "17ba6407-b703-4403-ab59-13235966053f";
const CREATE_ROLE = "c0135d18-68b4-45e9-9b51-849158df6efd";
const MANAGE_PASSWORDS = "0b4d7f92-6c81-43a5-b7e0-2f9a1c8d5e36";
const ADD_ORDERS = "4ad474d4-5230-449c-874f-6a238b833bca";

const RES = "11111111-1111-1111-1111-111111111111";
const OUTLET = "22222222-2222-2222-2222-222222222222";
const identity = (actions: string[], role = "manager") => ({
  res_id: RES, outlet_id: OUTLET, employeeId: "emp-1", role, actions,
});

let harness: FakeApp;
let sessionCapabilities: typeof import("../routes/_shared")["sessionCapabilities"];
let CORE_ROLES: typeof import("../database_supabase")["CORE_ROLES"];

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  process.env.PLATFORM_DATABASE_URL =
    process.env.PLATFORM_DATABASE_URL || "postgres://fixture:fixture@localhost:5432/fixture";

  ({ sessionCapabilities } = await import("../routes/_shared"));
  ({ CORE_ROLES } = await import("../database_supabase"));
  const roles = await import("../routes/roles");
  harness = makeFakeApp();
  roles.registerCoreRolesRoute(harness.app as never);
  roles.registerRoleRoutes(harness.app as never);
});

// ---------------------------------------------------------------------------
describe("the capability block the clients obey", () => {
  test("an admin's wildcard satisfies every capability — an admin loses nothing", () => {
    const caps = sessionCapabilities({ actions: ["*"] });
    for (const [name, value] of Object.entries(caps)) {
      expect([name, value]).toEqual([name, true]);
    }
  });

  test("a bare waiter gets nothing but is still a valid answer, not an absent one", () => {
    const caps = sessionCapabilities({ actions: CORE_ROLES.waiter as unknown as string[] });
    expect(caps.settle_bill).toBe(false);
    expect(caps.delete_table).toBe(false);
    expect(caps.comp_item).toBe(false);
    expect(caps.waive_service_charge).toBe(false);
    expect(caps.view_roles).toBe(false);
    expect(caps.manage_roles).toBe(false);
  });

  test("a missing or malformed action list denies rather than throwing", () => {
    // A session minted before a field existed, or a corrupt store read. The
    // direction matters: this decides what a CLIENT DRAWS, and drawing nothing
    // is recoverable (the route still answers), whereas throwing here would 500
    // the login of every user of the tenant.
    expect(sessionCapabilities({}).settle_bill).toBe(false);
    expect(sessionCapabilities({ actions: "not-an-array" }).delete_table).toBe(false);
  });

  test("each capability follows its own grant, never another's", () => {
    const onlyDelete = sessionCapabilities({ actions: [DELETE_TABLE] });
    expect(onlyDelete.delete_table).toBe(true);
    expect(onlyDelete.settle_bill).toBe(false);
    expect(onlyDelete.edit_table).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("the core role definitions", () => {
  test("C2: a WAITER cannot settle — and neither can a valet or a bare employee", () => {
    for (const role of ["waiter", "valet", "employee"] as const) {
      expect([role, (CORE_ROLES[role] as readonly string[]).includes(CLOSE_BILL)]).toEqual([role, false]);
    }
  });

  test("C2: everyone who runs a till holds Close Bill — manager, cashier AND CAPTAIN", () => {
    // THE CAPTAIN LINE IS THE POINT OF THIS TEST, and it is a deliberate reversal
    // of what C2 shipped. A captain's settle has always been
    // `PATCH /orders/:id/status -> Paid`, gated on "Add Orders" alone; routing
    // every settle through enforceSettleAuthority silently took that away on the
    // next deploy. A captain supervises a section and takes payment for it —
    // role_scope.ts has always said so by listing `captain` in
    // ROLES_OUTRANKING_WAITER — so the capability is restored explicitly rather
    // than removed by accident. If this assertion is ever flipped back, somebody
    // is deciding that captains no longer settle, and they are deciding it here,
    // in the open, rather than discovering it from a till that stopped working.
    for (const role of ["manager", "cashier", "captain"] as const) {
      expect([role, (CORE_ROLES[role] as readonly string[]).includes(CLOSE_BILL)]).toEqual([role, true]);
    }
  });

  test("a captain gets Close Bill and NOT the payment-review flow", () => {
    // Restoring what C2 removed, and not one permission more: the two-step
    // waiter-confirm / admin-approve review is still a manager's job, and a
    // captain never held either half of it.
    const captain = CORE_ROLES.captain as readonly string[];
    expect(captain.includes(CLOSE_BILL)).toBe(true);
    for (const id of ["2393edd7-cdd9-439c-9ff3-d563d5216967", "fc57d407-4bba-442c-97a2-9e6f3c57f288"]) {
      expect([id, captain.includes(id)]).toEqual([id, false]);
    }
  });

  test("C2: a manager holds the WHOLE settle path, not one step of it", () => {
    // Holding Close Bill but not Add Orders means PATCH /orders/:id/status
    // refuses before the settle gate is even reached, which reads to a manager
    // as "settling is broken" rather than as a missing permission.
    const manager = CORE_ROLES.manager as readonly string[];
    for (const id of [ADD_ORDERS, "9186e53e-0fda-4ec8-ad20-2f9feaadb77f", "98b10bde-802d-4a5b-a726-53a826424f79",
      "2393edd7-cdd9-439c-9ff3-d563d5216967", "fc57d407-4bba-442c-97a2-9e6f3c57f288", CLOSE_BILL]) {
      expect([id, manager.includes(id)]).toEqual([id, true]);
    }
  });

  test("C5/C6: a manager can open the access-control screen; a waiter cannot", () => {
    const manager = CORE_ROLES.manager as readonly string[];
    expect(manager.includes(GET_ROLES)).toBe(true);
    expect(manager.includes(CREATE_ROLE)).toBe(true);
    expect((CORE_ROLES.waiter as readonly string[]).includes(GET_ROLES)).toBe(false);
  });

  test("C5: a manager is NOT quietly made a second account administrator", () => {
    const manager = CORE_ROLES.manager as readonly string[];
    // Role deletion, role assignment and credentials stay with the admin. C5
    // asks for view and EDIT of custom roles, and that is all it gets.
    for (const id of ["53d0927d-00f4-48cc-a40c-51edb09826d8", "4bf54bd9-9124-46c0-a7cc-011ea4c4e172",
      "9acc9097-4803-4be0-bb6d-fc2c5de57cf5", MANAGE_PASSWORDS, "*"]) {
      expect([id, manager.includes(id)]).toEqual([id, false]);
    }
  });

  test("C7: 'Table Deleted' is held by NO core role — it is granted, never assumed", () => {
    for (const [role, ids] of Object.entries(CORE_ROLES)) {
      if (role === "admin") { continue; } // the wildcard, by definition
      expect([role, (ids as readonly string[]).includes(DELETE_TABLE)]).toEqual([role, false]);
    }
  });
});

// ---------------------------------------------------------------------------
describe("C5: a manager editing roles cannot escalate", () => {
  const MANAGER = identity([GET_ROLES, CREATE_ROLE, ADD_ORDERS]);

  test("granting a permission the caller does not hold is refused, and the ids are named", async () => {
    const r = await harness.call("POST", "/roles", {
      auth: MANAGER,
      body: { role_name: "shift lead", actions_performable: [ADD_ORDERS, MANAGE_PASSWORDS, CLOSE_BILL] },
    });
    expect(r.status).toBe(403);
    const body = r.body as { ungrantableActionIds?: string[] };
    // Named so an owner can either grant them to the manager or untick them —
    // a bare "Forbidden" on a save of fourteen checkboxes is unactionable.
    expect(body.ungrantableActionIds).toEqual([MANAGE_PASSWORDS, CLOSE_BILL]);
  });

  test("the admin wildcard can never be written into a custom role by a non-admin", async () => {
    const r = await harness.call("POST", "/roles", {
      auth: MANAGER, body: { role_name: "superuser", actions_performable: ["*"] },
    });
    expect(r.status).toBe(403);
    expect((r.body as { ungrantableActionIds?: string[] }).ungrantableActionIds).toContain("*");
  });

  test("granting only what the caller holds gets PAST the guard", async () => {
    const r = await harness.call("POST", "/roles", {
      auth: MANAGER, body: { role_name: "shift lead", actions_performable: [ADD_ORDERS] },
    });
    // It fails LATER, in the data layer, on a fixture with no such restaurant —
    // which is the proof the guard let it through rather than that the route is
    // simply broken for managers.
    expect(r.status).not.toBe(403);
  });

  test("an admin is unaffected: the guard is skipped entirely", async () => {
    const r = await harness.call("POST", "/roles", {
      auth: identity(["*"], "admin"),
      body: { role_name: "anything", actions_performable: [MANAGE_PASSWORDS, CLOSE_BILL, DELETE_TABLE] },
    });
    expect(r.status).not.toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe("C6: a core role can actually be opened and read", () => {
  test("every core role comes back, each carrying its permissions ALREADY NAMED", async () => {
    const r = await harness.call("GET", "/core-roles", { auth: identity([GET_ROLES]) });
    expect(r.status).toBe(200);
    const rows = r.body as { role: string; actions: string[]; permissions: { id: string; action_name: string | null }[]; editable: boolean }[];
    expect(rows.map((x) => x.role).sort()).toEqual(Object.keys(CORE_ROLES).sort());

    for (const row of rows) {
      // `actions` is UNCHANGED — the shipped dashboard reads it as strings.
      expect(Array.isArray(row.actions)).toBe(true);
      expect(typeof row.actions[0]).toBe("string");
      // NEVER SHORTENS. An id with no "Actions" row keeps its place with a null
      // name, so a reviewer cannot conclude a role grants less than it does.
      expect(row.permissions).toHaveLength(row.actions.length);
      expect(row.permissions.map((p) => p.id)).toEqual(row.actions);
      expect(row.editable).toBe(false);
    }
  });

  test("the admin wildcard reads as something, not as one unknown uuid", async () => {
    const r = await harness.call("GET", "/core-roles", { auth: identity([GET_ROLES]) });
    const admin = (r.body as { role: string; permissions: { id: string; action_name: string | null }[] }[])
      .find((x) => x.role === "admin");
    expect(admin?.permissions[0]).toMatchObject({ id: "*", action_name: "All actions" });
  });

  test("an unreadable action catalogue DEGRADES: the roles still come back", async () => {
    // The fixture DB cannot answer GetActions(), so this run IS the degraded
    // path. A roles screen that renders uuids is poor; a roles screen that 500s
    // because the name lookup was unavailable is the C6 bug all over again.
    const r = await harness.call("GET", "/core-roles", { auth: identity([GET_ROLES]) });
    expect(r.status).toBe(200);
    expect((r.body as unknown[]).length).toBeGreaterThan(0);
  });

  test("a caller without 'Get Roles' is still refused — this is a permission, not a decoration", async () => {
    const r = await harness.call("GET", "/core-roles", { auth: identity(CORE_ROLES.waiter as unknown as string[], "waiter") });
    expect(r.status).toBe(403);
  });
});

// ===========================================================================
// THE ROLE INVARIANT: A WRITE WITHOUT ITS READ IS A BROKEN ROLE, NOT A SAFE ONE
// ===========================================================================
//
// STATED IN FULL, because the next person to add a core role has to satisfy it:
//
//   If a core role is granted a permission that lets it CHANGE something, it
//   must also be granted the permission that lets it LOOK AT the thing it is
//   changing. A role that can settle a bill must be able to read that bill. A
//   role that can take the money off a table must be able to see the table and
//   free it afterwards. A role that can ring an item up must be able to open
//   the menu it is ringing up from.
//
// AND THE HALF THAT IS EASY TO GET BACKWARDS: this invariant is satisfied by
// ADDING THE READ, NEVER BY ADDING THE WRITE. "The waiter fails write-implies-
// read on Close Bill" is not a thing that can happen, because a waiter holds no
// Close Bill; if it ever does, somebody has satisfied this rule by handing the
// floor the till, and the C2 tests above fail first and loudly.
//
// WHY IT EXISTS. Three separate roles shipped with exactly this defect and each
// one was found by a person, in the field, hitting a 403:
//
//   * the MANAGER held seven permissions, none of which could read a bill,
//     create one, or settle one -- while the rule being written at the time
//     named managers as THE role that settles;
//   * the CASHIER -- the role whose whole name is the till -- held five
//     permissions and all five were writes: create bill, confirm payment,
//     approve payment, close bill, order to Paid. It could settle a bill it was
//     403'd from reading (98b10bde), and could not free the table afterwards
//     (090ea8d4);
//   * the CAPTAIN, given Close Bill so its till kept working, was left with the
//     same missing 090ea8d4, so it could take payment for its section and then
//     not release the table.
//
// Each of those was found the expensive way. This block is the cheap way.
//
// A NOTE ON ONE PAIR THAT LOOKS MISSING. "Whoever can release a table can see
// tables" is not a row below, because releasing a table and listing tables are
// THE SAME uuid (090ea8d4) -- the read and the write cannot drift apart while
// that stays true. The Close Bill -> 090ea8d4 row carries that dependency
// instead, and carries it in the direction that actually broke.

const VIEW_BILL = "98b10bde-802d-4a5b-a726-53a826424f79";
const TABLE_OPS = "090ea8d4-e348-4e1b-9723-11131a73a085";
const VIEW_MENU = "f4177b38-77fa-4d8c-9fbd-c4f06bf28610";
const CREATE_BILL = "9186e53e-0fda-4ec8-ad20-2f9feaadb77f";
const CONFIRM_PAYMENT = "2393edd7-cdd9-439c-9ff3-d563d5216967";
const APPROVE_PAYMENT = "fc57d407-4bba-442c-97a2-9e6f3c57f288";

// WRITE capability -> the READ it cannot be used without.
const DEPENDENCIES: { write: string; writeName: string; read: string; readName: string; because: string }[] = [
  { write: CLOSE_BILL, writeName: "Close Bill (settle)", read: VIEW_BILL, readName: "View Bill",
    because: "settling a total you are not allowed to read is not a workflow" },
  { write: CLOSE_BILL, writeName: "Close Bill (settle)", read: TABLE_OPS, readName: "Table status/occupy/release",
    because: "the money is taken and the table still has to be freed" },
  { write: CREATE_BILL, writeName: "Create Bill", read: VIEW_BILL, readName: "View Bill",
    because: "opening a bill you then cannot open again strands the table" },
  { write: CONFIRM_PAYMENT, writeName: "Confirm Payment Method", read: VIEW_BILL, readName: "View Bill",
    because: "step 1 of the settle names an amount that has to be read first" },
  { write: APPROVE_PAYMENT, writeName: "Approve Payment", read: VIEW_BILL, readName: "View Bill",
    because: "approving an amount sight-unseen is not an approval" },
  { write: ADD_ORDERS, writeName: "Add Orders", read: VIEW_MENU, readName: "View Menu",
    because: "an order is rung up FROM the menu" },
];

// Every id each core role held BEFORE the cashier/captain repair, frozen. This
// is the "nothing was lost" ratchet: the repair is additive by construction, and
// an admin, owner, manager, cashier or captain who loses a capability to a
// permissions pass is the worst outcome this whole block can produce -- "the fix
// emptied the till" beats any door it closed. A deliberate REMOVAL from a core
// role has to come here and delete the line, in the open.
const HELD_BEFORE: Record<string, string[]> = {
  admin: ["*"],
  employee: ["0a98cf2b-8b42-47a7-a523-b7bb73cb870e", "1f176202-d5e7-4bb0-802c-275a42425394",
    "3ec33182-ceb4-4d07-ac7e-84214adcf104"],
  valet: ["ae8ce7c0-1e06-4722-8a06-817267eec785", "6e9be65f-4081-4b86-8ba0-0592ee26f7f2",
    "2caeab74-5941-424d-9c3a-5c68ef0186e1", "2ff51c3d-f18c-406c-9f49-7c54f468c835",
    "892b50f3-51fc-4099-8f31-01e8dd8c3d44", "9e37297d-408b-446d-a51b-7892ad216b7d",
    "b8e02c25-b91c-427c-b462-8df009ede055", "5ef876a7-eb92-4602-b4d3-5590ce379540"],
  cashier: [CREATE_BILL, CONFIRM_PAYMENT, APPROVE_PAYMENT, CLOSE_BILL, ADD_ORDERS],
  waiter: [ADD_ORDERS, TABLE_OPS, "c7699d46-0e2f-4448-b325-8ca490a5296b",
    "b7f78d0f-323d-4622-8d05-aa2f82d54b2e", VIEW_MENU, VIEW_BILL],
  captain: [ADD_ORDERS, CREATE_BILL, "c7699d46-0e2f-4448-b325-8ca490a5296b", VIEW_MENU, VIEW_BILL,
    "3f6a9c1e-8d24-4b7a-b5c9-2e1f7d4a8b63", CLOSE_BILL],
  manager: ["faf2745b-580c-4529-bbe1-033200cbcf67", "daf1d71f-2b37-4cd1-b951-28fece7719cd",
    "2e7b9c40-1f83-4d6a-b902-5a8c3e1f6047", "3f6a9c1e-8d24-4b7a-b5c9-2e1f7d4a8b63",
    "b4e7a1c9-2d58-4f36-9a07-5c81e3b0d472", "c1f83b26-5a97-4e40-b8d3-7e02a9c4f156",
    "d5a06e73-9c41-4b28-8f6a-1b74d3e08c95", ADD_ORDERS, CREATE_BILL, VIEW_BILL, CONFIRM_PAYMENT,
    APPROVE_PAYMENT, CLOSE_BILL, TABLE_OPS, VIEW_MENU, GET_ROLES,
    "2b6f7948-0b27-41a9-9727-c04ccc9f4db1", CREATE_ROLE],
};

const holdsOf = (role: string): { ids: readonly string[]; has: (id: string) => boolean } => {
  const ids = CORE_ROLES[role as keyof typeof CORE_ROLES] as readonly string[];
  return { ids, has: (id: string) => ids.includes("*") || ids.includes(id) };
};

describe("the role invariant: every WRITE a core role holds comes with its READ", () => {
  test("EVERY core role satisfies it -- including roles added after this was written", () => {
    const broken: string[] = [];
    for (const role of Object.keys(CORE_ROLES)) {
      const { has } = holdsOf(role);
      for (const d of DEPENDENCIES) {
        if (has(d.write) && !has(d.read)) {
          broken.push(`${role}: holds ${d.writeName} but not ${d.readName} -- ${d.because}`);
        }
      }
    }
    // Named, not counted: a bare "expected 3 to be 0" on a role table sends the
    // reader back to the uuids to work out which pair broke and for whom.
    expect(broken).toEqual([]);
  });

  test("the invariant is satisfied by adding the READ, never by adding the WRITE", () => {
    // The cheap way to make the loop above pass is to give a junior role the
    // WRITE so both sides go true. That would "fix" the test and hand the floor
    // the till. So the junior roles are pinned here: no settle, no bill
    // creation, no payment review, whatever else changes around them.
    for (const role of ["waiter", "valet", "employee"] as const) {
      const { has } = holdsOf(role);
      for (const [name, id] of [["Close Bill", CLOSE_BILL], ["Create Bill", CREATE_BILL],
        ["Confirm Payment", CONFIRM_PAYMENT], ["Approve Payment", APPROVE_PAYMENT]] as const) {
        expect([role, name, has(id)]).toEqual([role, name, false]);
      }
    }
  });

  test("an admin's wildcard satisfies every pair without listing one id", () => {
    const { has } = holdsOf("admin");
    for (const d of DEPENDENCIES) {
      expect([d.writeName, d.readName, has(d.write) && has(d.read)])
        .toEqual([d.writeName, d.readName, true]);
    }
  });

  test("NOTHING WAS LOST: every id a core role held before this pass, it still holds", () => {
    for (const [role, before] of Object.entries(HELD_BEFORE)) {
      const { ids } = holdsOf(role);
      const lost = before.filter((id) => !ids.includes(id));
      expect([role, lost]).toEqual([role, []]);
    }
    // ...and the frozen table covers every role there is, so a new core role
    // cannot slip past the ratchet by simply not being listed in it.
    expect(Object.keys(HELD_BEFORE).sort()).toEqual(Object.keys(CORE_ROLES).sort());
  });
});

describe("the two roles this pass repaired", () => {
  test("a CASHIER can now read the bill it settles, and free the table afterwards", () => {
    const { has } = holdsOf("cashier");
    expect(has(CLOSE_BILL)).toBe(true);   // unchanged -- it could always settle
    expect(has(VIEW_BILL)).toBe(true);    // GET /bill-for-table, /bills/open, /bills/closed
    expect(has(TABLE_OPS)).toBe(true);    // GET /table-status, POST /release-table
    expect(has(VIEW_MENU)).toBe(true);    // it holds Add Orders, so it must see the menu
  });

  test("a CAPTAIN can now free the table it just took payment for", () => {
    const { has } = holdsOf("captain");
    expect(has(CLOSE_BILL)).toBe(true);
    expect(has(TABLE_OPS)).toBe(true);
    // ...and the payment-review pair is STILL deliberately absent. Restoring a
    // captain's till has never meant handing it the manager's review flow.
    expect(has(CONFIRM_PAYMENT)).toBe(false);
    expect(has(APPROVE_PAYMENT)).toBe(false);
  });

  test("the repair granted READS ONLY -- the till gained no instrument that reduces a bill", () => {
    // This is the line that keeps an additive fix additive. Comp an item, void
    // with a reason and waive a service charge each LOWER what a guest pays, and
    // all three stay with the manager: an approval the person doing it can grant
    // themselves is not an approval.
    for (const role of ["cashier", "captain"] as const) {
      const caps = sessionCapabilities({ actions: CORE_ROLES[role] });
      expect([role, caps.comp_item]).toEqual([role, false]);
      expect([role, caps.waive_service_charge]).toEqual([role, false]);
      expect([role, caps.void_order]).toEqual([role, false]);
      expect([role, caps.delete_table]).toEqual([role, false]);
      expect([role, caps.edit_table]).toEqual([role, false]);
      expect([role, caps.manage_table_sections]).toEqual([role, false]);
      expect([role, caps.view_roles]).toEqual([role, false]);
      expect([role, caps.manage_roles]).toEqual([role, false]);
      // ...and the one capability it always had is still true.
      expect([role, caps.settle_bill]).toEqual([role, true]);
    }
  });

  test("a WAITER is untouched by the repair: same reads, still no till", () => {
    const caps = sessionCapabilities({ actions: CORE_ROLES.waiter });
    expect(caps.settle_bill).toBe(false);
    const { has } = holdsOf("waiter");
    expect(has(VIEW_BILL)).toBe(true);
    expect(has(TABLE_OPS)).toBe(true);
    expect(has(VIEW_MENU)).toBe(true);
  });
});

describe("the repair reaches the SHIPPED surface, not just the constant", () => {
  test("GET /core-roles hands the roles screen the fixed cashier and captain rows", async () => {
    // The constant is resolved into a session at LOGIN (resolveEmployeeActionSet),
    // so there is no migration and no backfill -- but the roles screen reads the
    // rows over THIS route, and a repair that never reaches it is a repair an
    // owner can neither see nor argue with.
    const r = await harness.call("GET", "/core-roles", { auth: identity([GET_ROLES]) });
    expect(r.status).toBe(200);
    const rows = r.body as { role: string; actions: string[] }[];
    const row = (name: string): string[] => rows.find((x) => x.role === name)?.actions ?? [];
    for (const id of [VIEW_BILL, TABLE_OPS, VIEW_MENU, CLOSE_BILL]) {
      expect([id, row("cashier").includes(id)]).toEqual([id, true]);
    }
    expect(row("captain").includes(TABLE_OPS)).toBe(true);
    // The route must not be quietly shortening or reordering either list.
    expect(row("cashier")).toEqual([...CORE_ROLES.cashier]);
    expect(row("captain")).toEqual([...CORE_ROLES.captain]);
  });
});
