/**
 * MENU GROUPS + VARIATIONS, THE EDITING RULES (migration 039's route half).
 *
 * PURE module — no database, no clock, no network. Same discipline as
 * menu_badges.ts, billing_math.ts and mis_capture.ts, and for the same reason:
 * every rule below decides either what an owner's edit does to a stored row or
 * what a guest is shown to pick from, so jest has to be able to exercise it
 * without a pg pool. database_supabase.ts re-exports everything here.
 *
 * WHAT IS HERE, AND WHAT DELIBERATELY IS NOT.
 *   HERE — the MERGE rules an editing route applies over the row it snapshotted,
 *   and the shaping of the variation list a guest page is served.
 *   NOT HERE — the classification (mis_capture.ts owns the group resolution and
 *   attributeOrderLine) and the pricing (applyMenuPriceFloor / repriceFromMenu
 *   own the floor, because the floor is money and money composes into
 *   billing_math.ts's ladder).
 *
 * ============================================================================
 * WHY EVERY WRITE IS A MERGE OVER A SNAPSHOT, AND NEVER A REPLACE
 * ============================================================================
 * This codebase has already paid for the alternative: a full-replace bulk save
 * wiped 56 menu items' images, sections and recipes, and the rule that came out
 * of it is that a field ABSENT from a payload means "keep what is stored", never
 * "clear it". A group and a variation are smaller rows than a menu item, but a
 * variation carries a PRICE — and a client that sends {id, active:false} to
 * retire a Half plate must not thereby reset its price to zero, because a zero
 * price is a zero FLOOR and every line naming that variation could then be rung
 * in at nothing. So an edit route:
 *
 *   1. reads the stored row (the snapshot),
 *   2. merges the request over it HERE, producing a complete row,
 *   3. writes that complete row.
 *
 * A create is the same call with a null snapshot and the documented defaults.
 *
 * ============================================================================
 * WHY A ZERO PRICE IS REFUSED EVEN THOUGH THE SCHEMA ALLOWS IT
 * ============================================================================
 * 039's CHECK is `price >= 0`. POST /menu already refuses a zero-priced ITEM
 * with the argument that it "silently stored a ₹0 dish — free food that also
 * poisons the order-path re-pricing floor". That argument is STRONGER for a
 * variation: applyMenuPriceFloor floors a line naming a variation at the
 * VARIATION's price, so a ₹0 variation is a standing invitation to ring any
 * quantity of that dish in at ₹0 with the bill still printing its name. Free
 * food is a non-chargeable (migration 034), which is a different act with a
 * reason, an authoriser and a ledger row. So the vocabulary here is the same one
 * the menu-item route uses: a price must be a positive finite number.
 */

import { MENU_GROUP_KINDS, normalizeVocabulary, type MenuGroupKind } from "./mis_capture.js";

/** Same bound both new tables' names are sliced to in the data layer. */
export const MENU_TAXONOMY_NAME_MAX = 60;

/**
 * Sort order is a small signed integer: negative is legitimate ("pin this group
 * above everything"), and the bound only exists so a client cannot store a value
 * that overflows the smallint-shaped expectations of a picker.
 */
export const MENU_TAXONOMY_SORT_MIN = -9999;
export const MENU_TAXONOMY_SORT_MAX = 9999;

/** A stored group, as the merge needs to read it. */
export interface StoredMenuGroup {
  id: string;
  name: string;
  kind: MenuGroupKind;
  active: boolean;
  sort_order: number;
}

/** A stored variation, as the merge needs to read it. */
export interface StoredMenuVariation {
  id: string;
  menu_id: string;
  name: string;
  price: number;
  is_default: boolean;
  active: boolean;
  sort_order: number;
}

/** The complete group row an edit route writes. */
export interface MenuGroupWrite {
  name: string;
  kind: MenuGroupKind;
  active: boolean;
  sort_order: number;
}

/** The complete variation row an edit route writes. */
export interface MenuVariationWrite {
  menu_id: string;
  name: string;
  price: number;
  is_default: boolean;
  active: boolean;
  sort_order: number;
}

/**
 * Merge outcome. A refusal carries the sentence the route puts in the 400 — the
 * caller is a menu editor with a human in front of it, and "invalid input" is
 * not something that human can act on.
 */
export type MergeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** Collapse whitespace and bound, exactly as the data layer stores it. */
function cleanName(raw: unknown): string {
  return (typeof raw === "string" ? raw : "").replace(/\s+/g, " ").trim().slice(0, MENU_TAXONOMY_NAME_MAX);
}

/** `undefined` when the key was absent, so "absent" and "invalid" stay distinct. */
function presentString(body: Record<string, unknown>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined && body[key] !== null
    ? String(body[key])
    : undefined;
}

function mergeBoolean(body: Record<string, unknown>, key: string, stored: boolean | undefined, fallback: boolean): boolean {
  return typeof body[key] === "boolean" ? (body[key] as boolean) : stored ?? fallback;
}

/**
 * sort_order, merged. A non-numeric value is IGNORED rather than refused: it is
 * a presentation hint, and refusing a whole rename because a picker sent "" for
 * the position would fail an edit that has nothing wrong with it.
 */
function mergeSortOrder(body: Record<string, unknown>, stored: number | undefined): number {
  const raw = body.sort_order;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) {return Math.round(stored ?? 0);}
  return Math.min(MENU_TAXONOMY_SORT_MAX, Math.max(MENU_TAXONOMY_SORT_MIN, Math.round(n)));
}

/**
 * Merge an edit over a stored group (or over nothing, for a create).
 *
 * `kind` is refused when it is PRESENT and unrecognised rather than defaulted to
 * "revenue" — the same rule normalizeVocabulary states for every other
 * controlled vocabulary. A group filed on the wrong axis is invisible to the
 * report that asks for the other one, so a typo must be told, not absorbed.
 */
export function mergeMenuGroupPatch(
  stored: StoredMenuGroup | null,
  body: Record<string, unknown>,
): MergeResult<MenuGroupWrite> {
  const rawKind = presentString(body, "kind");
  let kind: MenuGroupKind;
  if (rawKind !== undefined && rawKind.trim() !== "") {
    const parsed = normalizeVocabulary(rawKind, MENU_GROUP_KINDS);
    if (!parsed) {return { ok: false, error: `kind must be one of: ${MENU_GROUP_KINDS.join(", ")}` };}
    kind = parsed;
  } else {
    kind = stored?.kind ?? "revenue";
  }

  const rawName = presentString(body, "name");
  const name = rawName !== undefined ? cleanName(rawName) : (stored?.name ?? "");
  if (!name) {return { ok: false, error: "A group name is required" };}

  return {
    ok: true,
    value: {
      name,
      kind,
      active: mergeBoolean(body, "active", stored?.active, true),
      sort_order: mergeSortOrder(body, stored?.sort_order),
    },
  };
}

/**
 * Merge an edit over a stored variation (or over nothing, for a create).
 *
 * A variation CANNOT BE MOVED to another dish. Its id is stamped onto order
 * lines (039), so re-pointing it would silently relabel every past sale that
 * named it — the "Half" on last month's bills would start reporting under a
 * different dish. Retire it and create the variation on the other dish instead.
 */
export function mergeMenuVariationPatch(
  stored: StoredMenuVariation | null,
  body: Record<string, unknown>,
): MergeResult<MenuVariationWrite> {
  const rawMenuId = presentString(body, "menu_id");
  const menuId = stored ? stored.menu_id : (rawMenuId ?? "").trim();
  if (!menuId) {return { ok: false, error: "menu_id is required" };}
  if (stored && rawMenuId !== undefined && rawMenuId.trim() !== "" && rawMenuId.trim() !== stored.menu_id) {
    return { ok: false, error: "A variation cannot be moved to another dish. Retire it and add it to the other dish instead." };
  }

  const rawName = presentString(body, "name");
  const name = rawName !== undefined ? cleanName(rawName) : (stored?.name ?? "");
  if (!name) {return { ok: false, error: "A variation name is required" };}

  let price: number;
  if (Object.prototype.hasOwnProperty.call(body, "price") && body.price !== undefined && body.price !== null && String(body.price).trim() !== "") {
    const n = Number(body.price);
    // The same sentence PATCH /menu/:id/price and POST /menu use, for the same
    // reason — see this module's header on why zero is refused here too.
    if (!Number.isFinite(n) || n <= 0) {return { ok: false, error: "price must be a positive number" };}
    price = Math.round(n * 100) / 100;
  } else if (stored) {
    price = stored.price;
  } else {
    return { ok: false, error: "price must be a positive number" };
  }

  return {
    ok: true,
    value: {
      menu_id: menuId,
      name,
      price,
      is_default: mergeBoolean(body, "is_default", stored?.is_default, false),
      active: mergeBoolean(body, "active", stored?.active, true),
      sort_order: mergeSortOrder(body, stored?.sort_order),
    },
  };
}

// ============================================================================
// WHAT A GUEST IS SHOWN
// ============================================================================

/** One variation as the public QR menu serves it. */
export interface PublicMenuVariation {
  id: string;
  name: string;
  price: number;
  is_default: boolean;
}

/** The shape publicVariationsByItem reads. Matches MenuVariationRecord. */
export interface VariationSourceRow {
  id: string;
  menu_id: string;
  name: string;
  price: number;
  is_default: boolean;
  active: boolean;
  sort_order: number;
}

/**
 * Group the outlet's variations by dish, in the order a guest sees them.
 *
 * INACTIVE VARIATIONS ARE DROPPED. A retired price point must still resolve when
 * a REPORT reads an old order line that named it (which is why the attribution
 * index keeps them), but it must never be offerable again — the guest surface
 * and the report surface are asking two different questions of the same row.
 *
 * AT MOST ONE DEFAULT SURVIVES per dish. 039 deliberately declined to constrain
 * `is_default` to one row ("a dish may legitimately force the guest to choose"),
 * which leaves two rows able to claim it after a careless edit. Two pre-selected
 * options is not a state a picker can render, and the two clients that guess
 * differently would show two different prices for the same dish. So the FIRST in
 * (sort_order, name) keeps the flag and the rest are served with is_default
 * false — a presentation rule, applied once here, that never rewrites the row.
 */
export function publicVariationsByItem(
  rows: readonly VariationSourceRow[],
): Map<string, PublicMenuVariation[]> {
  // Sorted with the row's sort_order and its arrival index carried alongside, so
  // the comparator never looks back into `rows` (a find() inside a sort is a
  // quadratic scan of the whole outlet's menu on every guest page load).
  const staged = new Map<string, { v: PublicMenuVariation; sort: number; seq: number }[]>();
  let seq = 0;
  for (const r of rows) {
    if (r.active !== true) {continue;}
    const menuId = String(r.menu_id ?? "");
    if (!menuId) {continue;}
    const entry = {
      v: {
        id: String(r.id),
        name: String(r.name),
        price: Math.round(Number(r.price) * 100) / 100,
        is_default: r.is_default === true,
      },
      sort: Number.isFinite(Number(r.sort_order)) ? Math.round(Number(r.sort_order)) : 0,
      seq: seq++,
    };
    const list = staged.get(menuId);
    if (list) {list.push(entry);} else {staged.set(menuId, [entry]);}
  }

  const byItem = new Map<string, PublicMenuVariation[]>();
  for (const [menuId, list] of staged.entries()) {
    list.sort((a, b) => {
      if (a.sort !== b.sort) {return a.sort - b.sort;}
      const na = a.v.name.toLowerCase();
      const nb = b.v.name.toLowerCase();
      if (na !== nb) {return na < nb ? -1 : 1;}
      return a.seq - b.seq;
    });
    let seenDefault = false;
    for (const e of list) {
      if (!e.v.is_default) {continue;}
      if (seenDefault) {e.v.is_default = false;} else {seenDefault = true;}
    }
    byItem.set(menuId, list.map((e) => e.v));
  }
  return byItem;
}

/**
 * The variation key to SPREAD onto a guest menu item.
 *
 * Returns `{}` — not `{ variations: [] }` — for a dish with no variations, which
 * is EVERY dish on EVERY restaurant that has not configured any. That is what
 * makes the absent-config guarantee literal rather than approximate: the guest
 * payload of a tenant without variations is byte-identical to the payload it was
 * served before this feature existed, the same contract `posters` and
 * `brand_config` already follow on these routes.
 */
export function variationPayloadFor(
  menuId: unknown,
  byItem: Map<string, PublicMenuVariation[]>,
): { variations?: PublicMenuVariation[] } {
  const list = byItem.get(String(menuId ?? ""));
  return list && list.length > 0 ? { variations: list } : {};
}
