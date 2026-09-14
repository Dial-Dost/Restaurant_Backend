-- Migration 048: the round-off a settled bill was rounded to the rupee by.
--
-- ============================================================================
-- WHAT THE CLIENT ASKED FOR
-- ============================================================================
-- "Round off the final amount always in final bill." Their own receipt reads
-- "SGST 2.5% 118.63 / CGST 2.5% 118.63 / Round off -0.26 / Grand Total 4982.00":
-- the guest is asked for whole rupees and the paise are disclosed on a line.
--
-- computeBillCharges (billing_math.ts) now rounds the grand total once, in
-- integer paisa, to the nearest rupee, half up, and returns the adjustment as
-- `round_off`. Every settle path stores the rounded total in "Bills".total_amt
-- exactly as before. This column stores the adjustment beside it.
--
-- ============================================================================
-- WHY A COLUMN AT ALL
-- ============================================================================
-- A settled bill's only stored money facts are total_amt and tax_breakdown.
-- Everything above the total — the food base, the service charge, APC, net
-- sales, GST taxable turnover, the MIS ladder's anchor — is recovered from them
-- by SUBTRACTION (closedBillCharges). A rounded total read back without its
-- round-off pushes the paise into the food base: 4982.00 would read as 4744.74
-- of food against 4745.00 ordered, and past the 0.05 tolerance the bill is
-- flagged "no longer adds up" on web and app. So the adjustment is recorded, and
-- every reader subtracts it first.
--
-- ============================================================================
-- WHY NUMERIC(12,2), NULLABLE, NO DEFAULT, NO BACKFILL
-- ============================================================================
-- * NULL means "settled before rounding existed", and every reader reads it as
--   0 — which is exactly what those bills were. No historical ladder, report or
--   reprint moves by a paisa, so there is nothing to backfill.
-- * No default: adding a nullable column without one is a catalogue-only change
--   in PostgreSQL 11+, so the ACCESS EXCLUSIVE lock on the hot "Bills" table is
--   held for milliseconds and no row is rewritten.
-- * numeric(12,2), not a float: it is money, and it is compared in paisa.
-- * No CHECK on the [-0.49, +0.50] range: billing_math.ts is the single rule, and
--   a CHECK would have to be validated against every row under lock.
--
-- ============================================================================
-- WHO WRITES IT
-- ============================================================================
-- ConfirmBillPaymentByWaiter, SubmitCustomerPayment, ApproveBillPaymentByAdmin
-- and FinalizeOnlinePayment write it with the total. Every path that rewrites
-- total_amt as something other than a charged grand total clears it (release,
-- merge, the open-bill re-syncs, AddBill/ReplaceBill).
--
-- ============================================================================
-- ORDER OF ROLLOUT
-- ============================================================================
-- The backend that reads and writes this ships FIRST. It issues the same
-- statement itself — once at boot, outside any transaction, and lazily through
-- ensureBillRoundOffColumn before any statement that names the column (the idiom
-- 040 documents) — so on a runtime that connects as the table owner the column
-- already exists by the time this runs, and this file only records it in
-- schema_migrations. A runtime repointed to app_runtime (no DDL) must have this
-- applied BEFORE that backend is deployed.
--
-- THE INSTALLED OWNER APP HAS TO MOVE IN THE SAME WINDOW. Up to 1.9.7 the app
-- checks a settled bill's ladder on its own (taxable + service + tax = grand,
-- within 0.05) with no round-off rung, and the rounding backend returns the base
-- with the round-off already taken out. Against it, roughly nine settled bills
-- in ten (every |round off| of 0.05 or more) show 1.9.7's red "does not add up"
-- icon on the Accounting / History detail; its table sheet and waiter strip show
-- a ladder that stops short of the total by the paise; and its bill preview
-- still says "Opted-out" where the paper no longer does. The app build that
-- reads round_off is harmless against the older backend (no round_off, no row),
-- so release it FIRST or with the backend push, then raise APP_MIN_VERSION to it
-- once its downloads answer 200. Otherwise announce the window.
--
-- Idempotent: safe to run twice.

alter table "Bills" add column if not exists round_off numeric(12,2);

COMMENT ON COLUMN "Bills".round_off IS
  'What rounded total_amt to the rupee at settle (grand_total - pre-round total), '
  'in [-0.49, +0.50]. NULL = settled before rounding existed, read as 0. Written '
  'with total_amt by the settle paths; cleared wherever total_amt is rewritten as '
  'a pre-tax running sum. Subtracted before a settled bill''s charges are split.';

-- RLS on "Bills" is row-level and already covers every column. The runtime role's
-- grants are table-level, so a new column is covered too; re-granted here only so
-- a database whose grants were narrowed column-by-column is not left behind.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "Bills" TO app_runtime;
  END IF;
END $$;
