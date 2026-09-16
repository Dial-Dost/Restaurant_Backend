-- 049: the Reports section's time-slot presets (Lunch, Dinner, ...).
--
-- WHAT THE CLIENT ASKED FOR
-- -------------------------
-- "In the reports section there should be an option to structure the reports
-- section wise — select time for hour-wise reports or session-wise reports. The
-- superadmin should have an option to select what time slots he wants to see
-- reports of. Preset time slots for 2 sessions: lunch 12pm to 5pm and dinner 6pm
-- to 12am."
--
-- Every MIS report now takes ?slot=<preset id> (or custom ?time_from/?time_to)
-- and cuts each day of its window to those hours, on the clock it already uses.
-- The contract — half-open minutes, a slot crossing midnight belongs to the day
-- it starts on, all day is no slot — is report_window.ts. This column is only
-- where the restaurant's PRESETS live.
--
-- SHAPE
-- -----
--   {"version": 1, "slots": [{"id": "lunch", "label": "Lunch", "start": "12:00", "end": "17:00"}, ...]}
-- At most 8 slots; ids are unique slugs; HH:mm times, an end of "24:00" allowed;
-- no two slots overlap on the 24-hour circle. PUT /reports/mis/time-slots
-- validates all of it before writing (PERM_SETTINGS) and audits the list it
-- replaced.
--
-- WHY NULL, AND WHY NO DEFAULT VALUE
-- ----------------------------------
-- NULL means "never configured" and reads as DEFAULT_TIME_SLOTS — Lunch
-- 12:00-17:00 and Dinner 18:00-24:00, the client's own words. The defaults live
-- in code, not in a column default, so every existing "Restaurant" row gets them
-- the moment this runs without a row rewrite, and saving an empty list puts a
-- restaurant back on them. A stored value that no longer validates also reads as
-- the defaults: a report must never fail because of how its toolbar is set up.
--
-- RESTAURANT-WIDE, not per outlet, so the ALL-OUTLETS aggregate read has one
-- definition of Lunch across every branch it adds up.
--
-- WHY A COLUMN OF ITS OWN: brand_config is sanitized guest-page branding and
-- feedback_config has patch-merge semantics; neither is a list that is replaced
-- whole.
--
-- ORDER OF ROLLOUT
-- ----------------
-- IDEMPOTENT, and mirrored by ensureBrandingColumns() in database_supabase.ts,
-- which issues the same statement at runtime (the idiom 040 documents) before
-- the preset save's transaction. The report readers do not depend on it at all:
-- they read the column only when a preset id or the session cut names one, and a
-- missing column (42703) reads as the defaults. So the backend can ship first;
-- on a runtime that connects as the table owner the column already exists by the
-- time this runs, and this file only records it in schema_migrations. A runtime
-- repointed to app_runtime (no DDL) needs this applied before anyone SAVES
-- presets — reading them works either way.

alter table "Restaurant" add column if not exists report_time_slots jsonb default null;

comment on column "Restaurant".report_time_slots is
  'Reports time-slot presets: {"version":1,"slots":[{"id","label","start":"HH:mm","end":"HH:mm"}]}. NULL = never configured, read as Lunch 12:00-17:00 and Dinner 18:00-24:00 (report_window.ts DEFAULT_TIME_SLOTS). Written whole by PUT /reports/mis/time-slots.';

-- Grants are table-level (002_app_runtime_role.sql), so a new column needs no
-- further grant. Stated only so the omission reads as intentional.
