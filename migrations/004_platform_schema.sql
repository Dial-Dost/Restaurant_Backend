-- Migration 004: SaaS control plane (platform schema).
--
-- The control plane is PHYSICALLY ISOLATED from the tenant plane: it lives in a
-- separate `platform` schema that the tenant runtime role (app_runtime) has no
-- access to. Platform endpoints connect as a separate role (platform_runtime).
-- This keeps the tenant RLS (migration 003) intact — nothing here weakens it.
--
-- !! Apply on STAGING first. Requires migration 002 (app_runtime) first.

CREATE SCHEMA IF NOT EXISTS platform;

-- Internal SaaS operators (not restaurant staff).
CREATE TABLE IF NOT EXISTS platform.admins (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text UNIQUE NOT NULL,
  pass_hash  text NOT NULL,                 -- argon2id
  name       text,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Subscription plan catalog.
CREATE TABLE IF NOT EXISTS platform.plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text UNIQUE NOT NULL,         -- starter | growth | enterprise | ...
  name        text NOT NULL,
  price_cents integer NOT NULL DEFAULT 0,
  features    jsonb NOT NULL DEFAULT '{}'::jsonb,  -- feature flags
  limits      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- e.g. {"outlets":1,"employees":10}
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One subscription per restaurant (its lifecycle).
CREATE TABLE IF NOT EXISTS platform.subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  res_id             uuid NOT NULL UNIQUE REFERENCES "Restaurant"(id) ON DELETE CASCADE,
  plan_id            uuid REFERENCES platform.plans(id),
  status             text NOT NULL DEFAULT 'trial',  -- trial|active|past_due|suspended|cancelled|expired
  trial_ends_at      timestamptz,
  current_period_end timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Audit of platform admin actions.
CREATE TABLE IF NOT EXISTS platform.audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id      uuid REFERENCES platform.admins(id),
  action        text NOT NULL,
  target_res_id uuid,
  detail        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Account status lives on the tenant row (platform-controlled). created_at
-- already exists on "Restaurant".
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS account_status text NOT NULL DEFAULT 'active'; -- active|suspended

-- Dedicated runtime role for platform endpoints (separate from app_runtime).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_runtime') THEN
    CREATE ROLE platform_runtime LOGIN PASSWORD 'CHANGE_ME_STRONG_PASSWORD'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA platform TO platform_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA platform TO platform_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_runtime;
-- Platform manages tenant lifecycle on the (RLS fail-open metadata) Restaurant row.
GRANT USAGE ON SCHEMA public TO platform_runtime;
GRANT SELECT, UPDATE ON "Restaurant" TO platform_runtime;

-- The tenant runtime role must NEVER touch the control plane.
REVOKE ALL ON SCHEMA platform FROM app_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA platform FROM app_runtime;

-- Effective account status for a restaurant, callable by the tenant role at
-- login WITHOUT granting it access to the platform schema. SECURITY DEFINER so
-- it runs with the (privileged) owner's rights; search_path pinned for safety.
CREATE OR REPLACE FUNCTION platform.restaurant_status(p_res_id uuid)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = platform, public
AS $$
  SELECT CASE
    WHEN r.account_status = 'suspended' THEN 'suspended'
    WHEN s.status IS NULL THEN 'active'  -- no subscription row yet => allow
    WHEN s.status IN ('suspended', 'cancelled') THEN 'suspended'
    WHEN s.status = 'expired' THEN 'expired'
    WHEN s.status = 'trial'  AND s.trial_ends_at      IS NOT NULL AND s.trial_ends_at      < now() THEN 'expired'
    WHEN s.status = 'active' AND s.current_period_end IS NOT NULL AND s.current_period_end < now() THEN 'expired'
    ELSE 'active'
  END
  FROM "Restaurant" r
  LEFT JOIN platform.subscriptions s ON s.res_id = r.id
  WHERE r.id = p_res_id;
$$;

REVOKE ALL ON FUNCTION platform.restaurant_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.restaurant_status(uuid) TO app_runtime, platform_runtime;

-- Verify:
-- SELECT nspname FROM pg_namespace WHERE nspname = 'platform';
-- SELECT platform.restaurant_status('<some-restaurant-uuid>');
