// Issue: the Customer section's "money spent" never moved for a guest who
// BOOKED a table, sat on it and settled — because bill attribution only walked
// bill -> seating -> first order carrying a cust_id/phone/name, and staff-typed
// dine-in orders carry none of those. Bookings.cust_id (a real FK) was never
// consulted.
//
// bookingIdentForBill is the read-time fallback that consults it. These tests
// pin its contract:
//   * a booking on the same table whose window overlaps the seating claims the
//     bill;
//   * a different table, a non-overlapping window, or a cancelled/no-show
//     booking never does;
//   * two DIFFERENT customers' bookings over one seating -> nobody claims it
//     (the same honesty rule customerIdentityKeys applies to a shared phone);
//   * with no TableSessions row the seating start falls back to 12h before the
//     bill, exactly like the order-identity SQL.
//
// The function is pure, but it lives in database_supabase.ts, which opens a pg
// Pool at import time. Only `pg` is faked; the code under test is the shipped
// code, not a copy of it.

import { describe, test, expect, beforeAll, jest } from "@jest/globals";

jest.mock("pg", () => {
  class FakePool {
    on(): this { return this; }
    query(): Promise<never> {
      return Promise.reject(new Error("booking_bill_attribution: no test here may touch the database"));
    }
    connect(): Promise<never> {
      return Promise.reject(new Error("booking_bill_attribution: pool.connect() is not stubbed"));
    }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

type Db = typeof import("../database_supabase");
let db: Db;

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
});

const T1 = "9c3f8f2e-0000-4000-8000-0000000000t1";
const T2 = "9c3f8f2e-0000-4000-8000-0000000000t2";

/** A 2h booking for customer `cust` on `table` starting at `start`. */
const booking = (
  cust: string,
  table: string,
  start: string,
  { duration = 120, status = "Confirmed" as string | null } = {},
): import("../database_supabase").BookingAttributionRow => ({
  cust_id: cust,
  table_id: table,
  start,
  duration_minutes: duration,
  status,
});

// The tester's exact flow: booked 20:00, seated 19:55, bill raised 21:30.
const SEATED_BILL = {
  table_id: T1,
  seated_at: "2026-08-24T19:55:00.000Z",
  created_at: "2026-08-24T21:30:00.000Z",
};

describe("bookingIdentForBill", () => {
  test("the seating's booking claims the bill — the booked-and-settled guest finally has spend", () => {
    const ident = db.bookingIdentForBill(SEATED_BILL, [booking("cust-a", T1, "2026-08-24T20:00:00.000Z")]);
    expect(ident).toBe("c:cust-a");
  });

  test("a booking on a different table never claims", () => {
    expect(db.bookingIdentForBill(SEATED_BILL, [booking("cust-a", T2, "2026-08-24T20:00:00.000Z")])).toBeNull();
  });

  test("a booking whose window ended before the seating began never claims", () => {
    // 14:00–16:00 booking; seating starts 19:55. Different party entirely.
    expect(db.bookingIdentForBill(SEATED_BILL, [booking("cust-a", T1, "2026-08-24T14:00:00.000Z")])).toBeNull();
  });

  test("tomorrow's booking never claims tonight's bill", () => {
    expect(db.bookingIdentForBill(SEATED_BILL, [booking("cust-a", T1, "2026-08-25T20:00:00.000Z")])).toBeNull();
  });

  test("a late party still claims: the booked window overlaps, containment is not required", () => {
    // Booked 19:00–21:00, seated 19:55, bill 21:30 — overlap [19:55, 21:00].
    const ident = db.bookingIdentForBill(SEATED_BILL, [booking("cust-a", T1, "2026-08-24T19:00:00.000Z")]);
    expect(ident).toBe("c:cust-a");
  });

  test.each([["Cancelled"], ["cancel"], ["No Show"], ["no_show"], ["NoShow"]])(
    "a %s booking sat nobody, so it never claims",
    (status) => {
      expect(
        db.bookingIdentForBill(SEATED_BILL, [booking("cust-a", T1, "2026-08-24T20:00:00.000Z", { status })]),
      ).toBeNull();
    },
  );

  test("Seated and Completed bookings DO claim — those are the ones that settle bills", () => {
    for (const status of ["Seated", "Completed", "Confirmed", "Arrived"]) {
      expect(
        db.bookingIdentForBill(SEATED_BILL, [booking("cust-a", T1, "2026-08-24T20:00:00.000Z", { status })]),
      ).toBe("c:cust-a");
    }
  });

  test("two DIFFERENT customers' bookings over one seating -> nobody claims", () => {
    const ident = db.bookingIdentForBill(SEATED_BILL, [
      booking("cust-a", T1, "2026-08-24T20:00:00.000Z"),
      booking("cust-b", T1, "2026-08-24T20:30:00.000Z"),
    ]);
    expect(ident).toBeNull();
  });

  test("two bookings from the SAME customer are one guest, not an ambiguity", () => {
    const ident = db.bookingIdentForBill(SEATED_BILL, [
      booking("cust-a", T1, "2026-08-24T20:00:00.000Z"),
      booking("cust-a", T1, "2026-08-24T20:30:00.000Z"),
    ]);
    expect(ident).toBe("c:cust-a");
  });

  test("the ambiguity guard ignores non-candidates: a rival booking on another table changes nothing", () => {
    const ident = db.bookingIdentForBill(SEATED_BILL, [
      booking("cust-a", T1, "2026-08-24T20:00:00.000Z"),
      booking("cust-b", T2, "2026-08-24T20:00:00.000Z"),
      booking("cust-c", T1, "2026-08-24T20:15:00.000Z", { status: "Cancelled" }),
    ]);
    expect(ident).toBe("c:cust-a");
  });

  test("no seated_at falls back to a 12h window before the bill, like the order-identity SQL", () => {
    const bill = { table_id: T1, seated_at: null, created_at: "2026-08-24T21:30:00.000Z" };
    // 11h before the bill: inside the fallback window.
    expect(db.bookingIdentForBill(bill, [booking("cust-a", T1, "2026-08-24T10:30:00.000Z")])).toBe("c:cust-a");
    // Ends 09:00, half an hour before the window opens at 09:30: outside it.
    expect(db.bookingIdentForBill(bill, [booking("cust-b", T1, "2026-08-24T07:00:00.000Z")])).toBeNull();
  });

  test("a bill with no table can never be attributed to a booking", () => {
    expect(
      db.bookingIdentForBill(
        { table_id: null, seated_at: null, created_at: "2026-08-24T21:30:00.000Z" },
        [booking("cust-a", T1, "2026-08-24T20:00:00.000Z")],
      ),
    ).toBeNull();
  });

  test("an unparseable slot start is skipped, never treated as a match", () => {
    expect(db.bookingIdentForBill(SEATED_BILL, [booking("cust-a", T1, "not-a-date")])).toBeNull();
  });

  test("a zero/negative duration is read as the 120-minute default, not an instant", () => {
    const ident = db.bookingIdentForBill(SEATED_BILL, [
      booking("cust-a", T1, "2026-08-24T19:00:00.000Z", { duration: 0 }),
    ]);
    // 19:00 + default 120min = 21:00 > 19:55 seating start -> overlap.
    expect(ident).toBe("c:cust-a");
  });
});
