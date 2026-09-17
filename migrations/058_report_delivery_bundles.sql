-- Migration 058: the report DELIVERY LOG (client item 9).
--
-- ============================================================================
-- WHAT CHANGES ON "ReportDeliveries"
-- ============================================================================
-- One row is still one occurrence - the at-most-once guard, the failure record
-- and the history. It now also says:
--
--   kind            'scheduled' (a schedule's own occurrence), 'manual' (its
--                   Run now, key 'manual:...', backfilled below) or 'adhoc'
--                   (Send now from the Reports screen: no schedule, key
--                   'adhoc:<client_request_id>', which is what makes a retried
--                   request a replay rather than a second email)
--   report_keys, formats, outlet_scope, day_close
--                   what was built, for which scope, on which kind of day
--   window_start_at / window_end_at
--                   the exact instants the reports covered, so a trading-day
--                   email can be compared with the drawer to the minute
--   recipients      the addresses an ad hoc send was addressed to (a scheduled
--                   one reads its schedule's list live, as 044 decided)
--   delivered_to (044), rejected_to, skipped_to
--                   ONE OUTCOME PER ADDRESS: accepted by the provider, refused
--                   by it for good, or not sent because the address had left
--                   the address book (or a daily limit was reached)
--   provider, requested_by, sending_at
--   maybe_duplicate a retry found this row mid-send after a crash, so an
--                   address may have received the report twice. SMTP can only
--                   promise "at least once"; the history says so.
--   message_meta    what the email's body is built from besides the files -
--                   the headline figures, the restaurant's name, the
--                   "Generated" time - fixed when the files are stored, so a
--                   retry sends the SAME message (and an HTTPS provider's
--                   idempotency key is never reused with a different body).
--
-- status gains 'sending', committed BEFORE the first message goes, so a crash
-- mid-send is visible and resumable. schedule_id becomes NULLABLE for ad hoc
-- rows, and that changes what 026's partial unique index protects: NULLs are
-- distinct, so ad hoc rows get their OWN unique index,
-- report_deliveries_adhoc_uniq (res_id, occurrence_key) WHERE schedule_id IS
-- NULL - and every ON CONFLICT that targets it must repeat that predicate, or
-- Postgres raises 42P10. An ad hoc row must also name 1 to 10 recipients;
-- coalesce(cardinality(...), 0), because cardinality(NULL) is NULL and a CHECK
-- that evaluates to NULL passes.
--
-- ============================================================================
-- TWO NEW TABLES
-- ============================================================================
-- "ReportDeliveryFiles"  the attachments, one row per file (a workbook, or a
--                        CSV per report), bodies as bytea so an XLSX survives
--                        byte for byte. Tenant data: RLS forced, 026's policy.
--                        Bodies are purged after 90 days (purged_at); the row
--                        stays as history.
-- "ReportSweepLease"     ONE row (id = 1): which process runs the scheduled
--                        sweep, until when, and the platform-wide count of
--                        report emails sent today. Not tenant data - no res_id -
--                        but a role that could delete the row, or set `until` or
--                        `sent_count`, would stop every restaurant's sweep or
--                        trip the platform cap. So: the runtime may only read
--                        and update it (002's default privileges would also
--                        hand it INSERT and DELETE); every grant to PUBLIC,
--                        `anon`, `authenticated` and `service_role` is revoked
--                        (Supabase's default privileges hand those three
--                        everything, through PostgREST — and RLS does not
--                        cover TRUNCATE); and RLS is FORCED, as on every public
--                        table, with policies only the table's owner (read from
--                        the catalogue) and app_runtime satisfy.
--
-- ============================================================================
-- ORDER OF ROLLOUT
-- ============================================================================
-- As 056 and 057: issued by the runtime at boot, recorded by this file. Every
-- ALTER is catalogue-guarded; the status CHECK is replaced only when it does
-- not already admit 'sending'. "ReportDeliveries" has no rows in production.

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ReportDeliveries' AND column_name = 'kind') THEN
    ALTER TABLE "ReportDeliveries" ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'scheduled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ReportDeliveries' AND column_name = 'report_keys') THEN
    ALTER TABLE "ReportDeliveries" ADD COLUMN IF NOT EXISTS report_keys text[] NOT NULL DEFAULT '{}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ReportDeliveries' AND column_name = 'formats') THEN
    ALTER TABLE "ReportDeliveries" ADD COLUMN IF NOT EXISTS formats text[] NOT NULL DEFAULT '{csv}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ReportDeliveries' AND column_name = 'outlet_scope') THEN
    ALTER TABLE "ReportDeliveries" ADD COLUMN IF NOT EXISTS outlet_scope text NOT NULL DEFAULT 'outlet';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ReportDeliveries' AND column_name = 'window_start_at') THEN
    ALTER TABLE "ReportDeliveries" ADD COLUMN IF NOT EXISTS window_start_at timestamptz;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ReportDeliveries' AND column_name = 'window_end_at') THEN
    ALTER TABLE "ReportDeliveries" ADD COLUMN IF NOT EXISTS window_end_at timestamptz;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ReportDeliveries' AND column_name = 'day_close') THEN
    ALTER TABLE "ReportDeliveries" ADD COLUMN IF NOT EXISTS day_close text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ReportDeliveries' AND column_name = 'recipients') THEN
    ALTER TABLE "ReportDeliveries" ADD COLUMN IF NOT EXISTS recipients text[];
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ReportDeliveries' AND column_name = 'rejected_to') THEN
    ALTER TABLE "ReportDeliveries" ADD COLUMN IF NOT EXISTS rejected_to text[];
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ReportDeliveries' AND column_name = 'skipped_to') THEN
    ALTER TABLE "ReportDeliveries" ADD COLUMN IF NOT EXISTS skipped_to text[];
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ReportDeliveries' AND column_name = 'provider') THEN
    ALTER TABLE "ReportDeliveries" ADD COLUMN IF NOT EXISTS provider text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ReportDeliveries' AND column_name = 'requested_by') THEN
    ALTER TABLE "ReportDeliveries" ADD COLUMN IF NOT EXISTS requested_by text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ReportDeliveries' AND column_name = 'sending_at') THEN
    ALTER TABLE "ReportDeliveries" ADD COLUMN IF NOT EXISTS sending_at timestamptz;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ReportDeliveries' AND column_name = 'maybe_duplicate') THEN
    ALTER TABLE "ReportDeliveries" ADD COLUMN IF NOT EXISTS maybe_duplicate boolean NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ReportDeliveries' AND column_name = 'message_meta') THEN
    ALTER TABLE "ReportDeliveries" ADD COLUMN IF NOT EXISTS message_meta jsonb;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ReportDeliveries' AND column_name = 'schedule_id' AND is_nullable = 'NO') THEN
    ALTER TABLE "ReportDeliveries" ALTER COLUMN schedule_id DROP NOT NULL;
  END IF;
END $$;

UPDATE "ReportDeliveries" SET kind = 'manual'
  WHERE kind = 'scheduled' AND occurrence_key LIKE 'manual:%';

DO $$
DECLARE c record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = '"ReportDeliveries"'::regclass AND conname = 'ReportDeliveries_status_check'
       AND pg_get_constraintdef(oid) LIKE '%sending%'
  ) THEN
    FOR c IN
      SELECT con.conname FROM pg_constraint con
       WHERE con.conrelid = '"ReportDeliveries"'::regclass AND con.contype = 'c'
         AND pg_get_constraintdef(con.oid) ~ '\mstatus\M'
         AND pg_get_constraintdef(con.oid) LIKE '%abandoned%'
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', 'ReportDeliveries', c.conname);
    END LOOP;
    ALTER TABLE "ReportDeliveries" ADD CONSTRAINT "ReportDeliveries_status_check"
      CHECK (status IN ('claimed','rendered','sending','delivered','failed','abandoned'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ReportDeliveries"'::regclass AND conname = 'ReportDeliveries_kind_check') THEN
    ALTER TABLE "ReportDeliveries" ADD CONSTRAINT "ReportDeliveries_kind_check"
      CHECK (kind IN ('scheduled','manual','adhoc'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ReportDeliveries"'::regclass AND conname = 'ReportDeliveries_adhoc_has_no_schedule') THEN
    ALTER TABLE "ReportDeliveries" ADD CONSTRAINT "ReportDeliveries_adhoc_has_no_schedule"
      CHECK ((kind = 'adhoc') = (schedule_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ReportDeliveries"'::regclass AND conname = 'ReportDeliveries_adhoc_key') THEN
    ALTER TABLE "ReportDeliveries" ADD CONSTRAINT "ReportDeliveries_adhoc_key"
      CHECK (kind <> 'adhoc' OR (occurrence_key LIKE 'adhoc:%' AND coalesce(cardinality(recipients), 0) BETWEEN 1 AND 10));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ReportDeliveries"'::regclass AND conname = 'ReportDeliveries_formats_check') THEN
    ALTER TABLE "ReportDeliveries" ADD CONSTRAINT "ReportDeliveries_formats_check"
      CHECK (cardinality(formats) BETWEEN 1 AND 2 AND formats <@ ARRAY['csv','xlsx']::text[]);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ReportDeliveries"'::regclass AND conname = 'ReportDeliveries_outlet_scope_check') THEN
    ALTER TABLE "ReportDeliveries" ADD CONSTRAINT "ReportDeliveries_outlet_scope_check"
      CHECK (outlet_scope IN ('outlet','all'));
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('report_deliveries_adhoc_uniq') IS NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS report_deliveries_adhoc_uniq
      ON "ReportDeliveries" (res_id, occurrence_key) WHERE schedule_id IS NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "ReportDeliveryFiles" (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  res_id      uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  delivery_id uuid NOT NULL REFERENCES "ReportDeliveries"(id) ON DELETE CASCADE,
  report_key  text NOT NULL,
  format      text NOT NULL CHECK (format IN ('csv','xlsx')),
  filename    text NOT NULL,
  mime        text NOT NULL,
  bytes       integer NOT NULL DEFAULT 0,
  rows        integer NOT NULL DEFAULT 0,
  truncated   boolean NOT NULL DEFAULT false,
  body        bytea,
  purged_at   timestamptz
);

DO $$
BEGIN
  IF to_regclass('report_delivery_files_delivery_idx') IS NULL THEN
    CREATE INDEX IF NOT EXISTS report_delivery_files_delivery_idx
      ON "ReportDeliveryFiles" (res_id, delivery_id);
  END IF;
  IF to_regclass('report_delivery_files_purge_idx') IS NULL THEN
    CREATE INDEX IF NOT EXISTS report_delivery_files_purge_idx
      ON "ReportDeliveryFiles" (res_id, created_at) WHERE body IS NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('"ReportDeliveryFiles"') AND relrowsecurity AND relforcerowsecurity) THEN
    ALTER TABLE "ReportDeliveryFiles" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "ReportDeliveryFiles" FORCE ROW LEVEL SECURITY;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ReportDeliveryFiles' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON "ReportDeliveryFiles"
      USING      (res_id::text = current_setting('app.res_id', true))
      WITH CHECK (res_id::text = current_setting('app.res_id', true));
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ReportDeliveryFiles" TO app_runtime;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "ReportSweepLease" (
  id           smallint PRIMARY KEY CHECK (id = 1),
  holder       text,
  host         text,
  until        timestamptz NOT NULL DEFAULT 'epoch',
  heartbeat_at timestamptz,
  mail_ready   boolean NOT NULL DEFAULT false,
  sent_day     date,
  sent_count   integer NOT NULL DEFAULT 0,
  purged_day   date
);

INSERT INTO "ReportSweepLease" (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  REVOKE ALL ON "ReportSweepLease" FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "ReportSweepLease" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "ReportSweepLease" FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON "ReportSweepLease" FROM service_role;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('"ReportSweepLease"') AND relrowsecurity AND relforcerowsecurity) THEN
    ALTER TABLE "ReportSweepLease" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "ReportSweepLease" FORCE ROW LEVEL SECURITY;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ReportSweepLease' AND policyname = 'sweep_lease_owner') THEN
    CREATE POLICY sweep_lease_owner ON "ReportSweepLease"
      USING      (pg_has_role(current_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = '"ReportSweepLease"'::regclass), 'USAGE'))
      WITH CHECK (pg_has_role(current_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = '"ReportSweepLease"'::regclass), 'USAGE'));
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, UPDATE ON "ReportSweepLease" TO app_runtime;
    REVOKE INSERT, DELETE, TRUNCATE ON "ReportSweepLease" FROM app_runtime;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ReportSweepLease' AND policyname = 'sweep_lease_runtime') THEN
      CREATE POLICY sweep_lease_runtime ON "ReportSweepLease" TO app_runtime
        USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $$;
