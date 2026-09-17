-- Migration 056: the report email ADDRESS BOOK (client item 9).
--
-- ============================================================================
-- WHAT THE CLIENT ASKED FOR
-- ============================================================================
-- "All reports or any reports can be emailed to chosen email IDs ... with an
-- option to choose/add both the email IDs and the send time."
--
-- The IDs are CHOSEN from a list the restaurant keeps, not typed into every
-- schedule. Migration 044 stored free-text addresses on the schedule itself,
-- under the reports permission, which made "who receives our takings" a
-- question nobody could answer in one place, and let anyone who can read a
-- report start a standing export of it to any address. This table is that
-- place:
--
--   * one row per address, per restaurant; at most 25 live (enforced by the
--     server), unique case-insensitively among the live ones;
--   * added and removed only by PERM_SETTINGS holders (the owner always);
--   * a REMOVED address is soft-deleted (removed_at) and re-checked at SEND
--     time, so taking it out of the book stops the very next email to it, even
--     from a schedule that still lists it;
--   * status 'suppressed' is the same stop, for an address the provider has
--     told us bounces (phase 2 fills it; the send-time check already reads it).
--
-- email_norm is GENERATED (lower(btrim(email))), so the uniqueness rule and
-- every lookup agree on what "the same address" means without trusting each
-- writer to normalise it.
--
-- ============================================================================
-- ORDER OF ROLLOUT
-- ============================================================================
-- The backend ships FIRST and issues these same statements itself, once at
-- boot, outside any transaction (InitReportEmailSchema; report_email_schema.ts
-- holds them), so on a runtime that connects as the table owner - production -
-- the table exists before this file is applied and this file only records it.
-- A runtime repointed to app_runtime (no DDL) must have this applied before
-- the feature can be used; until then every report-email write answers 503
-- "database update pending", and every existing report path is untouched.
--
-- Idempotent: safe to run twice, and safe after the runtime has run it. Every
-- statement below either creates something that is absent or reads the
-- catalogue and does nothing.
--
-- The two "Actions" rows are audit LABELS, never gates (026's rule): the
-- address book is gated by PERM_SETTINGS, sending by the accounting permission.

-- LOCK TIMEOUT, FIRST (051's rule). Nothing here touches a hot table, but the
-- file is applied by hand, possibly during service, and a lock wait is better
-- as a fast failure that can be re-run off-peak than as a queue. LOCAL, because
-- scripts/migrate.ts runs each file in its own begin/commit.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "ReportEmailRecipients" (
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
    CHECK (char_length(email) BETWEEN 3 AND 254 AND email !~ '\s' AND position('@' in email) > 1),
  CONSTRAINT report_email_recipients_label_len
    CHECK (label IS NULL OR char_length(label) <= 60),
  CONSTRAINT report_email_recipients_status
    CHECK (status IN ('active','suppressed'))
);

DO $$
BEGIN
  IF to_regclass('report_email_recipients_live_uniq') IS NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS report_email_recipients_live_uniq
      ON "ReportEmailRecipients" (res_id, email_norm) WHERE removed_at IS NULL;
  END IF;
END $$;

DO $$
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
END $$;

INSERT INTO "Actions" (id, action_name, action_desc, "group")
VALUES
  ('ffded2ef-a164-4acc-8c13-77f9c66e5c31', 'Report Email Recipients Changed',
   'Audit label for adding or removing an address in the report email address book, or sending it a test email. Granting it does nothing on its own — the address book is gated by the settings permission.',
   'Restaurant Specific'::"Action_groups"),
  ('f23fc314-7d12-41d7-af36-1cd57d8d3419', 'Report Emailed',
   'Audit label for emailing reports on demand. Granting it does nothing on its own — sending is gated by the accounting/reports permission.',
   'Restaurant Specific'::"Action_groups")
ON CONFLICT (id) DO NOTHING;
