// In-memory tenant + a fake `pg` Pool, so the REAL MIS report readers in
// database_supabase.ts (the fifteen of them, plus the drill-downs) can be
// exercised as unit tests.
//
// THE SIX CAPTURE TABLES (migrations 034-039) ARE MODELLED HERE TOO — comps,
// service-charge waivers, tenders and their tips, billing counters, cash
// sessions, menu groups and variations. They are modelled as ROWS, not as
// answers: the bill a comp is attributed to, the group a line rolls up into and
// the counter a bill was rung on are all re-derived here by the same rule the
// reader states, so a reader that changed its rule fails instead of agreeing
// with itself.
//
// WHY A FIXTURE RATHER THAN PURE FUNCTIONS. The rules these tests exist to
// protect are not in any one function:
//   * the ladder's composition is split between closedBillCharges (module-private
//     to database_supabase.ts) and mis_report_math.ts;
//   * "cancelled is not sales" is a PREDICATE IN THE SQL;
//   * "both ends of the range are inclusive" is the +1 day inside windowInstants
//     turning into `< $4`;
//   * "covers once per seating" is a dedupe over a lateral join's session id;
//   * tenant isolation is `res_id = $1` being present AND bound.
// A test that re-implemented any of those in TypeScript would assert only that
// the copy agrees with itself. Driving the shipped readers over a stubbed Pool
// tests the real code, needs no database, and so can never be "skipped because a
// database wasn't reachable". Same posture as bill_fixtures.ts.
//
// THE FIXTURE ENFORCES THE PREDICATES IT MODELS, rather than assuming them:
//   * every row is filtered on the res_id the query BOUND ($1), so a reader that
//     lost its tenant predicate returns another tenant's money and the isolation
//     test fails;
//   * the outlet scope is read out of the SQL TEXT — `(true or …)` is the
//     ALL-OUTLETS aggregate read, `(false or …)` pins to $2 — which is exactly
//     what isAllOutlets() inlines, so an accidental `true` fails loudly;
//   * the window is applied half-open on [$3, $4), the shape the readers bind;
//   * requireShape() asserts the load-bearing fragments are still in the query.
//     Deleting `coalesce(o.status::text, '1') <> '5'` from the item read would
//     otherwise leave this suite green while cancelled food became revenue.
//
// WHAT IT DOES NOT MODEL, said plainly because a vague promise is worse than
// none: SQL semantics. Dispatch matches on a marker in each query and THROWS on
// anything unrecognised, so a reader that starts issuing a new query fails here
// instead of silently receiving zero rows — but a reader that adds a COLUMN to a
// query the fixture already recognises will not fail; the column simply arrives
// undefined. Add it to the row builder by hand.

export const RES_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
export const OUTLET_A = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
export const OUTLET_B = "cccccccc-3333-4333-8333-cccccccccccc";
/** A DIFFERENT restaurant. Nothing it owns may ever appear in a RES_ID report. */
export const OTHER_RES_ID = "dddddddd-4444-4444-8444-dddddddddddd";
export const OTHER_OUTLET = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";

export interface FixtureTaxLine { name: string; percentage: number; amount: number }

export interface FixtureBill {
  id: string;
  bill_no: string;
  res_id?: string;
  outlet_id?: string;
  /** UTC instant the bill SETTLED. Stored as closed_at, the canonical stamp. */
  settled_at: string;
  /** null = never settled (still on the floor): no closed_at, no admin_approved_at. */
  settled?: boolean;
  /** "Bills".total_amt — the TAX-INCLUSIVE grand total. */
  total_amt: number;
  tax_breakdown: FixtureTaxLine[];
  /**
   * "Bills".round_off (migration 048) — what rounded total_amt to the rupee.
   * Absent = NULL, a bill settled before rounding existed.
   */
  round_off?: number | null;
  payment_method?: string | null;
  payment_splits?: { method: string; amount: number }[] | null;
  discount_type?: "percent" | "flat" | null;
  discount_value?: number;
  coupon_code?: string | null;
  reason?: string | null;
  refund_amount?: number;
  status?: number;
  table_name?: string | null;
  waiter_fname?: string | null;
  waiter_lname?: string | null;
  /** The SEATING. Two bills sharing one id are one party — the covers dedupe. */
  session_id?: string | null;
  covers?: number;
  /** The order the bill was raised from (its order_type and item count). */
  order_id?: string | null;
  /** Populated only for a discount that went through the approval threshold. */
  requested_by?: string | null;
  decided_by?: string | null;
  /** 038: the till that rang it. NULL — the default — means "this outlet's till". */
  counter_id?: string | null;
}

/** One order line, including the flags migrations 034 and 039 stamp on it. */
export interface FixtureOrderItem {
  name: string;
  quantity: number;
  price: number;
  note?: string | null;
  /** 034: served but not charged for. Strictly boolean true, as the writer writes it. */
  nc?: boolean;
  /** 039: the menu row the server stamped on the line. */
  menu_id?: string;
  variation_id?: string;
  variation_name?: string;
}

export interface FixtureOrder {
  id: string;
  res_id?: string;
  outlet_id?: string;
  table_name?: string | null;
  created_at: string;
  /** 5 = Cancelled (a void). 4/6/7 = settled. */
  status: number;
  order_type?: string;
  /** Who took it — "Orders".food.taken_by_employee_name. */
  taken_by?: string | null;
  items: FixtureOrderItem[];
}

export interface FixtureAudit {
  id: string;
  res_id?: string;
  outlet_id?: string;
  created_at: string;
  action_id: string;
  action_name: string;
  reason: string | null;
  details: Record<string, unknown> | null;
  fname?: string | null;
  lname?: string | null;
  username?: string | null;
}

export interface FixtureMenuVariation { id: string; name: string; price: number }

export interface FixtureMenuItem {
  name: string;
  category: string;
  /** Stable menu id. Defaults to `menu-<index>`, as the plain menu read reports. */
  id?: string;
  /** 039: the REVENUE group this dish resolves to. Undefined = in no group. */
  group?: string | null;
  variations?: FixtureMenuVariation[];
}

/** 034 — one comp. `value` is derived here exactly as the GENERATED column does. */
export interface FixtureNonChargeable {
  id: string;
  res_id?: string;
  outlet_id?: string;
  created_at: string;
  order_id: string;
  item_name: string;
  /** The table it was on, by NAME. Null for a takeaway order with no table. */
  table_name?: string | null;
  nc_kind: string;
  reason: string;
  quantity: number;
  /** The price the LINE was carrying — what the guest would otherwise have paid. */
  unit_price: number;
  /** "Menu".price when the comp was made. Null when the dish did not resolve. */
  menu_price_at_nc?: number | null;
  marked_by: string;
  authorised_by: string;
  reversed_at?: string | null;
  reversed_by?: string | null;
  reversal_reason?: string | null;
}

/** 036 — one service-charge waiver. grand_total_reduction is derived, as in SQL. */
export interface FixtureWaiver {
  id: string;
  res_id?: string;
  outlet_id?: string;
  waived_at: string;
  bill_id: string;
  table_name?: string | null;
  basis: "restaurant_percent" | "tax_line";
  basis_percent: number;
  basis_amount: number;
  amount_waived: number;
  tax_on_waived: number;
  waiver_kind: string;
  reason: string;
  waived_by: string;
  authorised_by: string;
  reversed_at?: string | null;
  reversed_by?: string | null;
  reversal_reason?: string | null;
}

/** 037 — one tender. `tip_amount` rides ON it and is never part of `amount`. */
export interface FixtureTender {
  id: string;
  res_id?: string;
  outlet_id?: string;
  bill_id: string;
  table_name?: string | null;
  seq: number;
  settled_at: string;
  method: string;
  amount: number;
  tip_amount?: number;
  tip_mode?: string | null;
  tip_credited_to?: string | null;
  settled_by?: string;
  voided_at?: string | null;
}

/**
 * 035 — ONE RECORDED VOID REASON, keyed to the order it explains.
 *
 * Deliberately SEPARATE from FixtureOrder.status, because the whole point of the
 * A2 change is that a cancelled order MAY have a reason and may not: the cancel
 * paths accept a cancellation without one (a shipped till that cannot send it
 * must still be able to cancel), and every order cancelled before migration 035
 * has no row by design. A fixture that attached a reason to every status-5 order
 * would quietly assert the opposite.
 */
export interface FixtureOrderVoid {
  res_id?: string;
  outlet_id?: string;
  order_id: string;
  scope?: "order" | "item";
  reason: string;
  void_kind: string;
  stage: string;
}

/** 038 — a till identity. */
export interface FixtureCounter {
  id: string;
  res_id?: string;
  outlet_id?: string;
  code: string;
  name: string;
  kind?: string;
  active?: boolean;
  sort_order?: number;
}

/** 038 — one drawer counted once. Keyed to a till, never to an outlet. */
export interface FixtureCashSession {
  res_id?: string;
  counter_id: string;
  opened_at: string;
  closed_at?: string | null;
  variance?: number;
}

export interface FixtureDb {
  res_id: string;
  slug: string;
  name: string;
  timezone: string;
  /** "Restaurant".service_charge — shape (a). Zero when the tenant instead lists
   *  "Service Charge" inside Outlets.default_tax (shape b), which is the seed. */
  service_charge_percent: number;
  outlets: { id: string; name: string; res_id?: string }[];
  bills: FixtureBill[];
  orders: FixtureOrder[];
  audits: FixtureAudit[];
  menu: FixtureMenuItem[];
  non_chargeables: FixtureNonChargeable[];
  waivers: FixtureWaiver[];
  tenders: FixtureTender[];
  counters: FixtureCounter[];
  cash_sessions: FixtureCashSession[];
  order_voids: FixtureOrderVoid[];
  /** "Restaurant".payment_config — null/absent is the built-in defaults. */
  payment_config?: unknown;
}

export function makeDb(over: Partial<FixtureDb> = {}): FixtureDb {
  return {
    res_id: RES_ID,
    slug: "zztest-mis",
    name: "ZZTEST MIS Fixture",
    timezone: "Asia/Kolkata",
    service_charge_percent: 0,
    outlets: [
      { id: OUTLET_A, name: "Main" },
      { id: OUTLET_B, name: "Annexe" },
      { id: OTHER_OUTLET, name: "Someone Else", res_id: OTHER_RES_ID },
    ],
    bills: [],
    orders: [],
    audits: [],
    menu: [],
    non_chargeables: [],
    waivers: [],
    tenders: [],
    counters: [],
    cash_sessions: [],
    order_voids: [],
    ...over,
  };
}

let db: FixtureDb | null = null;

/** Install the tenant the next reader call will see. */
export function useFixtureDb(next: FixtureDb): void { db = next; }

function requireDb(): FixtureDb {
  if (!db) {throw new Error("useFixtureDb() was not called before invoking a reader");}
  return db;
}

/**
 * Assert a load-bearing fragment is still in the query.
 *
 * Dispatch below re-implements each predicate, which means deleting the
 * predicate from the SQL would leave these tests green — the fixture would keep
 * enforcing a rule the reader no longer had. So the text is checked too. Losing
 * the cancelled-order exclusion, or the `< $4` that makes the range inclusive of
 * its last day, now fails loudly rather than silently changing the money.
 */
function requireShape(q: string, fragment: string, why: string): void {
  if (!q.toLowerCase().includes(fragment.toLowerCase())) {
    throw new Error(`mis fixture: query lost "${fragment}" — ${why}\n  ${q.slice(0, 260)}`);
  }
}

/**
 * The outlet scope, read out of the SQL exactly as isAllOutlets() inlines it.
 *
 * The table alias is OPTIONAL because a single-table read (the comps, the
 * variations, the counters) writes the bare column name. What is not optional is
 * the predicate itself: a report that dropped it spans outlets by accident, so
 * its absence stays a loud failure rather than a default.
 */
function allOutletsFrom(q: string): boolean {
  if (/\(\s*true\s+or\s+(?:\w+\.)?outlet_id\s*=\s*\$2\s*\)/i.test(q)) {return true;}
  if (/\(\s*false\s+or\s+(?:\w+\.)?outlet_id\s*=\s*\$2\s*\)/i.test(q)) {return false;}
  throw new Error(`mis fixture: no outlet predicate in query — a report that dropped it spans outlets by accident\n  ${q.slice(0, 260)}`);
}

const resOf = (r: { res_id?: string }): string => r.res_id ?? RES_ID;
const outletOf = (r: { outlet_id?: string }): string => r.outlet_id ?? OUTLET_A;
const isSettled = (b: FixtureBill): boolean => b.settled !== false;

/** Half-open [from, to) — the shape every reader binds as `>= $3 and < $4`. */
function inWindow(iso: string, fromIso: unknown, toIso: unknown): boolean {
  const t = new Date(iso).getTime();
  const a = typeof fromIso === "string" ? new Date(fromIso).getTime() : Number.NEGATIVE_INFINITY;
  const z = typeof toIso === "string" ? new Date(toIso).getTime() : Number.POSITIVE_INFINITY;
  return t >= a && t < z;
}

/** Tenant + outlet + window, applied the way the bound query says to apply them. */
function billsMatching(q: string, params: unknown[]): FixtureBill[] {
  const d = requireDb();
  const all = allOutletsFrom(q);
  const rid = String(params[0] ?? ""), oid = String(params[1] ?? "");
  return d.bills.filter((b) =>
    resOf(b) === rid
    && (all || outletOf(b) === oid)
    && isSettled(b)
    && inWindow(b.settled_at, params[2], params[3]));
}

function ordersMatching(q: string, params: unknown[]): FixtureOrder[] {
  const d = requireDb();
  const all = allOutletsFrom(q);
  const rid = String(params[0] ?? ""), oid = String(params[1] ?? "");
  return d.orders.filter((o) =>
    resOf(o) === rid
    && (all || outletOf(o) === oid)
    && inWindow(o.created_at, params[2], params[3]));
}

const like = (value: string | null | undefined, pattern: unknown): boolean => {
  if (typeof pattern !== "string") {return true;}
  return String(value ?? "").toLowerCase().includes(pattern.replace(/%/g, "").toLowerCase());
};

const r2 = (n: number): number => Number(n.toFixed(2));

/** The menu id a fixture item is known by — explicit, or its position. */
function menuIdOf(m: FixtureMenuItem, i: number): string {
  return m.id ?? `menu-${String(i)}`;
}

/** A group's synthetic id. Stable, so an attribution can be asserted by id. */
function groupIdOf(name: string): string {
  return `grp-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/**
 * The bill a comp is attributed to, re-derived by the READER's stated rule: the
 * first bill on the comp's table that settled at or after it (an open bill last,
 * which is what 'infinity' does in the SQL), or the bill raised from the order
 * when the comp has no table. Re-derived rather than stored on the fixture row
 * so a reader that changed the rule disagrees with this and fails.
 */
function billForNonChargeable(n: FixtureNonChargeable): FixtureBill | undefined {
  const d = requireDb();
  const at = new Date(n.created_at).getTime();
  const mine = d.bills.filter((b) => resOf(b) === resOf(n) && outletOf(b) === outletOf(n));
  if (n.table_name) {
    const candidates = mine.filter((b) =>
      b.table_name === n.table_name
      && (!isSettled(b) || new Date(b.settled_at).getTime() >= at));
    return [...candidates].sort((a, z) => {
      const sa = isSettled(a) ? new Date(a.settled_at).getTime() : Number.POSITIVE_INFINITY;
      const sz = isSettled(z) ? new Date(z.settled_at).getTime() : Number.POSITIVE_INFINITY;
      return sa - sz;
    })[0];
  }
  return mine.find((b) => b.order_id === n.order_id);
}

/** Tenant + outlet + window over any capture table, applied as the query binds it. */
function captureRowsMatching<T extends { res_id?: string; outlet_id?: string }>(
  q: string,
  params: unknown[],
  rows: readonly T[],
  at: (r: T) => string,
): T[] {
  const all = allOutletsFrom(q);
  const rid = String(params[0] ?? ""), oid = String(params[1] ?? "");
  return rows.filter((r) =>
    resOf(r) === rid
    && (all || outletOf(r) === oid)
    && inWindow(at(r), params[2], params[3]));
}

// --- row builders ------------------------------------------------------------

/**
 * The row shape fetchMisBills selects.
 *
 * `round_off` (migration 048) comes back ONLY when the query actually selects
 * it — the way Postgres would answer. A fixture that returned it regardless
 * would keep a reader green after its SELECT lost the column, and that reader
 * would then book every rounded bill's paise as food.
 */
function misBillRow(b: FixtureBill, q = "") {
  return {
    id: b.id,
    bill_no: b.bill_no,
    outlet_id: outletOf(b),
    settled_at: new Date(b.settled_at),
    total_amt: b.total_amt,
    tax_breakdown: b.tax_breakdown,
    ...(/\bb\.round_off\b/i.test(q) ? { round_off: b.round_off ?? null } : {}),
    payment_method: b.payment_method ?? null,
    payment_splits: b.payment_splits ?? null,
    discount_type: b.discount_type ?? null,
    discount_value: b.discount_value ?? 0,
    coupon_code: b.coupon_code ?? null,
    refund_amount: b.refund_amount ?? 0,
    session_id: b.session_id ?? null,
    session_covers: b.session_id ? (b.covers ?? 1) : null,
  };
}

function orderOf(b: FixtureBill): FixtureOrder | undefined {
  return requireDb().orders.find((o) => o.id === b.order_id);
}

/** The row shape GetOrderSummaryReport's page query selects. */
function orderSummaryRow(b: FixtureBill, q = "") {
  const o = orderOf(b);
  return {
    ...misBillRow(b, q),
    status: b.status ?? 7,
    table_name: b.table_name ?? null,
    emp_fname: b.waiter_fname ?? null,
    emp_lname: b.waiter_lname ?? null,
    order_type: o?.order_type ?? null,
    item_count: String(o?.items.length ?? 0),
  };
}

// --- the fake client ---------------------------------------------------------

// DDL and session statements the lazy ensure* helpers fire. No-ops: the fixture
// defines the schema, so there is nothing to provision.
const DDL = /^(alter|create|drop|do|grant|revoke|comment|begin|commit|rollback|set|truncate)\b/i;

export async function fixtureQuery(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
  const q = sql.replace(/\s+/g, " ").trim();
  return { rows: dispatch(q, params) };
}

function dispatch(q: string, params: unknown[]): unknown[] {
  if (DDL.test(q)) {return [];}
  if (/^select set_config\('app\.res_id'/i.test(q)) {return [];}

  const d = requireDb();

  // --- identity ---
  if (/from "Restaurant" r/i.test(q)) {
    const identity = {
      res_id: d.res_id,
      restaurant_slug: d.slug,
      restaurant_name: d.name,
      restaurant_main_office_add: null,
      restaurant_logo_url: null,
      timezone: d.timezone,
    };
    if (/o\.id::text = \$4/i.test(q)) {
      // Outlet-bound branch: resolves a REAL outlet of THIS restaurant or nothing.
      const bound = typeof params[3] === "string" ? params[3] : "";
      const outlet = d.outlets.find((o) => o.id === bound && (o.res_id ?? RES_ID) === d.res_id);
      if (!outlet) {return [];}
      return [{ ...identity, outlet_id: outlet.id }];
    }
    // Default branch: the tenant's first outlet.
    const first = d.outlets.find((o) => (o.res_id ?? RES_ID) === d.res_id);
    return first ? [{ ...identity, outlet_id: first.id }] : [];
  }
  if (/select service_charge from "Restaurant"/i.test(q)) {
    return [{ service_charge: d.service_charge_percent }];
  }
  // loadPaymentConfig — the report readers' mode labels. Tenant-bound like
  // everything else here.
  if (/select payment_config from "Restaurant" where id = \$1/i.test(q)) {
    return params[0] === d.res_id ? [{ payment_config: d.payment_config ?? null }] : [];
  }

  // --- "Outlets" ---
  if (/select outlet_name from "Outlets" where id = \$1 and res_id = \$2/i.test(q)) {
    const o = d.outlets.find((x) => x.id === params[0] && (x.res_id ?? RES_ID) === params[1]);
    return o ? [{ outlet_name: o.name }] : [];
  }
  if (/select id, outlet_name from "Outlets" where res_id = \$1/i.test(q)) {
    return d.outlets.filter((o) => (o.res_id ?? RES_ID) === params[0]).map((o) => ({ id: o.id, outlet_name: o.name }));
  }

  // --- 039: the attribution index (menu row -> resolved revenue group) ---
  // BEFORE the plain "Menu" branch below, which would otherwise swallow it and
  // hand back a row shape with no group in it at all.
  if (/coalesce\(gi\.id, gc\.id\)/i.test(q)) {
    requireShape(q, "gi.kind = 'revenue'",
      "groups classify on two axes; reporting money by the PRODUCTION axis answers a different question");
    const all = allOutletsFrom(q);
    const rid = String(params[0] ?? ""), oid = String(params[1] ?? "");
    if (rid !== d.res_id) {return [];}
    if (!all && !d.outlets.some((o) => o.id === oid && (o.res_id ?? RES_ID) === rid)) {return [];}
    return d.menu.map((m, i) => ({
      id: menuIdOf(m, i),
      name: m.name,
      group_id: m.group ? groupIdOf(m.group) : null,
      group_name: m.group ?? null,
    }));
  }

  // --- 039: variations ---
  if (/from "MenuVariations"/i.test(q)) {
    const out: { id: string; menu_id: string; name: string; price: number }[] = [];
    d.menu.forEach((m, i) => {
      for (const v of m.variations ?? []) {
        out.push({ id: v.id, menu_id: menuIdOf(m, i), name: v.name, price: v.price });
      }
    });
    return out;
  }

  // --- 034: non-chargeables ---
  if (/from "OrderItemNonChargeable"/i.test(q)) {
    requireShape(q, "res_id = $1", "the tenant predicate");
    const rows = captureRowsMatching(q, params, d.non_chargeables, (n) => n.created_at);
    // The ladder-side read: what a window gave away, per outlet, nothing else.
    if (!/from "OrderItemNonChargeable" n/i.test(q)) {
      return rows.map((n) => ({
        created_at: new Date(n.created_at),
        outlet_id: outletOf(n),
        quantity: n.quantity,
        value: r2(n.quantity * n.unit_price),
        reversed: Boolean(n.reversed_at),
      }));
    }
    // The NC Summary's own read, with the bill/table/order it resolves.
    //
    // billForNonChargeable re-derives the attribution in TypeScript, which means
    // reversing the SQL's ORDER BY would leave this suite green while every comp
    // was reported against the wrong bill. So the ordering is asserted as text:
    // the FIRST bill that settles at or after the comp is the bill the comp
    // reduced; the last one belongs to a later seating.
    requireShape(q, "order by coalesce(b.closed_at, b.admin_approved_at, 'infinity'::timestamptz) asc",
      "a comp belongs to the first bill that settled at or after it, not the table's most recent one");
    requireShape(q, "coalesce(b.closed_at, b.admin_approved_at) >= n.created_at",
      "a bill that closed BEFORE the comp belongs to a previous seating");
    const search = params[4];
    const filtered = typeof search === "string" && search.includes("%")
      ? rows.filter((n) =>
        like(n.item_name, search) || like(n.reason, search) || like(n.nc_kind, search)
        || like(n.marked_by, search) || like(n.authorised_by, search)
        || like(n.table_name, search) || like(n.order_id, search)
        || like(billForNonChargeable(n)?.bill_no, search))
      : rows;
    return [...filtered]
      .sort((a, z) => new Date(z.created_at).getTime() - new Date(a.created_at).getTime())
      .map((n) => {
        const order = d.orders.find((o) => o.id === n.order_id);
        const bill = billForNonChargeable(n);
        return {
          id: n.id,
          created_at: new Date(n.created_at),
          order_id: n.order_id,
          item_name: n.item_name,
          nc_kind: n.nc_kind,
          reason: n.reason,
          quantity: n.quantity,
          unit_price: n.unit_price,
          menu_price_at_nc: n.menu_price_at_nc ?? null,
          value: r2(n.quantity * n.unit_price),
          marked_by_username: n.marked_by,
          authorised_by_username: n.authorised_by,
          reversed_at: n.reversed_at ? new Date(n.reversed_at) : null,
          reversed_by_username: n.reversed_by ?? null,
          reversal_reason: n.reversal_reason ?? null,
          table_name: n.table_name ?? null,
          order_type: order?.order_type ?? null,
          waiter: order?.taken_by ?? null,
          bill_id: bill?.id ?? null,
          bill_no: bill?.bill_no ?? null,
        };
      });
  }

  // --- 036: service-charge waivers ---
  if (/from "ServiceChargeWaivers" w/i.test(q)) {
    requireShape(q, "w.res_id = $1", "the tenant predicate");
    const rows = captureRowsMatching(q, params, d.waivers, (w) => w.waived_at);
    const search = params[4];
    const filtered = typeof search === "string" && search.includes("%")
      ? rows.filter((w) =>
        like(w.reason, search) || like(w.waiver_kind, search) || like(w.waived_by, search)
        || like(w.authorised_by, search) || like(w.table_name, search)
        || like(d.bills.find((b) => b.id === w.bill_id)?.bill_no, search) || like(w.bill_id, search))
      : rows;
    return [...filtered]
      .sort((a, z) => new Date(z.waived_at).getTime() - new Date(a.waived_at).getTime())
      .map((w) => {
        const bill = d.bills.find((b) => b.id === w.bill_id);
        return {
          id: w.id,
          waived_at: new Date(w.waived_at),
          bill_id: w.bill_id,
          basis: w.basis,
          basis_percent: w.basis_percent,
          basis_amount: w.basis_amount,
          amount_waived: w.amount_waived,
          tax_on_waived: w.tax_on_waived,
          grand_total_reduction: r2(w.amount_waived + w.tax_on_waived),
          waiver_kind: w.waiver_kind,
          reason: w.reason,
          waived_by_username: w.waived_by,
          authorised_by_username: w.authorised_by,
          reversed_at: w.reversed_at ? new Date(w.reversed_at) : null,
          reversed_by_username: w.reversed_by ?? null,
          reversal_reason: w.reversal_reason ?? null,
          table_name: w.table_name ?? null,
          bill_no: bill?.bill_no ?? null,
          total_amt: bill?.total_amt ?? null,
          settled_at: bill && isSettled(bill) ? new Date(bill.settled_at) : null,
        };
      });
  }

  // --- 037: tenders and the tips riding on them ---
  if (/from "BillTenders" tn/i.test(q)) {
    requireShape(q, "tn.res_id = $1", "the tenant predicate");
    // The leading `and` is load-bearing: it is what stops an `or true` bolted
    // beside the predicate from passing as the predicate.
    requireShape(q, "and tn.voided_at is null",
      "a tender keyed twice and voided carries no tip anybody is owed");
    requireShape(q, "and tn.tip_amount > 0", "the tip report reports tips");
    const rows = captureRowsMatching(q, params, d.tenders, (t) => t.settled_at)
      .filter((t) => !t.voided_at && (t.tip_amount ?? 0) > 0);
    const search = params[4];
    const filtered = typeof search === "string" && search.includes("%")
      ? rows.filter((t) =>
        like(t.method, search) || like(t.tip_mode, search) || like(t.tip_credited_to, search)
        || like(t.settled_by, search) || like(t.table_name, search)
        || like(d.bills.find((b) => b.id === t.bill_id)?.bill_no, search))
      : rows;
    return [...filtered]
      .sort((a, z) => new Date(z.settled_at).getTime() - new Date(a.settled_at).getTime() || a.seq - z.seq)
      .map((t) => {
        const bill = d.bills.find((b) => b.id === t.bill_id);
        const order = bill?.order_id ? d.orders.find((o) => o.id === bill.order_id) : undefined;
        return {
          id: t.id,
          settled_at: new Date(t.settled_at),
          bill_id: t.bill_id,
          seq: t.seq,
          method: t.method,
          tip_amount: t.tip_amount ?? 0,
          tip_mode: t.tip_mode ?? null,
          tip_credited_to_username: t.tip_credited_to ?? null,
          settled_by_username: t.settled_by ?? "cashier",
          table_name: t.table_name ?? null,
          bill_no: bill?.bill_no ?? null,
          // The reader only reads an order type when the BILL names an order; a
          // consolidated table bill does not, and the column stays blank.
          order_type: bill?.order_id ? (order?.order_type ?? null) : null,
        };
      });
  }

  // --- 038: the till identities ---
  if (/from "BillingCounters"/i.test(q)) {
    const all = allOutletsFrom(q);
    const rid = String(params[0] ?? ""), oid = String(params[1] ?? "");
    const includeInactive = /\(\s*true\s*\)/i.test(q) || !/active = true/i.test(q);
    return d.counters
      .filter((c) => resOf(c) === rid && (all || outletOf(c) === oid)
        && (includeInactive || c.active !== false))
      .map((c) => ({
        id: c.id,
        outlet_id: outletOf(c),
        code: c.code,
        name: c.name,
        kind: c.kind ?? "counter",
        device_hint: null,
        active: c.active !== false,
        sort_order: c.sort_order ?? 0,
      }));
  }

  // --- 038: the shifts counted on those tills ---
  if (/from "CashSessions"/i.test(q)) {
    requireShape(q, "res_id = $1", "the tenant predicate");
    requireShape(q, "counter_id is not null",
      "sessions are keyed to the till, never to the nullable outlet_id on this legacy table");
    const rid = String(params[0] ?? "");
    const from = params[1], to = params[2];
    const acc = new Map<string, { sessions: number; opened: number; closed: number | null; open: boolean; variance: number }>();
    for (const c of d.cash_sessions) {
      if (resOf(c) !== rid) {continue;}
      const opened = new Date(c.opened_at).getTime();
      const closed = c.closed_at ? new Date(c.closed_at).getTime() : null;
      const before = typeof to === "string" ? new Date(to).getTime() : Number.POSITIVE_INFINITY;
      const after = typeof from === "string" ? new Date(from).getTime() : Number.NEGATIVE_INFINITY;
      if (!(opened < before && (closed === null || closed >= after))) {continue;}
      const e = acc.get(c.counter_id) ?? { sessions: 0, opened, closed: null, open: false, variance: 0 };
      e.sessions += 1;
      e.opened = Math.min(e.opened, opened);
      if (closed === null) {e.open = true;} else {e.closed = Math.max(e.closed ?? closed, closed);}
      e.variance += c.variance ?? 0;
      acc.set(c.counter_id, e);
    }
    return [...acc.entries()].map(([counter_id, e]) => ({
      counter_id,
      sessions: String(e.sessions),
      opened_at: new Date(e.opened),
      closed_at: e.open || e.closed === null ? null : new Date(e.closed),
      variance: r2(e.variance),
    }));
  }

  // --- "Menu" (category enrichment for Item Wise) ---
  if (/from "Menu" m/i.test(q)) {
    return d.menu.map((m, i) => ({
      id: `menu-${String(i)}`,
      name: m.name,
      description: null,
      sub_category: m.category,
      main_category: m.category,
    }));
  }

  // --- 037: one bill's own tender ledger, and the bill row that resolves it ---
  //
  // Not a report read. It is here because mirrorTendersToBillColumns — the
  // function that decides what a bill's payment_method / payment_splits SAY —
  // is only reachable through GetBillPaymentLedger, and those two columns are
  // what the Settlement Summary cashes up against. A tip that leaked into a
  // split would read the day's takings high by the tips and show up nowhere
  // else, so the leak is tested where it would happen.
  if (/waiter_confirmed_at, admin_approved_at, closed_at, payment_method/i.test(q)) {
    const b = d.bills.find((x) => x.id === params[0] && resOf(x) === params[1] && outletOf(x) === params[2]);
    if (!b) {return [];}
    return [{
      id: b.id,
      table_id: b.table_name ?? null,
      total_amt: b.total_amt,
      waiter_confirmed_at: null,
      admin_approved_at: null,
      closed_at: isSettled(b) ? new Date(b.settled_at) : null,
      payment_method: b.payment_method ?? null,
    }];
  }
  if (/from "BillTenders"\s+where/i.test(q)) {
    requireShape(q, "voided_at is null", "a voided tender is not money that entered the till");
    return d.tenders
      .filter((t) => resOf(t) === params[0] && t.bill_id === params[1] && !t.voided_at)
      .sort((a, z) => a.seq - z.seq)
      .map((t) => ({
        id: t.id,
        created_at: new Date(t.settled_at),
        outlet_id: outletOf(t),
        bill_id: t.bill_id,
        table_id: t.table_name ?? null,
        seq: t.seq,
        method: t.method,
        amount: t.amount,
        txn_ref: null,
        settled_at: new Date(t.settled_at),
        settled_by_username: t.settled_by ?? "cashier",
        tip_amount: t.tip_amount ?? 0,
        tip_mode: t.tip_mode ?? null,
        tip_credited_to_username: t.tip_credited_to ?? null,
        voided_at: null,
        voided_by_username: null,
        void_reason: null,
      }));
  }

  // --- getSettledBills: the ACCOUNTING readers' bill read (GetSalesReport) ---
  // Unaliased, and it selects no ids — which is how it is told apart from the
  // MIS reads below. Modelled so a test can hold the accounting Net and the MIS
  // Net to one number over the same bills, rather than trusting two readers
  // that happen to share a classifier.
  if (/from "Bills" where res_id = \$1/i.test(q) && /as settled_at/i.test(q)) {
    requireShape(q, "coalesce(closed_at, admin_approved_at) >= $3",
      "the settlement basis the MIS readers use too — two clocks would be two answers");
    requireShape(q, "coalesce(closed_at, admin_approved_at) < $4",
      "the EXCLUSIVE upper bound is what makes the range inclusive of its last day");
    return billsMatching(q, params).map((b) => ({
      settled_at: new Date(b.settled_at),
      total_amt: b.total_amt,
      tax_breakdown: b.tax_breakdown,
      ...(/\bround_off\b/i.test(q) ? { round_off: b.round_off ?? 0 } : {}),
      payment_method: b.payment_method ?? null,
      payment_splits: b.payment_splits ?? null,
      refund_amount: b.refund_amount ?? 0,
    }));
  }

  // --- "Bills" ---
  if (/from "Bills" b/i.test(q)) {
    requireShape(q, "b.res_id = $1", "the tenant predicate is the only thing between one restaurant's money and another's");
    requireShape(q, 'coalesce(b.closed_at, b.admin_approved_at) >= $3',
      "the settlement basis: every money report must add up the same rows the accounting reports do");
    requireShape(q, 'coalesce(b.closed_at, b.admin_approved_at) < $4',
      "the EXCLUSIVE upper bound is what makes the range inclusive of its last day (windowInstants adds the +1)");

    // The Discount report's count/page carry their own extra predicate.
    const discountOnly = /coalesce\(b\.discount_value, 0\) > 0/i.test(q);
    let rows = billsMatching(q, params).filter((b) =>
      !discountOnly || (b.discount_value ?? 0) > 0 || (b.coupon_code ?? "").trim() !== "");

    // A search term, when one was bound. It is always the parameter after the
    // window, so its index is what tells the fixture a search was applied.
    const searchParam = params[4];
    if (typeof searchParam === "string" && searchParam.includes("%")) {
      rows = rows.filter((b) =>
        like(b.bill_no, searchParam) || like(b.table_name, searchParam)
        || like(b.coupon_code, searchParam) || like(b.id, searchParam)
        || like(b.payment_method, searchParam) || like(b.order_id, searchParam));
    }

    // fetchMisBillCounters — which till rang each bill, and who was on it.
    if (/b\.counter_id/i.test(q)) {
      return rows.map((b) => ({
        id: b.id,
        counter_id: b.counter_id ?? null,
        fname: b.waiter_fname ?? null,
        lname: b.waiter_lname ?? null,
      }));
    }

    if (/count\(\*\)::text as total/i.test(q)) {return [{ total: String(rows.length) }];}

    // Paged reads take limit/offset as the last two bound parameters.
    const paged = (list: FixtureBill[]): FixtureBill[] => {
      const limit = Number(params[params.length - 2]);
      const offset = Number(params[params.length - 1]);
      if (!Number.isFinite(limit) || !Number.isFinite(offset)) {return list;}
      const desc = [...list].sort((a, z) => new Date(z.settled_at).getTime() - new Date(a.settled_at).getTime());
      return desc.slice(offset, offset + limit);
    };

    // The Discount page: the only bill read that joins "DiscountRequests".
    if (/d\.requested_by, d\.decided_by/i.test(q)) {
      return paged(rows).map((b) => ({
        ...misBillRow(b, q),
        table_name: b.table_name ?? null,
        reason: b.reason ?? null,
        requested_by: b.requested_by ?? null,
        decided_by: b.decided_by ?? null,
      }));
    }
    // The Order Summary page: the only bill read that counts the order's items.
    if (/jsonb_array_length\(/i.test(q)) {return paged(rows).map((b) => orderSummaryRow(b, q));}
    // The Sales Summary's order-type cut.
    if (/as channel/i.test(q)) {
      const acc = new Map<string, { bills: number; total: number }>();
      for (const b of rows) {
        const o = orderOf(b);
        // The reader INNER-joins "Orders": a bill whose order row is gone is not
        // in this cut, and its own note says so.
        if (!o) {continue;}
        const key = o.order_type ?? "dine_in";
        const e = acc.get(key) ?? { bills: 0, total: 0 };
        e.bills += 1;
        e.total += b.total_amt;
        acc.set(key, e);
      }
      return [...acc.entries()].map(([channel, v]) => ({ channel, bills: String(v.bills), total: v.total }));
    }
    // GetOverviewHeadline — the ladder read without the seating lateral, plus
    // the online flag. The reader's EXISTS looks for any online order on the
    // bill's TABLE; the fixture has no table ids, so it reads the bill's own
    // order, which is the same answer for every bill these suites build.
    if (/as is_online/i.test(q)) {
      const walkIn = new Set(["dine_in", "dinein", "dine-in", "takeaway", "take_away", "pickup"]);
      return [...rows]
        .sort((a, z) => new Date(a.settled_at).getTime() - new Date(z.settled_at).getTime())
        .map((b) => ({
          ...misBillRow(b, q),
          session_id: null,
          session_covers: null,
          is_online: !walkIn.has(orderOf(b)?.order_type ?? "dine_in"),
        }));
    }
    // fetchMisBills — the shared ladder read.
    if (/s\.covers as session_covers/i.test(q)) {
      return [...rows]
        .sort((a, z) => new Date(a.settled_at).getTime() - new Date(z.settled_at).getTime())
        .map((b) => misBillRow(b, q));
    }
    throw new Error(`mis fixture: unrecognised "Bills" read — ${q.slice(0, 260)}`);
  }

  // --- "Orders" (Item Wise, Void KOT, the KOT drill-down) ---
  if (/from "Orders" o/i.test(q)) {
    // The drill-down reads ONE order by id and is not window-scoped.
    if (/b\.bill_no::text as bill_no/i.test(q)) {
      const o = d.orders.find((x) => x.id === params[0] && resOf(x) === params[1]);
      if (!o) {return [];}
      const bill = d.bills.find((b) => b.order_id === o.id);
      return [{
        id: o.id,
        created_at: new Date(o.created_at),
        updated_at: null,
        status: o.status,
        food: { items: o.items, order_type: o.order_type ?? "dine_in" },
        table_name: o.table_name ?? null,
        bill_id: bill?.id ?? null,
        bill_no: bill?.bill_no ?? null,
      }];
    }

    requireShape(q, "o.res_id = $1", "the tenant predicate");
    let rows = ordersMatching(q, params);

    if (/jsonb_array_elements\(/i.test(q) && /as gross/i.test(q)) {
      // The two item-line reads: ITEM WISE, and the shared line read the Group
      // and Variation summaries cut. They share every predicate on purpose — that
      // is what makes their grosses equal — so they share this branch too, and
      // are told apart by the 039 columns only the second one selects.
      requireShape(q, "coalesce(o.status::text, '1') <> '5'",
        "cancelled orders are not sales; without this, voided food is counted as revenue");
      requireShape(q, "jsonb_typeof((o.food)::jsonb->'items') = 'array'",
        "jsonb_array_elements RAISES on a non-array, and one malformed food blob would 500 the whole report");
      requireShape(q, "coalesce((item->'nc') = 'true'::jsonb, false) as nc",
        "the comp flag must be matched as the jsonb boolean true, exactly as isNonChargeableLine matches it");
      rows = rows.filter((o) => o.status !== 5);
      const byVariation = /variation_id/i.test(q);
      const search = byVariation ? undefined : params[4];
      interface LineAcc {
        name: string; channel: string; nc: boolean;
        menu_id: string | null; variation_id: string | null; variation_name: string | null;
        qty: number; gross: number;
      }
      const acc = new Map<string, LineAcc>();
      for (const o of rows) {
        const channel = o.order_type ?? "dine_in";
        for (const it of o.items) {
          if (typeof search === "string" && search.includes("%") && !like(it.name, search)) {continue;}
          const nc = it.nc === true;
          const menu_id = it.menu_id ?? null;
          const variation_id = byVariation ? (it.variation_id ?? null) : null;
          const variation_name = byVariation ? (it.variation_name ?? null) : null;
          const key = byVariation
            ? `${it.name}@@${String(menu_id)}@@${String(variation_id)}@@${String(variation_name)}@@${String(nc)}`
            : `${it.name}@@${channel}@@${String(nc)}`;
          const e = acc.get(key)
            ?? { name: it.name, channel, nc, menu_id, variation_id, variation_name, qty: 0, gross: 0 };
          e.qty += it.quantity;
          e.gross += it.price * it.quantity;
          acc.set(key, e);
        }
      }
      return [...acc.values()];
    }

    // VOID KOT — every read of it is scoped to status 5.
    requireShape(q, "coalesce(o.status::text, '1') = '5'",
      "a void IS status 5; without this the report would list live orders as cancelled");
    rows = rows.filter((o) => o.status === 5);
    const search = params[4];
    if (typeof search === "string" && search.includes("%")) {
      rows = rows.filter((o) =>
        like(o.id, search) || like(o.table_name, search)
        || o.items.some((it) => like(it.name, search)));
    }

    if (/count\(\*\)::text as total/i.test(q)) {return [{ total: String(rows.length) }];}
    if (/count\(distinct id\)::text as voids/i.test(q)) {
      let qty = 0, value = 0, lines = 0;
      for (const o of rows) {
        for (const it of o.items) { qty += it.quantity; value += it.price * it.quantity; lines += 1; }
      }
      return [{ voids: String(rows.length), qty, value, lines: String(lines) }];
    }
    if (/v\.created_at as voided_at/i.test(q)) {
      const limit = Number(params[params.length - 2]);
      const offset = Number(params[params.length - 1]);
      const desc = [...rows].sort((a, z) => new Date(z.created_at).getTime() - new Date(a.created_at).getTime());
      return desc.slice(offset, offset + limit).map((o) => {
        const void_entry = d.audits.find((a) =>
          resOf(a) === resOf(o)
          && a.details?.order_id === o.id
          && /cancelled$/i.test(a.reason ?? ""));
        return {
          id: o.id,
          created_at: new Date(o.created_at),
          table_name: o.table_name ?? null,
          food: { items: o.items, order_type: o.order_type ?? "dine_in" },
          voided_at: void_entry ? new Date(void_entry.created_at) : null,
          voided_fname: void_entry?.fname ?? null,
          voided_lname: void_entry?.lname ?? null,
          voided_username: void_entry?.username ?? null,
        };
      });
    }
    throw new Error(`mis fixture: unrecognised "Orders" read — ${q.slice(0, 260)}`);
  }

  // --- "Audit_logs" (Bill Edit, and the drill-down's trail) ---
  if (/from "Audit_logs" l/i.test(q)) {
    requireShape(q, "l.res_id = $1", "the tenant predicate");
    // The drill-down's trail: one order, no window.
    if (/limit 50/i.test(q)) {
      return d.audits
        .filter((a) => resOf(a) === params[0] && a.details?.order_id === params[1])
        .sort((a, z) => new Date(z.created_at).getTime() - new Date(a.created_at).getTime())
        .map((a) => ({
          created_at: new Date(a.created_at),
          action_name: a.action_name,
          reason: a.reason,
          fname: a.fname ?? null, lname: a.lname ?? null, emp_username: a.username ?? null,
        }));
    }
    // BILL EDIT.
    requireShape(q, "l.action_id::text = any($5::text[])",
      "the action-id prefilter; without it every audit row in the window is a candidate");
    const all = allOutletsFrom(q);
    const ids = Array.isArray(params[4]) ? (params[4] as string[]) : [];
    let rows = d.audits.filter((a) =>
      resOf(a) === params[0]
      && (all || outletOf(a) === params[1])
      && inWindow(a.created_at, params[2], params[3])
      && ids.includes(a.action_id));
    const search = params[5];
    if (typeof search === "string" && search.includes("%")) {
      rows = rows.filter((a) => like(a.reason, search) || like(a.action_name, search) || like(JSON.stringify(a.details), search));
    }
    return rows
      .sort((a, z) => new Date(z.created_at).getTime() - new Date(a.created_at).getTime())
      .map((a) => ({
        id: a.id,
        created_at: new Date(a.created_at),
        reason: a.reason,
        action_id: a.action_id,
        action_name: a.action_name,
        additional_details: a.details,
        fname: a.fname ?? null, lname: a.lname ?? null, emp_username: a.username ?? null,
      }));
  }

  // --- "OrderVoids" (035) — WHY a ticket was cancelled ------------------------
  //
  // The Void KOT report reads this SEPARATELY from its main statement so that a
  // deployment one migration behind degrades to "no reasons known" instead of
  // 500ing the whole report. Modelled here so that degradation is exercised by
  // a fixture with no rows rather than merely asserted in a comment.
  if (/from "OrderVoids"/i.test(q)) {
    requireShape(q, "res_id = $1", "the tenant predicate");
    const ids = Array.isArray(params[1]) ? (params[1] as string[]) : [];
    return d.order_voids
      .filter((v) => resOf(v) === params[0] && (v.scope ?? "order") === "order" && ids.includes(v.order_id))
      .map((v) => ({ order_id: v.order_id, reason: v.reason, void_kind: v.void_kind, stage: v.stage }));
  }

  throw new Error(`mis fixture: unstubbed SQL — ${q.slice(0, 260)}`);
}

// Wired onto globalThis because a jest.mock factory is hoisted above imports and
// may not close over module scope.
interface FixtureGlobal {
  __misFixtureQuery?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}
(globalThis as unknown as FixtureGlobal).__misFixtureQuery = fixtureQuery;
