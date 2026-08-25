-- 030: printed-bill header identity + the per-restaurant QR sentence.
--
-- WHAT THIS IS FOR
-- ----------------
-- The thermal bill's header printed the logo, the outlet name and the outlet
-- address, and nothing else. A real Indian restaurant receipt also carries the
-- REGISTERED ENTITY behind the trading name ("NAVKRISH HOSPITALITY LLP") and
-- the GST registration ("GSTN : 29AAXFN2701Q1ZF"). Neither had anywhere to live
-- — no column on "Restaurant", none on "Outlets" — so neither could be printed.
--
-- The footer had the opposite problem: the sentence above the feedback/valet QR
-- was a string literal inside the renderer, identical on every tenant's paper.
--
-- EVERY COLUMN HERE IS NULLABLE AND DEFAULTS TO NULL, DELIBERATELY.
-- NULL means "this tenant has not set one", and every print path treats that as
-- "print nothing at all" rather than "print an empty label". That is what lets
-- a restaurant with no GSTIN keep a clean receipt instead of one headed
-- "GSTN :" with nothing after it. For bill_qr_note, NULL additionally means
-- "use the built-in valet line", so an existing tenant's receipt is unchanged
-- until they deliberately type their own.
--
-- IDEMPOTENT, and mirrored by ensureBrandingColumns() in database_supabase.ts,
-- which issues the same three statements at runtime. That mirroring is the
-- existing idiom for "Restaurant" settings columns and is what keeps the
-- backend deployable ahead of the migration, in either order.

alter table "Restaurant" add column if not exists bill_legal_name text;
alter table "Restaurant" add column if not exists bill_gstin text;
alter table "Restaurant" add column if not exists bill_qr_note text;

comment on column "Restaurant".bill_legal_name is
  'Registered legal entity printed under the restaurant name on the bill (e.g. "… HOSPITALITY LLP"). NULL = not set, prints nothing.';
comment on column "Restaurant".bill_gstin is
  'GST registration number printed as "GSTN : <value>" on the bill. NULL = not set, prints nothing.';
comment on column "Restaurant".bill_qr_note is
  'Sentence printed above the bill feedback/valet QR. NULL = use the built-in default (DEFAULT_BILL_QR_NOTE in escpos.ts).';

-- The app runtime role reads and writes these through GetRestaurantSettings /
-- SetRestaurantSettings like every other "Restaurant" settings column. Column
-- privileges are not granted per-column anywhere in this schema (grants are
-- table-level, see 002_app_runtime_role.sql), so adding columns needs no
-- further grant — stated here only so the omission reads as intentional.
