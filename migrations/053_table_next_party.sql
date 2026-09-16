-- Migration 053: the next party at a printed table (client item 6).
--
-- ============================================================================
-- WHAT THE CLIENT ASKED FOR
-- ============================================================================
-- "Table where bill is printed is disappearing from the waiter app. There
-- should be a duplicate table showing same number for order taking for the
-- next round of guests."
--
-- The disappearing is C3 and it stays: once a waiter prints a table's bill, that
-- party leaves the waiter's floor and a manager settles it. What was missing is
-- a table NUMBER for the next guests. At Gaia Global Vegetarian a printed table
-- sat unsettled for a median of 26 minutes (p90 55), and on 2026-09-14 waiters
-- seated the next parties at 12 and 14 on table 15 as a stand-in.
--
-- ============================================================================
-- WHAT THIS ADDS
-- ============================================================================
-- A "next-party" SIBLING is an ordinary, non-virtual "Tables" row, "12 #2",
-- that points at its root:
--
--   parent_table_id  uuid      the root table; NULL on every other row
--   party_seq        smallint  2, 3, ... ; NULL on every other row
--
-- The server creates one when a bill is printed and no seat in the family is
-- free, and soft-deletes it once it is idle again (at most one free seat per
-- family, preferring the root). next_party.ts holds the rules.
--
-- WHY A SECOND ROW: every money path is keyed by table_id — the bill is the sum
-- of the table's still-owing orders, settle closes ALL of them, approval
-- re-prices from all of them, one open bill per table, and covers, seatings,
-- the KOT key and the print ledger all hang off the row. A second party on the
-- same row would be settled with the first party's printed bill. On its own row
-- it cannot be.
--
-- ============================================================================
-- THE CONSTRAINTS
-- ============================================================================
-- * tables_party_shape — the two columns are both NULL (a room table) or both
--   set with party_seq >= 2 (a sibling). Every existing row is NULL/NULL, so
--   the CHECK validates instantly on a table this size (< 200 rows in prod).
-- * tables_parent_fk — (parent_table_id, res_id, outlet_id) references the
--   root's primary key, so a sibling can only ever point at a table of the SAME
--   tenant and outlet. No ON DELETE: a root that ever had a sibling is
--   soft-deleted, never hard-deleted (RemoveTable checks), and a hard delete
--   would be refused rather than orphan the row.
-- * tables_one_live_party — at most one LIVE row per (outlet, root, party).
--   The root row lock in EnsureNextPartyTable already serialises two tills
--   printing the same table; this is the backstop. Retired rows are outside
--   the index, so a retired "12 #2" can sit beside a live one until it is
--   revived instead of a new row being minted.
--
-- ============================================================================
-- ORDER OF ROLLOUT
-- ============================================================================
-- The backend ships FIRST and issues these same statements itself — once at
-- boot, outside any transaction (InitTableNextPartySchema), memoised, and never
-- from inside a settle — so on a runtime that connects as the table owner (as
-- production does) the columns exist before this file is applied, and this
-- file only records them. A runtime repointed to app_runtime (no DDL) must have
-- this applied before the backend is deployed; until then the feature is OFF
-- and every path behaves exactly as it did on 2.0.0: no sibling, no guard, and
-- no reader names a column that is not there (the latch in database_supabase.ts
-- asks information_schema first).
--
-- Installed 2.0.0 apps are safe against it: GET /get-tables only GAINS fields
-- (parent_table, party_no, display_name), so an old app shows "12 #2" as an
-- ordinary table, and the only new refusal is a 423 (code "bill_printed") on
-- an order added to a printed bill by a waiter-only login or a QR guest. Not a
-- 409: a 2.0.0 till's offline queue reads 409 as "retry", and parks any other
-- 4xx at once.
--
-- Idempotent: safe to run twice, and safe after the runtime has run it.

ALTER TABLE "Tables" ADD COLUMN IF NOT EXISTS parent_table_id uuid;
ALTER TABLE "Tables" ADD COLUMN IF NOT EXISTS party_seq smallint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tables_party_shape' AND conrelid = 'public."Tables"'::regclass
  ) THEN
    ALTER TABLE "Tables" ADD CONSTRAINT tables_party_shape
      CHECK ((parent_table_id IS NULL AND party_seq IS NULL) OR (parent_table_id IS NOT NULL AND party_seq >= 2));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tables_parent_fk' AND conrelid = 'public."Tables"'::regclass
  ) THEN
    ALTER TABLE "Tables" ADD CONSTRAINT tables_parent_fk
      FOREIGN KEY (parent_table_id, res_id, outlet_id) REFERENCES "Tables"(id, res_id, outlet_id) ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS tables_one_live_party
  ON "Tables" (outlet_id, parent_table_id, party_seq)
  WHERE parent_table_id IS NOT NULL AND coalesce(is_deleted, false) = false;

COMMENT ON COLUMN "Tables".parent_table_id IS
  'Next-party sibling (client item 6): the root table this row is a second seat for. '
  'NULL on every room table. Never folded into the root on a bill, settle or approval path.';
COMMENT ON COLUMN "Tables".party_seq IS
  'Next-party sibling number (>= 2), shown in the name "<root> #<n>". NULL on every room table.';

-- RLS on "Tables" is row-level and already covers every column; the runtime
-- role's grants are table-level, so the new columns are covered too. Re-granted
-- here only so a database whose grants were narrowed column-by-column is not
-- left behind.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "Tables" TO app_runtime;
  END IF;
END $$;
