-- Migration 003: enable Row-Level Security for tenant isolation.
--
-- Model: shared schema, one tenant = one restaurant. res_id == "Restaurant".id.
-- Every request the backend serves runs inside a connection where the GUC
-- `app.res_id` is set to the caller's restaurant (see openTenantConnection /
-- withTenant in database_supabase.ts). These policies bind each row to that GUC.
--
-- FAIL CLOSED: operational tables are visible ONLY when app.res_id matches the
-- row's res_id. If the context is unset (NULL) or empty, no operational rows are
-- visible — a missing/escaped context can never leak another tenant's data.
--
-- The two exceptions are the bootstrap/metadata tables "Restaurant" and
-- "Outlets". They must be readable during the pre-session slug -> res_id lookup
-- (you don't know res_id until you resolve the slug), so they additionally allow
-- access when no context is set. They hold only tenant metadata (name, slug,
-- address), never operational data.
--
-- !! Apply on STAGING first (a wrong policy surfaces as zero-row reads or
--    permission errors). Requires migration 002 (app_runtime role) first, and
--    the backend connecting as that role.

-- 1) Operational tables: every table with a res_id column, fail-closed.
--    Excludes the global "Actions" catalog (shared, no res_id) and the two
--    metadata tables handled separately below.
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
      AND table_name NOT IN ('Actions', 'Outlets')
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

-- 2) Bootstrap/metadata tables. Keyed on their tenant id but ALSO readable with
--    no context set, for the pre-session slug -> res_id resolution at login.
ALTER TABLE "Restaurant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Restaurant" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Restaurant";
CREATE POLICY tenant_isolation ON "Restaurant"
  USING (
    id::text = current_setting('app.res_id', true)
    OR coalesce(current_setting('app.res_id', true), '') = ''
  )
  WITH CHECK (
    id::text = current_setting('app.res_id', true)
    OR coalesce(current_setting('app.res_id', true), '') = ''
  );

ALTER TABLE "Outlets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Outlets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Outlets";
CREATE POLICY tenant_isolation ON "Outlets"
  USING (
    res_id::text = current_setting('app.res_id', true)
    OR coalesce(current_setting('app.res_id', true), '') = ''
  )
  WITH CHECK (
    res_id::text = current_setting('app.res_id', true)
    OR coalesce(current_setting('app.res_id', true), '') = ''
  );

-- Verify which tables now enforce RLS:
-- SELECT relname, relrowsecurity, relforcerowsecurity
-- FROM pg_class WHERE relkind = 'r' AND relrowsecurity ORDER BY relname;
--
-- Fail-closed check (psql): with NO context set, an operational table is empty.
--   RESET app.res_id;  SELECT count(*) FROM "Orders";   -- expect 0
--   SET app.res_id = '<restaurantA-uuid>';  SELECT count(*) FROM "Orders"; -- only A
--   SET app.res_id = '<restaurantB-uuid>';  SELECT count(*) FROM "Orders"; -- only B
