-- Migration 055: what a printed bill SAID (client items 1 and 2, app 2.0.2).
--
-- ============================================================================
-- WHAT THE CLIENT ASKED FOR
-- ============================================================================
-- "In the waiter dashboard, if a bill is not settled, the table completely
-- vanishes; bills are settled only at night ... If a bill is printed on a table
-- (not settled), there should still be an option to add more items onto the
-- existing bill."
--
-- A waiter may now add to a printed bill (after confirming it), and the paper
-- in the guest's hand is then short. C3 lets a waiter print a seating's bill
-- ONCE, and the print ledger recorded only THAT a bill was printed, never WHAT
-- it said — so the rule could not tell a pointless second copy (what C3 stops)
-- from the one reprint that has to happen. These four columns are what the
-- paper said; bill_paper_digest.ts argues the design.
--
-- ============================================================================
-- WHAT THIS ADDS — four nullable columns on "PrintJobs"
-- ============================================================================
--   bill_digest       text           sha256 of the paper's money content: the
--                                    merged lines, every rung of the ladder and
--                                    the customer GSTIN (no time, cashier, bill
--                                    number, logo or QR)
--   lines_digest      text           sha256 of the merged lines alone — what the
--                                    floor read compares
--   bill_grand_total  numeric(12,2)  the total the guest was handed
--   table_name        text           the table name the paper printed ("12",
--                                    even after the party moves to 20)
--
-- Written by every bill print (POST /print/bill, /print/bill/claim,
-- /print/bill/split and the service-charge waiver print) as a follow-up UPDATE
-- of the job it just made. Read by the print state (bill_print_state.ts
-- latestBillPaper): a waiter may print again only when the current bill's
-- fingerprint differs from the latest print's, GET /bill-for-table and GET
-- /get-tables carry `paper_stale`, and the settle sheet warns.
--
-- NO DEFAULT AND NO BACKFILL. Every existing row is NULL, and NULL means
-- "nobody recorded what this paper said": a waiter's second print of such a
-- bill stays a senior's, exactly as on 2.0.1 (unknown fails closed). Nothing
-- can be backfilled honestly — the bills those papers were printed from have
-- moved on.
--
-- ============================================================================
-- ORDER OF ROLLOUT
-- ============================================================================
-- The backend ships FIRST and issues these same statements itself — once at
-- boot, outside any transaction, only for a column that is missing, under a
-- 2-second lock timeout (InitPrintJobPaperSchema) — so on a runtime that
-- connects as the table owner (as production does) the columns exist before
-- this file is applied, and this file only records them. A runtime repointed
-- to app_runtime (no DDL) must have this applied first; until then the feature
-- is OFF: nothing is written, nothing is read, and no reader names a column
-- that is not there (the latch in database_supabase.ts asks
-- information_schema first).
--
-- Installed 2.0.0 / 2.0.1 apps are unaffected: the payloads only GAIN fields
-- (`paper_stale`, `printed_as`, `revised`), and the only rule that moves is the
-- waiter's second print — which becomes allowed ONLY when the paper is out of
-- date, a state those apps cannot reach without the 2.0.2 confirm.
--
-- Idempotent: safe to run twice, and safe after the runtime has run it.

-- LOCK TIMEOUT, FIRST — AND EACH ALTER ONLY WHEN ITS COLUMN IS MISSING.
-- ADD COLUMN IF NOT EXISTS takes ACCESS EXCLUSIVE on "PrintJobs" BEFORE it
-- looks, so on its own it locks even when the runtime has already made every
-- column here, which on production it will have (ORDER OF ROLLOUT above) — and
-- "PrintJobs" is written by every kitchen docket, every bill and every ack.
-- While that lock waits, the kitchen queues behind it (a local PG17 run: the
-- file waited out its whole timeout behind a settle-shaped ROW EXCLUSIVE lock,
-- then failed). So each ALTER sits inside the same catalogue guard the runtime
-- uses (ensurePrintJobPaperColumns): with the columns there, this file takes no
-- ACCESS EXCLUSIVE lock at all. Without them, five seconds, then it fails whole
-- and can be re-run off-peak. LOCAL, because scripts/migrate.ts runs each file
-- in its own begin/commit.

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'PrintJobs'
                    AND column_name = 'bill_digest') THEN
    ALTER TABLE "PrintJobs" ADD COLUMN IF NOT EXISTS bill_digest text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'PrintJobs'
                    AND column_name = 'lines_digest') THEN
    ALTER TABLE "PrintJobs" ADD COLUMN IF NOT EXISTS lines_digest text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'PrintJobs'
                    AND column_name = 'bill_grand_total') THEN
    ALTER TABLE "PrintJobs" ADD COLUMN IF NOT EXISTS bill_grand_total numeric(12,2);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'PrintJobs'
                    AND column_name = 'table_name') THEN
    ALTER TABLE "PrintJobs" ADD COLUMN IF NOT EXISTS table_name text;
  END IF;
END $$;

-- The COMMENTs take SHARE UPDATE EXCLUSIVE, which a docket's or a settle's ROW
-- EXCLUSIVE does not conflict with, and the GRANT locks only the catalogue — so
-- re-applying this file during service does not stop the kitchen.

COMMENT ON COLUMN "PrintJobs".bill_digest IS
  'Bill prints only (client items 1-2): sha256 of the paper''s money content (bill_paper_digest.ts). '
  'NULL = not recorded (a print before 055, or a docket).';
COMMENT ON COLUMN "PrintJobs".lines_digest IS
  'Bill prints only: sha256 of the paper''s merged lines, compared by the floor read. NULL = not recorded.';
COMMENT ON COLUMN "PrintJobs".bill_grand_total IS
  'Bill prints only: the grand total on the paper. NULL = not recorded.';
COMMENT ON COLUMN "PrintJobs".table_name IS
  'Bill prints only: the table name the paper printed (kept when the party moves). NULL = not recorded.';

-- RLS on "PrintJobs" is row-level and already covers every column; the runtime
-- role's grants are table-level, so the new columns are covered too. Re-granted
-- here only so a database whose grants were narrowed column-by-column is not
-- left behind (027, 042 and 043 grant the same four).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "PrintJobs" TO app_runtime;
  END IF;
END $$;
