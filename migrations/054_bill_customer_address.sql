-- Migration 054: the guest's address on a bill (client item 7).
--
-- ============================================================================
-- WHAT THE CLIENT ASKED FOR
-- ============================================================================
-- "An option in the tables section to add the ADDRESS of a guest to the bill,
-- like name and GSTIN, especially for corporate parties." A tax invoice to a
-- registered party carries the recipient's name, address and GSTIN (GST Rule
-- 46). Round 2 item 1 (migration 046) put the name and the GSTIN on the bill;
-- this is the third field, edited in the same dialog, on the running table and
-- on a settled bill, and printed in the same slot under "Customer GSTIN:".
--
-- ============================================================================
-- WHY A COLUMN — THE SAME REASON AS 046
-- ============================================================================
-- While a table is running, the address lives inside "Orders".food beside the
-- name and the GSTIN (most running tables have no "Bills" row yet, so the
-- orders are the only place to put it). A settled invoice is the unit a B2B
-- export is made of, and such an export must be able to select the address off
-- the bill row without reconstructing each bill's orders by time window. This
-- column is that record. Readers take it first and fall back to the orders
-- (database_supabase.ts, the migration 054 block beside the 046 one).
--
-- LIKE 046, IT IS SPARSE. Nothing copies the orders' value onto the row when a
-- bill row is created or settled: the column is written by the two edit routes
-- whenever a row exists. Any reader, including a future export, must keep the
-- orders fallback.
--
-- ============================================================================
-- WHY TEXT, NULLABLE, NO DEFAULT, NO CHECK
-- ============================================================================
-- * text, lines joined by LF, at most 5 lines and 250 characters — the rule in
--   customer_address.ts, which refuses anything longer rather than cutting it.
-- * NULL is "no address", which is every bill before this and most after it.
--   An empty string would print a label.
-- * No default: adding a nullable column without one is a catalogue-only
--   change, so the ACCESS EXCLUSIVE lock on "Bills" is held for milliseconds and
--   no row is rewritten.
-- * No CHECK on the limits: customer_address.ts is the single rule and every
--   writer goes through it. A CHECK would be validated against every row under
--   lock and would turn a future rule change into another migration.
--
-- NOT MONEY. No total, report, drawer figure or MIS invariant reads it.
-- PERSONAL DATA: it is never sent to the guest QR bill (guest_bill_view.ts is an
-- allowlist), never printed on a KOT, and not carried by the settled-bill list.
--
-- ============================================================================
-- ORDER OF ROLLOUT
-- ============================================================================
-- The backend ships FIRST and issues this same ALTER itself — once at boot,
-- outside any transaction, only when the column is missing, under a 2-second
-- lock timeout (InitBillCustomerAddressSchema) — so on a runtime that connects
-- as the table owner (as production does) the column already exists by the time
-- this file is applied, and applying it only records it in schema_migrations
-- and sets the comment. A runtime without DDL rights answers an address write
-- with 503 "This server has not finished updating — try again shortly" until
-- this is applied (noticed within a minute, no restart); bills print exactly as
-- before, and name / GSTIN edits keep working.
--
-- Installed 2.0.1 apps and the 2.0.1 dashboard never send the field, which the
-- routes read as "unchanged", so they cannot wipe an address a newer client
-- saved.
--
-- Idempotent: safe to run twice, and safe after the runtime has run it.

-- LOCK TIMEOUT, FIRST — AND THE ALTER ONLY WHEN THE COLUMN IS MISSING.
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS takes ACCESS EXCLUSIVE on "Bills"
-- BEFORE it looks, so on its own it locks even when the runtime has already
-- made the column, which on production it will have (ORDER OF ROLLOUT above).
-- While that lock waits, every reader of "Bills" (every settle, bill read and
-- report) queues behind it: on a local PG17 run, one session holding an
-- ordinary read made a plain count(*) from a third wait 2.7 s behind this file,
-- and the file then failed anyway. So the ALTER sits inside the same
-- catalogue-guarded block the runtime issues (InitBillCustomerAddressSchema):
-- with the column there, this file takes no ACCESS EXCLUSIVE lock at all.
-- Without it, five seconds, then it fails whole and can be re-run off-peak
-- (the 2026-08-24 standstill's shape is one idle-in-transaction session
-- queueing the floor behind a DDL). LOCAL, because scripts/migrate.ts runs each
-- file in its own begin/commit — as 051 does.

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'Bills'
                    AND column_name = 'customer_address') THEN
    ALTER TABLE "Bills" ADD COLUMN IF NOT EXISTS customer_address text;
  END IF;
END $$;

-- The COMMENT takes SHARE UPDATE EXCLUSIVE, which a settle's ROW EXCLUSIVE and a
-- read's ACCESS SHARE do not conflict with, and the GRANT locks only the
-- catalogue — so re-applying this file during service does not stop the floor.

COMMENT ON COLUMN "Bills".customer_address IS
  'The guest''s (corporate party''s) address printed on this bill, lines joined by '
  'LF, at most 5 lines and 250 characters (customer_address.ts). NULL when the bill '
  'carries none. NOT money. Written by POST /bills/customer-name (running table, when '
  'a bill row exists) and POST /bills/:billId/customer-details (settled bill); the '
  'orders'' food.customer_address is the fallback.';

-- RLS on "Bills" is row-level and already covers every column. The runtime role's
-- grants are table-level, so a new column is covered too; re-granted here only so
-- a database whose grants were narrowed column-by-column is not left behind.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "Bills" TO app_runtime;
  END IF;
END $$;
