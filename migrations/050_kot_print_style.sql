-- 050: which kitchen docket a restaurant prints — the owner's escape hatch —
-- and how large the reference docket's type is.
--
-- Two columns on "Restaurant", both NULL for every existing row, both read and
-- written by the runtime before this file is applied (see ORDER OF ROLLOUT):
--
--   kot_print_style  NULL / 'reference' | 'classic'
--   kot_text_size    NULL / 'standard'  | 'small' | 'large'
--
-- WHAT THIS IS FOR
-- ----------------
-- The reference kitchen docket is drawn as a RASTER IMAGE. It has to be: the
-- client's reference ticket is a proportional Arial-metric face, and a thermal
-- printer's built-in fonts are monospaced, so no amount of text mode can match
-- it. A raster reaches the paper as `GS v 0`.
--
-- Nearly every thermal printer implements `GS v 0`. The ones that do not DO NOT
-- SAY SO — they swallow the block and feed blank paper. On a bill printer that
-- is an annoyance somebody notices immediately. On a KITCHEN printer it is
-- silent order loss: the docket is blank, the food is never cooked, every screen
-- in the building says the order is fine, and the first person to find out is
-- the guest.
--
-- No printer model is on record for this estate ("PrintDevices" is empty), so
-- there is no way to check that risk in advance. There is only a way to make it
-- RECOVERABLE — by the owner, from Settings, in the ten seconds after the first
-- blank ticket, without waiting for anybody to deploy anything. This column is
-- that switch, and it is why the old ESC/POS text encoder stays in escpos.ts
-- rather than being deleted as superseded code.
--
--   NULL / 'reference'  the reference docket (raster). What everyone gets.
--   'classic'           the plain ESC/POS TEXT docket this product has always
--                       printed. What a printer that cannot draw a raster needs.
--
-- WHY NULL READS AS 'reference', AND WHY THERE IS NO COLUMN DEFAULT
-- ----------------------------------------------------------------
-- Every "Restaurant" row is NULL here the instant this runs, and the answer to a
-- question nobody has been asked must be the behaviour the product is shipping:
-- the docket the client asked for. So NULL reads as 'reference'.
--
-- That answer lives in CODE (kot_print_style.ts, KOT_PRINT_STYLE_DEFAULT), not
-- in a column default, and deliberately. The read has to give the same answer
-- for a NULL column, for a column this file has not created yet (42703), and for
-- a value nobody recognises — three cases a column default cannot cover. A
-- default would be a second place for that answer to live, and the day the two
-- disagreed the one on the paper would be whichever the printer got.
--
-- RESTAURANT-WIDE, like kot_auto_print and bill_paper_width beside it: which
-- docket the kitchens print is one decision across a restaurant's outlets. A
-- chain that needs it per outlet has a different problem (per-printer
-- capability), and that belongs on "PrintDevices", not here.
--
-- WHAT READS IT
-- -------------
-- kot_print.ts:dispatchKot, once per docket, and it hands the resolved style to
-- the renderer for every station ticket that docket splits into. Every KOT in
-- the product goes through that function — auto-print on placement and approval,
-- the added-line docket, POST /print/kot/order/:id, POST /print/bill
-- {kind:"kot"}, the cancellation slip and the table-move slip — so there is
-- nothing for a caller to forget. POST /print/test reads it too, so the slip an
-- owner prints to check a printer is made of the same bytes that printer will be
-- sent at service.
--
-- ORDER OF ROLLOUT
-- ----------------
-- IDEMPOTENT, and mirrored by ensureBrandingColumns() in database_supabase.ts,
-- which issues the same two statements at runtime, in this order (the idiom 040
-- documents, outside any transaction and never inside a settle). The PRINT path
-- does not depend on this file at all: it reads each column through its own
-- statement and a missing column (42703) reads as that column's default, warned
-- once per process. So the backend can ship first; on a runtime that connects as
-- the table owner both columns already exist by the time this runs, and this
-- file only records them in schema_migrations. A runtime repointed to
-- app_runtime (no DDL) needs this applied before anyone can SAVE either setting
-- — reading them works either way.

alter table "Restaurant" add column if not exists kot_print_style text;

comment on column "Restaurant".kot_print_style is
  'Which kitchen docket this restaurant prints. NULL = never chosen, read as ''reference'' (the reference docket, drawn as a raster). ''classic'' = the plain ESC/POS text docket — the escape hatch for a kitchen printer that ignores GS v 0 and answers a raster with blank paper. Resolved by kot_print_style.ts; any unrecognised value reads as ''reference''.';

-- THE SECOND COLUMN: HOW LARGE THE REFERENCE DOCKET'S TYPE IS
-- ------------------------------------------------------------
-- The client, having printed the reference docket: "The font sizes must be
-- smaller in the KOT." Having earlier asked for bigger type twice, the honest
-- answer is a per-restaurant choice:
--
--   NULL / 'standard'  the client's reference ticket — 28 dots per em on an
--                      80mm roll, 24 on 58mm. What everyone gets.
--   'small'            a step down (24 on 80mm, 22 on 58mm).
--   'large'            a step up (34 on 80mm, 28 on 58mm).
--
-- The numbers live in escpos.ts (KOT_BODY_PPEM) beside the glyph atlas that
-- has to contain them; the three words and the "NULL means standard" rule live
-- in kot_print_style.ts (KOT_TEXT_SIZE_DEFAULT). NO COLUMN DEFAULT, for the
-- reason kot_print_style above has none.
--
-- IT SIZES THE REFERENCE DOCKET ONLY. The classic text docket is set in the
-- printer's own font and prints the same bytes whatever this says.
--
-- ITS OWN COLUMN, READ BY ITS OWN STATEMENT (loadKotTextSize), so a database
-- that somehow has the first column and not this one still hands every kitchen
-- the docket its owner chose. The runtime issues the two statements in this
-- same order.

alter table "Restaurant" add column if not exists kot_text_size text;

comment on column "Restaurant".kot_text_size is
  'How large the reference kitchen docket''s type is. NULL = never chosen, read as ''standard'' (the client''s reference ticket: 28 dots per em on 80mm, 24 on 58mm). ''small'' and ''large'' are a step either side. The classic text docket ignores it. Resolved by kot_print_style.ts; any unrecognised value reads as ''standard''.';

-- Grants are table-level (002_app_runtime_role.sql), so neither new column
-- needs a further grant. Stated only so the omission reads as intentional.
