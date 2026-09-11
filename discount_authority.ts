/**
 * DISCOUNTING A BILL DOWN TO NOTHING IS A WRITE-OFF, and this module is the rule
 * that says when.
 *
 * ============================================================================
 * THE HOLE THIS CLOSES — AND THE DEFAULT THAT PROVES IT IS REAL
 * ============================================================================
 * POST /bills/discount is gated on 4ad474d4 "Add Orders", which the CORE WAITER
 * ROLE holds (CORE_ROLES.waiter). A 100% discount zeroes a bill economically —
 * the same outcome release_authority.ts was written to prevent, through a wider
 * door: the release gate stops a waiter voiding a ₹9,000 table, and a single
 * `{type:'percent', value:100}` did the same thing with the bill still on the
 * screen.
 *
 * IT WAS LEFT OPEN ON THE RATIONALE THAT "LARGE DISCOUNTS NEED APPROVAL". THAT
 * RATIONALE IS FALSE ON A DEFAULT TENANT, and the proof is two lines of shipped
 * code:
 *
 *   database_supabase.ts (ensure… migration):
 *     alter table "Restaurant" add column if not exists
 *       discount_approval_threshold numeric default 0
 *
 *   SetBillDiscountWithApproval:
 *     const threshold = await getDiscountApprovalThreshold(...);
 *     if (threshold > 0) { ...park as a pending DiscountRequests row... }
 *
 * The column DEFAULTS TO 0 and the workflow only engages when it is ABOVE zero.
 * So on every restaurant that has never opened Settings and typed a number —
 * which is every restaurant on day one — there is no approval step at all and
 * the discount applies immediately. The approval path protects only tenants who
 * had already thought about the problem. A gate has to hold for the tenant who
 * has not.
 *
 * ============================================================================
 * WHERE THE LINE SITS, AND WHY IT IS NOT "THE ROUTE"
 * ============================================================================
 * Moving the whole route to PERM_CLOSE_BILL would break the floor. Taking ₹50
 * off for a slow starter, rounding ₹1,247 down to ₹1,200, giving the regular
 * their usual 10% — that is ordinary front-of-house work, it is why the control
 * exists, and a waiter who must fetch a manager for ₹50 will stop giving the ₹50
 * and the restaurant will feel it. Same shape of argument as
 * release_authority.ts: the requirement is not "waiters may not discount", it is
 * "nobody writes off a bill without the authority to settle it".
 *
 * So THE GATE DEPENDS ON THE DISCOUNT, NOT ON THE ROUTE.
 *
 * ============================================================================
 * WHAT COUNTS AS A WRITE-OFF — TWO LIMBS, BOTH IN RUPEES
 * ============================================================================
 * "100%" IS NOT THE ONLY WRITE-OFF. A 99.9% discount that leaves ₹1 behind is
 * the same act wearing a fig leaf, and a gate written on the percentage would
 * wave it through. So the first limb is stated on the money that SURVIVES:
 *
 *   1. RESIDUAL — a discount that hands back MORE THAN HALF the bill leaves
 *      something that is not really a bill any more. Expressed as remaining
 *      value (`remaining < subtotal/2`) rather than as a percentage, so 100%,
 *      99.9% and "flat ₹4,999 off a ₹5,000 table" are all one case with one
 *      answer. It is proportional on purpose: it holds on a ₹200 table and on a
 *      ₹200,000 one, and it cannot be dodged by picking `flat` over `percent`.
 *
 *   2. MAGNITUDE — a discount that hands back more than
 *      DEFAULT_FLOOR_DISCOUNT_CEILING (₹2,000) in one go is write-off scale
 *      whatever fraction of the bill it is. 10% of a ₹40,000 banquet is ₹4,000
 *      of somebody's money, and the residual limb alone would pass it.
 *
 *      THIS LIMB YIELDS TO A TENANT THAT HAS CONFIGURED ITS OWN THRESHOLD. When
 *      "Restaurant".discount_approval_threshold > 0 the restaurant HAS an answer
 *      for magnitude — the DiscountRequests approval queue — and a 403 here
 *      would kill the feature it configured: the point of that queue is that a
 *      waiter CAN request a big discount and a manager decides. So limb 2 fires
 *      only where there is no approval path at all, which is the default tenant
 *      the paragraph above is about. Limb 1 always fires: a threshold of ₹50,000
 *      would otherwise auto-approve zeroing an ₹800 table.
 *
 * NOTHING HERE IS CONFIGURABLE BY THE FLOOR. Both numbers are constants a tenant
 * cannot lower to nothing, because "the restaurant may switch the gate off" is
 * how the approval threshold ended up defaulting to off.
 *
 * ============================================================================
 * WHY A PURE MODULE
 * ============================================================================
 * Same reason as release_authority.ts, role_scope.ts and billing_math.ts: it is
 * a rule about money, so it must be testable without a database, and the route,
 * the data layer and any future till that wants to ask "will this need a
 * manager?" before drawing the button must reach the SAME answer instead of each
 * writing its own `>= 100`.
 */

/** The share of a bill that must SURVIVE a discount for it to be an ordinary one. */
export const WRITE_OFF_RESIDUAL_SHARE = 0.5;

/**
 * The most a discount may hand back on floor authority alone when the tenant has
 * configured no approval threshold of its own. Rupees.
 */
export const DEFAULT_FLOOR_DISCOUNT_CEILING = 2000;

/** What a discount would do to a bill, in rupees. Both figures are PRE-TAX. */
export interface DiscountImpact {
	/** The pre-tax base the discount comes off — Σ chargeable order subtotals. */
	subtotal: number;
	/** What the discount hands back, sized the way the bill math will size it. */
	discount_amount: number;
}

const num = (v: unknown): number => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Paise, so a half-rupee comparison is never decided by float noise. */
const paisa = (v: unknown): number => Math.round(num(v) * 100);

/** What the guest would still owe, pre-tax. Never negative. */
export function discountRemainingValue(impact: Partial<DiscountImpact> | null | undefined): number {
	const subtotal = paisa(impact?.subtotal);
	const amount = Math.min(paisa(impact?.discount_amount), subtotal);
	return (subtotal - amount) / 100;
}

/**
 * Is this discount a write-off? See the header for both limbs.
 *
 * `approvalThreshold` is the tenant's configured
 * "Restaurant".discount_approval_threshold; 0 (the DEFAULT) means "no approval
 * workflow", which is when the magnitude limb applies.
 *
 * A bill with nothing on it cannot be written off, exactly as
 * releaseIsWriteOff treats a ₹0 table: refusing a discount on an empty table
 * would put a waiter in front of a control that does nothing and cannot explain
 * itself.
 */
export function discountIsWriteOff(
	impact: Partial<DiscountImpact> | null | undefined,
	approvalThreshold = 0,
): boolean {
	const subtotal = paisa(impact?.subtotal);
	if (subtotal <= 0) { return false; }
	const amount = Math.min(paisa(impact?.discount_amount), subtotal);
	if (amount <= 0) { return false; }

	// Limb 1 — more than half the bill handed back. `>` not `>=`: an exact 50%
	// is a discount a floor gives, and a rule that refuses the round number
	// everybody types would be read as a bug rather than as a policy.
	if (amount > subtotal * WRITE_OFF_RESIDUAL_SHARE) { return true; }

	// Limb 2 — write-off-scale money, only where no approval queue exists.
	if (num(approvalThreshold) <= 0 && amount > paisa(DEFAULT_FLOOR_DISCOUNT_CEILING)) { return true; }

	return false;
}

/** What the caller should do with this discount. */
export interface DiscountVerdict {
	allowed: boolean;
	/** The money the discount hands back. */
	discount_amount: number;
	/** What the guest would still owe, pre-tax. */
	remaining_value: number;
	/** Present only on a refusal — the sentence the caller is shown, verbatim. */
	details?: string;
}

/**
 * MAY THIS IDENTITY APPLY THIS DISCOUNT?
 *
 * `closeBillPermission` is passed in rather than imported so this module stays
 * free of routes/_shared.ts (which pulls in the whole data layer). Callers hand
 * it PERM_CLOSE_BILL — the SAME uuid enforceSettleAuthority and mayReleaseTable
 * check, never a new one. Minting "may write off a bill by discount" would strip
 * the capability from every role that holds it today (migration 025's rule) and
 * would let three answers to one question drift apart.
 *
 * AN ADMIN LOSES NOTHING, and neither does a manager, a cashier or a captain:
 * "*" satisfies this, and CORE_ROLES.manager, .cashier and .captain all carry
 * a953d044 already. The only identity this refuses is one the tenant has not
 * trusted with the till — which is the waiter the requirement is about.
 */
export function mayDiscountBill(input: {
	actions?: unknown;
	impact?: Partial<DiscountImpact> | null;
	approvalThreshold?: number;
	closeBillPermission: string;
	tableName?: string;
	currency?: string;
}): DiscountVerdict {
	const amount = Math.round(num(input.impact?.discount_amount) * 100) / 100;
	const remaining = discountRemainingValue(input.impact);

	if (!discountIsWriteOff(input.impact, input.approvalThreshold ?? 0)) {
		return { allowed: true, discount_amount: amount, remaining_value: remaining };
	}

	const actions = Array.isArray(input.actions) ? input.actions.map((a) => String(a).trim()) : [];
	if (actions.includes("*") || actions.includes(input.closeBillPermission)) {
		return { allowed: true, discount_amount: amount, remaining_value: remaining };
	}

	const cur = input.currency ?? "₹";
	const where = input.tableName ? ` on table ${input.tableName}` : "";
	return {
		allowed: false,
		discount_amount: amount,
		remaining_value: remaining,
		// NAMES THE PERMISSION AND BOTH NUMBERS, for the same reason
		// enforceSettleAuthority's and mayReleaseTable's messages do: "Forbidden"
		// sends an owner hunting through the role editor and tells the waiter
		// standing at the table nothing at all. The amount is in the sentence
		// because that waiter is the person best placed to notice it is the wrong
		// table or an extra zero.
		details:
			`A ${cur}${amount.toFixed(2)} discount${where} would leave only ${cur}${remaining.toFixed(2)} on the bill. ` +
			`Writing a bill off is the same act as settling it, so it requires the 'Close Bill' permission. ` +
			`Apply a smaller discount, or ask a manager to approve this one.`,
	};
}

/**
 * THE REFUSAL, CARRIED FROM THE DATA LAYER TO THE ROUTE WITHOUT LOSING ITS BODY.
 *
 * The authority check has to run INSIDE SetBillDiscountWithApproval's
 * transaction, because the subtotal it is sized against is read there and a
 * route-level pre-check would be deciding on a number that can change before the
 * write lands. But routes/bills.ts maps every thrown error to a bare 400
 * {error: message}, which would flatten the sentence above into a
 * "couldn't-do-that" toast — the exact defect the clients were just fixed for.
 *
 * So the refusal travels as a TAGGED error. `code` is checked rather than
 * `instanceof`: a test that mocks the data layer, and a bundler that ends up
 * with two copies of this module, both break `instanceof` and neither breaks a
 * string compare.
 */
export const DISCOUNT_WRITE_OFF_REFUSED = "DISCOUNT_WRITE_OFF_REFUSED";

export class DiscountAuthorityError extends Error {
	readonly code = DISCOUNT_WRITE_OFF_REFUSED;
	readonly status = 403;
	readonly details: string;
	readonly requiredPermission: string;
	readonly discount_amount: number;
	readonly remaining_value: number;
	constructor(verdict: DiscountVerdict, requiredPermission: string) {
		super(verdict.details ?? "Forbidden");
		this.name = "DiscountAuthorityError";
		this.details = verdict.details ?? "Forbidden";
		this.requiredPermission = requiredPermission;
		this.discount_amount = verdict.discount_amount;
		this.remaining_value = verdict.remaining_value;
	}
}

/** Is this the refusal above? Tag test, not `instanceof` — see the header. */
export function isDiscountAuthorityError(err: unknown): err is DiscountAuthorityError {
	return Boolean(err) && (err as { code?: unknown }).code === DISCOUNT_WRITE_OFF_REFUSED;
}
