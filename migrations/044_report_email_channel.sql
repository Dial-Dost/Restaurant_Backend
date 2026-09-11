-- Migration 044: the email channel for scheduled reports (V3 "Automated Email
-- Reports").
--
-- WHAT 026 LEFT HERE ON PURPOSE. That migration wrote:
--
--     channel text NOT NULL DEFAULT 'inbox' CHECK (channel IN ('inbox'))
--     -- One channel ships here. Widening this CHECK is a later migration's job,
--     -- together with the sender it enables — no storable state without an
--     -- implementation behind it.
--
-- This is that later migration, and the sender lands with it (mailer.ts, wired
-- into report_schedules.ts's sweep). The rule is kept: after this runs, 'email'
-- is storable BECAUSE something sends it, not in the hope that something will.
--
-- --------------------------------------------------------------------------
-- WHY RECIPIENTS ARE A COLUMN AND NOT "the owner's login email"
-- --------------------------------------------------------------------------
-- The requirement is "deliver reports via email to the owners/admins", plural,
-- and in practice the list is not the staff list: a restaurant sends its GST
-- report to its accountant, who has no login here at all, and its daily sales to
-- two partners of whom only one is an admin. Deriving the list from Employees
-- would make the common case impossible and would silently change who receives
-- money figures whenever somebody's role is edited — which is precisely the kind
-- of invisible coupling role_scope.ts exists to document.
--
-- text[] rather than a child table: this is a short, ordered, wholly-replaced
-- list with no identity of its own and nothing ever joins to it. A child table
-- would buy referential integrity over strings that reference nothing.
--
-- --------------------------------------------------------------------------
-- THE CHECK IS THE POINT
-- --------------------------------------------------------------------------
-- An email schedule with no recipients is not a schedule; it is a sweep that
-- runs every morning, renders a report, has nowhere to send it, fails, retries
-- five times and auto-disables itself — with the tenant seeing only a schedule
-- that stopped working. Refusing it at write time is the difference between a
-- form error the person can fix and a silent daily failure.
--
-- The constraint is written so an INBOX schedule is untouched: recipients may be
-- NULL or empty for 'inbox', because nothing reads them there.

ALTER TABLE "ReportSchedules"
  ADD COLUMN IF NOT EXISTS recipients text[] NOT NULL DEFAULT '{}';

-- --------------------------------------------------------------------------
-- WIDEN THE CHANNEL — dropped BY DEFINITION, not by guessed name.
-- --------------------------------------------------------------------------
-- 026 wrote the old constraint INLINE, so its name is whatever Postgres chose
-- ("ReportSchedules_channel_check" today, and nothing in the schema promises
-- that). A plain DROP CONSTRAINT IF EXISTS on a guessed name is the trap this
-- file is already documenting twice over: if the guess is wrong the drop does
-- nothing, the ADD below succeeds under its own name, and the table ends up with
-- TWO channel CHECKs — the old narrow one still refusing 'email'. The migration
-- reports success and the feature does not work, with nothing in the logs.
--
-- So every CHECK on this table whose definition mentions `channel` is dropped by
-- looking it up, and the new one is added afterwards. Re-running finds only the
-- new constraint, drops it, and adds it back: idempotent without depending on a
-- name anyone has to remember.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE rel.relname = 'ReportSchedules'
       AND ns.nspname = current_schema()
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%channel%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', 'ReportSchedules', c.conname);
  END LOOP;
END $$;

ALTER TABLE "ReportSchedules"
  ADD CONSTRAINT "ReportSchedules_channel_check"
  CHECK (channel IN ('inbox','email'));

-- An email schedule must have somewhere to go. NOT VALID is deliberately NOT
-- used: there is no pre-existing 'email' row to grandfather (the old CHECK made
-- one impossible), so the table validates instantly and a future bad row is
-- refused rather than accumulated.
--
-- cardinality(), NOT array_length(). This was written as
--
--     CHECK (channel <> 'email' OR array_length(recipients, 1) >= 1)
--
-- which reads correctly and DOES NOT WORK, proven against a real Postgres before
-- it shipped: array_length('{}', 1) is NULL rather than 0, so the expression
-- evaluates to `false OR NULL` = NULL — and a CHECK that evaluates to NULL
-- PASSES. The constraint accepted exactly the row it exists to refuse, while
-- looking right in the schema dump. cardinality() returns 0 for an empty array
-- and the whole three-valued problem disappears.
ALTER TABLE "ReportSchedules" DROP CONSTRAINT IF EXISTS "ReportSchedules_email_needs_recipients";
ALTER TABLE "ReportSchedules"
  ADD CONSTRAINT "ReportSchedules_email_needs_recipients"
  CHECK (channel <> 'email' OR cardinality(recipients) >= 1);

-- --------------------------------------------------------------------------
-- WHERE IT WENT, recorded per delivery.
-- --------------------------------------------------------------------------
-- The inbox channel needs no such record: the notification IS the evidence, and
-- it is in the tenant's own bell. An email leaves no trace inside this system at
-- all, so "did the 1st-of-the-month GST report actually go to the accountant, and
-- to which address" becomes unanswerable the moment somebody edits the schedule.
-- Stamped at SEND time from the addresses the transport ACCEPTED, never copied
-- from the schedule at render time, so an edited schedule cannot rewrite history.
ALTER TABLE "ReportDeliveries"
  ADD COLUMN IF NOT EXISTS delivered_to text[];

-- "ReportDeliveries".channel ALREADY EXISTS (026:149) as a bare nullable text
-- with no CHECK, and this is worth spelling out because the obvious statement
-- here is a TRAP: writing
--
--     ALTER TABLE "ReportDeliveries"
--       ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'inbox'
--         CHECK (channel IN ('inbox','email'));
--
-- reads as "declare the column with its constraint" and does NOTHING AT ALL —
-- IF NOT EXISTS makes the whole statement a no-op once the column is there, so
-- the CHECK is silently never created and the migration reports success. This
-- codebase has already been bitten by a gate that passed while doing nothing
-- (check-migrations exiting 0 on pending migrations); a constraint that was
-- never created is the same failure in the schema.
--
-- So the constraint is added on its own, by name, and NULL IS ALLOWED: rows
-- written before 026 stamped a channel carry NULL, and rewriting delivery
-- history to satisfy a new constraint would be falsifying a ledger.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE rel.relname = 'ReportDeliveries'
       AND ns.nspname = current_schema()
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%channel%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', 'ReportDeliveries', c.conname);
  END LOOP;
END $$;

ALTER TABLE "ReportDeliveries"
  ADD CONSTRAINT "ReportDeliveries_channel_check"
  CHECK (channel IS NULL OR channel IN ('inbox','email'));
