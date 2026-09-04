-- Migration 036: SERVICE CHARGE WAIVERS — the record of a service charge that
-- applied and was then taken off.
--
-- WHY THIS IS ITS OWN CONTROL AND NOT JUST A DISCOUNT. In India the service
-- charge is the one line on a bill a guest is entitled to refuse, and the
-- restaurant is expected to remove it on request. That makes waiving it a
-- ROUTINE, HIGH-FREQUENCY act performed by the most junior person on the floor —
-- which is exactly what makes it worth counting. A tenant charging 10% whose
-- waiver rate is 40% is not running the policy it thinks it is running, and
-- today nothing anywhere records that a single one of them happened: the bill is
-- simply recomputed without the charge and settles for less, indistinguishable
-- from a table that never attracted one.
--
-- Recording it as a discount would be wrong in two directions at once. It would
-- inflate the Discount report (which is a document about money given off FOOD,
-- and drives a completely different conversation) and it would leave the Service
-- Charge rung of the money ladder reading zero with no explanation, so the
-- ladder's own totals would stop being able to answer "how much service charge
-- did we bill, and how much did we keep".
--
-- ============================================================================
-- IT MUST WORK IN BOTH TAX SHAPES, AND THEY BEHAVE DIFFERENTLY
-- ============================================================================
-- The header of closedBillCharges (database_supabase.ts) documents the two ways
-- a live tenant carries a service charge. Both exist in production:
--
--   (a) "Restaurant".service_charge — a percentage applied to the discounted
--       subtotal BEFORE tax, so GST is charged ON TOP of the service charge.
--       computeBillCharges already takes an `includeServiceCharge` flag, so
--       waiving it removes the charge AND the tax that sat on it.
--
--   (b) A "Service Charge" entry inside "Outlets".default_tax — the charge is
--       modelled as one more tax line, computed on the discounted subtotal
--       alongside GST. (This is what the shipped seed does, and those tenants
--       have "Restaurant".service_charge = 0.) `includeServiceCharge` does
--       nothing here; waiving means dropping that named entry from the tax
--       config, and nothing else falls away with it because in this shape
--       nothing is charged on top of it.
--
-- So the guest's saving is NOT the same number as the service charge in shape
-- (a), and IS in shape (b). Storing one figure and calling it "the waiver" would
-- be right for half the fleet. Three columns instead:
--
--   amount_waived         the service charge itself, pre-tax. This is the figure
--                         that belongs on the Service Charge rung of the ladder.
--   tax_on_waived         the tax that fell away with it. Non-zero only in shape
--                         (a); structurally zero in shape (b).
--   grand_total_reduction amount_waived + tax_on_waived — what the guest
--                         actually stopped owing. GENERATED, so the three can
--                         never disagree.
--
-- All three are computed by running the EXISTING computeBillCharges twice, with
-- and without the charge, and taking the difference. Not by a parallel formula:
-- a second implementation of the charge arithmetic is a second thing that can be
-- wrong, and the two would drift the first time either tax shape changed.
-- `basis` records which shape produced the number, so a report never has to
-- guess why tax_on_waived is zero.
--
-- ============================================================================
-- ONE LIVE WAIVER PER BILL; UN-WAIVING IS A REVERSAL
-- ============================================================================
-- The charge is either on the bill or off it, so a second live waiver row is
-- meaningless and doubles the reported saving. The partial unique index makes
-- that a constraint. Putting the charge back (guest changed their mind, manager
-- overruled) stamps `reversed_at` on the existing row rather than deleting it —
-- 034's argument, unchanged: the deletion of a control record is itself the
-- thing a control record exists to prevent.
--
-- No FK to "Bills": its PK is composite (id, res_id, outlet_id) and a CASCADE
-- would take the waiver with the bill. res_id/outlet_id remain real FKs and RLS
-- binds every read; see 034's header.
--
-- text + CHECK, not an enum (024). NOT CREATED LAZILY (026/027/029/033).

CREATE TABLE IF NOT EXISTS "ServiceChargeWaivers" (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  res_id        uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  outlet_id     uuid NOT NULL REFERENCES "Outlets"(id)    ON UPDATE CASCADE ON DELETE CASCADE,

  -- The bill the charge came off. NOT NULL: a waiver with no bill is not a
  -- waiver, it is a note.
  bill_id       uuid NOT NULL,
  table_id      uuid,
  waived_at     timestamptz NOT NULL DEFAULT now(),

  -- WHICH SHAPE produced the numbers below. See the header.
  --   restaurant_percent : "Restaurant".service_charge  (shape a)
  --   tax_line           : a "Service Charge" entry in Outlets.default_tax (b)
  basis         text NOT NULL CHECK (basis IN ('restaurant_percent','tax_line')),
  -- The percentage that WOULD have applied, and the base it would have applied
  -- to (the discounted, pre-service-charge subtotal). Kept so a report can show
  -- "10% of 2,400" rather than a bare number an owner has to take on trust.
  basis_percent numeric NOT NULL DEFAULT 0 CHECK (basis_percent >= 0),
  basis_amount  numeric NOT NULL DEFAULT 0 CHECK (basis_amount  >= 0),

  amount_waived         numeric NOT NULL CHECK (amount_waived  >= 0),
  tax_on_waived         numeric NOT NULL DEFAULT 0 CHECK (tax_on_waived >= 0),
  grand_total_reduction numeric GENERATED ALWAYS AS (round(amount_waived + tax_on_waived, 2)) STORED,

  waiver_kind   text NOT NULL
                CHECK (waiver_kind IN ('guest_request','guest_complaint','goodwill','staff_meal','policy','other')),
  reason        text NOT NULL CHECK (btrim(reason) <> ''),

  -- Same two-name rule as 034/035. A junior waiving on request is legitimate;
  -- the row still has to say who backed it.
  waived_by_employee_id     uuid,
  waived_by_username        text NOT NULL CHECK (btrim(waived_by_username) <> ''),
  authorised_by_employee_id uuid,
  authorised_by_username    text NOT NULL CHECK (btrim(authorised_by_username) <> ''),

  reversed_at          timestamptz,
  reversed_by_username text,
  reversal_reason      text,
  CONSTRAINT scwaivers_reversal_complete
    CHECK ((reversed_at IS NULL) = (reversed_by_username IS NULL))
);

-- The charge is on or off. One live waiver per bill, enforced rather than
-- assumed — two would double the reported saving on a control document.
CREATE UNIQUE INDEX IF NOT EXISTS scwaivers_live_bill_uidx
  ON "ServiceChargeWaivers" (res_id, bill_id)
  WHERE reversed_at IS NULL;

-- The report's read: a window, per tenant/outlet, newest first.
CREATE INDEX IF NOT EXISTS scwaivers_window_idx
  ON "ServiceChargeWaivers" (res_id, outlet_id, waived_at DESC);

ALTER TABLE "ServiceChargeWaivers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceChargeWaivers" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ServiceChargeWaivers";
CREATE POLICY tenant_isolation ON "ServiceChargeWaivers"
  USING      (res_id::text = current_setting('app.res_id', true))
  WITH CHECK (res_id::text = current_setting('app.res_id', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ServiceChargeWaivers" TO app_runtime;
  END IF;
END $$;
