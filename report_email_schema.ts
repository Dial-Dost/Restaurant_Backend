/**
 * MIGRATIONS 056, 057 AND 058 — statement for statement, as the runtime issues
 * them.
 *
 * THE HOUSE PATTERN (048, 050, 053): production connects as the table owner,
 * so the backend creates what it needs ONCE at boot, before the listener,
 * outside any request transaction (InitReportEmailSchema), and the files in
 * migrations/ are applied by hand later and only record it. A runtime
 * repointed to app_runtime (no DDL) needs the files applied first; until then
 * every new write answers 503 "database update pending" and every existing
 * path does exactly what it did on 2.0.1.
 *
 * PURE CONSTANTS, no imports, so jest-tests/report_email_migrations.test.ts can
 * hold each migration file to these exact statements without loading the data
 * layer, and so the local-Postgres proof runs the same text the server runs.
 *
 * EVERY STATEMENT IS SAFE TO RE-RUN WITHOUT TAKING A LOCK IT DOES NOT NEED.
 * `ALTER TABLE … ADD COLUMN IF NOT EXISTS` takes ACCESS EXCLUSIVE before it
 * looks, so every ALTER on an existing table sits inside a DO block that asks
 * the catalogue first; a constraint is replaced only when its new form is not
 * already there. Re-running any file after the runtime has made the schema
 * reads the catalogue and changes nothing.
 */

/** Audit LABELS (never gates — see 026's note). */
export const REPORT_EMAIL_RECIPIENTS_ACTION_ID = "ffded2ef-a164-4acc-8c13-77f9c66e5c31";
export const REPORT_EMAILED_ACTION_ID = "f23fc314-7d12-41d7-af36-1cd57d8d3419";

/** The report keys migration 057's CHECKs admit — report_catalogue.ts's eighteen. */
export const SCHEDULABLE_REPORT_KEYS_SQL =
  "'item_wise','discount','void_kot','bill_edit','sales_summary','order_summary',"
  + "'executive_summary','cover_size_summary','settlement_summary','nc_summary',"
  + "'service_charge_deny','group_summary','variation_summary','tip_summary','counter_summary',"
  + "'sales','gst','pnl'";

// ---------------------------------------------------------------------------
// 056 — the restaurant's address book
// ---------------------------------------------------------------------------
export const REPORT_EMAIL_DDL_056: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "ReportEmailRecipients" (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  res_id            uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  email             text NOT NULL,
  email_norm        text GENERATED ALWAYS AS (lower(btrim(email))) STORED,
  label             text,
  status            text NOT NULL DEFAULT 'active',
  suppressed_reason text,
  created_by        text,
  removed_at        timestamptz,
  removed_by        text,
  CONSTRAINT report_email_recipients_email_shape
    CHECK (char_length(email) BETWEEN 3 AND 254 AND email !~ '\\s' AND position('@' in email) > 1),
  CONSTRAINT report_email_recipients_label_len
    CHECK (label IS NULL OR char_length(label) <= 60),
  CONSTRAINT report_email_recipients_status
    CHECK (status IN ('active','suppressed'))
)`,
  // CREATE INDEX IF NOT EXISTS takes its SHARE lock BEFORE it looks (053's
  // note), so every index is created behind a catalogue check instead.
  `DO $$
BEGIN
  IF to_regclass('report_email_recipients_live_uniq') IS NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS report_email_recipients_live_uniq
      ON "ReportEmailRecipients" (res_id, email_norm) WHERE removed_at IS NULL;
  END IF;
END $$`,
  `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('"ReportEmailRecipients"') AND relrowsecurity AND relforcerowsecurity) THEN
    ALTER TABLE "ReportEmailRecipients" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "ReportEmailRecipients" FORCE ROW LEVEL SECURITY;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ReportEmailRecipients' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON "ReportEmailRecipients"
      USING      (res_id::text = current_setting('app.res_id', true))
      WITH CHECK (res_id::text = current_setting('app.res_id', true));
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ReportEmailRecipients" TO app_runtime;
  END IF;
END $$`,
  `INSERT INTO "Actions" (id, action_name, action_desc, "group")
VALUES
  ('${REPORT_EMAIL_RECIPIENTS_ACTION_ID}', 'Report Email Recipients Changed',
   'Audit label for adding or removing an address in the report email address book, or sending it a test email. Granting it does nothing on its own — the address book is gated by the settings permission.',
   'Restaurant Specific'::"Action_groups"),
  ('${REPORT_EMAILED_ACTION_ID}', 'Report Emailed',
   'Audit label for emailing reports on demand. Granting it does nothing on its own — sending is gated by the accounting/reports permission.',
   'Restaurant Specific'::"Action_groups")
ON CONFLICT (id) DO NOTHING`,
];

// ---------------------------------------------------------------------------
// 057 — a schedule is a BUNDLE of reports, in formats, on a kind of day
// ---------------------------------------------------------------------------
export const REPORT_EMAIL_DDL_057: readonly string[] = [
  `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ReportSchedules' AND column_name = 'report_keys') THEN
    ALTER TABLE "ReportSchedules" ADD COLUMN IF NOT EXISTS report_keys text[] NOT NULL DEFAULT '{}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ReportSchedules' AND column_name = 'formats') THEN
    ALTER TABLE "ReportSchedules" ADD COLUMN IF NOT EXISTS formats text[] NOT NULL DEFAULT '{csv}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ReportSchedules' AND column_name = 'window_mode') THEN
    ALTER TABLE "ReportSchedules" ADD COLUMN IF NOT EXISTS window_mode text NOT NULL DEFAULT 'calendar';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ReportSchedules' AND column_name = 'outlet_scope') THEN
    ALTER TABLE "ReportSchedules" ADD COLUMN IF NOT EXISTS outlet_scope text NOT NULL DEFAULT 'outlet';
  END IF;
END $$`,
  `DO $$
DECLARE c record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = '"ReportSchedules"'::regclass AND conname = 'ReportSchedules_report_key_check'
       AND pg_get_constraintdef(oid) LIKE '%item_wise%'
  ) THEN
    FOR c IN
      SELECT con.conname FROM pg_constraint con
       WHERE con.conrelid = '"ReportSchedules"'::regclass AND con.contype = 'c'
         AND pg_get_constraintdef(con.oid) ~ '\\mreport_key\\M'
         AND pg_get_constraintdef(con.oid) !~ 'payroll'
         AND pg_get_constraintdef(con.oid) !~ 'report_keys'
         AND pg_get_constraintdef(con.oid) !~ 'window_mode'
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', 'ReportSchedules', c.conname);
    END LOOP;
    ALTER TABLE "ReportSchedules" ADD CONSTRAINT "ReportSchedules_report_key_check"
      CHECK (report_key IN (${SCHEDULABLE_REPORT_KEYS_SQL},'bundle'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = '"ReportSchedules"'::regclass AND conname = 'ReportSchedules_format_check'
       AND pg_get_constraintdef(oid) LIKE '%xlsx%'
  ) THEN
    FOR c IN
      SELECT con.conname FROM pg_constraint con
       WHERE con.conrelid = '"ReportSchedules"'::regclass AND con.contype = 'c'
         AND pg_get_constraintdef(con.oid) ~ '\\mformat\\M'
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', 'ReportSchedules', c.conname);
    END LOOP;
    ALTER TABLE "ReportSchedules" ADD CONSTRAINT "ReportSchedules_format_check"
      CHECK (format IN ('csv','xlsx'));
  END IF;
END $$`,
  `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ReportSchedules"'::regclass AND conname = 'ReportSchedules_report_keys_check') THEN
    ALTER TABLE "ReportSchedules" ADD CONSTRAINT "ReportSchedules_report_keys_check"
      CHECK (report_keys <@ ARRAY[${SCHEDULABLE_REPORT_KEYS_SQL}]::text[] AND cardinality(report_keys) <= 18);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ReportSchedules"'::regclass AND conname = 'ReportSchedules_bundle_keys') THEN
    ALTER TABLE "ReportSchedules" ADD CONSTRAINT "ReportSchedules_bundle_keys"
      CHECK (report_key <> 'bundle' OR cardinality(report_keys) >= 2);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ReportSchedules"'::regclass AND conname = 'ReportSchedules_formats_check') THEN
    ALTER TABLE "ReportSchedules" ADD CONSTRAINT "ReportSchedules_formats_check"
      CHECK (cardinality(formats) BETWEEN 1 AND 2 AND formats <@ ARRAY['csv','xlsx']::text[]);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ReportSchedules"'::regclass AND conname = 'ReportSchedules_window_mode_check') THEN
    ALTER TABLE "ReportSchedules" ADD CONSTRAINT "ReportSchedules_window_mode_check"
      CHECK (window_mode IN ('calendar','trading_day'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ReportSchedules"'::regclass AND conname = 'ReportSchedules_trading_day_daily') THEN
    ALTER TABLE "ReportSchedules" ADD CONSTRAINT "ReportSchedules_trading_day_daily"
      CHECK (window_mode <> 'trading_day' OR frequency = 'daily');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ReportSchedules"'::regclass AND conname = 'ReportSchedules_trading_day_keys') THEN
    ALTER TABLE "ReportSchedules" ADD CONSTRAINT "ReportSchedules_trading_day_keys"
      CHECK (window_mode <> 'trading_day' OR (NOT (report_keys && ARRAY['gst','pnl']::text[]) AND report_key NOT IN ('gst','pnl')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ReportSchedules"'::regclass AND conname = 'ReportSchedules_outlet_scope_check') THEN
    ALTER TABLE "ReportSchedules" ADD CONSTRAINT "ReportSchedules_outlet_scope_check"
      CHECK (outlet_scope IN ('outlet','all'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ReportSchedules"'::regclass AND conname = 'ReportSchedules_recipients_cap') THEN
    ALTER TABLE "ReportSchedules" ADD CONSTRAINT "ReportSchedules_recipients_cap"
      CHECK (cardinality(recipients) <= 10);
  END IF;
END $$`,
];

// ---------------------------------------------------------------------------
// 058 — the delivery log: kinds, windows, files, per-address outcomes, a lease
// ---------------------------------------------------------------------------
export const REPORT_EMAIL_DDL_058: readonly string[] = [
  `DO $$
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
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ReportDeliveries' AND column_name = 'schedule_id' AND is_nullable = 'NO') THEN
    ALTER TABLE "ReportDeliveries" ALTER COLUMN schedule_id DROP NOT NULL;
  END IF;
END $$`,
  `UPDATE "ReportDeliveries" SET kind = 'manual'
  WHERE kind = 'scheduled' AND occurrence_key LIKE 'manual:%'`,
  `DO $$
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
         AND pg_get_constraintdef(con.oid) ~ '\\mstatus\\M'
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
END $$`,
  `DO $$
BEGIN
  IF to_regclass('report_deliveries_adhoc_uniq') IS NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS report_deliveries_adhoc_uniq
      ON "ReportDeliveries" (res_id, occurrence_key) WHERE schedule_id IS NULL;
  END IF;
END $$`,
  `CREATE TABLE IF NOT EXISTS "ReportDeliveryFiles" (
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
)`,
  `DO $$
BEGIN
  IF to_regclass('report_delivery_files_delivery_idx') IS NULL THEN
    CREATE INDEX IF NOT EXISTS report_delivery_files_delivery_idx
      ON "ReportDeliveryFiles" (res_id, delivery_id);
  END IF;
  IF to_regclass('report_delivery_files_purge_idx') IS NULL THEN
    CREATE INDEX IF NOT EXISTS report_delivery_files_purge_idx
      ON "ReportDeliveryFiles" (res_id, created_at) WHERE body IS NOT NULL;
  END IF;
END $$`,
  `DO $$
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
END $$`,
  `CREATE TABLE IF NOT EXISTS "ReportSweepLease" (
  id           smallint PRIMARY KEY CHECK (id = 1),
  holder       text,
  host         text,
  until        timestamptz NOT NULL DEFAULT 'epoch',
  heartbeat_at timestamptz,
  mail_ready   boolean NOT NULL DEFAULT false,
  sent_day     date,
  sent_count   integer NOT NULL DEFAULT 0,
  purged_day   date
)`,
  `INSERT INTO "ReportSweepLease" (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
  // 002's default privileges would hand the runtime INSERT and DELETE too. The
  // one row is made above; a runtime that could delete it would switch the
  // scheduled sweep off for every restaurant without a trace.
  `DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, UPDATE ON "ReportSweepLease" TO app_runtime;
    REVOKE INSERT, DELETE, TRUNCATE ON "ReportSweepLease" FROM app_runtime;
  END IF;
END $$`,
];

/** What the boot probe asks, one boolean per migration. */
export const REPORT_EMAIL_SCHEMA_PROBE = `select
  to_regclass('"ReportEmailRecipients"') is not null as m056,
  (exists (select 1 from information_schema.columns
            where table_schema = current_schema() and table_name = 'ReportSchedules' and column_name = 'outlet_scope')
   and exists (select 1 from pg_constraint where conname = 'ReportSchedules_recipients_cap')) as m057,
  (to_regclass('"ReportDeliveryFiles"') is not null
   and to_regclass('"ReportSweepLease"') is not null
   and exists (select 1 from information_schema.columns
                where table_schema = current_schema() and table_name = 'ReportDeliveries' and column_name = 'maybe_duplicate')
   and exists (select 1 from pg_constraint where conname = 'ReportDeliveries_outlet_scope_check')) as m058`;
