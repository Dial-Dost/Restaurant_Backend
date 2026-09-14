// In-memory "Bills" fixture + a fake `pg` Pool, so the REAL report readers in
// database_supabase.ts (GetSalesReport / GetGstReport / GetProfitAndLoss /
// BuildTallyXml / ListClosedBills) can be exercised as unit tests.
//
// WHY A FIXTURE RATHER THAN PURE FUNCTIONS: the classification that separates a
// service charge from genuine tax (splitServiceChargeLine → closedBillCharges →
// reportBillCharges) is module-private to database_supabase.ts. Re-implementing
// it in a test would assert only that the copy agrees with itself — which is
// exactly the hole the 31,733.92 misreport fell through. Driving the exported
// readers over a stubbed pg Pool tests the shipped code path, and needs no
// database, so the suite can never be "skipped because prod wasn't reachable".
//
// The fake Pool answers only the queries these readers actually issue, and
// THROWS on an unrecognised query or table: a reader that starts reading a new
// TABLE fails loudly here instead of silently receiving zero rows.
//
// Known limit, stated because an inaccurate promise here is worse than none:
// dispatch matches on a marker in the SQL, not on the select list, so a reader
// that adds a new COLUMN to a query the fixture already recognises will NOT
// fail — the column simply arrives undefined. If you add a column to one of
// these readers, add it to the corresponding fixture row by hand.

export interface FixtureTaxLine {
  name: string;
  percentage: number;
  amount: number;
}

export interface FixtureBill {
  id: string;
  bill_no: string;
  /** UTC instant the bill settled. Stored as closed_at (the canonical settle stamp). */
  settled_at: string;
  /** "Bills".total_amt — the TAX-INCLUSIVE grand total. */
  total_amt: number;
  /** "Bills".tax_breakdown, verbatim. May contain a "Service Charge" line (shape b). */
  tax_breakdown: FixtureTaxLine[];
  /**
   * "Bills".round_off (migration 048). Absent = NULL, settled before rounding.
   * Answered only to a query that SELECTS the column, as Postgres would — so a
   * reader that loses it from its SELECT is caught, which the dispatch-by-marker
   * limit noted above would otherwise let through.
   */
  round_off?: number | null;
  payment_method?: string | null;
  payment_splits?: { method: string; amount: number }[] | null;
  refund_amount?: number;
  /** Covers live on "TableSessions", never on Bills — this is the joined value. */
  covers?: number | null;
  /** ReleaseTable stamps 'released' when a table is freed without payment. */
  closed_by_username?: string | null;
  /** false = never settled (still on the floor): no closed_at, no admin_approved_at. */
  settled?: boolean;
}

export interface FixtureExpense {
  id?: string;
  spent_on: string;
  category: string;
  vendor?: string | null;
  amount: number;
  note?: string | null;
}

export interface FixtureDb {
  res_id: string;
  outlet_id: string;
  slug: string;
  name: string;
  timezone: string;
  /**
   * "Restaurant".service_charge — shape (a), a percent applied before tax and NOT
   * present in tax_breakdown. Zero when the tenant instead lists "Service Charge"
   * inside Outlets.default_tax (shape b), which is what the shipped seed does.
   */
  service_charge_percent: number;
  bills: FixtureBill[];
  expenses?: FixtureExpense[];
  /** "Restaurant".payment_config — null/absent is the built-in defaults. */
  payment_config?: unknown;
}

export const RES_ID = "11111111-1111-4111-8111-111111111111";
export const OUTLET_ID = "22222222-2222-4222-8222-222222222222";

export function makeDb(over: Partial<FixtureDb> & Pick<FixtureDb, "bills">): FixtureDb {
  return {
    res_id: RES_ID,
    outlet_id: OUTLET_ID,
    slug: "zztest-money",
    name: "ZZTEST Money Fixture",
    timezone: "Asia/Kolkata",
    service_charge_percent: 0,
    expenses: [],
    ...over,
  };
}

let db: FixtureDb | null = null;

/** Install the bill set the next reader call will see. */
export function useFixtureDb(next: FixtureDb): void {
  db = next;
}

function requireDb(): FixtureDb {
  if (!db) {throw new Error("useFixtureDb() was not called before invoking a reader");}
  return db;
}

const isSettled = (b: FixtureBill): boolean => b.settled !== false;

function inRange(iso: string, fromIso: unknown, toIso: unknown): boolean {
  const t = new Date(iso).getTime();
  const from = typeof fromIso === "string" ? new Date(fromIso).getTime() : Number.NEGATIVE_INFINITY;
  const to = typeof toIso === "string" ? new Date(toIso).getTime() : Number.POSITIVE_INFINITY;
  return t >= from && t < to; // half-open, matching the readers' `>= $3 and < $4`
}

/** The row shape getSettledBills() selects. */
function settledBillRow(b: FixtureBill, q = "") {
  return {
    settled_at: new Date(b.settled_at),
    total_amt: b.total_amt,
    tax_breakdown: b.tax_breakdown,
    ...(/\bround_off\b/i.test(q) ? { round_off: b.round_off ?? 0 } : {}),
    payment_method: b.payment_method ?? null,
    payment_splits: b.payment_splits ?? null,
    refund_amount: b.refund_amount ?? 0,
  };
}

/** The row shape CLOSED_BILL_SELECT produces (the bill-detail / history path). */
function closedBillRow(b: FixtureBill, q = "") {
  const closedAt = new Date(b.settled_at);
  return {
    id: b.id,
    bill_no: b.bill_no,
    status: 7, // Closed
    reason: null,
    table_id: null,
    table_name: null,
    total_amt: b.total_amt,
    tax_breakdown: b.tax_breakdown,
    ...(/\bb\.round_off\b/i.test(q) ? { round_off: b.round_off ?? null } : {}),
    payment_method: b.payment_method ?? null,
    payment_splits: b.payment_splits ?? null,
    payment_proof_screenshot_url: null,
    discount_type: null,
    discount_value: 0,
    discount_applied_at: null,
    coupon_code: null,
    waiter_confirmed_at: closedAt,
    waiter_confirmed_by_username: null,
    admin_approved_at: closedAt,
    admin_approved_by_username: null,
    closed_at: closedAt,
    closed_by_username: b.closed_by_username ?? null,
    refunded_at: (b.refund_amount ?? 0) > 0 ? closedAt : null,
    refunded_by_username: null,
    refund_amount: b.refund_amount ?? 0,
    refund_reason: null,
    refund_ref: null,
    created_at: closedAt,
    created_by_fname: null,
    created_by_lname: null,
    session_covers: b.covers ?? null,
    seated_at: closedAt,
    left_at: closedAt,
  };
}

// DDL and session statements the lazy-table helpers fire. They are no-ops here:
// the fixture defines the schema, so there is nothing to provision.
const DDL = /^(alter|create|drop|do|grant|revoke|comment|begin|commit|rollback|set|truncate)\b/i;

export async function fixtureQuery(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
  const q = sql.replace(/\s+/g, " ").trim();
  const rows = dispatch(q, params);
  return { rows };
}

function dispatch(q: string, params: unknown[]): unknown[] {
  if (DDL.test(q)) {return [];}

  const d = requireDb();

  // resolveRestaurantContext — both the outlet-bound and the first-outlet variant.
  if (/from "Restaurant" r/.test(q)) {
    return [{
      res_id: d.res_id,
      outlet_id: d.outlet_id,
      restaurant_slug: d.slug,
      restaurant_name: d.name,
      restaurant_main_office_add: null,
      restaurant_logo_url: null,
      timezone: d.timezone,
    }];
  }

  // getServiceChargePercent — shape (a)'s percent.
  if (/select service_charge from "Restaurant"/i.test(q)) {
    return [{ service_charge: d.service_charge_percent }];
  }

  // loadPaymentConfig — the report readers' mode labels.
  if (/select payment_config from "Restaurant" where id = \$1/i.test(q)) {
    return params[0] === d.res_id ? [{ payment_config: d.payment_config ?? null }] : [];
  }

  if (/from "Outlets" where id = \$1/i.test(q)) {
    return [{ outlet_name: "Main", outlet_add: "", outlet_phone: null, outlet_hours: null }];
  }

  // GetRestaurantProfile's employee lookup (BuildTallyXml only wants the name).
  if (/from "Employees"/i.test(q)) {return [];}

  if (/from "Expenses"/i.test(q)) {
    const from = String(params[2] ?? "0000-01-01");
    const to = String(params[3] ?? "9999-12-31");
    return (d.expenses ?? [])
      .filter((e) => e.spent_on >= from && e.spent_on <= to)
      .map((e, i) => ({
        id: e.id ?? `expense-${i}`,
        spent_on: e.spent_on,
        category: e.category,
        vendor: e.vendor ?? null,
        amount: e.amount,
        note: e.note ?? null,
        created_by: null,
        created_at: new Date(`${e.spent_on}T00:00:00Z`),
      }));
  }

  if (/from "Bills"/i.test(q)) {
    // ListClosedBills' count query.
    if (/count\(\*\)::text as total/i.test(q)) {
      return [{ total: String(closedListBills(d, q, params).length) }];
    }
    // getSettledBills — the shared revenue basis of every report reader.
    if (/as settled_at/i.test(q)) {
      return d.bills
        .filter((b) => isSettled(b) && inRange(b.settled_at, params[2], params[3]))
        .map((b) => settledBillRow(b, q));
    }
    // ListClosedBills' page query (the bill-detail classification path).
    if (/b\.bill_no/i.test(q)) {
      return closedListBills(d, q, params).map((b) => closedBillRow(b, q));
    }
  }

  throw new Error(`money fixture: unstubbed SQL — ${q.slice(0, 220)}`);
}

// ListClosedBills' date predicates, applied the way Postgres would. The bound
// column is coalesce(closed_at, admin_approved_at, created_at), which is
// settled_at for every fixture bill. Before this the fixture ignored from/to on
// the list entirely, so no test could see WHICH DAY a bill is listed under —
// the very thing the reports and the list must agree on. The ORDER BY uses the
// same expression followed by `desc`, which this pattern deliberately skips.
const CLOSED_LIST_BOUND = /coalesce\(b\.closed_at, b\.admin_approved_at, b\.created_at\) (>=|<=|<) \$(\d+)/;

function closedListBills(d: FixtureDb, q: string, params: unknown[]): FixtureBill[] {
  const bounds: { op: string; at: number }[] = [];
  const re = new RegExp(CLOSED_LIST_BOUND.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) {
    const raw = params[Number(m[2]) - 1];
    const at = new Date(String(raw)).getTime();
    // A bound Postgres could not cast would be a 500 in production; fail loudly.
    if (Number.isNaN(at)) {throw new Error(`money fixture: unparseable ListClosedBills bound ${String(raw)}`);}
    bounds.push({ op: m[1], at });
  }
  return d.bills.filter(isSettled).filter((b) => {
    const t = new Date(b.settled_at).getTime();
    return bounds.every(({ op, at }) => (op === ">=" ? t >= at : op === "<" ? t < at : t <= at));
  });
}

// Wired onto globalThis because a jest.mock factory is hoisted above imports and
// may not close over module scope.
interface FixtureGlobal {
  __moneyFixtureQuery?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}
(globalThis as unknown as FixtureGlobal).__moneyFixtureQuery = fixtureQuery;
