-- Migration 022: a real permission for floor sections + empty the "Test" action group.
--
-- TWO fixes to the role-permission catalogue, both idempotent.
--
-- 1) "Manage Table Sections" (Tables)
--    Creating / renaming / removing a floor section used to ride on
--    'Table Added' (194ce6ee…), so anyone who could add a table could also
--    re-carve the whole floor plan. This seeds a dedicated grantable action.
--    MOVING a table between sections deliberately KEEPS 194ce6ee — re-seating
--    during service must not wait on an admin-level grant, and a move can
--    neither invent nor destroy a zone. Only creating a NEW zone name (which is
--    the same PATCH write) escalates to the new permission. See index.ts:
--    requireSectionAdminForNewSection.
--
-- 2) Empty the "Test" group.
--    "Actions"."group" DEFAULTS to 'Test'::"Action_groups", so every seed that
--    omitted the column dumped a REAL, gate-carrying action into a category
--    literally called Test in both role editors. Sixteen actions landed there.
--    Each is re-homed BY ID below. The application-side seeds now name their
--    group explicitly (database_supabase.ts), so a fresh deploy lands correctly
--    without this migration; this file repairs databases that already exist.
--
-- INVARIANT: audit-log titles are rendered from "Actions".action_name, so this
-- migration NEVER touches id or action_name — only "group". No audit row's title
-- changes.
--
-- The 'Test' enum value itself is intentionally LEFT IN PLACE: it is still the
-- column DEFAULT, and dropping an enum value that a default depends on is a
-- multi-step, lock-heavy rewrite for no behavioural gain. Unused-but-present is
-- the safe state; an empty category renders as nothing in the role editors.

-- 1) The new grantable permission. Matches the seed in
--    database_supabase.ts::ensureFeaturePermissionActions so whichever runs
--    first wins and the other is a no-op.
INSERT INTO "Actions" (id, action_name, action_desc, "group")
VALUES (
  '2f7c5a94-8e13-4b60-9d27-6a0f3c8e5b41',
  'Manage Table Sections',
  'Create, rename and remove floor sections (zones). Moving a table into an EXISTING section stays under Table Added.',
  'Tables'::"Action_groups"
)
ON CONFLICT (id) DO NOTHING;

-- 2) Re-home every action currently sitting in "Test".
--    Guarded on "group" = 'Test' so a hand-corrected row is never overwritten,
--    and keyed by id so re-running is a no-op.
UPDATE "Actions" AS a
SET "group" = v.grp::"Action_groups"
FROM (VALUES
  -- Attendance workflow -> the group that already holds employee admin.
  ('e7a41c3b-5a20-4f6e-9d38-6c2b9a51f0aa'::uuid, 'Restaurant Specific'), -- Approve Attendance
  ('b3f8d6a1-2c47-4e0b-8f5d-9e6a7c8b0d21'::uuid, 'Restaurant Specific'), -- Attendance Clock Event
  -- Money / bill lifecycle.
  ('c4d2e6f8-1a3b-4c5d-8e7f-2b4a6c8d0e1f'::uuid, 'Bills'),               -- Approve Discount
  ('ec63660a-67c4-4225-862c-70d99a1f42c8'::uuid, 'Bills'),               -- Bill Payment Approved
  ('97ea36e9-2157-4730-8c94-233ed7fd8517'::uuid, 'Bills'),               -- Bill Payment Confirmed
  ('7d3a9f52-4b8c-4e16-a2d7-90c5e8b1f634'::uuid, 'Bills'),               -- Reconcile Settlement
  ('d5e3f7a9-2b4c-4d6e-9f80-3c5b7d9e1f2a'::uuid, 'Bills'),               -- Reopened bill
  -- Kitchen dispatch rides on the order, so it belongs with Orders rather than
  -- a new "Kitchen" enum value: both act on an existing order's items.
  ('3f6a9c1e-8d24-4b7a-b5c9-2e1f7d4a8b63'::uuid, 'Orders'),              -- Bark Order
  ('a4b8f0d2-6c3e-4f7a-9b1d-5e8c2a7f4d90'::uuid, 'Orders'),              -- Fire Course
  -- Stock.
  ('265b87e4-7f45-4a1e-af48-bac07c1c15f1'::uuid, 'Inventory'),           -- Inventory Add
  ('9c4b7d2e-6f18-4a53-b0e9-1d7a3c58f246'::uuid, 'Inventory'),           -- Issue Stock
  -- Loyalty is a guest programme.
  ('5b3f9d71-2c84-47e6-9a05-8e64d1f0b923'::uuid, 'Customer'),            -- Loyalty Redeem
  -- Valet ops.
  ('6c2e8a4d-7f1b-4d9c-8e35-b0a4d6c2f791'::uuid, 'Valet'),               -- Valet Charge to Bill
  ('4a7d1c9e-5b3f-4e8a-a6d2-0c9f7b3e5a18'::uuid, 'Valet'),               -- Valet Key Log
  ('8e4b2d6f-3a1c-4f7e-9b05-d2c6a8e0f413'::uuid, 'Valet'),               -- Valet Ops Update
  -- Genuine smoke-test debris, but NOT deletable: live "Audit_logs" rows carry
  -- this action_id and their titles are rendered from action_name, so removing
  -- it would blank real history (and trip the FK). Parked under Audit Logs.
  ('d57cbf00-26b0-4551-bc61-037c01139131'::uuid, 'Audit Logs')           -- Smoke Audit Action
) AS v(id, grp)
WHERE a.id = v.id
  AND a."group" = 'Test'::"Action_groups";
