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
  endOccupancy,
  resetStore,
  seedAssignment,
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

  // The rule the owner asked for: whoever SEATS the party is its server until
  // someone reassigns the table — an owner working the floor included. An
  // earlier revision refused admins outright and left tables unassigned.
  test("seating a party as the admin DOES credit the admin — whoever seats, serves", async () => {
    await db.OccupyTable(RESTAURANT_SLUG, "T1", 2, null, ADMIN_EMP_ID);
    expect(assignedEmployeeFor(TABLE1_ID)).toBe(ADMIN_EMP_ID);
  });

  // REGRESSION (the shipped bug this whole area exists for). /occupy-table is
  // sent by the order flow around every order save, so an admin saving an order
  // used to silently become the waiter of a table someone else was serving.
  // Only the free -> occupied transition is a seating; a re-occupy is not.
  test("REGRESSION: an admin's order-save occupy of an ALREADY-seated table changes nothing", async () => {
    await db.OccupyTable(RESTAURANT_SLUG, "T1", 2, null, WAITER1_ID);
    await db.OccupyTable(RESTAURANT_SLUG, "T1", null, "order-9", ADMIN_EMP_ID);
    expect(assignedEmployeeFor(TABLE1_ID)).toBe(WAITER1_ID);
  });

  // And with NO waiter on the table either: an order save is not a seating, so
  // it must not hand the table to whoever happened to save the order.
  test("REGRESSION: an order-save occupy of an already-seated, waiterless table assigns nobody", async () => {
    await db.OccupyTable(RESTAURANT_SLUG, "T1", 2, null, WAITER1_ID);
    await db.UnassignTableEmployee(RESTAURANT_SLUG, "T1");
    await db.OccupyTable(RESTAURANT_SLUG, "T1", null, "order-9", ADMIN_EMP_ID);
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

  // WHAT THIS TEST USED TO ASSERT WAS THE BUG. It read
  // `expect(assignments()).toHaveLength(0)` — seating a party while not clocked
  // in credited nobody — and that is exactly what "waiters are not getting
  // auto-assigned" turned out to be in production: an outlet with Attendance
  // rows on file and nobody clocked in at that moment dropped every seating.
  //
  // The clocked-in rule governs candidates the SYSTEM picks. The seater is not
  // picked; they walked the party to the table. The second half of this test is
  // what keeps the original fix ("employees who aren't clocked in should not
  // show up as an option to be assigned or be automatically assigned") intact:
  // Binu is credited for HIS OWN seating and is still absent from the picker and
  // still refused on an explicit write.
  test("the SEATER is credited even when they never clocked in — the act of seating is the proof of presence", async () => {
    addAttendance({ emp_id: WAITER1_ID, status: "approved" });
    // Binu is not clocked in, but he is the one who seated this party.
    const r = await db.OccupyTable(RESTAURANT_SLUG, "T1", 2, null, WAITER2_ID);
    expect(assignedEmployeeFor(TABLE1_ID)).toBe(WAITER2_ID);
    expect(r.assignment?.assigned).toBe(true);
    expect(r.assignment?.reason).toBe("assigned");
    expect(r.assignment?.employee_id).toBe(WAITER2_ID);
    expect(r.assignment?.message).toContain("Binu M");
  });

  test("a not-clocked-in employee who did NOT seat anyone is still out of the picker and still refused on write", async () => {
    addAttendance({ emp_id: WAITER1_ID, status: "approved" });
    const roster = await db.GetAssignableEmployees(RESTAURANT_SLUG);
    expect(roster.attendance_in_use).toBe(true);
    expect(roster.employees.map((e) => e.employee_Username)).toEqual(["asha"]);
    await expect(db.AssignTableToEmployee(RESTAURANT_SLUG, "T1", "binu")).rejects.toThrow(/not clocked in/);
    expect(assignments()).toHaveLength(0);
  });

  test("a clocked-in actor seating a free table DOES become its waiter", async () => {
    addAttendance({ emp_id: WAITER1_ID, status: "approved" });
    // A SEPARATE seating, not a re-occupy of the table above: only the
    // free -> occupied transition is a seating, so the table must start free.
    await db.OccupyTable(RESTAURANT_SLUG, "T1", 2, null, WAITER1_ID);
    expect(assignedEmployeeFor(TABLE1_ID)).toBe(WAITER1_ID);
  });

  test("a closed shift and a rejected open shift both mean NOT clocked in right now", async () => {
    addAttendance({ emp_id: WAITER1_ID, status: "approved", clock_out: new Date("2026-08-24T23:00:00Z") }); // finished shift
    addAttendance({ emp_id: WAITER2_ID, status: "rejected" }); // open but rejected
    const roster = await db.GetAssignableEmployees(RESTAURANT_SLUG);
    expect(roster.attendance_in_use).toBe(true);
    expect(roster.employees).toHaveLength(0);
    await expect(db.AssignTableToEmployee(RESTAURANT_SLUG, "T1", "asha")).rejects.toThrow(/not clocked in/);
    // Nobody is pickable and no explicit assignment is allowed — and seating
    // STILL credits the seater. Asha's shift is closed on paper; she is
    // nonetheless the person who just put this party at T1, and leaving the
    // table waiterless does not make the attendance record any truer.
    await db.OccupyTable(RESTAURANT_SLUG, "T1", 2, null, WAITER1_ID);
    expect(assignedEmployeeFor(TABLE1_ID)).toBe(WAITER1_ID);
  });
});

// ---------------------------------------------------------------------------
// THE SILENCE. Every early return in assignTableById used to be a bare
// `return;` — no log line, no field in the response. An outlet where auto-assign
// fired on every seating and one where it fired on none were indistinguishable
// from outside, which is how this ran for weeks with zero warnings in the logs
// and was finally reported by the owner rather than by the system. Each case now
// has to name itself.
describe("the outcome of a seating is always reported", () => {
  test("assigned: says who, by name", async () => {
    const r = await db.OccupyTable(RESTAURANT_SLUG, "T1", 2, null, WAITER1_ID);
    expect(r.assignment?.reason).toBe("assigned");
    expect(r.assignment?.employee_id).toBe(WAITER1_ID);
    expect(r.assignment?.message).toContain("Asha K");
  });

  test("already_assigned: names the waiter that was KEPT, not just a refusal", async () => {
    await db.AssignTableToEmployee(RESTAURANT_SLUG, "T1", "asha");
    const r = await db.OccupyTable(RESTAURANT_SLUG, "T1", 2, null, WAITER2_ID);
    expect(r.assignment?.assigned).toBe(false);
    expect(r.assignment?.reason).toBe("already_assigned");
    expect(r.assignment?.employee_id).toBe(WAITER1_ID);
    expect(r.assignment?.message).toContain("Asha K");
    // The kept row is the point of `on conflict do nothing` — unchanged.
    expect(assignedEmployeeFor(TABLE1_ID)).toBe(WAITER1_ID);
  });

  test("unknown_employee: a well-formed id that is nobody here is reported, not swallowed", async () => {
    const r = await db.OccupyTable(RESTAURANT_SLUG, "T1", 2, null, "99999999-9999-4999-8999-999999999999");
    expect(r.assignment?.assigned).toBe(false);
    expect(r.assignment?.reason).toBe("unknown_employee");
    expect(assignments()).toHaveLength(0);
  });

  test("no_actor: a guest QR occupy has nobody to credit, and says so", async () => {
    const r = await db.OccupyTable(RESTAURANT_SLUG, "T1", 2, null, null);
    expect(r.assignment?.assigned).toBe(false);
    expect(r.assignment?.reason).toBe("no_actor");
    expect(assignments()).toHaveLength(0);
  });

  test("a re-occupy of an already-seated table reports NOTHING — it was never a seating", async () => {
    await db.OccupyTable(RESTAURANT_SLUG, "T1", 2, null, WAITER1_ID);
    const r = await db.OccupyTable(RESTAURANT_SLUG, "T1", null, "order-9", ADMIN_EMP_ID);
    // null, not a "reason" — the order flow's incidental occupy has no opinion
    // about the waiter and must not look like a failed assignment.
    expect(r.assignment).toBeNull();
    expect(assignedEmployeeFor(TABLE1_ID)).toBe(WAITER1_ID);
  });
});

// ---------------------------------------------------------------------------
// `on conflict do nothing` is right for a deliberate choice and wrong for a
// leftover. Both look identical in the table — one row on a table — so the only
// honest discriminator is WHEN it was written relative to the previous party
// leaving (TableSessions.left_at, stamped by the DB trigger on every release).
describe("a stale assignment cannot outlive its occupancy", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

  test("an assignment left behind by the PREVIOUS occupancy does not survive the next seating", async () => {
    // Binu served the last party at T1...
    seedAssignment(TABLE1_ID, WAITER2_ID, hoursAgo(3));
    // ...and the release path freed the table WITHOUT unassigning him (the bug
    // class: CloseBillByOrder and the reservation un-seat both did exactly this).
    endOccupancy(TABLE1_ID, hoursAgo(1));

    const r = await db.OccupyTable(RESTAURANT_SLUG, "T1", 2, null, WAITER1_ID);

    // The new party's seater owns the table. Without the sweep, `do nothing`
    // would have kept Binu on a table he is not serving — and reported
    // "already_assigned", which is how it stayed invisible.
    expect(assignedEmployeeFor(TABLE1_ID)).toBe(WAITER1_ID);
    expect(r.assignment?.reason).toBe("assigned");
  });

  test("a deliberate pre-assignment made while the table stood FREE does survive", async () => {
    // Last party left an hour ago, table cleared properly.
    endOccupancy(TABLE1_ID, hoursAgo(1));
    // A manager lays out sections for the next service — this is a choice, not a
    // leftover, and it is made AFTER the table went free.
    await db.AssignTableToEmployee(RESTAURANT_SLUG, "T1", "binu");

    const r = await db.OccupyTable(RESTAURANT_SLUG, "T1", 2, null, WAITER1_ID);

    expect(assignedEmployeeFor(TABLE1_ID)).toBe(WAITER2_ID);
    expect(r.assignment?.reason).toBe("already_assigned");
    expect(r.assignment?.employee_name).toBe("Binu M");
  });
});
