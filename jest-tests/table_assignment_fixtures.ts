// In-memory store + a fake `pg` Pool so the REAL table-waiter assignment paths
// in database_supabase.ts — OccupyTable's auto-assign, AssignTableToEmployee,
// UnassignTableEmployee, GetTableAssignments, GetAssignableEmployees — can be
// exercised as unit tests. Same shape and reasoning as report_fixtures.ts and
// platform_fixtures.ts: none of the guarantees under test live in a TypeScript
// function. "An explicit assignment survives a later occupy" IS the difference
// between `on conflict do update` and `on conflict do nothing` in one INSERT;
// re-implementing that in a test would only prove the copy agrees with itself.
//
// THE RULE THAT KEEPS IT HONEST: the "Table_assignments" INSERT handler derives
// its behaviour from the STATEMENT TEXT — a `do update` conflict clause
// overwrites, `do nothing` keeps the existing row. Reverting the shipped fix
// (auto-assign back to `do update`) therefore fails the regression test in this
// suite instead of the fixture silently enforcing the new rule itself.
//
// WHAT IT DOES NOT MODEL, stated because an inaccurate promise is worse than
// none: transactions are decorative (BEGIN/COMMIT/ROLLBACK are no-ops — nothing
// in these tests asserts atomicity), RLS is not applied, and DDL is swallowed.
// Dispatch THROWS on any unrecognised statement so a code path that starts
// issuing a new query fails loudly rather than silently receiving zero rows.

export const RES_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
export const OUTLET_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
export const RESTAURANT_SLUG = "gaia";

/** The tenant admin — the Employees row behind the dashboard session that drove
 *  the Gaia test night. Every /occupy-table the dashboard makes carries this id
 *  as the acting employee. */
export const ADMIN_EMP_ID = "cccccccc-3333-4333-8333-cccccccccccc";
export const WAITER1_ID = "dddddddd-4444-4444-8444-dddddddddddd";
export const WAITER2_ID = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
export const TABLE1_ID = "ffffffff-6666-4666-8666-ffffffffffff";

export interface EmployeeFix {
  id: string;
  username: string;
  fname: string;
  lname: string | null;
  /** emp_roles payload exactly as the column stores it. */
  roles: { primary: string; all: string[] };
}

export interface TableFix {
  id: string;
  table_name: string;
  capacity: number;
  max_capacity: number;
  is_occupied: boolean;
  num_covers: number;
  linked_order_id: string | null;
}

export interface AttendanceFix {
  emp_id: string;
  clock_in: Date;
  clock_out: Date | null;
  /** null = legacy (approved), 'pending' | 'approved' | 'rejected' */
  status: string | null;
}

export interface AssignmentFix {
  id: string;
  table_id: string;
  employee_id: string;
  created_at: Date;
}

interface Store {
  employees: EmployeeFix[];
  tables: TableFix[];
  attendance: AttendanceFix[];
  /** keyed by table_id — mirrors idx_table_assignments_unique. */
  assignments: Map<string, AssignmentFix>;
}

let store: Store = freshStore();

function freshStore(): Store {
  return { employees: [], tables: [], attendance: [], assignments: new Map() };
}

export function resetStore(): void {
  store = freshStore();
}

export function addEmployee(e: EmployeeFix): void {
  store.employees.push(e);
}

export function addTable(t: Partial<TableFix> & { id: string; table_name: string }): void {
  store.tables.push({
    capacity: 4,
    max_capacity: 6,
    is_occupied: false,
    num_covers: 1,
    linked_order_id: null,
    ...t,
  } as TableFix);
}

export function addAttendance(a: Partial<AttendanceFix> & { emp_id: string }): void {
  store.attendance.push({
    clock_in: new Date("2026-08-24T18:00:00Z"),
    clock_out: null,
    status: "pending",
    ...a,
  } as AttendanceFix);
}

/** Current assignment rows, for assertions. */
export function assignments(): AssignmentFix[] {
  return [...store.assignments.values()];
}

export function assignedEmployeeFor(tableId: string): string | null {
  return store.assignments.get(tableId)?.employee_id ?? null;
}

// ---------------------------------------------------------------------------
// SQL dispatch
// ---------------------------------------------------------------------------

const str = (v: unknown): string => String(v ?? "");
const lower = (v: unknown): string => str(v).toLowerCase();

/** Open, non-rejected shift right now — the fixture's copy of the definition
 *  under test ("clocked in right now"). */
function isClockedIn(empId: string): boolean {
  return store.attendance.some(
    (a) => a.emp_id === empId && a.clock_out === null && a.status !== "rejected",
  );
}

function outletUsesAttendance(): boolean {
  return store.attendance.length > 0;
}

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

function query(sqlRaw: string, params: unknown[] = []): { rows: unknown[] } {
  const sql = sqlRaw.replace(/\s+/g, " ").trim();
  const s = sql.toLowerCase();

  // Transaction control — decorative here (see module header).
  if (/^(begin|commit|rollback|savepoint|release)/.test(s)) {return { rows: [] };}
  if (s.includes("set_config(")) {return { rows: [] };}

  // Lazy DDL / RLS / triggers — swallowed.
  if (s.startsWith("create table if not exists")) {return { rows: [] };}
  if (s.startsWith("create index") || s.startsWith("create unique index")) {return { rows: [] };}
  if (s.startsWith("create or replace function")) {return { rows: [] };}
  if (s.startsWith("create trigger") || s.startsWith("drop trigger")) {return { rows: [] };}
  if (s.startsWith("alter table")) {return { rows: [] };}
  if (s.startsWith("do $$")) {return { rows: [] };}
  if (s.includes('insert into "actions"')) {return { rows: [] };}

  // --- Table_assignments writes --------------------------------------------
  // Behaviour is DERIVED FROM THE STATEMENT: `do update` overwrites the row,
  // `do nothing` keeps it. This is what lets the regression test fail against
  // the pre-fix auto-assign SQL.
  if (s.includes('insert into "table_assignments"')) {
    const [id, , , tableId, employeeId] = [params[0], params[1], params[2], params[3], params[4]];
    const existing = store.assignments.get(str(tableId));
    if (existing) {
      if (/do\s+update/.test(s)) {
        existing.employee_id = str(employeeId);
        if (s.includes("created_at = now()")) {existing.created_at = new Date();}
      }
      // `do nothing` — keep the existing row untouched.
      return { rows: [] };
    }
    store.assignments.set(str(tableId), {
      id: str(id),
      table_id: str(tableId),
      employee_id: str(employeeId),
      created_at: new Date(),
    });
    return { rows: [] };
  }

  if (s.includes('delete from "table_assignments"')) {
    const tableId = str(params[2]);
    const existing = store.assignments.get(tableId);
    if (existing) {store.assignments.delete(tableId);}
    return { rows: existing && s.includes("returning") ? [{ id: existing.id }] : [] };
  }

  if (s.includes('from "table_assignments" ta')) {
    const rows = [...store.assignments.values()]
      .map((a) => {
        const t = store.tables.find((x) => x.id === a.table_id);
        const e = store.employees.find((x) => x.id === a.employee_id);
        if (!t || !e) {return null;}
        return {
          id: a.id,
          table_name: t.table_name,
          employee_username: e.username,
          fname: e.fname,
          lname: e.lname ?? "",
          role_primary: e.roles.primary,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => a.table_name.localeCompare(b.table_name));
    return { rows };
  }

  // --- OTP gate (occupy path) ----------------------------------------------
  if (s.includes("select require_table_otp")) {return { rows: [{ require_table_otp: false }] };}
  if (s.includes('update "tables" set order_otp')) {return { rows: [] };}

  // --- Waiter eligibility (getWaiterEligibility) ---------------------------
  if (s.includes("as attendance_in_use")) {
    const emp = store.employees.find((e) => e.id === str(params[0]));
    if (!emp) {return { rows: [] };}
    return {
      rows: [{
        emp_roles: emp.roles,
        attendance_in_use: outletUsesAttendance(),
        clocked_in: isClockedIn(emp.id),
      }],
    };
  }

  // --- GetAssignableEmployees ----------------------------------------------
  if (s.includes("as in_use")) {return { rows: [{ in_use: outletUsesAttendance() }] };}
  if (s.includes("as clocked_in") && s.includes('from "employees" e')) {
    const rows = store.employees
      .map((e) => ({
        employee_id: e.id,
        emp_username: e.username,
        fname: e.fname,
        lname: e.lname,
        role_primary: e.roles.primary,
        clocked_in: isClockedIn(e.id),
      }))
      .sort((a, b) => a.fname.localeCompare(b.fname));
    return { rows };
  }

  // --- Context resolution (resolveRestaurantContext, both branches) --------
  if (s.includes('from "restaurant" r')) {return { rows: [contextRow()] };}

  // --- Tables reads/writes (OccupyTable / resolveTableByName) --------------
  if (s.includes("select id, capacity, max_capacity")) {
    const t = store.tables.find((x) => lower(x.table_name) === lower(params[2]));
    return { rows: t ? [{ id: t.id, capacity: t.capacity, max_capacity: t.max_capacity }] : [] };
  }
  if (s.includes('update "tables"') && s.includes("is_occupied = true")) {
    const t = store.tables.find((x) => x.id === str(params[0]));
    if (!t) {return { rows: [] };}
    t.is_occupied = true;
    const covers = params[3];
    t.num_covers = covers == null ? Math.max(1, t.num_covers) : Math.max(1, Number(covers));
    t.linked_order_id = params[4] == null ? null : str(params[4]);
    return { rows: [{ is_occupied: t.is_occupied, num_covers: t.num_covers, linked_order_id: t.linked_order_id }] };
  }
  if (s.includes("select id, table_name") && s.includes('from "tables"')) {
    const t = store.tables.find((x) => lower(x.table_name) === lower(params[2]));
    return { rows: t ? [{ id: t.id, table_name: t.table_name }] : [] };
  }

  // --- resolveEmployeeByUsername -------------------------------------------
  if (s.includes('from "login" l')) {
    const needle = str(params[2]).trim();
    const e = store.employees.find(
      (x) => lower(x.username) === needle.toLowerCase() || x.id === needle,
    );
    return {
      rows: e
        ? [{ id: e.id, username: e.username, fname: e.fname, lname: e.lname, role_primary: e.roles.primary }]
        : [],
    };
  }

  throw new Error(`table_assignment_fixtures: unmodelled SQL: ${sql.slice(0, 160)}`);
}

// ---------------------------------------------------------------------------
// Fake pg wiring — same globalThis pattern as the sibling fixtures, because a
// jest.mock("pg") factory is hoisted above imports and cannot close over them.
// ---------------------------------------------------------------------------

interface FixtureGlobal {
  __tableAssignFixtureConnect?: () => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    release: () => void;
  };
}

(globalThis as unknown as FixtureGlobal).__tableAssignFixtureConnect = () => ({
  query: (sql: string, params?: unknown[]) => Promise.resolve(query(sql, params ?? [])),
  release: () => {/* pooling is not modelled */},
});
