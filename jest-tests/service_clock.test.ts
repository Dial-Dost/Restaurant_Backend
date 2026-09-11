// D2 — THE SERVICE CLOCK: order placed -> bill settled, computed once on the
// server so the owner app and the dashboard render ONE number for one table.
//
// WHY EACH CASE BELOW EXISTS. None of them is arithmetic for its own sake; each
// pins a decision that, got the other way round, produces a wrong figure on a
// live floor:
//
//   * a running clock must keep moving and a settled one must be frozen, or a
//     settled table keeps ageing on the screen forever;
//   * a table's clock starts at the FIRST order, or ordering another round
//     silently resets how long the guests have been sitting there — which is the
//     display D2 exists to replace;
//   * a table with one unsettled order is NOT finished, however many of its
//     other orders are;
//   * a missing timestamp is "no clock", not "zero seconds".

import { describe, test, expect } from "@jest/globals";
import { serviceClock, tableServiceClock } from "../service_clock";

const T = (iso: string): number => Date.parse(iso);
const PLACED = "2026-09-11T12:00:00.000Z";
const NOW = T("2026-09-11T12:41:30.000Z"); // 41m30s after PLACED

describe("one order's service clock", () => {
  test("an open bill keeps running, measured against the SERVER's clock", () => {
    const c = serviceClock({ placed_at: PLACED, settled_at: null }, NOW);
    expect(c.running).toBe(true);
    expect(c.ended_at).toBeNull();
    expect(c.started_at).toBe(PLACED);
    expect(c.elapsed_ms).toBe(41 * 60_000 + 30_000);
    // `as_of` is the instant the figure was measured — a client ticking the
    // display advances from HERE, never from its own idea of the wall clock.
    expect(c.as_of).toBe(new Date(NOW).toISOString());
  });

  test("a settled bill is FROZEN at the settle: `now` moving on does not move it", () => {
    const settled = "2026-09-11T13:00:00.000Z";
    const atSettle = serviceClock({ placed_at: PLACED, settled_at: settled }, T(settled));
    const anHourLater = serviceClock({ placed_at: PLACED, settled_at: settled }, T("2026-09-11T14:00:00.000Z"));
    expect(atSettle.elapsed_ms).toBe(60 * 60_000);
    expect(anHourLater.elapsed_ms).toBe(60 * 60_000);
    expect(anHourLater.running).toBe(false);
    expect(anHourLater.ended_at).toBe(settled);
  });

  test("no placed-at is NO CLOCK, not a zero-second one", () => {
    const c = serviceClock({ placed_at: null, settled_at: null }, NOW);
    expect(c.started_at).toBeNull();
    expect(c.elapsed_ms).toBe(0);
    // The pair a client tests: not running AND no start = "don't draw a timer".
    // A zero that claimed to be running would render "0m" on a two-hour table.
    expect(c.running).toBe(false);
  });

  test("clock skew between the DB and the app server can never print a negative duration", () => {
    // The order row's created_at comes from Postgres, `now` from Node. A second
    // of drift between them is ordinary; "in service for -1s" is not.
    const c = serviceClock({ placed_at: PLACED, settled_at: null }, T(PLACED) - 1_000);
    expect(c.elapsed_ms).toBe(0);
  });

  test("a pg Date, an ISO string and an epoch number are the same instant", () => {
    const asDate = serviceClock({ placed_at: new Date(PLACED) }, NOW);
    const asString = serviceClock({ placed_at: PLACED }, NOW);
    const asNumber = serviceClock({ placed_at: T(PLACED) }, NOW);
    expect(asDate.elapsed_ms).toBe(asString.elapsed_ms);
    expect(asNumber.elapsed_ms).toBe(asString.elapsed_ms);
  });

  test("an unparseable timestamp degrades to no clock rather than to NaN", () => {
    const c = serviceClock({ placed_at: "not a date" }, NOW);
    expect(c.started_at).toBeNull();
    expect(Number.isFinite(c.elapsed_ms)).toBe(true);
  });
});

describe("a table's service clock across several orders (B3: interval orders)", () => {
  test("starts at the FIRST order — a second round does not reset the table", () => {
    const c = tableServiceClock(
      [
        { placed_at: "2026-09-11T12:30:00.000Z" }, // deliberately out of order
        { placed_at: PLACED },
        { placed_at: "2026-09-11T12:15:00.000Z" },
      ],
      NOW,
    );
    expect(c.started_at).toBe(PLACED);
    expect(c.elapsed_ms).toBe(41 * 60_000 + 30_000);
    expect(c.running).toBe(true);
  });

  test("ONE unsettled order keeps the whole table running, however many are settled", () => {
    const c = tableServiceClock(
      [
        { placed_at: PLACED, settled_at: "2026-09-11T12:20:00.000Z" },
        { placed_at: "2026-09-11T12:05:00.000Z", settled_at: "2026-09-11T12:20:00.000Z" },
        { placed_at: "2026-09-11T12:10:00.000Z", settled_at: null }, // still open
      ],
      NOW,
    );
    expect(c.running).toBe(true);
    expect(c.ended_at).toBeNull();
    // A table that has not paid must not report itself as a completed service.
    expect(c.elapsed_ms).toBe(41 * 60_000 + 30_000);
  });

  test("stops at the LAST settlement once every order is settled", () => {
    const last = "2026-09-11T12:50:00.000Z";
    const c = tableServiceClock(
      [
        { placed_at: PLACED, settled_at: "2026-09-11T12:20:00.000Z" },
        { placed_at: "2026-09-11T12:10:00.000Z", settled_at: last },
      ],
      T("2026-09-11T18:00:00.000Z"),
    );
    expect(c.running).toBe(false);
    expect(c.ended_at).toBe(last);
    expect(c.elapsed_ms).toBe(50 * 60_000);
  });

  test("an empty table has no clock", () => {
    const c = tableServiceClock([], NOW);
    expect(c.started_at).toBeNull();
    expect(c.running).toBe(false);
  });

  test("an order with no placed-at is skipped, not counted as the start of time", () => {
    const c = tableServiceClock([{ placed_at: null }, { placed_at: PLACED }], NOW);
    expect(c.started_at).toBe(PLACED);
  });
});
