-- Migration 029: per-day Kitchen Order Ticket numbers.
--
-- WHAT THIS ADDS. A KOT printed today must carry a short number the kitchen and
-- the floor can shout across a pass ("where is 26?"), and that number must start
-- again at 1 every morning. Bill numbers ("Outlets".bill_seq, allocated by
-- nextBillNo) are the closest existing thing and they are deliberately NOT that:
-- a GST invoice series is monotonic FOR EVER and must never restart, so it cannot
-- be reused here and its counter column cannot be reset.
--
-- TWO TABLES, NOT ONE, AND THE SPLIT IS THE WHOLE DESIGN
-- -----------------------------------------------------
--   "KotCounters" is ONE ROW PER (tenant, outlet, business day). It is the
--   allocator, and it is also THE LOCK: every allocation for a given outlet-day
--   serialises on that row, which is what makes the sequence gapless under
--   concurrent prints from several tills.
--
--   "KotTickets" is the MEMO — one row per KOT that was actually issued a
--   number, keyed by a caller-supplied ticket_key. It exists so a REPRINT
--   returns the number the kitchen already has on paper instead of burning a
--   new one. Without it, a waiter pressing Print twice would put two different
--   numbers on two identical dockets, which is precisely the confusion the
--   number is meant to remove.
--
-- WHY business_day IS A `date` AND NOT DERIVED FROM created_at
-- -----------------------------------------------------------
-- The rollover has to happen at the RESTAURANT's midnight, not the server's.
-- A Bangalore kitchen closing at 01:30 IST is still working the previous UTC
-- day; a counter keyed on `created_at::date` (which is UTC on this fleet) would
-- roll over at 05:30 in the middle of dinner service. So the day key is computed
-- in the tenant's own zone ("Restaurant".timezone, via dateKeyInZone) and stored
-- as an opaque calendar date. Nothing in this schema re-derives it from a
-- timestamp, deliberately — see the report-bucketing note in migration 021 for
-- the same argument applied to revenue.
--
-- NOT CREATED LAZILY. Migration 026's header records the production outage
-- caused by `create table if not exists` under the least-privilege app_runtime
-- role, which has USAGE but not CREATE on public. Migration 027 restated the
-- rule for "PrintJobs". Same rule here. The application tolerates this table not
-- existing yet (kot_numbers.ts degrades to an unnumbered ticket with a loud log,
-- exactly as print_jobs.ts degrades when 027 is unapplied) so the rollout window
-- prints paper rather than 500s — but the table is created HERE, by a migration.

-- ---------------------------------------------------------------------------
-- The allocator / the lock.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "KotCounters" (
  res_id       uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  -- Per OUTLET, not per tenant. Two branches of one restaurant each run their
  -- own kitchen and their own pass; sharing a counter would interleave their
  -- numbers and make "KOT 26" ambiguous on the only floor that cares.
  outlet_id    uuid NOT NULL REFERENCES "Outlets"(id)    ON UPDATE CASCADE ON DELETE CASCADE,
  -- The restaurant's calendar day, in the restaurant's zone. See header.
  business_day date NOT NULL,
  -- Last number ISSUED. 0 means the day is open but nothing has printed yet, so
  -- the first ticket of the day is 1.
  seq          integer NOT NULL DEFAULT 0 CHECK (seq >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- The PK is the lock target. Allocation does `select … for update` on exactly
  -- this row, so the index that serves it must be the identity itself.
  PRIMARY KEY (res_id, outlet_id, business_day)
);

-- ---------------------------------------------------------------------------
-- The memo — what makes a reprint idempotent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "KotTickets" (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  res_id       uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  outlet_id    uuid NOT NULL REFERENCES "Outlets"(id)    ON UPDATE CASCADE ON DELETE CASCADE,
  business_day date NOT NULL,
  kot_no       integer NOT NULL CHECK (kot_no > 0),
  -- A stable fingerprint of WHAT WAS SENT TO THE KITCHEN — outlet, business day,
  -- table and the normalised item set (name x qty x note). Built by
  -- kot_numbers.ts:kotTicketKey, opaque here on purpose: the database's job is
  -- to guarantee that one key maps to one number for ever, not to know how the
  -- key was derived.
  --
  -- ONE KEY COVERS ALL N STATION DOCKETS OF ONE KOT. buildKotBase64 splits a
  -- ticket into one docket per kitchen station; those dockets are one logical
  -- order and share a number, so the expo can pair "KOT 26 / TANDOOR" with
  -- "KOT 26 / BEVERAGES". The key is therefore computed BEFORE the split, over
  -- the whole item set.
  ticket_key   text NOT NULL,

  -- THE IDEMPOTENCE GUARANTEE, as a constraint rather than as application code.
  -- business_day is already inside ticket_key, so this is naturally day-scoped:
  -- the same table with the same items tomorrow is a different key and gets
  -- tomorrow's number.
  CONSTRAINT kottickets_key_unique UNIQUE (res_id, outlet_id, ticket_key),
  -- No two tickets of one outlet-day may claim the same number. This is belt to
  -- the allocator's braces: if the `for update` serialisation is ever broken by
  -- a refactor, the second writer gets a 23505 instead of two dockets printing
  -- "KOT 26".
  CONSTRAINT kottickets_no_unique  UNIQUE (res_id, outlet_id, business_day, kot_no)
);

-- Serves the reprint lookup (res_id, outlet_id, ticket_key) via
-- kottickets_key_unique, so no extra index is needed for the hot read. This one
-- exists for the cold path: a future retention sweep, and "show me today's
-- kitchen tickets" in reporting. Cheap, and it keeps a purge from seq-scanning a
-- table that grows by one row per KOT for ever.
CREATE INDEX IF NOT EXISTS kottickets_day_idx
  ON "KotTickets" (res_id, business_day);

-- Fail-closed from the moment they exist, in migration 003's exact policy form.
-- 003 applies RLS by a dynamic loop over information_schema.columns (003:30-45),
-- which does not retro-cover tables created later, so this is not redundant.
ALTER TABLE "KotCounters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KotCounters" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "KotCounters";
CREATE POLICY tenant_isolation ON "KotCounters"
  USING      (res_id::text = current_setting('app.res_id', true))
  WITH CHECK (res_id::text = current_setting('app.res_id', true));

ALTER TABLE "KotTickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KotTickets" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "KotTickets";
CREATE POLICY tenant_isolation ON "KotTickets"
  USING      (res_id::text = current_setting('app.res_id', true))
  WITH CHECK (res_id::text = current_setting('app.res_id', true));

-- 002's ALTER DEFAULT PRIVILEGES only covers tables created by the role that set
-- it, so a migration run under a different owner would otherwise leave the
-- runtime unable to touch its own rows. Spelled out, as migrations 024 and 027
-- spell it out. Neither table owns a sequence (uuid default + a plain integer
-- counter), so unlike 027 there is nothing to GRANT USAGE on.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "KotCounters" TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "KotTickets"  TO app_runtime;
  END IF;
END $$;
