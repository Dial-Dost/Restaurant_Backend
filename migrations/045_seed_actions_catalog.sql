-- Migration 045: the permission catalogue a database built from migrations never had.
--
-- THE DEFECT. "Audit_logs".action_id has a foreign key to "Actions"(id)
-- (000_base_schema.sql), and audit titles render from "Actions".action_name. But
-- no migration ever seeded the ORIGINAL catalogue — the rows every
-- validateAction()/log_audit() call names were created by hand in the first
-- Supabase project, and 000 copied the table's shape, not its rows. So on any
-- database built from migrations (the local docker stack, CI's ephemeral
-- Postgres, a fresh tenant box) seating a table — log_audit under 090ea8d4
-- "Table Occupied" — fails with 23503 and the audit line is lost, and so does
-- every other audited write whose id is below.
--
-- TWO KINDS OF ROW, both idempotent (ON CONFLICT (id) DO NOTHING), and neither
-- touches a row that already exists, so a production catalogue — which already
-- holds every one of these ids under its real name — is left byte-for-byte as
-- it is. Nothing here renames, re-groups or re-describes an existing action.
--
-- 1) THE APPLICATION'S LAZY SEEDS, copied VERBATIM from database_supabase.ts
--    (ensureFeaturePermissionActions, ensureValetOpsColumns, ensureIssueStockAction,
--    ensureFireCourseAction, the discount/reopen, attendance, reconcile and
--    loyalty seeds). Each of those says "seeded by migrations under
--    least-privilege runtimes" in its catch — and none of them was. Under the
--    app_runtime role (002) the insert fails, the catch swallows it, and the
--    row never exists. Whichever of the two runs first now wins and the other is
--    a no-op, the arrangement 022 already uses for Manage Table Sections.
--
-- 2) THE ORIGINAL CATALOGUE. Ids the code has always used and nothing has ever
--    seeded. Where the code names the row verbatim (AUDIT_UNDO_BLOCKLIST's
--    "VERBATIM action_name" list, CORE_ROLES, the permission constants) that
--    name is used. The rest are named after the routes they gate — marked
--    "(named from its routes)" below — because a label nobody can read is worse
--    than a plain description, and on a database that already has the row the
--    real name wins anyway.
--
-- NEVER mint a new id here (025's rule). Every id below is one the code already
-- passes; jest-tests/actions_catalog_seeded.test.ts fails when a new one appears
-- in the code without a migration that inserts it.

-- 1) The application's lazy seeds.
INSERT INTO "Actions" (id, action_name, action_desc, "group")
VALUES
  ('4a7d1c9e-5b3f-4e8a-a6d2-0c9f7b3e5a18', 'Valet Key Log', 'Record which attendant holds a valet vehicle''s keys', 'Valet'::"Action_groups"),
  ('8e4b2d6f-3a1c-4f7e-9b05-d2c6a8e0f413', 'Valet Ops Update', 'Update valet parking location / condition notes / retrieval ETA', 'Valet'::"Action_groups"),
  ('6c2e8a4d-7f1b-4d9c-8e35-b0a4d6c2f791', 'Valet Charge to Bill', 'Post a valet parking fee onto a table''s open bill', 'Valet'::"Action_groups"),
  ('3f9a1c72-6b04-4e19-9d2a-8c5e7f01a4b3', 'Manage Campaigns', 'Create and delete marketing campaigns', 'Customer'::"Action_groups"),
  ('7c1e4d90-2a6b-4f83-b5c1-9e0d6a2f3418', 'Manage Coupons & Vouchers', 'Create/list/delete discount coupons and gift vouchers', 'Customer'::"Action_groups"),
  ('5b8d2f16-4c93-47a0-a1e6-3d7f9b0c5e24', 'Guest Messaging', 'View guest messages and run reminder campaigns', 'Customer'::"Action_groups"),
  ('9a3c6e81-7d40-4b52-8f19-2c6b4a0e7d35', 'Approve Discounts', 'Review, approve or reject discount requests', 'Bills'::"Action_groups"),
  ('2e7b9c40-1f83-4d6a-b902-5a8c3e1f6047', 'Review Attendance', 'View staff attendance and approve/reject entries', 'Restaurant Specific'::"Action_groups"),
  ('6d0f3a94-8b21-4c67-9e53-1a4d7b2f8c60', 'Manage Restaurant Settings', 'Change restaurant settings: taxes, service charge, payment keys, OTP, kitchen sections, feedback config, timezone', 'Restaurant Specific'::"Action_groups"),
  ('4a1c8e73-5f60-49b2-a3d8-7c2e0b6f9153', 'Manage Branding', 'Change logo, colours and customer-page theme', 'Restaurant Specific'::"Action_groups"),
  ('1c6e9b34-7a52-4f80-9d13-3b8c5a0e6f27', 'Manage Subscription & Billing', 'View and change the subscription plan and process billing', 'Restaurant Specific'::"Action_groups"),
  ('0b4d7f92-6c81-43a5-b7e0-2f9a1c8d5e36', 'Manage User Passwords', 'Reset staff passwords and handle password-reset requests', 'Roles'::"Action_groups"),
  ('6f2a4c81-9d35-4b7e-a0c2-5e8b1d3f7a94', 'Undo Audited Action', 'Reverse an eligible action from the audit log', 'Audit Logs'::"Action_groups"),
  ('8c3f5b21-0e74-4a96-b2d8-6f1a9c4e7b53', 'Delete Orders', 'Permanently delete an order (separate from placing or editing orders)', 'Orders'::"Action_groups"),
  ('3d9e7a05-6c18-4f2b-9a41-8b5d0e3c6f72', 'Delete Menu Categories', 'Delete a menu category and its grouping', 'Menu'::"Action_groups"),
  ('7b2c9d48-3a51-4e07-8d6f-1c4e5a9b0837', 'Bulk Replace Menu', 'Replace the ENTIRE menu in one save — destructive; a partial payload removes items', 'Menu'::"Action_groups"),
  ('5e8a1f36-9b47-42c0-a7e5-0d3b6c8f4291', 'Resolve Feedback Recovery', 'Mark a guest-recovery case resolved (a write, not a view)', 'Feedback Questions'::"Action_groups"),
  ('b4e7a1c9-2d58-4f36-9a07-5c81e3b0d472', 'Mark Items Non-Chargeable', 'Comp a dish (complimentary, staff meal, spoilage, tasting, guest complaint, promo) off what the guest pays, and reverse one. Also names who may AUTHORISE a comp.', 'Bills'::"Action_groups"),
  ('c1f83b26-5a97-4e40-b8d3-7e02a9c4f156', 'Void Orders With Reason', 'Cancel a rung-up order with a recorded reason and authoriser. Also names who may AUTHORISE a void.', 'Orders'::"Action_groups"),
  ('d5a06e73-9c41-4b28-8f6a-1b74d3e08c95', 'Waive Service Charge', 'Take the service charge off an open bill with a recorded reason and authoriser, and put it back. Also names who may AUTHORISE a waiver.', 'Bills'::"Action_groups"),
  ('c4d2e6f8-1a3b-4c5d-8e7f-2b4a6c8d0e1f', 'Approve Discount', 'Review (approve/reject) staff bill-discount requests', 'Bills'::"Action_groups"),
  ('d5e3f7a9-2b4c-4d6e-9f80-3c5b7d9e1f2a', 'Reopened bill', 'Re-open a closed bill within the allowed window', 'Bills'::"Action_groups"),
  ('e7a41c3b-5a20-4f6e-9d38-6c2b9a51f0aa', 'Approve Attendance', 'Review (approve/reject) employee clock-ins', 'Restaurant Specific'::"Action_groups"),
  ('b3f8d6a1-2c47-4e0b-8f5d-9e6a7c8b0d21', 'Attendance Clock Event', 'Employee clocked in or out', 'Restaurant Specific'::"Action_groups"),
  ('9c4b7d2e-6f18-4a53-b0e9-1d7a3c58f246', 'Issue Stock', 'Ingredient issued from store to kitchen', 'Inventory'::"Action_groups"),
  ('a4b8f0d2-6c3e-4f7a-9b1d-5e8c2a7f4d90', 'Fire Course', 'Fired a held course to the kitchen', 'Orders'::"Action_groups"),
  ('7d3a9f52-4b8c-4e16-a2d7-90c5e8b1f634', 'Reconcile Settlement', 'Record the actual settlement received per payment method vs the POS expected total', 'Bills'::"Action_groups"),
  ('5b3f9d71-2c84-47e6-9a05-8e64d1f0b923', 'Loyalty Redeem', 'Loyalty points redeemed as a bill discount', 'Customer'::"Action_groups")
ON CONFLICT (id) DO NOTHING;

-- 2) The original catalogue.
INSERT INTO "Actions" (id, action_name, action_desc, "group")
VALUES
  -- Tables
  ('090ea8d4-e348-4e1b-9723-11131a73a085', 'Table Occupied', 'Seat a party, correct its covers, move it to another table, read table status and release the table.', 'Tables'::"Action_groups"),
  ('194ce6ee-b867-4be3-b5f0-48c28ce0a81b', 'Table Added', 'Add a table and edit it (capacity, section).', 'Tables'::"Action_groups"),
  ('5777c4aa-29df-4ea1-9c45-c1038d25f746', 'Table Deleted', 'Delete a table from the floor.', 'Tables'::"Action_groups"),
  ('f88657ce-0d67-4cd6-aae1-765dec10cd98', 'View Table Assignments', 'See which waiter is assigned to which table.', 'Tables'::"Action_groups"), -- (named from its routes)
  ('faf2745b-580c-4529-bbe1-033200cbcf67', 'Assign Table', 'Assign a waiter to a table.', 'Tables'::"Action_groups"), -- (named from its routes)
  ('e97a2c5d-d83d-48e3-bdea-ef0c3a1c51a7', 'Unassign Table', 'Remove a waiter''s assignment from a table.', 'Tables'::"Action_groups"), -- (named from its routes)
  -- Orders
  ('4ad474d4-5230-449c-874f-6a238b833bca', 'Add Orders', 'Place and edit orders, print KOTs and work the running bill.', 'Orders'::"Action_groups"),
  ('07e364cc-f40d-46f3-b691-0f719dd38e0f', 'Update Order Status', 'Move an order through its workflow statuses.', 'Orders'::"Action_groups"),
  ('d6bebeb5-111f-4371-b373-a99158116d71', 'Update Order - Add Food Item', 'Audit label for adding a line to an existing order.', 'Orders'::"Action_groups"),
  ('371ecf9f-303e-4114-92fb-3a5120d1565e', 'Update Order - Delete Food Item', 'Audit label for removing a line from an existing order.', 'Orders'::"Action_groups"),
  ('b7f78d0f-323d-4622-8d05-aa2f82d54b2e', 'View Orders', 'See the live orders feed and the expo screen.', 'Orders'::"Action_groups"), -- (named from its routes)
  ('df75119b-e5f1-4f38-aba5-78a1cf182f56', 'View Order APC', 'See APC, revenue, analytics and accounting figures.', 'Orders'::"Action_groups"),
  -- Bills
  ('9186e53e-0fda-4ec8-ad20-2f9feaadb77f', 'Create Bill', 'Generate a bill for a table.', 'Bills'::"Action_groups"),
  ('98b10bde-802d-4a5b-a726-53a826424f79', 'View Bill', 'Read a table''s running bill and the open and closed bill lists.', 'Bills'::"Action_groups"),
  ('a953d044-31ba-4e31-b96f-99304fe43dfa', 'Close Bill', 'Settle a bill. Also required to release a table that still carries value or to discount a bill to nothing.', 'Bills'::"Action_groups"),
  ('2393edd7-cdd9-439c-9ff3-d563d5216967', 'Captain Confirm Payment Method', 'Record how a bill is being paid (tenders, payment proof) ahead of approval.', 'Bills'::"Action_groups"),
  ('fc57d407-4bba-442c-97a2-9e6f3c57f288', 'Approve Payment', 'Approve a recorded payment.', 'Bills'::"Action_groups"),
  ('ec63660a-67c4-4225-862c-70d99a1f42c8', 'Bill Payment Approved', 'Audit label for an approved bill payment.', 'Bills'::"Action_groups"),
  ('97ea36e9-2157-4730-8c94-233ed7fd8517', 'Bill Payment Confirmed', 'Audit label for a confirmed bill payment.', 'Bills'::"Action_groups"),
  ('383cc261-7e5c-4745-b16f-06a41e2ae047', 'Replace Bill', 'Replace a bill with a corrected one.', 'Bills'::"Action_groups"),
  ('2ae797d9-2bef-4419-a33d-ab09590dbef9', 'Publish Bill', 'Publish a bill to the guest.', 'Bills'::"Action_groups"), -- (named from its routes)
  -- Bookings
  ('3ec33182-ceb4-4d07-ac7e-84214adcf104', 'Add Booking', 'Create a reservation.', 'Bookings'::"Action_groups"), -- (named from its routes)
  ('0a98cf2b-8b42-47a7-a523-b7bb73cb870e', 'View Bookings In Range', 'List reservations within a date range.', 'Bookings'::"Action_groups"), -- (named from its routes)
  ('1f176202-d5e7-4bb0-802c-275a42425394', 'Cancel Booking', 'Cancel a reservation.', 'Bookings'::"Action_groups"),
  ('fdeecab6-7c3a-4239-b87c-99a96f50c551', 'Update Booking Status', 'Change a reservation''s status (arrived, seated, no-show…).', 'Bookings'::"Action_groups"),
  ('c7699d46-0e2f-4448-b325-8ca490a5296b', 'Assign Booking Table', 'Assign tables to a reservation and read seating suggestions.', 'Bookings'::"Action_groups"), -- (named from its routes)
  -- Customer
  ('3c530903-324c-4bbe-802b-849763518920', 'Get Customers', 'Read the customer list, insights and segments.', 'Customer'::"Action_groups"),
  ('daf1d71f-2b37-4cd1-b951-28fece7719cd', 'Add Customer', 'Create or link a customer record.', 'Customer'::"Action_groups"), -- (named from its routes)
  -- Menu
  ('f4177b38-77fa-4d8c-9fbd-c4f06bf28610', 'View Menu', 'Read the menu, categories, badges and costing.', 'Menu'::"Action_groups"),
  ('88a87943-8f0b-43e2-b85e-192fdc901ed2', 'Create Menu Item', 'Create or save menu items, categories, images and the queue pre-order menu.', 'Menu'::"Action_groups"), -- (named from its routes)
  ('ed800655-b937-44ba-a7ca-7458295886c9', 'Edit Menu', 'Change prices, availability, badges and kitchen sections.', 'Menu'::"Action_groups"),
  -- Inventory
  ('77e41c84-ebf4-4542-a75b-c9e72e03b570', 'View Inventory', 'Read inventory items and stock.', 'Inventory'::"Action_groups"), -- (named from its routes)
  ('dfe2cde8-c159-4685-b015-ec7b0d4386eb', 'Update Inventory', 'Create or update inventory items and stock.', 'Inventory'::"Action_groups"), -- (named from its routes)
  ('add0a9ec-a563-4903-9a24-d2e0b46361a5', 'Remove Inventory Items', 'Delete an inventory item.', 'Inventory'::"Action_groups"),
  -- Roles
  ('17ba6407-b703-4403-ab59-13235966053f', 'Get Roles', 'Read core and custom roles.', 'Roles'::"Action_groups"),
  ('2b6f7948-0b27-41a9-9727-c04ccc9f4db1', 'Get Actions', 'Read the permission catalogue.', 'Roles'::"Action_groups"),
  ('c0135d18-68b4-45e9-9b51-849158df6efd', 'Create/Update Role', 'Create a custom role or change its permissions.', 'Roles'::"Action_groups"),
  ('53d0927d-00f4-48cc-a40c-51edb09826d8', 'Delete Role', 'Delete a custom role.', 'Roles'::"Action_groups"),
  ('4bf54bd9-9124-46c0-a7cc-011ea4c4e172', 'Assign Role', 'Assign a role to an employee.', 'Roles'::"Action_groups"), -- (named from its routes)
  ('9acc9097-4803-4be0-bb6d-fc2c5de57cf5', 'Remove Role', 'Remove a role from an employee.', 'Roles'::"Action_groups"), -- (named from its routes)
  -- Restaurant Specific
  ('92cb8236-1039-4b47-a66f-6c7c8b0144ae', 'View Employees', 'List the restaurant''s staff.', 'Restaurant Specific'::"Action_groups"), -- (named from its routes)
  ('58fdfca7-7a97-439b-aeb2-00e4395a9a30', 'Add Employee', 'Create a staff login.', 'Restaurant Specific'::"Action_groups"), -- (named from its routes)
  ('a978f15d-1043-417a-b07b-05f6bddad875', 'Remove Employee', 'Remove a staff login.', 'Restaurant Specific'::"Action_groups"),
  ('60d14e9c-45cc-4dc2-b017-56058cc3ae33', 'Update Restaurant Profile', 'Edit the restaurant profile and outlets; also the audit label for settings, branding, coupon and aggregator changes.', 'Restaurant Specific'::"Action_groups"), -- (named from its routes)
  ('d9b3f882-d3cf-46bc-b9ce-4218e8a5c29d', 'View Default Tax', 'Read an outlet''s default tax configuration.', 'Restaurant Specific'::"Action_groups"), -- (named from its routes)
  ('28fa21cc-0dba-4a0f-bf6f-387089f47bbf', 'Update Default Tax', 'Change an outlet''s default tax configuration.', 'Restaurant Specific'::"Action_groups"), -- (named from its routes)
  -- Audit Logs
  ('91b24293-7b88-4fe4-8cf5-deb6faaba4f5', 'View Audit Logs', 'Read the audit log.', 'Audit Logs'::"Action_groups"), -- (named from its routes)
  -- Feedback Questions
  ('0cb6768b-92ff-4848-8631-52ef9d65cf53', 'View Feedback', 'Read guest feedback, recovery cases and feedback stats.', 'Feedback Questions'::"Action_groups"), -- (named from its routes)
  -- Valet
  ('9e37297d-408b-446d-a51b-7892ad216b7d', 'View Valet Info', 'Read valet records, bays and charge targets.', 'Valet'::"Action_groups"), -- (named from its routes)
  ('892b50f3-51fc-4099-8f31-01e8dd8c3d44', 'Create Valet Record', 'Check a vehicle in with valet.', 'Valet'::"Action_groups"), -- (named from its routes)
  ('b8e02c25-b91c-427c-b462-8df009ede055', 'Update Valet State', 'Move a valet vehicle through its states and bays.', 'Valet'::"Action_groups"), -- (named from its routes)
  ('ae8ce7c0-1e06-4722-8a06-817267eec785', 'Add Valet Bay', 'Add a valet parking bay.', 'Valet'::"Action_groups"), -- (named from its routes)
  ('2caeab74-5941-424d-9c3a-5c68ef0186e1', 'Update Valet Bay', 'Edit a valet parking bay.', 'Valet'::"Action_groups"), -- (named from its routes)
  ('6e9be65f-4081-4b86-8ba0-0592ee26f7f2', 'Delete Valet Bay', 'Delete a valet parking bay.', 'Valet'::"Action_groups"), -- (named from its routes)
  ('2ff51c3d-f18c-406c-9f49-7c54f468c835', 'Set Current Valet Bay', 'Set a vehicle''s current valet bay.', 'Valet'::"Action_groups"), -- (named from its routes)
  ('5ef876a7-eb92-4602-b4d3-5590ce379540', 'Unassign Valet Bay', 'Free a vehicle''s valet bay.', 'Valet'::"Action_groups") -- (named from its routes)
ON CONFLICT (id) DO NOTHING;
