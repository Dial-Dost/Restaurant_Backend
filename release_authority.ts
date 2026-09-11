/**
 * RELEASING A TABLE THAT STILL OWES MONEY IS A WRITE-OFF, and this module is the
 * rule that says when.
 *
 * ============================================================================
 * THE HOLE THIS CLOSES
 * ============================================================================
 * C2 put all five settle paths behind PERM_CLOSE_BILL (see enforceSettleAuthority).
 * POST /release-table was left alone, because releasing a table reads as floor
 * work rather than as money. It is not. ReleaseTable:
 *
 *   1. sets every still-active order on the table to status 5 (cancelled), and
 *   2. closes the open bill with `closed_by_username = 'released'` and
 *      `total_amt = 0` whenever the bill has not been admin-approved.
 *
 * So the bolt on the front door meant a waiter could not settle a ₹9,000 bill
 * for ₹9,000 — and could still make the same ₹9,000 disappear for ₹0, on a
 * permission (090ea8d4, "Table status/occupy/release") the CORE WAITER ROLE
 * holds. That is worse than never having restricted settle: the restriction is
 * visible, so it is trusted, and the number it protects leaves by the side door.
 *
 * ============================================================================
 * WHERE THE LINE SITS, AND WHY IT IS NOT "THE ROUTE"
 * ============================================================================
 * Gating the whole ROUTE on PERM_CLOSE_BILL would be the easy fix and it would
 * break the floor. Releasing an EMPTY table — a party that sat down, ordered
 * nothing and left; a table opened on the wrong number; a takeaway slot being
 * recycled — is the single commonest floor action there is, it destroys nothing,
 * and a waiter who has to find a manager to free a table will stop freeing
 * tables. The requirement is not "waiters may not release tables". It is
 * "nobody writes off money without the authority to settle it".
 *
 * So THE GATE DEPENDS ON THE BILL, NOT ON THE ROUTE:
 *
 *     A release that would destroy VALUE needs the authority to settle that
 *     value. A release that destroys nothing is ordinary floor work.
 *
 * ============================================================================
 * WHAT COUNTS AS VALUE — THE GREATER OF TWO NUMBERS, DELIBERATELY
 * ============================================================================
 * "Bills".total_amt is the running PRE-TAX subtotal, re-synced by
 * resyncOpenBillTotal on the paths that edit a bill. It is not re-synced by
 * every path that adds an order: a table can carry ₹4,000 of active orders with
 * no "Bills" row at all (resyncOpenBillTotal deliberately does not mint one for
 * an empty table, and AddOrder does not always run it). Reading only the bill
 * would therefore report ₹0 for exactly the table a waiter would most like to
 * make vanish — orders rung up, bill never generated.
 *
 * Reading only the ORDERS has the mirror flaw: a bill that has been discounted,
 * couponed or split carries a total the raw order sum does not reproduce.
 *
 * The gate therefore takes the GREATER of the two. Over-reporting value costs a
 * waiter one escalation on a table that turns out to be empty; under-reporting
 * it is the bug. When the two disagree the difference is itself worth reporting,
 * which is why both numbers travel in [ReleaseImpact] rather than being
 * collapsed at the read.
 *
 * ============================================================================
 * WHY A PURE MODULE
 * ============================================================================
 * Same reason as role_scope.ts, service_clock.ts and billing_math.ts: it is a
 * rule about money, so it has to be testable without a database, and both the
 * route and any future caller (a till that wants to ask "will this need a
 * manager?" before showing the button) must reach the SAME answer rather than
 * each writing its own `> 0`.
 */

/** The pre-tax rupee value a release would destroy, from both of its sources. */
export interface ReleaseImpact {
	/** "Bills".total_amt on the table's OPEN bill, or 0 when there is no open bill. */
	open_bill_total: number;
	/** Σ chargeable subtotal of the table's still-active orders. */
	active_order_total: number;
	/** How many still-active orders the release would move to status 5. */
	active_order_count: number;
	/** Whether an open (not yet closed) "Bills" row exists for this table at all. */
	has_open_bill: boolean;
}

/** A zero impact — the shape an empty table produces. */
export const EMPTY_RELEASE_IMPACT: ReleaseImpact = {
	open_bill_total: 0,
	active_order_total: 0,
	active_order_count: 0,
	has_open_bill: false,
};

const num = (v: unknown): number => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * The money a release would write off: the GREATER of the open bill's running
 * total and the sum of the table's active orders. See the header for why both.
 */
export function releaseWriteOffValue(impact: Partial<ReleaseImpact> | null | undefined): number {
	return Math.max(num(impact?.open_bill_total), num(impact?.active_order_total));
}

/**
 * Is this release a write-off?
 *
 * VALUE, NOT MERE EXISTENCE, is the test. A table carrying an open bill of ₹0
 * and no orders — generated by mistake, or emptied down to nothing by a manager
 * who already had the authority to empty it — destroys nothing when it closes,
 * and refusing it would put a waiter in front of a table they cannot free and
 * cannot explain. The same goes for a table whose every line has been comped:
 * marking an item non-chargeable already required PERM_NON_CHARGEABLE (a manager
 * act, ledgered by migration 034), the giveaway is already recorded, and the
 * revenue being released is genuinely zero.
 */
export function releaseIsWriteOff(impact: Partial<ReleaseImpact> | null | undefined): boolean {
	return releaseWriteOffValue(impact) > 0;
}

/** What the route should do with this release. */
export interface ReleaseVerdict {
	allowed: boolean;
	/** The money at stake. 0 on an ordinary release. */
	write_off_value: number;
	/** Present only on a refusal — the sentence the caller is shown, verbatim. */
	details?: string;
}

/**
 * MAY THIS IDENTITY RELEASE THIS TABLE?
 *
 * `closeBillPermission` is passed in rather than imported so this module stays
 * free of routes/_shared.ts (which pulls in the whole data layer). The route
 * hands it PERM_CLOSE_BILL — the SAME uuid enforceSettleAuthority checks, never
 * a new one. Minting a new id for "may write off a table" would strip the
 * capability from every role that holds it today (migration 025's rule) and
 * would let the two answers drift: a tenant that has decided who settles has
 * already decided who may write off, and being asked the question twice is how
 * the two end up with different answers.
 *
 * AN ADMIN LOSES NOTHING: "*" satisfies this exactly as it satisfies every other
 * gate in the codebase.
 */
export function mayReleaseTable(input: {
	actions?: unknown;
	impact?: Partial<ReleaseImpact> | null;
	closeBillPermission: string;
	tableName?: string;
	currency?: string;
}): ReleaseVerdict {
	const value = releaseWriteOffValue(input.impact);
	if (value <= 0) { return { allowed: true, write_off_value: 0 }; }

	const actions = Array.isArray(input.actions) ? input.actions.map((a) => String(a).trim()) : [];
	if (actions.includes("*") || actions.includes(input.closeBillPermission)) {
		return { allowed: true, write_off_value: value };
	}

	const where = input.tableName ? `${input.tableName} ` : "";
	const money = `${input.currency ?? "₹"}${value.toFixed(2)}`;
	return {
		allowed: false,
		write_off_value: value,
		// NAMES THE PERMISSION AND THE NUMBER, for the same reason
		// enforceSettleAuthority's message does: "Forbidden" sends an owner hunting
		// through the role editor and tells the waiter nothing, whereas "this
		// writes off ₹9,000 and needs Close Bill" is both the explanation and the
		// checkbox. The amount is in the message because the waiter standing at
		// the table is the person best placed to notice it is the wrong table.
		details:
			`Releasing table ${where}would void ${money} of unpaid orders and close its bill at zero. ` +
			`That is a write-off, so it requires the same 'Close Bill' permission as settling the bill. ` +
			`Settle it, or ask a manager to release it.`,
	};
}
