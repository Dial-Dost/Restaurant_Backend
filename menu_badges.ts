/**
 * Configurable menu badges: the per-restaurant badge CATALOGUE, the per-item
 * tags, and the resolution rule that turns the two (plus the item's allergens)
 * into the ordered list a guest actually sees.
 *
 * PURE module — no database, no network, no imports. Same discipline as
 * billing_math.ts and brand_theme.ts: the rules below decide what a diner is
 * told about a dish, so jest has to be able to exercise them without a pg pool.
 * database_supabase.ts re-exports everything here.
 *
 * THE MODEL --------------------------------------------------------------
 * A badge is a small label a restaurant sticks on a dish ("Must Try", "Jain",
 * "Contains nuts"). Three things vary per tenant: WHICH badges exist, what they
 * are CALLED, and which dishes carry them. So:
 *
 *   catalogue  -> "Restaurant".menu_badges (jsonb array, restaurant-wide, like
 *                 kitchen_sections/inventory_categories — a chain wants ONE
 *                 badge vocabulary across its outlets)
 *   tags       -> `badges: string[]` inside the item's Menu.description JSON
 *                 blob, next to image_url/station/allergens/recipe. Item-scoped
 *                 writes only; PUT /menu is never the tagging mechanism.
 *
 * ABSENT = NOTHING. A tenant who has never opened the badges editor has a null
 * column, which resolves to an EMPTY catalogue, which renders zero badges on
 * every surface. MENU_BADGE_PRESETS below is a starter set the editors OFFER,
 * never something the server applies on its behalf.
 *
 * KIND IS NOT DECORATION -------------------------------------------------
 * "Bestseller" is marketing. "Contains nuts" is the sentence that stops an
 * anaphylaxis. They cannot share a rendering rule, so every badge declares a
 * kind and the kind decides the behaviour:
 *
 *   alert — warn before ordering (nuts, dairy, heat). Rendered FIRST, in the
 *           warning tone, never truncated away to make room for marketing.
 *   diet  — dietary identity (veg / vegan / Jain / halal). Rendered next,
 *           never truncated. A Jain diner cannot recover this by asking "is it
 *           veg", so it is not allowed to be the thing that falls off a card.
 *   promo — marketing. Rendered last, and it is the only kind a compact
 *           surface is allowed to cap.
 *
 * DERIVED SAFETY BADGES --------------------------------------------------
 * Menu items ALREADY carry an allergen list (`allergens`, free-form, rendered
 * as muted chips). Adding a second, separately-tagged "Contains nuts" badge
 * would mean two stores of the same safety fact that can disagree — and the one
 * that disagrees quietly is the one that hurts someone. So an `alert` badge may
 * instead declare `allergen: "<tag>"`: it is then DERIVED from the item's
 * allergen list and is never tagged by hand. Consequences, all deliberate:
 *
 *   - There is exactly one source of truth for "this dish contains nuts".
 *   - You cannot untag it. Removing the warning means editing the allergen
 *     record, which is the actual claim.
 *   - Promoting an allergen to a badge is how a restaurant says "make THIS one
 *     prominent"; the guest surfaces drop it from the plain allergen chip row
 *     so the same fact is never printed twice (see badgeCoveredAllergens).
 */

export type MenuBadgeKind = "alert" | "diet" | "promo";

/** Render order. Safety first, identity next, marketing last — see the header. */
export const MENU_BADGE_KINDS: MenuBadgeKind[] = ["alert", "diet", "promo"];

/**
 * Kinds a tenant may NOT silently drop while dishes still carry them. Losing a
 * "Bestseller" sticker costs nothing; losing "Jain" or "Contains nuts" from
 * forty dishes at once is a safety regression that looks like a UI tidy-up.
 * SetMenuBadgeCatalogue refuses those removals unless the caller explicitly
 * releases the tagged items (see MenuBadgeSafetyError).
 */
export const MENU_BADGE_PROTECTED_KINDS: MenuBadgeKind[] = ["alert", "diet"];

export const MENU_BADGE_MAX = 24;          // catalogue size
export const MENU_BADGE_ID_MAX = 32;
export const MENU_BADGE_LABEL_MAX = 24;
/** Tags per item. A dish wearing ten stickers communicates nothing. */
export const MENU_BADGE_PER_ITEM_MAX = 8;

export interface MenuBadge {
  /** Stable slug. Tags reference this, so it never changes once created. */
  id: string;
  /** What guests read. Freely editable — renaming keeps every tag intact. */
  label: string;
  kind: MenuBadgeKind;
  /** Disabled badges keep their tags but render nowhere. */
  enabled: boolean;
  /**
   * `alert` only. When set, the badge is DERIVED from the item's allergen list
   * rather than tagged, and the matching plain allergen chip is suppressed on
   * the guest surfaces (see the header). Lowercased, matches sanitizeAllergens'
   * vocabulary.
   */
  allergen?: string;
}

/**
 * The starter set the editors offer with one click. NOT applied automatically —
 * a tenant who never opens the editor keeps an empty catalogue and sees nothing
 * change. Chosen for Indian restaurants specifically:
 *
 *  - veg / non_veg — the single most load-bearing fact on an Indian menu, and
 *    often religious rather than preference. Both exist because on a mixed menu
 *    an UNTAGGED dish reads as "nobody got round to tagging it", not "non-veg".
 *  - egg — "eggetarian" is a real and common category here. Folding egg into
 *    non-veg is wrong; folding it into veg is worse.
 *  - jain — no onion, garlic or root vegetables. A hard constraint a Jain diner
 *    cannot resolve by asking whether a dish is vegetarian.
 *  - vegan — ghee, cream, paneer and butter are everywhere in Indian cooking,
 *    so "veg" tells a vegan almost nothing.
 *  - halal — a genuine and commonly asked-for claim.
 *  - spicy — heat level, the most frequent question a waiter is asked.
 *  - contains_nuts — cashew and almond paste are default thickeners in North
 *    Indian gravies, exactly where a guest would not expect them. This is the
 *    badge that prevents an emergency.
 *  - contains_dairy — ghee in the dal, cream in the makhani. Under-declared,
 *    and the audience (lactose-intolerant, vegan) is large.
 *  - must_try / chefs_special / bestseller / new — the owner's own
 *    recommendation, which is what was actually asked for. "Bestseller" is
 *    included because Swiggy and Zomato have already taught Indian diners to
 *    read it.
 *
 * The two `contains_*` entries carry `allergen`, so they are derived from the
 * dish's allergen list instead of being tagged twice (see the header).
 */
export const MENU_BADGE_PRESETS: MenuBadge[] = [
  { id: "must_try", label: "Must Try", kind: "promo", enabled: true },
  { id: "chefs_special", label: "Chef's Special", kind: "promo", enabled: true },
  { id: "bestseller", label: "Bestseller", kind: "promo", enabled: true },
  { id: "new", label: "New", kind: "promo", enabled: true },
  { id: "veg", label: "Veg", kind: "diet", enabled: true },
  { id: "non_veg", label: "Non-veg", kind: "diet", enabled: true },
  { id: "egg", label: "Contains egg", kind: "diet", enabled: true },
  { id: "jain", label: "Jain", kind: "diet", enabled: true },
  { id: "vegan", label: "Vegan", kind: "diet", enabled: true },
  { id: "halal", label: "Halal", kind: "diet", enabled: true },
  { id: "spicy", label: "Spicy", kind: "alert", enabled: true },
  { id: "contains_nuts", label: "Contains nuts", kind: "alert", enabled: true, allergen: "nuts" },
  { id: "contains_dairy", label: "Contains dairy", kind: "alert", enabled: true, allergen: "dairy" },
];

/** Slugify a label into a badge id: lowercase, ASCII-ish, `_` separated. */
export function menuBadgeSlug(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  return text
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")          // "Chef's" -> "chefs", not "chef_s"
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MENU_BADGE_ID_MAX);
}

function badgeLabel(raw: unknown, fallback: string): string {
  const text = typeof raw === "string"
    // Plain text only, single line — this is rendered straight into a chip.
    ? raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, MENU_BADGE_LABEL_MAX).trim()
    : "";
  return text || fallback;
}

function badgeKind(raw: unknown): MenuBadgeKind {
  // Unknown kinds fall back to `promo` — the SAFE direction. A typo must never
  // silently promote a marketing sticker into the always-visible safety lane.
  return MENU_BADGE_KINDS.includes(raw as MenuBadgeKind) ? (raw as MenuBadgeKind) : "promo";
}

/** Allergen link, matching sanitizeAllergens' shape (trimmed, lowercase, ≤24). */
function badgeAllergen(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase().slice(0, 24) : "";
}

/**
 * Coerce arbitrary input into a clean badge catalogue: valid ids, capped
 * labels, known kinds, de-duplicated by id, capped in count. Order is the
 * caller's and is PRESERVED — it is what the editors drag and what every
 * surface renders within a kind.
 *
 * Anything unusable is dropped rather than defaulted, so a malformed write
 * cannot invent a badge nobody configured.
 */
export function sanitizeMenuBadgeCatalogue(raw: unknown): MenuBadge[] {
  if (!Array.isArray(raw)) {return [];}
  const out: MenuBadge[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {continue;}
    const b = entry as Record<string, unknown>;
    // An explicit id wins; otherwise derive one from the label so an editor can
    // create a badge by typing a name alone.
    const id = menuBadgeSlug(typeof b.id === "string" && b.id.trim() ? b.id : b.label);
    if (!id || seen.has(id)) {continue;}
    const kind = badgeKind(b.kind);
    const badge: MenuBadge = {
      id,
      label: badgeLabel(b.label, id.replace(/_/g, " ")),
      kind,
      // Absent = enabled. A payload from a client that predates the flag must
      // not silently switch every badge off.
      enabled: b.enabled !== false,
    };
    // Only `alert` badges may be allergen-derived; the link is meaningless (and
    // would wrongly suppress an allergen chip) on the other kinds.
    const allergen = kind === "alert" ? badgeAllergen(b.allergen) : "";
    if (allergen) {badge.allergen = allergen;}
    out.push(badge);
    seen.add(id);
    if (out.length >= MENU_BADGE_MAX) {break;}
  }
  return out;
}

/**
 * Coerce an item's badge tags: slugified ids, deduped, capped. Deliberately
 * does NOT consult the catalogue — the sanitizer runs inside
 * encodeMenuDescription, which has no tenant context, and a tag for a badge
 * that is momentarily disabled must survive being re-saved. Unknown ids are
 * dropped at RENDER time instead (resolveMenuBadges), the same way the waitlist
 * pre-order drops items that left the menu.
 */
export function sanitizeMenuBadgeIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {return [];}
  const out: string[] = [];
  for (const entry of raw) {
    const id = menuBadgeSlug(entry);
    if (id && !out.includes(id)) {out.push(id);}
    if (out.length >= MENU_BADGE_PER_ITEM_MAX) {break;}
  }
  return out;
}

/** The enabled slice of a catalogue, in catalogue order. */
export function enabledMenuBadges(catalogue: MenuBadge[]): MenuBadge[] {
  return catalogue.filter((b) => b.enabled);
}

/** The allergen an `alert` badge is derived from, or "" when it is hand-tagged. */
export function menuBadgeAllergen(badge: MenuBadge): string {
  return badge.kind === "alert" && typeof badge.allergen === "string" ? badge.allergen : "";
}

/** Badge ids a tenant may not hand-tag: they are derived from the allergen list. */
export function isDerivedMenuBadge(badge: MenuBadge): boolean {
  return menuBadgeAllergen(badge).length > 0;
}

/**
 * Allergen tags an ENABLED derived badge already speaks for. The guest surfaces
 * subtract these from the plain allergen chip row so "nuts" is never printed
 * twice — once loudly as a badge and once quietly as a chip.
 */
export function badgeCoveredAllergens(catalogue: MenuBadge[]): string[] {
  const out: string[] = [];
  for (const b of enabledMenuBadges(catalogue)) {
    const allergen = menuBadgeAllergen(b);
    if (allergen && !out.includes(allergen)) {out.push(allergen);}
  }
  return out;
}

/**
 * The badges a guest sees on one dish, ready to render.
 *
 *   tagged    — the item's `badges` ids. Unknown/disabled ids are dropped, and
 *               so is any id that belongs to a DERIVED badge (that one is not
 *               a tag, it is a consequence of the allergen list).
 *   derived   — every enabled allergen-linked alert whose tag is in `allergens`.
 *
 * Ordered by kind (alert -> diet -> promo) and then by catalogue position, so
 * the restaurant's own ordering decides ties and the safety lane can never be
 * pushed off the end of a card by marketing.
 */
export function resolveMenuBadges(
  catalogue: MenuBadge[],
  tagged: unknown,
  allergens: unknown,
): MenuBadge[] {
  const enabled = enabledMenuBadges(catalogue);
  if (enabled.length === 0) {return [];}

  const taggedIds = new Set(sanitizeMenuBadgeIds(tagged));
  const allergenTags = new Set(
    (Array.isArray(allergens) ? allergens : [])
      .map((a) => (typeof a === "string" ? a.trim().toLowerCase() : ""))
      .filter(Boolean),
  );

  const picked: { badge: MenuBadge; index: number }[] = [];
  enabled.forEach((badge, index) => {
    const derivedFrom = menuBadgeAllergen(badge);
    const hit = derivedFrom ? allergenTags.has(derivedFrom) : taggedIds.has(badge.id);
    if (hit) {picked.push({ badge, index });}
  });

  picked.sort((a, b) => {
    const rank = MENU_BADGE_KINDS.indexOf(a.badge.kind) - MENU_BADGE_KINDS.indexOf(b.badge.kind);
    return rank !== 0 ? rank : a.index - b.index;
  });
  return picked.map((p) => p.badge);
}

/**
 * Split a resolved list for a space-constrained surface. `alert` and `diet`
 * always survive whole; only `promo` is capped, and the overflow count is
 * returned so a card can render "+2" rather than silently losing them.
 *
 * `promoLimit` of 0 hides marketing entirely (the queue row does this when it
 * is tight) but still shows every safety and dietary badge.
 */
export function capMenuBadges(
  resolved: MenuBadge[],
  promoLimit: number,
): { shown: MenuBadge[]; hidden: number } {
  const limit = Number.isFinite(promoLimit) && promoLimit >= 0 ? Math.floor(promoLimit) : 0;
  const shown: MenuBadge[] = [];
  let promoSeen = 0;
  let hidden = 0;
  for (const badge of resolved) {
    if (badge.kind !== "promo") { shown.push(badge); continue; }
    if (promoSeen < limit) { shown.push(badge); promoSeen++; }
    else { hidden++; }
  }
  return { shown, hidden };
}
