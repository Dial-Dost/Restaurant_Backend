-- Migration 005: platform helper functions for feature-gating + health metrics.
-- Additive to 004. Apply on STAGING first. Requires 004.
--
-- All functions are SECURITY DEFINER (owned by the migration runner). The
-- migration runner bypasses RLS, so functions that aggregate across tenants
-- (all_restaurant_metrics) work despite the fail-closed tenant RLS, while
-- exposing ONLY the specific, read-only values returned here.

-- Effective plan features + limits for a restaurant. Callable by the tenant
-- role at login WITHOUT granting it access to the platform schema. Returns no
-- rows when the restaurant has no plan (caller treats as empty {}).
CREATE OR REPLACE FUNCTION platform.restaurant_plan(p_res_id uuid)
RETURNS TABLE(features jsonb, limits jsonb)
LANGUAGE sql
SECURITY DEFINER
SET search_path = platform, public
AS $$
  SELECT coalesce(p.features, '{}'::jsonb), coalesce(p.limits, '{}'::jsonb)
  FROM platform.subscriptions s
  JOIN platform.plans p ON p.id = s.plan_id
  WHERE s.res_id = p_res_id
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION platform.restaurant_plan(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.restaurant_plan(uuid) TO app_runtime, platform_runtime;

-- Per-tenant health metrics (counts) for the admin console. One call returns a
-- row per restaurant. Only the platform role may execute it.
CREATE OR REPLACE FUNCTION platform.all_restaurant_metrics()
RETURNS TABLE(res_id uuid, employees bigint, outlets bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, platform
AS $$
  SELECT
    r.id,
    (SELECT count(*) FROM "Employees" e WHERE e.res_id = r.id),
    (SELECT count(*) FROM "Outlets"   o WHERE o.res_id = r.id)
  FROM "Restaurant" r;
$$;

REVOKE ALL ON FUNCTION platform.all_restaurant_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.all_restaurant_metrics() TO platform_runtime;

-- Verify:
-- SELECT * FROM platform.restaurant_plan('<res-uuid>');
-- SELECT * FROM platform.all_restaurant_metrics();
