/**
 * SETTLE AS NC — the pure rules behind closing a whole bill as non-chargeable.
 *
 * PURE module: it imports only the other pure modules (billing_math.ts,
 * mis_capture.ts) and touches no database, no clock and no network. Same
 * discipline, and the same reason, as billing_math.ts: every rule below is
 * decided by value, so jest proves it without a pg pool, and
 * SettleBillAsNonChargeable in database_supabase.ts is left with nothing to
 * decide — only rows to lock and write.
 *
 * ============================================================================
 * WHAT THE CLIENT ASKED FOR, AND WHAT IT MEANS FOR THE MONEY
 * ============================================================================
 * "NC has to come up as an option for payment mode when settling a bill, this
 * has to be coded in as analytics for NC is required."
 *
 * NC IS A WAY TO CLOSE A BILL, NOT A WAY TO PAY ONE. payment_methods.ts refuses
 * "NC" as a payment mode on purpose, and that refusal stands: a mode is money
 * collected, and settling with one books the grand total as Gross, as tax and
 * as takings for a meal nobody paid for. So "Settle as NC" is built out of the
 * one NC fact this system already has — the per-line ledger of migration 034 —
 * and never out of an amount:
 *
 *   * every remaining chargeable LINE of the table's still-owing orders is comped
 *     into "OrderItemNonChargeable" with scope 'bill' (migration 052), each with
 *     the kind, the reason and both names, exactly as an item comp is;
 *   * the chargeable subtotal is then 0, so discount, service charge, tax and
 *     round-off are all 0 by computeBillCharges' own rules — nothing is zeroed
 *     by hand;
 *   * the bill closes at ₹0 with payment_method 'NC' (NC_SETTLE_METHOD), which is
 *     how every report can count NC bills without a second source.
 *
 * WHOLE LINES ONLY. A partial NC "by amount" (₹400 NC + ₹600 cash) is refused:
 * an amount cannot say which dishes were given away, and an amount taken off a
 * tax-inclusive total would leave GST and service charge standing on money that
 * was never collected. The partial case already has a correct shape — comp the
 * dishes individually, then take the rest — and the refusal says so.
 *
 * THE VALUE IS THE PRE-TAX LINE VALUE, the same basis as an item comp and as the
 * NC Summary's Loss. What the guest WOULD have been charged (service charge and
 * tax included) is informational only: it goes into the audit line and onto the
 * paper, and into no report ladder, because that money never existed.
 */

import { chargeableSubtotal, isNonChargeableLine, nonChargeableValue, orderLinePrice, orderLineQuantity, round2 } from "./billing_math.js";
import type { OrderLineMoney } from "./billing_math.js";

/** The bill marker. Mirrors payment_methods.ts's NC_SETTLE_METHOD; kept here too so this module needs no settings module. */
export const NC_BILL_METHOD = "NC";

/** The one sentence every client shows for a partial NC. Same words on web and app. */
export const NC_WHOLE_BILL_ONLY =
  "Settle as NC covers the whole bill. To give part of it away, comp dishes individually, then take the rest.";

/** One line a bill NC will comp. `item_id` is the id the flag and the ledger row will carry. */
export interface NcPlannedLine {
  order_id: string;
  /** The line's position in `food.items`, so an id-less or duplicate-id line is still addressable. */
  index: number;
  item_id: string;
  /** True when `item_id` was minted here because the stored line had none (or shared one). */
  minted_id: boolean;
  name: string;
  quantity: number;
  unit_price: number;
  /** round2(quantity x unit_price) — the ledger's GENERATED value, derived the same way. */
  value: number;
}

export interface NcPlan {
  /** The chargeable lines to comp, in order and line order. */
  to_comp: NcPlannedLine[];
  /** Chargeable lines on course hold that were never fired: food nobody served. */
  held: { order_id: string; name: string }[];
  /** Chargeable lines priced below zero, which a comp cannot zero. */
  negative: { order_id: string; name: string }[];
  /** Every line on the still-owing orders, comped or not. 0 = nothing on the table. */
  line_count: number;
  /**
   * The chargeable pre-tax subtotal BEFORE the NC, RE-DERIVED FROM THE LINES
   * per order exactly as repriceOrderFood would store it, and summed — never the
   * sum of the rows, which can differ by a paisa on a weighed (fractional) line.
   * It prices the would-have-charged figure. It is NOT the quote the manager
   * saw: that is the orders' STORED figure (NcSettleFacts.quoted_subtotal), and
   * the two part company on an order a writer priced over its comped lines.
   */
  chargeable_subtotal: number;
  /** Σ value of the lines this NC will comp. */
  value_to_comp: number;
  /** What was already comped on these orders, line by line, before this NC. */
  already_comped: number;
}

/** A line as it sits in "Orders".food.items — only the keys the planner reads. */
export type NcSourceLine = OrderLineMoney & {
  id?: unknown;
  name?: unknown;
  course_hold?: unknown;
  fired_at?: unknown;
};

/**
 * Work out what settling these orders as NC would comp.
 *
 * `newId` mints an id for a line that has none, or whose id another line of the
 * SAME order already carries. The ledger's live-line unique index is
 * (res_id, order_id, item_id), and the flag is applied by position anyway, so a
 * legacy line with no id must not be skipped (that would leave it chargeable and
 * the bill un-closable) and must not collide with its neighbour.
 *
 * A zero-priced line is not comped: it gives nothing away, and a ledger row of
 * ₹0 would count as an NC entry for no money. It is chargeable at ₹0 before and
 * after, which leaves the subtotal at 0 exactly as a comp would.
 */
export function planBillNonChargeable(
  orders: readonly { id: string; items: readonly NcSourceLine[] }[],
  newId: () => string,
): NcPlan {
  const to_comp: NcPlannedLine[] = [];
  const held: { order_id: string; name: string }[] = [];
  const negative: { order_id: string; name: string }[] = [];
  let line_count = 0;
  let chargeable = 0;
  let already = 0;
  let value = 0;
  for (const o of orders) {
    const items = Array.isArray(o.items) ? o.items : [];
    line_count += items.length;
    // Per order, rounded, then summed: the order's stored subtotal IS
    // round2(chargeableSubtotal(items)), and sumOrderTotalsForTable adds those.
    chargeable += chargeableSubtotal(items);
    already = round2(already + nonChargeableValue(items));
    const seen = new Set<string>();
    items.forEach((line, index) => {
      const name = String(line.name ?? "Item");
      const stored = String(line.id ?? "").trim();
      const duplicate = stored !== "" && seen.has(stored);
      if (stored) {seen.add(stored);}
      if (isNonChargeableLine(line)) {return;}
      const price = orderLinePrice(line);
      if (price < 0) { negative.push({ order_id: o.id, name }); return; }
      if (line.course_hold === true && !line.fired_at) { held.push({ order_id: o.id, name }); }
      const unit = round2(price);
      const quantity = orderLineQuantity(line);
      const lineValue = round2(quantity * unit);
      if (!(lineValue > 0)) {return;}
      const minted = stored === "" || duplicate;
      const item_id = minted ? newId() : stored;
      seen.add(item_id);
      to_comp.push({ order_id: o.id, index, item_id, minted_id: minted, name, quantity, unit_price: unit, value: lineValue });
      value = round2(value + lineValue);
    });
  }
  return {
    to_comp, held, negative, line_count,
    chargeable_subtotal: round2(chargeable),
    value_to_comp: value,
    already_comped: already,
  };
}

/** Why a bill cannot be settled as NC. `status` is the HTTP answer the route gives. */
export interface NcSettleRefusal {
  status: 400 | 409;
  code:
    | "payment_pending" | "tenders_recorded" | "discount_on_bill" | "held_lines"
    | "negative_lines" | "nothing_to_settle" | "quote_moved";
  error: string;
}

/** Everything the refusals are decided on, read inside the settle's own transaction. */
export interface NcSettleFacts {
  /** "Bills".waiter_confirmed_at is set, or an order is at status 6. */
  payment_pending: boolean;
  live_tender_count: number;
  live_tender_total: number;
  /** A manual discount, a coupon or a loyalty redemption on the open bill. */
  discount_value: number;
  coupon_code: string | null;
  loyalty_redeemed: boolean;
  plan: Pick<NcPlan, "held" | "negative" | "line_count" | "value_to_comp" | "already_comped">;
  /**
   * What the till IS quoting now: the still-owing orders' STORED subtotals,
   * reduced exactly as the open bill reduces them (activeOrderSubtotal). Both
   * clients send the open bill's `subtotal` as `expected_value`, so this — and
   * not a figure re-derived from the lines — is the one it can be compared
   * with. An order whose stored figure was written over its comped lines (the
   * items-split writer did that before it priced chargeable lines only) quotes
   * more than its lines say; comparing against the lines refused that table on
   * every attempt, with the dialog re-reading the same figure each time.
   */
  quoted_subtotal: number;
  /** What the till was quoting when the manager pressed the button. Absent = not checked. */
  expected_value: number | null;
}

const rupees = (n: number): string => `₹${round2(n).toFixed(2)}`;

function nameList(lines: readonly { name: string }[]): string {
  const names = [...new Set(lines.map((l) => l.name))];
  if (names.length <= 3) {return names.join(", ");}
  return `${names.slice(0, 3).join(", ")} and ${String(names.length - 3)} more`;
}

/**
 * The first reason this bill cannot be settled as NC, or null.
 *
 * ORDER IS THE CONTROL, and every one of these is answered before anything is
 * written:
 *   1. money already taken — a pending waiter-confirmed payment or live tenders.
 *      Converting either would erase money the restaurant has received; the
 *      same rule ReleaseTable keeps.
 *   2. a discount, coupon or redeemed points. A comped bill has nothing to
 *      discount, and clearing a redemption silently would lose the guest's
 *      spent points. Removing it is a deliberate act with its own record.
 *   3. course-held lines never fired — comping them records food that was never
 *      served as given away.
 *   4. a negative-priced line, which no comp can bring to zero.
 *   5. nothing given away at all: an empty table, or one whose only lines are
 *      free (a ₹0 water). An NC bill with no NC value would still count as an
 *      NC bill in every report, for nothing. A table whose every dish was
 *      ALREADY comped is not this — something was given away, and it closes
 *      here at 0.00.
 *   6. the quote moved: the subtotal the till quotes now is not the one the
 *      manager saw, compared in whole paisa.
 */
export function ncSettleRefusal(f: NcSettleFacts): NcSettleRefusal | null {
  if (f.payment_pending) {
    return {
      status: 409, code: "payment_pending",
      error: "A payment for this bill is already waiting for approval. Approve it, or re-open the bill afterwards — settling it as non-chargeable now would erase money already taken.",
    };
  }
  if (f.live_tender_count > 0 && f.live_tender_total > 0) {
    return {
      status: 409, code: "tenders_recorded",
      error: `${rupees(f.live_tender_total)} is already recorded as paid on this bill. Void that payment first, or comp dishes individually and take the rest.`,
    };
  }
  if (f.discount_value > 0 || (f.coupon_code ?? "").trim() !== "" || f.loyalty_redeemed) {
    return {
      status: 409, code: "discount_on_bill",
      error: f.loyalty_redeemed
        ? "This bill has loyalty points redeemed against it. Remove the discount first — a comped bill has nothing to discount, and the guest's spent points would be lost."
        : "This bill carries a discount or a coupon. Remove it first — a comped bill has nothing to discount.",
    };
  }
  if (f.plan.held.length > 0) {
    const one = new Set(f.plan.held.map((h) => h.name)).size === 1;
    return {
      status: 409, code: "held_lines",
      error: `${nameList(f.plan.held)} ${one ? "is" : "are"} on course hold and never went to the kitchen. Void or fire ${one ? "it" : "them"} before settling as non-chargeable.`,
    };
  }
  if (f.plan.negative.length > 0) {
    return {
      status: 409, code: "negative_lines",
      error: `${nameList(f.plan.negative)} ${f.plan.negative.length === 1 ? "has" : "have"} a price below zero, which a comp cannot clear. Remove ${f.plan.negative.length === 1 ? "it" : "them"} first.`,
    };
  }
  const givesNothing = Math.round(f.plan.value_to_comp * 100) === 0 && Math.round(f.plan.already_comped * 100) === 0;
  if (f.plan.line_count === 0 || givesNothing) {
    return { status: 400, code: "nothing_to_settle", error: "There is nothing on this table to settle." };
  }
  if (f.expected_value !== null && Number.isFinite(f.expected_value)
    && Math.round(f.expected_value * 100) !== Math.round(f.quoted_subtotal * 100)) {
    return {
      status: 400, code: "quote_moved",
      error: `The bill changed while you were deciding: its food now comes to ${rupees(f.quoted_subtotal)}, not ${rupees(f.expected_value)}. Check it and settle again.`,
    };
  }
  return null;
}

/**
 * Apply a plan's flags to one order's lines, by POSITION.
 *
 * `items_split` (what the KDS and the course-fire path read) is flagged by id,
 * matching on the id the line carried BEFORE this NC — so a minted id is written
 * onto both representations of the same line. Returns new arrays; the inputs are
 * not touched, because the caller also reads them for the audit line.
 */
export function applyBillNonChargeable(
  items: readonly Record<string, unknown>[],
  split: readonly [string, readonly Record<string, unknown>[]][] | null,
  planned: readonly (NcPlannedLine & { nc_id: string; nc_kind: string })[],
): { items: Record<string, unknown>[]; split: [string, Record<string, unknown>[]][] | null } {
  const byIndex = new Map(planned.map((p) => [p.index, p]));
  const nextItems = items.map((it, i) => {
    const p = byIndex.get(i);
    if (!p) {return { ...it };}
    return { ...it, id: p.item_id, nc: true, nc_id: p.nc_id, nc_kind: p.nc_kind };
  });
  if (split === null) {return { items: nextItems, split: null };}
  // A stored id that several lines shared cannot say which split line is which,
  // so only lines whose id was unique (not minted) are carried across by id.
  const byStoredId = new Map<string, NcPlannedLine & { nc_id: string; nc_kind: string }>();
  for (const p of planned) {
    if (!p.minted_id) {byStoredId.set(p.item_id, p);}
  }
  const nextSplit = split.map(([label, arr]) => [
    label,
    arr.map((it) => {
      const p = byStoredId.get(String(it.id ?? "").trim());
      return p && !isNonChargeableLine(it) ? { ...it, nc: true, nc_id: p.nc_id, nc_kind: p.nc_kind } : { ...it };
    }),
  ] as [string, Record<string, unknown>[]]);
  return { items: nextItems, split: nextSplit };
}

/**
 * THE HARDENING RULE (decision 6): a ₹0 settle whose every priced line was
 * already comped IS an NC bill, whatever pill the till sent.
 *
 * Installed 2.0.0 tills have no NC pill, and their ₹0 path posts the selected
 * mode (UPI by default), so a fully comped table has been booking as a ₹0 UPI
 * bill. Storing 'NC' instead bypasses no control — every line was comped by
 * someone holding the comp permission, with a reason and an authoriser — and it
 * is what lets the reports count that bill as the NC bill it is.
 *
 * Strict: the charged total must be zero in whole paisa, nothing chargeable may
 * remain, and something must actually have been given away. A 100%-discounted
 * bill is NOT this (its lines are chargeable), and neither is an empty one.
 */
export function settlesAsNonChargeable(grandTotal: number, lines: readonly OrderLineMoney[]): boolean {
  if (Math.round((Number(grandTotal) || 0) * 100) !== 0) {return false;}
  if (!lines.some((l) => isNonChargeableLine(l))) {return false;}
  return chargeableSubtotal(lines) === 0 && nonChargeableValue(lines) > 0;
}

/** Is a stored payment method the NC bill marker? Case- and space-insensitive. */
export function isNcBillMethod(raw: unknown): boolean {
  return String(raw ?? "").trim().toLowerCase() === NC_BILL_METHOD.toLowerCase();
}

/**
 * How the settlement is described on paper and on the closed bill, from the
 * ledger rows behind it. `kind` is the one kind when every row agrees, and
 * "mixed" when they do not (a bill whose dishes were comped for different
 * reasons before the rest was settled); the names are listed once each.
 */
export function describeNcSettlement(rows: readonly { nc_kind: string; authorised_by: string; marked_by: string; reason: string; value: number; scope?: string | null }[]): {
  kind: string;
  kind_label: string;
  authorised_by: string;
  marked_by: string;
  reason: string;
  lines: number;
  value: number;
} | null {
  if (rows.length === 0) {return null;}
  // The bill-scope rows describe the settle itself; item comps made earlier on
  // the same bill are part of its value but not of its decision.
  const deciding = rows.some((r) => r.scope === "bill") ? rows.filter((r) => r.scope === "bill") : rows;
  const kinds = [...new Set(deciding.map((r) => r.nc_kind))];
  const uniq = (xs: string[]): string => [...new Set(xs.map((x) => x.trim()).filter(Boolean))].join(", ");
  const kind = kinds.length === 1 ? (kinds[0] ?? "") : "mixed";
  return {
    kind,
    kind_label: kind === "mixed" ? "Several reasons" : ncKindLabel(kind),
    authorised_by: uniq(deciding.map((r) => r.authorised_by)),
    marked_by: uniq(deciding.map((r) => r.marked_by)),
    reason: uniq(deciding.map((r) => r.reason)),
    lines: rows.length,
    value: round2(rows.reduce((s, r) => s + (Number(r.value) || 0), 0)),
  };
}

/** The label both clients show for each kind. Same words as the comp sheets. */
const NC_KIND_LABELS: Readonly<Record<string, string>> = {
  complimentary: "Complimentary",
  staff_meal: "Staff meal",
  spoilage: "Spoilage",
  tasting: "Tasting",
  guest_complaint: "Guest complaint",
  promo: "Promotion",
};

export function ncKindLabel(kind: unknown): string {
  const k = String(kind ?? "").trim();
  if (NC_KIND_LABELS[k]) {return NC_KIND_LABELS[k];}
  const s = k.replace(/[_-]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

// ============================================================================
// THE NC FLAGS ACROSS AN EVERYDAY REWRITE (UpdateOrderItemsSplit)
// ============================================================================
//
// The items-split writer — the web orders-page drag, DELETE
// /orders/:id/items/:itemId and POST /orders/:id/items — stores a whole new line
// list. It used to store the CLIENT's copy of every line, nc keys and all, and
// price it over every line, comped ones included. Two things followed:
//
//   * the order's stored subtotal charged the comped dish again, so the table's
//     bill (and the quote a Settle as NC is checked against) disagreed with its
//     own lines;
//   * the nc flag was whatever the payload said. A payload that dropped it
//     re-charged a dish the ledger still says was given away, and one that
//     ADDED it — once the writer prices chargeable lines only — would be a comp
//     with no reason, no authoriser and no ledger row.
//
// So the flag is SERVER-OWNED on this path too, exactly as AddOrder treats it
// (stripClientNonChargeable): every client key is removed, and a stored comp is
// carried onto the line that is still that line.
//
//   1. BY ECHO. A line that carries the stored comp's own nc_id, and still has
//      the comped line's id, price and quantity, gets the stored flag back. The
//      nc_id is only a pointer here — the flag, the id and the kind written are
//      the stored ones, and each stored comp is carried onto one line at most.
//      A line that echoes a comp but has a different price or quantity is a
//      change to a comped dish, and it is refused: keeping the flag would give
//      away more (or less) than the ledger row says, and dropping it would
//      charge for a dish the ledger says was free.
//   2. BY PLACE, for a payload that echoes nothing (a stale tab, a client that
//      never read the keys). When the payload still holds every line the order
//      had under that id, the comped line is among them, so the comp goes onto
//      the first un-flagged line with the same id, price and quantity — the same
//      money whichever of two identical lines carries it. None matching is the
//      same refusal as above.
//   3. Otherwise the comped line was REMOVED (fewer lines under its id than the
//      order had), and it leaves with its flag, as it always has.
//
// A comp is never created here: a line the order did not have comped cannot
// come out of this function comped.

/** The keys that decide whether a guest is charged for a line. Server-owned. */
const NC_LINE_KEYS = ["nc", "nc_id", "nc_kind"] as const;

type LineObject = Record<string, unknown>;

const isLineObject = (v: unknown): v is LineObject => typeof v === "object" && v !== null && !Array.isArray(v);

const lineIdOf = (line: LineObject): string => String(line.id ?? "").trim();

const samePriceAndQuantity = (a: LineObject, b: LineObject): boolean =>
  Math.round(orderLinePrice(a) * 100) === Math.round(orderLinePrice(b) * 100)
  && Math.abs(orderLineQuantity(a) - orderLineQuantity(b)) < 1e-9;

/**
 * Carry the stored comps onto a client-supplied items_split. `stored` is the
 * order's lines as they are in the database; `split` is the payload. Returns the
 * split to store (client nc keys gone, stored comps re-applied) or the sentence
 * that refuses the write. Non-mutating.
 */
export function carryServerNonChargeable(
  stored: readonly unknown[],
  split: readonly unknown[],
): { split: unknown[]; refusal: string | null } {
  // The payload, stripped. A tuple that is not [label, lines[]] passes through
  // untouched, as AddOrder passes it: this path tolerates legacy shapes.
  const lines: { line: LineObject; hint: string; flagged: boolean }[] = [];
  const next = split.map((t) => {
    if (!Array.isArray(t) || !Array.isArray(t[1])) {return t;}
    const arr = (t[1] as unknown[]).map((raw) => {
      if (!isLineObject(raw)) {return raw;}
      const copy: LineObject = { ...raw };
      for (const k of NC_LINE_KEYS) {delete copy[k];}
      lines.push({ line: copy, hint: typeof raw.nc_id === "string" ? raw.nc_id.trim() : "", flagged: false });
      return copy;
    });
    return [t[0], arr, ...t.slice(2)];
  });

  const storedLines = stored.filter(isLineObject);
  const comps = storedLines
    .filter((l) => isNonChargeableLine(l))
    .map((l) => ({ line: l, nc_id: String(l.nc_id ?? "").trim(), id: lineIdOf(l), used: false }));
  const carry = (target: { line: LineObject; flagged: boolean }, comp: (typeof comps)[number]): void => {
    target.line.nc = true;
    if (comp.line.nc_id !== undefined) {target.line.nc_id = comp.line.nc_id;}
    if (comp.line.nc_kind !== undefined) {target.line.nc_kind = comp.line.nc_kind;}
    target.flagged = true;
    comp.used = true;
  };
  const changed = (comp: (typeof comps)[number]): string =>
    `${String(comp.line.name ?? "A dish")} is comped as non-chargeable, and this change would alter it. Undo the comp first, or refresh the order and try again.`;

  // 1. By echo.
  for (const target of lines) {
    if (!target.hint) {continue;}
    const comp = comps.find((c) => !c.used && c.nc_id !== "" && c.nc_id === target.hint);
    if (!comp) {continue;}
    if (lineIdOf(target.line) !== comp.id || !samePriceAndQuantity(target.line, comp.line)) {
      return { split: next, refusal: changed(comp) };
    }
    carry(target, comp);
  }

  // 2. By place, only where no line under that id was removed.
  for (const comp of comps) {
    if (comp.used || comp.id === "") {continue;}
    const had = storedLines.filter((l) => lineIdOf(l) === comp.id).length;
    const sameId = lines.filter((l) => lineIdOf(l.line) === comp.id);
    if (sameId.length < had) {continue;} // 3. removed
    const target = sameId.find((l) => !l.flagged && samePriceAndQuantity(l.line, comp.line));
    if (!target) {return { split: next, refusal: changed(comp) };}
    carry(target, comp);
  }
  return { split: next, refusal: null };
}

/**
 * The set of live comps on a line list, as one comparable string: the nc_id of
 * every comped line, sorted by code unit and joined with commas.
 *
 * UpdateOrderItemsSplit writes only while the stored order still has THIS
 * signature — the comps it carried are the comps that are there. Its SQL
 * computes the same string (`collate "C"` is the code-unit order), so a comp,
 * a reversal or a Settle as NC committed between its read and its write makes
 * the write match nothing instead of overwriting them.
 */
export function ncFlagSignature(lines: readonly unknown[]): string {
  return lines
    .filter(isLineObject)
    .filter((l) => isNonChargeableLine(l))
    .map((l) => (l.nc_id === undefined || l.nc_id === null ? "" : String(l.nc_id)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join(",");
}
