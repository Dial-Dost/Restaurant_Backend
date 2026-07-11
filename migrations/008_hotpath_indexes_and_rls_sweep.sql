-- Migration 008: version-controlled hot-path indexes for base tables + a final
-- RLS sweep over every res_id table.
--
-- WHY:
--  * Index coverage on Orders/Bills/Employees/Inventory was whatever the original
--    Supabase project happened to have — not reproducible on a rebuilt DB, where
--    the hot predicates (res_id/outlet_id/table_id, created-at ranges) degrade to
--    full scans that grow with order history. This ships them declaratively.
--  * Re-applies the tenant_isolation RLS policy to every res_id table so any
--    lazily-created feature table that predates RLS-at-creation is covered too.
--
-- SAFETY: every index is created only when ALL its target columns actually exist
-- (guards against schema drift), and uses IF NOT EXISTS. Idempotent; safe to
-- re-run. Apply on STAGING first. Requires migration 002 (app_runtime) for the
-- intended least-privilege production posture.

-- 1) Final RLS sweep (mirrors 003/007; idempotent). Fail-closed on app.res_id.
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

-- 2) Hot-path composite indexes. Created only when every target column exists.
DO $$
DECLARE
  rec record;
  cols_exist boolean;
  collist text;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('Orders',         'idx_orders_res_outlet_table',     ARRAY['res_id','outlet_id','table_id']),
      ('Orders',         'idx_orders_res_outlet_created',   ARRAY['res_id','outlet_id','created_at']),
      ('Bills',          'idx_bills_res_outlet_table',      ARRAY['res_id','outlet_id','table_id']),
      ('Bills',          'idx_bills_res_outlet_created',    ARRAY['res_id','outlet_id','created_at']),
      ('Bills',          'idx_bills_res_outlet_closed',     ARRAY['res_id','outlet_id','closed_at']),
      ('Employees',      'idx_employees_res_outlet',        ARRAY['res_id','outlet_id']),
      ('Inventory',      'idx_inventory_res_outlet_barcode',ARRAY['res_id','outlet_id','barcode']),
      ('StockMovements', 'idx_stockmov_res_outlet_created', ARRAY['res_id','outlet_id','created_at']),
      ('Expenses',       'idx_expenses_res_outlet_spent',   ARRAY['res_id','outlet_id','spent_on']),
      ('Attendance',     'idx_attendance_res_outlet_emp',   ARRAY['res_id','outlet_id','emp_id'])
    ) AS v(tbl, idx, cols)
  LOOP
    IF to_regclass(format('public.%I', rec.tbl)) IS NULL THEN
      CONTINUE;
    END IF;
    SELECT bool_and(EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = rec.tbl AND column_name = c
    )) INTO cols_exist
    FROM unnest(rec.cols) AS c;

    IF cols_exist THEN
      SELECT string_agg(format('%I', c), ', ') INTO collist FROM unnest(rec.cols) AS c;
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (%s)', rec.idx, rec.tbl, collist);
    ELSE
      RAISE NOTICE 'Skipping index % on % (missing column)', rec.idx, rec.tbl;
    END IF;
  END LOOP;
END $$;

-- Verify (psql):
--   SELECT indexrelid::regclass FROM pg_index WHERE indexrelid::regclass::text LIKE 'idx_%';
