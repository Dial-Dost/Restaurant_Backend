/**
 * The QUEUE PRE-ORDER MENU: which dishes a walk-in still standing in the
 * waitlist may pick from, and how that list presents itself.
 *
 * PURE module — no database, no network, no imports. Same discipline as
 * brand_theme.ts (which database_supabase.ts re-exports): the rules below decide
 * what a real guest can order, so a jest test must be able to import and drive
 * them without dragging in the pg pool.
 *
 * WHY THIS EXISTS -----------------------------------------------------------
 * Until now the queue page showed the WHOLE dine-in menu. A kitchen cannot cook
 * a 40-minute biryani for a party that is still standing at the door, and a bar
 * cannot pour for someone who has not been seated — but those dishes must stay
 * on the dine-in menu, so "mark it unavailable" is not the answer. This is a
 * second, narrower view of the same menu.
 *
 * ABSENT = TODAY ------------------------------------------------------------
 * Every field is optional and an absent/NULL config resolves to exactly the
 * shipped behaviour: the whole available menu, categories sorted alphabetically,
 * prices shown, and the queue page's own headline/intro copy (which is
 * localised EN/HI, so an override is only applied when the tenant typed one).
 * Nothing changes for any existing tenant until they opt in.
 *
 * THE SELECTION RULE --------------------------------------------------------
 * One `mode` plus two lists, unioned:
 *   "all"     — every item (the default).
 *   "include" — ONLY items whose id is in `items`, or whose category is in
 *               `categories`. An allowlist: "just starters and drinks".
 *   "exclude" — everything EXCEPT those. A denylist: "not the biryani".
 * One rule, read the same way in both directions, so an owner never has to
 * reason about an item-level list fighting a category-level one.
 */

/** How `items`/`categories` are read. Absent = "all". */
export type QueueMenuMode = "all" | "include" | "exclude";

export const QUEUE_MENU_MODES: QueueMenuMode[] = ["all", "include", "exclude"];

// Caps. Storage is one jsonb column on "Restaurant" and the payload is read by
// every queuing guest, so the lists are bounded rather than trusted.
export const QUEUE_MENU_HEADLINE_MAX = 80;
export const QUEUE_MENU_INTRO_MAX = 240;
const MAX_ITEM_IDS = 500;
const MAX_CATEGORIES = 120;
const MAX_ID_LEN = 64;
const MAX_CATEGORY_LEN = 80;

/**
 * A tenant's queue pre-order menu customization. Every key is optional at the
 * storage layer (only provided, valid keys are persisted); the read layer
 * applies the shipped defaults — see resolveQueueMenuConfig.
 */
export interface QueueMenuConfig {
  /** How `items`/`categories` are read. Absent = "all" = today. */
  mode?: QueueMenuMode;
  /** Menu item ids the mode applies to. */
  items?: string[];
  /** Category names the mode applies to (matched case-insensitively). */
  categories?: string[];
  /**
   * Categories to float to the front, in this order; everything else follows
   * alphabetically (the shipped order). Names are matched case-insensitively
   * and a name that no longer exists is simply ignored, so renaming a category
   * degrades to the default order instead of hiding it.
   */
  category_order?: string[];
  /** Replaces the queue page's "Get a head start" heading. */
  headline?: string;
  /** Replaces the line under that heading. */
  intro?: string;
  /** Whether the queue menu prints prices. Absent = true = today. */
  show_prices?: boolean;
}

/** The read-time view: every key present, defaults applied, safe to render from. */
export interface ResolvedQueueMenuConfig {
  mode: QueueMenuMode;
  items: string[];
  categories: string[];
  category_order: string[];
  /** "" means "use the page's own localised copy" — never a blank heading. */
  headline: string;
  intro: string;
  show_prices: boolean;
}

/** The minimum shape the rules need. Menu rows carry much more; this is a
 *  structural subset so the module stays free of database types. */
export interface QueueMenuItemLike {
  id: string;
  name: string;
  category?: string | null;
  available?: boolean | null;
}

/** Every key a caller may send. Also the clear-key allowlist, so a stray
 *  property in a write can never be journalled as "removed". */
const QUEUE_MENU_KEYS = ["mode", "items", "categories", "category_order", "headline", "intro", "show_prices"] as const;

const clean = (v: unknown, max: number): string =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

const key = (v: unknown): string => String(v ?? "").trim().toLowerCase();

/** Trimmed, de-duplicated, capped list. Blank entries are dropped — an editor
 *  that sends an empty row must not create a rule that matches nothing forever. */
function stringList(raw: unknown, maxLen: number, maxCount: number): string[] {
  if (!Array.isArray(raw)) {return [];}
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" && typeof entry !== "number") {continue;}
    const v = String(entry).trim().slice(0, maxLen);
    if (!v) {continue;}
    const k = v.toLowerCase();
    if (seen.has(k)) {continue;}
    seen.add(k);
    out.push(v);
    if (out.length >= maxCount) {break;}
  }
  return out;
}

/**
 * Validate a write down to the STORED subset: only keys the caller actually
 * provided AND that pass validation survive. Mirrors sanitizeBrandConfigInput —
 * returning just the valid provided keys is what lets the storage layer
 * merge-on-omit without a bad value ever landing in the column.
 *
 * A key sent as `null` is a deliberate CLEAR and is reported separately (see
 * queueMenuClearKeys) rather than being stored as null.
 */
export function sanitizeQueueMenuConfigInput(raw: unknown): QueueMenuConfig {
  const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: QueueMenuConfig = {};
  if (typeof s.mode === "string" && (QUEUE_MENU_MODES as string[]).includes(s.mode.trim())) {
    out.mode = s.mode.trim() as QueueMenuMode;
  }
  if (Array.isArray(s.items)) {out.items = stringList(s.items, MAX_ID_LEN, MAX_ITEM_IDS);}
  if (Array.isArray(s.categories)) {out.categories = stringList(s.categories, MAX_CATEGORY_LEN, MAX_CATEGORIES);}
  if (Array.isArray(s.category_order)) {out.category_order = stringList(s.category_order, MAX_CATEGORY_LEN, MAX_CATEGORIES);}
  // A headline/intro that trims to nothing is NOT stored as "" — it falls back
  // to the page's own localised copy, which is better than a blank heading.
  if (typeof s.headline === "string") {
    const v = clean(s.headline, QUEUE_MENU_HEADLINE_MAX);
    if (v) {out.headline = v;}
  }
  if (typeof s.intro === "string") {
    const v = clean(s.intro, QUEUE_MENU_INTRO_MAX);
    if (v) {out.intro = v;}
  }
  if (typeof s.show_prices === "boolean") {out.show_prices = s.show_prices;}
  return out;
}

/** Keys the caller explicitly sent as null (or as a blank headline/intro) and
 *  therefore wants REMOVED from storage — back to the shipped default. */
export function queueMenuClearKeys(raw: unknown): string[] {
  const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: string[] = [];
  for (const k of QUEUE_MENU_KEYS) {
    if (!(k in s)) {continue;}
    if (s[k] === null) {out.push(k); continue;}
    // A headline/intro typed back to blank is a CLEAR, not a no-op: without this
    // an owner could never remove custom copy once they had set it.
    if ((k === "headline" || k === "intro") && typeof s[k] === "string" && !clean(s[k], QUEUE_MENU_HEADLINE_MAX)) {
      out.push(k);
    }
  }
  return out;
}

/**
 * Read-time view with the shipped defaults applied, so no caller has to
 * null-check a key. An absent/NULL/garbage stored value resolves to exactly the
 * behaviour that shipped before this feature existed.
 */
export function resolveQueueMenuConfig(stored: unknown): ResolvedQueueMenuConfig {
  const c = sanitizeQueueMenuConfigInput(stored);
  return {
    mode: c.mode ?? "all",
    items: c.items ?? [],
    categories: c.categories ?? [],
    category_order: c.category_order ?? [],
    headline: c.headline ?? "",
    intro: c.intro ?? "",
    show_prices: c.show_prices ?? true,
  };
}

/**
 * Is this tenant actually customizing the queue menu? Lets a client tell "no
 * config" apart from "a config that deliberately shows nothing" — the queue
 * page's "menu unavailable right now" apology is for the first case only.
 */
export function isQueueMenuConfigured(stored: unknown): boolean {
  return Object.keys(sanitizeQueueMenuConfigInput(stored)).length > 0;
}

/**
 * THE gate. One item, one answer — every surface that can put a dish in front of
 * a queuing guest, or accept one back from them, funnels through this.
 *
 * `available === false` items are refused here too: the queue page already hid
 * them client-side, and a sold-out dish must not be pre-orderable by an API
 * caller that skips the page.
 */
export function isQueueMenuItemAllowed(cfg: ResolvedQueueMenuConfig, item: QueueMenuItemLike): boolean {
  if (item.available === false) {return false;}
  if (cfg.mode === "all") {return true;}
  const listed =
    cfg.items.some((id) => key(id) === key(item.id)) ||
    cfg.categories.some((c) => key(c) === key(item.category ?? ""));
  return cfg.mode === "include" ? listed : !listed;
}

/**
 * Category display order: the tenant's `category_order` first (in the order they
 * arranged it), then everything else alphabetically — which IS the shipped
 * order, so an empty `category_order` reproduces it exactly.
 */
export function orderQueueMenuCategories(cfg: ResolvedQueueMenuConfig, categories: string[]): string[] {
  const rest = [...categories].sort((a, b) => a.localeCompare(b));
  if (cfg.category_order.length === 0) {return rest;}
  const rank = new Map<string, number>();
  cfg.category_order.forEach((c, i) => { if (!rank.has(key(c))) {rank.set(key(c), i);} });
  const pinned: string[] = [];
  const tail: string[] = [];
  for (const c of rest) {
    if (rank.has(key(c))) {pinned.push(c);} else {tail.push(c);}
  }
  pinned.sort((a, b) => (rank.get(key(a)) ?? 0) - (rank.get(key(b)) ?? 0));
  return [...pinned, ...tail];
}

/**
 * The whole queue menu in one call: the items a queuing guest may order, and the
 * categories those items fall into, already ordered. Item order inside a
 * category is the menu's own (GetMenuItems' newest-first), untouched.
 */
export function buildQueueMenu<T extends QueueMenuItemLike>(
  cfg: ResolvedQueueMenuConfig,
  items: T[],
): { items: T[]; categories: string[] } {
  const allowed = items.filter((it) => isQueueMenuItemAllowed(cfg, it));
  const seen = new Set<string>();
  const cats: string[] = [];
  for (const it of allowed) {
    const name = String(it.category ?? "").trim();
    if (!name || seen.has(key(name))) {continue;}
    seen.add(key(name));
    cats.push(name);
  }
  return { items: allowed, categories: orderQueueMenuCategories(cfg, cats) };
}
