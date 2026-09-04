-- Migration 034: NON-CHARGEABLE (NC) order lines — the complimentary /
-- staff-meal / spoilage / tasting / guest-complaint / promo ledger.
--
-- WHAT IS MISSING TODAY. Food leaves this kitchen without being charged for it
-- every single service, and the system has no idea. A waiter who wants to comp a
-- dessert has exactly two tools: delete the line (the food is gone, the revenue
-- is gone, and nothing anywhere says a dish was given away) or discount the
-- whole bill (which misattributes a dish-level giveaway to a bill-level
-- decision). Neither records WHO authorised it, and that is the entire point:
-- an NC nobody approved is precisely the thing an NC report exists to catch.
--
-- THE FRAUD CONTROL IS `authorised_by`, AND IT IS NOT NULLABLE. A staff member
-- comping their own friend's table is the single most common till fraud in a
-- restaurant, and the only defence that survives contact with a busy Saturday is
-- a second name against every giveaway. Making the column nullable would let the
-- one field that matters be the one field that is always empty.
--
-- ============================================================================
-- WHERE THE FLAG LIVES, AND WHY IT LIVES IN TWO PLACES ON PURPOSE
-- ============================================================================
-- "Orders".food is a JSON blob, `{items:[{id,name,quantity,price,...}]}`. There
-- is no OrderItems table to hang a foreign key on. So an NC has to be recorded
-- somewhere, and there are only two candidates:
--
--   (1) A KEY ON THE ITEM inside the blob (`nc: true`). This is what BILLING
--       must read, because billing is a hot path that already reduces that blob
--       (activeOrderSubtotal), and because the deduction has to be exact: if the
--       line's quantity is later edited, a flag ON the line is still right,
--       while a separately-stored money amount is instantly stale.
--
--   (2) THIS TABLE. The blob cannot carry the reason, the authoriser, the
--       timestamp, a reversal, or a price snapshot without becoming an audit log
--       written by five different clients — and it is not queryable: an NC
--       report over a month cannot scan every order's JSON.
--
-- So: BOTH, written in ONE transaction, with a strict division of authority.
--   * THIS TABLE IS THE LEDGER. Every question a report or an auditor asks
--     (what was given away, by whom, why, worth how much) is answered here.
--   * THE `nc` KEY ON THE ITEM IS THE BILLING FACT. Exactly one thing reads it:
--     the reduction that produces "Orders".food.subtotal, which every bill-summing
--     path in the system already funnels through (sumOrderTotalsForTable ->
--     activeOrderSubtotal, and AddOrder's pricedSubtotal, which is what writes
--     that stored subtotal in the first place). Getting the deduction into those
--     two functions is what makes the open bill, the printed bill, the KOT, the
--     settle path, the split path, the merge path and the closed-bill detail all
--     agree without any of them knowing this table exists.
--
-- The duplication is deliberate and it is bounded: the ledger row is written
-- first, in the same transaction as the blob edit, and the blob carries the
-- ledger row's id (`nc_id`) so the two can always be reconciled. Nothing else in
-- the codebase may set that key — AddOrder strips `nc*` from every client-supplied
-- item and re-applies only the SERVER's stored flags, so a compromised or buggy
-- till cannot comp a dish by editing its own payload.
--
-- ============================================================================
-- THE PRICE SNAPSHOT
-- ============================================================================
-- `unit_price` is the price the line WOULD have been charged at, captured at the
-- moment of the NC, and `value` is derived from it by the database rather than
-- by the caller. A menu price change six weeks later must not rewrite what last
-- month's giveaways cost — that is not a report, that is a rewrite of history.
--
-- `menu_price_at_nc` is recorded ALONGSIDE it and is nullable, because the two
-- are not always the same number: applyMenuPriceFloor guarantees a line is never
-- billed BELOW its menu price but happily bills an off-menu or manually-uplifted
-- line above it, and the revenue actually given away is the line price, not the
-- menu's. Keeping both means "what did we lose" and "what does the menu say"
-- can be asked separately instead of one being silently substituted for the
-- other. NULL means the line did not resolve to a menu row at all (a valet fee,
-- an open item, an aggregator line) — an honest gap, never a fabricated price.
--
-- `value` is GENERATED ALWAYS. The loss is quantity x unit_price and there is no
-- circumstance in which a caller should be able to disagree with that; a stored
-- total that a caller can set independently of its own factors is how a
-- fraud-control figure quietly stops being one.
--
-- ============================================================================
-- REVERSAL IS A SUPERSESSION, NEVER A DELETE
-- ============================================================================
-- Un-comping a dish (wrong item, wrong table, manager said no) leaves the
-- original row and stamps `reversed_at`. Deleting it would erase the evidence of
-- the act, which is the same mistake DeleteOrder deliberately refuses to make
-- for cancelled orders ("deleting it would erase the very record the audit-log
-- undo needs"). The partial unique index below is what keeps the billing side
-- unambiguous: at most ONE live NC per (order, item), for ever.
--
-- ============================================================================
-- NO FOREIGN KEY TO "Orders" OR "Bills", AND THAT IS NOT AN OVERSIGHT
-- ============================================================================
-- DeleteOrder (database_supabase.ts) HARD-DELETES an "Orders" row. A composite
-- FK with ON DELETE CASCADE would therefore let one DELETE erase the record of
-- the giveaway it is deleting — the exact evidence this table exists to hold —
-- and ON DELETE RESTRICT would make a routine delete start failing in
-- production for a reason no operator could diagnose. Tenant integrity is
-- already guaranteed twice over: RLS binds every read and write to res_id, and
-- res_id/outlet_id ARE real foreign keys. Same posture migration 033 takes with
-- employee_id, and for the same reason.
--
-- text + CHECK rather than a Postgres enum, matching the house convention for
-- workflow state (024's note applies verbatim).
--
-- NOT CREATED LAZILY, deliberately — same reasoning as 027/029/033: migration
-- 026's header records the production outage that `create table if not exists`
-- inside database_supabase.ts caused under the least-privilege app_runtime role,
-- which has USAGE but not CREATE on public (002:28).

CREATE TABLE IF NOT EXISTS "OrderItemNonChargeable" (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  res_id        uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  outlet_id     uuid NOT NULL REFERENCES "Outlets"(id)    ON UPDATE CASCADE ON DELETE CASCADE,

  -- WHAT WAS COMPED. order_id + item_id together address one line inside
  -- "Orders".food.items[]. See the header for why there is no FK.
  order_id      uuid NOT NULL,
  -- The order-line id (`food.items[].id`). text, not uuid: most lines carry a
  -- v4 uuid, but a line that arrived without one is read back through
  -- GetOrders' `String(entry.id ?? randomUUID())` fallback and some legacy rows
  -- carry a menu id or a client-side slug instead. Refusing to record an NC
  -- because the line's id is not uuid-shaped would drop the control on exactly
  -- the oldest data.
  item_id       text NOT NULL,
  -- Snapshotted so the report reads without touching the order blob at all, and
  -- so a renamed dish does not rewrite what was given away.
  item_name     text NOT NULL,
  -- The table this happened on, snapshotted for the report's grouping. Nullable:
  -- a takeaway/delivery order has no table.
  table_id      uuid,

  -- WHY. `nc_kind` is the bucket a report sums by; `reason` is the sentence a
  -- human reads next to it. Both are required — a bucket with no sentence is
  -- unauditable, and a sentence with no bucket cannot be totalled.
  nc_kind       text NOT NULL
                CHECK (nc_kind IN ('complimentary','staff_meal','spoilage','tasting','guest_complaint','promo')),
  reason        text NOT NULL CHECK (btrim(reason) <> ''),

  -- HOW MUCH WAS GIVEN AWAY. See the header: value is derived, never supplied.
  quantity         numeric NOT NULL CHECK (quantity > 0),
  unit_price       numeric NOT NULL CHECK (unit_price >= 0),
  menu_price_at_nc numeric CHECK (menu_price_at_nc IS NULL OR menu_price_at_nc >= 0),
  value            numeric GENERATED ALWAYS AS (round(quantity * unit_price, 2)) STORED,

  -- WHO. marked_by is the person who pressed the button; authorised_by is the
  -- person who owns the decision. They are allowed to be the same human (a
  -- manager comping a table needs no second manager) but the row must always say
  -- so explicitly rather than leaving it to be inferred from a blank.
  marked_by_employee_id     uuid,
  marked_by_username        text NOT NULL CHECK (btrim(marked_by_username) <> ''),
  authorised_by_employee_id uuid,
  authorised_by_username    text NOT NULL CHECK (btrim(authorised_by_username) <> ''),

  -- REVERSAL. See the header — a supersession, not a delete.
  reversed_at       timestamptz,
  reversed_by_username text,
  reversal_reason   text,
  CONSTRAINT orderitemnc_reversal_complete
    CHECK ((reversed_at IS NULL) = (reversed_by_username IS NULL))
);

-- THE BILLING INVARIANT, AS A CONSTRAINT. At most one LIVE non-chargeable per
-- order line. Without this, two tills racing the same comp would each write a
-- ledger row while the blob carries one flag, and the NC report would double the
-- money given away on a bill whose total only ever dropped once.
CREATE UNIQUE INDEX IF NOT EXISTS orderitemnc_live_line_uidx
  ON "OrderItemNonChargeable" (res_id, order_id, item_id)
  WHERE reversed_at IS NULL;

-- The NC report's read: a window, per tenant/outlet, newest first.
CREATE INDEX IF NOT EXISTS orderitemnc_window_idx
  ON "OrderItemNonChargeable" (res_id, outlet_id, created_at DESC);

-- The billing-side read: "what is comped on THIS order", used to reconcile the
-- blob's flags against the ledger.
CREATE INDEX IF NOT EXISTS orderitemnc_order_idx
  ON "OrderItemNonChargeable" (res_id, order_id);

-- Fail-closed from the moment it exists, in migration 003's exact policy form.
-- 003 applies RLS by a dynamic loop over information_schema.columns (003:30-45),
-- which does not retro-cover tables created later, so this is not redundant.
ALTER TABLE "OrderItemNonChargeable" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderItemNonChargeable" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "OrderItemNonChargeable";
CREATE POLICY tenant_isolation ON "OrderItemNonChargeable"
  USING      (res_id::text = current_setting('app.res_id', true))
  WITH CHECK (res_id::text = current_setting('app.res_id', true));

-- 002's ALTER DEFAULT PRIVILEGES only covers tables created by the role that set
-- it, so spell the grants out — a migration run under a different owner would
-- otherwise leave the runtime unable to read its own rows. (024/033's guard.)
-- No sequence to grant: identity is a uuid.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "OrderItemNonChargeable" TO app_runtime;
  END IF;
END $$;
