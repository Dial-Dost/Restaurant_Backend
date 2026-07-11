-- Migration 002: dedicated runtime DB role for the application.
--
-- Purpose: the backend currently connects as the table owner, which BYPASSES
-- Row-Level Security. Create a least-privilege role that the app connects as so
-- that RLS (migration 003) is actually enforced on every query.
--
-- IMPORTANT — apply order & rollout:
--   1. Run this on a STAGING copy first (see plan risks).
--   2. Set a real password below (or ALTER ROLE ... PASSWORD after creating).
--   3. Point the backend at this role: set SUPABASE_DIRECT_URL / DATABASE_URL to
--      connect as app_runtime instead of the owner.
--   4. Then apply migration 003.
--
-- NOTE: migration 003 also uses FORCE ROW LEVEL SECURITY, so RLS is enforced
-- even for the table owner. The dedicated role is defence-in-depth + least
-- privilege; both together are the intended production posture.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    -- Replace 'CHANGE_ME_STRONG_PASSWORD' before running outside local dev.
    CREATE ROLE app_runtime LOGIN PASSWORD 'CHANGE_ME_STRONG_PASSWORD'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- Schema + object privileges (DML only; no DDL).
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;

-- Ensure future tables/sequences are reachable too.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;

-- Verify:
-- SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_runtime';
