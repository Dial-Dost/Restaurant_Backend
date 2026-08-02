-- Migration 023: an honest audit title for table edits + a real home for zones.
--
-- Two fixes to the same complaint ("moving tables and adding sections doesn't
-- show up in the audit log"), both idempotent.
--
-- 1) "Table Updated"
--    PATCH /table/:name logged under 194ce6ee… whose action_name is
--    'Table Added', and audit titles are rendered from "Actions".action_name.
--    So every drag-and-drop move and every capacity edit was FILED UNDER
--    "Table Added" — logged, but unfindable. This seeds the row those entries
--    should have pointed at all along.
--
--    THIS ROW IS A LABEL, NOT A GATE. PATCH /table/:name keeps
--    validateAction('194ce6ee…'); the new id is only ever passed to log_audit.
--    That matters because "Actions" rows also render the permission checkboxes
--    for custom roles: if the route gated on this id, every existing role would
--    be missing it the moment this migration landed and the whole floor would
--    lose the ability to re-seat a table. Logging must never become a
--    permission gate. (The row still shows up as a grantable checkbox — its
--    action_desc says so, so nobody wastes time wondering why ticking it
--    changes nothing.)
--
--    Historical rows are NOT re-pointed: past entries genuinely were written
--    under 194ce6ee…, and rewriting them would be inventing history. Only new
--    edits carry the new id.
--
-- 2) "Table_sections"
--    A zone used to be nothing but the set of "Tables" carrying that name
--    (migration 020), so a zone with no tables in it could not exist at all.
--    The web "Add Section" button therefore never called the server — it wrote
--    the new zone to window.localStorage, which means no audit entry, and the
--    zone never reached the owner app or the next device (or even the same
--    browser after a cache clear). This table gives an empty zone somewhere to
--    live so POST /table-sections can be a real, audited, tenant-wide write.
--
--    "Tables".section stays the source of truth for WHICH zone a table is in —
--    a drag is still a single-row UPDATE with no join table to keep in sync.
--    This table only records that a NAME exists. GET /table-sections unions the
--    two and de-duplicates.

-- 1) The audit label. Fresh uuid, generated for this migration.
INSERT INTO "Actions" (id, action_name, action_desc, "group")
VALUES (
  '526c6b48-4036-4d0d-b617-b34acba3a1d2',
  'Table Updated',
  'Audit label for editing a table (moved between sections, capacity changed). Granting it does nothing on its own — editing a table is gated by Table Added.',
  'Tables'::"Action_groups"
)
ON CONFLICT (id) DO NOTHING;

-- 2) Named zones. Tenant-scoped exactly like "Tables": res_id + outlet_id, both
--    NOT NULL, both cascading from their parent.
CREATE TABLE IF NOT EXISTS "Table_sections" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  res_id uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  outlet_id uuid NOT NULL REFERENCES "Outlets"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  name text NOT NULL
);

-- Uniqueness is on the TRIMMED, LOWERCASED name because that is how the routes
-- resolve a zone (lower(btrim(...)), see GetTableSections / RenameTableSection).
-- A plain unique on `name` would happily hold "Patio" and "patio" side by side
-- while a rename of either swept both — the list and the actions would disagree,
-- which is the exact bug the case-insensitive grouping in GetTableSections was
-- added to fix.
CREATE UNIQUE INDEX IF NOT EXISTS table_sections_tenant_name_idx
  ON "Table_sections" (res_id, outlet_id, lower(btrim(name)));

-- Fail-closed from the moment it exists, in migration 003's exact policy form.
ALTER TABLE "Table_sections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Table_sections" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Table_sections";
CREATE POLICY tenant_isolation ON "Table_sections"
  USING (res_id::text = current_setting('app.res_id', true))
  WITH CHECK (res_id::text = current_setting('app.res_id', true));

-- 002's ALTER DEFAULT PRIVILEGES should already cover this, but only for tables
-- created by the role that set it. Spell it out so a migration run under a
-- different owner still leaves the runtime able to read its own zones.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "Table_sections" TO app_runtime;
  END IF;
END $$;

-- Seed the roster from the zones that already exist as table labels, so the two
-- sources agree on day one and a rename/delete of an existing zone finds a row
-- to keep in step. Grouped case-insensitively (min() picks a stable spelling)
-- for the same reason the unique index is. Excludes deleted and virtual tables
-- to match what GET /table-sections lists.
INSERT INTO "Table_sections" (res_id, outlet_id, name)
SELECT t.res_id, t.outlet_id, min(btrim(t.section))
FROM "Tables" t
WHERE coalesce(t.is_deleted, false) = false
  AND coalesce(t.is_virtual, false) = false
  AND nullif(btrim(coalesce(t.section, '')), '') IS NOT NULL
GROUP BY t.res_id, t.outlet_id, lower(btrim(t.section))
ON CONFLICT DO NOTHING;
