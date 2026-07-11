// Pure bill/coupon arithmetic — NO database, network, or native dependencies.
//
// This module is deliberately free of imports so the money math can be unit-tested
// in isolation (jest) without loading the heavy `database_supabase.ts` graph
// (pg/sharp/argon2/supabase). `database_supabase.ts` imports and re-exports from here,
// so there is a single source of truth for how a bill total is built.

export function round2(value: number): number {
  return Number((Number(value) || 0).toFixed(2));
}

export type BillTaxLine = { name: string; percentage: number; amount: number };

// Apply a restaurant's configured taxes (e.g. CGST 2.5%, SGST 2.5%) to a
// pre-tax subtotal. Accepts either the outlet's `default_tax` record
// (name -> percentage) or an array of {name, percentage}. Returns each tax line
// with its computed amount, the tax total, and the tax-inclusive grand total.
export function computeBillTaxes(
  subtotal: number,
  taxConfig: Record<string, number> | Array<{ name: string; percentage: number }> | null | undefined,
): { taxes: BillTaxLine[]; tax_total: number; grand_total: number } {
  const base = Number(subtotal) || 0;
  const entries: Array<{ name: string; percentage: number }> = [];
  if (Array.isArray(taxConfig)) {
    for (const t of taxConfig) {
      const name = String(t?.name ?? "").trim();
      const pct = Number(t?.percentage) || 0;
      if (name && pct > 0) entries.push({ name, percentage: pct });
    }
  } else if (taxConfig && typeof taxConfig === "object") {
    for (const [name, pct] of Object.entries(taxConfig)) {
      const p = Number(pct) || 0;
      if (name.trim() && p > 0) entries.push({ name: name.trim(), percentage: p });
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
  taxConfig: Record<string, number> | Array<{ name: string; percentage: number }> | null | undefined,
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
export type CouponDiscountInput = { type: "percent" | "flat"; value: number; max_discount?: number | null };

// Discount a coupon yields against a pre-tax subtotal, clamped to the subtotal
// and (when set) to the coupon's max_discount cap.
export function computeCouponDiscount(coupon: CouponDiscountInput, subtotal: number): number {
  if (subtotal <= 0) return 0;
  let d = coupon.type === "flat" ? coupon.value : (subtotal * coupon.value) / 100;
  if (coupon.max_discount != null && coupon.max_discount > 0) d = Math.min(d, coupon.max_discount);
  return round2(Math.min(d, subtotal));
}

export type SplitItem = { name: string; price: number; quantity: number };
export type SplitGroupInput = { label?: string; items?: SplitItem[] };
export type SplitPart = { label: string; subtotal: number; total: number; items?: SplitItem[] };

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
