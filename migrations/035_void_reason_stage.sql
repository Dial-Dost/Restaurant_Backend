-- Migration 035: WHY an order (or one line of it) was voided, and — the part
-- that actually matters — AT WHICH STAGE.
--
-- WHAT A VOID IS TODAY. `"Orders".status = 5`. That is the whole record. Nothing
-- says why, nothing says who, nothing says when beyond the row's last write, and
-- nothing says whether the food had already been cooked or the bill had already
-- been shown to the guest. GetVoidKotReport can therefore only report that a
-- ticket vanished, which is the least interesting fact about it.
--
-- ============================================================================
-- THE STAGE IS THE FRAUD SIGNAL, WHICH IS WHY THE SERVER DERIVES IT
-- ============================================================================
-- The three stages are not equally interesting and an auditor reads them in
-- ascending order of suspicion:
--
--   before_print  Rung up, not yet sent to the kitchen. Almost always an honest
--                 correction — wrong table, wrong dish, guest changed their mind
--                 before anything happened. Costs nothing.
--   after_print   The kitchen already has it. Real food was (or is being)
--                 cooked, so this one has a WASTAGE cost attached whether or not
--                 anybody wrote it down.
--   after_bill    A bill already existed for this table. This is the shape of a
--                 till fraud: take the guest's money, then void the order so the
--                 sale never appears. Every one of these deserves a human look.
--
-- A CLIENT MUST NOT BE ABLE TO SELF-REPORT THAT NUMBER. The whole value of the
-- stage is that it is adversarial: the person whose void it is has an obvious
-- interest in it reading "before_print". So it is derived here, server-side,
-- from facts the server already holds and the client cannot reach:
--
--   after_bill   <- a "Bills" row exists for the order's table, raised at or
--                   before the void and belonging to the CURRENT seating (later
--                   than the previous bill's close). A bill row is only ever
--                   minted by generating, discounting, couponing or settling a
--                   bill — i.e. by an act the guest can see.
--   after_print  <- "Orders".barked_at is not null (the expo announced the order
--                   to the kitchen; migration 016), or a "PrintJobs" row of
--                   kind='kot' was enqueued for this table after the order was
--                   created (migration 027). Either is proof paper reached a
--                   kitchen.
--   before_print <- neither of the above could be shown.
--
-- `stage_evidence` stores the facts that fired, verbatim. A derived
-- classification in a fraud document that cannot be re-checked is just an
-- assertion with extra steps; with the evidence beside it, a manager disputing a
-- stage can be answered with "this bill, raised at this instant" rather than
-- "the system said so".
--
-- ============================================================================
-- THE BACKFILL POSTURE FOR THE EXISTING status=5 ROWS: THERE ISN'T ONE
-- ============================================================================
-- Every order cancelled before this migration has NO row in this table, and that
-- is the correct and permanent answer. The readers report those voids with
-- reason = null and stage = null, rendered as "unknown". They are NOT
-- back-derived, even though the derivation above would technically run against
-- an old order: the facts it reads (a bill row's existence, a KOT print job)
-- describe the table's state NOW, not its state at the instant of a void that
-- happened months ago, and a stage computed from the wrong instant is a
-- fabricated fraud signal pointing at a named employee. An honest gap is
-- strictly better. The reports say how many rows are in that gap.
--
-- ============================================================================
-- ONE TABLE FOR TWO SCOPES
-- ============================================================================
-- Two different acts destroy food in this system and both are voids:
--   scope='order' — the whole ticket goes (PATCH /orders/:id/status -> Cancelled,
--                   or removeItemFromTableOrders emptying the last line, which
--                   sets status = 5).
--   scope='item'  — one line goes (DELETE /orders/:id/items/:itemId, and the
--                   admin remove-from-bill path).
-- Splitting them into two tables would mean every void report is a UNION and
-- every total has to be assembled twice. One table with a scope column and a
-- nullable item_id keeps "what did we void today" a single query.
--
-- WHAT THIS IS NOT. It is not the non-chargeable ledger (034). A void means the
-- food was NOT served; an NC means it WAS served and not charged for. Conflating
-- them is how a wastage figure and a giveaway figure become the same wrong
-- number.
--
-- No FK to "Orders": DeleteOrder hard-deletes that row, so CASCADE would erase
-- the record of the void and RESTRICT would break a routine delete. Migration
-- 034's header argues this at length; the same reasoning applies unchanged.
--
-- text + CHECK rather than a Postgres enum (024's convention). NOT CREATED
-- LAZILY (026's outage, restated by 027/029/033).

CREATE TABLE IF NOT EXISTS "OrderVoids" (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  res_id        uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  outlet_id     uuid NOT NULL REFERENCES "Outlets"(id)    ON UPDATE CASCADE ON DELETE CASCADE,

  order_id      uuid NOT NULL,
  -- See the header. NULL for scope='order'; the enforcing CHECK is below.
  scope         text NOT NULL DEFAULT 'order' CHECK (scope IN ('order','item')),
  item_id       text,
  item_name     text,
  table_id      uuid,

  -- WHEN THE VOID HAPPENED, as the server saw it. Separate from created_at (the
  -- row's own write time) because a void recorded through a replayed offline
  -- write lands minutes after the act, and a fraud timeline that is minutes
  -- wrong is a fraud timeline nobody can cross-check against a camera.
  voided_at     timestamptz NOT NULL DEFAULT now(),

  void_kind     text NOT NULL
                CHECK (void_kind IN ('wrong_entry','guest_changed_mind','kitchen_error','duplicate','test_order','item_unavailable','other')),
  reason        text NOT NULL CHECK (btrim(reason) <> ''),

  -- THE DERIVED STAGE. See the header — server-derived, client-supplied values
  -- are ignored by the writer.
  stage         text NOT NULL
                CHECK (stage IN ('before_print','after_print','after_bill')),
  -- The facts the derivation used: {"bill_id":…,"bill_no":…,"bill_created_at":…,
  -- "barked_at":…,"kot_print_job_id":…,"kot_printed_at":…}. Keys are present only
  -- when that fact was actually found, so an empty object is a truthful
  -- "before_print: nothing could be shown".
  stage_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- THE MONEY THAT WAS VOIDED, snapshotted at the instant of the void, PRE-TAX
  -- (the same basis as "Orders".food.subtotal and therefore as every other
  -- figure the void report sits next to). Not derived at read time: the order's
  -- blob is edited afterwards by the very act being recorded here, so the value
  -- would read as 0 for every void.
  value_voided  numeric NOT NULL DEFAULT 0 CHECK (value_voided >= 0),

  -- WHO. Same two-name rule as 034: the person who did it and the person who
  -- owns the decision, both always recorded rather than one inferred from a
  -- blank. authorised_by is NOT NULL for the same fraud-control reason.
  voided_by_employee_id     uuid,
  voided_by_username        text NOT NULL CHECK (btrim(voided_by_username) <> ''),
  authorised_by_employee_id uuid,
  authorised_by_username    text NOT NULL CHECK (btrim(authorised_by_username) <> ''),

  -- scope='item' addresses a line and must name it; scope='order' must not, so
  -- an order-level void can never be mistaken for a line-level one by a reader
  -- that only checks item_id for null.
  CONSTRAINT ordervoids_scope_item CHECK (
    (scope = 'item'  AND item_id IS NOT NULL AND btrim(item_id) <> '')
    OR
    (scope = 'order' AND item_id IS NULL)
  )
);

-- At most ONE void record per order-level void. A re-cancel of an already
-- cancelled order is a documented no-op in SetOrderStatus, and it must not be
-- able to write a second reason over the first (which is how the real reason
-- gets replaced with "duplicate" by an accidental double-tap).
CREATE UNIQUE INDEX IF NOT EXISTS ordervoids_one_per_order_uidx
  ON "OrderVoids" (res_id, order_id)
  WHERE scope = 'order';

-- Line-level voids are naturally one per (order, line): a line can only be
-- removed once, and the line ceases to exist afterwards.
CREATE UNIQUE INDEX IF NOT EXISTS ordervoids_one_per_item_uidx
  ON "OrderVoids" (res_id, order_id, item_id)
  WHERE scope = 'item';

-- The report's read: a window, per tenant/outlet, newest first.
CREATE INDEX IF NOT EXISTS ordervoids_window_idx
  ON "OrderVoids" (res_id, outlet_id, voided_at DESC);

-- "Show me every after_bill void this month" — the one query a control report
-- runs that must not degrade into a window scan as the table grows.
CREATE INDEX IF NOT EXISTS ordervoids_stage_idx
  ON "OrderVoids" (res_id, outlet_id, stage, voided_at DESC);

ALTER TABLE "OrderVoids" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderVoids" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "OrderVoids";
CREATE POLICY tenant_isolation ON "OrderVoids"
  USING      (res_id::text = current_setting('app.res_id', true))
  WITH CHECK (res_id::text = current_setting('app.res_id', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "OrderVoids" TO app_runtime;
  END IF;
END $$;
