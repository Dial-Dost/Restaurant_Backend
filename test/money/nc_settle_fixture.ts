// An in-memory table, its orders, its open bill and the NC ledger — and a fake
// `pg` Pool with TRANSACTIONS — so the REAL SettleBillAsNonChargeable (and the
// settle paths it has to agree with) can be driven as a unit test.
//
// WHY A FIXTURE AND NOT A DATABASE: the rules this protects are spread across
// the transaction — the lock order, the refusals before any write, the per-line
// ledger rows, the re-price, the ₹0 invariant, the bill stamp, the freed table —
// and none of them lives in one pure function. Driving the shipped function over
// a stubbed Pool tests the real code and needs no database, the same posture as
// bill_fixtures.ts and mis_fixtures.ts. The integration test in
// test/integration runs the same flow against real Postgres in CI.
//
// WHAT IT ENFORCES rather than assumes:
//   * every statement is matched by a marker and an UNRECOGNISED statement
//     THROWS, so a new query in the settle path fails here instead of quietly
//     getting zero rows;
//   * BEGIN snapshots the whole state and ROLLBACK restores it (SAVEPOINTs too),
//     so "a failure half-way writes nothing" is observed, not asserted;
//   * every statement is recorded, so "refused before any write" is a fact about
//     the statements actually issued.
//
// WHAT IT DOES NOT MODEL: SQL. Each branch re-implements what its statement does
// to these rows, and says which predicate it relies on with requireShape.
//
// ALSO DRIVEN THROUGH IT, because they meet an NC table: the items-split writer
// (UpdateOrderItemsSplit — its guarded write is modelled predicate by
// predicate), the admin remove-item path, and the settled-bill read
// (GetClosedBill) of an NC bill with its settlement.

import { ncFlagSignature } from "../../nc_settle";

export const RES_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
export const OUTLET_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
export const TABLE_ID = "cccccccc-3333-4333-8333-cccccccccccc";

export interface NcFixtureLine {
  id?: string;
  name: string;
  price: number;
  quantity: number;
  nc?: boolean;
  nc_id?: string;
  nc_kind?: string;
  course_hold?: boolean;
  fired_at?: string | null;
  menu_id?: string;
}

export interface NcFixtureOrder {
  id: string;
  status: number;
  created_at: string;
  items: NcFixtureLine[];
  /** Present on an order a course-fire path has split; flagged alongside items. */
  items_split?: [string, NcFixtureLine[]][];
  subtotal?: number;
  total?: number;
  nc_subtotal?: number;
}

export interface NcFixtureBill {
  id: string;
  bill_no: number;
  created_at: string;
  table_id: string;
  status: number;
  total_amt: number;
  tax_breakdown: unknown;
  round_off: number | null;
  payment_method: string | null;
  payment_splits: unknown;
  payment_proof_screenshot_url: string | null;
  waiter_confirmed_at: string | null;
  waiter_confirmed_by_username: string | null;
  admin_approved_at: string | null;
  admin_approved_by_username: string | null;
  closed_at: string | null;
  closed_by_username: string | null;
  discount_type: string | null;
  discount_value: number;
  coupon_code: string | null;
  refunded_at?: string | null;
}

export interface NcFixtureRow {
  id: string;
  created_at: string;
  outlet_id: string;
  order_id: string;
  item_id: string;
  item_name: string;
  table_id: string | null;
  nc_kind: string;
  reason: string;
  quantity: number;
  unit_price: number;
  menu_price_at_nc: number | null;
  marked_by_employee_id: string | null;
  marked_by_username: string;
  authorised_by_employee_id: string | null;
  authorised_by_username: string;
  scope: string;
  bill_id: string | null;
  settle_group: string | null;
  reversed_at: string | null;
  reversed_by_username: string | null;
  reversal_reason: string | null;
}

export interface NcFixtureState {
  table: { id: string; name: string; is_occupied: boolean; num_covers: number };
  orders: NcFixtureOrder[];
  bills: NcFixtureBill[];
  nc: NcFixtureRow[];
  tenders: { bill_id: string; amount: number; voided: boolean }[];
  loyalty_redeemed_bills: string[];
  /** Outlets.default_tax — shape (b) when it carries a "Service Charge" line. */
  default_tax: { name: string; percentage: number }[];
  service_charge_percent: number;
  /** False models a database migration 052 never reached. */
  nc_columns: boolean;
  next_bill_no: number;
  /** Makes the named statement throw, to prove the transaction rolls back. */
  fail_on?: RegExp | null;
  /** Makes the post-comp table sum non-zero (a line outside the plan still charging). */
  leak_after_comp?: number;
  /** The payment_config the settle paths resolve modes against. */
  payment_config?: unknown;
  /** Audit_logs rows the settled-bill read looks for (the settle's would-have-charged figure). */
  audit?: { action_id: string; bill_id: string; scope: string; would_have_charged: number | null; created_at: string }[];
  /**
   * Runs once, right after the items-split writer has READ its order — the
   * window in which a concurrent settle or comp can commit before it writes.
   */
  after_split_read?: (() => void) | null;
}

export function makeState(over: Partial<NcFixtureState> = {}): NcFixtureState {
  return {
    table: { id: TABLE_ID, name: "T7", is_occupied: true, num_covers: 4 },
    orders: [],
    bills: [],
    nc: [],
    tenders: [],
    loyalty_redeemed_bills: [],
    default_tax: [{ name: "SGST", percentage: 2.5 }, { name: "CGST", percentage: 2.5 }],
    service_charge_percent: 10,
    nc_columns: true,
    next_bill_no: 101,
    fail_on: null,
    leak_after_comp: 0,
    ...over,
  };
}

let state: NcFixtureState | null = null;
let snapshots: NcFixtureState[] = [];
export const statements: { sql: string; params: unknown[] }[] = [];

export function useState(next: NcFixtureState): void {
  state = next;
  snapshots = [];
  statements.length = 0;
}

export function current(): NcFixtureState {
  if (!state) {throw new Error("nc fixture: useState() was not called");}
  return state;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function requireShape(q: string, fragment: string, why: string): void {
  if (!q.toLowerCase().includes(fragment.toLowerCase())) {
    throw new Error(`nc fixture: query lost "${fragment}" — ${why}\n  ${q.slice(0, 300)}`);
  }
}

/** The stored subtotal, exactly as repriceOrderFood / AddOrder write it. */
export function storedSubtotal(o: NcFixtureOrder): number {
  if (typeof o.subtotal === "number") {return o.subtotal;}
  const s = o.items.filter((i) => i.nc !== true).reduce((a, i) => a + i.price * Math.max(1, i.quantity || 1), 0);
  return Math.round(s * 100) / 100;
}

function foodOf(o: NcFixtureOrder): Record<string, unknown> {
  const sub = storedSubtotal(o);
  return {
    items: o.items,
    ...(o.items_split ? { items_split: o.items_split } : {}),
    subtotal: sub,
    total: typeof o.total === "number" ? o.total : sub,
    ...(typeof o.nc_subtotal === "number" ? { nc_subtotal: o.nc_subtotal } : {}),
    status: "Served",
  };
}

const STILL_OWES = (status: number): boolean => ![4, 5, 7].includes(status);

const nowIso = (): string => new Date().toISOString();

function ncRowOut(r: NcFixtureRow) {
  return {
    id: r.id, created_at: new Date(r.created_at), outlet_id: r.outlet_id, order_id: r.order_id,
    item_id: r.item_id, item_name: r.item_name, table_id: r.table_id, nc_kind: r.nc_kind,
    reason: r.reason, quantity: r.quantity, unit_price: r.unit_price, menu_price_at_nc: r.menu_price_at_nc,
    value: Math.round(r.quantity * r.unit_price * 100) / 100,
    marked_by_username: r.marked_by_username, authorised_by_username: r.authorised_by_username,
    reversed_at: r.reversed_at ? new Date(r.reversed_at) : null,
    reversed_by_username: r.reversed_by_username, reversal_reason: r.reversal_reason,
  };
}

const DDL = /^(alter|create|drop|do|grant|revoke|comment|set|truncate)\b/i;

export function fixtureQuery(sql: string, params: unknown[] = []): { rows: unknown[] } {
  const q = sql.replace(/\s+/g, " ").trim();
  statements.push({ sql: q, params });
  const s = current();
  if (s.fail_on && s.fail_on.test(q)) {
    throw Object.assign(new Error(`nc fixture: injected failure on ${q.slice(0, 60)}`), { code: "XX000" });
  }

  // --- transactions ---------------------------------------------------------
  if (/^begin$/i.test(q)) { snapshots = [clone(s)]; return { rows: [] }; }
  if (/^commit$/i.test(q)) { snapshots = []; return { rows: [] }; }
  if (/^rollback$/i.test(q)) {
    const back = snapshots[0];
    if (back) { state = { ...back, fail_on: s.fail_on, leak_after_comp: s.leak_after_comp }; }
    snapshots = [];
    return { rows: [] };
  }
  if (/^savepoint /i.test(q)) { snapshots.push(clone(s)); return { rows: [] }; }
  if (/^release savepoint /i.test(q)) { snapshots.pop(); return { rows: [] }; }
  if (/^rollback to savepoint /i.test(q)) {
    const back = snapshots.pop();
    if (back) { state = { ...back, fail_on: s.fail_on, leak_after_comp: s.leak_after_comp }; }
    return { rows: [] };
  }
  if (DDL.test(q)) {
    // A runtime without DDL rights is modelled as a refused ALTER.
    if (!s.nc_columns && /"OrderItemNonChargeable"/.test(q)) {
      throw Object.assign(new Error("must be owner of table OrderItemNonChargeable"), { code: "42501" });
    }
    return { rows: [] };
  }
  if (/^select set_config\(/i.test(q)) {return { rows: [] };}

  // --- identity -------------------------------------------------------------
  if (/from "Restaurant" r/i.test(q)) {
    return { rows: [{
      res_id: RES_ID, outlet_id: OUTLET_ID, restaurant_slug: "zztest-nc", restaurant_name: "ZZTEST NC",
      restaurant_main_office_add: null, restaurant_logo_url: null, timezone: "Asia/Kolkata",
    }] };
  }
  if (/select payment_config from "Restaurant"/i.test(q)) {return { rows: [{ payment_config: s.payment_config ?? null }] };}
  if (/select service_charge from "Restaurant"/i.test(q)) {return { rows: [{ service_charge: s.service_charge_percent }] };}

  // --- the catalogue --------------------------------------------------------
  if (/from information_schema\.columns where table_schema = 'public' and table_name = 'OrderItemNonChargeable'/i.test(q)) {
    return { rows: [{ n: s.nc_columns ? 3 : 0 }] };
  }

  // --- the acting employee (the ordinary settle resolves one) ---------------
  if (/from "Login" l join "Employees" e/i.test(q)) {
    return { rows: [{ id: "e1111111-1111-4111-8111-111111111111", username: String(params[2]), fname: "Cashier", lname: "One", role_primary: "cashier" }] };
  }
  if (/^select discount_type, discount_value from "Bills" where table_id = \$1/i.test(q)) {
    const b = [...s.bills].filter((x) => x.closed_at === null).sort((a, z) => z.created_at.localeCompare(a.created_at))[0];
    return { rows: b ? [{ discount_type: b.discount_type, discount_value: b.discount_value }] : [] };
  }

  // --- the menu (advisory price snapshot; nothing on the menu here) ----------
  if (/from "Menu" m/i.test(q)) {return { rows: [] };}
  if (/^insert into "Actions"/i.test(q)) {return { rows: [] };}

  // --- "Orders" ---------------------------------------------------------------
  if (/^select table_id, status from "Orders" where id = \$1 and res_id = \$2 and outlet_id = \$3 limit 1$/i.test(q)) {
    const o = s.orders.find((x) => x.id === params[0]);
    return { rows: o ? [{ table_id: TABLE_ID, status: o.status }] : [] };
  }
  if (/^select table_id from "Orders" where id = \$1 and res_id = \$2 and outlet_id = \$3 limit 1$/i.test(q)) {
    const o = s.orders.find((x) => x.id === params[0]);
    return { rows: o ? [{ table_id: TABLE_ID }] : [] };
  }
  if (/^select status from "Orders" where id = \$1 and res_id = \$2 and outlet_id = \$3 limit 1$/i.test(q)) {
    const o = s.orders.find((x) => x.id === params[0]);
    return { rows: o ? [{ status: o.status }] : [] };
  }
  if (/^select id, food, status from "Orders" where res_id = \$1 and outlet_id = \$2 and table_id = \$3 and /i.test(q)) {
    requireShape(q, "for update", "the orders are locked FIRST, which is what turns a double tap into `already`");
    requireShape(q, "coalesce(status::text, '1') not in", "only the orders that still owe are comped");
    return { rows: s.orders.filter((o) => STILL_OWES(o.status)).map((o) => ({ id: o.id, food: foodOf(o), status: o.status })) };
  }
  if (/^select food, status from "Orders" where res_id = \$1 and outlet_id = \$2 and table_id = \$3$/i.test(q)) {
    // sumOrderTotalsForTable / tableBillLines — every order; the reducer filters.
    return { rows: s.orders.map((o) => {
      const f = foodOf(o);
      if (s.leak_after_comp && STILL_OWES(o.status) && storedSubtotal(o) === 0 && o.items.some((i) => i.nc)) {
        f.subtotal = s.leak_after_comp; f.total = s.leak_after_comp;
      }
      return { food: f, status: o.status };
    }) };
  }
  // --- the items-split writer (UpdateOrderItemsSplit) -------------------------
  if (/^select food, table_id from "Orders" where id = \$1 and res_id = \$2 and outlet_id = \$3 limit 1$/i.test(q)) {
    const o = s.orders.find((x) => x.id === params[0]);
    const rows = o ? [{ food: clone(foodOf(o)), table_id: TABLE_ID }] : [];
    const hook = s.after_split_read;
    if (hook) { s.after_split_read = null; hook(); }
    return { rows };
  }
  if (/^select column_name from information_schema\.columns where table_schema = 'public' and table_name = 'Orders' and column_name = 'barked_at'$/i.test(q)) {
    return { rows: [{ column_name: "barked_at" }] };
  }
  if (/^select barked_at from "Orders" where id = \$1 and res_id = \$2 and outlet_id = \$3 limit 1$/i.test(q)) {
    const o = s.orders.find((x) => x.id === params[0]);
    return { rows: o ? [{ barked_at: new Date("2026-09-16T09:00:00Z") }] : [] };
  }
  if (/^update "Orders" set food = \$1::json, status = \$2 where id = \$3 and res_id = \$4 and outlet_id = \$5 /i.test(q)) {
    // The guarded write: each predicate the statement names is applied here.
    requireShape(q, "coalesce(status::text, '1') not in", "a settled or cancelled order is never rewritten");
    requireShape(q, "coalesce(status::text, '1') <> '6'", "an order awaiting payment approval is frozen");
    requireShape(q, "string_agg(coalesce(x ->> 'nc_id', ''), ',' order by coalesce(x ->> 'nc_id', '') collate \"C\")", "the comps it was built on are the comps still there");
    requireShape(q, "where x -> 'nc' = 'true'::jsonb", "only a real boolean flag is a comp (isNonChargeableLine)");
    requireShape(q, "), '') = $6 returning id", "the stored comps must EQUAL the ones the write was built from");
    requireShape(q, "returning id", "a write that matched nothing must be seen");
    const o = s.orders.find((x) => x.id === params[2]);
    if (!o || !STILL_OWES(o.status) || o.status === 6 || ncFlagSignature(o.items) !== params[5]) {return { rows: [] };}
    const f = JSON.parse(String(params[0])) as Record<string, unknown>;
    o.items = f.items as NcFixtureLine[];
    o.items_split = (f.items_split as [string, NcFixtureLine[]][] | undefined) ?? undefined;
    o.subtotal = Number(f.subtotal);
    o.total = Number(f.total);
    o.nc_subtotal = typeof f.nc_subtotal === "number" ? f.nc_subtotal : undefined;
    o.status = Number(params[1]);
    return { rows: [{ id: o.id }] };
  }

  // --- the admin remove-item path (RemoveBillItem) ---------------------------
  if (/^select id from "Tables" where res_id = \$1 and outlet_id = \$2 and lower\(table_name\) = lower\(\$3\)/i.test(q)) {
    return { rows: String(params[2]).toLowerCase() === s.table.name.toLowerCase() ? [{ id: TABLE_ID }] : [] };
  }
  if (/^select admin_approved_at from "Bills" where table_id = \$1 and res_id = \$2 and outlet_id = \$3 and closed_at is null/i.test(q)) {
    const b = [...s.bills].filter((x) => x.closed_at === null).sort((a, z) => z.created_at.localeCompare(a.created_at))[0];
    return { rows: b ? [{ admin_approved_at: b.admin_approved_at }] : [] };
  }
  if (/^select id, food(, status, barked_at)? from "Orders" where res_id = \$1 and outlet_id = \$2 and table_id = \$3 and .* order by created_at asc$/i.test(q)) {
    requireShape(q, "coalesce(status::text, '1') not in", "only the orders that still owe lose a line");
    return { rows: s.orders.filter((o) => STILL_OWES(o.status)).map((o) => ({ id: o.id, food: clone(foodOf(o)), status: o.status, barked_at: null })) };
  }
  if (/^update "Bills" set total_amt = \$1, round_off = null where id = \$2 and res_id = \$3 and outlet_id = \$4$/i.test(q)) {
    const b = s.bills.find((x) => x.id === params[1]);
    if (b) { b.total_amt = Number(params[0]); b.round_off = null; }
    return { rows: [] };
  }

  // --- the settled-bill read (GetClosedBill) ---------------------------------
  if (/^select b\.id, b\.bill_no, b\.status, b\.reason, b\.table_id, t\.table_name,/i.test(q)) {
    requireShape(q, "where b.id = $1", "the detail reads ONE bill");
    const b = s.bills.find((x) => x.id === params[0]);
    return { rows: b ? [{
      id: b.id, bill_no: String(b.bill_no), status: b.status, reason: null, table_id: b.table_id, table_name: s.table.name,
      total_amt: b.total_amt, tax_breakdown: b.tax_breakdown, round_off: b.round_off, payment_method: b.payment_method,
      payment_splits: b.payment_splits, payment_proof_screenshot_url: b.payment_proof_screenshot_url,
      discount_type: b.discount_type, discount_value: b.discount_value, discount_applied_at: null, coupon_code: b.coupon_code,
      waiter_confirmed_at: b.waiter_confirmed_at ? new Date(b.waiter_confirmed_at) : null,
      waiter_confirmed_by_username: b.waiter_confirmed_by_username,
      admin_approved_at: b.admin_approved_at ? new Date(b.admin_approved_at) : null,
      admin_approved_by_username: b.admin_approved_by_username,
      closed_at: b.closed_at ? new Date(b.closed_at) : null, closed_by_username: b.closed_by_username,
      refunded_at: null, refunded_by_username: null, refund_amount: 0, refund_reason: null, refund_ref: null,
      created_at: new Date(b.created_at), created_by_fname: "Cashier", created_by_lname: "One",
      session_covers: 4, seated_at: null, left_at: null,
    }] : [] };
  }
  if (/^select id, created_at, status, food from "Orders" o where res_id = \$1 and outlet_id = \$2 and table_id = \$3 and coalesce\(status::text, '1'\) = any\(\$4::text\[\]\)/i.test(q)) {
    // The session window is not modelled: the fixture holds one session. Its
    // shape is: the window is read on the order's ARRIVAL (settledWindowSql).
    requireShape(q, "coalesce(o.updated_at, o.created_at) > $5::timestamptz", "the window is read on the arrival");
    const codes = (params[3] as string[]).map(String);
    return { rows: s.orders.filter((o) => codes.includes(String(o.status)))
      .map((o) => ({ id: o.id, created_at: new Date(o.created_at), status: String(o.status), food: clone(foodOf(o)) })) };
  }
  if (/from information_schema\.columns/i.test(q) && /'customer_gstin'/i.test(q)) {return { rows: [] };}
  if (/^select nc_kind, authorised_by_username, marked_by_username, reason, value, scope from "OrderItemNonChargeable"/i.test(q)) {
    requireShape(q, "reversed_at is null", "a reversed comp is not part of the settlement");
    requireShape(q, "(bill_id = $2 or order_id = any($3::uuid[]))", "the bill's own rows AND its orders' item comps");
    const ids = params[2] as string[];
    return { rows: s.nc.filter((r) => r.reversed_at === null && (r.bill_id === params[1] || ids.includes(r.order_id)))
      .map((r) => ({ ...ncRowOut(r), scope: r.scope })) };
  }
  if (/^select additional_details->>'would_have_charged' as v from "Audit_logs"/i.test(q)) {
    requireShape(q, "additional_details->>'scope' = 'bill'", "only the settle's own line carries the figure");
    const hit = (s.audit ?? [])
      .filter((a) => a.action_id === params[1] && a.bill_id === params[2] && a.scope === "bill")
      .sort((a, z) => z.created_at.localeCompare(a.created_at))[0];
    return { rows: hit ? [{ v: hit.would_have_charged === null ? null : String(hit.would_have_charged) }] : [] };
  }

  if (/^select count\(\*\)::int as n from "Orders" where res_id = \$1 and outlet_id = \$2 and table_id = \$3 and /i.test(q)) {
    return { rows: [{ n: s.orders.filter((o) => STILL_OWES(o.status)).length }] };
  }
  if (/^update "Orders" set food = \$4::json where id = \$1 and res_id = \$2 and outlet_id = \$3$/i.test(q)) {
    const o = s.orders.find((x) => x.id === params[0]);
    if (o) {
      const f = JSON.parse(String(params[3])) as Record<string, unknown>;
      o.items = f.items as NcFixtureLine[];
      o.items_split = (f.items_split as [string, NcFixtureLine[]][] | undefined) ?? undefined;
      o.subtotal = Number(f.subtotal);
      o.total = Number(f.total);
      o.nc_subtotal = typeof f.nc_subtotal === "number" ? f.nc_subtotal : undefined;
    }
    return { rows: [] };
  }
  if (/^select food from "Orders" where id = \$1 and res_id = \$2 and outlet_id = \$3 limit 1 for update$/i.test(q)) {
    const o = s.orders.find((x) => x.id === params[0]);
    return { rows: o ? [{ food: foodOf(o) }] : [] };
  }
  // updateOrderWorkflowStatus, table form: every still-owing order moves together.
  if (/^update "Orders" set status = \$1, food = jsonb_set\(.*\) where table_id = \$3 and res_id = \$4 and outlet_id = \$5 and /i.test(q)) {
    requireShape(q, "coalesce(status::text, '1') not in", "a settled session's orders must not be re-opened");
    for (const o of s.orders) { if (STILL_OWES(o.status)) {o.status = Number(params[0]);} }
    return { rows: [] };
  }
  // ReopenBill's restore of the session's settled orders.
  if (/^update "Orders" set status = (\d), food = jsonb_set\(.*\) where res_id = \$1 and outlet_id = \$2 and table_id = \$3 and coalesce\(status::text, '1'\) in \('4', '7'\)/i.test(q)) {
    const to = Number(/set status = (\d)/i.exec(q)?.[1]);
    const out: { id: string }[] = [];
    for (const o of s.orders) { if (o.status === 4 || o.status === 7) { o.status = to; out.push({ id: o.id }); } }
    return { rows: out };
  }

  // --- "Tables" -----------------------------------------------------------------
  if (/^select table_name from "Tables" where id = \$1 and res_id = \$2 and outlet_id = \$3 limit 1$/i.test(q)) {
    return { rows: [{ table_name: s.table.name }] };
  }
  if (/^update "Tables" set is_occupied = false, num_covers = 1, linked_order_id = null, order_otp = null where id = \$1/i.test(q)) {
    s.table.is_occupied = false; s.table.num_covers = 1;
    return { rows: [] };
  }
  // ReopenBill's "has this table a new party?" — seated, or owing again.
  if (/^select t\.table_name, \(\(coalesce\(t\.is_deleted, false\) = false and coalesce\(t\.is_occupied, false\)\) or exists \(select 1 from "Orders" o/i.test(q)) {
    requireShape(q, "coalesce(o.status::text, '1') not in", "a new party is one that still owes, by the owing rule");
    return { rows: [{ table_name: s.table.name, busy: s.table.is_occupied || s.orders.some((o) => STILL_OWES(o.status)) }] };
  }
  if (/^update "Tables" set is_occupied = true where id = \$1/i.test(q)) {
    s.table.is_occupied = true;
    return { rows: [{ table_name: s.table.name }] };
  }
  if (/^update "Tables" set is_deleted = true, is_occupied = false, order_otp = null where id = \$1 and res_id = \$2 and outlet_id = \$3 and coalesce\(is_virtual, false\) = true$/i.test(q)) {
    return { rows: [] }; // the fixture table is a real table, never a virtual one
  }
  if (/from "Bookings"/i.test(q)) {return { rows: [] };}
  if (/"TableAssignments"|"Table_assignments"|table_assignments/i.test(q)) {return { rows: [] };}
  if (/^select coalesce\(is_virtual, false\) as is_virtual/i.test(q) || /is_virtual/i.test(q) && /^select/i.test(q)) {
    return { rows: [{ is_virtual: false }] };
  }

  // --- "Outlets" / charge configuration ---------------------------------------
  if (/^select default_tax from "Outlets" where id = \$1 and res_id = \$2 limit 1$/i.test(q)) {
    return { rows: [{ default_tax: s.default_tax }] };
  }
  if (/^update "Outlets" set bill_seq = coalesce\(bill_seq, 0\) \+ 1/i.test(q)) {
    const n = s.next_bill_no; s.next_bill_no += 1;
    return { rows: [{ bill_seq: n }] };
  }
  if (/from "ServiceChargeWaivers"/i.test(q)) {return { rows: [] };}

  // --- "Bills" ----------------------------------------------------------------
  const openBill = (): NcFixtureBill | undefined =>
    [...s.bills].filter((b) => b.closed_at === null).sort((a, z) => z.created_at.localeCompare(a.created_at))[0];
  if (/^select id from "Bills" where table_id = \$1 and res_id = \$2 and outlet_id = \$3 and closed_at is null order by created_at desc limit 1$/i.test(q)) {
    const b = openBill();
    return { rows: b ? [{ id: b.id }] : [] };
  }
  if (/^select id, bill_no::text as bill_no, waiter_confirmed_at, discount_value, coupon_code from "Bills"/i.test(q)) {
    requireShape(q, "closed_at is null", "only the OPEN bill is settled");
    requireShape(q, "for update", "the bill is locked before its tenders and discount are judged");
    const b = openBill();
    return { rows: b ? [{
      id: b.id, bill_no: String(b.bill_no), waiter_confirmed_at: b.waiter_confirmed_at,
      discount_value: b.discount_value, coupon_code: b.coupon_code,
    }] : [] };
  }
  if (/^select id, bill_no::text as bill_no, payment_method, closed_at from "Bills"/i.test(q)) {
    const b = [...s.bills].sort((a, z) => z.created_at.localeCompare(a.created_at))[0];
    return { rows: b ? [{ id: b.id, bill_no: String(b.bill_no), payment_method: b.payment_method, closed_at: b.closed_at }] : [] };
  }
  if (/^select bill_no::text as bill_no from "Bills" where id = \$1$/i.test(q)) {
    const b = s.bills.find((x) => x.id === params[0]);
    return { rows: b ? [{ bill_no: String(b.bill_no) }] : [] };
  }
  if (/^insert into "Bills" \(id, created_at, res_id, outlet_id, table_id, emp_id, status, order_id, total_amt, tax_breakdown, bill_no\)/i.test(q)) {
    if (openBill()) {return { rows: [] };} // bills_one_open_per_table
    const b: NcFixtureBill = {
      id: String(params[0]), bill_no: Number(params[7]), created_at: nowIso(), table_id: TABLE_ID, status: 1,
      total_amt: Number(params[6]), tax_breakdown: [], round_off: null, payment_method: null, payment_splits: null,
      payment_proof_screenshot_url: null, waiter_confirmed_at: null, waiter_confirmed_by_username: null,
      admin_approved_at: null, admin_approved_by_username: null, closed_at: null, closed_by_username: null,
      discount_type: null, discount_value: 0, coupon_code: null,
    };
    s.bills.push(b);
    return { rows: /returning id, bill_no/i.test(q) ? [{ id: b.id, bill_no: String(b.bill_no) }] : [{ id: b.id }] };
  }
  if (/^update "Bills" set payment_method = \$1, payment_splits = null, payment_proof_screenshot_url = null, total_amt = 0/i.test(q)) {
    requireShape(q, "closed_at is null", "a closed bill is never re-stamped");
    const b = s.bills.find((x) => x.id === params[2] && x.closed_at === null && x.status !== 3);
    if (!b) {return { rows: [] };}
    const at = nowIso();
    Object.assign(b, {
      payment_method: params[0], payment_splits: null, payment_proof_screenshot_url: null, total_amt: 0,
      tax_breakdown: [], round_off: Number(params[5]),
      waiter_confirmed_at: at, waiter_confirmed_by_username: params[1],
      admin_approved_at: at, admin_approved_by_username: params[1],
      closed_at: at, closed_by_username: params[1], status: 2,
    });
    return { rows: [{ id: b.id }] };
  }
  // ConfirmBillPaymentByWaiter's stamp.
  if (/^update "Bills" set payment_method = \$1, payment_proof_screenshot_url = \$2, waiter_confirmed_at = now\(\)/i.test(q)) {
    const b = s.bills.find((x) => x.id === params[3] && x.status !== 3);
    if (!b) {return { rows: [] };}
    Object.assign(b, {
      payment_method: params[0], payment_proof_screenshot_url: params[1],
      waiter_confirmed_at: nowIso(), waiter_confirmed_by_username: params[2],
      total_amt: Number(params[6]), tax_breakdown: JSON.parse(String(params[7])),
      payment_splits: params[8] === null ? null : JSON.parse(String(params[8])), round_off: Number(params[9]), status: 1,
    });
    return { rows: [{ id: b.id }] };
  }
  // RefundBill's read, by id.
  if (/^select id, total_amt, payment_method, payment_proof_screenshot_url, refunded_at, refund_ref from "Bills" where id = \$1/i.test(q)) {
    const b = s.bills.find((x) => x.id === params[0]);
    return { rows: b ? [{
      id: b.id, total_amt: b.total_amt, payment_method: b.payment_method,
      payment_proof_screenshot_url: b.payment_proof_screenshot_url, refunded_at: b.refunded_at ?? null, refund_ref: null,
    }] : [] };
  }
  // ApproveBillPaymentByAdmin's read of the open bill.
  if (/^select payment_method, payment_proof_screenshot_url, payment_splits from "Bills" where table_id = \$1/i.test(q)) {
    requireShape(q, "closed_at is null", "approval reads the OPEN bill");
    const b = openBill();
    return { rows: b ? [{ payment_method: b.payment_method, payment_proof_screenshot_url: b.payment_proof_screenshot_url, payment_splits: b.payment_splits }] : [] };
  }
  // ReopenBill.
  if (/^select b\.id, b\.bill_no, b\.table_id, b\.total_amt, b\.payment_method, b\.created_at, b\.closed_at/i.test(q)) {
    const b = s.bills.find((x) => x.id === params[0]);
    return { rows: b ? [{
      id: b.id, bill_no: String(b.bill_no), table_id: b.table_id, total_amt: b.total_amt, payment_method: b.payment_method,
      created_at: new Date(b.created_at), closed_at: b.closed_at ? new Date(b.closed_at) : null,
      refunded_at: b.refunded_at ?? null, waiter_confirmed_at: b.waiter_confirmed_at ? new Date(b.waiter_confirmed_at) : null,
      within_window: true, window_min: 240,
    }] : [] };
  }
  if (/^select id from "Bills" where table_id = \$1 and res_id = \$2 and outlet_id = \$3 and closed_at is null limit 1$/i.test(q)) {
    const b = openBill();
    return { rows: b ? [{ id: b.id }] : [] };
  }
  if (/^update "Bills" set closed_at = null, closed_by_username = null, admin_approved_at = null/i.test(q)) {
    const b = s.bills.find((x) => x.id === params[0]);
    if (!b) {return { rows: [] };}
    Object.assign(b, { closed_at: null, closed_by_username: null, admin_approved_at: null, admin_approved_by_username: null, status: 1 });
    return { rows: [{ id: b.id, waiter_confirmed_at: b.waiter_confirmed_at, status: 1, created_at: new Date(b.created_at) }] };
  }
  if (/^select coalesce\(max\(closed_at\), 'epoch'::timestamptz\) as prev_closed from "Bills"/i.test(q)) {
    return { rows: [{ prev_closed: new Date(0) }] };
  }
  if (/^update "Bills" set payment_method = null, payment_splits = null, payment_proof_screenshot_url = null, waiter_confirmed_at = null/i.test(q)) {
    const b = s.bills.find((x) => x.id === params[0]);
    if (b) {
      Object.assign(b, {
        payment_method: null, payment_splits: null, payment_proof_screenshot_url: null,
        waiter_confirmed_at: null, waiter_confirmed_by_username: null,
        total_amt: Number(params[3]), tax_breakdown: [], round_off: null,
      });
    }
    return { rows: [] };
  }

  // --- tenders and loyalty (read inside the settle, under a savepoint) -------
  if (/^select count\(\*\)::int as n, coalesce\(sum\(amount\), 0\) as total from "BillTenders"/i.test(q)) {
    requireShape(q, "voided_at is null", "a voided tender is not money on the bill");
    const live = s.tenders.filter((t) => t.bill_id === params[1] && !t.voided);
    return { rows: [{ n: live.length, total: live.reduce((a, t) => a + t.amount, 0) }] };
  }
  if (/^select count\(\*\)::int as n from "LoyaltyLedger"/i.test(q)) {
    return { rows: [{ n: s.loyalty_redeemed_bills.includes(String(params[1])) ? 1 : 0 }] };
  }

  // --- "OrderItemNonChargeable" -----------------------------------------------
  if (/^insert into "OrderItemNonChargeable"/i.test(q)) {
    requireShape(q, "'bill',$17,$18", "a settle's rows are scope 'bill' and name their bill and settle group");
    if (!s.nc_columns) {throw Object.assign(new Error('column "scope" does not exist'), { code: "42703" });}
    const [id, , outlet, orderId, itemId, name, tableId, kind, reason, qty, unit, menuPrice, byId, by, authId, auth, billId, group] = params;
    if (s.nc.some((r) => r.order_id === orderId && r.item_id === itemId && r.reversed_at === null)) {
      throw Object.assign(new Error("duplicate key value violates unique constraint \"orderitemnc_live_line_uidx\""), { code: "23505" });
    }
    const row: NcFixtureRow = {
      id: String(id), created_at: nowIso(), outlet_id: String(outlet), order_id: String(orderId), item_id: String(itemId),
      item_name: String(name), table_id: tableId === null ? null : String(tableId), nc_kind: String(kind), reason: String(reason),
      quantity: Number(qty), unit_price: Number(unit), menu_price_at_nc: menuPrice === null ? null : Number(menuPrice),
      marked_by_employee_id: byId === null ? null : String(byId), marked_by_username: String(by),
      authorised_by_employee_id: authId === null ? null : String(authId), authorised_by_username: String(auth),
      scope: "bill", bill_id: String(billId), settle_group: String(group),
      reversed_at: null, reversed_by_username: null, reversal_reason: null,
    };
    // 034's CHECKs and 052's.
    if (!(row.quantity > 0) || row.unit_price < 0 || !row.reason.trim() || !row.authorised_by_username.trim()) {
      throw Object.assign(new Error("new row violates check constraint"), { code: "23514" });
    }
    s.nc.push(row);
    return { rows: [ncRowOut(row)] };
  }
  if (/^select .* from "OrderItemNonChargeable" where res_id = \$1 and order_id = any\(\$2::uuid\[\]\) and reversed_at is null/i.test(q)) {
    const ids = params[1] as string[];
    return { rows: s.nc.filter((r) => ids.includes(r.order_id) && r.reversed_at === null).map(ncRowOut) };
  }
  if (/^select .* from "OrderItemNonChargeable" where res_id = \$1 and bill_id = \$2 and reversed_at is null order by created_at asc$/i.test(q)) {
    return { rows: s.nc.filter((r) => r.bill_id === params[1] && r.reversed_at === null).map(ncRowOut) };
  }
  if (/^select settle_group from "OrderItemNonChargeable" where res_id = \$1 and bill_id = \$2/i.test(q)) {
    const r = s.nc.find((x) => x.bill_id === params[1] && x.reversed_at === null);
    return { rows: r ? [{ settle_group: r.settle_group }] : [] };
  }
  if (/^update "OrderItemNonChargeable" set reversed_at = now\(\), reversed_by_username = \$3, reversal_reason = \$4 where res_id = \$1 and bill_id = \$2 and scope = 'bill' and reversed_at is null/i.test(q)) {
    const out: unknown[] = [];
    for (const r of s.nc) {
      if (r.bill_id === params[1] && r.scope === "bill" && r.reversed_at === null) {
        r.reversed_at = nowIso(); r.reversed_by_username = String(params[2]); r.reversal_reason = String(params[3]);
        out.push({ id: r.id, order_id: r.order_id, value: Math.round(r.quantity * r.unit_price * 100) / 100, settle_group: r.settle_group });
      }
    }
    return { rows: out };
  }

  throw new Error(`nc fixture: unstubbed SQL — ${q.slice(0, 400)}`);
}

// A jest.mock factory is hoisted above imports and may not close over module
// scope, so the query function is reached through globalThis.
interface FixtureGlobal {
  __ncFixtureQuery?: (sql: string, params?: unknown[]) => { rows: unknown[] };
}
(globalThis as unknown as FixtureGlobal).__ncFixtureQuery = fixtureQuery;

export { requireShape, foodOf, STILL_OWES, nowIso, ncRowOut, clone };
