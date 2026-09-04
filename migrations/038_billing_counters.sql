-- Migration 038: BILLING COUNTERS — the till a sale was rung on.
--
-- WHY. A food-court stall, a multi-till QSR and a hotel with a coffee shop and a
-- bar all share one thing: several places that take money inside ONE outlet.
-- Today every bill in an outlet is indistinguishable from every other, so
-- "counter 2 is 4,000 short" is a sentence this system cannot express, let alone
-- investigate. Every bill carries a bill number, a table and an employee; none
-- of those is the till. The employee is the closest thing and it is the wrong
-- thing — staff rotate across tills through a shift, which is exactly the
-- circumstance in which you need to ask about the till and not the person.
--
-- ============================================================================
-- HOW THIS RELATES TO "CashSessions", WHICH ALREADY EXISTS. READ THIS FIRST.
-- ============================================================================
-- "CashSessions" (base schema:96) is a CASH-UP: opening float, cash sales, cash
-- refunds, cash payouts, expected vs counted, variance, opened_by / closed_by.
-- One row per shift, currently one open row per outlet (OpenCashSession's guard
-- is `where res_id = $1 and outlet_id = $2 and status = 'open'`).
--
-- These are two different nouns and neither can do the other's job:
--
--   "BillingCounters" is an IDENTITY. It is durable, it is configured once, and
--   it exists whether or not anybody is trading. "Counter 2", "Bar till",
--   "Terminal at the pass".
--
--   "CashSessions" is an EVENT. It is one drawer counted once, at the end of one
--   shift, and there are many of them per counter over time.
--
-- So the relationship is one-to-many, counter -> sessions, and this migration
-- adds counter_id to BOTH sides:
--   "Bills".counter_id        which till RANG the sale.
--   "CashSessions".counter_id which till was COUNTED.
-- Only with both can a cash-up be reconciled against the sales it is supposed to
-- explain, which is the entire point of cashing up per till.
--
-- Duplicating CashSessions with a per-counter clone was the alternative and it
-- is worse in the obvious way: two tables that both mean "cash was counted",
-- diverging the first time someone adds a column to one of them.
--
-- ============================================================================
-- NULL counter_id MEANS "THE OUTLET'S SINGLE TILL", AND EVERY EXISTING ROW IS NULL
-- ============================================================================
-- The overwhelming majority of tenants have one till per outlet and must never
-- be asked to configure a counter to keep working. So:
--   * both columns are NULLABLE with no default and no backfill;
--   * every existing bill and every existing cash session stays NULL, and reads
--     as "this outlet's till" in every report;
--   * OpenCashSession's one-open-session guard becomes per (outlet, counter)
--     ONLY when a counter is supplied, and stays per-outlet when it is not — so
--     a tenant that never touches counters sees byte-identical behaviour, and a
--     food court can run four open drawers at once.
-- A NOT NULL column with a synthetic "Default" counter row per outlet was the
-- alternative. It would have required a data migration across every tenant's
-- entire "Bills" history to satisfy the constraint, on a live table, to express
-- something the NULL already says.
--
-- ============================================================================
-- WHY code AND name ARE BOTH HERE
-- ============================================================================
-- `code` is what a human types and what appears on a printed bill footer — short,
-- stable, unique within the outlet, and case-insensitively unique so "C1" and
-- "c1" cannot both exist and be confused on a cash-up sheet at 1am. `name` is
-- what the configuration screen shows. Collapsing them would force either an
-- unreadable code onto the bill or a long name into every report column.
--
-- DEACTIVATION, NOT DELETION. A counter that stops being used is set inactive.
-- Deleting it would orphan the counter_id on every bill it ever rang, which is
-- precisely the history the column was added to preserve.
--
-- No FK from "Bills".counter_id / "CashSessions".counter_id to this table: both
-- are historical attributions that must survive a counter being removed from a
-- tenant's configuration, and "Bills" is the highest-traffic table in the schema
-- — a referential check on every insert buys nothing that the application's own
-- resolution (which only ever writes an id it just read) does not already
-- guarantee. Tenant integrity is RLS's job, as everywhere else.
--
-- text + CHECK, not an enum (024). NOT CREATED LAZILY (026/027/029/033).

CREATE TABLE IF NOT EXISTS "BillingCounters" (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  res_id      uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  -- Per OUTLET, not per tenant — a counter is a physical place. Same reasoning
  -- migration 029 gives for scoping KOT counters to the outlet.
  outlet_id   uuid NOT NULL REFERENCES "Outlets"(id)    ON UPDATE CASCADE ON DELETE CASCADE,

  code        text NOT NULL CHECK (btrim(code) <> '' AND length(code) <= 16),
  name        text NOT NULL CHECK (btrim(name) <> ''),
  -- counter  : a billing point a guest walks up to (a food-court stall).
  -- terminal : a POS device that rings sales for a shared billing point.
  -- The distinction exists because a QSR reconciles per DEVICE while a food
  -- court reconciles per STALL, and a report that cannot tell them apart cannot
  -- serve either.
  kind        text NOT NULL DEFAULT 'counter' CHECK (kind IN ('counter','terminal')),
  -- Free-form operator hint — a device serial, an IP, "the one by the door".
  -- Never matched on, never trusted; purely so a human can find the machine.
  device_hint text,
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0
);

-- Case-insensitive, per outlet. See the header: two counters whose codes differ
-- only by case are two counters nobody can tell apart on paper.
CREATE UNIQUE INDEX IF NOT EXISTS billingcounters_code_uidx
  ON "BillingCounters" (res_id, outlet_id, lower(code));

-- The configuration list, and the resolution read on every settle.
CREATE INDEX IF NOT EXISTS billingcounters_outlet_idx
  ON "BillingCounters" (res_id, outlet_id, active, sort_order);

-- ---------------------------------------------------------------------------
-- The two attributions. Both nullable, both unbackfilled — see the header.
-- ---------------------------------------------------------------------------
ALTER TABLE "Bills"        ADD COLUMN IF NOT EXISTS counter_id uuid;
ALTER TABLE "CashSessions" ADD COLUMN IF NOT EXISTS counter_id uuid;

-- "settlements by counter over a window" — the report this migration exists for.
-- Partial, because the whole point is that most rows are NULL and a full index
-- over them would be almost entirely dead weight on the busiest table here.
CREATE INDEX IF NOT EXISTS bills_counter_settled_idx
  ON "Bills" (res_id, outlet_id, counter_id, (coalesce(closed_at, admin_approved_at)) DESC)
  WHERE counter_id IS NOT NULL;

-- Mirrors cash_sessions_lookup_idx (base schema:485) with the counter folded in,
-- so the per-counter open-session guard resolves on an index instead of
-- filtering the outlet's whole session history.
CREATE INDEX IF NOT EXISTS cash_sessions_counter_idx
  ON "CashSessions" (res_id, outlet_id, counter_id, status, opened_at DESC)
  WHERE counter_id IS NOT NULL;

ALTER TABLE "BillingCounters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingCounters" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "BillingCounters";
CREATE POLICY tenant_isolation ON "BillingCounters"
  USING      (res_id::text = current_setting('app.res_id', true))
  WITH CHECK (res_id::text = current_setting('app.res_id', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "BillingCounters" TO app_runtime;
  END IF;
END $$;
