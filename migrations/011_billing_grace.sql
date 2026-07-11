-- Migration 011: subscription grace period.
-- A lapsed paid period (or past_due) should still allow LOGIN so the tenant can
-- self-serve renew (the dashboard banner nudges them). The billing cycle flags
-- past_due, then suspends after SAAS_GRACE_DAYS (which revokes sessions + blocks
-- login). This replaces the previous behavior where an active sub became 'expired'
-- the instant its period lapsed (which would lock a paying tenant out before they
-- could renew). Trials still hard-expire at trial_ends_at. Idempotent.

CREATE OR REPLACE FUNCTION platform.restaurant_status(p_res_id uuid)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = platform, public
AS $$
  SELECT CASE
    WHEN r.account_status = 'suspended' THEN 'suspended'
    WHEN s.status IS NULL THEN 'active'  -- no subscription => fail-open (unchanged)
    WHEN s.status IN ('suspended', 'cancelled') THEN 'suspended'
    WHEN s.status = 'expired' THEN 'expired'
    WHEN s.status = 'trial' AND s.trial_ends_at IS NOT NULL AND s.trial_ends_at < now() THEN 'expired'
    ELSE 'active'  -- active OR past_due within grace allow login; cycle suspends after grace
  END
  FROM "Restaurant" r
  LEFT JOIN platform.subscriptions s ON s.res_id = r.id
  WHERE r.id = p_res_id;
$$;

REVOKE ALL ON FUNCTION platform.restaurant_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.restaurant_status(uuid) TO app_runtime, platform_runtime;
