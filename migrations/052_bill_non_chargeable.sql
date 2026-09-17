-- 052: SETTLE AS NC — a whole bill closed as non-chargeable.
--
-- WHAT THE CLIENT ASKED FOR
-- -------------------------
-- "NC has to come up as an option for payment mode when settling a bill, this
-- has to be coded in as analytics for NC is required."
--
-- NC is a way to CLOSE a bill, not a way to PAY one: payment_methods.ts refuses
-- "NC" as a mode, because settling with a mode books the grand total as sales,
-- tax and takings. So POST /bills/order/:orderId/settle-nc comps every remaining
-- chargeable line of the table into this ledger (migration 034) — one row per
-- line, with the kind, the reason and both names, exactly as an item comp — and
-- closes the bill at 0.00 with "Bills".payment_method = 'NC'. The rules are in
-- nc_settle.ts; the transaction is SettleBillAsNonChargeable.
--
-- WHAT THIS ADDS: three columns that say a row was written BY such a settle.
--
--   scope         'item' — one dish comped (every row that exists today, and the
--                 default, so migration 034's writer is untouched) — or 'bill'.
--   bill_id       the bill the settle closed. The NC Summary shows that bill
--                 directly instead of resolving one, and re-opening the bill
--                 finds exactly the rows to reverse.
--   settle_group  one id per settle, shared by all of its rows, so "this table
--                 was given away" is one act on every report and in the audit.
--
-- A bill-scope row must say which bill and which settle — the CHECK below. An
-- item row may carry neither; nothing else is constrained.
--
-- NO FOREIGN KEY on bill_id, for 034's reason: bills and orders are hard-deleted
-- by paths that must not erase the record of what was given away. RLS and the
-- res_id FK already bind every row to its tenant.
--
-- The value of a bill-scope row is 034's GENERATED value — the pre-tax line
-- value, the same basis as an item comp. What the guest would have paid with
-- service charge and tax is kept in the settle's audit line and on the paper,
-- and in no column: that money never existed.
--
-- ORDER OF ROLLOUT
-- ----------------
-- IDEMPOTENT, and mirrored statement for statement by ensureBillNcColumns() in
-- database_supabase.ts, which the backend runs once at boot and before each NC
-- settle (never inside one). Production connects as the table owner, so the
-- columns will usually exist before this file is applied by hand, and applying
-- it then only records it in schema_migrations. A runtime without DDL rights
-- answers the settle route with a 503 until this is applied; every reader
-- (the NC Summary, the closed bill, a re-open) checks the catalogue and reads
-- without the columns meanwhile.
--
-- Additive only. Existing rows become scope 'item' through the column default,
-- which is a metadata-only change on Postgres 11+ (no table rewrite).

-- LOCK TIMEOUT, FIRST. An ALTER TABLE that adds a column "if not exists"
-- takes ACCESS EXCLUSIVE on "OrderItemNonChargeable" BEFORE it looks, so it
-- locks even when the runtime has already made every column here (and CREATE
-- INDEX IF NOT EXISTS below takes SHARE before it looks, too). This file is
-- applied by hand, possibly during service, and every open bill, comp and NC
-- report reads that table;
-- one idle-in-transaction session would otherwise queue every one of those
-- reads behind this ALTER (the 2026-08-24 standstill's shape). Five seconds,
-- then it fails whole and can be re-run off-peak. LOCAL, because
-- scripts/migrate.ts runs each file in its own begin/commit — as 051 does.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "OrderItemNonChargeable"
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'item',
  ADD COLUMN IF NOT EXISTS bill_id uuid,
  ADD COLUMN IF NOT EXISTS settle_group uuid;

-- Named, and added only when absent, so a runtime that got here first (with the
-- same names) and a re-run of this file are both no-ops.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orderitemnc_scope_check') THEN
    ALTER TABLE "OrderItemNonChargeable"
      ADD CONSTRAINT orderitemnc_scope_check CHECK (scope IN ('item', 'bill'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orderitemnc_bill_scope_linked') THEN
    ALTER TABLE "OrderItemNonChargeable"
      ADD CONSTRAINT orderitemnc_bill_scope_linked
      CHECK (scope = 'item' OR (bill_id IS NOT NULL AND settle_group IS NOT NULL));
  END IF;
END $$;

-- The two reads keyed on the bill: a re-open's reversal and the closed bill's
-- settlement block. Partial — item comps, the overwhelming majority, carry none.
CREATE INDEX IF NOT EXISTS orderitemnc_bill_idx
  ON "OrderItemNonChargeable" (res_id, bill_id)
  WHERE bill_id IS NOT NULL;

COMMENT ON COLUMN "OrderItemNonChargeable".scope IS
  'item = one dish comped; bill = one line of a bill settled as non-chargeable (POST /bills/order/:orderId/settle-nc, payment_method NC).';
COMMENT ON COLUMN "OrderItemNonChargeable".bill_id IS
  'The bill a bill-scope comp closed. NULL on item comps. No FK, as for order_id (migration 034).';
COMMENT ON COLUMN "OrderItemNonChargeable".settle_group IS
  'One id per NC settle, shared by all of its rows.';

-- RLS, FORCE and the tenant policy from 034 cover the new columns, and grants
-- are table-level, so nothing further is needed. Stated so the omission reads
-- as intentional.
