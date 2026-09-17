// In-memory floor + a fake `pg` Pool, so the REAL next-party paths in
// database_supabase.ts (EnsureNextPartyTable, the retirement hooks, the money
// guard's read) AND the real settle paths they sit beside (GetBillForTable,
// ApproveBillPaymentByAdmin, CloseBillByOrder, FinalizeOnlinePayment,
// ReleaseTable, MergeTableBills, GetTables) run without a database. Same shape
// and reasoning as table_move_fixtures.ts, whose trigger model this copies.
//
// WHAT THIS FIXTURE MODELS THAT THE OTHERS DO NOT
// -----------------------------------------------
// 1) TWO CONNECTIONS AND A ROW LOCK. "Two tills print table 12 at once and one
//    sibling comes out" is a claim about `select … for update`, so every
//    connect() here is its own client, and a `for update` on a "Tables" row that
//    another client's open transaction already locked WAITS until that
//    transaction ends. `lockRows = false` switches the lock off so a test can
//    prove the unique index is the backstop.
// 2) THE UNIQUE PARTIAL INDEX tables_one_live_party — a second LIVE row for the
//    same (outlet, root, party number) throws 23505, as Postgres would.
// 3) MIGRATION 053 ABSENT. With `columnsPresent = false` the information_schema
//    probe answers 0, the DDL answers 42501 (a runtime role that cannot add the
//    columns), and ANY statement naming parent_table_id or party_seq throws
//    42703 — so a reader that names the columns without asking first fails
//    loudly here, exactly as it would in production.
// 4) THE NC LEDGER (migration 052), so SettleBillAsNonChargeable and the
//    re-open that undoes it run over the SAME floor as the next-party seats —
//    the combination neither feature's own fixture can reach (nc_settle_fixture
//    has one table and no 053; this one had no 052).
//
// WHAT IT DOES NOT MODEL: RLS, and rollback under concurrency (a ROLLBACK
// restores the whole store to the snapshot its BEGIN took; no test here rolls
// back while another client is mid-transaction).
//
// Dispatch THROWS on any unrecognised statement, so a path that starts issuing
// a new query fails loudly rather than silently receiving zero rows.

import { orderArrivedAt } from "../order_moves";

export const RES_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
export const OUTLET_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
export const OTHER_OUTLET_ID = "cccccccc-3333-4333-8333-cccccccccccc";
export const SLUG = "ggv";

export interface TableFix {
  id: string;
  outlet_id: string;
  table_name: string;
  capacity: number;
  max_capacity: number | null;
  section: string | null;
  is_occupied: boolean;
  num_covers: number;
  linked_order_id: string | null;
  order_otp: string | null;
  is_deleted: boolean;
  is_virtual: boolean;
  parent_table_id: string | null;
  party_seq: number | null;
  created_at: string;
}

export interface OrderFix {
  id: string;
  outlet_id: string;
  table_id: string;
  food: Record<string, unknown>;
  /** '1' new … '4' paid, '5' cancelled, '6' payment pending, '7' closed. */
  status: string;
  created_at: string;
}

export interface BillFix {
  id: string;
  outlet_id: string;
  table_id: string;
  status: number;
  bill_no: string | null;
  total_amt: number;
  tax_breakdown: unknown;
  round_off: number | null;
  created_at: string;
  closed_at: string | null;
  closed_by_username: string | null;
  waiter_confirmed_at: string | null;
  admin_approved_at: string | null;
  admin_approved_by_username: string | null;
  payment_method: string | null;
  payment_proof_screenshot_url: string | null;
  discount_type: string | null;
  discount_value: number;
}

export interface SessionFix {
  id: string;
  table_id: string;
  table_name: string;
  covers: number;
  seated_at: string;
  left_at: string | null;
}

export interface BookingFix {
  outlet_id: string;
  table_id: string;
  /** The JSON slot text decodeSlot reads. */
  slot: string;
  created_at: string;
}

export interface PrintJobFix {
  /** Absent on rows seeded before 2.0.2's tests; addPrint gives one. */
  id?: string;
  outlet_id: string;
  bill_id: string;
  created_at: string;
  kind: string;
  status: string;
  /** Migration 055: what the paper said. Null = not recorded. */
  bill_digest?: string | null;
  lines_digest?: string | null;
  bill_grand_total?: number | null;
  table_name?: string | null;
}

/** One "OrderItemNonChargeable" row, as far as a settle-as-NC and its re-open use it. */
export interface NcRowFix {
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
  marked_by_username: string;
  authorised_by_username: string;
  scope: string;
  bill_id: string | null;
  settle_group: string | null;
  reversed_at: string | null;
  reversed_by_username: string | null;
  reversal_reason: string | null;
}

interface Store {
  tables: TableFix[];
  orders: OrderFix[];
  bills: BillFix[];
  sessions: SessionFix[];
  printJobs: PrintJobFix[];
  nc: NcRowFix[];
  assignments: { table_id: string; employee_id: string }[];
  bookings: BookingFix[];
  /** Outlets.default_tax, verbatim. */
  taxes: unknown;
  /** "Restaurant".service_charge — the restaurant_percent leg. */
  scPct: number;
  billSeq: number;
  nextId: number;
  /** The database's now(), advanced by tick(). */
  nowMs: number;
  columnsPresent: boolean;
  /** Migration 055's four "PrintJobs" columns (client items 1 and 2). */
  paperColumnsPresent: boolean;
  lockRows: boolean;
  failOn: string | null;
  log: string[];
}

type Snapshot = Omit<Store, "log" | "failOn" | "columnsPresent" | "paperColumnsPresent" | "lockRows">;

let store: Store = freshStore();

function freshStore(): Store {
  return {
    tables: [], orders: [], bills: [], sessions: [], printJobs: [], nc: [], assignments: [], bookings: [],
    // Outlets.default_tax as the shipped seed stores it (000_base_schema.sql).
    taxes: { SGST: 2.5, CGST: 2.5 },
    scPct: 0,
    billSeq: 100,
    nextId: 1,
    nowMs: Date.parse("2026-09-16T08:00:00.000Z"),
    columnsPresent: true,
    paperColumnsPresent: true,
    lockRows: true,
    failOn: null,
    log: [],
  };
}

export function resetStore(): void {
  store = freshStore();
  locks.clear();
  waiters.clear();
}

export function setColumnsPresent(present: boolean): void { store.columnsPresent = present; }
/** Model a database without migration 055 (and a runtime that cannot add it). */
export function setPaperColumnsPresent(present: boolean): void { store.paperColumnsPresent = present; }
export function setRowLocking(on: boolean): void { store.lockRows = on; }
export function setServiceChargePercent(pct: number): void { store.scPct = pct; }
export function failNextStatementContaining(needle: string | null): void { store.failOn = needle; }

/** The database clock. Every now() the SQL asks for is this instant. */
export const nowIso = (): string => new Date(store.nowMs).toISOString();
export function tick(minutes: number): void { store.nowMs += Math.round(minutes * 60_000); }

const nid = (prefix: string): string => {
  // uuid-shaped, because `any($3::uuid[])` and isUuid() care.
  const n = String(store.nextId++).padStart(12, "0");
  return `${prefix.padEnd(8, "0").slice(0, 8)}-0000-4000-8000-${n}`;
};

function snapshot(): Snapshot {
  return {
    tables: store.tables.map((r) => ({ ...r })),
    orders: store.orders.map((r) => ({ ...r, food: { ...r.food } })),
    bills: store.bills.map((r) => ({ ...r })),
    sessions: store.sessions.map((r) => ({ ...r })),
    printJobs: store.printJobs.map((r) => ({ ...r })),
    nc: store.nc.map((r) => ({ ...r })),
    assignments: store.assignments.map((r) => ({ ...r })),
    bookings: store.bookings.map((r) => ({ ...r })),
    taxes: store.taxes,
    scPct: store.scPct,
    billSeq: store.billSeq,
    nextId: store.nextId,
    nowMs: store.nowMs,
  };
}

function restore(s: Snapshot): void {
  Object.assign(store, s);
}

// --- seeding ---------------------------------------------------------------

export function addTable(t: Partial<TableFix> & { table_name: string }): TableFix {
  const row: TableFix = {
    id: nid("7ab1e000"),
    outlet_id: OUTLET_ID,
    capacity: 4,
    max_capacity: null,
    section: "Main",
    is_occupied: false,
    num_covers: 1,
    linked_order_id: null,
    order_otp: null,
    is_deleted: false,
    is_virtual: false,
    parent_table_id: null,
    party_seq: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...t,
  };
  store.tables.push(row);
  if (row.is_occupied) {
    store.sessions.push({
      id: nid("5e551000"), table_id: row.id, table_name: row.table_name,
      covers: Math.max(1, row.num_covers), seated_at: nowIso(), left_at: null,
    });
  }
  return row;
}

/** Seat a party the way OccupyTable does: an UPDATE, so the trigger fires. */
export function seat(tableName: string, covers: number): TableFix {
  const t = liveTable(tableName);
  const before = { ...t };
  t.is_occupied = true;
  t.num_covers = covers;
  fireSessionTrigger(before, t);
  return { ...t };
}

export function addOrder(tableName: string, subtotal: number, over: Partial<OrderFix> = {}): OrderFix {
  const t = liveTable(tableName);
  const row: OrderFix = {
    id: nid("0de70000"),
    outlet_id: t.outlet_id,
    table_id: t.id,
    food: {
      table: t.table_name, subtotal, total: subtotal,
      items: [{ id: nid("1e3a0000"), name: `Dish on ${t.table_name}`, price: subtotal, quantity: 1 }],
    },
    status: "2",
    created_at: nowIso(),
    ...over,
  };
  store.orders.push(row);
  return row;
}

export function addBill(tableName: string, over: Partial<BillFix> = {}): BillFix {
  const t = liveTable(tableName);
  const row: BillFix = {
    id: nid("b1110000"),
    outlet_id: t.outlet_id,
    table_id: t.id,
    status: 1,
    bill_no: String(++store.billSeq),
    total_amt: 0,
    tax_breakdown: [],
    round_off: null,
    created_at: nowIso(),
    closed_at: null,
    closed_by_username: null,
    waiter_confirmed_at: null,
    admin_approved_at: null,
    admin_approved_by_username: null,
    payment_method: null,
    payment_proof_screenshot_url: null,
    discount_type: null,
    discount_value: 0,
    ...over,
  };
  store.bills.push(row);
  return row;
}

/** A print in the ledger, addressed the way routes/bills.ts addresses it. */
export function addPrint(billId: string, over: Partial<PrintJobFix> = {}): PrintJobFix {
  const row: PrintJobFix = { id: nid("9a000000"), outlet_id: OUTLET_ID, bill_id: billId, created_at: nowIso(), kind: "bill", status: "delivered", ...over };
  store.printJobs.push(row);
  return row;
}

export const printJobs = (): PrintJobFix[] => store.printJobs.map((r) => ({ ...r }));

/** A status written by another screen (a senior's cancel, a settle elsewhere). */
export function setOrderStatus(id: string, status: string): void {
  const o = store.orders.find((x) => x.id === id);
  if (!o) {throw new Error(`next_party_fixtures: no order ${id}`);}
  o.status = status;
}

/** An order's food rewritten in place (a guest named on it, as SetBillCustomerName writes). */
export function setOrderFood(id: string, food: Record<string, unknown>): void {
  const o = store.orders.find((x) => x.id === id);
  if (!o) {throw new Error(`next_party_fixtures: no order ${id}`);}
  o.food = JSON.parse(JSON.stringify(food)) as Record<string, unknown>;
}

/** Confirm a payment the way the waiter step leaves a bill: ready for approval. */
export function markWaiterConfirmed(billId: string, method = "Cash"): void {
  const b = store.bills.find((x) => x.id === billId);
  if (!b) {throw new Error(`no bill ${billId}`);}
  b.waiter_confirmed_at = nowIso();
  b.payment_method = method;
  for (const o of store.orders.filter((x) => x.table_id === b.table_id && isOwing(x.status))) {o.status = "6";}
}

/**
 * A reservation holding a table, as GetTables reads one: `start` and
 * `duration` minutes in the slot JSON.
 */
export function addBooking(tableName: string, start: Date, durationMin = 120): BookingFix {
  const t = liveTable(tableName);
  const row: BookingFix = {
    outlet_id: t.outlet_id,
    table_id: t.id,
    slot: JSON.stringify({ start: start.toISOString(), duration: durationMin, status: "Confirmed" }),
    created_at: nowIso(),
  };
  store.bookings.push(row);
  return row;
}

export function addAssignment(tableName: string, employeeId: string): void {
  store.assignments.push({ table_id: liveTable(tableName).id, employee_id: employeeId });
}

// --- reading back ------------------------------------------------------------

export const tables = (): TableFix[] => store.tables.map((r) => ({ ...r }));
export const orders = (): OrderFix[] => store.orders.map((r) => ({ ...r, food: { ...r.food } }));
export const bills = (): BillFix[] => store.bills.map((r) => ({ ...r }));
export const sessions = (): SessionFix[] => store.sessions.map((r) => ({ ...r }));
export const ncRows = (): NcRowFix[] => store.nc.map((r) => ({ ...r }));
export const assignments = () => store.assignments.map((r) => ({ ...r }));
export const statements = (): string[] => [...store.log];

export function liveTable(name: string): TableFix {
  const hit = store.tables.find((t) => !t.is_deleted && t.table_name.toLowerCase() === name.toLowerCase());
  if (!hit) {throw new Error(`fixture: no live table "${name}"`);}
  return hit;
}
export const liveTables = (): TableFix[] => tables().filter((t) => !t.is_deleted);
export const liveSiblingsOf = (rootName: string): TableFix[] => {
  const root = liveTable(rootName);
  return liveTables().filter((t) => t.parent_table_id === root.id).sort((a, z) => (a.party_seq ?? 0) - (z.party_seq ?? 0));
};

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

const str = (v: unknown): string => String(v ?? "");
const OWING_EXCLUDED = ["4", "5", "7"];
const isOwing = (status: string): boolean => !OWING_EXCLUDED.includes(str(status) || "1");
const releaseVoidable = (status: string): boolean => !["4", "5", "7", "6"].includes(str(status) || "1");
const at = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);
const inOutlet = (row: { outlet_id: string }, params: unknown[], idx: number): boolean => row.outlet_id === str(params[idx]);

/** A table's name by id, deleted rows included (a settled bill's seat may be retired). */
const tableNameOf = (tableId: string): string => store.tables.find((t) => t.id === tableId)?.table_name ?? "";

/** min(orderArrivalSql) over these orders, on the named table — as the SQL computes it. */
function firstArrival(rows: readonly OrderFix[], tableName: string): Date | null {
  let first: number | null = null;
  for (const o of rows) {
    const t = orderArrivedAt(o.food, tableName, o.created_at);
    if (t !== null && (first === null || t < first)) {first = t;}
  }
  return first === null ? null : new Date(first);
}

/** max(seated_at) of a table's OPEN seating rows, or null. */
function newestOpenSeating(tableId: string): Date | null {
  const open = store.sessions.filter((x) => x.table_id === tableId && x.left_at === null).map((x) => x.seated_at).sort();
  const last = open[open.length - 1];
  return last ? new Date(last) : null;
}

/**
 * settledWindowSql, as the re-open issues it: the order ARRIVED on its table
 * after the previous close and no later than this one. (The updated_at
 * pre-filter is implied by the arrival and is not modelled.)
 */
function inSettledWindow(o: OrderFix, after: number, upTo: number): boolean {
  const arrived = orderArrivedAt(o.food, tableNameOf(o.table_id), o.created_at);
  return arrived !== null && at(o.created_at) <= upTo && arrived > after && arrived <= upTo;
}

function assertSettledWindow(s: string): void {
  if (!s.includes("coalesce(\"orders\".updated_at, \"orders\".created_at) > $4::timestamptz")
    || !s.includes("'table_since'") || s.includes("and created_at > $4 and created_at <= $5")) {
    throw new Error("next_party_fixtures: the re-open's window must be read on the arrival (settledWindowSql)");
  }
}

function contextRow(): Record<string, unknown> {
  return {
    res_id: RES_ID, outlet_id: OUTLET_ID, restaurant_slug: SLUG, restaurant_name: "Gaia Global Vegetarian",
    restaurant_main_office_add: null, restaurant_logo_url: null, timezone: "Asia/Kolkata",
  };
}

/** table_session_track, as table_move_fixtures reproduces it. AFTER UPDATE only. */
function fireSessionTrigger(before: TableFix, after: TableFix): void {
  if (!before.is_occupied && after.is_occupied) {
    store.sessions.push({
      id: nid("5e551000"), table_id: after.id, table_name: after.table_name,
      covers: Math.max(1, after.num_covers || 1), seated_at: nowIso(), left_at: null,
    });
    return;
  }
  const open = store.sessions
    .filter((s) => s.table_id === after.id && s.left_at === null)
    .sort((a, z) => (a.seated_at < z.seated_at ? 1 : -1))[0];
  if (before.is_occupied && !after.is_occupied) {
    if (open) {
      open.left_at = nowIso();
      open.covers = Math.max(open.covers || 1, before.num_covers || 1);
    }
    return;
  }
  if (after.is_occupied && (after.num_covers || 1) !== (before.num_covers || 1) && open) {
    open.covers = Math.max(1, after.num_covers || 1);
  }
}

/** tables_one_live_party, checked as Postgres checks a unique index: on write. */
function assertOneLiveParty(row: TableFix): void {
  if (row.is_deleted || !row.parent_table_id) {return;}
  const clash = store.tables.find((t) => t !== row && !t.is_deleted && t.outlet_id === row.outlet_id
    && t.parent_table_id === row.parent_table_id && t.party_seq === row.party_seq);
  if (clash) {
    throw Object.assign(new Error("duplicate key value violates unique constraint \"tables_one_live_party\""), { code: "23505" });
  }
}

function updateTable(row: TableFix, patch: Partial<TableFix>): void {
  const before = { ...row };
  Object.assign(row, patch);
  try {
    assertOneLiveParty(row);
  } catch (err) {
    Object.assign(row, before);
    throw err;
  }
  fireSessionTrigger(before, row);
}

const tableRowOut = (t: TableFix) => ({
  id: t.id, table_name: t.table_name, capacity: t.capacity, max_capacity: t.max_capacity, section: t.section,
  is_occupied: t.is_occupied, num_covers: t.num_covers, order_otp: t.order_otp,
});

const hasMoney = (t: TableFix): boolean =>
  store.orders.some((o) => o.table_id === t.id && isOwing(o.status))
  || store.bills.some((b) => b.table_id === t.id && b.closed_at === null);

function openBillOf(tableId: string, extra: (b: BillFix) => boolean = () => true): BillFix | undefined {
  return store.bills
    .filter((b) => b.table_id === tableId && b.closed_at === null && extra(b))
    .sort((a, z) => (a.created_at < z.created_at ? 1 : -1))[0];
}

// --- locks ------------------------------------------------------------------

const locks = new Map<string, number>();
const waiters = new Map<string, (() => void)[]>();

async function lockRow(clientId: number, rowId: string): Promise<void> {
  if (!store.lockRows) {return;}
  for (;;) {
    const holder = locks.get(rowId);
    if (holder === undefined || holder === clientId) {
      locks.set(rowId, clientId);
      return;
    }
    await new Promise<void>((resolve) => {
      const list = waiters.get(rowId) ?? [];
      list.push(resolve);
      waiters.set(rowId, list);
    });
  }
}

function releaseLocks(clientId: number): void {
  for (const [rowId, holder] of [...locks.entries()]) {
    if (holder !== clientId) {continue;}
    locks.delete(rowId);
    const list = waiters.get(rowId) ?? [];
    waiters.delete(rowId);
    for (const wake of list) {wake();}
  }
}

// --- dispatch ---------------------------------------------------------------

const missingColumn = (): Error => Object.assign(new Error("column \"parent_table_id\" does not exist"), { code: "42703" });

async function query(clientId: number, stack: Snapshot[], sqlRaw: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
  const sql = sqlRaw.replace(/\s+/g, " ").trim();
  const s = sql.toLowerCase();
  store.log.push(s);

  if (store.failOn && s.includes(store.failOn.toLowerCase())) {
    store.failOn = null;
    throw new Error(`fixture: injected failure on "${sql.slice(0, 60)}"`);
  }

  // --- transaction control ------------------------------------------------
  if (s === "begin" || s.startsWith("savepoint")) {stack.push(snapshot()); return { rows: [] };}
  if (s === "commit") {stack.pop(); releaseLocks(clientId); return { rows: [] };}
  if (s.startsWith("release savepoint")) {stack.pop(); return { rows: [] };}
  if (s === "rollback" || s.startsWith("rollback to savepoint")) {
    const snap = stack.pop();
    if (snap) {restore(snap);}
    if (s === "rollback") {releaseLocks(clientId);}
    return { rows: [] };
  }
  if (s.includes("set_config(")) {return { rows: [] };}

  // --- DDL: nothing to model, except a runtime that may not issue it --------
  if (/^(create|alter|drop|comment|grant)\b/.test(s) || s.startsWith("do $$")) {
    const names053 = s.includes("parent_table_id") || s.includes("party_seq") || s.includes("tables_one_live_party");
    if (names053 && !store.columnsPresent) {
      throw Object.assign(new Error("must be owner of table Tables"), { code: "42501" });
    }
    const names055 = s.includes("bill_digest") || s.includes("lines_digest");
    if (names055 && !store.paperColumnsPresent) {
      throw Object.assign(new Error("must be owner of table PrintJobs"), { code: "42501" });
    }
    return { rows: [] };
  }
  if (s.includes('insert into "actions"')) {return { rows: [] };}

  if (s.includes("information_schema.columns") && s.includes("parent_table_id")) {
    return { rows: [{ n: store.columnsPresent ? 2 : 0 }] };
  }
  if (!store.columnsPresent && (s.includes("parent_table_id") || s.includes("party_seq"))) {
    throw missingColumn();
  }
  // Migration 055's latch probe, and the rule every reader must obey without it.
  if (s.includes("information_schema.columns") && s.includes("table_name = 'printjobs'")) {
    return { rows: [{ n: store.paperColumnsPresent ? 4 : 0 }] };
  }
  if (!store.paperColumnsPresent && (s.includes("bill_digest") || s.includes("lines_digest") || s.includes("bill_grand_total"))) {
    throw Object.assign(new Error("column \"bill_digest\" does not exist"), { code: "42703" });
  }

  // --- context and configuration -----------------------------------------
  if (s.includes('from "restaurant" r')) {return { rows: [contextRow()] };}
  if (s.includes('from "login" l join "employees" e')) {
    return { rows: [{ id: "e0000000-0000-4000-8000-000000000001", username: "nirav", fname: "Nirav", lname: "", role_primary: "admin" }] };
  }
  if (s.startsWith("select default_tax from \"outlets\"")) {return { rows: [{ default_tax: store.taxes }] };}
  if (s.startsWith("select service_charge from \"restaurant\"")) {return { rows: [{ service_charge: store.scPct }] };}
  if (s.includes('from "servicechargewaivers"')) {return { rows: [] };}
  if (s.startsWith("select payment_config from \"restaurant\"")) {return { rows: [{ payment_config: null }] };}
  if (s.startsWith("select loyalty_earn_per_100")) {return { rows: [] };}
  if (s.includes('from "billtenders"')) {return { rows: [] };}
  // GetTables' floor read of the reservations; every other booking reader sees none.
  if (s.startsWith("select table_id, slot, created_at from \"bookings\"")) {
    return {
      rows: store.bookings
        .filter((b) => inOutlet(b, params, 1))
        .map((b) => ({ table_id: b.table_id, slot: b.slot, created_at: b.created_at })),
    };
  }
  if (s.includes('from "bookings"')) {return { rows: [] };}
  if (s.includes('"table_assignments"')) {
    if (s.startsWith("delete from")) {
      store.assignments = store.assignments.filter((a) => a.table_id !== str(params[2]));
    }
    if (s.startsWith('update "table_assignments" set table_id = $1')) {
      const moved = store.assignments.filter((a) => a.table_id === str(params[3]));
      for (const a of moved) {a.table_id = str(params[0]);}
      return { rows: moved.map((_, i) => ({ id: `a-${String(i)}` })) };
    }
    return { rows: [] };
  }
  if (s.includes('update "outlets" set bill_seq')) {store.billSeq += 1; return { rows: [{ bill_seq: store.billSeq }] };}
  if (s.startsWith("select require_table_otp")) {return { rows: [{ require_table_otp: false }] };}
  // getTargetApc: the month's SETTLED history. None here, so no benchmark and no
  // upsell suggestions — neither of which is money on this bill.
  if (s.startsWith("select o.id as order_id, o.food, o.status, coalesce(t.num_covers, 1) as num_covers")) {return { rows: [] };}
  if (s === "select now() as now" || s.startsWith("select now()")) {return { rows: [{ now: new Date(store.nowMs) }] };}

  // --- PrintJobs (billPrintStateForSeatings) -------------------------------
  if (s.startsWith("select bill_id, created_at") && s.includes("from \"printjobs\"")) {
    const statuses = (params[3] as string[]) ?? [];
    const floor = params[4] ? Date.parse(str(params[4])) : null;
    const withPaper = s.includes("bill_digest");
    return {
      rows: store.printJobs
        .filter((j) => j.outlet_id === str(params[1]) && j.kind === str(params[2]) && statuses.includes(j.status))
        .filter((j) => floor === null || at(j.created_at) >= floor)
        .map((j) => ({
          bill_id: j.bill_id, created_at: new Date(j.created_at),
          ...(withPaper ? {
            bill_digest: j.bill_digest ?? null, lines_digest: j.lines_digest ?? null,
            // numeric comes back from pg as text.
            bill_grand_total: j.bill_grand_total === null || j.bill_grand_total === undefined ? null : Number(j.bill_grand_total).toFixed(2),
            table_name: j.table_name ?? null,
          } : {}),
        })),
    };
  }
  // RecordBillPrintPaper.
  if (s.startsWith("update \"printjobs\" set bill_digest = $3, lines_digest = $4, bill_grand_total = $5, table_name = $6")) {
    const ids = ((params[1] as string[]) ?? []).map(String);
    for (const j of store.printJobs) {
      if (!j.id || !ids.includes(j.id)) {continue;}
      Object.assign(j, {
        bill_digest: params[2] === null ? null : str(params[2]),
        lines_digest: params[3] === null ? null : str(params[3]),
        bill_grand_total: params[4] === null ? null : Number(params[4]),
        table_name: params[5] === null ? null : str(params[5]),
      });
    }
    return { rows: [] };
  }
  // CopyBillPrintPaper: the claim's record onto the publish's job — this
  // tenant, both bill jobs, the SAME bill_id, or nothing.
  if (s.startsWith("update \"printjobs\" t set bill_digest = f.bill_digest, lines_digest = f.lines_digest, bill_grand_total = f.bill_grand_total, table_name = f.table_name from \"printjobs\" f")) {
    if (!s.includes("f.bill_id = t.bill_id") || !s.includes("t.kind = $4") || !s.includes("f.kind = $4")) {
      throw new Error("next_party_fixtures: the paper copy must be bounded by kind and by the same bill_id");
    }
    const kind = str(params[3]);
    const from = store.printJobs.find((j) => j.id === str(params[1]) && j.kind === kind);
    const to = store.printJobs.find((j) => j.id === str(params[2]) && j.kind === kind);
    if (!from || !to || from.bill_id !== to.bill_id) {return { rows: [] };}
    Object.assign(to, {
      bill_digest: from.bill_digest ?? null, lines_digest: from.lines_digest ?? null,
      bill_grand_total: from.bill_grand_total ?? null, table_name: from.table_name ?? null,
    });
    return { rows: [{ id: to.id }] };
  }
  // MoveTableParty's re-key of the moving party's `<name>-<epoch>` prints.
  if (s.startsWith("select (select min(o.created_at) from \"orders\" o")) {
    const tableId = str(params[2]);
    const owingRows = store.orders.filter((o) => o.table_id === tableId && inOutlet(o, params, 1) && isOwing(o.status));
    const owing = owingRows.map((o) => o.created_at).sort();
    const bill = openBillOf(tableId, (b) => b.status !== 3 && inOutlet(b, params, 1));
    if (!s.includes("as first_arrival") || !s.includes('from "tablesessions" s where s.table_id = $3 and s.left_at is null')) {
      throw new Error("next_party_fixtures: the re-key's seating start must read the arrivals and the open seating");
    }
    return {
      rows: [{
        first_order_at: owing[0] ? new Date(owing[0]) : null,
        bill_created_at: bill ? new Date(bill.created_at) : null,
        first_arrival: firstArrival(owingRows, str(params[3])),
        seated_at: newestOpenSeating(tableId),
      }],
    };
  }
  // ...and, before it, the retirement of the destination's previous party's prints.
  if (s.startsWith("update \"printjobs\" set bill_id = $4 || bill_id where")) {
    const prefix = str(params[2]);
    const start = Date.parse(str(params[5]));
    const out: { id: string }[] = [];
    for (const j of store.printJobs) {
      if (j.outlet_id !== str(params[1]) || j.kind !== str(params[4]) || !j.bill_id.startsWith(prefix)) {continue;}
      const tail = j.bill_id.slice(prefix.length);
      if (!/^([0-9]+|split-[0-9]+of[0-9]+)$/.test(tail) || at(j.created_at) < start) {continue;}
      j.bill_id = `${str(params[3])}${j.bill_id}`;
      out.push({ id: j.id ?? j.bill_id });
    }
    return { rows: out };
  }
  if (s.startsWith("update \"printjobs\" set bill_id = $4 || substr(bill_id, length($3) + 1)")) {
    const from = str(params[2]);
    const to = str(params[3]);
    const start = Date.parse(str(params[5]));
    const out: { id: string }[] = [];
    for (const j of store.printJobs) {
      if (j.outlet_id !== str(params[1]) || j.kind !== str(params[4]) || !j.bill_id.startsWith(from)) {continue;}
      const tail = j.bill_id.slice(from.length);
      if (!/^([0-9]+|split-[0-9]+of[0-9]+)$/.test(tail) || at(j.created_at) < start) {continue;}
      j.bill_id = `${to}${tail}`;
      out.push({ id: j.id ?? j.bill_id });
    }
    return { rows: out };
  }

  const nc = await ncDispatch(clientId, s, params);
  if (nc) {return nc;}

  // =========================================================================
  // "Tables"
  // =========================================================================

  // GetTables' floor read (with or without 053's two columns).
  if (s.startsWith("select id, table_name, capacity, max_capacity, section, coalesce(is_occupied, false) as is_occupied, coalesce(num_covers, 1) as num_covers, order_otp")) {
    const withParty = s.includes("parent_table_id");
    return {
      rows: store.tables
        .filter((t) => inOutlet(t, params, 1) && !t.is_deleted && !t.is_virtual)
        .sort((a, z) => (a.table_name < z.table_name ? -1 : a.table_name > z.table_name ? 1 : 0))
        .map((t) => ({ ...tableRowOut(t), ...(withParty ? { parent_table_id: t.parent_table_id, party_seq: t.party_seq } : {}) })),
    };
  }

  // Name lookups, live rows only. Several shapes, one rule.
  const byName = (): TableFix | undefined => store.tables.find((t) =>
    inOutlet(t, params, 1) && !t.is_deleted && t.table_name.trim().toLowerCase() === str(params[2]).trim().toLowerCase());
  if (s.startsWith("select id, coalesce(num_covers, 1) as num_covers from \"tables\"")) {
    const t = byName();
    return { rows: t ? [{ id: t.id, num_covers: t.num_covers }] : [] };
  }
  if (/^select id from "tables" where res_id = \$1 and outlet_id = \$2 and lower\(table_name\) = lower\(\$3\)/.test(s)) {
    const t = byName();
    return { rows: t ? [{ id: t.id }] : [] };
  }
  if (s.startsWith("select id, parent_table_id from \"tables\" where res_id = $1")) {
    const t = byName();
    return { rows: t ? [{ id: t.id, parent_table_id: t.parent_table_id }] : [] };
  }
  if (s.startsWith("select id, table_name, coalesce(is_virtual, false) as is_virtual from \"tables\"")) {
    const t = byName();
    return { rows: t ? [{ id: t.id, table_name: t.table_name, is_virtual: t.is_virtual }] : [] };
  }
  if (s.startsWith("select id, capacity, max_capacity, coalesce(is_occupied, false) as is_occupied from \"tables\"")) {
    const t = byName();
    return { rows: t ? [{ id: t.id, capacity: t.capacity, max_capacity: t.max_capacity, is_occupied: t.is_occupied }] : [] };
  }

  // The KOT readers (GetKotTableContext by name, GetOrderKotContext by order).
  // With 053 present they join the live root and print ITS zone; without it
  // they read the row's own and name no 053 column (the check above throws if
  // they do).
  const kotZone = (t: TableFix): string | null => {
    if (!s.includes("left join \"tables\" kp")) {return t.section;}
    if (!s.includes("case when kp.id is not null then kp.section else t.section end as section")
      || !s.includes("and coalesce(kp.is_deleted, false) = false")) {
      throw new Error("next_party_fixtures: the KOT zone must be the LIVE root's, then the row's own");
    }
    const root = t.parent_table_id
      ? store.tables.find((p) => p.id === t.parent_table_id && p.outlet_id === t.outlet_id && !p.is_deleted)
      : undefined;
    return root ? root.section : t.section;
  };
  if (s.startsWith("select t.id, t.table_name, ") && s.includes("as latest_food from \"tables\" t")) {
    const t = byName();
    const food = t
      ? store.orders.filter((o) => o.table_id === t.id && isOwing(o.status)).sort((a, z) => (a.created_at < z.created_at ? 1 : -1))[0]?.food ?? null
      : null;
    return {
      rows: t ? [{
        id: t.id, table_name: t.table_name, section: kotZone(t), num_covers: t.num_covers,
        is_virtual: t.is_virtual, latest_food: food ? JSON.stringify(food) : null,
      }] : [],
    };
  }
  if (s.startsWith("select o.id as order_id, o.outlet_id, o.status, o.food, o.table_id, t.table_name, ")) {
    const o = store.orders.find((x) => x.id === str(params[0]) && inOutlet(x, params, 2));
    const t = o ? store.tables.find((x) => x.id === o.table_id && x.outlet_id === o.outlet_id) : undefined;
    return {
      rows: o ? [{
        order_id: o.id, outlet_id: o.outlet_id, status: o.status, food: JSON.stringify(o.food), table_id: o.table_id,
        table_name: t?.table_name ?? null, section: t ? kotZone(t) : null, num_covers: t?.num_covers ?? 1,
        is_virtual: t?.is_virtual ?? false,
      }] : [],
    };
  }
  // UpdateTable: the named live row, then that one row's seats and zone.
  if (s.startsWith("select id, table_name, capacity, max_capacity, section from \"tables\"")) {
    const t = byName();
    return { rows: t ? [{ id: t.id, table_name: t.table_name, capacity: t.capacity, max_capacity: t.max_capacity, section: t.section }] : [] };
  }
  if (s.startsWith("update \"tables\" set capacity = $4, max_capacity = $5, section = $6 where id = $1")) {
    const t = store.tables.find((x) => x.id === str(params[0]) && inOutlet(x, params, 2));
    if (t) {
      updateTable(t, {
        capacity: Number(params[3]),
        max_capacity: params[4] === null ? null : Number(params[4]),
        section: params[5] === null ? null : str(params[5]),
      });
    }
    return { rows: [] };
  }

  // By id.
  const byId = (idx: number, outletIdx: number): TableFix | undefined =>
    store.tables.find((t) => t.id === str(params[idx]) && inOutlet(t, params, outletIdx));
  if (s.startsWith("select table_name from \"tables\" where id = $1")) {
    const t = byId(0, 2);
    return { rows: t ? [{ table_name: t.table_name }] : [] };
  }
  if (s.startsWith("select id, parent_table_id from \"tables\" where id = $1")) {
    const t = byId(0, 2);
    return { rows: t ? [{ id: t.id, parent_table_id: t.parent_table_id }] : [] };
  }
  if (s.startsWith("select id from \"tables\" where id = $1") && s.endsWith("for update")) {
    const t = byId(0, 2);
    if (t) {await lockRow(clientId, t.id);}
    return { rows: t ? [{ id: t.id }] : [] };
  }
  if (s.startsWith("select id, table_name, capacity, max_capacity, section, coalesce(is_virtual, false) as is_virtual")) {
    const t = byId(0, 2);
    if (t) {await lockRow(clientId, t.id);}
    return {
      rows: t ? [{
        id: t.id, table_name: t.table_name, capacity: t.capacity, max_capacity: t.max_capacity, section: t.section,
        is_virtual: t.is_virtual, is_deleted: t.is_deleted, parent_table_id: t.parent_table_id,
      }] : [],
    };
  }
  if (s.startsWith("select p.table_name as parent_name from \"tables\" t join \"tables\" p")) {
    const t = byId(0, 2);
    const p = t?.parent_table_id ? store.tables.find((x) => x.id === t.parent_table_id) : undefined;
    return { rows: p ? [{ parent_name: p.table_name }] : [] };
  }
  if (s.startsWith("select p.table_name as parent_name, (t.parent_table_id is not null) as is_sibling")) {
    const t = byId(0, 2);
    const p = t?.parent_table_id ? store.tables.find((x) => x.id === t.parent_table_id) : undefined;
    return { rows: t ? [{ parent_name: p?.table_name ?? null, is_sibling: t.parent_table_id !== null }] : [] };
  }

  // The family read.
  if (s.startsWith("select t.id, t.table_name, t.parent_table_id, t.party_seq")) {
    const rootId = str(params[2]);
    return {
      rows: store.tables
        .filter((t) => inOutlet(t, params, 1) && (t.id === rootId || t.parent_table_id === rootId))
        .sort((a, z) => (a.party_seq ?? 0) - (z.party_seq ?? 0))
        .map((t) => ({
          id: t.id, table_name: t.table_name, parent_table_id: t.parent_table_id, party_seq: t.party_seq,
          is_deleted: t.is_deleted, is_occupied: t.is_occupied, capacity: t.capacity, max_capacity: t.max_capacity,
          section: t.section, has_money: hasMoney(t),
        })),
    };
  }
  if (s.startsWith("select lower(btrim(table_name)) as n from \"tables\"")) {
    const prefix = `${str(params[2]).trim().toLowerCase()} #`;
    return {
      rows: store.tables
        .filter((t) => inOutlet(t, params, 1) && !t.is_deleted && t.table_name.trim().toLowerCase().startsWith(prefix))
        .map((t) => ({ n: t.table_name.trim().toLowerCase() })),
    };
  }
  if (s.startsWith("select table_name, coalesce(is_deleted, false) as is_deleted from \"tables\" where parent_table_id = $1")) {
    return {
      rows: store.tables
        .filter((t) => t.parent_table_id === str(params[0]) && inOutlet(t, params, 2))
        .map((t) => ({ table_name: t.table_name, is_deleted: t.is_deleted })),
    };
  }

  // OccupyTable's revive of a retired sibling, by name, while its root lives.
  if (s.startsWith("select t.id, t.parent_table_id from \"tables\" t join \"tables\" p")) {
    const hit = store.tables
      .filter((t) => inOutlet(t, params, 1) && t.is_deleted && t.parent_table_id !== null
        && t.table_name.toLowerCase() === str(params[2]).toLowerCase())
      .filter((t) => store.tables.some((p) => p.id === t.parent_table_id && !p.is_deleted))
      .sort((a, z) => (a.created_at < z.created_at ? 1 : -1))[0];
    return { rows: hit ? [{ id: hit.id, parent_table_id: hit.parent_table_id }] : [] };
  }

  // ReopenBill's next-party half: the row, and its root.
  if (s.startsWith("select t.table_name, t.parent_table_id, coalesce(t.is_deleted, false) as is_deleted, p.table_name as parent_name")) {
    const t = byId(0, 2);
    const p = t?.parent_table_id ? store.tables.find((x) => x.id === t.parent_table_id) : undefined;
    return {
      rows: t ? [{
        table_name: t.table_name, parent_table_id: t.parent_table_id, is_deleted: t.is_deleted,
        parent_name: p?.table_name ?? null, parent_deleted: p ? p.is_deleted : null,
      }] : [],
    };
  }
  if (s.startsWith("update \"tables\" t set is_deleted = false, is_occupied = true where t.id = $1")) {
    const t = byId(0, 2);
    const clash = t && store.tables.some((x) => x !== t && !x.is_deleted && x.outlet_id === t.outlet_id
      && (x.table_name.toLowerCase() === t.table_name.toLowerCase()
        || (x.parent_table_id === t.parent_table_id && x.party_seq === t.party_seq)));
    if (!t || !t.is_deleted || clash) {return { rows: [] };}
    updateTable(t, { is_deleted: false, is_occupied: true });
    return { rows: [{ table_name: t.table_name }] };
  }
  // ReopenBill's "has this table a new party?" — seated (a live row) or owing.
  if (s.startsWith("select t.table_name, ((coalesce(t.is_deleted, false) = false and coalesce(t.is_occupied, false)) or exists (select 1 from \"orders\" o")) {
    if (!s.includes("coalesce(o.status::text, '1') not in ('4','5','7')")) {
      throw new Error("next_party_fixtures: the new-party check must use the owing rule");
    }
    const t = byId(0, 2);
    const busy = t ? ((!t.is_deleted && t.is_occupied) || store.orders.some((o) => o.table_id === t.id && inOutlet(o, params, 2) && isOwing(o.status))) : false;
    return { rows: t ? [{ table_name: t.table_name, busy }] : [] };
  }
  // ReopenBill's ordinary re-seat: live rows only.
  if (s.startsWith("update \"tables\" set is_occupied = true where id = $1")) {
    const t = byId(0, 2);
    if (!t || t.is_deleted) {return { rows: [] };}
    updateTable(t, { is_occupied: true });
    return { rows: [{ table_name: t.table_name }] };
  }

  // Sibling insert.
  if (s.startsWith("insert into \"tables\"") && s.includes("parent_table_id")) {
    const row: TableFix = {
      id: str(params[0]), outlet_id: str(params[2]), table_name: str(params[3]),
      capacity: Number(params[4]), max_capacity: params[5] === null ? null : Number(params[5]),
      section: params[6] === null ? null : str(params[6]),
      is_occupied: false, num_covers: 1, linked_order_id: null, order_otp: null,
      is_deleted: false, is_virtual: false, parent_table_id: str(params[7]), party_seq: Number(params[8]),
      created_at: nowIso(),
    };
    assertOneLiveParty(row);
    store.tables.push(row);
    return { rows: [] };
  }

  // "Tables" updates — each through updateTable, so the trigger and the index apply.
  if (s.startsWith("update \"tables\" set is_deleted = false, is_occupied = false, num_covers = 1, linked_order_id = null, order_otp = null, table_name = $4")) {
    const t = byId(0, 2);
    if (t) {
      updateTable(t, {
        is_deleted: false, is_occupied: false, num_covers: 1, linked_order_id: null, order_otp: null,
        table_name: str(params[3]), capacity: Number(params[4]),
        max_capacity: params[5] === null ? null : Number(params[5]), section: params[6] === null ? null : str(params[6]),
      });
    }
    return { rows: [] };
  }
  if (s.startsWith("update \"tables\" t set is_deleted = true, order_otp = null, linked_order_id = null")) {
    const ids = (params[2] as string[]) ?? [];
    const out: { id: string; table_name: string }[] = [];
    for (const t of store.tables) {
      if (!ids.includes(t.id) || !inOutlet(t, params, 1)) {continue;}
      if (!t.parent_table_id || t.is_deleted || t.is_occupied || hasMoney(t)) {continue;}
      updateTable(t, { is_deleted: true, order_otp: null, linked_order_id: null });
      out.push({ id: t.id, table_name: t.table_name });
    }
    return { rows: out };
  }
  if (s.startsWith("update \"tables\" t set is_deleted = false, is_occupied = false, num_covers = 1")) {
    const t = byId(0, 2);
    const clash = t && store.tables.some((x) => x !== t && !x.is_deleted && x.outlet_id === t.outlet_id
      && (x.table_name.toLowerCase() === t.table_name.toLowerCase()
        || (x.parent_table_id === t.parent_table_id && x.party_seq === t.party_seq)));
    if (!t || clash || hasMoney(t)) {return { rows: [] };}
    updateTable(t, { is_deleted: false, is_occupied: false, num_covers: 1, linked_order_id: null, order_otp: null });
    return { rows: [{ id: t.id, capacity: t.capacity, max_capacity: t.max_capacity }] };
  }
  if (s.startsWith("update \"tables\" set is_occupied = false, num_covers = 1")) {
    const t = byId(0, 2);
    if (t) {updateTable(t, { is_occupied: false, num_covers: 1, linked_order_id: null, order_otp: null });}
    return { rows: s.includes("returning is_occupied") && t ? [{ is_occupied: false }] : [] };
  }
  if (s.startsWith("update \"tables\" set is_deleted = true, is_occupied = false, order_otp = null where id = $1")) {
    const t = byId(0, 2);
    if (t && t.is_virtual) {updateTable(t, { is_deleted: true, is_occupied: false, order_otp: null });}
    return { rows: [] };
  }
  if (s.startsWith("update \"tables\" set is_occupied = true, num_covers = $1 where id = $2")) {
    const t = byId(1, 3);
    if (t) {updateTable(t, { is_occupied: true, num_covers: Number(params[0]) });}
    return { rows: [] };
  }
  if (s.startsWith("update \"tables\" set is_occupied = true, num_covers = case when $4::int is null")) {
    const t = byId(0, 2);
    if (!t) {return { rows: [] };}
    updateTable(t, {
      is_occupied: true,
      num_covers: params[3] === null ? (t.num_covers || 1) : Math.max(1, Number(params[3])),
      linked_order_id: params[4] === null ? null : str(params[4]),
    });
    return { rows: [{ is_occupied: true, num_covers: t.num_covers, linked_order_id: t.linked_order_id }] };
  }
  if (s.startsWith("select (select coalesce(num_covers,1) from \"tables\" where id = $1) as from_c")) {
    const f = store.tables.find((t) => t.id === str(params[0]));
    const d = store.tables.find((t) => t.id === str(params[1]));
    return { rows: [{ from_c: f?.num_covers ?? 1, to_c: d?.num_covers ?? 1 }] };
  }

  // --- the room's tables (physicalTableSql), for the denominator readers ----
  const physicalOnly = (t: TableFix): boolean => !t.is_virtual
    && (!s.includes("parent_table_id is null") || t.parent_table_id === null);
  if (s.startsWith("select id, table_name, capacity, max_capacity from \"tables\"")) {
    return {
      rows: store.tables
        .filter((t) => inOutlet(t, params, 1) && !t.is_deleted && (s.includes("is_virtual") ? physicalOnly(t) : true))
        .map((t) => ({ id: t.id, table_name: t.table_name, capacity: t.capacity, max_capacity: t.max_capacity })),
    };
  }
  if (s.startsWith("select id, table_name, capacity, max_capacity, coalesce(is_occupied, false) as is_occupied from \"tables\"")) {
    return {
      rows: store.tables
        .filter((t) => inOutlet(t, params, 1) && !t.is_deleted && physicalOnly(t))
        .sort((a, z) => (a.table_name < z.table_name ? -1 : 1))
        .map((t) => ({ id: t.id, table_name: t.table_name, capacity: t.capacity, max_capacity: t.max_capacity, is_occupied: t.is_occupied })),
    };
  }
  if (s.includes("select min(nullif(btrim(coalesce(section, '')), '')) as section")) {
    const groups = new Map<string, { section: string | null; tables: number; seats: number }>();
    for (const t of store.tables.filter((x) => inOutlet(x, params, 1) && !x.is_deleted && physicalOnly(x))) {
      const key = (t.section ?? "").trim().toLowerCase();
      const g = groups.get(key) ?? { section: (t.section ?? "").trim() || null, tables: 0, seats: 0 };
      g.tables += 1;
      g.seats += Math.max(1, t.capacity);
      groups.set(key, g);
    }
    return { rows: [...groups.values()] };
  }
  if (s.includes('from "table_sections"')) {return { rows: [] };}

  // --- AddTable / RemoveTable -------------------------------------------------
  if (s.startsWith("select id, coalesce(is_deleted, false) as is_deleted from \"tables\"")) {
    const t = store.tables.find((x) => inOutlet(x, params, 1) && x.table_name.toLowerCase() === str(params[2]).toLowerCase()
      && (!s.includes("parent_table_id is null") || x.parent_table_id === null));
    return { rows: t ? [{ id: t.id, is_deleted: t.is_deleted }] : [] };
  }
  if (s.startsWith("insert into \"tables\" (id, created_at, res_id, outlet_id, table_name, capacity, max_capacity, section)")) {
    store.tables.push({
      id: str(params[0]), outlet_id: str(params[2]), table_name: str(params[3]), capacity: Number(params[4]),
      max_capacity: params[5] === null ? null : Number(params[5]), section: params[6] === null ? null : str(params[6]),
      is_occupied: false, num_covers: 1, linked_order_id: null, order_otp: null, is_deleted: false, is_virtual: false,
      parent_table_id: null, party_seq: null, created_at: nowIso(),
    });
    return { rows: [] };
  }
  if (s.startsWith("select id, coalesce(is_occupied, false) as is_occupied from \"tables\"")) {
    const t = byName();
    return { rows: t ? [{ id: t.id, is_occupied: t.is_occupied }] : [] };
  }
  if (s.startsWith("select exists(select 1 from \"orders\" where table_id = $1")) {
    const id = str(params[0]);
    const siblingHistory = s.includes('exists(select 1 from "tables" where parent_table_id = $1');
    return {
      rows: [{
        has_history: store.orders.some((o) => o.table_id === id) || store.bills.some((b) => b.table_id === id)
          || (siblingHistory && store.tables.some((t) => t.parent_table_id === id)),
      }],
    };
  }
  if (s.startsWith("update \"tables\" set is_deleted = true, is_occupied = false, num_covers = 1, linked_order_id = null, order_otp = null where id = $1")) {
    const t = byId(0, 2);
    if (t) {updateTable(t, { is_deleted: true, is_occupied: false, num_covers: 1, linked_order_id: null, order_otp: null });}
    return { rows: [] };
  }
  if (s.startsWith("delete from \"tables\" where id = $1")) {
    const id = str(params[0]);
    if (store.tables.some((t) => t.parent_table_id === id)) {
      throw Object.assign(new Error("violates foreign key constraint \"tables_parent_fk\""), { code: "23503" });
    }
    store.tables = store.tables.filter((t) => t.id !== id);
    return { rows: [] };
  }

  // --- MoveOrderToTable (client items 3-4; money-floor review of 2.0.2) --------
  if (s.startsWith('select id, table_id, food, status from "orders" where id = $1 and res_id = $2 and outlet_id = $3')) {
    const o = store.orders.find((x) => x.id === str(params[0]) && inOutlet(x, params, 2));
    return { rows: o ? [{ id: o.id, table_id: o.table_id, food: JSON.stringify(o.food), status: o.status }] : [] };
  }
  if (s.startsWith('select food from "orders" where res_id = $1 and outlet_id = $2 and table_id = $3')) {
    if (!s.includes("coalesce(status::text, '1') not in ('4','5','7')") || !s.includes("order by created_at asc")) {
      throw new Error("next_party_fixtures: the destination's guest is read off its running orders, oldest first");
    }
    return {
      rows: store.orders
        .filter((o) => inOutlet(o, params, 1) && o.table_id === str(params[2]) && isOwing(o.status))
        .sort((a, z) => (a.created_at < z.created_at ? -1 : 1))
        .map((o) => ({ food: JSON.stringify(o.food) })),
    };
  }
  if (s.startsWith('select created_at from "orders" where id = $1 and res_id = $2 and outlet_id = $3')) {
    const o = store.orders.find((x) => x.id === str(params[0]) && inOutlet(x, params, 2));
    return { rows: o ? [{ created_at: new Date(o.created_at) }] : [] };
  }
  if (s.startsWith('update "tables" set is_occupied = true, num_covers = greatest(1, coalesce(num_covers, 1)) where id = $1')) {
    const t = byId(0, 2);
    if (t) {updateTable(t, { is_occupied: true, num_covers: Math.max(1, t.num_covers || 1) });}
    return { rows: [] };
  }
  if (s.startsWith('select count(*)::text as n from "orders" where res_id = $1 and outlet_id = $2 and table_id = $3')) {
    const n = store.orders.filter((o) => inOutlet(o, params, 1) && o.table_id === str(params[2]) && isOwing(o.status)).length;
    return { rows: [{ n: String(n) }] };
  }

  // --- MoveTableParty (the statements table_move_fixtures models) -------------
  if (s.includes('from "tables"') && s.includes("order by id") && s.includes("coalesce(is_virtual, false) as is_virtual")) {
    const a = str(params[2]).trim().toLowerCase();
    const b = str(params[3]).trim().toLowerCase();
    const withParent = s.includes("parent_table_id");
    // MoveOrderToTable asks by the source's ID or the destination's NAME.
    const byIdOrName = s.includes("(id = $3 or lower(btrim(table_name)) = lower(btrim($4)))");
    return {
      rows: store.tables
        .filter((t) => inOutlet(t, params, 1) && !t.is_deleted && (byIdOrName
          ? (t.id === str(params[2]) || t.table_name.trim().toLowerCase() === b)
          : [a, b].includes(t.table_name.trim().toLowerCase())))
        .sort((x, y) => (x.id < y.id ? -1 : 1))
        .map((t) => ({
          id: t.id, table_name: t.table_name, capacity: t.capacity, max_capacity: t.max_capacity,
          is_occupied: t.is_occupied, num_covers: t.num_covers, linked_order_id: t.linked_order_id,
          order_otp: t.order_otp, is_virtual: t.is_virtual,
          ...(withParent ? { parent_table_id: t.parent_table_id } : {}),
        })),
    };
  }
  if (s.startsWith("select count(*)::text as n from \"bills\" where res_id = $1 and outlet_id = $2 and table_id = $3 and closed_at is null")
      && !s.includes("waiter_confirmed_at")) {
    return { rows: [{ n: String(store.bills.filter((b) => b.table_id === str(params[2]) && b.closed_at === null).length) }] };
  }
  if (s.startsWith("update \"bills\" set table_id = $1 where")) {
    const moved = store.bills.filter((b) => b.table_id === str(params[3]) && b.closed_at === null);
    for (const b of moved) {b.table_id = str(params[0]);}
    return { rows: moved.map((b) => ({ id: b.id })) };
  }
  if (s.startsWith(`select to_regclass('public."tablesessions"') is not null as present`)) {
    return { rows: [{ present: true }] };
  }
  if (s.startsWith('select s.table_id::text as table_id, max(s.seated_at) as seated_at from "tablesessions" s join "tables" t')) {
    if (!s.includes("s.left_at is null") || !s.includes("coalesce(t.is_occupied, false) = true")) {
      throw new Error("next_party_fixtures: only an OCCUPIED table's OPEN seating bounds its prints");
    }
    const ids = Array.isArray(params[2]) ? (params[2] as string[]) : null;
    const out: { table_id: string; seated_at: Date }[] = [];
    for (const t of store.tables) {
      if (t.outlet_id !== str(params[1]) || !t.is_occupied || (ids && !ids.includes(t.id))) {continue;}
      const seatedAt = newestOpenSeating(t.id);
      if (seatedAt) {out.push({ table_id: t.id, seated_at: seatedAt });}
    }
    return { rows: out };
  }
  if (s.startsWith('update "tablesessions" set seated_at = least(seated_at, $2::timestamptz) where table_id = $1 and left_at is null')) {
    const floor = new Date(str(params[1])).toISOString();
    for (const x of store.sessions) {
      if (x.table_id === str(params[0]) && x.left_at === null && floor < x.seated_at) {x.seated_at = floor;}
    }
    return { rows: [] };
  }
  if (s.startsWith("select id from \"tablesessions\" where table_id = $1 and left_at is null")) {
    const open = store.sessions.filter((x) => x.table_id === str(params[0]) && x.left_at === null)
      .sort((a, z) => (a.seated_at < z.seated_at ? 1 : -1))[0];
    return { rows: open ? [{ id: open.id }] : [] };
  }
  if (s.startsWith("delete from \"tablesessions\" where id = $1")) {
    store.sessions = store.sessions.filter((x) => x.id !== str(params[0]));
    return { rows: [] };
  }
  if (s.startsWith("update \"tablesessions\" set table_id = $2, table_name = $3, left_at = null where id = $1")) {
    const row = store.sessions.find((x) => x.id === str(params[0]));
    if (row) {row.table_id = str(params[1]); row.table_name = str(params[2]); row.left_at = null;}
    return { rows: [] };
  }
  if (s.startsWith("update \"tables\" set is_occupied = true, num_covers = $4, linked_order_id = $5, order_otp = $6 where id = $1")) {
    const t = byId(0, 2);
    if (t) {
      updateTable(t, {
        is_occupied: true, num_covers: Number(params[3]),
        linked_order_id: params[4] === null ? null : str(params[4]), order_otp: params[5] === null ? null : str(params[5]),
      });
    }
    return { rows: [] };
  }

  // --- OccupyTable's auto-assign lookup: nobody on the roster ---------------
  if (s.startsWith("select e.emp_roles as emp_roles")) {return { rows: [] };}

  // =========================================================================
  // "Orders"
  // =========================================================================
  const tableIs = (o: OrderFix, idx: number) => o.table_id === str(params[idx]);
  if (s.startsWith("select id, food, created_at from \"orders\"")) {
    return {
      rows: store.orders
        .filter((o) => inOutlet(o, params, 1) && tableIs(o, 2) && isOwing(o.status))
        .sort((a, z) => (a.created_at < z.created_at ? -1 : 1))
        .map((o) => ({ id: o.id, food: JSON.stringify(o.food), created_at: new Date(o.created_at) })),
    };
  }
  if (s.startsWith("select food, status from \"orders\" where res_id = $1 and outlet_id = $2 and table_id = $3")) {
    const owingOnly = s.includes("not in");
    return {
      rows: store.orders
        .filter((o) => inOutlet(o, params, 1) && tableIs(o, 2) && (!owingOnly || isOwing(o.status)))
        .map((o) => ({ food: JSON.stringify(o.food), status: o.status })),
    };
  }
  if (s.startsWith("select table_id, food, created_at from \"orders\"")) {
    return {
      rows: store.orders
        .filter((o) => inOutlet(o, params, 1) && isOwing(o.status))
        .map((o) => ({ table_id: o.table_id, food: JSON.stringify(o.food), created_at: new Date(o.created_at) })),
    };
  }
  if (s.startsWith("select min(created_at) as first_at, min(coalesce(")) {
    const owing = store.orders.filter((o) => inOutlet(o, params, 1) && tableIs(o, 2) && isOwing(o.status));
    const first = owing.map((o) => o.created_at).sort()[0];
    return { rows: [{ first_at: first ? new Date(first) : null, first_arrival: firstArrival(owing, str(params[3])) }] };
  }
  if (s.startsWith("select food from \"orders\" where id = $1 and res_id = $2 and outlet_id = $3")) {
    const o = store.orders.find((x) => x.id === str(params[0]) && inOutlet(x, params, 2));
    return { rows: o ? [{ food: JSON.stringify(o.food) }] : [] };
  }
  if (s.startsWith("select table_id from \"orders\" where id = $1")) {
    const o = store.orders.find((x) => x.id === str(params[0]) && inOutlet(x, params, 2));
    return { rows: o ? [{ table_id: o.table_id }] : [] };
  }
  if (s.startsWith("select id, food from \"orders\" where res_id = $1 and outlet_id = $2 and table_id = $3") && s.includes("not in")) {
    return {
      rows: store.orders
        .filter((o) => inOutlet(o, params, 1) && tableIs(o, 2) && isOwing(o.status))
        .sort((a, z) => (a.created_at < z.created_at ? -1 : 1))
        .map((o) => ({ id: o.id, food: JSON.stringify(o.food) })),
    };
  }
  if (s.startsWith("select id, food from \"orders\" where res_id = $1 and outlet_id = $2 and table_id = $3 order by created_at desc limit 1")) {
    const o = store.orders.filter((x) => inOutlet(x, params, 1) && tableIs(x, 2))
      .sort((a, z) => (a.created_at < z.created_at ? 1 : -1))[0];
    return { rows: o ? [{ id: o.id, food: JSON.stringify(o.food) }] : [] };
  }
  if (s.startsWith("update \"orders\" set status = $4 where res_id = $1 and outlet_id = $2 and table_id = $3")) {
    for (const o of store.orders) {
      if (inOutlet(o, params, 1) && tableIs(o, 2) && isOwing(o.status)) {o.status = str(params[3]);}
    }
    return { rows: [] };
  }
  if (s.startsWith("update \"orders\" set status = 5 where res_id = $1 and outlet_id = $2 and table_id = $3")) {
    for (const o of store.orders) {
      if (inOutlet(o, params, 1) && tableIs(o, 2) && releaseVoidable(o.status)) {o.status = "5";}
    }
    return { rows: [] };
  }
  // ReopenBill: this session's settled orders back to "Payment Pending Approval".
  if (s.startsWith("update \"orders\" set status = 6, food = jsonb_set(")) {
    assertSettledWindow(s);
    const after = at(new Date(params[3] as string | Date).toISOString());
    const upTo = at(new Date(params[4] as string | Date).toISOString());
    const out: { id: string }[] = [];
    for (const o of store.orders) {
      if (!inOutlet(o, params, 1) || !tableIs(o, 2) || !["4", "7"].includes(str(o.status) || "1")) {continue;}
      if (!inSettledWindow(o, after, upTo)) {continue;}
      o.status = "6";
      o.food = { ...o.food, status: "Payment Pending Approval" };
      out.push({ id: o.id });
    }
    return { rows: out };
  }
  if (s.startsWith("update \"orders\" set status = $1, food = jsonb_set(")) {
    for (const o of store.orders) {
      if (o.table_id === str(params[2]) && inOutlet(o, params, 4) && isOwing(o.status)) {
        o.status = str(params[0]);
        o.food = { ...o.food, status: str(params[1]) };
      }
    }
    return { rows: [] };
  }
  if (s.startsWith("update \"orders\" set table_id = $1, food = jsonb_set(($2)::jsonb, '{table_since}', to_jsonb(now()), true)::json where id = $3")) {
    const o = store.orders.find((x) => x.id === str(params[2]) && inOutlet(x, params, 4));
    if (o) {
      o.table_id = str(params[0]);
      o.food = { ...(JSON.parse(str(params[1])) as Record<string, unknown>), table_since: nowIso() };
    }
    return { rows: [] };
  }
  if (s.startsWith("update \"orders\" set table_id = $1, food = $2::json where id = $3")) {
    const o = store.orders.find((x) => x.id === str(params[2]));
    if (o) {
      o.table_id = str(params[0]);
      o.food = JSON.parse(str(params[1])) as Record<string, unknown>;
    }
    return { rows: [] };
  }

  // =========================================================================
  // "Bills"
  // =========================================================================
  // ReopenBill.
  if (s.startsWith("select b.id, b.bill_no, b.table_id, b.total_amt, b.payment_method, b.created_at, b.closed_at")) {
    const b = store.bills.find((x) => x.id === str(params[0]) && inOutlet(x, params, 2));
    return {
      rows: b ? [{
        id: b.id, bill_no: b.bill_no, table_id: b.table_id, total_amt: b.total_amt, payment_method: b.payment_method,
        created_at: new Date(b.created_at), closed_at: b.closed_at ? new Date(b.closed_at) : null, refunded_at: null,
        waiter_confirmed_at: b.waiter_confirmed_at ? new Date(b.waiter_confirmed_at) : null,
        within_window: b.closed_at !== null && store.nowMs - at(b.closed_at) <= 240 * 60_000,
        window_min: 240,
      }] : [],
    };
  }
  if (s.startsWith("update \"bills\" set closed_at = null, closed_by_username = null, admin_approved_at = null")) {
    const b = store.bills.find((x) => x.id === str(params[0]) && inOutlet(x, params, 2));
    if (!b) {return { rows: [] };}
    Object.assign(b, { closed_at: null, closed_by_username: null, admin_approved_at: null, admin_approved_by_username: null, status: 1 });
    return {
      rows: [{
        id: b.id, status: b.status, created_at: new Date(b.created_at),
        waiter_confirmed_at: b.waiter_confirmed_at ? new Date(b.waiter_confirmed_at) : null,
      }],
    };
  }
  if (s.startsWith("select coalesce(max(closed_at), 'epoch'::timestamptz) as prev_closed from \"bills\"")) {
    const upTo = at(new Date(params[4] as string | Date).toISOString());
    const prev = store.bills
      .filter((b) => b.table_id === str(params[0]) && inOutlet(b, params, 2) && b.id !== str(params[3])
        && b.closed_at !== null && at(b.closed_at) <= upTo)
      .map((b) => at(b.closed_at))
      .sort((a, z) => z - a)[0];
    return { rows: [{ prev_closed: new Date(prev ?? 0) }] };
  }
  if (s.startsWith("select b.id, b.bill_no, b.coupon_code")) {
    const b = openBillOf(str(params[0]), (x) => x.status !== 3 && inOutlet(x, params, 2));
    return {
      rows: b ? [{
        id: b.id, bill_no: b.bill_no, coupon_code: null, payment_method: b.payment_method,
        payment_proof_screenshot_url: b.payment_proof_screenshot_url, created_at: new Date(b.created_at),
        waiter_confirmed_at: b.waiter_confirmed_at ? new Date(b.waiter_confirmed_at) : null,
        admin_approved_at: b.admin_approved_at ? new Date(b.admin_approved_at) : null, discount_applied_at: null,
      }] : [],
    };
  }
  if (s.startsWith("select id, created_at from \"bills\" where table_id = $1")) {
    const b = openBillOf(str(params[0]), (x) => x.status !== 3 && inOutlet(x, params, 2));
    return { rows: b ? [{ id: b.id, created_at: new Date(b.created_at) }] : [] };
  }
  if (s.startsWith("select id, table_id, created_at, status, waiter_confirmed_at, admin_approved_at from \"bills\"")) {
    return {
      rows: store.bills
        .filter((b) => inOutlet(b, params, 1) && b.closed_at === null)
        .map((b) => ({
          id: b.id, table_id: b.table_id, created_at: new Date(b.created_at), status: b.status,
          waiter_confirmed_at: b.waiter_confirmed_at, admin_approved_at: b.admin_approved_at,
        })),
    };
  }
  if (s.startsWith("select discount_type, discount_value from \"bills\"")) {
    const b = openBillOf(str(params[0]), (x) => inOutlet(x, params, 2));
    return { rows: b ? [{ discount_type: b.discount_type, discount_value: b.discount_value }] : [] };
  }
  if (s.startsWith("select id from \"bills\" where table_id = $1") && s.includes("closed_at is null")) {
    const b = openBillOf(str(params[0]), (x) => inOutlet(x, params, 2));
    return { rows: b ? [{ id: b.id }] : [] };
  }
  if (s.startsWith("select payment_method, payment_proof_screenshot_url, payment_splits from \"bills\"")) {
    const b = openBillOf(str(params[0]), (x) => inOutlet(x, params, 2));
    return { rows: b ? [{ payment_method: b.payment_method, payment_proof_screenshot_url: b.payment_proof_screenshot_url, payment_splits: null }] : [] };
  }
  if (s.startsWith("update \"bills\" set admin_approved_at = now()")) {
    const b = openBillOf(str(params[1]), (x) => inOutlet(x, params, 3) && x.waiter_confirmed_at !== null && x.status !== 3);
    if (!b) {return { rows: [] };}
    b.admin_approved_at = nowIso();
    b.admin_approved_by_username = str(params[0]);
    b.status = 2;
    b.total_amt = Number(params[4]);
    b.tax_breakdown = JSON.parse(str(params[5]));
    b.round_off = params[6] === null ? null : Number(params[6]);
    return { rows: [{ id: b.id }] };
  }
  if (s.startsWith("update \"bills\" set closed_at = now(), closed_by_username = $1 where table_id = $2")) {
    for (const b of store.bills) {
      if (b.table_id === str(params[1]) && inOutlet(b, params, 3) && b.closed_at === null && b.admin_approved_at !== null) {
        b.closed_at = nowIso();
        b.closed_by_username = str(params[0]);
      }
    }
    return { rows: [] };
  }
  if (s.startsWith("select id, table_id from \"bills\" where table_id = $1")) {
    const b = openBillOf(str(params[0]), (x) => inOutlet(x, params, 2) && x.admin_approved_at !== null && x.status !== 3);
    return { rows: b ? [{ id: b.id, table_id: b.table_id }] : [] };
  }
  if (s.startsWith("select id from \"bills\" where table_id = $1") && s.includes("admin_approved_at is not null")) {
    const b = store.bills.filter((x) => x.table_id === str(params[0]) && x.admin_approved_at !== null
      && (!s.includes("closed_at is not null") || x.closed_at !== null))[0];
    return { rows: b ? [{ id: b.id }] : [] };
  }
  if (s.startsWith("update \"bills\" set closed_at = now(), closed_by_username = $1 where id = $2")) {
    const b = store.bills.find((x) => x.id === str(params[1]));
    if (b) {b.closed_at = nowIso(); b.closed_by_username = str(params[0]);}
    return { rows: b ? [{ id: b.id }] : [] };
  }
  if (s.startsWith("select total_amt from \"bills\" where res_id = $1 and outlet_id = $2 and payment_proof_screenshot_url = $3")) {
    const b = store.bills.find((x) => inOutlet(x, params, 1) && x.payment_proof_screenshot_url === str(params[2]));
    return { rows: b ? [{ total_amt: b.total_amt }] : [] };
  }
  if (s.startsWith("insert into \"bills\"")) {
    // FinalizeOnlinePayment: ($1 id, $2 res, $3 outlet, $4 table, $5 emp, $6 order, $7 total, $8 tax, $9 bill_no)
    // MergeTableBills:       ($1 id, $2 res, $3 outlet, $4 table, $5 total, $6 bill_no)
    const merge = s.includes("null, 1, null, $5");
    const tableId = str(params[3]);
    if (openBillOf(tableId)) {return { rows: [] };} // bills_one_open_per_table: on conflict do nothing
    store.bills.push({
      id: str(params[0]), outlet_id: str(params[2]), table_id: tableId, status: merge ? 1 : 0,
      bill_no: str(merge ? params[5] : params[8]), total_amt: Number(merge ? params[4] : params[6]),
      tax_breakdown: merge ? [] : JSON.parse(str(params[7])), round_off: null, created_at: nowIso(),
      closed_at: null, closed_by_username: null, waiter_confirmed_at: null, admin_approved_at: null,
      admin_approved_by_username: null, payment_method: null, payment_proof_screenshot_url: null,
      discount_type: null, discount_value: 0,
    });
    return { rows: merge ? [] : [{ id: str(params[0]) }] };
  }
  if (s.startsWith("update \"bills\" set total_amt = $1, tax_breakdown = $2::jsonb, payment_method = 'razorpay'")) {
    const b = store.bills.find((x) => x.id === str(params[3]));
    if (b) {
      Object.assign(b, {
        total_amt: Number(params[0]), tax_breakdown: JSON.parse(str(params[1])), payment_method: "Razorpay",
        payment_proof_screenshot_url: str(params[2]), waiter_confirmed_at: nowIso(), admin_approved_at: nowIso(),
        admin_approved_by_username: "razorpay", closed_at: nowIso(), closed_by_username: "razorpay", status: 2,
        round_off: params[6] === null ? null : Number(params[6]),
      });
    }
    return { rows: [] };
  }
  if (s.startsWith("select count(*)::text as n from \"bills\"") && s.includes("waiter_confirmed_at is not null")) {
    const n = store.bills.filter((b) => b.table_id === str(params[2]) && inOutlet(b, params, 1) && b.closed_at === null
      && b.waiter_confirmed_at !== null && b.admin_approved_at === null).length;
    return { rows: [{ n: String(n) }] };
  }
  if (s.startsWith("update \"bills\" set closed_at = now(), closed_by_username = 'released'")) {
    for (const b of store.bills) {
      if (b.table_id !== str(params[2]) || !inOutlet(b, params, 1) || b.closed_at !== null) {continue;}
      b.closed_at = nowIso();
      b.closed_by_username = "released";
      if (b.admin_approved_at === null) {b.total_amt = 0; b.tax_breakdown = []; b.round_off = null;}
    }
    return { rows: [] };
  }
  if (s.startsWith("update \"bills\" set total_amt = $1, round_off = null where id = $2")) {
    const b = store.bills.find((x) => x.id === str(params[1]));
    if (b) {b.total_amt = Number(params[0]); b.round_off = null;}
    return { rows: [] };
  }
  if (s.startsWith("update \"bills\" set closed_at = now(), closed_by_username = 'merge'")) {
    for (const b of store.bills) {
      if (b.table_id === str(params[0]) && inOutlet(b, params, 2) && b.closed_at === null) {
        Object.assign(b, { closed_at: nowIso(), closed_by_username: "merge", total_amt: 0, tax_breakdown: [], round_off: null });
      }
    }
    return { rows: [] };
  }
  if (s.startsWith("select admin_approved_at from \"bills\"")) {
    const b = openBillOf(str(params[0]));
    return { rows: b ? [{ admin_approved_at: b.admin_approved_at }] : [] };
  }

  throw new Error(`next_party_fixtures: unmodelled SQL: ${sql.slice(0, 260)}`);
}

// ---------------------------------------------------------------------------
// Settle as NC (migration 052) and its re-open, over the same floor. Only the
// statements those two paths issue; anything else falls through to the
// dispatch above, which throws on what it does not know.
// ---------------------------------------------------------------------------

const ncValue = (r: NcRowFix): number => Math.round(r.quantity * r.unit_price * 100) / 100;

function ncOut(r: NcRowFix): Record<string, unknown> {
  return {
    id: r.id, created_at: new Date(r.created_at), outlet_id: r.outlet_id, order_id: r.order_id,
    item_id: r.item_id, item_name: r.item_name, table_id: r.table_id, nc_kind: r.nc_kind,
    reason: r.reason, quantity: r.quantity, unit_price: r.unit_price, menu_price_at_nc: r.menu_price_at_nc,
    value: ncValue(r), marked_by_username: r.marked_by_username, authorised_by_username: r.authorised_by_username,
    reversed_at: r.reversed_at ? new Date(r.reversed_at) : null,
    reversed_by_username: r.reversed_by_username, reversal_reason: r.reversal_reason,
  };
}

async function ncDispatch(clientId: number, s: string, params: unknown[]): Promise<{ rows: unknown[] } | null> {
  // billNcColumnsPresent: 052 is modelled as applied.
  if (s.includes("information_schema.columns") && s.includes("table_name = 'orderitemnonchargeable'")) {
    return { rows: [{ n: 3 }] };
  }
  // GetMenuItems — the settle's advisory price snapshot. Nothing on the menu here.
  if (s.includes('from "menu" m left join "menue_sub_cat"')) {return { rows: [] };}
  if (s.startsWith('select table_id, status from "orders" where id = $1')) {
    const o = store.orders.find((x) => x.id === str(params[0]) && inOutlet(x, params, 2));
    return { rows: o ? [{ table_id: o.table_id, status: o.status }] : [] };
  }
  if (s.startsWith('select status from "orders" where id = $1')) {
    const o = store.orders.find((x) => x.id === str(params[0]) && inOutlet(x, params, 2));
    return { rows: o ? [{ status: o.status }] : [] };
  }
  // The settle's owing orders, locked FIRST.
  if (s.startsWith('select id, food, status from "orders" where res_id = $1 and outlet_id = $2 and table_id = $3')) {
    if (!s.endsWith("for update")) {throw new Error("next_party_fixtures: the NC settle must lock the owing orders");}
    const rows = store.orders
      .filter((o) => inOutlet(o, params, 1) && o.table_id === str(params[2]) && isOwing(o.status))
      .sort((a, z) => (a.created_at < z.created_at ? -1 : 1));
    for (const o of rows) {await lockRow(clientId, o.id);}
    return { rows: rows.map((o) => ({ id: o.id, food: JSON.stringify(o.food), status: o.status })) };
  }
  // assertTableSessionOpen.
  if (s.startsWith('select count(*)::int as n from "orders" where res_id = $1 and outlet_id = $2 and table_id = $3')) {
    return { rows: [{ n: store.orders.filter((o) => inOutlet(o, params, 1) && o.table_id === str(params[2]) && isOwing(o.status)).length }] };
  }
  // closedNcBillForTable: the table's newest bill, whatever its state.
  if (s.startsWith('select id, bill_no::text as bill_no, payment_method, closed_at from "bills"')) {
    const b = store.bills.filter((x) => x.table_id === str(params[0]) && inOutlet(x, params, 2))
      .sort((a, z) => (a.created_at < z.created_at ? 1 : -1))[0];
    return { rows: b ? [{ id: b.id, bill_no: b.bill_no, payment_method: b.payment_method, closed_at: b.closed_at ? new Date(b.closed_at) : null }] : [] };
  }
  if (s.startsWith('select id, bill_no::text as bill_no, waiter_confirmed_at, discount_value, coupon_code from "bills"')) {
    if (!s.endsWith("for update")) {throw new Error("next_party_fixtures: the NC settle must lock the open bill");}
    const b = openBillOf(str(params[0]), (x) => inOutlet(x, params, 2));
    return { rows: b ? [{ id: b.id, bill_no: b.bill_no, waiter_confirmed_at: b.waiter_confirmed_at, discount_value: b.discount_value, coupon_code: null }] : [] };
  }
  // The NC settle's own bill, minted only when the table has none.
  if (s.startsWith('insert into "bills"') && s.includes("returning id, bill_no::text as bill_no")) {
    const tableId = str(params[3]);
    if (openBillOf(tableId)) {return { rows: [] };}
    store.bills.push({
      id: str(params[0]), outlet_id: str(params[2]), table_id: tableId, status: 1, bill_no: str(params[7]),
      total_amt: Number(params[6]), tax_breakdown: [], round_off: null, created_at: nowIso(), closed_at: null,
      closed_by_username: null, waiter_confirmed_at: null, admin_approved_at: null, admin_approved_by_username: null,
      payment_method: null, payment_proof_screenshot_url: null, discount_type: null, discount_value: 0,
    });
    return { rows: [{ id: str(params[0]), bill_no: str(params[7]) }] };
  }
  if (s.startsWith('select bill_no::text as bill_no from "bills" where id = $1')) {
    const b = store.bills.find((x) => x.id === str(params[0]));
    return { rows: b ? [{ bill_no: b.bill_no }] : [] };
  }
  if (s.startsWith('insert into "orderitemnonchargeable"')) {
    if (!s.includes("'bill',$17,$18")) {throw new Error("next_party_fixtures: a settle's comps are scope 'bill'");}
    const [id, , outlet, orderId, itemId, name, tableId, kind, reason, qty, unit, menuPrice, , by, , auth, billId, group] = params;
    if (store.nc.some((r) => r.order_id === str(orderId) && r.item_id === str(itemId) && r.reversed_at === null)) {
      throw Object.assign(new Error("duplicate key value violates unique constraint \"orderitemnc_live_line_uidx\""), { code: "23505" });
    }
    const row: NcRowFix = {
      id: str(id), created_at: nowIso(), outlet_id: str(outlet), order_id: str(orderId), item_id: str(itemId),
      item_name: str(name), table_id: tableId === null ? null : str(tableId), nc_kind: str(kind), reason: str(reason),
      quantity: Number(qty), unit_price: Number(unit), menu_price_at_nc: menuPrice === null ? null : Number(menuPrice),
      marked_by_username: str(by), authorised_by_username: str(auth), scope: "bill", bill_id: str(billId),
      settle_group: str(group), reversed_at: null, reversed_by_username: null, reversal_reason: null,
    };
    store.nc.push(row);
    return { rows: [ncOut(row)] };
  }
  if (s.startsWith('update "orders" set food = $4::json where id = $1')) {
    const o = store.orders.find((x) => x.id === str(params[0]) && inOutlet(x, params, 2));
    if (o) {o.food = JSON.parse(str(params[3])) as Record<string, unknown>;}
    return { rows: [] };
  }
  if (s.startsWith('select food from "orders" where id = $1') && s.endsWith("for update")) {
    const o = store.orders.find((x) => x.id === str(params[0]) && inOutlet(x, params, 2));
    if (o) {await lockRow(clientId, o.id);}
    return { rows: o ? [{ food: JSON.stringify(o.food) }] : [] };
  }
  // liveNcOnOrders.
  if (s.includes('from "orderitemnonchargeable" where res_id = $1 and order_id = any($2::uuid[]) and reversed_at is null')) {
    const ids = ((params[1] as string[]) ?? []).map(String);
    return { rows: store.nc.filter((r) => ids.includes(r.order_id) && r.reversed_at === null).map(ncOut) };
  }
  // The settle's close: 'NC', ₹0, every stamp.
  if (s.startsWith('update "bills" set payment_method = $1, payment_splits = null, payment_proof_screenshot_url = null, total_amt = 0')) {
    const b = store.bills.find((x) => x.id === str(params[2]) && inOutlet(x, params, 4) && x.closed_at === null && x.status !== 3);
    if (!b) {return { rows: [] };}
    Object.assign(b, {
      payment_method: str(params[0]), payment_proof_screenshot_url: null, total_amt: 0, tax_breakdown: [],
      round_off: Number(params[5]), waiter_confirmed_at: nowIso(), admin_approved_at: nowIso(),
      admin_approved_by_username: str(params[1]), closed_at: nowIso(), closed_by_username: str(params[1]), status: 2,
    });
    return { rows: [{ id: b.id }] };
  }
  // ReopenBill of an NC bill: the settle's comps reversed...
  if (s.startsWith('update "orderitemnonchargeable" set reversed_at = now()')) {
    if (!s.includes("scope = 'bill'")) {throw new Error("next_party_fixtures: a re-open reverses the settle's comps only");}
    const out: Record<string, unknown>[] = [];
    for (const r of store.nc) {
      if (r.bill_id !== str(params[1]) || r.scope !== "bill" || r.reversed_at !== null) {continue;}
      Object.assign(r, { reversed_at: nowIso(), reversed_by_username: str(params[2]), reversal_reason: str(params[3]) });
      out.push({ id: r.id, order_id: r.order_id, value: ncValue(r), settle_group: r.settle_group });
    }
    return { rows: out };
  }
  // ...its orders back to Served (a paid bill's go to Payment Pending Approval)...
  if (s.startsWith('update "orders" set status = 2, food = jsonb_set(')) {
    assertSettledWindow(s);
    const after = at(new Date(params[3] as string | Date).toISOString());
    const upTo = at(new Date(params[4] as string | Date).toISOString());
    const out: { id: string }[] = [];
    for (const o of store.orders) {
      if (!inOutlet(o, params, 1) || o.table_id !== str(params[2]) || !["4", "7"].includes(str(o.status) || "1")) {continue;}
      if (!inSettledWindow(o, after, upTo)) {continue;}
      o.status = "2";
      o.food = { ...o.food, status: "Served" };
      out.push({ id: o.id });
    }
    return { rows: out };
  }
  // ...and the bill an ordinary unpaid one again.
  if (s.startsWith('update "bills" set payment_method = null, payment_splits = null, payment_proof_screenshot_url = null, waiter_confirmed_at = null')) {
    const b = store.bills.find((x) => x.id === str(params[0]) && inOutlet(x, params, 2));
    if (b) {
      Object.assign(b, {
        payment_method: null, payment_proof_screenshot_url: null, waiter_confirmed_at: null,
        total_amt: Number(params[3]), tax_breakdown: [], round_off: null,
      });
    }
    return { rows: [] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fake pg wiring — the globalThis pattern the sibling fixtures use, because a
// jest.mock("pg") factory is hoisted above imports and cannot close over them.
// Every connect() is its OWN client (see the header).
// ---------------------------------------------------------------------------

let clientSeq = 0;

interface FixtureGlobal {
  __nextPartyFixture?: {
    connect: () => { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; release: () => void };
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  };
}

(globalThis as unknown as FixtureGlobal).__nextPartyFixture = {
  connect: () => {
    const id = ++clientSeq;
    const stack: Snapshot[] = [];
    return {
      query: (sql: string, params?: unknown[]) => query(id, stack, sql, params ?? []),
      release: () => { releaseLocks(id); },
    };
  },
  // Pool.query outside any transaction: its own momentary client.
  query: (sql: string, params?: unknown[]) => query(++clientSeq, [], sql, params ?? []),
};
