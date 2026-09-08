-- Migration 041: an explicit, per-outlet order for floor sections.
--
-- THE COMPLAINT: "sections under tables are grouped in alphabetical order;
-- there should be an option to rearrange the order of the sections."
--
-- Alphabetical was never a choice anyone made. Migration 023 created
-- "Table_sections" as (id, created_at, res_id, outlet_id, name) — there is no
-- ordering column anywhere in the schema, so `order by name` is the ONLY total
-- order the data can express. A floor is not laid out alphabetically: an owner
-- reads their sections front-to-back (Entrance, Main Hall, Terrace, Rooftop),
-- and the list they stare at all service should say that.
--
-- WHAT THIS ADDS: one nullable integer per roster row.
--
--   sort_order IS NULL  -> "no position has ever been chosen for this section"
--   sort_order = n      -> "this section is nth in this outlet's floor order"
--
-- The read order everywhere is (sort_order IS NULL, sort_order, lower(name)):
-- positioned sections first in their chosen order, then everything unpositioned
-- in the alphabetical order it has always had.
--
-- NOTHING IS BACKFILLED, DELIBERATELY. Every existing row stays NULL, so the
-- moment this migration lands every outlet still renders in exactly the
-- alphabetical order it rendered in on 1.8.5 — this release is invisible until
-- somebody actually drags a section. That is also the fallback rule for the two
-- cases the feature has to answer for:
--
--   * An outlet that has NEVER reordered: every row NULL, so the composite key
--     collapses to lower(name). Alphabetical, unchanged, for free.
--   * A section CREATED after a reorder: NULL, so it lands at the end of the
--     list (alphabetically among any other new ones) instead of shouldering
--     into the middle of a hand-made order. Appending is the only placement
--     that moves nothing the owner already positioned; they can then drag it
--     where they want it.
--
-- PER OUTLET, not per restaurant: "Table_sections" is already keyed
-- (res_id, outlet_id) and two branches genuinely lay their floors out
-- differently. Positions are assigned 1..N within one outlet's roster and mean
-- nothing across outlets.
--
-- WHY NO UNIQUE INDEX ON (res_id, outlet_id, sort_order): uniqueness is a
-- product of HOW the column is written, not something the reader needs. The
-- whole outlet is renumbered 1..N by a single UPDATE inside one transaction
-- that has already taken FOR UPDATE on the roster (see ReorderTableSections),
-- so duplicates cannot be produced by the shipped path. A non-deferrable unique
-- index, meanwhile, is checked per row DURING a statement, so the ordinary act
-- of swapping two sections would trip it mid-UPDATE even though the committed
-- state is unique. And if a duplicate ever did appear — a hand-run UPDATE, a
-- restore from an odd backup — the lower(name) tiebreaker in the read order
-- still yields a total, stable order rather than a 500. A constraint that
-- cannot be satisfied by a legal write, in exchange for a failure mode the
-- reader already handles, is a bad trade.

-- The column. Idempotent, additive, no rewrite: adding a nullable column with
-- no default is a catalogue-only change in PostgreSQL 11+, so this does not
-- take an exclusive lock long enough to matter on a live floor.
ALTER TABLE "Table_sections"
  ADD COLUMN IF NOT EXISTS sort_order integer;

-- The read path is always scoped to one outlet and ordered by this column, so
-- the index carries the tenant key first and the position second — the same
-- shape as tables_section_idx in 020.
CREATE INDEX IF NOT EXISTS table_sections_order_idx
  ON "Table_sections" (res_id, outlet_id, sort_order);

-- RLS was applied to this table by 023 and is asserted again here for the same
-- reason 033 spells it out: migration 003 applies RLS with a dynamic loop over
-- information_schema, which does not retro-cover tables created later, and a
-- database restored or branched between 023 and now must not be able to end up
-- with an unprotected roster. All four statements are idempotent and are a
-- no-op on a database where 023 already did this.
ALTER TABLE "Table_sections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Table_sections" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Table_sections";
CREATE POLICY tenant_isolation ON "Table_sections"
  USING      (res_id::text = current_setting('app.res_id', true))
  WITH CHECK (res_id::text = current_setting('app.res_id', true));

-- 002's ALTER DEFAULT PRIVILEGES only covers tables created by the role that
-- set it, so spell the grants out — a migration run under a different owner
-- would otherwise leave the runtime unable to write the column it just added.
-- (023's and 033's exact guard.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "Table_sections" TO app_runtime;
  END IF;
END $$;
