-- Migration 057: a scheduled report becomes a BUNDLE (client item 9).
--
-- ============================================================================
-- WHAT CHANGES ON "ReportSchedules"
-- ============================================================================
-- 026 scheduled ONE of three accounting reports (sales, pnl, gst) as ONE CSV
-- covering the previous CALENDAR day. The client asked for "all reports or any
-- reports", daily "at the end of each day at a specific time". So a schedule now
-- carries:
--
--   report_keys   text[]  which reports: the fifteen MIS documents and the
--                         accounting three (report_catalogue.ts). '{}' on a row
--                         written before this, which reads as [report_key].
--   formats       text[]  'xlsx' (one workbook: Summary, a sheet per report,
--                         Notes) and/or 'csv' (one file per report). '{csv}' on
--                         every existing row, which is what they produced.
--   window_mode   text    'calendar' - the previous calendar day, what 026 did
--                         and what every existing row keeps - or 'trading_day':
--                         the 24 hours ENDING AT THE SEND TIME, so a 02:00
--                         email carries the night's after-midnight bills with
--                         the evening they belong to (report_window.ts).
--   outlet_scope  text    'outlet', or 'all' - every outlet of the restaurant
--                         combined, which only an admin or manager may choose.
--
-- report_key STAYS, and a bundle row stores 'bundle' in it. Code reads
-- report_keys first and falls back to [report_key], so a row written by 2.0.1
-- reads exactly as it did.
--
-- ============================================================================
-- THE CHECKS
-- ============================================================================
-- * report_key / format are WIDENED, dropped BY DEFINITION first (044's rule -
--   026 wrote them inline, so their names are whatever Postgres chose). The
--   drop touches only the allow-list CHECK: 026's period-shape tripwire
--   (payroll / balance_sheet only monthly) mentions report_key too and must
--   survive, so it is excluded by what it says, as are the new checks below.
--   PDF is NOT admitted: nothing renders it yet, and 026's rule holds -
--   nothing is storable before something implements it.
-- * report_keys / formats are allow-lists with cardinality() bounds.
--   cardinality(), never array_length(): array_length('{}', 1) is NULL and a
--   CHECK that evaluates to NULL PASSES (044 found this against a real
--   Postgres).
-- * a trading day is daily only, and never carries GST or P&L - statutory,
--   month-based documents that must stay on calendar days.
-- * at most ten recipients on one schedule.
-- * a 'bundle' row names at least two reports.
--
-- ============================================================================
-- ORDER OF ROLLOUT
-- ============================================================================
-- As 056: the runtime issues these statements at boot, so on production this
-- file records what already exists. Every ALTER sits behind a catalogue check,
-- because ADD COLUMN IF NOT EXISTS takes ACCESS EXCLUSIVE before it looks, and
-- a constraint is replaced only when its new form is absent. "ReportSchedules"
-- has no rows in production today; the checks validate instantly.
--
-- Installed 2.0.1 apps are safe against it: they create {name, report_key,
-- frequency, hour_local, minute_local}, which the server stores as a
-- calendar-day CSV schedule of that one report, exactly as before.

SET LOCAL lock_timeout = '5s';

DO $$
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
END $$;

DO $$
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
         AND pg_get_constraintdef(con.oid) ~ '\mreport_key\M'
         AND pg_get_constraintdef(con.oid) !~ 'payroll'
         AND pg_get_constraintdef(con.oid) !~ 'report_keys'
         AND pg_get_constraintdef(con.oid) !~ 'window_mode'
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', 'ReportSchedules', c.conname);
    END LOOP;
    ALTER TABLE "ReportSchedules" ADD CONSTRAINT "ReportSchedules_report_key_check"
      CHECK (report_key IN ('item_wise','discount','void_kot','bill_edit','sales_summary','order_summary','executive_summary','cover_size_summary','settlement_summary','nc_summary','service_charge_deny','group_summary','variation_summary','tip_summary','counter_summary','sales','gst','pnl','bundle'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = '"ReportSchedules"'::regclass AND conname = 'ReportSchedules_format_check'
       AND pg_get_constraintdef(oid) LIKE '%xlsx%'
  ) THEN
    FOR c IN
      SELECT con.conname FROM pg_constraint con
       WHERE con.conrelid = '"ReportSchedules"'::regclass AND con.contype = 'c'
         AND pg_get_constraintdef(con.oid) ~ '\mformat\M'
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', 'ReportSchedules', c.conname);
    END LOOP;
    ALTER TABLE "ReportSchedules" ADD CONSTRAINT "ReportSchedules_format_check"
      CHECK (format IN ('csv','xlsx'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ReportSchedules"'::regclass AND conname = 'ReportSchedules_report_keys_check') THEN
    ALTER TABLE "ReportSchedules" ADD CONSTRAINT "ReportSchedules_report_keys_check"
      CHECK (report_keys <@ ARRAY['item_wise','discount','void_kot','bill_edit','sales_summary','order_summary','executive_summary','cover_size_summary','settlement_summary','nc_summary','service_charge_deny','group_summary','variation_summary','tip_summary','counter_summary','sales','gst','pnl']::text[] AND cardinality(report_keys) <= 18);
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
END $$;
