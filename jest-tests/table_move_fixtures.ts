// In-memory store + a fake `pg` Pool so the REAL move paths in
// database_supabase.ts — MoveTableParty and MoveOrderToTable — can be exercised
// without a database. Same shape and reasoning as
// table_section_order_fixtures.ts and table_assignment_fixtures.ts.
//
// WHY THIS FIXTURE MODELS TWO THINGS THE OTHERS DO NOT
// ---------------------------------------------------
// 1) THE TRANSACTION, WITH REAL ROLLBACK. Moving a party is the one feature here
//    whose dangerous outcome is HALF SUCCESS — orders on the new table, seating
//    still on the old one — so "it is atomic" is the claim that most needs
//    proving. A fixture that only recorded BEGIN/COMMIT could assert the shape
//    but never that a failure UNDOES anything. So this one snapshots the whole
//    store on BEGIN and restores it on ROLLBACK, which is what a single
//    Postgres connection does, and gives the tests a `failOn` hook that makes a
//    chosen statement throw. A test can then stop the move at any step and
//    assert the floor is exactly as it was.
//
// 2) THE "TableSessions" TRIGGER. Covers, APC and turnaround all hang off one
//    row per SEATING, and that row is written by table_session_track — a
//    DATABASE trigger on "Tables", not by any call site. A move that did not
//    account for it would silently count one party's covers twice, and no test
//    written against the TypeScript alone could see that. So the trigger is
//    reproduced here from its own body: an update that flips is_occupied
//    false -> true inserts a session, true -> false closes the newest open one,
//    and a covers change on an occupied table updates it. Change the shipped
//    trigger and this fixture is what has to change with it.
//
// WHAT IT DELIBERATELY DOES NOT MODEL: isolation and RLS. There is one
// connection, so `for update` cannot actually block and `app.res_id` filters
// nothing. What can be proved without them is everything this feature can get
// wrong on its own — which statements run, in what order, inside which
// transaction, and what the rows look like afterwards.
//
// Dispatch THROWS on any unrecognised statement, so a code path that starts
// issuing a new query fails loudly rather than silently receiving zero rows.

export const RES_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
export const OUTLET_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
export const RESTAURANT_SLUG = "gaia";

export interface TableFix {
  id: string;
  table_name: string;
  capacity: number;
  max_capacity: number | null;
  section: string | null;
  is_occupied: boolean;
  num_covers: number | null;
  linked_order_id: string | null;
  order_otp: string | null;
  is_deleted: boolean;
  is_virtual: boolean;
}

export interface OrderFix {
  id: string;
  table_id: string | null;
  /** "Orders".food, the JSON blob that carries the printed table name and the
   *  line items. Stored parsed; the dispatcher re-serialises on write, exactly
   *  as the shipped statements do. */
  food: Record<string, unknown>;
  /** '1' new … '4' paid, '5' cancelled, '6' payment pending, '7' closed, '8' awaiting approval. */
  status: string;
  created_at: string;
  /** When the kitchen was told (MoveBillItem carries it to the dish's new order). */
  barked_at?: string | null;
}

export interface BillFix {
  id: string;
  table_id: string;
  total_amt: number;
  closed_at: string | null;
  admin_approved_at: string | null;
  bill_no: string | null;
  created_at: string;
}

/** One row per SEATING. seated_at when a table flips to occupied, left_at when
 *  it flips back. Written ONLY by the trigger below — never by a call site. */
export interface SessionFix {
  id: string;
  table_id: string;
  table_name: string | null;
  covers: number;
  seated_at: string;
  left_at: string | null;
}

export interface AssignmentFix {
  id: string;
  table_id: string;
  employee_id: string;
  created_at: string;
}

export interface BookingFix {
  id: string;
  table_id: string | null;
  slot: string;
  created_at: string;
}

interface Store {
  tables: TableFix[];
  orders: OrderFix[];
  bills: BillFix[];
  sessions: SessionFix[];
  assignments: AssignmentFix[];
  bookings: BookingFix[];
  /** ticket_key -> kot_no, migration 029's memo. */
  kotTickets: Map<string, number>;
  billSeq: number;
  log: string[];
  nextId: number;
  /** Snapshots pushed by BEGIN / SAVEPOINT and popped by COMMIT / ROLLBACK. */
  stack: Omit<Store, "stack" | "failOn" | "log">[];
  /** Make the next statement matching this substring throw. */
  failOn: string | null;
}

let store: Store = freshStore();

function freshStore(): Store {
  return {
    tables: [], orders: [], bills: [], sessions: [], assignments: [], bookings: [],
    kotTickets: new Map(), billSeq: 100, log: [], nextId: 1, stack: [], failOn: null,
  };
}

export function resetStore(): void {
  store = freshStore();
}

/** Make the first statement containing [needle] throw, as a lost connection or a
 *  constraint violation would. The move must then leave nothing behind. */
export function failNextStatementContaining(needle: string | null): void {
  store.failOn = needle;
}

function snapshot(): Omit<Store, "stack" | "failOn" | "log"> {
  return {
    tables: store.tables.map((r) => ({ ...r })),
    orders: store.orders.map((r) => ({ ...r, food: JSON.parse(JSON.stringify(r.food)) as Record<string, unknown> })),
    bills: store.bills.map((r) => ({ ...r })),
    sessions: store.sessions.map((r) => ({ ...r })),
    assignments: store.assignments.map((r) => ({ ...r })),
    bookings: store.bookings.map((r) => ({ ...r })),
    kotTickets: new Map(store.kotTickets),
    billSeq: store.billSeq,
    nextId: store.nextId,
  };
}

function restore(snap: Omit<Store, "stack" | "failOn" | "log">): void {
  store.tables = snap.tables;
  store.orders = snap.orders;
  store.bills = snap.bills;
  store.sessions = snap.sessions;
  store.assignments = snap.assignments;
  store.bookings = snap.bookings;
  store.kotTickets = snap.kotTickets;
  store.billSeq = snap.billSeq;
  store.nextId = snap.nextId;
}

// --- seeding ---------------------------------------------------------------

export function addTable(t: Partial<TableFix> & { table_name: string }): TableFix {
  const row: TableFix = {
    id: `t-${String(store.nextId++)}`,
    capacity: 4,
    max_capacity: null,
    section: null,
    is_occupied: false,
    num_covers: 1,
    linked_order_id: null,
    order_otp: null,
    is_deleted: false,
    is_virtual: false,
    ...t,
  };
  store.tables.push(row);
  // A table seeded as already seated must carry the seating row the trigger
  // would have written, or every test about covers would start from a state the
  // database cannot actually be in.
  if (row.is_occupied) {
    store.sessions.push({
      id: `s-${String(store.nextId++)}`,
      table_id: row.id,
      table_name: row.table_name,
      covers: Math.max(1, row.num_covers ?? 1),
      seated_at: "2026-09-09T12:00:00.000Z",
      left_at: null,
    });
  }
  return row;
}

export function addOrder(o: Partial<OrderFix> & { table_id: string }): OrderFix {
  const row: OrderFix = {
    id: `o-${String(store.nextId++)}`,
    food: { total: 500, subtotal: 500, table: "", items: [] },
    status: "1",
    created_at: "2026-09-09T12:05:00.000Z",
    ...o,
  };
  store.orders.push(row);
  return row;
}

export function addBill(b: Partial<BillFix> & { table_id: string }): BillFix {
  const row: BillFix = {
    id: `b-${String(store.nextId++)}`,
    total_amt: 500,
    closed_at: null,
    admin_approved_at: null,
    bill_no: "B-42",
    created_at: "2026-09-09T12:06:00.000Z",
    ...b,
  };
  store.bills.push(row);
  return row;
}

/** Strip a table's seating rows, modelling the one state the repair has to cope
 *  with: a table that was occupied before the table_session_track trigger
 *  existed, so there is no open session to carry across. */
export function dropSessionsFor(tableId: string): void {
  store.sessions = store.sessions.filter((s) => s.table_id !== tableId);
}

export function addAssignment(tableId: string, employeeId: string): void {
  store.assignments.push({
    id: `a-${String(store.nextId++)}`, table_id: tableId, employee_id: employeeId,
    created_at: "2026-09-09T12:00:00.000Z",
  });
}

export function addBooking(tableId: string, status: string): void {
  store.bookings.push({
    id: `bk-${String(store.nextId++)}`, table_id: tableId,
    slot: JSON.stringify({ start: "2026-09-09T12:00:00.000Z", duration: 120, status }),
    created_at: "2026-09-09T11:00:00.000Z",
  });
}

// --- reading back for assertions -------------------------------------------

export const tables = (): TableFix[] => store.tables.map((r) => ({ ...r }));
export const orders = (): OrderFix[] => store.orders.map((r) => ({ ...r, food: { ...r.food } }));
export const bills = (): BillFix[] => store.bills.map((r) => ({ ...r }));
export const sessions = (): SessionFix[] => store.sessions.map((r) => ({ ...r }));
export const assignments = (): AssignmentFix[] => store.assignments.map((r) => ({ ...r }));
export const bookings = (): BookingFix[] => store.bookings.map((r) => ({ ...r }));
export const statements = (): string[] => [...store.log];

export function tableByName(name: string): TableFix | undefined {
  const hit = store.tables.find((t) => t.table_name.toLowerCase() === name.toLowerCase());
  return hit ? { ...hit } : undefined;
}

/** The still-open seating rows. The number of these is the covers question:
 *  one party must own exactly one. */
export const openSessions = (): SessionFix[] => sessions().filter((s) => s.left_at === null);

// ---------------------------------------------------------------------------
// SQL dispatch
// ---------------------------------------------------------------------------

const NOW = "2026-09-09T13:00:00.000Z";
const str = (v: unknown): string => String(v ?? "");

function contextRow(): Record<string, unknown> {
  return {
    res_id: RES_ID,
    outlet_id: OUTLET_ID,
    restaurant_slug: RESTAURANT_SLUG,
    restaurant_name: "Gaia",
    restaurant_main_office_add: null,
    restaurant_logo_url: null,
    timezone: "Asia/Kolkata",
  };
}

/**
 * table_session_track, reproduced from the shipped trigger body.
 *
 * Applied by the dispatcher after EVERY update to a "Tables" row, because that
 * is when Postgres applies it — not when a caller remembers to.
 */
function fireSessionTrigger(before: TableFix, after: TableFix): void {
  const was = before.is_occupied;
  const now = after.is_occupied;
  if (!was && now) {
    store.sessions.push({
      id: `s-${String(store.nextId++)}`,
      table_id: after.id,
      table_name: after.table_name,
      covers: Math.max(1, after.num_covers ?? 1),
      seated_at: NOW,
      left_at: null,
    });
    return;
  }
  if (was && !now) {
    const open = store.sessions
      .filter((s) => s.table_id === after.id && s.left_at === null)
      .sort((a, b) => (a.seated_at < b.seated_at ? 1 : -1))[0];
    if (open) {
      open.left_at = NOW;
      open.covers = Math.max(open.covers || 1, before.num_covers ?? 1);
    }
    return;
  }
  if (now && (after.num_covers ?? 1) !== (before.num_covers ?? 1)) {
    const open = store.sessions
      .filter((s) => s.table_id === after.id && s.left_at === null)
      .sort((a, b) => (a.seated_at < b.seated_at ? 1 : -1))[0];
    if (open) {open.covers = Math.max(1, after.num_covers ?? 1);}
  }
}

/** The active-order status filter every money statement here carries. */
const isActive = (status: string): boolean => !["4", "5", "7"].includes(str(status) || "1");

function query(sqlRaw: string, params: unknown[] = []): { rows: unknown[] } {
  const sql = sqlRaw.replace(/\s+/g, " ").trim();
  const s = sql.toLowerCase();
  store.log.push(s);

  if (store.failOn && s.includes(store.failOn.toLowerCase())) {
    store.failOn = null;
    throw new Error(`fixture: injected failure on "${store.failOn ?? sql.slice(0, 60)}"`);
  }

  // --- transaction control, MODELLED (see this file's header) --------------
  if (s === "begin" || s.startsWith("savepoint")) {store.stack.push(snapshot()); return { rows: [] };}
  if (s === "commit" || s.startsWith("release savepoint")) {store.stack.pop(); return { rows: [] };}
  if (s === "rollback" || s.startsWith("rollback to savepoint")) {
    const snap = store.stack.pop();
    if (snap) {restore(snap);}
    return { rows: [] };
  }
  if (s.includes("set_config(")) {return { rows: [] };}

  // --- lazy DDL and RLS — nothing to model --------------------------------
  if (/^(create|alter|drop)\b/.test(s)) {return { rows: [] };}
  if (s.startsWith("do $$")) {return { rows: [] };}
  if (s.includes('insert into "actions"')) {return { rows: [] };}

  // --- context ------------------------------------------------------------
  if (s.includes('from "restaurant" r')) {return { rows: [contextRow()] };}

  // --- MoveTableParty / MoveOrderToTable: the locked two-row read ----------
  if (s.includes('from "tables"') && s.includes("order by id") && s.includes("coalesce(is_virtual, false) as is_virtual")) {
    const live = store.tables.filter((t) => !t.is_deleted);
    let rows: TableFix[];
    if (s.includes("lower(btrim(table_name)) in")) {
      const a = str(params[2]).trim().toLowerCase();
      const b = str(params[3]).trim().toLowerCase();
      rows = live.filter((t) => [a, b].includes(t.table_name.trim().toLowerCase()));
    } else {
      const id = str(params[2]);
      const name = str(params[3]).trim().toLowerCase();
      rows = live.filter((t) => t.id === id || t.table_name.trim().toLowerCase() === name);
    }
    return {
      rows: [...rows].sort((x, y) => (x.id < y.id ? -1 : 1)).map((t) => ({
        id: t.id, table_name: t.table_name, capacity: t.capacity, max_capacity: t.max_capacity,
        is_occupied: t.is_occupied, num_covers: t.num_covers, linked_order_id: t.linked_order_id,
        order_otp: t.order_otp, is_virtual: t.is_virtual,
      })),
    };
  }

  // --- assertBillEditable --------------------------------------------------
  if (s.includes('select admin_approved_at from "bills"')) {
    const tableId = str(params[0]);
    const open = store.bills
      .filter((b) => b.table_id === tableId && b.closed_at === null)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    return { rows: open ? [{ admin_approved_at: open.admin_approved_at }] : [] };
  }

  // --- the stray-open-bill guard ------------------------------------------
  if (s.includes('count(*)::text as n from "bills"')) {
    const tableId = str(params[2]);
    const n = store.bills.filter((b) => b.table_id === tableId && b.closed_at === null).length;
    return { rows: [{ n: String(n) }] };
  }

  // --- the source table's active orders -----------------------------------
  if (s.includes('select id, food from "orders"')) {
    const tableId = str(params[2]);
    return {
      rows: store.orders
        .filter((o) => o.table_id === tableId && isActive(o.status))
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
        .map((o) => ({ id: o.id, food: JSON.stringify(o.food) })),
    };
  }

  // --- MoveBillItem (client item 4): the source orders WITH their stage and
  //     bark time, the lines coming off them, and the destination's new order.
  if (s.includes('select id, food, status, barked_at from "orders"')) {
    const tableId = str(params[2]);
    return {
      rows: store.orders
        .filter((o) => o.table_id === tableId && isActive(o.status))
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
        .map((o) => ({ id: o.id, food: JSON.stringify(o.food), status: o.status, barked_at: o.barked_at ?? null })),
    };
  }
  if (s.startsWith('select id from "tables" where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3)')) {
    const name = str(params[2]).trim().toLowerCase();
    const t = store.tables.find((x) => !x.is_deleted && x.table_name.trim().toLowerCase() === name);
    return { rows: t ? [{ id: t.id }] : [] };
  }
  if (s.startsWith('update "orders" set food = $4::json, status = 5 where')) {
    const o = store.orders.find((r) => r.id === str(params[0]));
    if (o) { o.food = JSON.parse(str(params[3])) as Record<string, unknown>; o.status = "5"; }
    return { rows: [] };
  }
  if (s.startsWith('update "orders" set food = $4::json where')) {
    const o = store.orders.find((r) => r.id === str(params[0]));
    if (o) { o.food = JSON.parse(str(params[3])) as Record<string, unknown>; }
    return { rows: [] };
  }
  if (s.startsWith('insert into "orders" (id, created_at, res_id, outlet_id, food, table_id, status, barked_at)')) {
    store.orders.push({
      id: str(params[0]),
      table_id: str(params[4]),
      food: JSON.parse(str(params[3])) as Record<string, unknown>,
      status: str(params[5]),
      created_at: NOW,
      barked_at: params[6] === null || params[6] === undefined ? null : str(params[6]),
    });
    return { rows: [] };
  }
  if (s.includes("from information_schema.columns") && s.includes("column_name = 'barked_at'")) {
    return { rows: [{ column_name: "barked_at" }] };
  }

  // --- BarkOrder, on the order a dish move made (client item 4): the status
  //     guard, and the compare-and-set read that answers already_barked.
  if (s.startsWith('select status from "orders" where id = $1')) {
    const o = store.orders.find((r) => r.id === str(params[0]));
    return { rows: o ? [{ status: o.status }] : [] };
  }
  if (s.startsWith('select status, barked_at, food from "orders" where id = $1')) {
    const o = store.orders.find((r) => r.id === str(params[0]));
    return { rows: o ? [{ status: o.status, barked_at: o.barked_at ?? null, food: JSON.stringify(o.food) }] : [] };
  }

  // --- one order, by id ----------------------------------------------------
  if (s.includes('select id, table_id, food, status from "orders"')) {
    const o = store.orders.find((r) => r.id === str(params[0]));
    return { rows: o ? [{ id: o.id, table_id: o.table_id, food: JSON.stringify(o.food), status: o.status }] : [] };
  }

  // --- move an order -------------------------------------------------------
  if (s.startsWith('update "orders" set table_id =')) {
    const o = store.orders.find((r) => r.id === str(params[2]));
    if (o) {
      o.table_id = str(params[0]);
      o.food = JSON.parse(str(params[1])) as Record<string, unknown>;
    }
    return { rows: [] };
  }

  // --- move the open bill ROW (not a rebuild) ------------------------------
  if (s.startsWith('update "bills" set table_id =')) {
    const moved = store.bills.filter((b) => b.table_id === str(params[3]) && b.closed_at === null);
    for (const b of moved) {b.table_id = str(params[0]);}
    return { rows: moved.map((b) => ({ id: b.id })) };
  }

  // --- resyncOpenBillTotal -------------------------------------------------
  if (s.startsWith('update "bills" set total_amt =')) {
    const b = store.bills.find((r) => r.id === str(params[1]));
    if (b) {b.total_amt = Number(params[0]);}
    return { rows: [] };
  }
  if (s.includes('select id from "bills" where table_id =') && s.includes("closed_at is null")) {
    const open = store.bills
      .filter((b) => b.table_id === str(params[0]) && b.closed_at === null)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    return { rows: open ? [{ id: open.id }] : [] };
  }
  if (s.startsWith('insert into "bills"')) {
    store.bills.push({
      id: str(params[0]), table_id: str(params[3]), total_amt: Number(params[4]),
      closed_at: null, admin_approved_at: null, bill_no: str(params[5]), created_at: NOW,
    });
    return { rows: [] };
  }
  if (s.includes('update "outlets" set bill_seq')) {
    store.billSeq += 1;
    return { rows: [{ bill_seq: store.billSeq }] };
  }

  // --- sumOrderTotalsForTable ---------------------------------------------
  if (s.includes('select food, status from "orders"')) {
    const tableId = str(params[2]);
    return {
      rows: store.orders
        .filter((o) => o.table_id === tableId)
        .map((o) => ({ food: JSON.stringify(o.food), status: o.status })),
    };
  }

  // --- how many active orders are left on a table --------------------------
  if (s.includes('count(*)::text as n from "orders"')) {
    const tableId = str(params[2]);
    const n = store.orders.filter((o) => o.table_id === tableId && isActive(o.status)).length;
    return { rows: [{ n: String(n) }] };
  }

  // --- TableSessions -------------------------------------------------------
  if (s.includes('select id from "tablesessions"')) {
    const open = store.sessions
      .filter((x) => x.table_id === str(params[0]) && x.left_at === null)
      .sort((a, b) => (a.seated_at < b.seated_at ? 1 : -1))[0];
    return { rows: open ? [{ id: open.id }] : [] };
  }
  if (s.startsWith('delete from "tablesessions"')) {
    store.sessions = store.sessions.filter((x) => x.id !== str(params[0]));
    return { rows: [] };
  }
  if (s.startsWith('update "tablesessions" set table_id =')) {
    const row = store.sessions.find((x) => x.id === str(params[0]));
    if (row) {
      row.table_id = str(params[1]);
      row.table_name = str(params[2]);
      row.left_at = null;
    }
    return { rows: [] };
  }

  // --- "Tables" updates, each followed by the trigger ----------------------
  if (s.startsWith('update "tables"')) {
    const id = str(params[0]);
    const row = store.tables.find((t) => t.id === id);
    if (!row) {return { rows: [] };}
    const before = { ...row };
    if (s.includes("set is_occupied = true, num_covers = $4")) {
      row.is_occupied = true;
      row.num_covers = Number(params[3]);
      row.linked_order_id = params[4] === null ? null : str(params[4]);
      row.order_otp = params[5] === null ? null : str(params[5]);
    } else if (s.includes("set is_occupied = false")) {
      row.is_occupied = false;
      row.num_covers = 1;
      row.linked_order_id = null;
      row.order_otp = null;
    } else if (s.includes("set is_occupied = true, num_covers = greatest(1, coalesce(num_covers, 1))")) {
      row.is_occupied = true;
      row.num_covers = Math.max(1, row.num_covers ?? 1);
    } else if (s.startsWith('update "tables" set is_occupied = true where id = $1')) {
      // MoveBillItem seats the destination and leaves its covers alone.
      row.is_occupied = true;
    } else {
      throw new Error(`table_move_fixtures: unmodelled "Tables" update: ${sql.slice(0, 160)}`);
    }
    fireSessionTrigger(before, row);
    return { rows: [] };
  }

  // --- Table_assignments ---------------------------------------------------
  if (s.startsWith('update "table_assignments" set table_id =')) {
    const moved = store.assignments.filter((a) => a.table_id === str(params[3]));
    for (const a of moved) {a.table_id = str(params[0]); a.created_at = NOW;}
    return { rows: moved.map((a) => ({ id: a.id })) };
  }

  // --- Bookings ------------------------------------------------------------
  if (s.includes('select id, slot, created_at from "bookings"')) {
    return {
      rows: store.bookings
        .filter((b) => b.table_id === str(params[2]))
        .map((b) => ({ id: b.id, slot: b.slot, created_at: new Date(b.created_at) })),
    };
  }
  if (s.startsWith('update "bookings" set table_id =')) {
    const b = store.bookings.find((r) => r.id === str(params[0]));
    if (b) {b.table_id = str(params[3]);}
    return { rows: [] };
  }

  throw new Error(`table_move_fixtures: unmodelled SQL: ${sql.slice(0, 220)}`);
}

// ---------------------------------------------------------------------------
// Fake pg wiring — same globalThis pattern as the sibling fixtures, because a
// jest.mock("pg") factory is hoisted above imports and cannot close over them.
// ---------------------------------------------------------------------------

interface FixtureGlobal {
  __tableMoveFixtureConnect?: () => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    release: () => void;
  };
}

(globalThis as unknown as FixtureGlobal).__tableMoveFixtureConnect = () => ({
  query: (sql: string, params?: unknown[]) => Promise.resolve(query(sql, params ?? [])),
  release: () => {/* pooling is not modelled */},
});
