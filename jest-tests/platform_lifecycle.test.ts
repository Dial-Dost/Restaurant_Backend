// Operator tenant lifecycle: POST /platform/restaurants (create) and the
// archive/restore pair that replaces "delete".
//
// The suite that matters is the one about REMOVAL, and it has two halves that
// have to hold together:
//
//   (a) removal actually removes — staff cannot sign in, the billing cycle stops
//       charging, live sessions are gone;
//   (b) removal destroys NOTHING — every Bill, Order and Audit_log survives
//       byte-for-byte, and the whole thing is reversible from the audit trail.
//
// With only (a), archiving is a delete with extra steps and India's statutory
// retention is broken the first time an operator clicks it. With only (b), the
// operator has a button that greys out a row while the tenant keeps trading and
// keeps being invoiced. Both are tested here, separately.
//
// Creation is tested for one thing above all: that the duplicate-slug path fails
// CLEANLY. EnsureRestaurantSeed is an UPSERT, so a create route that lost its
// existence pre-check would not error — it would quietly rename a live tenant and
// overwrite its owner's password hash.

import { describe, test, expect, beforeAll, beforeEach } from "@jest/globals";
import {
  ADMIN_ID,
  INACTIVE_ADMIN_ID,
  PLAN_GROWTH_ID,
  PLAN_STARTER_ID,
  addAuditLog,
  addBill,
  addOrder,
  addRestaurant,
  addSubscription,
  auditLogs,
  bills,
  breakAuditInsert,
  breakBillsCount,
  breakLoginInsert,
  breakSubscriptionCancel,
  employees,
  healSubscriptionCancel,
  unapplyMigration028,
  invoices,
  logins,
  makeFakeApp,
  orders,
  outlets,
  platformAudit,
  resetStore,
  restaurantBySlug,
  restaurants,
  subscriptionFor,
  subscriptions,
  type FakeApp,
} from "./platform_fixtures";

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

let harness: FakeApp;
let operatorToken: string;
let deactivatedOperatorToken: string;
let runBillingCycle: () => Promise<{ generated: number; past_due: number; suspended: number }>;
// archivedStatusSupported() memoises a SUCCESSFUL check, so the "028 is not
// applied" cases have to clear it — otherwise an earlier passing test would make
// the gate answer from cache and the case would silently stop being tested.
// Bound in beforeAll, not imported at module scope: platform/db.ts reads
// PLATFORM_DATABASE_URL when it is first loaded, and beforeAll is where that is set.
let resetArchivedStatusSupportCache: () => void;

// Each create burns one token from rateLimit("platform-create-restaurant", 20/min),
// which is keyed by IP and backed by a process-wide in-memory store that no test
// resets. A distinct IP per call keeps the suite from 429-ing itself as it grows.
let ipSeq = 0;
const freshIp = (): string => `198.51.100.${String((ipSeq++ % 250) + 1)}`;

interface CreateBody {
  res_name?: string;
  res_username?: string;
  owner_name?: string;
  owner_username?: string;
  plan_id?: string;
  address?: string;
  phone?: string;
  email?: string;
}

// "" is "send no Authorization header at all". A default parameter cannot express
// that — passing `undefined` explicitly triggers the default, so `create(body,
// undefined)` would silently run AS THE OPERATOR and an auth test would pass for
// the wrong reason.
const NO_TOKEN = "";

const create = (body: CreateBody, token: string = operatorToken) =>
  harness.call("POST", "/platform/restaurants", { token, body, ip: freshIp() });

const archive = (id: string, body: Record<string, unknown> = {}, token: string = operatorToken) =>
  harness.call("POST", "/platform/restaurants/:id/archive", { token, params: { id }, body });

const restore = (id: string, token: string = operatorToken) =>
  harness.call("POST", "/platform/restaurants/:id/restore", { token, params: { id } });

const activate = (id: string) =>
  harness.call("POST", "/platform/restaurants/:id/activate", { token: operatorToken, params: { id } });

const login = (slug: string, username: string, password: string) =>
  harness.call("POST", "/auth/employee-login", {
    body: { restaurantId: slug, restaurantName: slug, employeeUsername: username, password },
    ip: freshIp(),
  });

beforeAll(async () => {
  // Connection strings are required at import time; both pools are faked, so
  // neither value is ever dialled. REDIS_URL must be absent so the session store
  // is the in-memory one (a stray shell value would try to open a socket).
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  process.env.PLATFORM_DATABASE_URL =
    process.env.PLATFORM_DATABASE_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  process.env.SAAS_TRIAL_DAYS = "14";

  const platformRoutes = await import("../platform/routes");
  const authRoutes = await import("../routes/auth");
  const platformSessions = await import("../platform/sessions");

  runBillingCycle = platformRoutes.runBillingCycle;
  resetArchivedStatusSupportCache = (await import("../platform/db")).resetArchivedStatusSupportCache;

  harness = makeFakeApp();
  // Registered in the same order index.ts registers them: the platform routes sit
  // BEFORE the tenant auth gate and carry their own guard.
  platformRoutes.registerPlatformRoutes(harness.app as never);
  authRoutes.registerAuthRoutes(harness.app as never);

  operatorToken = await platformSessions.createPlatformSession({
    adminId: ADMIN_ID, email: "operator@example.test", name: "Operator",
  });
  deactivatedOperatorToken = await platformSessions.createPlatformSession({
    adminId: INACTIVE_ADMIN_ID, email: "former@example.test", name: "Former",
  });
});

beforeEach(() => { resetStore(); });

/** Deep, order-independent snapshot of everything that is a financial record. */
const financialSnapshot = (): string => JSON.stringify({
  bills: [...bills()].sort((a, b) => a.id.localeCompare(b.id)),
  orders: [...orders()].sort((a, b) => a.id.localeCompare(b.id)),
  audit_logs: [...auditLogs()].sort((a, b) => a.id.localeCompare(b.id)),
  invoices: [...invoices()].sort((a, b) => a.id.localeCompare(b.id)),
});

/** A tenant with a trading history: settled bills with GST, orders, audit logs. */
function seedTenantWithHistory(over: Parameters<typeof addRestaurant>[0] = {}) {
  const r = addRestaurant(over);
  addBill({ res_id: r.id });
  addBill({ res_id: r.id, status: 2, total_amt: 2360 });
  addOrder({ res_id: r.id });
  addAuditLog({ res_id: r.id });
  return r;
}

// ---------------------------------------------------------------------------
describe("route registration", () => {
  test("create, archive and restore are registered with requirePlatformAuth, like the other platform routes", () => {
    const paths = harness.routes().map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain("POST /platform/restaurants");
    expect(paths).toContain("POST /platform/restaurants/:id/archive");
    expect(paths).toContain("POST /platform/restaurants/:id/restore");
  });

  test("there is no DELETE route anywhere on /platform/restaurants", () => {
    // The guarantee is structural, not stylistic: "Restaurant" is the cascade root
    // for every tenant table, so a delete route would be one click from erasing a
    // tenant's statutory history.
    const deletes = harness.routes().filter((r) => r.method === "DELETE" && r.path.startsWith("/platform/restaurants"));
    expect(deletes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("a non-platform caller", () => {
  test.each([
    ["create", () => create({ res_name: "X", owner_name: "Y", owner_username: "z" }, NO_TOKEN)],
    ["archive", () => archive("res-1", {}, NO_TOKEN)],
    ["restore", () => restore("res-1", NO_TOKEN)],
  ])("%s with no bearer token is 401", async (_name, run) => {
    const r = await run();
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: "Unauthorized" });
  });

  test.each([
    ["create", (t: string) => create({ res_name: "X", owner_name: "Y", owner_username: "z" }, t)],
    ["archive", (t: string) => archive("res-1", {}, t)],
    ["restore", (t: string) => restore("res-1", t)],
  ])("%s with a garbage bearer token is 401", async (_name, run) => {
    const r = await run("not-a-real-token");
    expect(r.status).toBe(401);
  });

  test("a TENANT employee session token does not open the platform routes", async () => {
    // The two auth domains use separate keyspaces (session: vs psession:). A
    // logged-in restaurant admin holding a perfectly valid tenant token must not
    // be able to create or archive restaurants fleet-wide.
    const tenant = addRestaurant({ res_username: "tenanttoken" });
    const { createSession } = await import("../auth/sessions");
    const tenantToken = await createSession({
      employeeId: "emp-1", res_id: tenant.id, outlet_id: "outlet-1", role: "admin",
      role_all: ["admin"], actions: ["*"], features: {}, limits: {}, action_names: [],
      emp_Fname: "Owner", emp_Lname: null, employeeUsername: "owner",
      restaurantUsername: tenant.res_username, restaurantName: tenant.res_name,
    });

    expect((await create({ res_name: "X", owner_name: "Y", owner_username: "z" }, tenantToken)).status).toBe(401);
    expect((await archive(tenant.id, {}, tenantToken)).status).toBe(401);
    expect((await restore(tenant.id, tenantToken)).status).toBe(401);
    expect(restaurants()).toHaveLength(1);
    expect(restaurantBySlug("tenanttoken")?.account_status).toBe("active");
  });

  test("a DEACTIVATED operator's still-valid token is rejected on every request", async () => {
    // requirePlatformAuth re-reads platform.admins.active per request precisely so
    // a revoked operator loses fleet-wide access immediately, not in 8 hours.
    const tenant = addRestaurant({ res_username: "deactivated" });
    expect((await create({ res_name: "X", owner_name: "Y", owner_username: "z" }, deactivatedOperatorToken)).status).toBe(401);
    expect((await archive(tenant.id, {}, deactivatedOperatorToken)).status).toBe(401);
    expect((await restore(tenant.id, deactivatedOperatorToken)).status).toBe(401);
    expect(restaurants()).toHaveLength(1);
    expect(restaurantBySlug("deactivated")?.account_status).toBe("active");
    expect(platformAudit()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("create", () => {
  test("seeds the tenant, its outlet and its owner, and returns the id + a one-time password", async () => {
    const r = await create({
      res_name: "The Rustic Fork", res_username: "therusticfork",
      owner_name: "Asha Menon", owner_username: "asha",
      address: "12 Residency Road", phone: "9876543210", email: "asha@rusticfork.test",
    });

    expect(r.status).toBe(201);
    const body = r.body as { restaurant: { id: string; res_username: string; res_name: string }; owner: { username: string; temporary_password: string } };
    expect(body.restaurant.res_username).toBe("therusticfork");
    expect(body.restaurant.res_name).toBe("The Rustic Fork");

    const row = restaurantBySlug("therusticfork");
    expect(row).toBeDefined();
    expect(body.restaurant.id).toBe(row?.id);
    expect(row?.account_status).toBe("active");
    expect(row?.main_office_add).toBe("12 Residency Road");

    // The seed is the SAME one self-serve registration runs: one outlet, one
    // admin employee, one login.
    expect(outlets().filter((o) => o.res_id === row?.id)).toHaveLength(1);
    expect(outlets()[0]?.oultet_username).toBe("therusticfork-main");
    const owner = employees().find((e) => e.res_id === row?.id);
    expect(owner?.emp_roles).toEqual({ primary: "admin", all: ["admin"] });
    expect(owner?.emp_Fname).toBe("Asha");
    expect(logins().find((l) => l.res_id === row?.id)?.emp_username).toBe("asha");
  });

  test("the temporary password is argon2-hashed, meets the tenant password policy, and never leaves the response body", async () => {
    const r = await create({ res_name: "Blue Door", owner_name: "Ravi K", owner_username: "ravi" });
    const { owner } = r.body as { owner: { temporary_password: string } };
    const { passwordPolicyError } = await import("../routes/_shared");

    // Not reset-owner-password's 4-character floor — the tenant's own policy.
    expect(passwordPolicyError(owner.temporary_password)).toBeNull();

    const stored = logins()[0]?.emp_pass ?? "";
    expect(stored.startsWith("$argon2")).toBe(true);
    expect(stored).not.toContain(owner.temporary_password);

    // It exists in the 201 body and nowhere else — above all not in the audit
    // trail, which the operator console renders verbatim.
    const entry = platformAudit().find((a) => a.action === "restaurant.create");
    expect(JSON.stringify(entry)).not.toContain(owner.temporary_password);
  });

  test("the owner it creates can actually sign in with the password it returned", async () => {
    const r = await create({ res_name: "Blue Door", res_username: "bluedoor", owner_name: "Ravi K", owner_username: "ravi" });
    const { owner } = r.body as { owner: { temporary_password: string } };

    const ok = await login("bluedoor", "ravi", owner.temporary_password);
    expect(ok.status).toBe(200);
    expect((ok.body as { role: string }).role).toBe("admin");

    const wrong = await login("bluedoor", "ravi", "not-the-password-1");
    expect(wrong.status).toBe(401);
  });

  test("is audited, without the credential", async () => {
    await create({ res_name: "Blue Door", res_username: "bluedoor", owner_name: "Ravi K", owner_username: "ravi", plan_id: PLAN_GROWTH_ID });
    const entry = platformAudit().find((a) => a.action === "restaurant.create");
    expect(entry?.admin_id).toBe(ADMIN_ID);
    expect(entry?.target_res_id).toBe(restaurantBySlug("bluedoor")?.id);
    expect(entry?.detail).toEqual({
      res_username: "bluedoor", res_name: "Blue Door",
      owner_username: "ravi", plan_id: PLAN_GROWTH_ID,
    });
  });

  test("with no plan it starts a trial; with a plan it activates that plan instead", async () => {
    await create({ res_name: "Trial Cafe", res_username: "trialcafe", owner_name: "A B", owner_username: "ab" });
    const trial = subscriptionFor(restaurantBySlug("trialcafe")!.id);
    expect(trial?.status).toBe("trial");
    expect(trial?.plan_id).toBe(PLAN_STARTER_ID); // cheapest active plan

    await create({ res_name: "Sold Cafe", res_username: "soldcafe", owner_name: "C D", owner_username: "cd", plan_id: PLAN_GROWTH_ID });
    const sold = subscriptionFor(restaurantBySlug("soldcafe")!.id);
    expect(sold?.status).toBe("active");
    expect(sold?.plan_id).toBe(PLAN_GROWTH_ID);
    expect(sold?.trial_ends_at).toBeNull();
  });

  test("rejects a slug the operator could not retype, naming the one that would work", async () => {
    const r = await create({ res_name: "The Rustic Fork", res_username: "The Rustic Fork!", owner_name: "A B", owner_username: "ab" });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toContain("therusticfork");
    expect(restaurants()).toEqual([]);
  });

  test("rejects missing fields, and a name with nothing sluggable in it", async () => {
    expect((await create({ res_name: "X", owner_name: "A B" })).status).toBe(400);
    expect((await create({ owner_name: "A B", owner_username: "ab" })).status).toBe(400);
    expect((await create({ res_name: "!!!", owner_name: "A B", owner_username: "ab" })).status).toBe(400);
    expect(restaurants()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("create against a slug that already exists", () => {
  test("fails with 409 and leaves the existing tenant completely untouched", async () => {
    // EnsureRestaurantSeed's UPDATE branches rename the restaurant and OVERWRITE
    // the owner's emp_pass. If the existence pre-check ever goes missing, this
    // route becomes a tenant-takeover primitive with no error and no symptom —
    // so the assertion is not just "409", it is "nothing moved".
    const first = await create({ res_name: "Joe's Pizza", res_username: "joespizza", owner_name: "Joe P", owner_username: "joe" });
    expect(first.status).toBe(201);
    const resId = restaurantBySlug("joespizza")!.id;
    const before = {
      restaurants: JSON.stringify(restaurants()),
      outlets: JSON.stringify(outlets()),
      employees: JSON.stringify(employees()),
      logins: JSON.stringify(logins()),
      subscriptions: JSON.stringify(subscriptions()),
    };
    const auditCountBefore = platformAudit().length;

    const clash = await create({ res_name: "Joes Pizza (Koramangala)", res_username: "joespizza", owner_name: "Impostor", owner_username: "joe" });

    expect(clash.status).toBe(409);
    expect((clash.body as { res_username: string }).res_username).toBe("joespizza");

    expect(restaurants()).toHaveLength(1);
    expect(restaurantBySlug("joespizza")!.id).toBe(resId);
    // Byte-for-byte: name, address, outlet, employee record and password hash.
    expect(JSON.stringify(restaurants())).toBe(before.restaurants);
    expect(JSON.stringify(outlets())).toBe(before.outlets);
    expect(JSON.stringify(employees())).toBe(before.employees);
    expect(JSON.stringify(logins())).toBe(before.logins);
    expect(JSON.stringify(subscriptions())).toBe(before.subscriptions);
    // A rejected create is not an event worth auditing, and must not look like one.
    expect(platformAudit()).toHaveLength(auditCountBefore);
  });

  test("the original owner's password still works after the clashing attempt", async () => {
    const first = await create({ res_name: "Joe's Pizza", res_username: "joespizza", owner_name: "Joe P", owner_username: "joe" });
    const original = (first.body as { owner: { temporary_password: string } }).owner.temporary_password;

    await create({ res_name: "Joes Pizza", res_username: "joespizza", owner_name: "Impostor", owner_username: "joe" });

    const ok = await login("joespizza", "joe", original);
    expect(ok.status).toBe(200);
  });

  test("a name that normalizes onto an existing slug is refused too", async () => {
    await create({ res_name: "Joe's Pizza", owner_name: "Joe P", owner_username: "joe" });
    const clash = await create({ res_name: "Joes Pizza!!", owner_name: "Other", owner_username: "other" });
    expect(clash.status).toBe(409);
    expect(restaurants()).toHaveLength(1);
  });

  test("a seed that dies halfway leaves NO half-created tenant behind", async () => {
    // The "Login" insert is the last statement of EnsureRestaurantSeed's
    // transaction: the "Restaurant", "Outlets" and "Employees" rows are already
    // written when it fails. All of them must roll back, or the slug is
    // permanently burned on a tenant nobody can log into.
    breakLoginInsert();
    const r = await create({ res_name: "Half Baked", res_username: "halfbaked", owner_name: "A B", owner_username: "ab" });

    expect(r.status).toBe(500);
    expect(restaurants()).toEqual([]);
    expect(outlets()).toEqual([]);
    expect(employees()).toEqual([]);
    expect(logins()).toEqual([]);
    expect(subscriptions()).toEqual([]);
    expect(platformAudit()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("archive", () => {
  test("flags the account, cancels the subscription, and audits what it is undoing", async () => {
    const tenant = seedTenantWithHistory({ res_username: "departing" });
    addSubscription({ res_id: tenant.id, status: "past_due", plan_id: PLAN_GROWTH_ID });

    const r = await archive(tenant.id, { reason: "Closed the restaurant" });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, account_status: "archived" });
    expect(restaurantBySlug("departing")?.account_status).toBe("archived");
    expect(subscriptionFor(tenant.id)?.status).toBe("cancelled");

    const entry = platformAudit().find((a) => a.action === "restaurant.archive");
    expect(entry?.admin_id).toBe(ADMIN_ID);
    expect(entry?.target_res_id).toBe(tenant.id);
    expect(entry?.detail).toMatchObject({
      reason: "Closed the restaurant",
      prev_account_status: "active",
      prev_sub_status: "past_due",
      prev_plan_id: PLAN_GROWTH_ID,
    });
  });

  test("does not delete or alter a single Bill, Order or Audit_logs row", async () => {
    const tenant = seedTenantWithHistory({ res_username: "keepsbooks" });
    addSubscription({ res_id: tenant.id });
    // An unpaid invoice for service already rendered is still owed, and is itself
    // a record — archiving must not void it.
    const before = financialSnapshot();
    expect(bills()).toHaveLength(2);

    const r = await archive(tenant.id);
    expect(r.status).toBe(200);

    // Byte-for-byte, including every tax_breakdown. The fixture additionally
    // throws on ANY delete/truncate/drop, so a cascade could not have run
    // silently either.
    expect(financialSnapshot()).toBe(before);
    expect(bills()).toHaveLength(2);
    expect(orders()).toHaveLength(1);
    expect(auditLogs()).toHaveLength(1);
    // The tenant row itself survives — platform.audit joins it for target_name,
    // and its history is meaningless without it.
    expect(restaurants().some((x) => x.id === tenant.id)).toBe(true);
    expect(employees().length + logins().length + outlets().length).toBe(0);
  });

  test("reports how many bills are still open, because archiving strands them", async () => {
    const tenant = addRestaurant({ res_username: "midservice" });
    addBill({ res_id: tenant.id, status: 1, closed_at: null });   // open
    addBill({ res_id: tenant.id, status: 1, closed_at: null });   // open
    addBill({ res_id: tenant.id, status: 2 });                    // settled
    addBill({ res_id: tenant.id, status: 3, closed_at: null });   // voided

    const r = await archive(tenant.id);
    expect((r.body as { open_bills: number }).open_bills).toBe(2);
    expect(platformAudit().find((a) => a.action === "restaurant.archive")?.detail)
      .toMatchObject({ open_bills: 2 });
    // Emphatically NOT auto-settled: inventing a settlement for money that may
    // never have been collected writes a false financial record.
    expect(bills().filter((b) => b.closed_at === null)).toHaveLength(3);
  });

  test("still archives when the open-bill count is unavailable", async () => {
    // The count runs on the TENANT pool; the control plane must not lose the
    // ability to remove a tenant because that pool is unreachable.
    const tenant = addRestaurant({ res_username: "nocount" });
    breakBillsCount();
    const r = await archive(tenant.id);
    expect(r.status).toBe(200);
    expect((r.body as { open_bills: number | null }).open_bills).toBeNull();
    expect(restaurantBySlug("nocount")?.account_status).toBe("archived");
  });

  test("revokes every live session for the tenant", async () => {
    const tenant = addRestaurant({ res_username: "livesessions" });
    const { createSession, getSession } = await import("../auth/sessions");
    const token = await createSession({
      employeeId: "emp-9", res_id: tenant.id, outlet_id: "outlet-9", role: "admin",
      role_all: ["admin"], actions: ["*"], features: {}, limits: {}, action_names: [],
      emp_Fname: "Owner", emp_Lname: null, employeeUsername: "owner",
      restaurantUsername: tenant.res_username, restaurantName: tenant.res_name,
    });
    expect(await getSession(token)).not.toBeNull();

    await archive(tenant.id);
    expect(await getSession(token)).toBeNull();
  });

  test("is idempotent, and a second archive does not destroy the way back", async () => {
    const tenant = addRestaurant({ res_username: "twice" });
    addSubscription({ res_id: tenant.id, status: "trial", plan_id: PLAN_STARTER_ID });

    await archive(tenant.id, { reason: "first" });
    const second = await archive(tenant.id, { reason: "second" });

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, account_status: "archived", already_archived: true });
    // Exactly one archive entry: a second one would record prev_sub_status
    // 'cancelled' and restore would then put the tenant back as cancelled.
    const entries = platformAudit().filter((a) => a.action === "restaurant.archive");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.detail).toMatchObject({ reason: "first", prev_sub_status: "trial" });
  });

  test("404s on an unknown restaurant, and writes nothing", async () => {
    const r = await archive("00000000-0000-4000-8000-000000000000");
    expect(r.status).toBe(404);
    expect(platformAudit()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("an archived restaurant", () => {
  test("cannot sign in", async () => {
    const created = await create({ res_name: "Gone Cafe", res_username: "gonecafe", owner_name: "A B", owner_username: "ab" });
    const password = (created.body as { owner: { temporary_password: string } }).owner.temporary_password;
    const resId = restaurantBySlug("gonecafe")!.id;
    expect((await login("gonecafe", "ab", password)).status).toBe(200);

    await archive(resId);

    const blocked = await login("gonecafe", "ab", password);
    expect(blocked.status).toBe(403);
    // The credential is still valid — it is the ACCOUNT that is closed, and the
    // message must not suggest a payment would fix it.
    expect((blocked.body as { error: string }).error).toBe("This restaurant account has been closed. Please contact support.");
  });

  test("is skipped by the billing cycle, while a live tenant on the same plan is still invoiced", async () => {
    // Lapsed, but still inside SAAS_GRACE_DAYS, so the live tenant stops at
    // past_due rather than being suspended in the same run.
    const justLapsed = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const departed = addRestaurant({ res_username: "departed" });
    const trading = addRestaurant({ res_username: "trading" });
    addSubscription({ res_id: departed.id, status: "active", plan_id: PLAN_GROWTH_ID, current_period_end: justLapsed });
    addSubscription({ res_id: trading.id, status: "active", plan_id: PLAN_GROWTH_ID, current_period_end: justLapsed });

    await archive(departed.id);
    const result = await runBillingCycle();

    expect(result.generated).toBe(1);
    expect(invoices().map((i) => i.res_id)).toEqual([trading.id]);
    // Its subscription stays cancelled — it is not dragged to past_due, and after
    // SAAS_GRACE_DAYS it is not "suspended" on top of being archived.
    expect(subscriptionFor(departed.id)?.status).toBe("cancelled");
    expect(subscriptionFor(trading.id)?.status).toBe("past_due");
  });

  test("cannot be brought back by the Activate button", async () => {
    const tenant = addRestaurant({ res_username: "wrongbutton" });
    addSubscription({ res_id: tenant.id, status: "active", plan_id: PLAN_GROWTH_ID });
    await archive(tenant.id);

    const r = await activate(tenant.id);

    expect(r.status).toBe(409);
    // Activate would have left it live and trading with a cancelled (unbilled)
    // subscription — the exact half-revived state restore exists to prevent.
    expect(restaurantBySlug("wrongbutton")?.account_status).toBe("archived");
    expect(subscriptionFor(tenant.id)?.status).toBe("cancelled");
    expect(platformAudit().some((a) => a.action === "restaurant.activate")).toBe(false);
  });

  test("activate still works normally on a merely suspended tenant, and 404s on an unknown one", async () => {
    const tenant = addRestaurant({ res_username: "suspendedonly", account_status: "suspended" });
    const ok = await activate(tenant.id);
    expect(ok.status).toBe(200);
    expect(restaurantBySlug("suspendedonly")?.account_status).toBe("active");
    expect((await activate("00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe("restore", () => {
  test("puts back exactly the two columns archive changed, and the tenant works again", async () => {
    const created = await create({ res_name: "Back Again", res_username: "backagain", owner_name: "A B", owner_username: "ab", plan_id: PLAN_GROWTH_ID });
    const password = (created.body as { owner: { temporary_password: string } }).owner.temporary_password;
    const resId = restaurantBySlug("backagain")!.id;
    addBill({ res_id: resId });
    addOrder({ res_id: resId });

    await archive(resId, { reason: "seasonal closure" });
    expect((await login("backagain", "ab", password)).status).toBe(403);
    const financialsWhileArchived = financialSnapshot();

    const r = await restore(resId);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, account_status: "active", subscription_status: "active" });
    expect(restaurantBySlug("backagain")?.account_status).toBe("active");
    expect(subscriptionFor(resId)?.status).toBe("active");
    expect(subscriptionFor(resId)?.plan_id).toBe(PLAN_GROWTH_ID);
    // Nothing financial moved in either direction.
    expect(financialSnapshot()).toBe(financialsWhileArchived);

    // The owner signs in again with the same credential — sessions were revoked,
    // not the login.
    const back = await login("backagain", "ab", password);
    expect(back.status).toBe(200);
    expect(platformAudit().find((a) => a.action === "restaurant.restore")?.detail)
      .toEqual({ restored_sub_status: "active" });
  });

  test("restores the status the tenant actually had, not a guessed 'active'", async () => {
    // A tenant that left while on trial must NOT come back billable.
    const tenant = addRestaurant({ res_username: "wasontrial" });
    addSubscription({ res_id: tenant.id, status: "trial", plan_id: PLAN_STARTER_ID });

    await archive(tenant.id);
    const r = await restore(tenant.id);

    expect((r.body as { subscription_status: string }).subscription_status).toBe("trial");
    expect(subscriptionFor(tenant.id)?.status).toBe("trial");
  });

  test("does not clobber a plan the operator re-assigned while the tenant was archived", async () => {
    const tenant = addRestaurant({ res_username: "reassigned" });
    addSubscription({ res_id: tenant.id, status: "trial", plan_id: PLAN_STARTER_ID });
    await archive(tenant.id);

    // Something else moved the subscription off 'cancelled' in the meantime.
    subscriptionFor(tenant.id)!.status = "active";
    const r = await restore(tenant.id);

    expect(r.status).toBe(200);
    expect((r.body as { subscription_status: string | null }).subscription_status).toBeNull();
    expect(subscriptionFor(tenant.id)?.status).toBe("active");
  });

  test("still un-archives when the archive audit entry is missing", async () => {
    // audit() swallows its own insert failures, so the recovery row may genuinely
    // not exist. Restore must degrade to "left cancelled, re-assign the plan"
    // rather than throwing and stranding the tenant archived forever.
    const tenant = addRestaurant({ res_username: "noauditrow" });
    addSubscription({ res_id: tenant.id, status: "active", plan_id: PLAN_GROWTH_ID });
    await archive(tenant.id);
    const archiveEntries = platformAudit().filter((a) => a.action === "restaurant.archive");
    for (const e of archiveEntries) { platformAudit().splice(platformAudit().indexOf(e), 1); }

    const r = await restore(tenant.id);

    expect(r.status).toBe(200);
    expect(restaurantBySlug("noauditrow")?.account_status).toBe("active");
    expect((r.body as { subscription_status: string | null }).subscription_status).toBeNull();
    expect(subscriptionFor(tenant.id)?.status).toBe("cancelled");
  });

  test("refuses a tenant that is not archived, and 404s on an unknown one", async () => {
    const suspended = addRestaurant({ res_username: "justsuspended", account_status: "suspended" });
    const r = await restore(suspended.id);
    expect(r.status).toBe(409);
    expect(restaurantBySlug("justsuspended")?.account_status).toBe("suspended");
    expect((await restore("00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  test("a restored tenant is billed again from the next cycle", async () => {
    const lastMonth = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const tenant = addRestaurant({ res_username: "billedagain" });
    addSubscription({ res_id: tenant.id, status: "active", plan_id: PLAN_GROWTH_ID, current_period_end: lastMonth });

    await archive(tenant.id);
    expect((await runBillingCycle()).generated).toBe(0);

    await restore(tenant.id);
    expect((await runBillingCycle()).generated).toBe(1);
    expect(invoices()).toHaveLength(1);
    expect(invoices()[0]?.res_id).toBe(tenant.id);
  });
});

// ---------------------------------------------------------------------------
// Archive used to be three writes on three different pooled connections
// (platformQuery is pool.query). Any of them landing without the others is a real
// production outcome, and the worst one was silent: the flag written, the
// subscription left 'active' on a priced plan, and no audit row — so the departed
// tenant kept being invoiced monthly AND restore had lost the only record of what
// to put back. The retry then short-circuited on "already archived" and repaired
// none of it.
//
// These tests break each write in turn and assert the two properties that replace
// that behaviour: nothing partial ever commits, and a retry finishes the job.
describe("archive when one of its writes fails mid-flight", () => {
  test("a failed subscription cancel rolls the ENTIRE archive back", async () => {
    const tenant = seedTenantWithHistory({ res_username: "halfarchived" });
    addSubscription({ res_id: tenant.id, status: "active", plan_id: PLAN_GROWTH_ID });
    breakSubscriptionCancel();

    const r = await archive(tenant.id, { reason: "closing" });

    expect(r.status).toBe(500);
    // The flag is the write that happened FIRST. If it survived, the tenant would
    // look gone while its subscription kept generating invoices.
    expect(restaurantBySlug("halfarchived")?.account_status).toBe("active");
    expect(subscriptionFor(tenant.id)?.status).toBe("active");
    expect(platformAudit().filter((a) => a.action === "restaurant.archive")).toHaveLength(0);
  });

  test("a failed audit insert rolls the entire archive back too", async () => {
    // The audit row is not a log line here — it is restore's ONLY recovery data,
    // which is why archive writes it inside the transaction rather than through
    // audit() (which swallows its own failures). An archive nobody can undo is
    // worse than an archive that was refused.
    const tenant = addRestaurant({ res_username: "noaudit" });
    addSubscription({ res_id: tenant.id, status: "trial", plan_id: PLAN_STARTER_ID });
    breakAuditInsert();

    const r = await archive(tenant.id);

    expect(r.status).toBe(500);
    expect(restaurantBySlug("noaudit")?.account_status).toBe("active");
    expect(subscriptionFor(tenant.id)?.status).toBe("trial");
    expect(platformAudit()).toEqual([]);
  });

  test("RETRYING after a failed write completes the archive, cancel and audit row included", async () => {
    // The blocker in full: before, the retry hit `priorStatus === 'archived'` and
    // returned 200 already_archived WITHOUT cancelling the subscription or writing
    // the audit row, so a departed tenant was invoiced forever and could never be
    // restored.
    const tenant = seedTenantWithHistory({ res_username: "retried" });
    addSubscription({ res_id: tenant.id, status: "active", plan_id: PLAN_GROWTH_ID });

    breakSubscriptionCancel();
    expect((await archive(tenant.id, { reason: "closing" })).status).toBe(500);
    healSubscriptionCancel();

    const retry = await archive(tenant.id, { reason: "closing" });

    expect(retry.status).toBe(200);
    expect(restaurantBySlug("retried")?.account_status).toBe("archived");
    expect(subscriptionFor(tenant.id)?.status).toBe("cancelled");
    const entries = platformAudit().filter((a) => a.action === "restaurant.archive");
    expect(entries).toHaveLength(1);
    // And the recovery data is the PRE-archive status, so restore still works.
    expect(entries[0]?.detail).toMatchObject({ prev_sub_status: "active", prev_plan_id: PLAN_GROWTH_ID });

    const back = await restore(tenant.id);
    expect(back.status).toBe(200);
    expect(subscriptionFor(tenant.id)?.status).toBe("active");
  });

  test("a tenant already flagged 'archived' but with no recovery row is REPAIRED, not skipped", async () => {
    // The state a pre-transaction partial write left behind, and the state a row
    // flipped by hand leaves behind. The old code returned 200 and walked away.
    const tenant = addRestaurant({ res_username: "orphaned", account_status: "archived" });
    addSubscription({ res_id: tenant.id, status: "active", plan_id: PLAN_GROWTH_ID });

    const r = await archive(tenant.id, { reason: "finishing the job" });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, account_status: "archived", repaired: true });
    expect(subscriptionFor(tenant.id)?.status).toBe("cancelled");
    const entries = platformAudit().filter((a) => a.action === "restaurant.archive");
    expect(entries).toHaveLength(1);
    // The subscription had never been cancelled, so its CURRENT status was still
    // the genuine pre-archive one — which is what makes the repair honest rather
    // than a guess. Restore can use it.
    expect(entries[0]?.detail).toMatchObject({ prev_sub_status: "active", prev_plan_id: PLAN_GROWTH_ID, repaired: true });
    expect((await restore(tenant.id)).status).toBe(200);
    expect(subscriptionFor(tenant.id)?.status).toBe("active");
  });

  test("re-archiving re-cancels a subscription that was put back on a plan meanwhile", async () => {
    // PUT /platform/restaurants/:id/subscription writes the status without looking
    // at account_status, so an archived tenant CAN end up back on a billable
    // subscription. Archive is the button an operator presses to stop that.
    const tenant = addRestaurant({ res_username: "resold" });
    addSubscription({ res_id: tenant.id, status: "trial", plan_id: PLAN_STARTER_ID });
    await archive(tenant.id, { reason: "first" });
    subscriptionFor(tenant.id)!.status = "active";

    const second = await archive(tenant.id, { reason: "second" });

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ already_archived: true, subscription_recancelled: true });
    expect(subscriptionFor(tenant.id)?.status).toBe("cancelled");
    // Still exactly ONE recovery row, still holding the original pre-archive
    // status. A second one would record 'cancelled' and restore would put the
    // tenant back locked out.
    const entries = platformAudit().filter((a) => a.action === "restaurant.archive");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.detail).toMatchObject({ reason: "first", prev_sub_status: "trial" });
  });
});

// ---------------------------------------------------------------------------
describe("the migration 028 release gate", () => {
  beforeEach(() => { resetArchivedStatusSupportCache(); });

  test("without 028 an archived flag is INERT — which is why the gate exists", async () => {
    // Not an assertion about the gate: an assertion about the failure it prevents.
    // platform.restaurant_status is the only thing that maps account_status to a
    // login decision, and migration 011's version matches the literal 'suspended'
    // and falls through to 'active' for everything else.
    const created = await create({ res_name: "Ghost Cafe", res_username: "ghostcafe", owner_name: "A B", owner_username: "ab" });
    const password = (created.body as { owner: { temporary_password: string } }).owner.temporary_password;
    const row = restaurantBySlug("ghostcafe")!;

    unapplyMigration028();
    row.account_status = "archived";   // as if the route had written it anyway
    subscriptions().splice(0, subscriptions().length);

    // Flagged archived in the database, greyed out in the console — and still
    // signing its staff in.
    expect((await login("ghostcafe", "ab", password)).status).toBe(200);
  });

  test("archive refuses with a 503 that names the migration, and writes nothing", async () => {
    const tenant = seedTenantWithHistory({ res_username: "toosoon" });
    addSubscription({ res_id: tenant.id, status: "active", plan_id: PLAN_GROWTH_ID });
    unapplyMigration028();

    const r = await archive(tenant.id, { reason: "closing" });

    expect(r.status).toBe(503);
    expect((r.body as { migration_required: string }).migration_required).toBe("028_restaurant_archived_status.sql");
    expect((r.body as { error: string }).error).toContain("npm run migrate");
    // Nothing was written — the operator gets an error instead of a tenant that
    // looks gone and keeps trading.
    expect(restaurantBySlug("toosoon")?.account_status).toBe("active");
    expect(subscriptionFor(tenant.id)?.status).toBe("active");
    expect(platformAudit()).toEqual([]);
  });

  test("with 028 applied the same call goes through", async () => {
    const tenant = addRestaurant({ res_username: "readynow" });
    addSubscription({ res_id: tenant.id, status: "active", plan_id: PLAN_GROWTH_ID });
    const r = await archive(tenant.id);
    expect(r.status).toBe(200);
    expect(restaurantBySlug("readynow")?.account_status).toBe("archived");
  });
});

// ---------------------------------------------------------------------------
describe("a restore that cannot finish says so", () => {
  test("names the subscription that still locks the tenant out, and what to do", async () => {
    // The degraded path: with no recovery row, restore un-archives but leaves the
    // subscription 'cancelled' — which platform.restaurant_status maps to
    // 'suspended', so the tenant reads Active in the console while its staff still
    // cannot sign in. A bare `subscription_status: null` reads as "nothing to do".
    const created = await create({ res_name: "Half Back", res_username: "halfback", owner_name: "A B", owner_username: "ab", plan_id: PLAN_GROWTH_ID });
    const password = (created.body as { owner: { temporary_password: string } }).owner.temporary_password;
    const resId = restaurantBySlug("halfback")!.id;
    await archive(resId);
    for (const e of platformAudit().filter((a) => a.action === "restaurant.archive")) {
      platformAudit().splice(platformAudit().indexOf(e), 1);
    }

    const r = await restore(resId);
    const body = r.body as {
      subscription_status: string | null;
      current_subscription_status: string | null;
      requires_plan_assignment: boolean;
      warning?: string;
    };

    expect(r.status).toBe(200);
    expect(restaurantBySlug("halfback")?.account_status).toBe("active");
    // Unchanged field, unchanged meaning: nothing was rolled back.
    expect(body.subscription_status).toBeNull();
    // New, and the point: what the subscription actually IS, and that it blocks.
    expect(body.current_subscription_status).toBe("cancelled");
    expect(body.requires_plan_assignment).toBe(true);
    expect(body.warning).toContain("cannot sign in");
    // Which is not a guess — the owner really is still locked out.
    expect((await login("halfback", "ab", password)).status).toBe(403);
  });

  test("a healthy restore reports nothing to do", async () => {
    const tenant = addRestaurant({ res_username: "cleanback" });
    addSubscription({ res_id: tenant.id, status: "active", plan_id: PLAN_GROWTH_ID });
    await archive(tenant.id);

    const r = await restore(tenant.id);
    const body = r.body as { current_subscription_status: string | null; requires_plan_assignment: boolean; warning?: string };

    expect(body.current_subscription_status).toBe("active");
    expect(body.requires_plan_assignment).toBe(false);
    expect(body.warning).toBeUndefined();
  });

  test("a plan re-assigned while archived counts as restored, not as needing attention", async () => {
    const tenant = addRestaurant({ res_username: "reassignedok" });
    addSubscription({ res_id: tenant.id, status: "trial", plan_id: PLAN_STARTER_ID });
    await archive(tenant.id);
    subscriptionFor(tenant.id)!.status = "active";

    const r = await restore(tenant.id);
    const body = r.body as { subscription_status: string | null; current_subscription_status: string | null; requires_plan_assignment: boolean };

    expect(body.subscription_status).toBeNull();          // nothing rolled back
    expect(body.current_subscription_status).toBe("active");
    expect(body.requires_plan_assignment).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("create with a plan_id that does not exist", () => {
  test("is refused BEFORE anything is seeded, so no tenant is stranded", async () => {
    // activateSubscriptionPlan runs after the seed has COMMITTED and outside any
    // transaction, so a bad plan_id used to answer 400 with the restaurant, its
    // outlet, its owner and its "Login" row already created — and the one-time
    // password discarded, never returned. The operator retried and got 409 slug
    // already taken, with nothing saying the tenant existed.
    const r = await create({
      res_name: "No Such Plan", res_username: "nosuchplan",
      owner_name: "A B", owner_username: "ab",
      plan_id: "55555555-5555-4555-8555-555555555555",
    });

    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe("Unknown plan_id");
    expect(restaurants()).toEqual([]);
    expect(logins()).toEqual([]);
    expect(subscriptions()).toEqual([]);
    expect(platformAudit()).toEqual([]);
  });

  test("a plan_id that is not even a uuid is the same clean 400", async () => {
    const r = await create({ res_name: "Bad Plan", res_username: "badplan", owner_name: "A B", owner_username: "ab", plan_id: "growth" });
    expect(r.status).toBe(400);
    expect(restaurants()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("POST /auth/register-restaurant (public self-serve)", () => {
  // The refactor moved this route's body onto the shared provisionRestaurant, and
  // the requirement was that the NORMAL PATH does not change. This pins the whole
  // response object with toEqual, not toMatchObject: an added field is a change to
  // a contract that public sign-up clients already consume.
  const register = (body: Record<string, unknown>) =>
    harness.call("POST", "/auth/register-restaurant", { body, ip: freshIp() });

  test("the 201 body is exactly what it always was", async () => {
    const r = await register({
      restaurantName: "The Rustic Fork",
      adminName: "Asha Menon",
      adminEmployeeId: "asha",
      password: "correct-horse-9",
    });

    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      restaurantId: "therusticfork",   // slug derived from the name, never supplied
      restaurantName: "The Rustic Fork",
      admin: { employeeId: "asha", name: "Asha Menon", role: "admin" },
    });
    // No id, no temporary password, no subscription detail — the operator route is
    // the one that returns those.
    expect(Object.keys(r.body as object).sort()).toEqual(["admin", "restaurantId", "restaurantName"]);
  });

  test("it really did seed the tenant, and the owner can sign in", async () => {
    await register({ restaurantName: "Blue Door", adminName: "Ravi K", adminEmployeeId: "ravi", password: "correct-horse-9" });
    const row = restaurantBySlug("bluedoor");
    expect(row?.res_name).toBe("Blue Door");
    expect(outlets().filter((o) => o.res_id === row?.id)).toHaveLength(1);
    expect((await login("bluedoor", "ravi", "correct-horse-9")).status).toBe(200);
    // Self-serve still gets the trial it always got.
    expect(subscriptionFor(row!.id)?.status).toBe("trial");
  });

  test("a duplicate registration is still the same 409 string", async () => {
    await register({ restaurantName: "Joe's Pizza", adminName: "Joe P", adminEmployeeId: "joe", password: "correct-horse-9" });
    const again = await register({ restaurantName: "Joe's Pizza", adminName: "Impostor", adminEmployeeId: "joe", password: "correct-horse-9" });

    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: `Restaurant "Joe's Pizza" is already registered.` });
    // And the pre-check that produced it is a security control: EnsureRestaurantSeed
    // is an UPSERT whose update branches rename the tenant and overwrite the owner's
    // password hash.
    expect(restaurants()).toHaveLength(1);
    expect(restaurantBySlug("joespizza")?.res_name).toBe("Joe's Pizza");
    expect((await login("joespizza", "joe", "correct-horse-9")).status).toBe(200);
  });
});
