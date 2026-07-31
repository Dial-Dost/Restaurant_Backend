-- Migration 020: per-table SECTION (zone) name.
--
-- Lets the floor be organised into named areas ("Garden", "AC Hall", "Rooftop")
-- and a table dragged from one to another. Deliberately a plain nullable text
-- column on "Tables" rather than a Sections table: a section IS just the set of
-- tables carrying that name, so a drag-and-drop reorder is a SINGLE-ROW update
-- (O(1) per drop) with no join table to keep in sync and no orphan rows.
--
-- NULL/'' means "unassigned" and is what every existing table gets, so the floor
-- grid behaves exactly as before until an operator names a section. The same
-- guarded ALTER runs lazily from the app (ensureTableSectionColumn) — whichever
-- side runs first wins and the other is a no-op, matching 017.

ALTER TABLE "Tables" ADD COLUMN IF NOT EXISTS section text;

-- Sections are listed/renamed by grouping on this column, so keep that grouping
-- (and the per-section floor read) off a sequential scan as table counts grow.
CREATE INDEX IF NOT EXISTS tables_section_idx ON "Tables" (res_id, outlet_id, section);
