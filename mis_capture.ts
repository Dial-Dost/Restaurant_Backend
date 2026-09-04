/**
 * THE PURE RULES BEHIND THE SIX MIS DATA-CAPTURE MIGRATIONS (034-039).
 *
 * PURE module: it imports only the other pure modules and touches no database,
 * no clock and no network. Same discipline as billing_math.ts /
 * mis_report_math.ts / report_window.ts / simulation_math.ts, and for the same
 * reason: every rule below is decided by value, so jest can prove it without a
 * pg pool.
 *
 * WHAT IS HERE, AND WHAT DELIBERATELY IS NOT.
 *   HERE — the CLASSIFICATION rules: the controlled vocabularies every capture
 *   table CHECKs, the void-stage derivation, and the menu attribution that lets
 *   a name-only order line be reported by group and variation.
 *   NOT HERE — MONEY. The non-chargeable reduction, the service-charge waiver
 *   arithmetic and the tender reconciliation all live in billing_math.ts,
 *   beside computeBillCharges, because they must compose with it rather than
 *   beside it. Two modules that both know how a service charge works is exactly
 *   the drift the money ladder's header warns about.
 */

// ============================================================================
// THE CONTROLLED VOCABULARIES
// ============================================================================
//
// Each of these mirrors a CHECK constraint in migrations 034-039. They are
// restated here — rather than left to the database to reject — because a bad
// value should fail as a 400 at the edge with a readable message, not as a
// 23514 from Postgres halfway through a transaction that has already written
// half of a money edit. The database keeps its CHECK regardless: an application
// that validates and a schema that does not is one refactor away from accepting
// anything.

/** Why a dish was given away. Mirrors 034's nc_kind CHECK. */
export const NON_CHARGEABLE_KINDS = [
  "complimentary", "staff_meal", "spoilage", "tasting", "guest_complaint", "promo",
] as const;
export type NonChargeableKind = (typeof NON_CHARGEABLE_KINDS)[number];

/** Why an order or line was voided. Mirrors 035's void_kind CHECK. */
export const VOID_KINDS = [
  "wrong_entry", "guest_changed_mind", "kitchen_error", "duplicate", "test_order",
  "item_unavailable", "other",
] as const;
export type VoidKind = (typeof VOID_KINDS)[number];

/** The three stages, in ascending order of how much an auditor cares. */
export const VOID_STAGES = ["before_print", "after_print", "after_bill"] as const;
export type VoidStage = (typeof VOID_STAGES)[number];

/** Why a service charge came off. Mirrors 036's waiver_kind CHECK. */
export const SERVICE_CHARGE_WAIVER_KINDS = [
  "guest_request", "guest_complaint", "goodwill", "staff_meal", "policy", "other",
] as const;
export type ServiceChargeWaiverKind = (typeof SERVICE_CHARGE_WAIVER_KINDS)[number];

/** How a tip arrived. Mirrors 037's tip_mode CHECK. */
export const TIP_MODES = ["cash", "card", "upi", "wallet", "other"] as const;
export type TipMode = (typeof TIP_MODES)[number];

/** A billing point, or a device that rings for one. Mirrors 038's kind CHECK. */
export const COUNTER_KINDS = ["counter", "terminal"] as const;
export type CounterKind = (typeof COUNTER_KINDS)[number];

/** The two axes a menu group can classify on. Mirrors 039's kind CHECK. */
export const MENU_GROUP_KINDS = ["revenue", "production"] as const;
export type MenuGroupKind = (typeof MENU_GROUP_KINDS)[number];

/**
 * Coerce raw input to one of a vocabulary, or null.
 *
 * Returns NULL rather than falling back to a default. A giveaway recorded as
 * "complimentary" because the client sent a typo is a fabricated reason in a
 * fraud-control document, and the caller must be told to send a real one.
 */
export function normalizeVocabulary<T extends string>(
  raw: unknown,
  allowed: readonly T[],
): T | null {
  const v = (typeof raw === "string" ? raw : "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

/**
 * A required free-text reason, trimmed and bounded.
 *
 * Empty is NOT a reason and returns null so the caller 400s. The 300-character
 * bound matches what a control report can render in a column without truncating
 * mid-sentence; anything longer is a note, not a reason.
 */
export function normalizeReason(raw: unknown, max = 300): string | null {
  const s = (typeof raw === "string" ? raw : "").replace(/\s+/g, " ").trim();
  return s.length > 0 ? s.slice(0, max) : null;
}

// ============================================================================
// THE VOID STAGE — migration 035
// ============================================================================

/**
 * The facts the SERVER holds about an order at the moment it is voided. Every
 * one of them is read from the database by the caller; none is client-supplied,
 * which is the entire point (see 035's header: the person whose void it is has
 * an obvious interest in it reading "before_print").
 */
export interface VoidStageFacts {
  /**
   * A "Bills" row for this order's table, raised at or before the void and
   * belonging to the CURRENT seating. A bill row is only ever minted by
   * generating, discounting, couponing or settling a bill — i.e. by an act the
   * guest can see.
   */
  bill?: { id: string; bill_no: string | null; created_at: string } | null;
  /** "Orders".barked_at — the expo announced the order to the kitchen (016). */
  barked_at?: string | null;
  /**
   * A "PrintJobs" row of kind='kot' for this table, enqueued at or after the
   * order was created (027). Proof paper reached a kitchen even on a tenant
   * whose floor never uses the bark step.
   */
  kot_print?: { id: string; created_at: string } | null;
}

/** What deriveVoidStage decided, and the facts it decided it from. */
export interface VoidStageDerivation {
  stage: VoidStage;
  /**
   * The evidence, stored verbatim in "OrderVoids".stage_evidence. Keys are
   * present ONLY when that fact was actually found, so `{}` is a truthful
   * "before_print: nothing could be shown" rather than a claim that three
   * separate checks were run and all returned false.
   */
  evidence: Record<string, unknown>;
}

/**
 * Derive the stage of a void from server-held facts.
 *
 * PRIORITY IS DESCENDING SUSPICION, and it is not negotiable:
 *   after_bill  beats everything. A bill existed; the guest could have paid.
 *   after_print next. The kitchen had it; real food was committed.
 *   before_print only when neither could be shown.
 *
 * An order can obviously be all three at once (barked, printed, billed) — the
 * question a control report asks is "how far had this gone", and the answer is
 * the furthest point reached, not the first one found.
 *
 * A `null` return is impossible: before_print is the floor, and it is an honest
 * floor because it is stated as "no evidence of print or bill was found" rather
 * than as "this was definitely voided before printing".
 */
export function deriveVoidStage(facts: VoidStageFacts): VoidStageDerivation {
  const evidence: Record<string, unknown> = {};

  if (facts.bill) {
    evidence.bill_id = facts.bill.id;
    if (facts.bill.bill_no !== null && facts.bill.bill_no !== undefined) {
      evidence.bill_no = facts.bill.bill_no;
    }
    evidence.bill_created_at = facts.bill.created_at;
  }
  const barked = typeof facts.barked_at === "string" && facts.barked_at.trim().length > 0
    ? facts.barked_at
    : null;
  if (barked) {evidence.barked_at = barked;}
  if (facts.kot_print) {
    evidence.kot_print_job_id = facts.kot_print.id;
    evidence.kot_printed_at = facts.kot_print.created_at;
  }

  if (facts.bill) {return { stage: "after_bill", evidence };}
  if (barked || facts.kot_print) {return { stage: "after_print", evidence };}
  return { stage: "before_print", evidence };
}

// ============================================================================
// MENU ATTRIBUTION — migration 039
// ============================================================================
//
// An order line records a NAME. That is why no report today can say what a sale
// belonged to. 039 makes new lines carry `menu_id` / `variation_id`, stamped
// server-side; this is the resolution that reads them, and the fallback that
// keeps every line written before then reportable.

/** The bucket a line lands in when nothing resolves. Never a guessed group. */
export const UNCLASSIFIED_GROUP = "Unclassified";

/** One variation of one dish, as the index needs it. */
export interface MenuVariationRef {
  id: string;
  name: string;
  price: number;
}

/**
 * One menu row, with its group ALREADY RESOLVED by the caller's SQL (item
 * override -> category default -> null). Resolving the override here would mean
 * carrying both ids through every read for no benefit: the precedence is a
 * single COALESCE in one query.
 */
export interface MenuAttributionRow {
  id: string;
  name: string;
  group_id: string | null;
  group_name: string | null;
  variations?: MenuVariationRef[];
}

/** The lookup structure attributeOrderLine reads. Built once per report/write. */
export interface MenuAttributionIndex {
  byId: Map<string, MenuAttributionRow>;
  byName: Map<string, MenuAttributionRow>;
  variationById: Map<string, { variation: MenuVariationRef; item: MenuAttributionRow }>;
}

/**
 * Build the index.
 *
 * byName is keyed on the trimmed lowercase name — the SAME key applyMenuPriceFloor
 * has always used to resolve an unstamped line, so a legacy line attributes to
 * exactly the menu row whose price it was floored against. Duplicate names keep
 * the FIRST row (menu reads come back ordered), matching that function's
 * `new Map(menu.map(...))` behaviour, which keeps the LAST — the difference is
 * only reachable on a menu with two identically-named dishes in two categories,
 * where neither answer is more right than the other and the important thing is
 * that one is chosen deterministically.
 */
export function buildMenuAttributionIndex(rows: readonly MenuAttributionRow[]): MenuAttributionIndex {
  const byId = new Map<string, MenuAttributionRow>();
  const byName = new Map<string, MenuAttributionRow>();
  const variationById = new Map<string, { variation: MenuVariationRef; item: MenuAttributionRow }>();
  for (const row of rows) {
    byId.set(String(row.id), row);
    const key = row.name.trim().toLowerCase();
    if (key && !byName.has(key)) {byName.set(key, row);}
    for (const v of row.variations ?? []) {
      variationById.set(String(v.id), { variation: v, item: row });
    }
  }
  return { byId, byName, variationById };
}

/** How a line's menu row was found. Reported so a gap is never mistaken for a fact. */
export type AttributionSource =
  /** The line carries a server-stamped menu_id (written since migration 039). */
  | "stamped"
  /** No menu_id, but the line's own id happens to be one (pre-039 accident). */
  | "legacy_id"
  /** Resolved by name — the only route open to a pre-039 line. */
  | "legacy_name"
  /** Nothing matched: a deleted dish, a renamed one, an off-menu or fee line. */
  | "unresolved";

/** What one order line attributes to. */
export interface OrderLineAttribution {
  menu_id: string | null;
  menu_name: string | null;
  group_id: string | null;
  /** UNCLASSIFIED_GROUP when nothing resolved — never a nearest match. */
  group_name: string;
  variation_id: string | null;
  variation_name: string | null;
  source: AttributionSource;
}

/** The subset of an order line attribution reads. */
export interface AttributableLine {
  id?: unknown;
  name?: unknown;
  /** Stamped by applyMenuPriceFloor since migration 039. */
  menu_id?: unknown;
  variation_id?: unknown;
  variation_name?: unknown;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Attribute one order line to a menu row, a group and a variation.
 *
 * THE RESOLUTION ORDER, and why each step exists:
 *   1. `menu_id`      — stamped by the server since 039. Authoritative.
 *   2. the line's own `id` — a pre-039 line's id IS the menu id when the dish
 *      was ordered once and never re-added (AddOrder's merge path mints a fresh
 *      uuid for added quantities, which is what destroys the link). Cheap to
 *      check and it recovers a real slice of history.
 *   3. the line's NAME — the only route left, and the same lookup
 *      applyMenuPriceFloor already trusts enough to enforce a price floor with.
 *   4. nothing        — UNCLASSIFIED_GROUP, source "unresolved". Never guessed.
 *
 * WHAT A PRE-039 LINE REPORTS AS, stated once: its group is whatever the dish is
 * classified as TODAY (a classification correction must apply retroactively —
 * see 039's header), and its variation is null, because a line written before
 * variations existed is a base-price sale by definition. A variation is never
 * inferred from a name suffix: "Paneer Tikka (Half)" typed by a waiter as an
 * off-menu line is not evidence that a Half variation was sold.
 */
export function attributeOrderLine(
  line: AttributableLine | null | undefined,
  index: MenuAttributionIndex,
): OrderLineAttribution {
  const l = line ?? {};
  const stampedMenuId = text(l.menu_id);
  const lineId = text(l.id);
  const name = text(l.name);

  let item: MenuAttributionRow | undefined;
  let source: AttributionSource = "unresolved";
  if (stampedMenuId) {
    item = index.byId.get(stampedMenuId);
    if (item) {source = "stamped";}
  }
  if (!item && lineId) {
    item = index.byId.get(lineId);
    if (item) {source = "legacy_id";}
  }
  if (!item && name) {
    item = index.byName.get(name.toLowerCase());
    if (item) {source = "legacy_name";}
  }

  // A stamped variation resolves on its own id. It is only honoured when it
  // belongs to the item we resolved (or when nothing else resolved but the
  // variation itself did, which pins the item too) — a variation id pointing at
  // a different dish is a client bug, and reporting the sale under that other
  // dish would move money between menu rows.
  const stampedVariationId = text(l.variation_id);
  let variation: MenuVariationRef | null = null;
  if (stampedVariationId) {
    const hit = index.variationById.get(stampedVariationId);
    if (hit && (!item || hit.item.id === item.id)) {
      variation = hit.variation;
      if (!item) {
        item = hit.item;
        source = "stamped";
      }
    }
  }

  if (!item) {
    return {
      menu_id: null,
      menu_name: null,
      group_id: null,
      group_name: UNCLASSIFIED_GROUP,
      variation_id: null,
      variation_name: null,
      source: "unresolved",
    };
  }

  return {
    menu_id: item.id,
    menu_name: item.name,
    group_id: item.group_id,
    group_name: item.group_name && item.group_name.trim().length > 0 ? item.group_name : UNCLASSIFIED_GROUP,
    variation_id: variation ? variation.id : null,
    // Prefer the LIVE variation label over the snapshot on the line: a renamed
    // "Half" is the same price point, and a report that shows two names for one
    // variation splits a bucket that is not split. The snapshot on the line is
    // for PRINTING a historical bill, where the label the guest saw is the right
    // one; that is a different question and a different reader.
    variation_name: variation ? variation.name : (text(l.variation_name) || null),
    source,
  };
}
