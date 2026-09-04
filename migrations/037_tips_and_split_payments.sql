-- Migration 037: TENDERS — one bill, N payments, plus tips.
--
-- WHAT EXISTS TODAY, AND WHY IT IS NOT ENOUGH. A settled bill carries
-- "Bills".payment_method (ONE text column) and, when that column literally says
-- 'split', a free-form "Bills".payment_splits array of {method, amount}. That
-- array is enough to cut the day's takings by mode and no further. It cannot say
-- which card machine the ₹1,200 went through, cannot carry the transaction
-- reference an owner needs to match a settlement file from the acquirer, cannot
-- say who took each part, and has no way at all to record a tip — so a
-- restaurant using this system today cannot answer "how much was tipped, in what
-- form, and who is owed it", which in most Indian restaurants is a payroll
-- question, not a curiosity.
--
-- ============================================================================
-- THIS IS ADDITIVE. payment_method AND payment_splits KEEP WORKING, UNCHANGED
-- ============================================================================
-- Every existing bill on every live tenant has zero rows here, and every reader
-- of payment_method / payment_splits (GetSalesReport, methodTotalsOf,
-- GetReconciliation, GetSettlementSummaryReport, mapClosedBillSummary,
-- allocateSettlement) is left exactly as it is. A single-tender settle still
-- writes payment_method and nothing else, byte for byte as before.
--
-- When tenders ARE recorded, the writer MIRRORS them down into those same two
-- columns in the same transaction — payment_method = the one method for a single
-- tender, 'Split' for several, with payment_splits carrying the parts. The old
-- columns stay the COMPATIBILITY SURFACE and this table becomes the detail
-- behind them; they are written from one source so they cannot disagree. That is
-- the whole migration strategy: nothing has to be rewritten to read the new data,
-- and nothing breaks if a client never writes it.
--
-- ============================================================================
-- THE TENDERS MUST SUM TO THE GRAND TOTAL — EXACTLY
-- ============================================================================
-- A bill that is 1 paisa short is not 1 paisa short. It is a bill the cashier
-- will hunt for at 1am and a variance line on the reconciliation nobody can
-- explain. Three defences, at three different layers, because no single one of
-- them covers every path:
--
--   1. THE DATABASE, at COMMIT. billtenders_sum_guard below is a DEFERRABLE
--      INITIALLY DEFERRED constraint trigger: it lets a multi-row insert pass
--      through every intermediate state and checks the total once, at the end of
--      the transaction, against "Bills".total_amt. DEFERRED is load-bearing — an
--      immediate trigger would reject a legitimate three-way split on its first
--      row. It fires only for bills that are actually SETTLED, because a bill
--      still open with tenders on it is a PARTIAL SETTLEMENT and that is a legal
--      state (see below).
--
--   2. THE SETTLE PATH, in code. The trigger cannot catch the one ordering it
--      cannot see: tenders recorded in one transaction, the bill closed in a
--      LATER one that never touches this table. So the settle path asserts the
--      sum before it stamps closed_at. That is the "in code where you cannot"
--      half, and it is named here so the next person knows the trigger is not
--      the only guard and must not be deleted as redundant.
--
--   3. INTEGER PAISA, in the pure layer. The comparison in TypeScript is done in
--      whole paisa (Math.round(x * 100)), never on floats. A three-way split of
--      an odd amount is the case that proves it: 0.1 + 0.2 !== 0.3 in IEEE-754,
--      and 33.33 + 33.33 + 33.34 summed as doubles is 100.00000000000001. A
--      naive `sum === total` there rejects a correct split; a naive tolerance
--      accepts a wrong one. Postgres `numeric` is exact, so the trigger needs no
--      such care — the drift is a JavaScript problem and it is solved in
--      JavaScript.
--
-- ============================================================================
-- WHAT A PARTIAL SETTLEMENT MEANS. IT IS DEFINED, NOT LEFT OPEN
-- ============================================================================
--   * Tenders may be recorded against an OPEN bill (closed_at IS NULL and
--     admin_approved_at IS NULL). Their sum may be less than the grand total.
--     That is a partial settlement: the guest has paid some of it. The trigger
--     stays quiet, and the outstanding balance is grand_total - Σ(live tenders).
--   * A bill may NOT be settled while that sum is anything other than the grand
--     total. Defence 2 refuses it, and defence 1 catches any path that gets past
--     it in the same transaction.
--   * Over-tendering is REFUSED, never recorded. Change handed back in cash is
--     not a negative tender and modelling it as one would make Σ(tenders) stop
--     meaning "money that entered the till". The tender is the amount APPLIED TO
--     THE BILL; whatever note the guest handed over is not a fact this system has.
--   * A VOIDED tender (wrong amount, wrong card, keyed twice) is superseded, not
--     deleted, and drops out of every sum via `voided_at IS NULL`. This is what
--     stops the double-count the brief calls out: a re-keyed card payment leaves
--     two rows and one live amount.
--
-- ============================================================================
-- TIPS ARE NOT PART OF THE BILL TOTAL
-- ============================================================================
-- `amount` is the portion of the BILL this tender settles. `tip_amount` rides on
-- the same tender and is EXCLUDED from the sum invariant, because a tip is money
-- the guest adds ON TOP of the grand total: folding it into `amount` would make
-- every tipped bill fail the reconciliation, and adding it to the ladder would
-- book a gratuity as restaurant revenue it may not legally be.
--
-- `tip_mode` is recorded separately from `method` on purpose: a card bill is
-- routinely tipped in cash, and which side of the drawer the tip landed on is
-- exactly what the person distributing it needs to know.
--
-- `tip_credited_to` is either a named employee or the word `pool`. Both are real
-- answers and a restaurant runs one or the other; a NULL would mean "nobody has
-- decided yet", which is a third, worse state to have to report on.
--
-- No FK to "Bills" (composite PK, and a CASCADE would take settlement history
-- with the bill). 034's header argues it; unchanged here. res_id / outlet_id are
-- real FKs and RLS binds every read.
--
-- text + CHECK, not an enum (024). NOT CREATED LAZILY (026/027/029/033).

CREATE TABLE IF NOT EXISTS "BillTenders" (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  res_id        uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  outlet_id     uuid NOT NULL REFERENCES "Outlets"(id)    ON UPDATE CASCADE ON DELETE CASCADE,

  bill_id       uuid NOT NULL,
  table_id      uuid,
  -- Position in the sequence of tenders on this bill, 1-based. Not cosmetic: it
  -- is what lets the printed bill list "Cash 500 / Card 755.55" in the order the
  -- cashier took them, and it is the natural unique slot that stops a retried
  -- write from appending a second copy of the same tender.
  seq           smallint NOT NULL CHECK (seq >= 1),

  -- The tender mode. Free text bounded by the application's PaymentMethod set
  -- rather than a CHECK list, deliberately: the existing payment_method column
  -- is free text too, tenants add aggregator modes (Dineout, Zomato, District)
  -- without a migration, and a CHECK here that fell behind that column would
  -- reject a mode the rest of the system happily accepts.
  method        text NOT NULL CHECK (btrim(method) <> ''),
  -- The portion of the BILL this tender settles. Strictly positive — a zero
  -- tender is a row with no meaning, and a negative one is a refund, which has
  -- its own columns on "Bills" and must not be smuggled in here.
  amount        numeric NOT NULL CHECK (amount > 0),
  -- The acquirer/PSP reference: the last four of the card, the UPI RRN, the
  -- Razorpay payment id. This is the field that makes a settlement file
  -- reconcilable against this system at all.
  txn_ref       text,

  settled_at    timestamptz NOT NULL DEFAULT now(),
  settled_by_employee_id uuid,
  settled_by_username    text NOT NULL CHECK (btrim(settled_by_username) <> ''),

  -- THE TIP. On top of `amount`; see the header.
  tip_amount    numeric NOT NULL DEFAULT 0 CHECK (tip_amount >= 0),
  tip_mode      text CHECK (tip_mode IS NULL OR tip_mode IN ('cash','card','upi','wallet','other')),
  -- Either a named employee, or the pool. `tip_credited_to_username` carries the
  -- literal 'pool' in the pooled case so a report never has to join to find out
  -- that there is nobody to join to.
  tip_credited_to_employee_id uuid,
  tip_credited_to_username    text,

  -- A tip that exists must say where it went and how it arrived. Without this a
  -- tip is recordable as an orphan amount, which is a payroll dispute waiting to
  -- happen.
  CONSTRAINT billtenders_tip_attributed CHECK (
    tip_amount = 0
    OR (tip_mode IS NOT NULL AND tip_credited_to_username IS NOT NULL AND btrim(tip_credited_to_username) <> '')
  ),

  -- SUPERSESSION, not deletion. See the header.
  voided_at          timestamptz,
  voided_by_username text,
  void_reason        text,
  CONSTRAINT billtenders_void_complete
    CHECK ((voided_at IS NULL) = (voided_by_username IS NULL))
);

-- The slot. A retried "record tender 2" writes the same seq and conflicts rather
-- than appending a duplicate that would break the sum invariant.
CREATE UNIQUE INDEX IF NOT EXISTS billtenders_slot_uidx
  ON "BillTenders" (res_id, bill_id, seq);

-- The hot read, and the trigger's own read: the LIVE tenders of one bill.
CREATE INDEX IF NOT EXISTS billtenders_live_bill_idx
  ON "BillTenders" (res_id, bill_id)
  WHERE voided_at IS NULL;

-- The tip report's read, and the settlement-by-mode cut over a window.
CREATE INDEX IF NOT EXISTS billtenders_window_idx
  ON "BillTenders" (res_id, outlet_id, settled_at DESC);

-- ---------------------------------------------------------------------------
-- DEFENCE 1: the sum invariant, at COMMIT.
--
-- Deliberately NOT security definer. It runs with the caller's privileges, so
-- the "Bills" lookup is bound by the same RLS policy every other read is: this
-- trigger can never be a way to learn another tenant's bill total.
--
-- WHEN IT STAYS SILENT, and why each case is right rather than a hole:
--   * no live tenders  -> nothing to check. Voiding the last tender of a bill is
--                         a legitimate correction (re-key the whole payment).
--   * bill not visible -> the tenant GUC is unset, which means the INSERT that
--                         reached this trigger already had to satisfy
--                         "BillTenders"'s own WITH CHECK against that same GUC.
--                         A row cannot get here with a res_id the caller cannot
--                         see, so this branch is unreachable in the application
--                         and exists only so a migration/repair session cannot
--                         wedge itself.
--   * bill not settled -> a partial settlement. Legal, and defined in the header.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION billtenders_sum_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_res     uuid;
  v_bill    uuid;
  v_count   integer;
  v_sum     numeric;
  v_total   numeric;
  v_settled boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_res  := OLD.res_id;
    v_bill := OLD.bill_id;
  ELSE
    v_res  := NEW.res_id;
    v_bill := NEW.bill_id;
  END IF;

  SELECT count(*), coalesce(sum(amount), 0)
    INTO v_count, v_sum
    FROM "BillTenders"
   WHERE res_id = v_res AND bill_id = v_bill AND voided_at IS NULL;

  IF v_count = 0 THEN
    RETURN NULL;
  END IF;

  SELECT round(total_amt, 2),
         (closed_at IS NOT NULL OR admin_approved_at IS NOT NULL)
    INTO v_total, v_settled
    FROM "Bills"
   WHERE id = v_bill AND res_id = v_res
   LIMIT 1;

  IF NOT FOUND OR NOT v_settled THEN
    RETURN NULL;
  END IF;

  -- numeric, so this is exact arithmetic and needs no tolerance. The paisa-level
  -- care belongs on the JavaScript side, where the values are doubles.
  IF round(v_sum, 2) <> v_total THEN
    RAISE EXCEPTION
      'Tenders on bill % add up to % but the settled bill total is %',
      v_bill, round(v_sum, 2), v_total
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS billtenders_sum_guard_trg ON "BillTenders";
CREATE CONSTRAINT TRIGGER billtenders_sum_guard_trg
  AFTER INSERT OR UPDATE OR DELETE ON "BillTenders"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION billtenders_sum_guard();

ALTER TABLE "BillTenders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillTenders" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "BillTenders";
CREATE POLICY tenant_isolation ON "BillTenders"
  USING      (res_id::text = current_setting('app.res_id', true))
  WITH CHECK (res_id::text = current_setting('app.res_id', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "BillTenders" TO app_runtime;
    -- Spelled out for the same reason the table grants are: 002's ALTER DEFAULT
    -- PRIVILEGES only covers objects created by the role that set it, and a
    -- trigger the runtime cannot execute is a trigger that turns every tender
    -- write into a permission error.
    GRANT EXECUTE ON FUNCTION billtenders_sum_guard() TO app_runtime;
  END IF;
END $$;
