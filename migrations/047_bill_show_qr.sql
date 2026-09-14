-- 047: let an owner turn the QR code off the customer bill.
--
-- WHAT THIS IS FOR
-- ----------------
-- Every customer bill printed by POST /print/bill ends with the feedback/valet
-- QR and the sentence above it (bill_qr_note, migration 030). Some restaurants
-- do not want it on the paper at all: no valet, feedback collected another way,
-- or a bill kept to the bare tax document. Until now there was no setting for
-- that.
--
-- WHY THE DEFAULT IS TRUE, AND WHY NULL READS AS TRUE
-- ---------------------------------------------------
-- Every existing "Restaurant" row is NULL here the instant this runs, and every
-- one of them has been printing the QR. The answer to a question nobody has been
-- asked must be the behaviour they already have, so GetRestaurantSettings maps
-- NULL -> true (`!== false`) and the column default matches. Only an explicit
-- false removes the QR. Same shape as kot_auto_print (040), for the same reason.
--
-- RESTAURANT-WIDE, like bill_qr_note and bill_paper_width beside it: what the
-- restaurant's bill looks like is one decision across its outlets.
--
-- NOT CONSULTED BY the settled-bill reprint or split-bill parts: neither has
-- ever carried a QR (see routes/bills.ts), so there is nothing to switch off.
--
-- IDEMPOTENT, and mirrored by ensureBrandingColumns() in database_supabase.ts,
-- which issues the same statement at runtime: the idiom 040 documents. The code
-- that reads this column shipped first (with the reference bill layout), so on
-- production the column already exists by the time this runs, and this file only
-- records it in schema_migrations.

alter table "Restaurant" add column if not exists bill_show_qr boolean default true;

comment on column "Restaurant".bill_show_qr is
  'The customer bill prints the feedback/valet QR and its sentence. NULL = not set, which reads as TRUE (see GetRestaurantSettings). FALSE prints the bill with no QR block.';

-- Grants are table-level (002_app_runtime_role.sql), so a new column needs no
-- further grant. Stated only so the omission reads as intentional.
