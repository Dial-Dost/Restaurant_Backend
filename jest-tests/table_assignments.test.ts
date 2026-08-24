// Table-waiter assignment: durability of explicit assignments + attendance-aware
// assignability. Reproduces the Gaia production failure (punch-list issues 3+7)
// against the REAL functions in database_supabase.ts over the fixture Pool.
//
// THE PRODUCTION SEQUENCE UNDER TEST (issue 3), measured on tenant "Gaia":
//   1. Admin explicitly assigns waiter W to a table (POST /table-assignments/assign).
//   2. Any order placed/edited from the dashboard calls POST /occupy-table around
//      the order save — once for covers, once to link the created order id
//      (Restaurant_Dashboard_UI/src/app/dashboard/orders/page.tsx:698,710).
//   3. /occupy-table passes the SESSION's employee id — the ADMIN's — into
//      OccupyTable, whose auto-assign upsert was `on conflict do update`: the
//      explicit W was silently overwritten with the admin. Seen on 5-10 tables,
//      because every table they touched took the same write.
// Symptom 1 (a waiterless table "auto-assigns the admin") is the same write with
// no prior row. Not a stale UI refresh — a later, genuine DB write.
//
// The fix under test: the auto path only fills a VACANT slot (`do nothing`),
// never assigns an admin, and respects attendance; the explicit path stays
// `do update` (a human's choice always wins) and enforces the clocked-in rule
// server-side. The fixture derives upsert behaviour from the statement text, so
// reverting the SQL to `do update` fails these tests.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import {
  ADMIN_EMP_ID,
  RESTAURANT_SLUG,
  TABLE1_ID,
  WAITER1_ID,
  WAITER2_ID,
  addAttendance,
  addEmployee,
  addTable,
  assignedEmployeeFor,
  assignments,
  resetStore,
} from "./table_assignment_fixtures";

jest.mock("pg", () => {
  interface FixtureGlobal {
    __tableAssignFixtureConnect?: () => { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; release: () => void };
  }
  const conn = () => {
    const make = (globalThis as unknown as FixtureGlobal).__tableAssignFixtureConnect;
    if (!make) {throw new Error("table assignment fixture harness was not loaded");}
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

type Db = typeof import("../database_supabase");
let db: Db;

beforeAll(async () => {
  // A connection string is required at import time; the pool is faked, so the
  // value is never dialled.
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
});

/** Admin + two waiters + one table — the Gaia floor in miniature. */
function seedFloor(): void {
  addEmployee({ id: ADMIN_EMP_ID, username: "gaia_admin", fname: "Gaia", lname: "Admin", roles: { primary: "admin", all: ["admin"] } });
  addEmployee({ id: WAITER1_ID, username: "asha", fname: "Asha", lname: "K", roles: { primary: "waiter", all: ["waiter"] } });
  addEmployee({ id: WAITER2_ID, username: "binu", fname: "Binu", lname: "M", roles: { primary: "waiter", all: ["waiter"] } });
  addTable({ id: TABLE1_ID, table_name: "T1" });
}

beforeEach(() => {
  resetStore();
  seedFloor();
});

// ---------------------------------------------------------------------------
describe("issue 3 — explicit assignments are durable, admins are never defaulted", () => {
  test("REGRESSION: explicit waiter assignment survives the dashboard's occupy + order-linking calls made by the admin session", async () => {
    // 1. Explicit assignment to Asha.
    await db.AssignTableToEmployee(RESTAURANT_SLUG, "T1", "asha");
    expect(assignedEmployeeFor(TABLE1_ID)).toBe(WAITER1_ID);

    // 2. The dashboard's order flow, verbatim: occupy with covers, then occupy
    //    again to link the created order — both as the ADMIN's session.
    await db.OccupyTable(RESTAURANT_SLUG, "T1", 2, null, ADMIN_EMP_ID);
    await db.OccupyTable(RESTAURANT_SLUG, "T1", null, "order-1", ADMIN_EMP_ID);

    // 3. The table still belongs to Asha — pre-fix, both calls rewrote it to the
    //    admin (`do update` on the auto-assign upsert).
    expect(assignedEmployeeFor(TABLE1_ID)).toBe(WAITER1_ID);

    // And the occupy itself still did its actual job.
    const listed = await db.GetTableAssignments(RESTAURANT_SLUG);
    expect(listed).toHaveLength(1);
    expect(listed[0].employee_id).toBe("asha");
  });

  test("occupying a waiterless table as the admin does NOT hand the table to the admin", async () => {
    await db.OccupyTable(RESTAURANT_SLUG, "T1", 2, null, ADMIN_EMP_ID);
    expect(assignments()).toHaveLength(0);
  });

  test("a non-admin employee occupying a vacant table still becomes its waiter", async () => {
    // No attendance rows exist — the degrade rule keeps auto-assign working.
    await db.OccupyTable(RESTAURANT_SLUG, "T1", 2, null, WAITER1_ID);
    expect(assignedEmployeeFor(TABLE1_ID)).toBe(WAITER1_ID);
  });

  test("auto-assign only fills a vacant slot — a second staffer's occupy never steals the table", async () => {
    await db.OccupyTable(RESTAURANT_SLUG, "T1", 2, null, WAITER1_ID);
    await db.OccupyTable(RESTAURANT_SLUG, "T1", null, "order-9", WAITER2_ID);
    expect(assignedEmployeeFor(TABLE1_ID)).toBe(WAITER1_ID);
  });

  test("explicit re-assignment still replaces the previous waiter (a human's choice always wins)", async () => {
    await db.AssignTableToEmployee(RESTAURANT_SLUG, "T1", "asha");
    await db.AssignTableToEmployee(RESTAURANT_SLUG, "T1", "binu");
    expect(assignedEmployeeFor(TABLE1_ID)).toBe(WAITER2_ID);
  });

  test("unassign still clears the table", async () => {
    await db.AssignTableToEmployee(RESTAURANT_SLUG, "T1", "asha");
    expect(await db.UnassignTableEmployee(RESTAURANT_SLUG, "T1")).toBe(true);
    expect(assignments()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("issue 7 — attendance-aware assignability", () => {
  test("DEGRADE RULE: an outlet where nobody has EVER clocked in keeps full assignment ability", async () => {
    // No Attendance rows at all — attendance is simply not used here.
    const roster = await db.GetAssignableEmployees(RESTAURANT_SLUG);
    expect(roster.attendance_in_use).toBe(false);
    expect(roster.employees.map((e) => e.employee_Username).sort()).toEqual(["asha", "binu", "gaia_admin"]);

    // Explicit assignment of a never-clocked-in employee must still work.
    await db.AssignTableToEmployee(RESTAURANT_SLUG, "T1", "binu");
    expect(assignedEmployeeFor(TABLE1_ID)).toBe(WAITER2_ID);
  });

  test("attendance in use: only staff clocked in right now are assignable", async () => {
    addAttendance({ emp_id: WAITER1_ID, status: "pending" }); // open shift; pending approval still counts as present
    const roster = await db.GetAssignableEmployees(RESTAURANT_SLUG);
    expect(roster.attendance_in_use).toBe(true);
    expect(roster.employees.map((e) => e.employee_Username)).toEqual(["asha"]);
  });

  test("explicitly assigning a not-clocked-in employee is refused server-side", async () => {
    addAttendance({ emp_id: WAITER1_ID, status: "approved" });
    await expect(db.AssignTableToEmployee(RESTAURANT_SLUG, "T1", "binu")).rejects.toThrow(/not clocked in/);
    // The clocked-in waiter is still assignable.
    await db.AssignTableToEmployee(RESTAURANT_SLUG, "T1", "asha");
    expect(assignedEmployeeFor(TABLE1_ID)).toBe(WAITER1_ID);
  });

  test("auto-assign never picks a not-clocked-in actor", async () => {
    addAttendance({ emp_id: WAITER1_ID, status: "approved" });
    // Binu is not clocked in: occupying must not make him the waiter.
    await db.OccupyTable(RESTAURANT_SLUG, "T1", 2, null, WAITER2_ID);
    expect(assignments()).toHaveLength(0);
    // Asha (clocked in) occupying does.
    await db.OccupyTable(RESTAURANT_SLUG, "T1", null, null, WAITER1_ID);
    expect(assignedEmployeeFor(TABLE1_ID)).toBe(WAITER1_ID);
  });

  test("a closed shift and a rejected open shift both mean NOT clocked in right now", async () => {
    addAttendance({ emp_id: WAITER1_ID, status: "approved", clock_out: new Date("2026-08-24T23:00:00Z") }); // finished shift
    addAttendance({ emp_id: WAITER2_ID, status: "rejected" }); // open but rejected
    const roster = await db.GetAssignableEmployees(RESTAURANT_SLUG);
    expect(roster.attendance_in_use).toBe(true);
    expect(roster.employees).toHaveLength(0);
    await expect(db.AssignTableToEmployee(RESTAURANT_SLUG, "T1", "asha")).rejects.toThrow(/not clocked in/);
    await db.OccupyTable(RESTAURANT_SLUG, "T1", 2, null, WAITER1_ID);
    expect(assignments()).toHaveLength(0);
  });
});
