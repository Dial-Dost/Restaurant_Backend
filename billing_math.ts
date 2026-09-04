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

// Full bill charges = optional service charge (on subtotal) + taxes (on subtotal
// + service charge). `includeServiceCharge=false` reprints/charges without it.
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
  const grand_total = round2(taxBase + tax_total);
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
//   - "even": split into N equal parts (N clamped to [2,50]).
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
  const per = Math.floor((grand / n) * 100) / 100;
  const parts: SplitPart[] = [];
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
  /** What the guest stopped owing: amount_waived + tax_on_waived. */
  grand_total_reduction: number;
  /** The grand total the bill WOULD have had. */
  grand_total_with: number;
  /** The grand total once waived. */
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
  const reduction = round2(withCharge.grand_total - withoutCharge.grand_total);
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
