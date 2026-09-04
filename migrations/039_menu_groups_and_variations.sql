-- Migration 039: MENU GROUPS (a classification above category) and ITEM
-- VARIATIONS (Half/Full, Small/Large, add-ons with their own prices) — plus the
-- one thing that makes either of them reportable: an order line that says which
-- menu row it came from.
--
-- ============================================================================
-- THE MENU AS IT IS
-- ============================================================================
-- "Menue_main_cat" -> "Menue_sub_cat" -> "Menu", and GetMenuItems FLATTENS all
-- of that to a single `category` string (sub-category name, falling back to
-- main). Price, image, station, modifiers, recipe, allergens, blurb, badges and
-- price history all live inside the "Menu".description JSON blob
-- (encodeMenuDescription). There is no notion of Food vs Beverage, no notion of
-- Kitchen vs Bar vs Bakery, and no notion of a dish having two sizes at two
-- prices.
--
-- The absence of the first is why no report can produce the liquor-vs-food split
-- that every Indian restaurant's accountant asks for first (they are taxed and
-- licensed differently). The absence of the second is why a Half plate is
-- currently entered as a separate menu item, or as an off-menu line typed at the
-- till — which is how a dish's real sales volume ends up split across three rows
-- with different names.
--
-- ============================================================================
-- THE HARD PART, STATED PLAINLY
-- ============================================================================
-- An order line is `{id, name, quantity, price, ...}` inside a JSON blob. `name`
-- is a STRING. `id` is NOT a menu reference — it is a menu id only by accident
-- and only sometimes: AddOrder's merge path mints `randomUUID()` for every added
-- quantity (database_supabase.ts, preparedNewItems), which destroys the link on
-- the second time a guest orders the same dish. So today NO report can attribute
-- a sale to a group or a variation, and none ever could without changing what an
-- order line carries.
--
-- WHAT AN ORDER LINE STARTS CARRYING, and it is three additive keys, all STAMPED
-- BY THE SERVER, never accepted from the client:
--
--     menu_id        the "Menu".id this line resolved to, or absent.
--     variation_id   the "MenuVariations".id, or absent.
--     variation_name the variation's label, snapshotted for printing.
--
-- They are stamped inside applyMenuPriceFloor, which is the ONE function every
-- order write already routes every line through, which already does exactly this
-- lookup (by id, then by lower(name)) to enforce the price floor, and which
-- already degrades to "leave the line as typed" when the menu cannot be read. No
-- new resolution path, no new failure mode, and no client can lie about which
-- menu row it billed against.
--
-- ============================================================================
-- WHAT EVERY EXISTING ORDER REPORTS AS. NOTHING CHANGES, AND NOTHING IS INVENTED
-- ============================================================================
-- Every order written before this migration has no `menu_id`. Those lines are
-- resolved AT READ TIME by the same name lookup, and:
--   * name matches a live menu row  -> attributed to that row's group and, for a
--     variation, to no variation (the line predates variations existing, so it
--     is a base-price sale by definition).
--   * name matches nothing (a dish since deleted or renamed, an off-menu line, a
--     valet fee, an aggregator line) -> group "Unclassified", variation null.
-- Never a guess, never a nearest match. Every report that cuts by group carries
-- an Unclassified bucket and states how much of the window is in it, because a
-- group report that quietly drops what it cannot classify is a group report
-- whose totals no longer equal the sales summary's.
--
-- ============================================================================
-- WHY THE GROUP IS RESOLVED AT READ TIME AND THE PRICE IS SNAPSHOTTED AT WRITE
-- ============================================================================
-- These look inconsistent and they are opposite on purpose:
--
--   A PRICE IS A FACT ABOUT THE TRANSACTION. What the guest was charged for a
--   Half plate in June must never change because the price moved in July. So
--   `price` stays on the line, exactly as today, and 034 snapshots it again for
--   non-chargeables.
--
--   A GROUP IS A CLASSIFICATION OF THE ITEM. If an owner discovers that Fresh
--   Lime Soda has been filed under Food for six months, the correct outcome of
--   fixing it is that the last six months of reports become right — not that the
--   error is frozen into history and every past report stays wrong for ever.
--   Snapshotting the group would make a classification correction unappliable,
--   which is the exact failure it exists to allow.
--
-- So group_id is a column on the MENU (and its category), resolved through
-- menu_id when a report runs. variation_id IS stamped, because a variation is
-- not a classification — it identifies WHICH THING was sold, and Half and Full
-- are two different things regardless of how they are later filed.
--
-- ============================================================================
-- GROUP LIVES ON THE CATEGORY, WITH A PER-ITEM OVERRIDE
-- ============================================================================
-- Setting a group on all 300 items one at a time is not a feature anybody will
-- use. Setting it on ~12 categories is. So:
--     "Menue_main_cat".group_id  the default for everything filed under it.
--     "Menu".group_id            a nullable override for the genuine exception
--                                (the mocktail listed under Desserts).
-- Resolution is item override -> category default -> Unclassified, in that
-- order, in one place (menuGroupResolution in database_supabase.ts). Two columns
-- is one more than ideal; requiring three hundred edits, or forbidding the
-- exception that certainly exists, are both worse.
--
-- ============================================================================
-- VARIATIONS ARE ROWS, NOT ANOTHER KEY IN THE description BLOB
-- ============================================================================
-- Modifiers already live in that blob and that is the right home for them: a
-- modifier is a decoration on a line and is never sold by itself. A variation is
-- a PRICE POINT — it is the thing sold, it needs its own id so an order line can
-- name it, and "what did Half plates take this month" is a GROUP BY over
-- thousands of orders. Neither is servable from JSON inside a text column
-- without scanning the whole menu on every report.
--
-- THE MONEY CONSEQUENCE, and it is the one thing here that can charge a guest
-- wrongly: applyMenuPriceFloor currently floors every line to its menu item's
-- base price. A Half plate at 150 against a base of 250 would be floored UP to
-- 250 and the guest would be overcharged by 100 with the bill still printing
-- "Half". So the floor becomes: the price of the RESOLVED VARIATION when the
-- line names one, and the base price otherwise. Unchanged for every line that
-- names no variation, which is every line that exists today.
--
-- DEACTIVATION, NOT DELETION, for both new tables: an order line that named a
-- variation must still be able to print its label next year.
--
-- text + CHECK, not an enum (024). NOT CREATED LAZILY (026/027/029/033).

-- ---------------------------------------------------------------------------
-- The group.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "MenuGroups" (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  res_id      uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  outlet_id   uuid NOT NULL REFERENCES "Outlets"(id)    ON UPDATE CASCADE ON DELETE CASCADE,

  name        text NOT NULL CHECK (btrim(name) <> ''),
  -- revenue    : how the money is CUT — Food / Beverage / Liquor / Tobacco. This
  --              is the axis an accountant and a licensing return care about.
  -- production : where it is MADE — Kitchen / Bar / Bakery. This is the axis a
  --              head chef and a station-wise KOT care about.
  -- One tenant legitimately wants both, over the same menu, and they do not nest
  -- (Liquor is made at the Bar; so is a mocktail, which is not Liquor). Keeping
  -- them as two kinds of group rather than two columns means a report asks for
  -- the axis it needs and a tenant that only wants one never configures the
  -- other.
  kind        text NOT NULL DEFAULT 'revenue' CHECK (kind IN ('revenue','production')),
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0
);

-- Case-insensitive per outlet: "Beverage" and "beverage" as two groups would
-- split one bucket in two on every report that sums by name.
CREATE UNIQUE INDEX IF NOT EXISTS menugroups_name_uidx
  ON "MenuGroups" (res_id, outlet_id, kind, lower(name));

CREATE INDEX IF NOT EXISTS menugroups_outlet_idx
  ON "MenuGroups" (res_id, outlet_id, kind, active, sort_order);

-- ---------------------------------------------------------------------------
-- Where a group attaches. See the header: category default + item override.
-- ---------------------------------------------------------------------------
ALTER TABLE "Menue_main_cat" ADD COLUMN IF NOT EXISTS group_id uuid;
ALTER TABLE "Menu"           ADD COLUMN IF NOT EXISTS group_id uuid;

-- Partial: overrides are the exception by design, so indexing the NULLs would be
-- indexing almost the whole menu to find almost nothing.
CREATE INDEX IF NOT EXISTS menu_group_idx
  ON "Menu" (res_id, outlet_id, group_id)
  WHERE group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS menue_main_cat_group_idx
  ON "Menue_main_cat" (res_id, outlet_id, group_id)
  WHERE group_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Variations.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "MenuVariations" (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  res_id      uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  outlet_id   uuid NOT NULL REFERENCES "Outlets"(id)    ON UPDATE CASCADE ON DELETE CASCADE,
  -- The dish this is a variation OF. A real composite FK: unlike the audit
  -- tables in 034-037, a variation has no meaning without its item and there is
  -- no history to preserve when the item is gone — an orphaned "Half" that
  -- belongs to nothing would be a menu row that renders as a price with no dish.
  -- "Menu"'s PK is (id, res_id, outlet_id), so the reference names all three,
  -- which also makes it impossible for a variation to point across a tenant.
  menu_id     uuid NOT NULL,

  name        text NOT NULL CHECK (btrim(name) <> ''),
  price       numeric NOT NULL CHECK (price >= 0),
  -- The variation a till should pre-select. Not a constraint that exactly one
  -- exists — a dish may legitimately force the guest to choose — but the
  -- resolver treats "no default" as "the item's base price", so an unconfigured
  -- dish behaves exactly as it does today.
  is_default  boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,

  CONSTRAINT menuvariations_item_fk
    FOREIGN KEY (menu_id, res_id, outlet_id)
    REFERENCES "Menu" (id, res_id, outlet_id)
    ON UPDATE CASCADE ON DELETE CASCADE
);

-- One "Half" per dish. Case-insensitive for the same reason as groups: two
-- variations a human reads as identical would split the dish's sales in two.
CREATE UNIQUE INDEX IF NOT EXISTS menuvariations_name_uidx
  ON "MenuVariations" (res_id, outlet_id, menu_id, lower(name));

-- The menu read's join, and the price-floor resolution on every order write.
CREATE INDEX IF NOT EXISTS menuvariations_item_idx
  ON "MenuVariations" (res_id, outlet_id, menu_id, active, sort_order);

-- ---------------------------------------------------------------------------
-- RLS. "Menu" / "Menue_main_cat" are covered by migration 003 already; the two
-- new tables are not, because 003's loop over information_schema.columns does
-- not retro-cover tables created later.
-- ---------------------------------------------------------------------------
ALTER TABLE "MenuGroups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MenuGroups" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "MenuGroups";
CREATE POLICY tenant_isolation ON "MenuGroups"
  USING      (res_id::text = current_setting('app.res_id', true))
  WITH CHECK (res_id::text = current_setting('app.res_id', true));

ALTER TABLE "MenuVariations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MenuVariations" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "MenuVariations";
CREATE POLICY tenant_isolation ON "MenuVariations"
  USING      (res_id::text = current_setting('app.res_id', true))
  WITH CHECK (res_id::text = current_setting('app.res_id', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "MenuGroups"     TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "MenuVariations" TO app_runtime;
  END IF;
END $$;
