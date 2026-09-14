// Pure bill/coupon arithmetic — NO database, network, or native dependencies.
//
// This module is deliberately free of imports so the money math can be unit-tested
// in isolation (jest) without loading the heavy `database_supabase.ts` graph
// (pg/sharp/argon2/supabase). `database_supabase.ts` imports and re-exports from here,
// so there is a single source of truth for how a bill total is built.

export function round2(value: number): number {
  return Number((Number(value) || 0).toFixed(2));
}

export interface BillTaxLine { name: string; percentage: number; amount: number }

// Apply a restaurant's configured taxes (e.g. CGST 2.5%, SGST 2.5%) to a
// pre-tax subtotal. Accepts either the outlet's `default_tax` record
// (name -> percentage) or an array of {name, percentage}. Returns each tax line
// with its computed amount, the tax total, and the tax-inclusive grand total.
export function computeBillTaxes(
  subtotal: number,
  taxConfig: Record<string, number> | { name: string; percentage: number }[] | null | undefined,
): { taxes: BillTaxLine[]; tax_total: number; grand_total: number } {
  const base = Number(subtotal) || 0;
  const entries: { name: string; percentage: number }[] = [];
  if (Array.isArray(taxConfig)) {
    for (const t of taxConfig) {
      const name = String(t?.name ?? "").trim();
      const pct = Number(t?.percentage) || 0;
      if (name && pct > 0) {entries.push({ name, percentage: pct });}
    }
  } else if (taxConfig && typeof taxConfig === "object") {
    for (const [name, pct] of Object.entries(taxConfig)) {
      const p = Number(pct) || 0;
      if (name.trim() && p > 0) {entries.push({ name: name.trim(), percentage: p });}
    }
  }
  const taxes = entries.map((e) => ({ name: e.name, percentage: e.percentage, amount: round2((base * e.percentage) / 100) }));
  const tax_total = round2(taxes.reduce((s, t) => s + t.amount, 0));
  const grand_total = round2(base + tax_total);
  return { taxes, tax_total, grand_total };
}

// ============================================================================
// ROUNDING THE BILL TO THE RUPEE — migration 048
// ============================================================================
//
// THE CLIENT'S RECEIPT, which is the specification: "Sub Total 4745.00, SGST
// 2.5% 118.63, CGST 2.5% 118.63, Round off -0.26, Grand Total 4982.00". A guest
// is asked for whole rupees, and the paise are disclosed on their own line.
//
// ROUNDED ONCE, HERE, AND NOWHERE ELSE. Every path that decides what a guest
// owes — the bill view, the printed bill, the four settle writers, tender state,
// split validation, the Razorpay order — already asks computeBillCharges, so
// rounding its grand total is what makes all of them agree without any of them
// knowing rounding exists. The renderers deliberately do NOT round (escpos.ts's
// grandTotal note: a bill SETTLED at 797.55 once PRINTED as 798); they disclose
// the `round_off` this function hands them, exactly as they always could.
//
// IN INTEGER PAISA, TO THE NEAREST RUPEE, HALF UP. 4982.26 -> 4982.00 (-0.26),
// 4982.50 -> 4983.00 (+0.50), 4982.49 -> 4982.00 (-0.49): the CGST Act s.170
// convention and the one on the client's own paper. Paisa because 4982.255 is
// not a number a double holds, and a rounding rule that answers differently for
// two spellings of one amount is not a rule. A bill total is never negative (the
// discount is clamped to the subtotal), so Math.round's half-up is half-up here.
//
// ONLY THE TOTAL MOVES. Every rung above it — the subtotal, the discount, the
// service charge, each tax line, tax_total — is exactly what it was, so no tax
// is recomputed on a rounded base and the GST on the paper is the GST on the
// food. The ladder identity simply gains one rung:
//
//     discounted_subtotal + service_charge + tax_total + round_off === grand_total
//
// `pre_round_total` is the old grand total, kept because two things need the
// unrounded figure: the service-charge waiver quote (a difference of two
// ROUNDED totals would leak up to a rupee of rounding into "tax on waived"),
// and anything that has to prove the identity above.

/** A bill's rupee-rounded total, and the adjustment that got it there. */
export function roundBillTotal(preRoundTotal: number): { grand_total: number; round_off: number } {
  const p = toPaisa(preRoundTotal);
  const grandP = Math.round(p / 100) * 100;
  return { grand_total: round2(grandP / 100), round_off: round2((grandP - p) / 100) };
}

// Full bill charges = optional service charge (on subtotal) + taxes (on subtotal
// + service charge), with the total rounded to the rupee (see above).
// `includeServiceCharge=false` reprints/charges without the charge.
export type BillDiscount = { type: "percent" | "flat"; value: number } | null | undefined;

export function computeBillCharges(
  subtotal: number,
  taxConfig: Record<string, number> | { name: string; percentage: number }[] | null | undefined,
  serviceChargePercent = 0,
  includeServiceCharge = true,
  discount?: BillDiscount,
): {
  subtotal: number;
  discount: number;
  discount_type: "percent" | "flat" | null;
  discount_value: number;
  discounted_subtotal: number;
  service_charge: number;
  service_charge_percent: number;
  taxes: BillTaxLine[];
  tax_total: number;
  /** discounted_subtotal + service_charge + tax_total, before rounding to the rupee. */
  pre_round_total: number;
  /** grand_total - pre_round_total. In [-0.49, +0.50]; 0 when the bill is already whole. */
  round_off: number;
  /** What the guest pays: whole rupees. */
  grand_total: number;
} {
  const base = round2(Number(subtotal) || 0);
  // A discount comes off the items subtotal first; service charge + taxes are then
  // computed on the discounted amount (standard restaurant billing order).
  let discountAmt = 0;
  let dType: "percent" | "flat" | null = null;
  let dValue = 0;
  if (discount && Number(discount.value) > 0) {
    dType = discount.type === "flat" ? "flat" : "percent";
    dValue = Math.max(0, Number(discount.value) || 0);
    discountAmt =
      dType === "flat" ? round2(Math.min(dValue, base)) : round2((base * Math.min(dValue, 100)) / 100);
  }
  const discountedBase = round2(Math.max(0, base - discountAmt));
  const scPct = includeServiceCharge ? Math.max(0, Number(serviceChargePercent) || 0) : 0;
  const service_charge = round2((discountedBase * scPct) / 100);
  const taxBase = round2(discountedBase + service_charge);
  const { taxes, tax_total } = computeBillTaxes(taxBase, taxConfig);
  const pre_round_total = round2(taxBase + tax_total);
  const { grand_total, round_off } = roundBillTotal(pre_round_total);
  return {
    subtotal: base,
    discount: discountAmt,
    discount_type: dType,
    discount_value: dValue,
    discounted_subtotal: discountedBase,
    service_charge,
    service_charge_percent: scPct,
    taxes,
    tax_total,
    pre_round_total,
    round_off,
    grand_total,
  };
}

// Minimal structural shape of a coupon needed to size its discount. The full
// `CouponRecord` (database_supabase.ts) is assignable to this.
export interface CouponDiscountInput { type: "percent" | "flat"; value: number; max_discount?: number | null }

// Discount a coupon yields against a pre-tax subtotal, clamped to the subtotal
// and (when set) to the coupon's max_discount cap.
export function computeCouponDiscount(coupon: CouponDiscountInput, subtotal: number): number {
  if (subtotal <= 0) {return 0;}
  let d = coupon.type === "flat" ? coupon.value : (subtotal * coupon.value) / 100;
  if (coupon.max_discount != null && coupon.max_discount > 0) {d = Math.min(d, coupon.max_discount);}
  return round2(Math.min(d, subtotal));
}

export interface SplitItem { name: string; price: number; quantity: number }
export interface SplitGroupInput { label?: string; items?: SplitItem[] }
export interface SplitPart { label: string; subtotal: number; total: number; items?: SplitItem[] }

// Split a bill's grand total into parts. INVARIANT: the parts' totals always sum
// back to the grand total exactly (the last part absorbs any rounding remainder),
// so a split can never lose or invent money.
//   - "item": allocate the grand proportionally to each guest-group's item subtotal.
//   - "even": split into N equal parts (N clamped to [2,50]) — in whole rupees
//     when the total is whole rupees, the leftover rupees one each to the first
//     parts; otherwise to the paisa, remainder on the last.
// A THIRD mode — by MENU SECTION (starters / mains / bar) — is computeSectionSplit
// at the foot of this file. It is a separate function on purpose; its header says why.
export function computeBillSplit(
  grandTotal: number,
  mode: "even" | "item",
  opts: { parts?: number; groups?: SplitGroupInput[]; subtotalFallback?: number },
): { mode: "even" | "item"; grand_total: number; parts: SplitPart[] } {
  const grand = round2(grandTotal);

  if (mode === "item" && Array.isArray(opts.groups) && opts.groups.length > 0) {
    const groups = opts.groups.map((g, i) => {
      const items = Array.isArray(g.items) ? g.items : [];
      const subtotal = round2(
        items.reduce((s, it) => s + (Number(it.price) || 0) * Math.max(1, Math.round(Number(it.quantity) || 1)), 0),
      );
      return { label: g.label?.trim() || `Guest ${i + 1}`, subtotal, items };
    });
    // Avoid divide-by-zero when every group's items sum to 0 (falls back to the
    // bill subtotal, else 1 so allocation degrades to "all on the last guest").
    const sumSub = round2(groups.reduce((s, g) => s + g.subtotal, 0)) || round2(opts.subtotalFallback ?? 0) || 1;
    let allocated = 0;
    const parts = groups.map((g, i) => {
      const isLast = i === groups.length - 1;
      const total = isLast ? round2(grand - allocated) : round2((grand * g.subtotal) / sumSub);
      allocated = round2(allocated + total);
      return { label: g.label, subtotal: g.subtotal, total, items: g.items };
    });
    return { mode: "item", grand_total: grand, parts };
  }

  // Even split.
  const n = Math.max(2, Math.min(50, Math.round(Number(opts.parts) || 2)));
  const parts: SplitPart[] = [];

  // A WHOLE-RUPEE BILL SPLITS INTO WHOLE-RUPEE SHARES (migration 048). The bill
  // is rounded to the rupee now, and the even split is the one both clients
  // actually offer — on screen and on the slips each guest is handed. Floored to
  // the paisa, 4982 three ways came out 1660.66 / 1660.66 / 1660.68: a "final
  // bill" in paise again, one slip at a time. So every share is floored to the
  // RUPEE and the K rupees left over (K < n) go one each to the first K shares.
  // Every share has the same claim to them, so position is the only fair tie
  // break, and no share differs from another by more than a rupee. Conservation
  // is exact by construction: n floors plus K rupees is the total.
  //
  // Not attempted when the total is not whole rupees (a bill settled before
  // rounding, or a figure built by hand) or is under a rupee a share — ₹2 three
  // ways would hand somebody a ₹0 slip. Those keep the paisa allocation below.
  const grandP = toPaisa(grand);
  if (grandP % 100 === 0 && grandP >= n * 100) {
    const rupees = grandP / 100;
    const perRupees = Math.floor(rupees / n);
    const extra = rupees - perRupees * n;
    for (let i = 0; i < n; i++) {
      const total = perRupees + (i < extra ? 1 : 0);
      parts.push({ label: `Guest ${i + 1}`, subtotal: total, total });
    }
    return { mode: "even", grand_total: grand, parts };
  }

  const per = Math.floor((grand / n) * 100) / 100;
  let allocated = 0;
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    const total = isLast ? round2(grand - allocated) : per;
    allocated = round2(allocated + total);
    parts.push({ label: `Guest ${i + 1}`, subtotal: round2(total), total });
  }
  return { mode: "even", grand_total: grand, parts };
}

// ============================================================================
// NON-CHARGEABLE (NC) LINES — migration 034
// ============================================================================
//
// An NC line is a dish that LEFT THE KITCHEN AND WAS NOT CHARGED FOR:
// complimentary, staff meal, spoilage, tasting, guest complaint, promo. It is
// NOT a void (a void means the food was never served) and it is NOT a discount
// (a discount is a bill-level decision about money, not a dish-level decision
// about food).
//
// THE BILLING RULE, in one sentence: an NC line contributes ZERO to the pre-tax
// base every bill is built on, and its full value is separately recoverable.
//
// WHY THAT IS ENOUGH TO MAKE EVERY MONEY PATH AGREE. "Orders".food.subtotal is
// the pre-tax base, and it has exactly two writers — AddOrder's pricedSubtotal
// and the NC/remove-item edits that recompute it — while every consumer in the
// system (sumOrderTotalsForTable -> activeOrderSubtotal, and therefore the open
// bill, the printed bill, the KOT, waiter-confirm, admin-approve, the customer
// pay path, discount, coupon, split, merge, move-item and remove-item) reads
// that one stored number. Reducing over CHARGEABLE lines here, in the one
// function both writers call, is what makes all of them agree without any of
// them having to know NC exists.
//
// `nc` IS SERVER-WRITTEN ONLY. AddOrder strips nc* from every client-supplied
// line and re-applies only the flags already stored on the server, so a till
// cannot comp a dish by editing its own payload. See stripClientNonChargeable
// in database_supabase.ts.

/** The subset of an order line these reductions need. Everything else ignored. */
export interface OrderLineMoney {
  price?: unknown;
  quantity?: unknown;
  /** True when this line has a LIVE non-chargeable against it (migration 034). */
  nc?: unknown;
}

/**
 * Quantity of one order line, read EXACTLY as AddOrder's pricedSubtotal reads
 * it: Math.max(1, n || 1), with no rounding. Duplicated behaviour rather than
 * "improved" behaviour on purpose — a line stored with quantity 2.5 (a weighed
 * item) bills as 2.5 today, and silently rounding it here would change what live
 * tenants are charged for reasons that have nothing to do with this work.
 */
export function orderLineQuantity(line: OrderLineMoney | null | undefined): number {
  const q = Number((line ?? {}).quantity);
  return Math.max(1, (Number.isFinite(q) ? q : 0) || 1);
}

/** Price of one order line, coerced the way parseNumeric coerces it. */
export function orderLinePrice(line: OrderLineMoney | null | undefined): number {
  const p = Number((line ?? {}).price);
  return Number.isFinite(p) ? p : 0;
}

/**
 * Is this line non-chargeable?
 *
 * Strictly `nc === true`. Not truthiness: the flag is written by exactly one
 * server path as a real boolean, and accepting "false", 0 or "" as meaningful
 * would let a stray JSON round-trip turn a paying line into a free one.
 */
export function isNonChargeableLine(line: OrderLineMoney | null | undefined): boolean {
  return (line ?? {}).nc === true;
}

/**
 * Sum of price x quantity over the CHARGEABLE lines — the pre-tax base.
 *
 * With no NC lines this is byte-identical to what AddOrder's pricedSubtotal has
 * always produced, which is the property that makes adopting it a no-op for
 * every existing order.
 */
export function chargeableSubtotal(lines: readonly (OrderLineMoney | null | undefined)[]): number {
  let sum = 0;
  for (const line of lines) {
    if (!line || isNonChargeableLine(line)) {continue;}
    sum += orderLinePrice(line) * orderLineQuantity(line);
  }
  return round2(sum);
}

/**
 * Sum of price x quantity over the NON-CHARGEABLE lines — the revenue given away.
 *
 * THE INVARIANT THE NC BILLING TEST PROVES:
 *     chargeableSubtotal(lines) + nonChargeableValue(lines)
 *       === chargeableSubtotal(lines with every nc flag cleared)
 * Nothing is lost and nothing is invented; the money merely moves from the
 * charged column into the given-away column.
 */
export function nonChargeableValue(lines: readonly (OrderLineMoney | null | undefined)[]): number {
  let sum = 0;
  for (const line of lines) {
    if (!line || !isNonChargeableLine(line)) {continue;}
    sum += orderLinePrice(line) * orderLineQuantity(line);
  }
  return round2(sum);
}

// ============================================================================
// A CHARGE IS NEVER NEGATIVE
// ============================================================================
//
// THE DOOR THIS CLOSES, and it was the last one open in the census.
//
// applyMenuPriceFloor floors every line that resolves to a menu row, and
// deliberately bills an UNRESOLVED line exactly as typed — a valet fee, an
// aggregator line, a one-off "open item" are real charges that are not on the
// menu, and refusing them would break the till for the sake of a rule.
//
// The gap is that "exactly as typed" accepted a NEGATIVE number. A line reading
//
//     { name: "Adjustment", price: -4000, quantity: 1 }
//
// resolves to no menu row, keeps its price, and chargeableSubtotal sums it — so
// the order subtotal drops by 4,000 and the table's bill drops with it. No
// discount was recorded, no coupon, no void, no NC line. GetTableReleaseImpact
// then values the table at what is left, and every gate this block built —
// settle, release, discount, coupon, loyalty, item-strip — measures a table that
// is already empty and finds nothing to protect. It is the same outcome as
// writing the bill off, reached by a door none of them watch, under an audit
// line that says an item was ADDED.
//
// THE RULE: a line may cost nothing, and may cost anything above nothing, and
// may never cost LESS than nothing. Money comes OFF a bill through a discount, a
// coupon, an NC flag, a void or a refund — every one of which is gated, recorded
// and reportable. A negative price is none of those; it is a discount wearing a
// dish's name.
//
// WHY ZERO RATHER THAN A REFUSAL. Refusing the write would turn a typo into a
// failed order at the pass, and the floor's whole design is that a menu outage
// or an odd line never blocks order entry. Clamping keeps the order, keeps the
// line visible on the ticket and the bill, and simply declines to let it pay the
// guest. A genuinely free line is what `nc` is for, and it is recorded.
//
// QUANTITY WAS ALREADY SAFE FOR THE MONEY — orderLineQuantity clamps to at least
// 1, so a negative quantity has never been able to reverse a line's sign. What is
// normalised here is only the STORED value, so a ticket cannot print "-3x
// Biryani" beside a positive total and invite an argument at the table.
//
// AND ONLY WHEN IT IS NOT A QUANTITY AT ALL. Zero, negative and non-numeric
// become 1; a FRACTION does not. Selling by weight is ordinary — 0.5 kg of
// something priced per kilo — and rounding that up to 1 here would double what
// the ticket says the guest ordered. (orderLineQuantity's own floor already
// charges such a line as 1, which is a separate and older inconsistency; this
// clamp deliberately does not make it worse by writing it into the order.)

/** What a line was typed as, before any of this is applied. */
export interface LineChargeInput {
  price?: unknown;
  quantity?: unknown;
}

export interface ClampedLineCharge {
  /** Never below zero. */
  price: number;
  /** Always a positive number. A fraction stays a fraction; see the header. */
  quantity: number;
  /** True when either value had to be moved. Callers log on this. */
  clamped: boolean;
}

/**
 * The non-negative form of one order line's money.
 *
 * Pure, so both order paths can share one answer and it can be argued with in a
 * test that needs no database. Applied by applyMenuPriceFloor (the staff path,
 * including the off-menu lines it deliberately does not re-price) and by
 * repriceFromMenu (the guest and waitlist paths).
 */
export function clampLineCharge(line: LineChargeInput | null | undefined): ClampedLineCharge {
  const rawPrice = Number((line ?? {}).price);
  const rawQty = Number((line ?? {}).quantity);
  const price = round2(Number.isFinite(rawPrice) ? rawPrice : 0);
  const quantity = Number.isFinite(rawQty) ? rawQty : 1;
  const safePrice = price < 0 ? 0 : price;
  const safeQty = quantity > 0 ? quantity : 1;
  return { price: safePrice, quantity: safeQty, clamped: safePrice !== price || safeQty !== quantity };
}

// ============================================================================
// THE PRICE FLOOR OF ONE ORDER LINE — migration 039 (variations)
// ============================================================================
//
// WHY THIS IS HERE AND NOT IN menu_taxonomy.ts. That module owns the EDITING
// rules (what an owner's save does to a stored row) and the SHAPING rules (what
// a guest is offered) and says so in its header. This is neither: it decides
// what a line may be billed at, which is money, and money lives beside the
// ladder that consumes it.
//
// WHY IT IS A FUNCTION AT ALL, rather than the four lines it replaces. There are
// TWO server paths that price an incoming order line and they must never
// disagree:
//
//   applyMenuPriceFloor  — the STAFF path (and every path AddOrder routes
//                          through). Floors a line at its menu row's price and
//                          bills an unmatched line as typed.
//   repriceFromMenu      — the GUEST QR path and the waitlist pre-order path.
//                          Same floor, but an unmatched line is DROPPED (a guest
//                          may only order from the menu).
//
// Before variations both floored against `Menu.price`, so "the same rule" was
// two copies of one expression and the copies could not drift far. A variation
// makes the floor CONDITIONAL — the Half plate's ₹150, not the dish's ₹250 —
// and two copies of a conditional rule is exactly how a guest ends up charged
// ₹250 for a Half on one path and ₹150 on the other. One function, called by
// both, is the only version of this that stays true.
//
// THE RULE, and every clause of it is a defence:
//   * NO variation_id on the line  -> the item's base price. That is every line
//     written before 039 and every line of every tenant that configures none, so
//     this path must stay arithmetically identical to what shipped.
//   * A variation that BELONGS TO ANOTHER DISH is refused. Honouring it would
//     let a till bill a ₹250 dish at some other dish's ₹80 "Small" price — it
//     would turn the price floor into a price hole.
//   * A RETIRED (inactive) variation is refused for a NEW line. It resolves fine
//     for a REPORT reading an old order (the attribution index keeps inactive
//     rows on purpose), but it must not be sellable again, and a retired row's
//     price is not a price the restaurant is offering today.
//   * An UNKNOWN id is refused. A client that names a variation nobody has heard
//     of gets the base price, never a discount.
// In all three refusals the floor falls back UP to the base price, which is the
// safe direction: the guest is charged the menu price, never less.

/** A menu row, as the floor needs to read it. */
export interface MenuPriceRef { id: string; price: unknown }

/** A variation row, as the floor needs to read it. Matches MenuVariationRecord. */
export interface VariationPriceRef {
  id: string;
  menu_id: string;
  name: string;
  price: number;
  active: boolean;
}

/** Why a named variation was not honoured. "none" = the line named none at all. */
export type VariationRefusal = "none" | "unknown" | "foreign" | "retired";

export interface LinePriceFloor {
  /** The price this line may not be billed below. */
  base: number;
  /** The honoured variation, or null. Non-null means `base` is ITS price. */
  variation: VariationPriceRef | null;
  /** "none" when the line named no variation; otherwise why it was refused. */
  refused: VariationRefusal;
}

export function resolveLinePriceFloor(
  rawVariationId: unknown,
  item: MenuPriceRef,
  variations: ReadonlyMap<string, VariationPriceRef>,
): LinePriceFloor {
  const basePrice = round2(Number(item.price) || 0);
  const wanted = typeof rawVariationId === "string" ? rawVariationId.trim() : "";
  if (!wanted) {return { base: basePrice, variation: null, refused: "none" };}
  const found = variations.get(wanted);
  if (!found) {return { base: basePrice, variation: null, refused: "unknown" };}
  if (String(found.menu_id) !== String(item.id)) {return { base: basePrice, variation: null, refused: "foreign" };}
  if (found.active !== true) {return { base: basePrice, variation: null, refused: "retired" };}
  return { base: round2(Number(found.price) || 0), variation: found, refused: "none" };
}

/**
 * Does ANY incoming line name a variation?
 *
 * Both order paths load the outlet's variation table ONLY when this is true, so
 * a tenant that has never configured one — i.e. every tenant on the day 039
 * ships — pays not one query for this at order-entry time. Kept here beside the
 * rule it guards so the two paths cannot disagree about when to look.
 */
export function anyLineNamesVariation(lines: readonly (Record<string, unknown> | null | undefined)[]): boolean {
  for (const line of lines) {
    const raw = (line ?? {}).variation_id;
    if (typeof raw === "string" && raw.trim().length > 0) {return true;}
  }
  return false;
}

// ============================================================================
// SERVICE CHARGE WAIVER — migration 036
// ============================================================================

/** How a tenant carries its service charge. See closedBillCharges' header. */
export type ServiceChargeBasis = "restaurant_percent" | "tax_line" | "none";

/** Does a tax-config entry name the service charge? The one matcher. */
const SERVICE_CHARGE_NAME = /service\s*charge/i;

/** The tax config, normalised to an array, with the service-charge line removed. */
export function taxConfigWithoutServiceCharge(
  taxConfig: Record<string, number> | { name: string; percentage: number }[] | null | undefined,
): { taxes: { name: string; percentage: number }[]; service_line: { name: string; percentage: number } | null } {
  const entries: { name: string; percentage: number }[] = [];
  if (Array.isArray(taxConfig)) {
    for (const t of taxConfig) {
      const name = String(t?.name ?? "").trim();
      const pct = Number(t?.percentage) || 0;
      if (name && pct > 0) {entries.push({ name, percentage: pct });}
    }
  } else if (taxConfig && typeof taxConfig === "object") {
    for (const [name, pct] of Object.entries(taxConfig)) {
      const p = Number(pct) || 0;
      if (name.trim() && p > 0) {entries.push({ name: name.trim(), percentage: p });}
    }
  }
  const idx = entries.findIndex((e) => SERVICE_CHARGE_NAME.test(e.name));
  if (idx < 0) {return { taxes: entries, service_line: null };}
  return { taxes: entries.filter((_, i) => i !== idx), service_line: entries[idx] };
}

/** What waiving the service charge on one bill costs, in both tax shapes. */
export interface ServiceChargeWaiverQuote {
  /** Which shape carried the charge. "none" = there was nothing to waive. */
  basis: ServiceChargeBasis;
  /** The EFFECTIVE percentage the waived charge represented, against basis_amount. */
  basis_percent: number;
  /** The discounted, pre-service-charge subtotal the charge applied to. */
  basis_amount: number;
  /** The service charge itself, pre-tax. The Service Charge rung of the ladder. */
  amount_waived: number;
  /** The tax that fell away WITH it. Structurally 0 in the tax_line shape. */
  tax_on_waived: number;
  /**
   * What the waiver took off, before rounding: amount_waived + tax_on_waived,
   * exactly. A difference of the two PRE-ROUND totals — see the function.
   */
  grand_total_reduction: number;
  /** The grand total the bill WOULD have had — rupee-rounded, as payable. */
  grand_total_with: number;
  /** The grand total once waived — rupee-rounded, as payable. */
  grand_total_without: number;
  /** Feed these two back into computeBillCharges to bill the waived bill. */
  tax_config_waived: { name: string; percentage: number }[];
  service_charge_percent_waived: 0;
}

/**
 * Price a service-charge waiver on one bill, in BOTH tax shapes, by running the
 * EXISTING computeBillCharges twice and taking the difference.
 *
 * Deliberately not a formula of its own. A second implementation of the charge
 * arithmetic is a second thing that can be wrong, and the two would drift the
 * first time either shape changed. Everything below is a subtraction between two
 * results of the one function the whole system already bills with, which is what
 * makes the waived bill's own total exactly `grand_total_without` and the
 * reported saving exactly the difference — no residual, in either shape.
 *
 * THE SAVING IS A DIFFERENCE OF PRE-ROUND TOTALS (migration 048). Both grand
 * totals are rupee-rounded, and each carries its own round-off of up to half a
 * rupee, so subtracting them would book that rounding noise as "tax on the
 * waived charge" — or, worse, report a reduction SMALLER than the charge itself
 * (240.00 against 240.04), which is a control document contradicting its own
 * arithmetic. The pre-round figures differ by exactly the charge and the tax
 * that rode on it, so `amount_waived + tax_on_waived === grand_total_reduction`
 * stays exact. `grand_total_with` / `grand_total_without` stay the rounded,
 * payable figures, because those are what the till showed before and after.
 *
 * THE TWO SHAPES, and why one number would have been wrong for half the fleet:
 *
 *   restaurant_percent — the charge sits UNDER the tax, so waiving it removes
 *                        the charge AND the GST that was charged on it:
 *                        tax_on_waived > 0.
 *   tax_line           — the charge IS one of the tax lines, computed on the same
 *                        base as the GST beside it with nothing charged on top of
 *                        it: tax_on_waived === 0, structurally.
 *
 * A tenant configured with BOTH (a non-zero "Restaurant".service_charge AND a
 * "Service Charge" entry in Outlets.default_tax) is charging twice, and this
 * waives both: amount_waived is the whole charge in that case, and `basis` names
 * the tax_line shape because that is the one closedBillCharges gives priority to
 * when it reads the settled bill back.
 */
export function quoteServiceChargeWaiver(
  subtotal: number,
  taxConfig: Record<string, number> | { name: string; percentage: number }[] | null | undefined,
  serviceChargePercent: number,
  discount?: BillDiscount,
): ServiceChargeWaiverQuote {
  const scPct = Math.max(0, Number(serviceChargePercent) || 0);
  const { taxes: waivedConfig, service_line } = taxConfigWithoutServiceCharge(taxConfig);

  const withCharge = computeBillCharges(subtotal, taxConfig, scPct, true, discount);
  const withoutCharge = computeBillCharges(subtotal, waivedConfig, 0, false, discount);

  // The charge itself, pre-tax, summed across whichever shapes are configured. In
  // the tax_line shape it is one of `withCharge.taxes`; in the restaurant_percent
  // shape it is `withCharge.service_charge`. A tenant with both pays both, so
  // both are added rather than one being chosen.
  const scLineAmount = round2(
    withCharge.taxes.filter((t) => SERVICE_CHARGE_NAME.test(t.name)).reduce((s, t) => s + t.amount, 0),
  );
  const amount_waived = round2(withCharge.service_charge + scLineAmount);
  const reduction = round2(withCharge.pre_round_total - withoutCharge.pre_round_total);
  // Never negative: a "waiver" that increased the bill would mean the two calls
  // disagreed about something other than the charge, and clamping is safer than
  // recording a negative saving on a control document. Unreachable with the
  // current computeBillCharges; kept because it costs nothing and a future tax
  // shape that broke it would otherwise fail silently.
  const tax_on_waived = round2(Math.max(0, reduction - amount_waived));

  const basis: ServiceChargeBasis =
    service_line !== null ? "tax_line" : (scPct > 0 ? "restaurant_percent" : "none");
  const basis_amount = round2(withCharge.discounted_subtotal);
  // The EFFECTIVE percentage — derived from the money rather than copied from a
  // config value, so it is still right for a tenant carrying both shapes at once
  // and it always satisfies basis_amount x pct/100 = amount_waived.
  const basis_percent = basis_amount > 0 ? round2((amount_waived / basis_amount) * 100) : 0;

  return {
    basis,
    basis_percent,
    basis_amount,
    amount_waived,
    tax_on_waived,
    grand_total_reduction: round2(Math.max(0, reduction)),
    grand_total_with: withCharge.grand_total,
    grand_total_without: withoutCharge.grand_total,
    tax_config_waived: waivedConfig,
    service_charge_percent_waived: 0,
  };
}

// ============================================================================
// TURNING THE SERVICE CHARGE OFF — the ONE answer (F2)
// ============================================================================
//
// THE CLIENT'S SENTENCE, VERBATIM, from a running restaurant: "bills printed
// WITHOUT a service charge incorrectly show the same total as bills WITH a
// service charge."
//
// THE FAILURE MODE, NAMED. "Off" only ever meant ONE of the two shapes above.
// computeBillCharges' `includeServiceCharge=false` zeroes the restaurant_percent
// leg and nothing else, so on a tenant carrying the charge as a TAX LINE — which
// is the shipped seed (migrations/000_base_schema.sql:266), i.e. the default,
// i.e. the tenant that reported this — the charge sails straight through
// computeBillTaxes untouched and the "without" bill equals the "with" bill TO
// THE PAISA. The guest is charged for a thing the bill says was not charged.
//
// So `includeServiceCharge=false` is not, on its own, a truthful answer to
// "print this without the charge": it has to be PAIRED with a tax config the
// charge has been lifted out of. Four call sites paired those two by hand and
// four of them got it wrong, which is why they are paired HERE, once, and every
// caller asks this instead of assembling the pair itself.
//
// IT ALSO ANSWERS "WAS ANYTHING ACTUALLY REMOVED", because the printers need
// that and were deriving it wrongly too: the (since retired) Opted-out line and
// the voluntary-charge disclaimer both keyed off `settings.service_charge > 0`,
// which is 0 on precisely the tax_line tenant being overcharged — so that bill
// did not merely charge the guest, it declined to admit the charge existed.
// `service_charge_removed` / `service_charge_applied` are that answer in both
// shapes, so no printer has to re-derive it from a config it cannot read.
//
// WHY NOT JUST CALL quoteServiceChargeWaiver. That function prices a waiver on a
// SPECIFIC bill — it needs the subtotal and the discount, and it returns money.
// A printer deciding how to render a header has neither yet; it needs the
// CONFIG. This is the config half, and it is deliberately built out of the same
// taxConfigWithoutServiceCharge the quote is built out of, so the config a bill
// is charged through and the config its recorded saving was measured against are
// the same subtraction. (`resolveServiceChargeConfig` returns the quote's
// `tax_config_waived` and `service_charge_percent_waived` exactly — pinned in
// test/money/service_charge_off.test.ts.)
//
// A TENANT WITH NO CHARGE IN EITHER SHAPE IS UNTOUCHED BY CONSTRUCTION: `basis`
// is "none", both booleans are false, and `taxConfig` is handed back as THE SAME
// OBJECT that came in — not a normalised copy — so a tenant who has never used
// this feature cannot tell that it shipped.

export interface ServiceChargeConfigResolution {
  /** Hand straight to computeBillCharges. Charge-free when the charge was removed. */
  taxConfig: Record<string, number> | { name: string; percentage: number }[] | null | undefined;
  /** Hand straight to computeBillCharges. 0 when the charge was removed. */
  scPct: number;
  /** Hand straight to computeBillCharges. false when the charge was removed. */
  includeServiceCharge: boolean;
  /** Which shape CARRIED the charge, before any removal. "none" = none configured. */
  basis: ServiceChargeBasis;
  /** The NOMINAL percent of the configured charge, for a display line. See below. */
  service_charge_percent: number;
  /** True iff a charge was configured AND this resolution took it off. */
  service_charge_removed: boolean;
  /** True iff the resolved config still charges one. This gates the disclaimer. */
  service_charge_applied: boolean;
}

/**
 * Resolve what a bill's charge configuration is, with the service charge left on
 * or taken off — in BOTH shapes.
 *
 * `off` is the "print/charge this without the service charge" request: the
 * `no_service_charge` flag on /print/bill, a live waiver on an open bill
 * (migration 036), the dashboard's opt-out. One flag, one answer, both legs.
 */
export function resolveServiceChargeConfig(
  taxConfig: Record<string, number> | { name: string; percentage: number }[] | null | undefined,
  serviceChargePercent: number,
  off = false,
): ServiceChargeConfigResolution {
  const scPct = Math.max(0, Number(serviceChargePercent) || 0);
  const { taxes, service_line } = taxConfigWithoutServiceCharge(taxConfig);
  // Same precedence as quoteServiceChargeWaiver: a tenant carrying BOTH is
  // reported under the tax_line shape, because that is the shape the settled
  // bill is read back through. Keeping the two in step matters — the waiver
  // record's `basis` column and this field describe the same charge.
  const basis: ServiceChargeBasis =
    service_line !== null ? "tax_line" : (scPct > 0 ? "restaurant_percent" : "none");
  // NOMINAL, not effective. In either single shape this IS the configured
  // percentage — a label for the audit line and the waiver card, never a
  // printed rung (a removed charge prints no line). A tenant carrying both
  // is charging twice and the two legs sit on DIFFERENT bases (the percent leg
  // on the discounted subtotal, the tax line on subtotal + that leg), so their
  // sum is a label rather than an arithmetic claim; the money-truth for that
  // tenant is quoteServiceChargeWaiver's difference, which is derived from two
  // ladders rather than from any percentage. Never print money from this.
  const service_charge_percent = round2(scPct + (service_line?.percentage ?? 0));

  if (!off || basis === "none") {
    // Either the caller did not ask, or there is nothing to remove. Hand back the
    // caller's OWN config object rather than the normalised array: the charge-on
    // path is the path every existing bill takes, and it must not be rebuilt
    // underneath a fleet of live tenants for a feature they are not using.
    return {
      taxConfig,
      scPct,
      includeServiceCharge: !off,
      basis,
      service_charge_percent,
      service_charge_removed: false,
      service_charge_applied: !off && basis !== "none",
    };
  }

  // BOTH LEGS, which is the whole fix: the tax-line leg comes out of the config
  // AND the restaurant_percent leg is zeroed. Removing only one of them is the
  // bug this function exists to make unrepeatable.
  return {
    taxConfig: taxes,
    scPct: 0,
    includeServiceCharge: false,
    basis,
    service_charge_percent,
    service_charge_removed: true,
    service_charge_applied: false,
  };
}

// ============================================================================
// TENDERS — migration 037
// ============================================================================
//
// A tender is one payment against one bill. N tenders settle one bill, and their
// amounts must reconstruct the grand total EXACTLY.
//
// WHY INTEGER PAISA AND NOT A TOLERANCE. Rupee amounts are doubles in
// JavaScript, and 33.33 + 33.33 + 33.34 evaluates to 100.00000000000001. A naive
// `sum === total` therefore REJECTS a correct three-way split of 100, and the
// obvious fix — an epsilon — accepts a genuinely wrong split that happens to land
// inside it. Both fail in the direction that matters: one blocks a cashier who
// did nothing wrong, the other lets money go missing quietly.
//
// So every comparison here is done on whole paisa, where the arithmetic is exact
// and "exactly equal" means exactly equal. round2 is applied to each part FIRST,
// because a tender is stored as a 2-decimal numeric and a caller handing in
// 33.333333 is handing in a number that cannot be paid.
//
// Postgres needs none of this: migration 037's trigger compares `numeric`, which
// is exact. The drift is a JavaScript problem and it is solved in JavaScript.

/** One rupee amount as whole paisa. The only safe unit for tender equality. */
export function toPaisa(value: number): number {
  return Math.round(round2(Number(value) || 0) * 100);
}

/** How a bill's live tenders stand against its grand total. */
export interface TenderReconciliation {
  /** Sum of the parts, in rupees, accumulated in paisa so it never drifts. */
  tendered: number;
  /** grand_total - tendered. Positive = still owed; negative = over-tendered. */
  outstanding: number;
  /** True only when the parts reconstruct the total to the paisa. */
  exact: boolean;
  /** True when the parts exceed the total. Refused, never recorded — see 037. */
  over: boolean;
  /** True when something is tendered but not everything. A legal open state. */
  partial: boolean;
}

/**
 * Reconcile a set of tender amounts against a bill's grand total.
 *
 * `amounts` must already exclude VOIDED tenders and must exclude TIPS: a tip
 * rides on top of the grand total, and folding it in would make every tipped
 * bill read as over-tendered. See migration 037's header.
 */
/**
 * The amounts that count TOWARD THE BILL, out of a set of tenders.
 *
 * This is one line of code guarding one rule: **a tip is not payment for food.**
 * A tender carries `amount` (money owed to the restaurant for the bill) and
 * `tip_amount` (money owed onward to staff); only the former reduces what the
 * guest still owes.
 *
 * It is a named, exported function rather than an inline `.map(t => t.amount)`
 * because the inline form was invisible to the suite: folding `tip_amount` into
 * the mapped value passed tsc and all 1004 tests, and would have made every
 * TIPPED bill read as over-tendered — so `assertTendersReconcileForSettle`
 * would refuse the settle, stranding a guest at the till with a payment that
 * cannot be closed. The mutation is only detectable if the rule has a name.
 */
export function tenderAmountsTowardBill(
  tenders: readonly { amount: number; tip_amount?: number }[],
): number[] {
  return tenders.map((t) => t.amount);
}

export function reconcileTenders(grandTotal: number, amounts: readonly number[]): TenderReconciliation {
  const totalPaisa = toPaisa(grandTotal);
  let tenderedPaisa = 0;
  for (const a of amounts) {tenderedPaisa += toPaisa(a);}
  const outstandingPaisa = totalPaisa - tenderedPaisa;
  return {
    tendered: round2(tenderedPaisa / 100),
    outstanding: round2(outstandingPaisa / 100),
    exact: outstandingPaisa === 0,
    over: outstandingPaisa < 0,
    partial: tenderedPaisa > 0 && outstandingPaisa > 0,
  };
}

/**
 * Split a grand total into N tender amounts that sum back to it EXACTLY.
 *
 * The same allocation computeBillSplit's "even" mode uses — floor every part to
 * the paisa, give the remainder to the last — restated in whole paisa so the
 * result is exact BY CONSTRUCTION rather than by a final round2 that happens to
 * absorb the error. 100 over three tenders is 33.33 / 33.33 / 33.34, and
 * reconcileTenders(100, those) reports exact.
 *
 * N is clamped to [1, 50]: one tender is a legitimate degenerate case here
 * (unlike computeBillSplit, which splits a bill BETWEEN guests and so needs at
 * least two), and 50 is the same upper bound for the same reason.
 */
export function allocateTenderAmounts(grandTotal: number, parts: number): number[] {
  const n = Math.max(1, Math.min(50, Math.round(Number(parts) || 1)));
  const totalPaisa = toPaisa(grandTotal);
  const per = Math.floor(totalPaisa / n);
  const out: number[] = [];
  let allocated = 0;
  for (let i = 0; i < n; i++) {
    const paisa = i === n - 1 ? totalPaisa - allocated : per;
    allocated += paisa;
    out.push(round2(paisa / 100));
  }
  return out;
}

// ============================================================================
// SPLITTING A BILL BY MENU SECTION — the third mode
// ============================================================================
//
// "even" splits a bill BETWEEN PEOPLE. "item" splits it between guest groups the
// CALLER names. This one splits it between SECTIONS OF THE MENU — starters,
// mains, the bar — which is a different question with a different owner: the
// caller does not choose the buckets, the menu does. Which axis of the menu
// ("Starters" the category, or "Liquor" the revenue group of migration 039) is
// the caller's choice; every line then lands in exactly one bucket on that axis,
// including the lines that classify to nothing.
//
// WHY THIS IS NOT computeBillSplit's "item" mode with server-built groups. That
// mode allocates ONE number — the grand total — and hands the LAST group
// whatever rounding is left over. A section split is read as a set of
// MINI-BILLS ("the bar came to 2,360, of which 360 is GST"), so every rung of
// the ladder has to be apportioned rather than just the total, and the rounding
// has to be spread rather than dumped on whoever happens to be last. Bending the
// existing mode to do that would have changed what its existing callers get,
// which is a live money path and not worth touching for a new feature.
//
// THE TWO INVARIANTS, and they hold TOGETHER, exactly, in whole paisa:
//
//   COLUMN — for every rung (discounted subtotal, discount, service charge, each
//            named tax line, round-off, grand total) the parts sum to the bill's
//            own figure. Nothing is lost and nothing is invented, which is what
//            makes the set of parts a tax document instead of an estimate. A
//            split that drops the GST is a bill that does not add up.
//   ROW    — each part's own rungs add up to that part's own grand total. A part
//            IS a bill in miniature and the guest handed one can check it.
//
// They pull against each other: rounding every rung independently breaks the
// row, and deriving every rung from an allocated total breaks the column. They
// are reconciled by apportioning every rung EXCEPT the grand total and then
// DERIVING each part's grand total from its own apportioned rungs. The column
// holds because each rung's own allocation conserves; the row holds by
// construction. This works because the bill's own ladder satisfies the same
// identity in paisa — computeBillCharges rounds every rung to 2dp, so
// grand = discounted_subtotal + service_charge + tax_total + round_off exactly.
// ROUND-OFF IS THE ONE RUNG THAT IS NOT APPORTIONED BY WEIGHT when the bill is
// whole rupees (every bill since migration 048): each part is rounded to the
// rupee instead, so every slip asks for rupees too — see
// wholeRupeePartRoundOffs, which keeps both invariants. A ladder whose total is
// NOT whole rupees, or not the rounding of its own rungs, has its difference
// apportioned by weight as a visible `round_off` rather than quietly lost.
//
// WHY THE DISCOUNTED SUBTOTAL IS THE RUNG AND THE GROSS ONE IS DERIVED. If gross
// and discount were allocated independently, a section whose share of the
// DISCOUNTED subtotal is under one paisa could be handed a discount one paisa
// larger than its gross, and the part would come out owing minus one paisa.
// Allocating the net and deriving gross = net + discount makes every allocated
// rung non-negative, so no part can ever be negative, and gross still sums to
// the bill's gross because both of its components do.
//
// WHY A NON-CHARGEABLE WEIGHS NOTHING. A comped dish contributes zero to the
// pre-tax base every bill is built on (see the NC header below), so it must
// contribute zero to the WEIGHT as well — otherwise a comped starter would drag
// paid money out of the bar's part and into the kitchen's. The line is still
// listed under its section, at its menu value, in `nc_value`: the food went to
// that section and pretending otherwise would hide it.

/** One order line, as a section split reads it. */
export interface SectionSplitLine {
  /** Stable grouping key for the section. Two lines share a part iff they share this. */
  section_key: string;
  /** What the section is called on the part. */
  section_label: string;
  /** True for a classification gap (Unclassified / Unattributed). Never merged away. */
  section_gap?: boolean;
  name: string;
  price: number;
  quantity: number;
  /** True when this line is non-chargeable (migration 034). Weighs nothing. */
  nc?: boolean;
  nc_kind?: string;
  /** The variation label snapshotted on the line (migration 039). */
  variation?: string | null;
}

/** One line as it appears back on a part. The shape the open bill already prints. */
export interface SectionSplitItem {
  name: string;
  price: number;
  quantity: number;
  nc?: true;
  nc_kind?: string;
  variation?: string;
}

/**
 * The bill's ladder — every rung the split has to apportion.
 *
 * computeBillCharges' return value is assignable to this, which is the intended
 * caller: the split apportions the SAME numbers the guest is being charged
 * rather than recomputing them from the lines, so it cannot disagree with the
 * bill it is splitting.
 */
export interface SectionSplitLadder {
  subtotal: number;
  discount: number;
  /** Defaults to subtotal - discount, which is exactly how computeBillCharges builds it. */
  discounted_subtotal?: number;
  service_charge: number;
  taxes: BillTaxLine[];
  tax_total: number;
  grand_total: number;
}

/** One section's share of the bill. A bill in miniature. */
export interface SectionSplitPart {
  key: string;
  /** SplitPart-compatible: an existing split client reads `label`, `subtotal`, `total`. */
  label: string;
  gap: boolean;
  /** Gross, pre-discount. Always discounted_subtotal + discount. */
  subtotal: number;
  discount: number;
  discounted_subtotal: number;
  service_charge: number;
  taxes: BillTaxLine[];
  tax_total: number;
  /**
   * What rounds this part to the rupee on a whole-rupee bill (always under a
   * rupee either way), and sums across the parts to the bill's own round-off.
   * On a ladder that is not whole rupees, the bill's difference apportioned.
   */
  round_off: number;
  grand_total: number;
  /** Alias of grand_total, so a client written against `even`/`item` still renders. */
  total: number;
  /** Units in this section, chargeable and comped alike. */
  qty: number;
  /** Menu value of the comped lines in this section. NOT part of any rung above. */
  nc_value: number;
  items: SectionSplitItem[];
}

export interface SectionSplitResult {
  mode: "section";
  grand_total: number;
  parts: SectionSplitPart[];
  /** Parts that actually need paying. A fully-comped section owes nothing. */
  payable_parts: number;
}

/**
 * Split an integer amount of paisa across integer weights so the parts sum back
 * to it EXACTLY.
 *
 * LARGEST REMAINDER (Hamilton), not "floor everything and give the rest to the
 * last one". Both conserve; they differ in WHERE the drift lands. With N
 * sections the last-part rule can pile up to N-1 paisa onto one part chosen
 * purely by position, which on a printed part reads as an error. Largest
 * remainder hands the leftover paisa out one each to the sections with the
 * biggest fractional claim, so no part is ever more than one paisa off its exact
 * share.
 *
 * BIGINT, NOT DOUBLES, for the one multiplication. total x weight on a banquet
 * bill (a few crore paisa against a weight of the same size) exceeds 2^53, where
 * a double quietly stops being an integer and floor() starts answering a
 * different question. Everything else here is small-integer arithmetic; this is
 * the single place exactness is not free, so it is bought.
 *
 * A ZERO-WEIGHT PART IS NEVER HANDED A STRAY PAISA. The leftover goes only to
 * parts with a positive weight (when any has one), so a section whose every line
 * was comped comes out at exactly zero rather than at one paisa nobody can
 * explain. When NOTHING has weight the amount is spread evenly — never all on
 * one part, and never dropped.
 */
export function allocateInPaisa(totalPaisa: number, weights: readonly number[]): number[] {
  const n = weights.length;
  if (n === 0) {return [];}
  const total = Math.round(Number(totalPaisa) || 0);
  // The sign is handled once, here, so the BigInt division below is always a
  // true floor (it truncates toward zero, a DIFFERENT operation for negatives).
  const sign = total < 0 ? -1 : 1;
  const magnitude = Math.abs(total);

  const w = weights.map((x) => {
    const v = Number(x);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  });
  const anyWeight = w.some((x) => x > 0);
  const ws = anyWeight ? w : w.map(() => 1);
  const W = ws.reduce((s, x) => s + x, 0);

  const totalBig = BigInt(magnitude);
  const wBig = BigInt(W);
  const out: number[] = [];
  const claims: { index: number; remainder: bigint }[] = [];
  let allocated = 0;
  for (let i = 0; i < n; i++) {
    const numerator = totalBig * BigInt(ws[i] ?? 0);
    const share = Number(numerator / wBig);
    out.push(share);
    allocated += share;
    if ((ws[i] ?? 0) > 0) {claims.push({ index: i, remainder: numerator % wBig });}
  }

  // The leftover is strictly smaller than claims.length by construction (each
  // dropped fraction being under 1), so this loop always exhausts it.
  let leftover = magnitude - allocated;
  claims.sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : (a.remainder > b.remainder ? -1 : 1)));
  for (let k = 0; k < claims.length && leftover > 0; k++) {
    const idx = claims[k].index;
    out[idx] = out[idx] + 1;
    leftover -= 1;
  }
  return sign < 0 ? out.map((x) => -x) : out;
}

/** The merge key the open bill already uses, so a part lists what the bill lists. */
function sectionItemKey(line: SectionSplitLine): string {
  const variation = (line.variation ?? "").trim().toLowerCase();
  return `${line.name.trim().toLowerCase()}@@${String(orderLinePrice(line))}@@${line.nc === true ? "nc" : ""}@@${variation}`;
}

/**
 * Each part's round-off, when the bill being split is a WHOLE-RUPEE bill — so
 * every part is a whole-rupee slip too. Null when that cannot be done exactly,
 * and the caller then apportions the bill's round-off by weight as before.
 *
 * WHY PARTS ARE ROUNDED AT ALL (migration 048). The whole bill is now paid in
 * whole rupees. A part apportioned by weight alone would print "Food 3149.84"
 * under a "Round off -0.16" line — a slip whose total is still in paise, next to
 * a line announcing that the paise were rounded away. A guest paying their share
 * is asked for rupees exactly as the table is.
 *
 * THE RULE, IN PAISA. Each part's pre-round total (its own net + service + tax,
 * already apportioned and conserving) is floored to the rupee. The bill's grand
 * total is then short of the sum of those floors by K whole rupees, and those K
 * rupees go one each to the parts with the LARGEST dropped remainder — largest
 * remainder again, for the reason allocateInPaisa gives: the extra rupee lands
 * where the claim to it is biggest, never on whoever happens to be last. Ties
 * break by position, which is weight order. A part's round-off is then its whole
 * total minus its pre-round total.
 *
 * BOTH INVARIANTS SURVIVE. ROW: each part's rungs plus its round-off are its
 * total, by construction. COLUMN: the parts' totals sum to the grand total (the
 * floors plus exactly K rupees), and since their pre-round totals sum to the
 * bill's, their round-offs sum to the bill's round-off. Every other rung is
 * untouched. No part moves by a rupee or more, and no part goes negative (a floor
 * of a non-negative amount is non-negative).
 *
 * WHEN IT IS NOT ATTEMPTED: the grand total is not whole rupees (a ladder built
 * before rounding, or by hand), or K falls outside [0, parts with a remainder] —
 * which only a ladder whose total is not the rounding of its own rungs can
 * produce. Refusing is what keeps this exact rather than approximately right.
 */
function wholeRupeePartRoundOffs(partPreRoundP: readonly number[], grandP: number): number[] | null {
  if (partPreRoundP.length === 0 || grandP % 100 !== 0) {return null;}
  if (partPreRoundP.some((p) => !Number.isInteger(p) || p < 0)) {return null;}
  const floors = partPreRoundP.map((p) => Math.floor(p / 100) * 100);
  const shortP = grandP - floors.reduce((s, f) => s + f, 0);
  if (shortP % 100 !== 0) {return null;}
  const claims = partPreRoundP
    .map((p, index) => ({ index, remainder: p - (floors[index] ?? 0) }))
    .filter((c) => c.remainder > 0)
    .sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : b.remainder - a.remainder));
  const rupees = shortP / 100;
  if (rupees < 0 || rupees > claims.length) {return null;}
  const totals = [...floors];
  for (let k = 0; k < rupees; k++) {
    const idx = claims[k].index;
    totals[idx] = (totals[idx] ?? 0) + 100;
  }
  return totals.map((t, i) => t - (partPreRoundP[i] ?? 0));
}

/**
 * Split a bill between the sections its lines belong to.
 *
 * The caller resolves each line to a section (see SplitBillForTable, which uses
 * the SAME menu attribution the Group Summary report uses, so a section here and
 * a row there are the same bucket under the same name). This function does the
 * money and nothing else: it knows what a section is called and what it weighs,
 * and it has never heard of a menu.
 *
 * LINES WITH NO SECTION AT ALL. If `lines` is empty — a bill generated before
 * any order landed, or a table whose every order was voided — the whole bill
 * comes back as ONE part labelled with `fallbackLabel`. The alternative is
 * returning no parts, and a split that answers "nothing" for a bill with a grand
 * total is a split that has lost the money.
 */
export function computeSectionSplit(
  ladder: SectionSplitLadder,
  lines: readonly SectionSplitLine[],
  opts: { fallbackLabel?: string } = {},
): SectionSplitResult {
  interface Bucket {
    key: string; label: string; gap: boolean;
    weight: number; qty: number; ncValue: number;
    items: Map<string, SectionSplitItem>;
  }
  const buckets = new Map<string, Bucket>();
  for (const line of lines) {
    const key = String(line.section_key ?? "").trim() || "~";
    const bucket = buckets.get(key) ?? {
      key,
      label: String(line.section_label ?? "").trim() || key,
      gap: line.section_gap === true,
      weight: 0, qty: 0, ncValue: 0,
      items: new Map<string, SectionSplitItem>(),
    };
    const qty = orderLineQuantity(line);
    const value = round2(orderLinePrice(line) * qty);
    bucket.qty = round2(bucket.qty + qty);
    if (isNonChargeableLine(line)) {
      bucket.ncValue = round2(bucket.ncValue + value);
    } else {
      // The WEIGHT is chargeable value only — see the header. Accumulated in
      // paisa so five hundred lines of 33.33 do not drift the section's share.
      bucket.weight += toPaisa(value);
    }
    const itemKey = sectionItemKey(line);
    const existing = bucket.items.get(itemKey);
    if (existing) {
      existing.quantity = round2(existing.quantity + qty);
    } else {
      const variation = (line.variation ?? "").trim();
      bucket.items.set(itemKey, {
        name: line.name,
        price: orderLinePrice(line),
        quantity: qty,
        ...(line.nc === true ? { nc: true as const, nc_kind: line.nc_kind || undefined } : {}),
        ...(variation ? { variation } : {}),
      });
    }
    buckets.set(key, bucket);
  }

  const ordered = [...buckets.values()].sort((a, b) => {
    // Gaps last: a bucket the menu could not classify is a footnote, not a
    // headline, and whoever is reading the parts should meet the real sections
    // first. Heaviest first inside each band, name as the deterministic
    // tie-break — the same order the Group Summary report puts its rows in.
    // Sorting BEFORE the allocation also decides who absorbs a tied paisa:
    // allocateInPaisa breaks a tie by position, and position here is weight, so
    // the leftover lands on the biggest section rather than on an arbitrary one.
    if (a.gap !== b.gap) {return a.gap ? 1 : -1;}
    if (a.weight !== b.weight) {return b.weight - a.weight;}
    return a.label.localeCompare(b.label);
  });

  if (ordered.length === 0) {
    ordered.push({
      key: "~whole",
      label: opts.fallbackLabel?.trim() || "Whole bill",
      gap: true, weight: 0, qty: 0, ncValue: 0,
      items: new Map<string, SectionSplitItem>(),
    });
  }

  const weights = ordered.map((b) => b.weight);
  const subtotalP = toPaisa(ladder.subtotal);
  const discountP = toPaisa(ladder.discount);
  const netP = ladder.discounted_subtotal === undefined
    ? subtotalP - discountP
    : toPaisa(ladder.discounted_subtotal);
  const serviceP = toPaisa(ladder.service_charge);
  const taxLines = Array.isArray(ladder.taxes) ? ladder.taxes : [];
  const namedTaxP = taxLines.map((t) => toPaisa(t.amount));
  const taxTotalP = toPaisa(ladder.tax_total);
  const grandP = toPaisa(ladder.grand_total);

  const net = allocateInPaisa(netP, weights);
  const discount = allocateInPaisa(discountP, weights);
  const service = allocateInPaisa(serviceP, weights);
  const taxes = taxLines.map((_, i) => allocateInPaisa(namedTaxP[i] ?? 0, weights));
  // A tax total the named lines do not reconstruct is apportioned as well rather
  // than dropped: an unnamed rupee of tax is still a rupee of tax.
  const unnamedTax = allocateInPaisa(taxTotalP - namedTaxP.reduce((s, x) => s + x, 0), weights);
  const partTaxTotalsP = ordered.map((_, i) =>
    taxes.reduce((s, line) => s + (line[i] ?? 0), 0) + (unnamedTax[i] ?? 0));
  const partPreRoundP = ordered.map((_, i) => (net[i] ?? 0) + (service[i] ?? 0) + (partTaxTotalsP[i] ?? 0));
  const roundOff = wholeRupeePartRoundOffs(partPreRoundP, grandP)
    ?? allocateInPaisa(grandP - (netP + serviceP + taxTotalP), weights);

  const parts: SectionSplitPart[] = ordered.map((bucket, i) => {
    const partTaxes: BillTaxLine[] = taxLines.map((t, k) => ({
      name: t.name,
      percentage: t.percentage,
      amount: round2((taxes[k]?.[i] ?? 0) / 100),
    }));
    const partTaxTotalP = partTaxTotalsP[i] ?? 0;
    const partGrandP = (partPreRoundP[i] ?? 0) + (roundOff[i] ?? 0);
    const grand = round2(partGrandP / 100);
    return {
      key: bucket.key,
      label: bucket.label,
      gap: bucket.gap,
      subtotal: round2(((net[i] ?? 0) + (discount[i] ?? 0)) / 100),
      discount: round2((discount[i] ?? 0) / 100),
      discounted_subtotal: round2((net[i] ?? 0) / 100),
      service_charge: round2((service[i] ?? 0) / 100),
      taxes: partTaxes,
      tax_total: round2(partTaxTotalP / 100),
      round_off: round2((roundOff[i] ?? 0) / 100),
      grand_total: grand,
      total: grand,
      qty: bucket.qty,
      nc_value: bucket.ncValue,
      items: [...bucket.items.values()],
    };
  });

  return {
    mode: "section",
    grand_total: round2(grandP / 100),
    parts,
    payable_parts: parts.filter((p) => toPaisa(p.grand_total) !== 0).length,
  };
}


// ============================================================================
// "AN ORDER THAT STILL OWES MONEY" — THE ONE DEFINITION
// ============================================================================
//
// THE BUG THIS ENDS. There were THREE copies of this status list in the
// codebase and they did not agree:
//
//   * activeOrderSubtotal (the bill math) skipped Paid / Cancelled / Closed —
//     so status 6 "Payment Pending Approval" WAS charged for;
//   * eight SQL readers wrote `not in ('4','5','7')` — the same rule;
//   * GetTableReleaseImpact (the release preflight) wrote
//     `not in ('4','5','6','7')` — a FOURTH status excluded.
//
// So a table whose orders sat at status 6 read as ₹0 to the preflight that
// decides whether releasing it is a write-off, while the bill math that would
// later charge for those same orders counted every rupee of them. The gate
// built to stop a waiter walking a table's money out of the system reported
// nothing to stop. A comment on the preflight said the two filters "must
// agree"; a comment is not a mechanism, which is why this is code.
//
// THE DEFINITION: an order still owes money unless it has been Paid (4),
// Cancelled (5) or Closed (7). Everything else — Preparing, Served, Bill
// Verification, Pending, and Payment Pending Approval (6) — is still on the
// bill. Status 6 is INCLUDED deliberately: the guest has tendered but nothing
// has been approved or closed, the money is still owed to the restaurant on
// this bill, and the bill math has always charged for it.
//
// EVERY reader of this rule — SQL or TypeScript — goes through this block.
// `stillOwesStatusSql` builds the SQL predicate from the SAME array
// `orderStatusStillOwes` tests, so the two cannot drift; a second list that
// agrees today is exactly how this happened.

/** Status codes of an order that is FINISHED WITH: 4 Paid, 5 Cancelled, 7 Closed. */
export const SETTLED_ORDER_STATUS_CODES: readonly string[] = ["4", "5", "7"];

/**
 * Status codes ReleaseTable must NOT void, which is the settled set PLUS 6
 * (Payment Pending Approval): the guest has already tendered, so cancelling
 * their orders would delete collected money rather than free a table.
 *
 * DERIVED from SETTLED_ORDER_STATUS_CODES rather than written out, so this is
 * not a second list. It is a DIFFERENT QUESTION with a different answer — "what
 * may I void" is not "what still owes money" — and the release preflight must
 * use the owing rule, never this one. See GetTableReleaseImpact.
 */
export const RELEASE_VOID_EXEMPT_STATUS_CODES: readonly string[] = [...SETTLED_ORDER_STATUS_CODES, "6"];

/**
 * Does this order still owe money? Takes the RAW `"Orders".status` value — a
 * number, a numeric string, or null — and coerces it the way the SQL predicate
 * does: anything unreadable is treated as 1 (Preparing), which still owes.
 * Failing towards "owes" is the safe direction: over-reporting value costs one
 * escalation, under-reporting it is the defect above.
 */
export function orderStatusStillOwes(status: unknown): boolean {
  const n = Number(status);
  const code = Number.isFinite(n) ? String(Math.round(n)) : "1";
  return !SETTLED_ORDER_STATUS_CODES.includes(code);
}

/** Quote a status-code list as a SQL `in` tuple. Codes are module constants. */
function statusTuple(codes: readonly string[]): string {
  return codes.map((c) => `'${c}'`).join(",");
}

/**
 * The SQL half of `orderStatusStillOwes`, built from the same array. Pass the
 * column expression when the query aliases "Orders" (e.g. `o.status`).
 */
export function stillOwesStatusSql(column = "status"): string {
  return `coalesce(${column}::text, '1') not in (${statusTuple(SETTLED_ORDER_STATUS_CODES)})`;
}

/** The SQL predicate for "orders ReleaseTable may void". See the constant. */
export function releaseVoidableStatusSql(column = "status"): string {
  return `coalesce(${column}::text, '1') not in (${statusTuple(RELEASE_VOID_EXEMPT_STATUS_CODES)})`;
}
