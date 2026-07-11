-- Migration 007: extend RLS to runtime-created feature tables + add uniqueness
-- guards that prevent double-billing and duplicate open bills.
--
-- WHY: migration 003 enabled RLS only on tables that existed when it ran. Several
-- feature tables (Coupons, CouponRedemptions, Vendors, StockMovements,
-- Attendance, PasswordResetRequests, Expenses, …) are created lazily at runtime
-- by the app, so they were never covered. This re-runs 003's auto-discovery block
-- (idempotent) so every public table with a res_id column gets the tenant
-- isolation policy. Re-run this migration after enabling a new feature whose
-- table did not yet exist.
--
-- !! Apply on STAGING first. Requires migrations 002 (app_runtime) + 004/006.

-- 1) Tenant isolation (fail-closed) for every res_id table not already covered.
DO $$
DECLARE
  t text;
  predicate text := 'res_id::text = current_setting(''app.res_id'', true)';
BEGIN
  FOR t IN
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'res_id'
      AND table_name NOT IN ('Actions', 'Outlets', 'Restaurant')
    GROUP BY table_name
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (%s) WITH CHECK (%s)',
      t, predicate, predicate
    );
  END LOOP;
END $$;

-- 2) Recurring billing: one invoice per (restaurant, period) — makes the
--    billing-cycle dedup atomic and immune to concurrent/replicated runs.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_res_period_uniq
  ON platform.invoices (res_id, period_end)
  WHERE period_end IS NOT NULL;

-- 3) At most one OPEN bill per table — closes the check-then-insert race in the
--    payment/discount/coupon materialization paths.
CREATE UNIQUE INDEX IF NOT EXISTS bills_one_open_per_table
  ON "Bills" (table_id, outlet_id)
  WHERE closed_at IS NULL;

-- 4) One coupon code per (restaurant, outlet) — backs the UpsertCoupon dup-check.
--    "Coupons" is a lazily-created feature table (it may not exist yet on a tenant
--    that has never made a coupon); guard so this migration doesn't fail on a DB
--    without it. When the table is later created, ensureCouponsTable adds the same
--    index, so coverage is preserved either way.
DO $$
BEGIN
  IF to_regclass('public."Coupons"') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS coupons_res_outlet_code_uniq
      ON "Coupons" (res_id, coalesce(outlet_id, '00000000-0000-0000-0000-000000000000'::uuid), upper(code));
  END IF;
END $$;

-- Verify:
-- SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
--   WHERE relname IN ('Coupons','Vendors','Attendance','Expenses','StockMovements','PasswordResetRequests');
