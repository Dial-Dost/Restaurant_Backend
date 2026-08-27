// In-memory store + a fake `pg` Pool + a fake Express app, so the REAL operator
// tenant-lifecycle path (platform/routes.ts driving provisioning.ts,
// database_supabase.ts and platform/tenant_billing.ts) can be exercised as a unit
// test — create, archive, restore, and the login and billing consequences of each.
//
// WHY A FIXTURE RATHER THAN PURE FUNCTIONS: none of the guarantees under test live
// in a function. "An archived tenant cannot sign in" is a CASE arm in a SQL
// function. "The billing cycle skips it" is a `where s.status = 'active'`
// predicate. "Nothing financial is touched" is the ABSENCE of statements. A test
// that re-implemented any of that in TypeScript would assert only that the copy
// agrees with itself. Driving the shipped code over a stubbed Pool tests the real
// statements and needs no database, so the suite can never be "skipped because a
// database wasn't reachable". (Same reasoning and shape as report_fixtures.ts and
// print_fixtures.ts.)
//
// ONE STORE FOR BOTH POOLS, and that is the point. platform/db.ts (the control
// plane, as platform_runtime) and database_supabase.ts (the tenant plane, as
// app_runtime) are separate pools in production but read the same database. Here
// they share one store, so an UPDATE the archive route makes through platformQuery
// is what the tenant-side login gate reads back — which is exactly the coupling
// the archive feature depends on and the thing worth testing.
//
// THE RULE THAT KEEPS IT HONEST: behaviour is DERIVED from the SQL text wherever
// the SQL is the guarantee. platform.restaurant_status is modelled by reading the
// CASE arms out of migrations/028_restaurant_archived_status.sql, so deleting the
// 'archived' arm from the migration makes these tests fail instead of leaving the
// fixture enforcing a rule the database no longer has. Predicates such as
// `and status = 'cancelled'` and `<> 'archived'` are applied only when the
// statement actually carries them.
//
// WHAT IT DOES NOT MODEL, stated because an inaccurate promise is worse than none:
// isolation. Writes are visible immediately, as if every transaction ran READ
// UNCOMMITTED. ROLLBACK is modelled (a journal of undos) because the seed's
// all-or-nothing property is under test, but concurrent-transaction visibility is
// not. It also does not model RLS: a statement platform_runtime would be refused
// in production still succeeds here, so the fixture proves behaviour, never
// permissions.
//
// Dispatch matches on a marker in the SQL and THROWS on anything unrecognised, so
// a code path that starts issuing a new query fails loudly rather than silently
// receiving zero rows. Any DELETE / TRUNCATE / DROP throws with its own message —
// see NO_DESTRUCTIVE_SQL.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
/** A platform admin whose `active` flag is false — requirePlatformAuth re-checks
 *  it on EVERY request, so their token must stop resolving. */
export const INACTIVE_ADMIN_ID = "22222222-2222-4222-8222-222222222222";
export const PLAN_STARTER_ID = "33333333-3333-4333-8333-333333333333";
export const PLAN_GROWTH_ID = "44444444-4444-4444-8444-444444444444";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface RestaurantRow {
  id: string;
  created_at: Date;
  res_username: string;
  res_name: string;
  main_office_add: string | null;
  logo: string | null;
  timezone: string | null;
  account_status: string;
  /** The Swiggy/Zomato intake key. Null unless a test issues one. */
  aggregator_key: string | null;
  /** Master on/off for the queue page's pre-order menu. */
  queue_show_menu: boolean | null;
  /** The queue PRE-ORDER menu rule (queue_menu.ts). Null = every existing
   *  tenant = the whole menu, which is the contract the tests pin. */
  queue_menu_config: unknown;
  /** The configurable badge CATALOGUE (menu_badges.ts). Null = never
   *  configured = no badge renders anywhere, which is what the badge tests pin. */
  menu_badges: unknown;
}

export interface OutletRow {
  id: string;
  created_at: Date;
  res_id: string;
  oultet_username: string;   // sic — the schema misspells it
  outlet_name: string;
  outlet_add: string | null;
  outlet_main_ph: string | null;
  outlet_working_hours: string | null;
}

export interface EmployeeRow {
  id: string;
  created_at: Date;
  res_id: string;
  outlet_id: string;
  emp_Fname: string;
  emp_Lname: string | null;
  emp_email: string | null;
  emp_ph: string | null;
  emp_add: string | null;
  emp_roles: { primary: string; all: string[] };
}

export interface LoginRow {
  emp_id: string;
  created_at: Date;
  res_id: string;
  outlet_id: string;
  emp_username: string;
  emp_pass: string;
}

/** Only the columns these tests read. The point of every "Bills"/"Orders"/
 *  "Audit_logs" row here is that it is still byte-identical afterwards. */
export interface BillRow {
  id: string;
  res_id: string;
  outlet_id: string;
  status: number;
  total_amt: number;
  tax_breakdown: string;
  closed_at: Date | null;
}
export interface OrderRow { id: string; res_id: string; outlet_id: string; food: string }
export interface AuditLogRow { id: string; res_id: string; action: string }

/** One "Waitlist" row plus `table_name`, the column the queue reads join in
 *  from "Tables" (modelled inline — the fixture has no Tables store). pre_order
 *  and party_members are kept as TEXT exactly as the pg driver may hand jsonb
 *  back; mapWaitlist parses both forms. */
export interface WaitlistRow {
  id: string;
  created_at: Date;
  res_id: string;
  outlet_id: string | null;
  token: string;
  name: string;
  phone: string | null;
  party_size: number;
  status: string;
  table_id: string | null;
  table_name: string | null;
  pre_order: string;
  pre_order_status: string;
  placed_order_id: string | null;
  party_members: string;
  called_at: Date | null;
  seated_at: Date | null;
}

/** One "Menu" row as GetMenuItems selects it — price and availability live in
 *  the JSON `description` column (parseMenuDescription's contract). */
export interface MenuRow {
  id: string;
  created_at: Date;
  res_id: string;
  outlet_id: string | null;
  name: string;
  description: string;
  sub_category: string | null;
  main_category: string | null;
}

/** One "Posters" row (migration 031) as the poster readers select it. The date
 *  bounds are CALENDAR KEYS (YYYY-MM-DD strings), never Date objects, because
 *  that is what to_char() hands back and the whole scheduling contract rests on
 *  the values never round-tripping through a timezone. */
export interface PosterRow {
  id: string;
  created_at: Date;
  res_id: string;
  outlet_id: string | null;
  image_url: string;
  title: string;
  placement: string;
  sort_order: number;
  start_on: string | null;
  end_on: string | null;
  active: boolean;
  width: number;
  height: number;
}

/** One "Menue_main_cat" / "Menue_sub_cat" row. UpsertMenuItem resolves a
 *  category NAME to this pair of ids before it can write a "Menu" row, so the
 *  fixture has to model them for the real upsert to be drivable. */
export interface MenuCategoryRow {
  id: string;
  res_id: string;
  outlet_id: string | null;
  name: string;
  /** Set on a sub-category, null on a main category. */
  main_cat_id: string | null;
}

export interface PlatformAdminRow { id: string; email: string; active: boolean }
export interface PlanRow { id: string; code: string; name: string; price_cents: number; active: boolean; created_at: Date }
export interface SubscriptionRow {
  res_id: string;
  plan_id: string | null;
  status: string;
  trial_ends_at: Date | null;
  current_period_end: Date | null;
  pending_plan_id: string | null;
  updated_at: Date;
}
export interface InvoiceRow {
  id: string;
  res_id: string;
  plan_id: string | null;
  amount_cents: number;
  status: string;
  period_start: string | null;
  period_end: string | null;
  note: string | null;
  created_at: Date;
}
export interface PlatformAuditRow {
  id: string;
  admin_id: string;
  action: string;
  target_res_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: Date;
}

interface Store {
  restaurants: RestaurantRow[];
  outlets: OutletRow[];
  employees: EmployeeRow[];
  logins: LoginRow[];
  bills: BillRow[];
  orders: OrderRow[];
  auditLogs: AuditLogRow[];
  admins: PlatformAdminRow[];
  plans: PlanRow[];
  subscriptions: SubscriptionRow[];
  invoices: InvoiceRow[];
  platformAudit: PlatformAuditRow[];
  waitlists: WaitlistRow[];
  menuRows: MenuRow[];
  menuCats: MenuCategoryRow[];
  posters: PosterRow[];
  /** Every "Restaurant" INSERT throws 23505 — two callers racing the pre-check. */
  failRestaurantInsert: boolean;
  /** Every "Login" INSERT throws — the seed dying halfway through. */
  failLoginInsert: boolean;
  /** The "Bills" count throws — the tenant pool unreachable from the archive route. */
  failBillsCount: boolean;
  /** The "Menu" read throws — models the pool-exhaustion / statement-timeout
   *  failures measured in production, which repriceFromMenu used to swallow
   *  into "drop every line" (wiping held waitlist pre-orders). */
  failMenuRead: boolean;
  /** The subscription cancel throws — archive's SECOND write failing mid-flight. */
  failSubscriptionCancel: boolean;
  /** The platform.audit insert throws — archive's THIRD write failing mid-flight. */
  failAuditInsert: boolean;
  /**
   * Whether migration 028 is applied to this "database". False models the real
   * pre-028 state: platform.restaurant_status exists (migration 011 created it)
   * but has no 'archived' arm, so an archived tenant reads back as ACTIVE.
   */
  migration028Applied: boolean;
  nextId: number;
}

let store: Store = freshStore();

function freshStore(): Store {
  return {
    restaurants: [],
    outlets: [],
    employees: [],
    logins: [],
    bills: [],
    orders: [],
    auditLogs: [],
    admins: [
      { id: ADMIN_ID, email: "operator@example.test", active: true },
      { id: INACTIVE_ADMIN_ID, email: "former@example.test", active: false },
    ],
    plans: [
      { id: PLAN_STARTER_ID, code: "starter", name: "Starter", price_cents: 0, active: true, created_at: new Date("2020-01-01T00:00:00Z") },
      { id: PLAN_GROWTH_ID, code: "growth", name: "Growth", price_cents: 499_00, active: true, created_at: new Date("2020-01-02T00:00:00Z") },
    ],
    subscriptions: [],
    invoices: [],
    platformAudit: [],
    waitlists: [],
    menuRows: [],
    menuCats: [],
    posters: [],
    failRestaurantInsert: false,
    failLoginInsert: false,
    failBillsCount: false,
    failMenuRead: false,
    failSubscriptionCancel: false,
    failAuditInsert: false,
    migration028Applied: true,
    nextId: 1,
  };
}

export function resetStore(): void { store = freshStore(); }

export function restaurants(): RestaurantRow[] { return store.restaurants; }
export function outlets(): OutletRow[] { return store.outlets; }
export function employees(): EmployeeRow[] { return store.employees; }
export function logins(): LoginRow[] { return store.logins; }
export function bills(): BillRow[] { return store.bills; }
export function orders(): OrderRow[] { return store.orders; }
export function auditLogs(): AuditLogRow[] { return store.auditLogs; }
export function subscriptions(): SubscriptionRow[] { return store.subscriptions; }
export function invoices(): InvoiceRow[] { return store.invoices; }
export function platformAudit(): PlatformAuditRow[] { return store.platformAudit; }
export function waitlists(): WaitlistRow[] { return store.waitlists; }

export function restaurantBySlug(slug: string): RestaurantRow | undefined {
  return store.restaurants.find((r) => r.res_username.toLowerCase() === slug.toLowerCase());
}
export function subscriptionFor(resId: string): SubscriptionRow | undefined {
  return store.subscriptions.find((s) => s.res_id === resId);
}

export function breakRestaurantInsert(): void { store.failRestaurantInsert = true; }
export function breakLoginInsert(): void { store.failLoginInsert = true; }
export function breakBillsCount(): void { store.failBillsCount = true; }
export function breakMenuRead(): void { store.failMenuRead = true; }
export function healMenuRead(): void { store.failMenuRead = false; }
export function breakSubscriptionCancel(): void { store.failSubscriptionCancel = true; }
export function healSubscriptionCancel(): void { store.failSubscriptionCancel = false; }
export function breakAuditInsert(): void { store.failAuditInsert = true; }
export function healAuditInsert(): void { store.failAuditInsert = false; }
/** Model a database on which migration 028 has NOT been run. */
export function unapplyMigration028(): void { store.migration028Applied = false; }

/** Seed a tenant directly, for tests that need one without paying for argon2. */
export function addRestaurant(over: Partial<RestaurantRow> = {}): RestaurantRow {
  const n = store.nextId++;
  const row: RestaurantRow = {
    id: `res-${String(n)}`,
    created_at: new Date("2024-01-01T00:00:00Z"),
    res_username: `tenant${String(n)}`,
    res_name: `Tenant ${String(n)}`,
    main_office_add: null,
    logo: null,
    timezone: "Asia/Kolkata",
    account_status: "active",
    aggregator_key: null,
    queue_show_menu: null,
    queue_menu_config: null,
    menu_badges: null,
    ...over,
  };
  store.restaurants.push(row);
  return row;
}

export function addSubscription(over: Partial<SubscriptionRow> & { res_id: string }): SubscriptionRow {
  const row: SubscriptionRow = {
    plan_id: PLAN_GROWTH_ID,
    status: "active",
    trial_ends_at: null,
    current_period_end: null,
    pending_plan_id: null,
    updated_at: new Date(),
    ...over,
  };
  store.subscriptions.push(row);
  return row;
}

/** A settled bill with its GST breakdown — a statutory record. */
export function addBill(over: Partial<BillRow> & { res_id: string }): BillRow {
  const n = store.nextId++;
  const row: BillRow = {
    id: `bill-${String(n)}`,
    outlet_id: "outlet-x",
    status: 2,
    total_amt: 1180,
    tax_breakdown: JSON.stringify([{ name: "CGST", rate: 9, amount: 90 }, { name: "SGST", rate: 9, amount: 90 }]),
    closed_at: new Date("2026-01-01T12:00:00Z"),
    ...over,
  };
  store.bills.push(row);
  return row;
}
export function addOrder(over: Partial<OrderRow> & { res_id: string }): OrderRow {
  const n = store.nextId++;
  const row: OrderRow = { id: `order-${String(n)}`, outlet_id: "outlet-x", food: "[]", ...over };
  store.orders.push(row);
  return row;
}
export function addAuditLog(over: Partial<AuditLogRow> & { res_id: string }): AuditLogRow {
  const n = store.nextId++;
  const row: AuditLogRow = { id: `alog-${String(n)}`, action: "bill_settled", ...over };
  store.auditLogs.push(row);
  return row;
}

/** Seed an outlet. The guest flows resolve the DEFAULT outlet (oldest row), and
 *  GetMenuItems is outlet-scoped, so waitlist tests need at least one. */
export function addOutlet(over: Partial<OutletRow> & { res_id: string }): OutletRow {
  const n = store.nextId++;
  const row: OutletRow = {
    id: `outlet-${String(n)}`,
    created_at: new Date("2024-01-01T00:00:00Z"),
    oultet_username: `outlet${String(n)}`,
    outlet_name: `Outlet ${String(n)}`,
    outlet_add: null,
    outlet_main_ph: null,
    outlet_working_hours: null,
    ...over,
  };
  store.outlets.push(row);
  return row;
}

/** Seed a menu item the way the schema stores it: price/availability inside the
 *  JSON description column. */
export function addMenuItem(over: { res_id: string; outlet_id: string | null; name: string; price: number; available?: boolean; id?: string; category?: string; created_at?: Date; extra?: Record<string, unknown> }): MenuRow {
  const n = store.nextId++;
  const row: MenuRow = {
    id: over.id ?? `menu-${String(n)}`,
    // Distinct per item so GetMenuItems' newest-first ordering is deterministic
    // — the queue menu preserves that order inside a category.
    created_at: over.created_at ?? new Date(Date.UTC(2024, 0, 2, 0, 0, n)),
    res_id: over.res_id,
    outlet_id: over.outlet_id,
    name: over.name,
    // `extra` seeds the OTHER description-JSON keys (image_url, station, recipe,
    // allergens, blurb, badges, price history). The badge tests need them so
    // "tagging did not disturb anything else" can be asserted against a real
    // stored blob rather than an empty one.
    description: JSON.stringify({ price: over.price, available: over.available !== false, ...(over.extra ?? {}) }),
    // GetMenuItems reads the sub-category first and falls back to "General".
    sub_category: over.category ?? null,
    // ensureMenuCategoryIds writes the SAME name to both levels, so a seeded
    // item has to carry it too — otherwise a later upsert of that dish resolves
    // a different main category and the id-less name lookup misses it.
    main_category: over.category ?? null,
  };
  store.menuRows.push(row);
  if (over.category) { ensureFixtureMenuCategory(over.res_id, over.outlet_id, over.category); }
  return row;
}

/** Seed the main+sub category pair for a name, the way ensureMenuCategoryIds
 *  would have. Idempotent, so seeding ten dishes in one category makes one pair. */
function ensureFixtureMenuCategory(resId: string, outletId: string | null, name: string): void {
  const same = (c: MenuCategoryRow, mainCatId: string | null) =>
    c.res_id === resId && c.outlet_id === outletId && c.name.toLowerCase() === name.toLowerCase() && c.main_cat_id === mainCatId;
  let main = store.menuCats.find((c) => same(c, null));
  if (!main) {
    main = { id: `maincat-${String(store.nextId++)}`, res_id: resId, outlet_id: outletId, name, main_cat_id: null };
    store.menuCats.push(main);
  }
  if (!store.menuCats.some((c) => same(c, main.id))) {
    store.menuCats.push({ id: `subcat-${String(store.nextId++)}`, res_id: resId, outlet_id: outletId, name, main_cat_id: main.id });
  }
}

/** A promotional poster. `outlet_id` defaults to NULL, which is what the poster
 *  editor writes and what "shows on every branch" means (migration 031). */
export function addPoster(over: Partial<PosterRow> & { res_id: string }): PosterRow {
  const n = store.nextId++;
  const row: PosterRow = {
    id: `poster-${String(n)}`,
    // Distinct per poster so the (sort_order, created_at, id) ordering the guest
    // read promises is deterministic here too.
    created_at: new Date(Date.UTC(2024, 0, 3, 0, 0, n)),
    outlet_id: null,
    image_url: `https://cdn.example.test/poster-${String(n)}.webp`,
    title: "",
    placement: "menu",
    sort_order: 0,
    start_on: null,
    end_on: null,
    active: true,
    width: 1200,
    height: 675,
    ...over,
  };
  store.posters.push(row);
  return row;
}
export function posters(): PosterRow[] { return store.posters; }

/** Set (or clear) a tenant's queue pre-order menu rule the way the editor would.
 *  Null is the state EVERY production tenant is in — see queue_menu.ts. */
export function setQueueMenuConfig(resId: string, config: unknown): void {
  const r = store.restaurants.find((x) => x.id === resId);
  if (r) {r.queue_menu_config = config;}
}

/** Seed a queue entry directly (the join route works too, but most pre-order
 *  tests need a party already in a specific state). */
export function addWaitlistEntry(over: Partial<WaitlistRow> & { res_id: string }): WaitlistRow {
  const n = store.nextId++;
  const row: WaitlistRow = {
    id: `wl-${String(n)}`,
    created_at: new Date(),
    outlet_id: null,
    token: `wtok-${String(n)}`,
    name: "Walk-in",
    phone: "9000000001",
    party_size: 2,
    status: "waiting",
    table_id: null,
    table_name: null,
    pre_order: "[]",
    pre_order_status: "none",
    placed_order_id: null,
    party_members: "[]",
    called_at: null,
    seated_at: null,
    ...over,
  };
  store.waitlists.push(row);
  return row;
}

// ---------------------------------------------------------------------------
// platform.restaurant_status — read out of the migration, not re-typed here
// ---------------------------------------------------------------------------

/**
 * The whole archive feature rests on ONE SQL function returning a non-'active'
 * string for an archived tenant. Migration 028 is the only place that mapping
 * exists, and it is applied by hand — so the fixture reads the migration file and
 * refuses to model an arm the migration does not actually contain. Delete the
 * 'archived' arm from 028 and every archive test fails here, loudly, instead of
 * passing against a rule only the fixture believes in.
 */
const ARCHIVED_STATUS_MIGRATION = join(__dirname, "..", "migrations", "028_restaurant_archived_status.sql");

function migrationMapsArchived(): boolean {
  const sql = readFileSync(ARCHIVED_STATUS_MIGRATION, "utf8");
  // The arm as migration 011 writes them: WHEN r.account_status = 'x' THEN 'y'.
  const arm = /WHEN\s+r\.account_status\s*=\s*'archived'\s+THEN\s+'archived'/i;
  const replaces = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+platform\.restaurant_status/i;
  return replaces.test(sql) && arm.test(sql);
}

function restaurantStatus(resId: string): string | null {
  const r = store.restaurants.find((x) => x.id === resId);
  if (!r) { return null; }
  // store.migration028Applied === false models a database still running migration
  // 011's version of this function: 'archived' is simply not a value it knows, so
  // it FALLS THROUGH to the arms below and an archived tenant reads back as
  // 'active'. That is the inertness the archive route's release gate exists to
  // prevent, and it is modelled here rather than asserted about, so the test that
  // proves the gate is testing the real failure.
  if (r.account_status === "archived" && store.migration028Applied) {
    if (!migrationMapsArchived()) {
      throw new Error(
        `platform fixture: ${ARCHIVED_STATUS_MIGRATION} does not map account_status 'archived' to 'archived'. ` +
        "Without that arm the shipped function falls through to 'active' and an archived tenant can still sign in.",
      );
    }
    return "archived";
  }
  if (r.account_status === "suspended") { return "suspended"; }
  const s = store.subscriptions.find((x) => x.res_id === resId);
  if (!s) { return "active"; }
  if (s.status === "suspended" || s.status === "cancelled") { return "suspended"; }
  if (s.status === "expired") { return "expired"; }
  if (s.status === "trial" && s.trial_ends_at && s.trial_ends_at.getTime() < Date.now()) { return "expired"; }
  return "active";
}

// ---------------------------------------------------------------------------
// The fake client
// ---------------------------------------------------------------------------

function requireShape(q: string, fragment: string, why: string): void {
  if (!q.toLowerCase().includes(fragment.toLowerCase())) {
    throw new Error(`platform fixture: query lost "${fragment}" — ${why}\n  ${q.slice(0, 220)}`);
  }
}

/** Any statement that could destroy a tenant's records. Not "unrecognised" — its
 *  own message, because a delete reaching "Restaurant" cascades to every Order,
 *  Bill, tax breakdown and Audit_log the tenant ever produced. */
const NO_DESTRUCTIVE_SQL = /^(delete|truncate|drop)\b/i;

type Undo = () => void;
/** Journal entries are undos or savepoint markers, so ROLLBACK TO can undo
 *  exactly the writes made since the savepoint. withTransaction nested inside
 *  withTenant (every guest waitlist pre-order mutation) runs on savepoints, and
 *  "a failed confirm must not half-commit" is a property under test. */
type JournalEntry = Undo | { savepoint: string };

class FakeClient {
  private undo: JournalEntry[] = [];
  private depth = 0;

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    const q = sql.replace(/\s+/g, " ").trim();
    if (/^begin$/i.test(q)) { this.depth++; if (this.depth === 1) { this.undo = []; } return { rows: [] }; }
    if (/^commit$/i.test(q)) { this.depth = Math.max(0, this.depth - 1); if (this.depth === 0) { this.undo = []; } return { rows: [] }; }
    if (/^rollback$/i.test(q)) {
      for (const u of [...this.undo].reverse()) { if (typeof u === "function") { u(); } }
      this.undo = []; this.depth = 0;
      return { rows: [] };
    }
    let sp = /^savepoint (\S+)$/i.exec(q);
    if (sp) { this.undo.push({ savepoint: sp[1]! }); return { rows: [] }; }
    sp = /^release savepoint (\S+)$/i.exec(q);
    if (sp) {
      const at = this.findSavepoint(sp[1]!);
      // Its writes now belong to the enclosing transaction; only the marker goes.
      if (at >= 0) { this.undo.splice(at, 1); }
      return { rows: [] };
    }
    sp = /^rollback to savepoint (\S+)$/i.exec(q);
    if (sp) {
      const at = this.findSavepoint(sp[1]!);
      if (at >= 0) {
        const undone = this.undo.splice(at + 1);
        for (const u of undone.reverse()) { if (typeof u === "function") { u(); } }
      }
      return { rows: [] };
    }
    return { rows: dispatch(q, params, (u) => { if (this.depth > 0) { this.undo.push(u); } }) };
  }

  /** Latest marker with this name (savepoints can be re-declared). */
  private findSavepoint(name: string): number {
    for (let i = this.undo.length - 1; i >= 0; i--) {
      const e = this.undo[i];
      if (typeof e !== "function" && e!.savepoint === name) { return i; }
    }
    return -1;
  }

  release(): void { /* pooled clients are reusable here */ }
}

export interface FixtureConnection {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  release: () => void;
}
interface FixtureGlobal { __platformFixtureConnect?: () => FixtureConnection }
(globalThis as unknown as FixtureGlobal).__platformFixtureConnect = () => new FakeClient();

const now = (): Date => new Date();

function addMonthsUtc(d: Date, n: number): Date {
  const x = new Date(d.getTime());
  x.setMonth(x.getMonth() + n);
  return x;
}

// eslint-disable-next-line complexity
function dispatch(q: string, params: unknown[], journal: (u: Undo) => void): unknown[] {
  if (NO_DESTRUCTIVE_SQL.test(q)) {
    throw new Error(
      `platform fixture: a DESTRUCTIVE statement was issued — "${q.slice(0, 160)}". ` +
      'Every tenant table cascades from "Restaurant"(id); removal must be an account_status change, never a delete.',
    );
  }
  if (/^select set_config\(/i.test(q)) { return []; }
  if (/pg_try_advisory_lock/i.test(q)) { return [{ locked: true }]; }
  if (/pg_advisory_unlock/i.test(q)) { return [{ ok: true }]; }
  if (/^select 1 as ok$/i.test(q)) { return [{ ok: 1 }]; }

  // Lazy branding DDL (ensureBrandingColumns) — additive ALTERs the real database
  // has already applied. Modelled as a no-op so the aggregator intake path, which
  // calls it before resolving an API key, is drivable.
  if (/^alter table "Restaurant" add column/i.test(q)) { return []; }

  // --- platform SECURITY DEFINER functions (called on the TENANT pool) ---
  if (/platform\.restaurant_status/i.test(q)) {
    return [{ status: restaurantStatus(String(params[0])) }];
  }

  // archivedStatusSupported()'s release gate reads the APPLIED function body out
  // of pg_proc. Modelled by handing back the real migration file that would be in
  // force: 028's when it has been applied, 011's when it has not. So the gate is
  // matching against the same SQL text production would, and deleting the
  // 'archived' arm from 028 makes the gate refuse here exactly as it would there.
  if (/from pg_proc p/i.test(q) && /platform/i.test(q) && /restaurant_status/i.test(q)) {
    const file = store.migration028Applied
      ? "028_restaurant_archived_status.sql"
      : "011_billing_grace.sql";
    return [{ src: readFileSync(join(__dirname, "..", "migrations", file), "utf8") }];
  }
  if (/platform\.restaurant_plan/i.test(q)) {
    return [{ features: {}, limits: {} }];
  }

  // --- platform.admins -----------------------------------------------------
  if (/^select active from platform\.admins/i.test(q)) {
    const a = store.admins.find((x) => x.id === params[0]);
    return a ? [{ active: a.active }] : [];
  }

  // --- platform.audit ------------------------------------------------------
  if (/^insert into platform\.audit/i.test(q)) {
    // Archive writes its recovery row through this statement INSIDE its
    // transaction (not through audit(), which swallows failures), so this arm has
    // to be able to fail and to roll back like any other write.
    if (store.failAuditInsert) { throw new Error("platform.audit insert failed"); }
    const [adminId, action, targetResId, detail] = params as [string, string, string | null, string | null];
    const row: PlatformAuditRow = {
      id: `paudit-${String(store.nextId++)}`,
      admin_id: adminId,
      action,
      target_res_id: targetResId,
      // jsonb: the route stringifies, Postgres hands back a parsed object.
      detail: detail === null ? null : (JSON.parse(detail) as Record<string, unknown>),
      created_at: now(),
    };
    store.platformAudit.push(row);
    journal(() => { store.platformAudit = store.platformAudit.filter((x) => x !== row); });
    return [];
  }
  if (/^select detail from platform\.audit/i.test(q)) {
    requireShape(q, "order by created_at desc",
      "restore recovers prev_sub_status from the LATEST archive entry; without the ordering it could read the first archive of a tenant archived twice");
    const rows = store.platformAudit
      .filter((a) => a.target_res_id === params[0] && a.action === "restaurant.archive")
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return rows.slice(0, 1).map((a) => ({ detail: a.detail }));
  }

  // --- "Restaurant" --------------------------------------------------------
  if (/^select account_status from "Restaurant"/i.test(q)) {
    const r = store.restaurants.find((x) => x.id === params[0]);
    return r ? [{ account_status: r.account_status }] : [];
  }
  if (/^select id::text as res_id from "Restaurant"/i.test(q)) {
    const slug = String(params[0] ?? "");
    const r = store.restaurants.find(
      (x) => x.res_username.toLowerCase() === slug.toLowerCase() || x.id === slug,
    );
    return r ? [{ res_id: r.id }] : [];
  }
  if (/^select id from "Restaurant" where lower\(res_username\) = lower\(\$1\)/i.test(q)) {
    const slug = String(params[0] ?? "");
    const r = store.restaurants.find((x) => x.res_username.toLowerCase() === slug.toLowerCase());
    return r ? [{ id: r.id }] : [];
  }
  // GetRestaurantIdByAggregatorKey — the Swiggy/Zomato intake's whole auth.
  if (/^select id from "Restaurant" where aggregator_key = \$1/i.test(q)) {
    const key = String(params[0] ?? "");
    const r = store.restaurants.find((x) => x.aggregator_key === key);
    return r ? [{ id: r.id }] : [];
  }
  if (/^insert into "Restaurant"/i.test(q)) {
    const [id, slug, name, address] = params as [string, string, string, string | null];
    if (store.failRestaurantInsert || store.restaurants.some((x) => x.res_username.toLowerCase() === slug.toLowerCase())) {
      // Restaurant_res_username_key (migrations/000_base_schema.sql:430).
      throw Object.assign(new Error(`duplicate key value violates unique constraint "Restaurant_res_username_key"`), { code: "23505" });
    }
    const row: RestaurantRow = {
      id, created_at: now(), res_username: slug, res_name: name,
      main_office_add: address, logo: null, timezone: null, account_status: "active", aggregator_key: null,
      queue_show_menu: null, queue_menu_config: null, menu_badges: null,
    };
    store.restaurants.push(row);
    journal(() => { store.restaurants = store.restaurants.filter((x) => x !== row); });
    return [];
  }
  if (/^update "Restaurant" set res_name/i.test(q)) {
    const [id, name, address] = params as [string, string, string | null];
    const r = store.restaurants.find((x) => x.id === id);
    if (!r) { return []; }
    const before = { ...r };
    journal(() => { Object.assign(r, before); });
    r.res_name = name;
    r.main_office_add = address;
    return [];
  }
  if (/^update "Restaurant" set account_status/i.test(q)) {
    // Read the target off the SET clause specifically. `<> 'archived'` in the
    // activate route's WHERE also contains the word, and a looser match wrote
    // 'archived' on every activate.
    const set = /^update "Restaurant" set account_status = '([a-z_]+)'/i.exec(q);
    if (!set) { throw new Error(`platform fixture: unparsable account_status update\n  ${q}`); }
    const target = set[1]!;
    const r = store.restaurants.find((x) => x.id === params[0]);
    if (!r) { return []; }
    // `<> 'archived'` on the activate route: refuses to lift an archive.
    if (/<> 'archived'/i.test(q) && r.account_status === "archived") { return []; }
    const before = { ...r };
    journal(() => { Object.assign(r, before); });
    r.account_status = target;
    return [{ id: r.id, account_status: r.account_status }];
  }

  // resolveRestaurantContext — both branches. Only the outlet-bound branch
  // carries the o.id::text = $4 predicate (database_supabase.ts:1592).
  if (/from "Restaurant" r/i.test(q) && /left join "Outlets" o/i.test(q)) {
    const [a, b, c] = params as [string, string, string];
    const r = store.restaurants.find(
      (x) => x.res_username.toLowerCase() === String(a).toLowerCase()
        || x.res_username.toLowerCase() === String(b).toLowerCase()
        || x.id === c,
    );
    if (!r) { return []; }
    const identity = {
      res_id: r.id,
      restaurant_slug: r.res_username,
      restaurant_name: r.res_name,
      restaurant_main_office_add: r.main_office_add,
      restaurant_logo_url: r.logo,
      // READ OFF THE QUERY'S OWN SELECT LIST, not handed over unconditionally.
      //
      // The default (no bound outlet) branch used to omit r.timezone, so every
      // public /qr/ request resolved a context whose zone had silently fallen
      // back to Asia/Kolkata — a real production bug for any non-IST tenant.
      // The fix is one word in the select list, and a fixture that returns the
      // column whether or not the query asked for it CANNOT SEE IT: the whole
      // suite stayed green with the fix reverted, which is exactly what this
      // comment used to claim was impossible.
      //
      // Now the fixture answers like Postgres: a column the query did not
      // select is not in the row.
      // Matches the COLUMN (`r.timezone`), not the word: a select list can
      // mention "timezone" while not reading the column at all (`null as
      // timezone` was the exact pre-fix shape), and a looser regex would call
      // that a hit and hand the value over anyway.
      ...(/\br\s*\.\s*timezone\b/i.test(q) ? { timezone: r.timezone } : {}),
    };
    const mine = store.outlets.filter((o) => o.res_id === r.id)
      .sort((x, y) => x.created_at.getTime() - y.created_at.getTime());
    if (/o\.id::text = \$4/i.test(q)) {
      const bound = String(params[3] ?? "");
      const hit = mine.find((o) => o.id === bound || o.outlet_name.toLowerCase() === bound.toLowerCase());
      // No match falls through to the default branch, exactly as in production.
      return hit ? [{ ...identity, outlet_id: hit.id }] : [];
    }
    return [{ ...identity, outlet_id: mine[0]?.id ?? null }];
  }

  // --- "Outlets" -----------------------------------------------------------
  if (/^select id from "Outlets" where res_id = \$1/i.test(q)) {
    const mine = store.outlets.filter((o) => o.res_id === params[0])
      .sort((x, y) => x.created_at.getTime() - y.created_at.getTime());
    return mine[0] ? [{ id: mine[0].id }] : [];
  }
  if (/^insert into "Outlets"/i.test(q)) {
    const [id, username, name, add, ph, hours, resId] =
      params as [string, string, string, string | null, string | null, string | null, string];
    const row: OutletRow = {
      id, created_at: now(), res_id: resId, oultet_username: username, outlet_name: name,
      outlet_add: add, outlet_main_ph: ph, outlet_working_hours: hours,
    };
    store.outlets.push(row);
    journal(() => { store.outlets = store.outlets.filter((x) => x !== row); });
    return [];
  }
  if (/^update "Outlets" set/i.test(q)) {
    const [id, name, add, ph, hours] = params as [string, string, string | null, string | null, string | null];
    const o = store.outlets.find((x) => x.id === id);
    if (!o) { return []; }
    const before = { ...o };
    journal(() => { Object.assign(o, before); });
    o.outlet_name = name; o.outlet_add = add; o.outlet_main_ph = ph; o.outlet_working_hours = hours;
    return [];
  }

  // --- "Login" / "Employees" ----------------------------------------------
  if (/^select emp_id from "Login"/i.test(q)) {
    const [resId, outletId, username] = params as [string, string, string];
    const l = store.logins.find(
      (x) => x.res_id === resId && x.outlet_id === outletId
        && x.emp_username.toLowerCase() === username.toLowerCase(),
    );
    return l ? [{ emp_id: l.emp_id }] : [];
  }
  if (/^insert into "Employees"/i.test(q)) {
    const [id, fname, email, ph, add, roles, resId, outletId, lname] =
      params as [string, string, string | null, string | null, string | null, string, string, string, string | null];
    const row: EmployeeRow = {
      id, created_at: now(), res_id: resId, outlet_id: outletId,
      emp_Fname: fname, emp_Lname: lname, emp_email: email, emp_ph: ph, emp_add: add,
      emp_roles: JSON.parse(roles) as { primary: string; all: string[] },
    };
    store.employees.push(row);
    journal(() => { store.employees = store.employees.filter((x) => x !== row); });
    return [];
  }
  if (/^insert into "Login"/i.test(q)) {
    if (store.failLoginInsert) { throw new Error("login insert failed"); }
    const [empId, resId, outletId, username, pass] = params as [string, string, string, string, string];
    const row: LoginRow = { emp_id: empId, created_at: now(), res_id: resId, outlet_id: outletId, emp_username: username, emp_pass: pass };
    store.logins.push(row);
    journal(() => { store.logins = store.logins.filter((x) => x !== row); });
    return [];
  }
  if (/^update "Employees" set/i.test(q)) {
    const [id, resId, outletId, fname, lname, roles, email, ph, add] =
      params as [string, string, string, string, string | null, string, string | null, string | null, string | null];
    const e = store.employees.find((x) => x.id === id && x.res_id === resId && x.outlet_id === outletId);
    if (!e) { return []; }
    const before = { ...e };
    journal(() => { Object.assign(e, before); });
    e.emp_Fname = fname; e.emp_Lname = lname; e.emp_email = email; e.emp_ph = ph; e.emp_add = add;
    e.emp_roles = JSON.parse(roles) as { primary: string; all: string[] };
    return [];
  }
  if (/^update "Login" set emp_pass/i.test(q)) {
    const [resId, outletId, username, pass] = params as [string, string, string, string];
    const l = store.logins.find(
      (x) => x.res_id === resId && x.outlet_id === outletId
        && x.emp_username.toLowerCase() === username.toLowerCase(),
    );
    if (!l) { return []; }
    const before = { ...l };
    journal(() => { Object.assign(l, before); });
    l.emp_pass = pass;
    return [];
  }
  // AuthenticateRestaurantEmployee's credential read.
  if (/from "Login" l/i.test(q) && /join "Employees" e/i.test(q)) {
    const [resId, outletId, username] = params as [string, string, string];
    const l = store.logins.find(
      (x) => x.res_id === resId && x.outlet_id === outletId
        && x.emp_username.toLowerCase() === username.toLowerCase(),
    );
    if (!l) { return []; }
    const e = store.employees.find((x) => x.id === l.emp_id);
    if (!e) { return []; }
    return [{
      emp_id: e.id,
      emp_username: l.emp_username,
      emp_pass: l.emp_pass,
      emp_fname: e.emp_Fname,
      emp_lname: e.emp_Lname,
      role_primary: e.emp_roles.primary,
      emp_roles: e.emp_roles,
      res_id: e.res_id,
      outlet_id: e.outlet_id,
    }];
  }

  // --- "Bills": counted, never written ------------------------------------
  if (/^select count\(\*\)::int as n from "Bills"/i.test(q)) {
    requireShape(q, "closed_at is null",
      "an open bill is one that has not been settled; counting settled bills too would put a scary number in front of the operator on every archive");
    if (store.failBillsCount) { throw new Error("tenant pool unreachable"); }
    const n = store.bills.filter((b) => b.res_id === params[0] && b.status !== 3 && b.closed_at === null).length;
    return [{ n }];
  }

  // --- platform.plans ------------------------------------------------------
  // Create's plan_id pre-check. It runs BEFORE the seed so an unknown plan cannot
  // leave a committed tenant behind whose one-time password was thrown away.
  if (/^select id from platform\.plans where id = \$1/i.test(q)) {
    const id = String(params[0] ?? "");
    // A plan_id that is not a uuid at all: Postgres raises 22P02 here, and the
    // route treats that as "unknown plan", not as an outage.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw Object.assign(new Error(`invalid input syntax for type uuid: "${id}"`), { code: "22P02" });
    }
    const p = store.plans.find((x) => x.id === id);
    return p ? [{ id: p.id }] : [];
  }
  if (/^select id from platform\.plans where active = true/i.test(q)) {
    const p = [...store.plans].filter((x) => x.active)
      .sort((a, b) => a.price_cents - b.price_cents || a.created_at.getTime() - b.created_at.getTime());
    return p[0] ? [{ id: p[0].id }] : [];
  }

  // --- platform.subscriptions ---------------------------------------------
  if (/^select status, plan_id from platform\.subscriptions/i.test(q)) {
    const s = store.subscriptions.find((x) => x.res_id === params[0]);
    return s ? [{ status: s.status, plan_id: s.plan_id }] : [];
  }
  if (/^insert into platform\.subscriptions/i.test(q) && /values \(\$1, \$2, 'trial'/i.test(q)) {
    requireShape(q, "on conflict (res_id) do nothing",
      "starting a trial must never overwrite a subscription an operator already assigned");
    const [resId, planId, days] = params as [string, string | null, string];
    if (store.subscriptions.some((s) => s.res_id === resId)) { return []; }
    const ends = new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000);
    store.subscriptions.push({
      res_id: resId, plan_id: planId, status: "trial",
      trial_ends_at: ends, current_period_end: ends, pending_plan_id: null, updated_at: now(),
    });
    return [];
  }
  if (/^insert into platform\.subscriptions/i.test(q) && /values \(\$1, \$2, 'active', now\(\) \+ interval '1 month'/i.test(q)) {
    requireShape(q, "on conflict (res_id) do update",
      "assigning a plan to a tenant that already has a subscription must update it, not raise a unique violation");
    const [resId, planId] = params as [string, string];
    if (!store.plans.some((p) => p.id === planId)) {
      throw Object.assign(new Error("insert or update violates foreign key constraint"), { code: "23503" });
    }
    const existing = store.subscriptions.find((s) => s.res_id === resId);
    const periodEnd = addMonthsUtc(
      new Date(Math.max(Date.now(), existing?.current_period_end?.getTime() ?? Date.now())), 1,
    );
    if (existing) {
      existing.plan_id = planId; existing.status = "active";
      existing.current_period_end = periodEnd; existing.pending_plan_id = null; existing.updated_at = now();
    } else {
      store.subscriptions.push({
        res_id: resId, plan_id: planId, status: "active", trial_ends_at: null,
        current_period_end: periodEnd, pending_plan_id: null, updated_at: now(),
      });
    }
    return [];
  }
  if (/^update platform\.subscriptions set status = 'cancelled'/i.test(q)) {
    requireShape(q, "status <> 'cancelled'",
      "archive's cancel is re-asserted on a retry; without this predicate the statement cannot report whether it actually caught a subscription that had been moved back off 'cancelled'");
    // The SECOND of archive's three writes. Breaking it is how the atomicity test
    // reproduces the production failure the transaction exists to prevent.
    if (store.failSubscriptionCancel) { throw new Error("subscription cancel failed"); }
    const s = store.subscriptions.find((x) => x.res_id === params[0]);
    if (!s || s.status === "cancelled") { return []; }
    const before = { ...s };
    journal(() => { Object.assign(s, before); });
    s.status = "cancelled"; s.updated_at = now();
    return /returning/i.test(q) ? [{ res_id: s.res_id }] : [];
  }
  if (/^update platform\.subscriptions set status = \$2/i.test(q)) {
    requireShape(q, "and status = 'cancelled'",
      "restore may only roll back the status ARCHIVE set; without this it would clobber a plan the operator re-assigned meanwhile");
    const [resId, status] = params as [string, string];
    const s = store.subscriptions.find((x) => x.res_id === resId && x.status === "cancelled");
    if (!s) { return []; }
    const before = { ...s };
    journal(() => { Object.assign(s, before); });
    s.status = status; s.updated_at = now();
    return [{ status: s.status }];
  }
  // Restore reads the LIVE status back after its rollback, to tell the operator
  // when a tenant is un-archived but still locked out by its subscription.
  if (/^select status from platform\.subscriptions/i.test(q)) {
    const s = store.subscriptions.find((x) => x.res_id === params[0]);
    return s ? [{ status: s.status }] : [];
  }
  if (/^update platform\.subscriptions set status = 'past_due'/i.test(q)) {
    const s = store.subscriptions.find((x) => x.res_id === params[0] && x.status === "active");
    if (!s) { return []; }
    s.status = "past_due"; s.updated_at = now();
    return [];
  }
  if (/^update platform\.subscriptions set status = 'suspended'/i.test(q)) {
    const graceDays = Number(params[0] ?? 7);
    const cutoff = Date.now() - graceDays * 24 * 60 * 60 * 1000;
    const hit = store.subscriptions.filter(
      (s) => s.status === "past_due" && s.current_period_end !== null && s.current_period_end.getTime() < cutoff,
    );
    for (const s of hit) { s.status = "suspended"; s.updated_at = now(); }
    return hit.map((s) => ({ res_id: s.res_id }));
  }
  if (/^update platform\.subscriptions set current_period_end = \$2/i.test(q)) {
    const [resId, next] = params as [string, string];
    const s = store.subscriptions.find((x) => x.res_id === resId && x.status === "active");
    if (!s) { return []; }
    s.current_period_end = new Date(next); s.updated_at = now();
    return [];
  }
  if (/^update platform\.subscriptions set plan_id = pending_plan_id/i.test(q)) {
    const hit = store.subscriptions.filter(
      (s) => s.pending_plan_id !== null && (s.current_period_end === null || s.current_period_end.getTime() < Date.now()),
    );
    for (const s of hit) { s.plan_id = s.pending_plan_id; s.pending_plan_id = null; s.updated_at = now(); }
    return hit.map((s) => ({ res_id: s.res_id }));
  }
  // runBillingCycle's two selection queries. The predicate under test is
  // `s.status = 'active'` — an archived tenant is 'cancelled' and must not appear.
  if (/from platform\.subscriptions s/i.test(q) && /platform\.plans p/i.test(q)) {
    requireShape(q, "s.status = 'active'",
      "the billing cycle must charge only ACTIVE subscriptions; widening this would invoice cancelled (archived) tenants");
    const priced = /coalesce\(p\.price_cents, 0\) > 0/i.test(q);
    return store.subscriptions
      .filter((s) => {
        if (s.status !== "active") { return false; }
        if (s.current_period_end === null || s.current_period_end.getTime() >= Date.now()) { return false; }
        const price = store.plans.find((p) => p.id === s.plan_id)?.price_cents ?? 0;
        if (priced) { return s.plan_id !== null && price > 0; }
        return price === 0;
      })
      .map((s) => ({
        res_id: s.res_id,
        plan_id: s.plan_id,
        current_period_end: s.current_period_end?.toISOString() ?? null,
        price_cents: store.plans.find((p) => p.id === s.plan_id)?.price_cents ?? 0,
      }));
  }

  // --- platform.invoices ---------------------------------------------------
  if (/^insert into platform\.invoices/i.test(q)) {
    requireShape(q, "on conflict (res_id, period_end) where period_end is not null",
      "Postgres cannot infer the PARTIAL invoices_res_period_uniq index unless ON CONFLICT repeats its predicate; omitting it raised 42P10 on every run");
    const [resId, planId, amount, periodStart, periodEnd, note] =
      params as [string, string | null, number, string, string, string];
    if (store.invoices.some((i) => i.res_id === resId && i.period_end === periodEnd)) { return []; }
    const row: InvoiceRow = {
      id: `inv-${String(store.nextId++)}`,
      res_id: resId, plan_id: planId, amount_cents: amount, status: "pending",
      period_start: periodStart, period_end: periodEnd, note, created_at: now(),
    };
    store.invoices.push(row);
    return [{ id: row.id }];
  }

  // --- Queue pre-order menu (readQueueMenuRow) -----------------------------
  // The rule a queuing walk-in's menu is filtered by, plus the master on/off.
  // Null config = every existing tenant = the whole menu.
  if (/^select queue_menu_config, queue_show_menu from "Restaurant"/i.test(q)) {
    const r = store.restaurants.find((x) => x.id === params[0]);
    return r ? [{ queue_menu_config: r.queue_menu_config, queue_show_menu: r.queue_show_menu }] : [];
  }

  // GetPublicBranding — the queue page's colours, currency and display name.
  // Matched on the leading columns so a new branding column added elsewhere does
  // not silently turn every queue-menu test into "unhandled query".
  if (/^select logo, theme_color, currency, payment_config/i.test(q) && /from "Restaurant"/i.test(q)) {
    const r = store.restaurants.find((x) => x.id === params[0]);
    if (!r) { return []; }
    return [{
      logo: r.logo, theme_color: null, currency: null, payment_config: null, feedback_config: null,
      res_name: r.res_name, bill_logo_svg: null, queue_show_menu: r.queue_show_menu,
      timezone: r.timezone, require_table_otp: null, brand_config: null, menu_badges: r.menu_badges,
    }];
  }

  // --- Menu categories (ensureMenuCategoryIds) -----------------------------
  // UpsertMenuItem cannot write a "Menu" row until the category name resolves to
  // a main/sub id pair, so the real upsert is only drivable with these modelled.
  const catLookup = (resId: string, outletId: string | null, name: string, mainCatId: string | null): MenuCategoryRow | undefined =>
    store.menuCats.find((c) => c.res_id === resId && c.outlet_id === outletId
      && c.name.toLowerCase() === String(name).toLowerCase() && c.main_cat_id === mainCatId);

  if (/^select id\s+from "Menue_main_cat"/i.test(q.trim())) {
    const [resId, outletId, name] = params as [string, string | null, string];
    const hit = catLookup(resId, outletId, name, null);
    return hit ? [{ id: hit.id }] : [];
  }
  if (/^select id\s+from "Menue_sub_cat"/i.test(q.trim())) {
    const [resId, outletId, mainId, name] = params as [string, string | null, string, string];
    const hit = catLookup(resId, outletId, name, mainId);
    return hit ? [{ id: hit.id }] : [];
  }
  if (/^insert into "Menue_main_cat"/i.test(q.trim())) {
    const [id, resId, outletId, name] = params as [string, string, string | null, string];
    const row: MenuCategoryRow = { id, res_id: resId, outlet_id: outletId, name, main_cat_id: null };
    store.menuCats.push(row);
    journal(() => { store.menuCats = store.menuCats.filter((x) => x !== row); });
    return [];
  }
  if (/^insert into "Menue_sub_cat"/i.test(q.trim())) {
    const [id, resId, outletId, name, , mainId] = params as [string, string, string | null, string, string, string];
    const row: MenuCategoryRow = { id, res_id: resId, outlet_id: outletId, name, main_cat_id: mainId };
    store.menuCats.push(row);
    journal(() => { store.menuCats = store.menuCats.filter((x) => x !== row); });
    return [];
  }

  // --- The real menu upsert (UpsertMenuItem / SaveMenuItems) ---------------
  // Modelled because "an unrelated item save must not strip X" is a claim about
  // THIS statement's merge, and the 56-item wipe is what happens when it is
  // wrong. GetMenuItemUndoState's read and the id-less name lookup share the
  // shape, so all three arms live together.
  if (/^select id, name, description from "Menu" where id = \$1 and res_id = \$2 and outlet_id = \$3/i.test(q)) {
    const [id, resId, outletId] = params as [string, string, string | null];
    const m = store.menuRows.find((x) => x.id === id && x.res_id === resId && x.outlet_id === outletId);
    return m ? [{ id: m.id, name: m.name, description: m.description }] : [];
  }
  if (/^select description from "Menu" where id = \$1 and res_id = \$2 and outlet_id = \$3/i.test(q)) {
    const [id, resId, outletId] = params as [string, string, string | null];
    const m = store.menuRows.find((x) => x.id === id && x.res_id === resId && x.outlet_id === outletId);
    return m ? [{ description: m.description }] : [];
  }
  if (/^select id from "Menu"\s+where res_id = \$1 and outlet_id = \$2 and lower\(name\) = lower\(\$3\)/i.test(q.trim())) {
    const [resId, outletId, name, mainId] = params as [string, string | null, string, string];
    const m = store.menuRows.find((x) => x.res_id === resId && x.outlet_id === outletId
      && x.name.toLowerCase() === String(name).toLowerCase()
      && x.main_category === (store.menuCats.find((c) => c.id === mainId)?.name ?? null));
    return m ? [{ id: m.id }] : [];
  }
  if (/^insert into "Menu"/i.test(q.trim()) && /on conflict \(id, res_id, outlet_id\)/i.test(q)) {
    const [id, resId, outletId, name, description, mainId, subId] =
      params as [string, string, string | null, string, string, string, string];
    const mainName = store.menuCats.find((c) => c.id === mainId)?.name ?? null;
    const subName = store.menuCats.find((c) => c.id === subId)?.name ?? null;
    const existing = store.menuRows.find((x) => x.id === id && x.res_id === resId && x.outlet_id === outletId);
    if (existing) {
      const before = { ...existing };
      journal(() => { Object.assign(existing, before); });
      existing.name = name;
      existing.description = description;
      existing.main_category = mainName;
      existing.sub_category = subName;
      return [];
    }
    const row: MenuRow = {
      id, created_at: now(), res_id: resId, outlet_id: outletId, name, description,
      sub_category: subName, main_category: mainName,
    };
    store.menuRows.push(row);
    journal(() => { store.menuRows = store.menuRows.filter((x) => x !== row); });
    return [];
  }

  // --- Configurable menu badges (menu_badges.ts) ---------------------------
  // The CATALOGUE is one jsonb column on "Restaurant"; the tags live inside each
  // item's description blob, so the tag reads/writes below are just "Menu" rows.
  if (/^select menu_badges from "Restaurant"/i.test(q)) {
    const r = store.restaurants.find((x) => x.id === params[0]);
    return r ? [{ menu_badges: r.menu_badges }] : [];
  }
  if (/^update "Restaurant" set menu_badges/i.test(q)) {
    const r = store.restaurants.find((x) => x.id === params[0]);
    if (!r) { return []; }
    const before = { ...r };
    journal(() => { Object.assign(r, before); });
    // jsonb: the caller stringifies, Postgres hands back a parsed value.
    r.menu_badges = JSON.parse(String(params[1]));
    return [];
  }
  // countMenuBadgeTags + releaseMenuBadgeTags read restaurant-WIDE (no outlet
  // predicate) because the catalogue is restaurant-wide. Matching on the absence
  // of `outlet_id` here is what keeps that property under test: adding an outlet
  // filter to the production query would fall through to "unhandled".
  if (/^select description from "Menu" where res_id = \$1$/i.test(q.trim())) {
    return store.menuRows.filter((m) => m.res_id === params[0]).map((m) => ({ description: m.description }));
  }
  if (/^select id, res_id, outlet_id, description from "Menu" where res_id = \$1$/i.test(q.trim())) {
    return store.menuRows
      .filter((m) => m.res_id === params[0])
      .map((m) => ({ id: m.id, res_id: m.res_id, outlet_id: m.outlet_id, description: m.description }));
  }
  // SetMenuItemBadges' targeted read. `= any($3::uuid[])` in production, so a
  // non-uuid id would abort the whole statement — SetMenuItemBadges filters
  // those out before this is ever reached.
  if (/^select id, description from "Menu" where res_id = \$1 and outlet_id = \$2 and id = any/i.test(q)) {
    const [resId, outletId, ids] = params as [string, string | null, string[]];
    return store.menuRows
      .filter((m) => m.res_id === resId && m.outlet_id === outletId && ids.includes(m.id))
      .map((m) => ({ id: m.id, description: m.description }));
  }
  // The description-only update shared by RenameMenuStation, SetMenuItemBadges
  // and releaseMenuBadgeTags. Writing ONLY this column is the whole point: it is
  // what makes a tag edit incapable of touching an image, a recipe or a price.
  if (/^update "Menu" set description = \$4 where id = \$1 and res_id = \$2 and outlet_id/i.test(q)) {
    const [id, resId, outletId, description] = params as [string, string, string | null, string];
    // `= $3` and `is not distinct from $3` agree for every value the fixture
    // stores (outlet_id is never SQL NULL on a seeded row), so one comparison
    // serves both statement shapes.
    const m = store.menuRows.find((x) => x.id === id && x.res_id === resId && x.outlet_id === outletId);
    if (!m) { return []; }
    const before = m.description;
    journal(() => { m.description = before; });
    m.description = description;
    return [];
  }
  // GetMenuCategories — the guest menu payload's category list.
  if (/^select distinct name as category_name/i.test(q.trim()) && /from "Menue_sub_cat"/i.test(q)) {
    const [resId, outletId] = params as [string, string | null];
    const names = Array.from(new Set(store.menuRows
      .filter((m) => m.res_id === resId && m.outlet_id === outletId && m.sub_category)
      .map((m) => m.sub_category as string)));
    return names.sort().map((category_name) => ({ category_name }));
  }

  // --- "Menu" (GetMenuItems — repriceFromMenu's pricing authority) ---------
  if (/^select m\.id, m\.name, m\.description/i.test(q) && /from "Menu" m/i.test(q)) {
    if (store.failMenuRead) {
      // The production failure this models: statement timeout / pool exhaustion
      // at read time. A pg-style coded error, so safeClientError masks it.
      throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014", severity: "ERROR" });
    }
    const [resId, outletId] = params as [string, string | null];
    return store.menuRows
      .filter((m) => m.res_id === resId && m.outlet_id === outletId)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .map((m) => ({ id: m.id, name: m.name, description: m.description, sub_category: m.sub_category, main_category: m.main_category }));
  }

  // --- GetPublicBranding ---------------------------------------------------
  // The single-row branding read behind the guest menu payload. Everything the
  // fixture does not model comes back null, which is exactly the state of a
  // tenant that never customised anything — and therefore the state under which
  // "a restaurant with no posters gets today's payload" has to hold.
  if (/^\s*select logo, theme_color, currency/i.test(q) && /from "Restaurant" where id = \$1/i.test(q)) {
    const r = store.restaurants.find((x) => x.id === params[0]);
    if (!r) { return []; }
    return [{
      logo: r.logo,
      theme_color: null,
      currency: null,
      payment_config: null,
      feedback_config: null,
      res_name: r.res_name,
      bill_logo_svg: null,
      queue_show_menu: r.queue_show_menu,
      timezone: r.timezone,
      require_table_otp: null,
      brand_config: null,
      menu_badges: null,
      queue_menu_config: r.queue_menu_config ?? null,
    }];
  }

  // --- GetRestaurantProfile ------------------------------------------------
  if (/^\s*select\s+outlet_name,\s+outlet_add/i.test(q) && /from "Outlets"/i.test(q)) {
    const o = store.outlets.find((x) => x.id === params[0] && x.res_id === params[1]);
    return o
      ? [{ outlet_name: o.outlet_name, outlet_add: o.outlet_add, outlet_phone: o.outlet_main_ph, outlet_hours: o.outlet_working_hours }]
      : [];
  }
  // selectProfileEmployee's no-employeeId branch (admin first, then oldest).
  if (/^\s*select\s+e\.id,\s+e\.emp_email as email/i.test(q) && /from "Employees" e/i.test(q)) {
    const [resId, outletId] = params as [string, string];
    const mine = store.employees
      .filter((e) => e.res_id === resId && e.outlet_id === outletId)
      .sort((a, b) =>
        (a.emp_roles.primary.toLowerCase() === "admin" ? 0 : 1) - (b.emp_roles.primary.toLowerCase() === "admin" ? 0 : 1)
        || a.created_at.getTime() - b.created_at.getTime());
    const e = mine[0];
    return e ? [{ id: e.id, email: e.emp_email, phone: e.emp_ph, address: e.emp_add }] : [];
  }

  // --- "Menue_sub_cat" (GetMenuCategories) ---------------------------------
  // The category list the guest menu payload carries. Derived from the menu rows
  // rather than stored separately, so a fixture menu and its categories cannot
  // disagree.
  if (/^\s*select distinct name as category_name/i.test(q) && /from "Menue_sub_cat"/i.test(q)) {
    const [resId, outletId] = params as [string, string | null];
    const names = new Set(
      store.menuRows
        .filter((m) => m.res_id === resId && m.outlet_id === outletId && m.sub_category)
        .map((m) => String(m.sub_category)),
    );
    return [...names].sort().map((category_name) => ({ category_name }));
  }

  // --- "Posters" (migration 031) -------------------------------------------
  // Guest read (GetVisiblePosters, `and active`) and editor read (ListPosters)
  // share one shape. The date bounds come back as the YYYY-MM-DD strings
  // to_char() produces — modelling them as Date objects here would hide the very
  // timezone round-trip the poster schedule exists to avoid.
  if (/from "Posters"/i.test(q) && /^\s*select/i.test(q) && !/count\(\*\)/i.test(q)) {
    const [resId, outletId] = params as [string, string | null];
    const activeOnly = /and active\b/i.test(q);
    return store.posters
      .filter((p) => p.res_id === resId && (p.outlet_id === null || p.outlet_id === outletId))
      .filter((p) => !activeOnly || p.active)
      .sort((a, b) =>
        a.sort_order - b.sort_order
        || a.created_at.getTime() - b.created_at.getTime()
        || a.id.localeCompare(b.id))
      .map((p) => ({
        id: p.id,
        image_url: p.image_url,
        title: p.title,
        placement: p.placement,
        sort_order: p.sort_order,
        start_on: p.start_on,
        end_on: p.end_on,
        active: p.active,
        width: p.width,
        height: p.height,
        created_at: p.created_at,
      }));
  }
  if (/^\s*select count\(\*\)::int as n from "Posters"/i.test(q)) {
    const [resId, outletId] = params as [string, string | null];
    return [{ n: store.posters.filter((p) => p.res_id === resId && (p.outlet_id === null || p.outlet_id === outletId)).length }];
  }

  // --- "Waitlist" ----------------------------------------------------------
  // Lazy DDL (ensureWaitlistTable / applyTenantRls): the real database has
  // already applied these; modelled as no-ops so the flow is drivable.
  if (/^create table if not exists "Waitlist"/i.test(q)) { return []; }
  if (/^create (unique )?index if not exists waitlist_/i.test(q)) { return []; }
  if (/^select column_name from information_schema\.columns where table_schema = 'public' and table_name = 'Waitlist'/i.test(q)) { return [{ column_name: 'party_members' }]; }
  if (/^alter table "Waitlist" add column/i.test(q)) { return []; }
  if (/^do \$\$ declare predicate text/i.test(q)) { return []; }

  // GetWaitlistEntryByToken — the guest queue page's poll.
  if (/^select w\.\*, t\.table_name from "Waitlist" w left join "Tables" t on t\.id = w\.table_id where w\.token = \$1/i.test(q)) {
    const [token, resId] = params as [string, string];
    const w = store.waitlists.find((x) => x.token === token && x.res_id === resId);
    return w ? [{ ...w }] : [];
  }
  // waitlistPosition
  if (/^select count\(\*\)::int as n from "Waitlist"/i.test(q)) {
    const [resId, outletId, createdAt] = params as [string, string | null, string | Date];
    const t0 = new Date(createdAt as string).getTime();
    const n = store.waitlists.filter(
      (x) => x.res_id === resId && x.outlet_id === outletId && x.status === "waiting" && x.created_at.getTime() < t0,
    ).length;
    return [{ n }];
  }
  // SetWaitlistPreorder — the ONLY statement that persists a guest's staged picks.
  if (/^update "Waitlist" set pre_order = \$1::jsonb/i.test(q)) {
    requireShape(q, "status in ('waiting','called')",
      "a pre-order may only be staged while the party is still active in the queue; without the predicate a cancelled/seated entry could be rewritten");
    const [preJson, token, resId] = params as [string, string, string];
    const w = store.waitlists.find((x) => x.token === token && x.res_id === resId && (x.status === "waiting" || x.status === "called"));
    if (!w) { return []; }
    const before = w.pre_order;
    journal(() => { w.pre_order = before; });
    w.pre_order = String(preJson);
    return [{ id: w.id }];
  }
  // loadWaitlistForPreorder — staff (id) and guest (token) forms share the shape.
  if (/^select w\.id, w\.name, w\.pre_order, w\.pre_order_status, w\.placed_order_id, t\.table_name from "Waitlist" w/i.test(q)) {
    const [key, resId] = params as [string, string];
    const w = store.waitlists.find((x) => (x.id === key || x.token === key) && x.res_id === resId);
    return w
      ? [{ id: w.id, name: w.name, pre_order: w.pre_order, pre_order_status: w.pre_order_status, placed_order_id: w.placed_order_id, table_name: w.table_name }]
      : [];
  }
  // pre_order_status transitions (pending/confirmed/declined/claimed/none).
  const preStatus = /^update "Waitlist" set pre_order_status = '([a-z]+)'(, placed_order_id = \$3)? where id = \$1 and res_id = \$2$/i.exec(q);
  if (preStatus) {
    const [id, resId, placedId] = params as [string, string, string | undefined];
    const w = store.waitlists.find((x) => x.id === id && x.res_id === resId);
    if (!w) { return []; }
    const before = { status: w.pre_order_status, placed: w.placed_order_id };
    journal(() => { w.pre_order_status = before.status; w.placed_order_id = before.placed; });
    w.pre_order_status = preStatus[1]!;
    if (preStatus[2]) { w.placed_order_id = placedId ?? null; }
    return [];
  }

  throw new Error(`platform fixture: unhandled query\n  ${q.slice(0, 300)}`);
}

// ---------------------------------------------------------------------------
// A fake Express app — routes are registered exactly as index.ts registers them
// ---------------------------------------------------------------------------
//
// registerPlatformRoutes takes the app itself (it is not a Router), so the only
// way to reach a handler is to let it register onto something. This collector is
// that something: it records (method, path, [...guards, handler]) in registration
// order and replays the chain, so requirePlatformAuth and rateLimit run for real
// on every call rather than being stubbed out.

type Handler = (req: unknown, res: unknown, next: () => unknown) => unknown;

export interface RouteCall {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export interface FakeApp {
  app: unknown;
  /** Live view of what has been registered, in registration order. A function
   *  rather than an array because callers hold the harness from beforeAll, and a
   *  snapshot taken at construction time is always empty. */
  routes: () => { method: string; path: string }[];
  call: (method: string, path: string, opts?: {
    token?: string;
    params?: Record<string, string>;
    body?: unknown;
    query?: Record<string, string>;
    ip?: string;
    /**
     * A resolved tenant session, as requireAuth would have left it on the
     * request. Needed because requireAuth is mounted with app.use(), which this
     * collector deliberately ignores (it records ROUTES, and a global gate is
     * not one) — so without this, every validateAction-gated route answers 403
     * and its handler is untestable. Supplying it drives the REAL guard: pass
     * actions that do not contain the route's permission and the 403 is genuine.
     */
    auth?: { res_id: string; outlet_id: string; employeeId: string; role: string; actions: string[] };
  }) => Promise<RouteCall>;
}

export function makeFakeApp(): FakeApp {
  const registered: { method: string; path: string; handlers: Handler[] }[] = [];
  const record = (method: string) => (path: string, ...handlers: Handler[]): unknown => {
    registered.push({ method, path, handlers });
    return app;
  };
  const app = {
    get: record("GET"), post: record("POST"), put: record("PUT"),
    patch: record("PATCH"), delete: record("DELETE"), use: () => app,
  };

  async function call(method: string, path: string, opts: {
    token?: string;
    params?: Record<string, string>;
    body?: unknown;
    query?: Record<string, string>;
    ip?: string;
    auth?: { res_id: string; outlet_id: string; employeeId: string; role: string; actions: string[] };
  } = {}): Promise<RouteCall> {
    const route = registered.find((r) => r.method === method && r.path === path);
    if (!route) { throw new Error(`platform fixture: no route registered for ${method} ${path}`); }

    const out: RouteCall = { status: 200, body: undefined, headers: {} };
    let ended = false;
    const res = {
      status(code: number) { out.status = code; return res; },
      json(payload: unknown) { if (!ended) { out.body = payload; ended = true; } return res; },
      send(payload: unknown) { if (!ended) { out.body = payload; ended = true; } return res; },
      setHeader(k: string, v: string) { out.headers[k] = String(v); return res; },
      end() { ended = true; return res; },
    };
    const req = {
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
      params: opts.params ?? {},
      body: opts.body ?? {},
      query: opts.query ?? {},
      ip: opts.ip ?? "203.0.113.7",
      socket: { remoteAddress: opts.ip ?? "203.0.113.7" },
      // Left undefined unless a test supplies one, so an unauthenticated call to
      // a gated route still fails the way it does in production.
      ...(opts.auth ? { auth: opts.auth } : {}),
    };

    // Express middleware calls next() WITHOUT awaiting it, so the promise a guard
    // returns settles before the handler it delegated to has finished. Worse,
    // rateLimit (routes/_shared.ts:522) is a SYNCHRONOUS function that kicks off a
    // detached `void (async () => …)()` and calls next() from inside it — so the
    // real handler starts one or more event-loop turns AFTER the guard returned.
    //
    // Awaiting only the promises that exist when the chain first unwinds
    // therefore returns before the handler has run at all, and the response reads
    // as an empty 200. Every promise next() creates is queued, and the queue is
    // drained across event-loop turns until the response is actually written.
    const pending: Promise<unknown>[] = [];
    let i = 0;
    let k = 0;
    const step = async (): Promise<void> => {
      const h = route.handlers[i++];
      if (!h) { return; }
      await h(req, res, next);
    };
    const next = (): Promise<void> => { const p = step(); pending.push(p); return p; };
    const drain = async (): Promise<void> => { while (k < pending.length) { await pending[k++]; } };

    pending.push(step());
    await drain();
    for (let turn = 0; turn < 200 && !ended; turn++) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      await drain();
    }

    return out;
  }

  return { app, routes: () => registered.map((r) => ({ method: r.method, path: r.path })), call };
}
