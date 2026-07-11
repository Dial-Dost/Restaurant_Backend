-- Migration 016: "Barked" step on Orders.
--
-- barked_at marks when the expo announced (barked) the order to the kitchen —
-- orders from every channel now arrive un-barked and dish prep timers only
-- start at bark time. barked_by records the employee who barked.
--
-- The backfill runs ONLY when the column is first created: every pre-existing
-- order counts as already barked (at created_at) so live restaurants keep their
-- old timer semantics and nothing gets stuck behind the new step. The same
-- guarded ALTER+backfill runs lazily from the app (ensureOrderBarkColumns), so
-- whichever side runs first wins and the other is a no-op.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Orders' AND column_name = 'barked_at'
  ) THEN
    ALTER TABLE "Orders" ADD COLUMN barked_at timestamptz;
    UPDATE "Orders" SET barked_at = created_at WHERE barked_at IS NULL;
  END IF;
  ALTER TABLE "Orders" ADD COLUMN IF NOT EXISTS barked_by text;
END $$;

-- Dedicated audit action (matches BARK_ORDER_ACTION_ID in the app).
INSERT INTO "Actions" (id, action_name, action_desc)
VALUES ('3f6a9c1e-8d24-4b7a-b5c9-2e1f7d4a8b63', 'Bark Order', 'Barked (announced) an order to the kitchen')
ON CONFLICT (id) DO NOTHING;
