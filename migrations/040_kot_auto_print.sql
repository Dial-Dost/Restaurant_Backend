-- 040: auto-print the kitchen docket when an order is barked.
--
-- WHAT THIS IS FOR
-- ----------------
-- Barking is the moment the expo announces an order to the kitchen: it stamps
-- "Orders".barked_at and rebases every prep timer, so the kitchen clock starts
-- there. Until now the DOCKET did not: someone had to remember to press Print
-- KOT afterwards, and on a busy pass that is exactly the thing that gets
-- forgotten. The order is "in the kitchen" according to every timer in the
-- system and there is no paper on the pass saying so.
--
-- The bark route now builds and enqueues that order's docket itself. This column
-- is the one switch that turns it off for a restaurant that genuinely wants the
-- manual step back (a place with no thermal printer at all, or one that calls
-- orders verbally and prints only on demand).
--
-- WHY THE DEFAULT IS TRUE, AND WHY NULL READS AS TRUE
-- ---------------------------------------------------
-- Every existing "Restaurant" row is NULL here the instant this runs, and no
-- tenant has ever been asked the question. The shipped answer to a question
-- nobody was asked has to be the behaviour the feature exists to provide, so
-- GetRestaurantSettings maps NULL -> true (`rows[0]?.kot_auto_print !== false`)
-- and the column default matches it. An owner who never opens Settings gets
-- dockets printing on bark; only an explicit false turns that off.
--
-- This is deliberately NOT the same shape as 030's nullable text columns, where
-- NULL means "print nothing". A boolean policy has no honest "unset" rendering:
-- either the docket prints or it does not, so NULL has to resolve to one of
-- them, and the safe one is the one that puts paper on the pass.
--
-- RESTAURANT-WIDE, NOT PER-OUTLET, and that is the right grain: "does barking
-- print a docket" is an operating policy, the same question in every branch of a
-- chain. It sits beside bill_paper_width, kitchen_sections, require_table_otp
-- and queue_show_menu, which are all "Restaurant" columns for the same reason.
-- (The printer ROUTING map — which physical printer each station's docket goes
-- to — is deliberately NOT here: those are Windows spooler names, which are
-- facts about one machine and are stored on that machine. See
-- lib/services/printer_service.dart.)
--
-- IDEMPOTENT, and mirrored by ensureBrandingColumns() in database_supabase.ts —
-- the lazy "Restaurant"-columns guard that GetRestaurantSettings and
-- SetRestaurantSettings both await — which issues the same statement at runtime.
-- That mirroring is the existing idiom for "Restaurant" settings columns (it is
-- how require_table_otp and queue_show_menu shipped) and is what keeps the
-- backend deployable ahead of the migration, in either order.

alter table "Restaurant" add column if not exists kot_auto_print boolean default true;

comment on column "Restaurant".kot_auto_print is
  'Barking an order also builds and enqueues its kitchen docket. NULL = not set, which reads as TRUE (see GetRestaurantSettings). FALSE restores the manual Print KOT step.';

-- Column privileges are not granted per-column anywhere in this schema (grants
-- are table-level, see 002_app_runtime_role.sql), so adding a column needs no
-- further grant. Stated here only so the omission reads as intentional.
