-- Migration 031: promotional POSTERS shown alongside the guest menu.
--
-- The ask: "allow restaurants to also add posters which can be displayed along
-- with the menu if needed." A poster is an image the owner uploads, optionally
-- windowed to a run of days, rendered on the public QR order page and the
-- walk-in queue page.
--
-- NOT CREATED LAZILY, deliberately — migration 027's header records why: two
-- dozen tables in this schema exist only as `create table if not exists` inside
-- database_supabase.ts, and migration 026's header records the production outage
-- that pattern caused under the least-privilege app_runtime role, which has USAGE
-- but not CREATE on public (002:28). A table read on every guest menu load does
-- not get to be the twenty-fifth.
--
-- WHY A TABLE AND NOT brand_config -----------------------------------------
-- Posters are a LIST of rows with their own lifecycle (create, schedule, retire,
-- delete) and their own ordering. brand_config is a merge-on-omit jsonb blob
-- whose whole contract is "an absent key means the default": it has no way to
-- delete the third element of an array, and a poster save would have to rewrite
-- the entire list, which is the exact full-replace shape that once destroyed 56
-- menu items' images and recipes. Rows with ids make every write item-scoped.

CREATE TABLE IF NOT EXISTS "Posters" (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  res_id      uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,

  -- NULLABLE, and that nullability is the feature: NULL means "every outlet of
  -- this restaurant", which is what today's editors write, because a promo is
  -- almost always the brand's and not one branch's. A non-null outlet_id scopes
  -- a poster to one branch, which is what a multi-outlet tenant will want the
  -- day the editor grows the control. The guest read already honours both
  -- (`outlet_id is null or outlet_id = $2`), so that day is a UI change only.
  outlet_id   uuid REFERENCES "Outlets"(id) ON UPDATE CASCADE ON DELETE CASCADE,

  -- Public URL in the existing image bucket (storage_bucket_supabase.ts). The
  -- BYTES behind it were re-encoded on upload to at most POSTER_MAX_DIMENSION on
  -- the long edge, so this URL is safe to hand a phone on a 3G connection.
  image_url   text NOT NULL,
  -- Doubles as the image's alt text on both guest pages, which is why it is
  -- stored even though the design does not print it: a poster with no accessible
  -- name is an unlabelled image on a page real diners use.
  title       text NOT NULL DEFAULT '',

  -- Which slot the poster renders in. text + CHECK rather than a Postgres enum,
  -- matching the house convention for small closed vocabularies (migration 024's
  -- note applies verbatim) — adding a third slot is then a CHECK change and not
  -- an ALTER TYPE that cannot run inside a transaction.
  placement   text NOT NULL DEFAULT 'menu' CHECK (placement IN ('top','menu')),
  sort_order  integer NOT NULL DEFAULT 0,

  -- THE SCHEDULE, as CALENDAR KEYS and not instants. `date` (not timestamptz)
  -- because the owner's question is "which days does this run", and both bounds
  -- are INCLUSIVE: Friday-to-Sunday is up on Sunday and gone on Monday.
  --
  -- The day these are compared against is computed in NODE, from the
  -- restaurant's own timezone (posters.ts / dateKeyInZone), NOT from the database
  -- clock: `current_date` on the server is a UTC day, so a Kolkata brunch poster
  -- keyed on it would expire at 05:30 IST — in the middle of the next morning's
  -- service. Every read therefore passes the tenant's day key as a parameter.
  start_on    date,
  end_on      date,
  CONSTRAINT posters_window_ordered CHECK (start_on IS NULL OR end_on IS NULL OR end_on >= start_on),

  -- Pause without deleting. An owner who runs the same Diwali poster every year
  -- should not have to re-upload it.
  active      boolean NOT NULL DEFAULT true,

  -- Intrinsic size of the STORED image, so the guest page can reserve the box
  -- before the bytes arrive. 0 when the encoder could not report it; the pages
  -- fall back to a fixed aspect ratio rather than to a collapsing box.
  width       integer NOT NULL DEFAULT 0,
  height      integer NOT NULL DEFAULT 0,

  created_by  uuid
);

-- THE hot read: "this tenant's posters, in display order", issued on every
-- guest menu load. res_id first because RLS predicates on it and every query is
-- tenant-scoped; the ordering columns follow so the read is an index scan that
-- needs no sort. Deliberately NOT partial on `active`: the editor's list wants
-- the paused ones too and there are single digits of rows per tenant either way.
CREATE INDEX IF NOT EXISTS posters_res_order_idx
  ON "Posters" (res_id, sort_order, created_at);

-- Fail-closed from the moment it exists, in migration 003's exact policy form.
-- 003 applies RLS by a dynamic loop over information_schema.columns (003:30-45),
-- which does not retro-cover tables created later, so this is not redundant.
ALTER TABLE "Posters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Posters" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Posters";
CREATE POLICY tenant_isolation ON "Posters"
  USING      (res_id::text = current_setting('app.res_id', true))
  WITH CHECK (res_id::text = current_setting('app.res_id', true));

-- 002's ALTER DEFAULT PRIVILEGES only covers tables created by the role that set
-- it. Spell the grant out so a migration run under a different owner still leaves
-- the runtime able to read its own rows. (Migrations 024 and 027 use this guard
-- verbatim; there is no sequence here, so no sequence grant is needed.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "Posters" TO app_runtime;
  END IF;
END $$;
