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
//
// WHAT IT DOES NOT MODEL: RLS, and rollback under concurrency (a ROLLBACK
// restores the whole store to the snapshot its BEGIN took; no test here rolls
// back while another client is mid-transaction).
//
// Dispatch THROWS on any unrecognised statement, so a path that starts issuing
// a new query fails loudly rather than silently receiving zero rows.

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

export interface PrintJobFix {
  outlet_id: string;
  bill_id: string;
  created_at: string;
  kind: string;
  status: string;
}

interface Store {
  tables: TableFix[];
  orders: OrderFix[];
  bills: BillFix[];
  sessions: SessionFix[];
  printJobs: PrintJobFix[];
  assignments: { table_id: string; employee_id: string }[];
  /** Outlets.default_tax, verbatim. */
  taxes: unknown;
  /** "Restaurant".service_charge — the restaurant_percent leg. */
  scPct: number;
  billSeq: number;
  nextId: number;
  /** The database's now(), advanced by tick(). */
  nowMs: number;
  columnsPresent: boolean;
  lockRows: boolean;
  failOn: string | null;
  log: string[];
}

type Snapshot = Omit<Store, "log" | "failOn" | "columnsPresent" | "lockRows">;

let store: Store = freshStore();

function freshStore(): Store {
  return {
    tables: [], orders: [], bills: [], sessions: [], printJobs: [], assignments: [],
    // Outlets.default_tax as the shipped seed stores it (000_base_schema.sql).
    taxes: { SGST: 2.5, CGST: 2.5 },
    scPct: 0,
    billSeq: 100,
    nextId: 1,
    nowMs: Date.parse("2026-09-16T08:00:00.000Z"),
    columnsPresent: true,
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
    assignments: store.assignments.map((r) => ({ ...r })),
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
  const row: PrintJobFix = { outlet_id: OUTLET_ID, bill_id: billId, created_at: nowIso(), kind: "bill", status: "delivered", ...over };
  store.printJobs.push(row);
  return row;
}

/** Confirm a payment the way the waiter step leaves a bill: ready for approval. */
export function markWaiterConfirmed(billId: string, method = "Cash"): void {
  const b = store.bills.find((x) => x.id === billId);
  if (!b) {throw new Error(`no bill ${billId}`);}
  b.waiter_confirmed_at = nowIso();
  b.payment_method = method;
  for (const o of store.orders.filter((x) => x.table_id === b.table_id && isOwing(x.status))) {o.status = "6";}
}

export function addAssignment(tableName: string, employeeId: string): void {
  store.assignments.push({ table_id: liveTable(tableName).id, employee_id: employeeId });
}

// --- reading back ------------------------------------------------------------

export const tables = (): TableFix[] => store.tables.map((r) => ({ ...r }));
export const orders = (): OrderFix[] => store.orders.map((r) => ({ ...r, food: { ...r.food } }));
export const bills = (): BillFix[] => store.bills.map((r) => ({ ...r }));
export const sessions = (): SessionFix[] => store.sessions.map((r) => ({ ...r }));
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
    return { rows: [] };
  }
  if (s.includes('insert into "actions"')) {return { rows: [] };}

  if (s.includes("information_schema.columns") && s.includes("parent_table_id")) {
    return { rows: [{ n: store.columnsPresent ? 2 : 0 }] };
  }
  if (!store.columnsPresent && (s.includes("parent_table_id") || s.includes("party_seq"))) {
    throw missingColumn();
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
  if (s.startsWith("select bill_id, created_at from \"printjobs\"")) {
    const statuses = (params[3] as string[]) ?? [];
    const floor = params[4] ? Date.parse(str(params[4])) : null;
    return {
      rows: store.printJobs
        .filter((j) => j.outlet_id === str(params[1]) && j.kind === str(params[2]) && statuses.includes(j.status))
        .filter((j) => floor === null || at(j.created_at) >= floor)
        .map((j) => ({ bill_id: j.bill_id, created_at: new Date(j.created_at) })),
    };
  }

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

  // --- MoveTableParty (the statements table_move_fixtures models) -------------
  if (s.includes('from "tables"') && s.includes("order by id") && s.includes("coalesce(is_virtual, false) as is_virtual")) {
    const a = str(params[2]).trim().toLowerCase();
    const b = str(params[3]).trim().toLowerCase();
    return {
      rows: store.tables
        .filter((t) => inOutlet(t, params, 1) && !t.is_deleted && [a, b].includes(t.table_name.trim().toLowerCase()))
        .sort((x, y) => (x.id < y.id ? -1 : 1))
        .map((t) => ({
          id: t.id, table_name: t.table_name, capacity: t.capacity, max_capacity: t.max_capacity,
          is_occupied: t.is_occupied, num_covers: t.num_covers, linked_order_id: t.linked_order_id,
          order_otp: t.order_otp, is_virtual: t.is_virtual,
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
  if (s.startsWith("select min(created_at) as first_at from \"orders\"")) {
    const owing = store.orders.filter((o) => inOutlet(o, params, 1) && tableIs(o, 2) && isOwing(o.status));
    const first = owing.map((o) => o.created_at).sort()[0];
    return { rows: [{ first_at: first ? new Date(first) : null }] };
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
  if (s.startsWith("update \"orders\" set status = $1, food = jsonb_set(")) {
    for (const o of store.orders) {
      if (o.table_id === str(params[2]) && inOutlet(o, params, 4) && isOwing(o.status)) {
        o.status = str(params[0]);
        o.food = { ...o.food, status: str(params[1]) };
      }
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
