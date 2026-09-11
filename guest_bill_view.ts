/**
 * WHAT AN UNAUTHENTICATED GUEST IS TOLD ABOUT THEIR OWN BILL.
 *
 * GET /qr/:slug/bill answers anyone holding a table's QR token, and it used to
 * hand back GetBillForTable's ENTIRE result — an object built for the till. So
 * the guest's browser received:
 *
 *   * `note` on every line — the KITCHEN instruction. The QR menu's own
 *     placeholder invites "no onions, less spicy, ALLERGIES", which makes this
 *     the one field on a bill that can be a medical detail, and it was handed to
 *     whoever asked. No guest UI ever drew it, so the exposure was invisible
 *     rather than absent: one devtools tab, or one curl, away.
 *   * `apc`, `target_apc`, `apc_status`, `apc_suggestions` — the restaurant's
 *     own performance figures and the coaching prose written for its managers.
 *   * `nc_total` — what the house has given away on this table.
 *   * `order_ids`, `bill_id`, `table_id` — internal handles.
 *
 * AN ALLOWLIST, NOT A REDACTION, and that choice is the whole design. A
 * delete-list has to be updated every time the till gains a field, by someone
 * who happens to remember this endpoint exists, and its failure is silent and
 * public. Listing what the guest MAY see inverts the default: a new till-side
 * field is invisible here until somebody decides otherwise.
 *
 * A MODULE OF ITS OWN, WITH NO RUNTIME IMPORTS, for the same reason
 * me_scorecard.ts is one: routes/guest.ts pulls in the entire database layer,
 * which cannot be loaded under jest, so a rule that lives in it cannot be
 * tested. This rule is exactly the kind that must be.
 *
 * The shape is precisely what the two real consumers read — the QR order page's
 * BillData and the customer-facing display, which parse the same response — so
 * nothing on either screen moves.
 */

/** One line as the guest is shown it. */
export interface GuestBillItem {
	name: string;
	price: number;
	quantity: number;
	/** The price point they were actually sold ("Half", "Bottle"), when there is one. */
	variation?: string;
}

/** The bill as the guest is shown it. */
export interface GuestBillView {
	items: GuestBillItem[];
	total_amt: number;
	subtotal: number;
	discount: number;
	coupon_code: string | null;
	service_charge: number;
	service_charge_percent: number;
	taxes: { name: string; percentage: number; amount: number }[];
	tax_total: number;
	grand_total: number;
	covers: number;
	bill_no: string | null;
	payment_method: string | null;
	payment_status: string | null;
}

/**
 * The till's bill, as far as this projector needs to read it. Deliberately a
 * STRUCTURAL subset rather than an import of GetBillForTable's return type:
 * naming the fields here is what keeps this module free of runtime imports, and
 * an extra property on the argument is accepted and dropped, which is the
 * behaviour the allowlist wants.
 */
export interface TillBillLike {
	items: { name: string; price: number; quantity: number; variation?: string }[];
	total_amt: number;
	subtotal: number;
	discount: number;
	coupon_code: string | null;
	service_charge: number;
	service_charge_percent: number;
	taxes: { name: string; percentage: number; amount: number }[];
	tax_total: number;
	grand_total: number;
	covers: number;
	bill_no: string | null;
	payment_method: string | null;
	payment_status: string | null;
}

export function guestBillView(bill: TillBillLike): GuestBillView {
	return {
		items: bill.items.map((it) => ({
			name: it.name,
			quantity: it.quantity,
			price: it.price,
			// Absent rather than null when the dish has no price point, so a
			// restaurant that has configured no variations gets the response it
			// got before variations existed.
			...(it.variation ? { variation: it.variation } : {}),
		})),
		total_amt: bill.total_amt,
		subtotal: bill.subtotal,
		discount: bill.discount,
		coupon_code: bill.coupon_code,
		service_charge: bill.service_charge,
		service_charge_percent: bill.service_charge_percent,
		taxes: bill.taxes,
		tax_total: bill.tax_total,
		grand_total: bill.grand_total,
		covers: bill.covers,
		bill_no: bill.bill_no,
		payment_method: bill.payment_method,
		payment_status: bill.payment_status,
	};
}
