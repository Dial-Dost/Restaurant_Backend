-- Migration 026: scheduled report delivery.
--
-- DATES ARE THE RESTAURANT'S CALENDAR DAYS, computed in TypeScript from the
-- tenant's IANA zone and stored as bare `date` / text day keys. Same rule and
-- same reasoning as migration 024: this server runs in UTC, so a Postgres-side
-- current_date is the wrong day through the tenant's late shift.
--
-- text + CHECK rather than Postgres enums, matching the house convention for
-- workflow state (024's note applies verbatim).
--
-- report_key is DELIBERATELY narrow. Only three reports are eligible, and all
-- three take (restaurantId, fromIso?, toIso?) positionally and scope through
-- normalizeReportRange in the tenant zone. GetPayroll takes a YYYY-MM period and
-- throws on anything else (database_supabase.ts:7858); GetBalanceSheet takes a
-- single as-of date (:13896) and has no range at all — neither has a meaningful
-- daily or weekly period, so they are excluded rather than left to silently
-- mis-scope. report_schedules_period_shape below is the tripwire that keeps them
-- excluded even after someone widens report_key.
--
-- format is likewise narrowed to what report_render.ts actually implements. A
-- combination that cannot be rendered must not be storable.

-- --------------------------------------------------------------------------
-- "Restaurant".timezone is READ by the reporting path but created by no
-- migration: it exists only as lazy DDL inside ensureBrandingColumns()
-- (database_supabase.ts:21062), which is NOT wrapped in ensureLazyTable and so
-- throws outright under app_runtime — migration 002 grants USAGE but not CREATE
-- on the public schema (002:28). resolveRestaurantContext's outlet-bound branch
-- selects r.timezone (:1585), so on a freshly-migrated least-privilege database
-- that read raises 42703 for every caller, not just the sweep. Declaring the
-- column here is what makes a fresh deployment serve reports at all. Idempotent
-- no-op wherever the lazy path already ran.
--
-- (service_charge, its neighbour in ensureBrandingColumns, needs no such
-- statement: it is already in 000_base_schema.sql:326.)
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS timezone text DEFAULT 'Asia/Kolkata';

-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ReportSchedules" (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  res_id       uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  -- NOT NULL and a real FK, deliberately. Every report function scopes to the
  -- ambient context's outlet, and a context resolved without a UUID outlet falls
  -- into resolveRestaurantContext's default branch, which picks the OLDEST outlet
  -- (`order by o.created_at asc nulls last limit 1`, database_supabase.ts:1639)
  -- and would report one branch's numbers as the whole business.
  outlet_id    uuid NOT NULL REFERENCES "Outlets"(id) ON UPDATE CASCADE ON DELETE CASCADE,

  name         text NOT NULL,
  report_key   text NOT NULL CHECK (report_key IN ('sales','pnl','gst')),
  frequency    text NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily','weekly','monthly')),
  hour_local   smallint NOT NULL DEFAULT 8 CHECK (hour_local   BETWEEN 0 AND 23),
  minute_local smallint NOT NULL DEFAULT 0 CHECK (minute_local BETWEEN 0 AND 59),
  -- weekly only. 0 = Sunday, matching weekdayOfDayKey (database_supabase.ts:13152).
  weekday      smallint CHECK (weekday BETWEEN 0 AND 6),
  -- monthly only. Capped at 28 so "the 31st" can never silently skip February.
  day_of_month smallint CHECK (day_of_month BETWEEN 1 AND 28),

  -- One channel ships here. Widening this CHECK is a later migration's job,
  -- together with the sender it enables — no storable state without an
  -- implementation behind it.
  channel      text NOT NULL DEFAULT 'inbox' CHECK (channel IN ('inbox')),
  format       text NOT NULL DEFAULT 'csv'   CHECK (format  IN ('csv')),
  enabled      boolean NOT NULL DEFAULT true,
  -- Tenant-facing "delete" is an ARCHIVE, because "ReportDeliveries" carries the
  -- at-most-once guard and the artifact history and those rows are never
  -- destroyed (the FK below refuses it outright). An archived schedule is hidden
  -- from the list and skipped by the sweep; its history stays readable.
  archived_at  timestamptz,

  -- Display only. NEVER the dedup guard — that is the unique index below.
  last_occurrence_key  text,
  last_status          text,
  last_error           text,
  last_run_at          timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,

  created_by   text,
  updated_by   text,

  CONSTRAINT report_schedules_weekly_shape
    CHECK (frequency <> 'weekly'  OR weekday      IS NOT NULL),
  CONSTRAINT report_schedules_monthly_shape
    CHECK (frequency <> 'monthly' OR day_of_month IS NOT NULL),
  -- Vacuous TODAY (report_key admits neither value) and that is the point: it is
  -- a tripwire for whoever widens report_key later. A payroll period is a whole
  -- calendar month by GetPayroll's own signature, and a balance sheet is a
  -- point-in-time snapshot whose only scheduled form that reconciles with the
  -- monthly P&L is a month-end one. Admitting either at daily or weekly would
  -- silently mis-scope it, so the constraint has to be dropped deliberately
  -- rather than forgotten.
  CONSTRAINT report_schedules_period_shape
    CHECK (report_key NOT IN ('payroll','balance_sheet') OR frequency = 'monthly')
);

-- The sweep's only read of this table: every live schedule for one tenant.
CREATE INDEX IF NOT EXISTS report_schedules_tenant_idx
  ON "ReportSchedules" (res_id, enabled);

-- One row per (schedule, occurrence). THIS TABLE IS the at-most-once guarantee,
-- the failure record and the artifact store, in that order of importance.
CREATE TABLE IF NOT EXISTS "ReportDeliveries" (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  res_id        uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  outlet_id     uuid NOT NULL REFERENCES "Outlets"(id)    ON UPDATE CASCADE ON DELETE CASCADE,
  -- NOT CASCADE: deleting a schedule would take its dedup rows with it, and a
  -- re-created schedule could then re-send an occurrence that already went out.
  -- "ReportSchedules".archived_at is the supported way to retire one, and this
  -- constraint is what stops that rule being lost by someone who only reads the
  -- routes: a bare DELETE on a schedule with history is refused.
  --
  -- NO ACTION rather than RESTRICT, deliberately. RESTRICT cannot be deferred, so
  -- it fires the instant the cascade from a deleted "Outlets" row (DeleteOutlet,
  -- database_supabase.ts:18423) removes this schedule — aborting an outlet
  -- deletion that has nothing to do with reports. NO ACTION is checked after the
  -- statement's other referential actions have run, by which point outlet_id's
  -- own CASCADE has already removed the matching delivery rows (every delivery is
  -- stamped with its schedule's outlet), so that path still works. A hand-written
  -- DELETE on a schedule alone still fails, which is the case worth guarding.
  schedule_id   uuid NOT NULL REFERENCES "ReportSchedules"(id) ON DELETE NO ACTION,

  -- The tenant-local calendar day the occurrence was due, 'YYYY-MM-DD'. A manual
  -- "run now" writes 'manual:YYYY-MM-DDTHH:MM' instead (the tenant-local minute,
  -- manualOccurrenceKey in report_schedules.ts), so it neither collides with nor
  -- consumes the scheduled occurrence AND is still deduplicated by the index
  -- below. NULL deduplicates NOTHING here, because that index is PARTIAL — it is
  -- left nullable only so a row written before that key existed stays valid.
  occurrence_key text,
  fire_at        timestamptz NOT NULL,
  period_from    date NOT NULL,
  period_to      date NOT NULL,
  -- Denormalised so a wrong-zone regression is visible in history, not invisible.
  timezone       text NOT NULL,

  status         text NOT NULL DEFAULT 'claimed'
                   CHECK (status IN ('claimed','rendered','delivered','failed','abandoned')),
  attempts       integer NOT NULL DEFAULT 0,
  -- NEVER NULL, and set to a LEASE (now + REPORT_ATTEMPT_LEASE_MIN) every time an
  -- attempt is taken — not to the retry backoff. A row another replica is
  -- mid-render on must not be eligible for the retry scan; leaving this NULL, or
  -- setting it to a 5-minute backoff at claim time, is exactly how the same
  -- occurrence gets rendered and delivered twice.
  next_attempt_at timestamptz NOT NULL,
  claimed_by     text,          -- diagnostic only; no guard reads it

  channel        text,
  artifact_name  text,
  artifact_mime  text,
  artifact_bytes integer,
  artifact_body  text,
  artifact_truncated boolean NOT NULL DEFAULT false,
  error          text,
  delivered_at   timestamptz
);

-- THE dedup guard, for scheduled AND manual occurrences alike. PARTIAL because
-- occurrence_key is nullable, which also means a NULL key is NOT deduplicated.
-- The matching ON CONFLICT clause MUST repeat this predicate: Postgres will not
-- infer a partial index otherwise, and the omission raises 42P10 on every
-- insert. platform/routes.ts:153-156 records that exact production failure — it
-- meant no tenant was ever invoiced and none moved off 'active'.
CREATE UNIQUE INDEX IF NOT EXISTS report_deliveries_occurrence_uniq
  ON "ReportDeliveries" (schedule_id, occurrence_key)
  WHERE occurrence_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS report_deliveries_history_idx
  ON "ReportDeliveries" (res_id, schedule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS report_deliveries_retry_idx
  ON "ReportDeliveries" (res_id, status, next_attempt_at);

-- Fail-closed from the moment they exist, in migration 003's exact policy form.
-- Migration 003 applies RLS by a dynamic loop over information_schema.columns
-- (003:30-45), which does not retro-cover tables created later, so this is not
-- redundant.
ALTER TABLE "ReportSchedules"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReportSchedules"  FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ReportSchedules";
CREATE POLICY tenant_isolation ON "ReportSchedules"
  USING      (res_id::text = current_setting('app.res_id', true))
  WITH CHECK (res_id::text = current_setting('app.res_id', true));

ALTER TABLE "ReportDeliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReportDeliveries" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ReportDeliveries";
CREATE POLICY tenant_isolation ON "ReportDeliveries"
  USING      (res_id::text = current_setting('app.res_id', true))
  WITH CHECK (res_id::text = current_setting('app.res_id', true));

-- 002's ALTER DEFAULT PRIVILEGES only covers tables created by the role that set
-- it. Spell it out so a migration run under a different owner still leaves the
-- runtime able to read its own rows. (Migration 024's exact guard.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ReportSchedules"  TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ReportDeliveries" TO app_runtime;
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- Audit LABEL, not a gate. Audit titles render from "Actions".action_name, so
-- without this row every schedule edit would appear in History under whatever
-- action id we borrowed. Every /reports/schedules route is gated on the EXISTING
-- accounting permission df75119b-e5f1-4f38-aba5-78a1cf182f56 — the same id that
-- already guards every /reports/* and /analytics/* route (index.ts:6856). Gating
-- on a brand-new id would strip the feature from every role that exists today,
-- because no role has been granted an id that did not exist until now. Logging
-- must never become a permission gate. (Migration 025's rule, verbatim.)
INSERT INTO "Actions" (id, action_name, action_desc, "group")
VALUES (
  '9e2f47a1-05b3-4c8d-8f6a-71d40b9c2e58',
  'Scheduled Report Changed',
  'Audit label for creating, editing, enabling, disabling or archiving a scheduled report. Granting it does nothing on its own — scheduled reports are gated by the accounting/reports permission.',
  'Restaurant Specific'::"Action_groups"
)
ON CONFLICT (id) DO NOTHING;
