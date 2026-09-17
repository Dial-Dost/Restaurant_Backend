/**
 * THE REFUSAL A WAITER-ONLY LOGIN GETS FOR CANCELLING A TICKETED ORDER —
 * client item 3. The rule itself is `mayCancelTicketed` in role_scope.ts; this
 * file is what the refusal looks like, once, for every door that can cancel.
 *
 * WHY A TAGGED ERROR AND NOT A ROUTE CHECK. The verdict needs the order's
 * status BEFORE the write, and the only place that status is read in step with
 * the write is the data layer (SetOrderStatus, AddOrder, VoidOrderWithReason,
 * UpdateOrderItemsSplit). A route that read the status first and then called
 * the writer would race the approval that turns a Pending order into a ticket.
 * So the writer throws this and the route turns it into the 403 — the same
 * shape, and for the same reasons, as discount_authority.ts's refusal.
 *
 * NOTHING IS WRITTEN WHEN THIS IS THROWN: no status flip, no void row, no
 * CANCELLED slip. Every writer throws it before its first write, and the one
 * that runs inside a transaction (VoidOrderWithReason) throws it inside, so a
 * refusal rolls back whatever came before it.
 *
 * THE SENTENCE IS FOR THE PERSON HOLDING THE TABLET. It names the ticket the
 * way the pass does ("KOT-65") and says who can do it instead. Both clients
 * show `details` verbatim (the app's ApiException.fromBody, the dashboard's
 * readErrorMessage), and an installed app that still draws the button — 2.0.1
 * and older — parks a queued cancel on the first 403 with this sentence on the
 * chip, so the words are the whole of what an old device learns.
 *
 * PURE: imports role_scope.ts only.
 */
import { CANCEL_NEEDS_SENIOR, ROLES_OUTRANKING_WAITER } from "./role_scope.js";

/** What was refused. The sentence differs; the rule does not. */
export type CancelRefusalAct = "cancel" | "remove_line";

export class CancelNeedsSeniorError extends Error {
	readonly code = CANCEL_NEEDS_SENIOR;
	readonly status = 403;
	readonly order_id: string;
	readonly act: CancelRefusalAct;
	constructor(orderId: string, act: CancelRefusalAct = "cancel") {
		super(cancelNeedsSeniorSentence([], act));
		this.name = "CancelNeedsSeniorError";
		this.order_id = orderId;
		this.act = act;
	}
}

/** Is this the refusal above? Tag test, not `instanceof` — see discount_authority.ts. */
export function isCancelNeedsSeniorError(err: unknown): err is CancelNeedsSeniorError {
	return Boolean(err) && (err as { code?: unknown }).code === CANCEL_NEEDS_SENIOR;
}

/**
 * "a manager, cashier, captain or admin" — the roles that outrank a waiter, in
 * the order a floor reads them (the person nearest the pass first). Built from
 * ROLES_OUTRANKING_WAITER so a role added there is named here too.
 */
export function seniorRolesPhrase(): string {
	const readingOrder = ["manager", "cashier", "captain", "admin"];
	const roles = [
		...readingOrder.filter((r) => ROLES_OUTRANKING_WAITER.includes(r)),
		...ROLES_OUTRANKING_WAITER.filter((r) => !readingOrder.includes(r)),
	];
	if (roles.length === 0) { return "a senior colleague"; }
	if (roles.length === 1) { return `a ${roles[0] ?? ""}`; }
	return `a ${roles.slice(0, -1).join(", ")} or ${roles[roles.length - 1] ?? ""}`;
}

/**
 * "KOT-65 has gone to the kitchen. Only a manager, cashier, captain or admin can
 * cancel it — ask one of them."
 *
 * `kotNos` is what the pass calls the ticket; with none (numbering unapplied,
 * or unreadable) the sentence says "This order" rather than inventing one.
 */
export function cancelNeedsSeniorSentence(kotNos: readonly number[], act: CancelRefusalAct = "cancel"): string {
	const nos = [...new Set(kotNos.filter((n) => Number.isFinite(n) && n > 0).map((n) => Math.round(n)))];
	const ticket = nos.length === 0 ? "This order" : nos.map((n) => `KOT-${String(n)}`).join(", ");
	const verb = nos.length > 1 ? "have" : "has";
	const only = `Only ${seniorRolesPhrase()}`;
	return act === "remove_line"
		? `${ticket} ${verb} gone to the kitchen, so a dish cannot be taken off it here. ${only} can do that — ask one of them.`
		: `${ticket} ${verb} gone to the kitchen. ${only} can cancel it — ask one of them.`;
}

/** The 403 body. `allowed_roles` is the machine list; `details` is the sentence. */
export function cancelNeedsSeniorBody(err: CancelNeedsSeniorError, kotNos: readonly number[]): {
	error: "Forbidden";
	code: typeof CANCEL_NEEDS_SENIOR;
	details: string;
	allowed_roles: readonly string[];
	order_id: string;
	kot_nos: number[];
} {
	return {
		error: "Forbidden",
		code: CANCEL_NEEDS_SENIOR,
		details: cancelNeedsSeniorSentence(kotNos, err.act),
		allowed_roles: ROLES_OUTRANKING_WAITER,
		order_id: err.order_id,
		kot_nos: [...kotNos],
	};
}
