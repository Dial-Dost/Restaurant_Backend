-- Migration 028: 'archived' as a third "Restaurant".account_status value.
--
-- WHAT ARCHIVING IS. A restaurant that has left the platform. Staff can no longer
-- sign in, the billing cycle stops charging it, and the operator console shows it
-- greyed out rather than hiding it. It is REVERSIBLE: POST /platform/restaurants/
-- :id/restore puts account_status back to 'active' and restores the subscription
-- status recorded in the archive's platform.audit row.
--
-- WHAT ARCHIVING IS NOT: a delete. Every tenant table — "Orders", "Bills" (with
-- their tax_breakdown), "Audit_logs", "Feedback_entries", "Customers" — carries
-- `res_id ... ON DELETE CASCADE` to "Restaurant"(id) (000_base_schema.sql:433-477).
-- A single `DELETE FROM "Restaurant" WHERE id = ...` therefore destroys a tenant's
-- entire statutory financial history in one statement, unrecoverably. In India
-- those are records that must be retained. There is no hard-delete route and there
-- must not be one; removal is this flag plus a cancelled subscription, and nothing
-- else is touched.
--
-- WHY A THIRD VALUE ON account_status RATHER THAN A NEW COLUMN. account_status is
-- `text NOT NULL DEFAULT 'active'` with NO check constraint (000:330, 004:58), so a
-- third value needs no column change at all. The repository's soft-delete flag,
-- is_deleted, exists only on "Tables" (000:363) — adding one to "Restaurant" would
-- put a second lifecycle flag next to the one that already carries the lifecycle,
-- which is exactly the duplication a prior architecture review rejected.
--
-- WHY 'archived' IS KEPT DISTINCT FROM 'suspended'. Suspended means "we switched
-- you off, we expect you back, keep billing". Archived means "you left, stop
-- billing, keep the books". Collapsing them makes a delinquent tenant
-- indistinguishable from a departed one and keeps invoicing someone who cancelled.
--
-- WHY THIS FILE IS NOT OPTIONAL. platform.restaurant_status (migration 011) matches
-- the literal 'suspended' and falls through to 'active' for anything else. Until
-- this replacement is applied, an archived tenant reads as ACTIVE to
-- GetRestaurantAccountStatus: the login gate (routes/auth.ts:151) lets its staff in
-- and the scheduled-report sweep (report_schedules.ts:215) keeps delivering, while
-- the operator console says "Archived". Ship this WITH the archive route.
--
-- THE CODE NOW REFUSES TO RUN WITHOUT IT, so that failure cannot reach a customer:
-- platform/db.ts's archivedStatusSupported() reads this function's body out of
-- pg_proc and looks for the 'archived' arm below. Missing => the archive route
-- answers 503 naming this file and writes nothing, and bootstrap logs an error
-- banner. Ordering, and why the container deploy path does not apply migrations,
-- are in docs/DEPLOY_ORDER.md. If you edit the arm, keep the literal text
-- `account_status = 'archived'` — that is what the runtime check matches on.
--
-- Idempotent (CREATE OR REPLACE). Only the function body changes; no table is
-- altered and no row is written.

CREATE OR REPLACE FUNCTION platform.restaurant_status(p_res_id uuid)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = platform, public
AS $$
  SELECT CASE
    -- New arm. First, because an archived tenant is archived regardless of what
    -- its (now cancelled) subscription says, and the caller needs to tell the two
    -- apart to show the right message.
    WHEN r.account_status = 'archived'  THEN 'archived'
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

-- Verify:
-- SELECT platform.restaurant_status('<some-restaurant-uuid>');
-- SELECT account_status, count(*) FROM "Restaurant" GROUP BY 1;
