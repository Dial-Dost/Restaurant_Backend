/**
 * C4 — WHAT A SCOPED FLOOR ROLE IS TOLD A TABLE IS WORTH.
 *
 * V3, verbatim: "Hide Prices for Waiters: When a waiter is taking an order at a
 * table, remove the prices from the list of ordered dishes displayed on the
 * right side. Only the dish name and quantity should remain visible."
 *
 * ============================================================================
 * THE DEFECT THIS CLOSES: THE RULE WAS DRAWN, NOT ENFORCED
 * ============================================================================
 * The Flutter app implements C4 by not DRAWING the figures — `RoleScope
 * .showsMoney`, which is literally `!isWaiterOnly`, gates the per-dish amount
 * down the right of the bill sheet (table_bill.dart), the same amount in the
 * table sheet's order list and in the order-detail sheet, the whole
 * Subtotal/Discount/Service charge/Tax/TOTAL PAYABLE card, the running bill,
 * the APC pair, and the floor tile's "₹1,200 · bill · apc ₹300" line.
 *
 * The SERVER sent every one of those numbers to every role. So the restriction
 * was worth exactly as much as the client drawing it: one devtools tab, one
 * `curl -H "Authorization: Bearer <the waiter's own token>"`, or one build of
 * the app from a release that predates the gate, and the day's takings on that
 * table are back on screen. That is the same shape as the C3 defect
 * (print_once_authority.test.ts's header) and the same shape as the client-side
 * `roles.every(r => r == 'waiter')` that role_scope.ts exists to kill: A HIDDEN
 * CONTROL MUST BE UNREACHABLE, NOT MERELY UNDRAWN, and a hidden FIGURE must be
 * ABSENT, not merely unpainted.
 *
 * ============================================================================
 * WHO IS NARROWED — isWaiterOnly, AND NOTHING ELSE
 * ============================================================================
 * The predicate is role_scope.ts's `isWaiterOnly`: the SAME function that ships
 * `scope.waiter_only` on every session payload and the SAME one routes/bills.ts
 * asks before refusing a waiter's reprint. One rule, one place. A second
 * predicate written here — "role === 'waiter'", an actions test, anything —
 * would be a third answer to a question that already has two clients obeying
 * one, and it would drift on exactly the tenants role_scope.ts's header names:
 * a waiter carrying a custom role UUID, or the "employee" placeholder.
 *
 * A manager, cashier, captain or admin therefore gets a byte-identical payload
 * to the one they get today. So does an unreadable or empty role set —
 * isWaiterOnly fails towards "not scoped", because a floor that cannot read its
 * own tables is a worse outage than a figure on a screen.
 *
 * ============================================================================
 * THE LINE DRAWN: AMOUNTS GO, RATES AND FACTS STAY
 * ============================================================================
 * The rule applied below is ONE sentence — "a waiter-only session is told no
 * MONETARY AMOUNT about this table" — and it is deliberately wider than the
 * requirement's literal words, because it is the line the Flutter app already
 * draws and drawing a narrower one server-side would leave the app hiding
 * figures the server still sends.
 *
 * GONE:
 *   * every per-line amount (`items[].price`) — the requirement itself;
 *   * every bill-level amount: total_amt, subtotal, discount, discount_value,
 *     service_charge, tax_total, grand_total, nc_total, and each tax line's own
 *     `amount`. `RoleScope.showsMoney` hides that whole totals card from a
 *     waiter as a unit (table_bill.dart:270, modules.dart:9451), so sending it
 *     would be redacting the line prices and shipping their sum;
 *   * the APC PAIR (`apc`, `target_apc`) and the floor row's `table_total` /
 *     `table_apc`. These are the restaurant's per-head takings, not the guest's
 *     bill, and they are behind the same gate in the app;
 *   * on the orders feed, each ticket's `subtotal` and `total`.
 *
 * KEPT, and each for a reason a waiter can act on:
 *   * the DISH: name, quantity, note, variation, non-chargeable flag, station,
 *     hold/fire state. "Only the dish name and quantity should remain visible"
 *     is the requirement; the note and the variation are the TICKET, and a
 *     waiter who cannot read the ticket cannot work the table.
 *   * `covers` — a count of people, not money, and the order pad asks for it.
 *   * `apc_status` and `apc_suggestions` — the traffic-light word and the
 *     server's own upsell prose. The app shows the suggestion card to a waiter
 *     deliberately (table_bill.dart's `_suggestions` sits OUTSIDE the money
 *     gate): "suggest a dessert" is coaching, and taking it away would remove a
 *     feature rather than a figure. The colour is a coarse derivative of a
 *     number we are no longer sending, and that is the price of keeping it.
 *   * `service_charge_percent` and each tax line's `name`/`percentage` — RATES,
 *     not amounts. They are the same public numbers GET /restaurant/settings
 *     hands every role and they are printed on the guest's copy; they say what
 *     the restaurant charges, not what this table owes.
 *   * `payment_status`, `payment_method`, `payment_pending`, `bill_no`,
 *     `print_count`/`bill_printed_at`/`printed_at`, the service clock and every
 *     timestamp. THIS IS THE ANSWER TO "a waiter still has to see that a table
 *     owes money": they see THAT it does — the table is occupied, payment is
 *     pending, the bill is printed or it is not — without being told HOW MUCH.
 *     The amount a guest is handed comes off the PRINTED bill, which is
 *     rendered server-side from GetBillForTable's own read and is untouched by
 *     anything here.
 *
 * ============================================================================
 * OMITTED, NOT NULLED — AND WHY IT CANNOT CRASH THE SHIPPED CLIENT
 * ============================================================================
 * Checked against the Flutter app before choosing, because a redaction that
 * red-screens a floor tablet is worse than the exposure it closes.
 *
 * IN DART THE TWO ARE THE SAME VALUE. Every one of these payloads is consumed
 * as a raw `Map<String, dynamic>` — there is no model class for a bill, an
 * order or a table row anywhere in `lib/` — and `map['price']` on a Dart map
 * returns `null` both for a key that is absent and for a key whose value is
 * null. There is no `undefined`. So no reachable expression can tell the two
 * apart, and the choice cannot break a parse that the other option survives.
 *
 * AND NEITHER CAN CRASH ONE. There is not a single non-nullable `as double` /
 * `as num` on these fields in the app; every money read funnels through one of
 * five helpers that are all `?? 0`- or `num.tryParse`-terminated:
 *
 *     double _num(dynamic v) => v is num ? v.toDouble() : (double.tryParse('${v ?? ''}') ?? 0);
 *     String _money(dynamic v) { final n = v is num ? v : num.tryParse('${v ?? ''}');
 *                                return n == null ? '—' : '₹${n.toStringAsFixed(2)}'; }
 *
 * — so a redacted field reads as `0` where it is arithmetic and as an em-dash
 * where it is text, in both shapes, and the em-dash is behind the money gate
 * anyway so a waiter never sees it. The fallback chains (`bill['subtotal'] ??
 * bill['total_amt']`, `bill['grand_total'] ?? bill['total_amt']`,
 * `it['total'] ?? it['price']`) are the one thing that WOULD have leaked, and
 * they are why every member of each chain is listed below: redacting
 * `subtotal` while sending `total_amt` would have hidden nothing at all.
 *
 * THE TIE IS BROKEN ON THE OTHER CONSUMERS. A JSON `null` reaching JavaScript
 * arithmetic — the web dashboard, any integration — is silently `0`:
 * `Number(null) === 0`, `null + 0 === 0`. A redacted bill that reads as a bill
 * FOR ZERO is worse than one that reads as unknown, because zero is a number
 * somebody will act on. An absent key gives `undefined` and therefore `NaN`,
 * which is visible on the screen that has the bug. Omission is also what an
 * allowlist projection produces naturally (guest_bill_view.ts) and it is the
 * shape this codebase has already committed to once, in the same payload:
 * OrderItemRecord's variation keys are "OMITTED, not sent as null".
 *
 * ============================================================================
 * A PURE MODULE, AND APPLIED AT THE ROUTE BOUNDARY — NEVER IN THE READER
 * ============================================================================
 * No runtime imports but role_scope.ts (which has none), for the same reason
 * guest_bill_view.ts and me_scorecard.ts have none: it is a rule about money
 * and visibility, so it must be testable without a database.
 *
 * And it is applied where the payload becomes a RESPONSE, never inside
 * GetBillForTable / GetTables / GetOrders. Those readers feed the ESC/POS
 * renderer, the settle paths, the split, the KOT, the guest QR projection, the
 * reports and the reaper. A redaction pushed down into them would take the
 * prices off the guest's printed bill — which is the one document that must
 * always carry them — and the failure would be discovered on paper, in a
 * restaurant, by a guest. So the readers stay the single source of truth about
 * what a table is worth and this module decides who is told.
 */

import { isWaiterOnly, type RoleScopeInput } from "./role_scope.js";

/**
 * Does THIS session get the redacted shape?
 *
 * A thin adapter over isWaiterOnly and deliberately nothing more: the rule is
 * role_scope.ts's and stays there. It exists only so the three routes do not
 * each spell out `{ role, role_all, actions }`, which is three places for a
 * field name to be mistyped into a silently un-scoped session.
 *
 * An ABSENT session is not scoped. requireAuth has already run on every route
 * that calls this — there is no anonymous caller here — so a missing `req.auth`
 * means something upstream is wrong, and the direction to be wrong in is the
 * one that leaves the floor working.
 */
export function hidesPrices(session: RoleScopeInput | null | undefined): boolean {
	if (!session) { return false; }
	return isWaiterOnly(session);
}

/**
 * The per-line keys that carry an AMOUNT, on every item shape this codebase
 * ships (the merged bill line and the order line are different types with the
 * same money key).
 */
export const REDACTED_ITEM_MONEY_KEYS: readonly string[] = ["price"];

/**
 * The bill-level keys that carry an AMOUNT on GET /bill-for-table.
 *
 * `total_amt` is in here BECAUSE OF THE CLIENT'S FALLBACK CHAIN, not because
 * anything draws it directly: the app reads `subtotal ?? total_amt` and
 * `grand_total ?? total_amt`, so leaving it behind would have published the
 * bill twice under a third name.
 *
 * `discount_value` is here and `discount_type` is not. The value is an AMOUNT
 * when the type is "flat" and a percentage when it is "percent"; a key that is
 * money half the time is redacted all of the time, because the alternative is a
 * rule that leaks on whichever configuration the tenant happens to use. The
 * TYPE is a label and tells nobody what the table is worth.
 */
export const REDACTED_BILL_MONEY_KEYS: readonly string[] = [
	"total_amt", "subtotal", "discount", "discount_value",
	"service_charge", "tax_total", "grand_total", "nc_total",
	"apc", "target_apc",
];

/** The money keys on a /get-tables row. `apc_status` is NOT one — see the header. */
export const REDACTED_TABLE_ROW_MONEY_KEYS: readonly string[] = [
	"table_total", "table_apc", "target_apc",
];

/** The money keys on an OrderRecord (GET /orders). */
export const REDACTED_ORDER_MONEY_KEYS: readonly string[] = ["subtotal", "total"];

/**
 * Copy `src` without `keys`.
 *
 * A COPY, never a mutation of the argument. GetTables and GetOrders build their
 * rows fresh per request today, but GetBillForTable's result is handed to the
 * printer, the split and the settle paths in other handlers, and a redactor that
 * deleted keys in place would eventually be called on an object one of those
 * still holds — and would take the prices off a guest's receipt. Making the
 * non-destructive shape the ONLY shape available here is what stops that from
 * being one refactor away.
 */
function without(src: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(src)) {
		if (keys.includes(k)) { continue; }
		out[k] = v;
	}
	return out;
}

/** One bill/order line with its amount removed; everything else survives. */
function redactItem(item: unknown): unknown {
	if (item === null || typeof item !== "object" || Array.isArray(item)) { return item; }
	return without(item as Record<string, unknown>, REDACTED_ITEM_MONEY_KEYS);
}

/**
 * The tax ladder with the AMOUNTS taken out and the RATES left in.
 *
 * `{ name: "GST", percentage: 5, amount: 212.45 }` becomes
 * `{ name: "GST", percentage: 5 }`. The percentage is what the restaurant
 * charges — it is printed on the guest's copy and readable from
 * GET /restaurant/settings by every role — and dropping the whole array would
 * be redacting configuration rather than money.
 */
function redactTaxes(taxes: unknown): unknown {
	if (!Array.isArray(taxes)) { return taxes; }
	return taxes.map((t) => (t !== null && typeof t === "object" && !Array.isArray(t)
		? without(t as Record<string, unknown>, ["amount"])
		: t));
}

/**
 * GET /bill-for-table, as a waiter-only session is told it.
 *
 * Structurally typed (`Record<string, unknown>` in, same out) rather than typed
 * against GetBillForTable's return, for guest_bill_view.ts's reason: naming the
 * shape here is what keeps this module free of the data layer, and a field the
 * reader gains that is NOT in the lists above survives untouched — which is the
 * one behaviour a redaction must be honest about, and the reason the tests
 * assert on the surviving keys as well as the removed ones.
 */
export function redactBillForTable(bill: Record<string, unknown>): Record<string, unknown> {
	const out = without(bill, REDACTED_BILL_MONEY_KEYS);
	if (Array.isArray(bill.items)) { out.items = bill.items.map(redactItem); }
	if ("taxes" in bill) { out.taxes = redactTaxes(bill.taxes); }
	return out;
}

/** One row of GET /get-tables, as a waiter-only session is told it. */
export function redactTableRow(row: Record<string, unknown>): Record<string, unknown> {
	return without(row, REDACTED_TABLE_ROW_MONEY_KEYS);
}

/** The whole GET /get-tables list. Non-arrays pass through — the route sends `[]`. */
export function redactTableList(rows: unknown): unknown {
	if (!Array.isArray(rows)) { return rows; }
	return rows.map((r) => (r !== null && typeof r === "object" && !Array.isArray(r)
		? redactTableRow(r as Record<string, unknown>)
		: r));
}

/**
 * One ticket of GET /orders, as a waiter-only session is told it.
 *
 * `taxes` on an OrderRecord is `{ id, name, percentage }` — it carries no
 * amount at all — so it is left exactly as it is, and so are
 * `serviceChargePercentage` and `applyServiceCharge`. Same line as everywhere
 * else here: rates and configuration stay, amounts go.
 */
export function redactOrderRecord(order: Record<string, unknown>): Record<string, unknown> {
	const out = without(order, REDACTED_ORDER_MONEY_KEYS);
	if (Array.isArray(order.items)) { out.items = order.items.map(redactItem); }
	return out;
}

/** The whole GET /orders list. */
export function redactOrderList(orders: unknown): unknown {
	if (!Array.isArray(orders)) { return orders; }
	return orders.map((o) => (o !== null && typeof o === "object" && !Array.isArray(o)
		? redactOrderRecord(o as Record<string, unknown>)
		: o));
}
