-- Migration 046: the customer's GSTIN on a bill (round 2, item 1).
--
-- ============================================================================
-- WHAT THE CLIENT ASKED FOR
-- ============================================================================
-- "Enable Customer Name Editing ... This also includes customer GST number for
-- corporate parties." A corporate guest needs their own GSTIN on the invoice to
-- claim the input tax, and they routinely ask for it after the bill has been
-- settled — so it is editable on the running table AND on a past bill from
-- Accounting.
--
-- ============================================================================
-- WHY A COLUMN, WHEN THE NAME HAS NONE
-- ============================================================================
-- The customer NAME lives inside "Orders".food (see SetBillCustomerName), and so
-- does the GSTIN while a table is running: most running tables have no "Bills"
-- row yet, so the orders are the only place to put it. But a settled invoice is
-- the unit a GST (B2B) export is made of, and that export must be able to say
-- `select bill_no, customer_gstin from "Bills"` without reconstructing each
-- bill's orders by time window. This column is that record. Readers take it
-- first and fall back to the orders (database_supabase.ts, the migration 046
-- block beside SetBillCustomerName).
--
-- ============================================================================
-- WHY NULLABLE, WITH NO DEFAULT AND NO CHECK
-- ============================================================================
-- * NULL is "no GSTIN", which is every bill ever raised before this and the
--   overwhelming majority after it. An empty string would print a label.
-- * No default: adding a nullable column without one is a catalogue-only change
--   in PostgreSQL 11+, so the ACCESS EXCLUSIVE lock it takes on the hot "Bills"
--   table is held for milliseconds and no row is rewritten.
-- * No CHECK on the 15-character shape: customer_gstin.ts is the single rule and
--   every writer goes through it. A CHECK here would have to be VALIDATEd against
--   every existing row (a full scan under lock) and would turn a future rule
--   change into a second migration.
--
-- ============================================================================
-- ORDER OF ROLLOUT
-- ============================================================================
-- The backend that reads this ships FIRST and tolerates its absence: reads
-- degrade to the orders' copy, and a GSTIN write answers 503 "This server has not
-- finished updating — try again shortly" rather than half-recording. Name-only
-- edits work either way. The running backend notices this column within a
-- minute of it being added; no restart is needed.
--
-- Idempotent: safe to run twice.

ALTER TABLE "Bills"
  ADD COLUMN IF NOT EXISTS customer_gstin text;

COMMENT ON COLUMN "Bills".customer_gstin IS
  'The customer''s (corporate party''s) GSTIN printed on this bill, normalized to '
  '15 uppercase characters by customer_gstin.ts. NULL when the bill carries none. '
  'NOT money. Written by POST /bills/customer-name (running table, when a bill row '
  'exists) and POST /bills/:billId/customer-details (settled bill).';

-- RLS on "Bills" is row-level and already covers every column. The runtime role's
-- grants are table-level, so a new column is covered too; re-granted here only so
-- a database whose grants were narrowed column-by-column is not left behind.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "Bills" TO app_runtime;
  END IF;
END $$;
