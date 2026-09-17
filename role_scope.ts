/**
 * WHO IS A SCOPED FLOOR ROLE — decided ONCE, on the server, for every client.
 *
 * THE BUG THIS EXISTS TO KILL, and it was live in production.
 *
 * The waiter scoping shipped in 1.9.0 was decided in the CLIENT, by asking
 * whether every role string on the profile was literally the word "waiter":
 *
 *     roles.every((r) => r == 'waiter')
 *
 * That reads as a reasonable rule and is not one, because it is a test on
 * SPELLING rather than on authority, and what gets spelled into `role_all`
 * varies per tenant in ways nobody configuring a restaurant would connect to a
 * waiter seeing the day's takings:
 *
 *   * A CUSTOM ROLE IS A UUID. parseEmployeeRoles stores custom roles by id, so
 *     a waiter granted any custom role carries `["waiter", "d2b1f0c4-…"]`. The
 *     uuid is not the word "waiter", `every` fails, and EVERY restriction
 *     evaporates — including the money gate, because `showsMoney` is defined as
 *     `!isWaiterOnly`. Using the granular RBAC feature silently un-scoped the
 *     role it was most likely to be used on.
 *   * "employee" IS A FALLBACK, NOT A ROLE. parseEmployeeRoles defaults `primary`
 *     to "employee" when it is unset or a stray uuid, and always folds primary
 *     into `all` — so an employee record whose primary was never set properly
 *     carries `["employee", "waiter"]` and is un-scoped by a placeholder.
 *
 * Both shapes are configuration accidents. Neither is a decision anybody made,
 * and both were invisible: the app looked correct on a tenant whose waiters
 * happened to carry one clean role, and wrong on the tenant next door.
 *
 * WHY THE SERVER AND NOT THE CLIENT. The server holds the whole picture — the
 * roles, what the custom ones actually grant, and the resolved action set — and
 * there is exactly one of it. A client can only infer, every client infers
 * separately, and a client that is a release behind infers with last month's
 * rules. Shipping the ANSWER rather than the INPUTS is what makes the behaviour
 * identical on every device of every tenant, which is the property that was
 * missing.
 *
 * THE RULE, stated so it can be argued with:
 *
 *     A waiter is scoped UNLESS they also hold a role that OUTRANKS a waiter.
 *
 * Outranking is a closed list of core roles — admin, manager, cashier, captain —
 * and nothing else. A waiter who is also a manager is a manager on shift and
 * keeps the run of the house; that was the sound half of the original rule and
 * it survives verbatim. What no longer un-scopes anybody is a custom role, the
 * "employee" placeholder, or an unrecognised string this build has never heard
 * of, because none of them is evidence of authority.
 *
 * WHICH DIRECTION IT FAILS. If the role set is unreadable or empty we return
 * false — NOT scoped. The failure mode of being wrong here is "an owner still
 * sees everything", never "a waiter lost the screen they work from"; a floor
 * that cannot take an order is a worse outage than a figure on a screen. An
 * admin, by role or by the `*` wildcard, is never scoped: a wildcard identity is
 * by definition not a scoped floor role.
 *
 * A PURE MODULE WITH NO RUNTIME IMPORTS, for the same reason me_scorecard.ts and
 * guest_bill_view.ts are: it is a rule about money and visibility, so it has to
 * be testable without a database, and every path that builds a session payload
 * has to be able to reach it without dragging the data layer in.
 */

/** The core roles this build recognises. Anything else is a custom role id. */
export const CORE_ROLES = [
	"admin", "employee", "valet", "waiter", "cashier", "captain", "manager",
] as const;

/**
 * The roles that OUTRANK a waiter.
 *
 * Deliberately a closed allowlist and not "anything that is not waiter": the
 * whole defect being fixed came from treating unrecognised strings as evidence
 * of seniority. A role has to be named here to lift the scoping, so a new custom
 * role — or a typo, or a uuid — cannot do it by accident.
 *
 * "employee" is NOT here, and that is the point: it is parseEmployeeRoles's
 * fallback for a missing primary, so treating it as senior hands the run of the
 * house to a misconfigured record.
 *
 * "valet" is not here either. A valet is a scoped role of its own, not a
 * supervisor of waiters, and it has never been the reason anybody sees money.
 */
export const ROLES_OUTRANKING_WAITER: readonly string[] = ["admin", "manager", "cashier", "captain"];

/** Is this string one of the core roles, rather than a custom role id? */
export function isCoreRole(raw: unknown): boolean {
	const r = String(raw ?? "").trim().toLowerCase();
	return (CORE_ROLES as readonly string[]).includes(r);
}

export interface RoleScopeInput {
	/** The session's primary role. */
	role?: unknown;
	/** Every role on the employee, core names and custom role UUIDs alike. */
	role_all?: unknown;
	/** The resolved action set. `*` is the admin wildcard. */
	actions?: unknown;
}

/**
 * True when this identity is a WAITER AND NOTHING SENIOR — the one predicate the
 * whole floor scoping hangs off.
 *
 * Every client must take this answer from the server rather than deriving its
 * own; see the header for what happened when they derived it.
 */
export function isWaiterOnly(input: RoleScopeInput): boolean {
	const actions = Array.isArray(input.actions) ? input.actions.map((a) => String(a).trim()) : [];
	if (actions.includes("*")) { return false; }

	const raw = [
		input.role,
		...(Array.isArray(input.role_all) ? input.role_all : []),
	];
	const roles = new Set<string>();
	for (const entry of raw) {
		const r = String(entry ?? "").trim().toLowerCase();
		if (r.length > 0) { roles.add(r); }
	}
	if (roles.size === 0) { return false; }

	// Must actually BE a waiter. A cook with a custom role is not scoped by this.
	if (!roles.has("waiter")) { return false; }

	// …and must hold nothing senior. Custom role ids, "employee" and anything
	// unrecognised all fall through here without lifting the scoping, which is
	// the entire fix.
	for (const r of roles) {
		if (ROLES_OUTRANKING_WAITER.includes(r)) { return false; }
	}
	return true;
}

/**
 * The scope block shipped on every session payload (`/auth/employee-login` and
 * `/auth/me`), for clients to OBEY rather than re-derive.
 *
 * An object rather than a bare boolean because the next scoped role — a valet
 * board, a cashier till — will want to say so here too, and adding a field to a
 * block clients already read is additive, whereas adding a second top-level key
 * is another thing every client has to learn about.
 */
export interface SessionRoleScope {
	/** See isWaiterOnly. The server's answer; clients must not compute their own. */
	waiter_only: boolean;
}

export function sessionRoleScope(input: RoleScopeInput): SessionRoleScope {
	return { waiter_only: isWaiterOnly(input) };
}

/**
 * CLIENT ITEM 3 (2026-09-17) — "On the waiter dashboard, Cancel KOT option
 * should be removed."
 *
 * WHAT IT MEANS, stated as a rule rather than as a button: A WAITER-ONLY LOGIN
 * NEVER CANCELS FOOD THE KITCHEN HAS BEEN TOLD ABOUT. Production showed why it
 * is the act and not the button: two GGV waiters cancelled printed dockets
 * through the everyday status route (reasons "Other" and "Aaa", one of them 27
 * seconds after the order went in), and both rows in the void ledger were
 * authorised by the person who made them. The same act is reachable from the
 * table sheet, the stage sheet, the web kitchen board and the upsert — a rule
 * that removed one button would leave the other three.
 *
 * WHAT A WAITER KEEPS: "Decline" on a PENDING order (status 8). That order was
 * placed while auto-push is off and has never been ticketed (autoPrintOrderKot
 * refuses to print it), so declining it cancels nothing the kitchen holds.
 *
 * THE ROLE OUTRANKS THE GRANT HERE, deliberately, and it is the one place it
 * does: a waiter-only login that a tenant has granted "Void Orders With Reason"
 * still loses it. The requirement names the waiter, not a permission, and no
 * live tenant grants that permission to a waiter today — so the only thing the
 * grant could do is re-open the door the client asked to close.
 *
 * `previousStatusCode` is the order's status column BEFORE the cancel, read in
 * the same place the write happens (SetOrderStatus, AddOrder,
 * VoidOrderWithReason, UpdateOrderItemsSplit), because a check made anywhere
 * else races the approval that turns a Pending order into a ticket.
 *
 * THE STATUS COLUMN ALONE IS NOT PROOF, and `printedKotNos` is why this takes
 * a third argument. Status 8 is a column anyone with Add Orders could once
 * write back: a waiter set a Preparing ticket to "Pending", then cancelled it
 * as a "decline" — and the CANCELLED slip was suppressed too, because a
 * Pending cancel prints none. The rewind itself is now refused
 * (mayPutBackToPending), but a senior can still write status 8 by hand, so the
 * decline also asks the one fact nothing can undo: a KOT number PrintJobs holds
 * for the order (migration 043). A Pending order with a printed number HAS
 * been ticketed, and a waiter-only login does not cancel it. An unreadable
 * number reads as none — the status rule above still stands on its own.
 */
export const CANCEL_NEEDS_SENIOR = "cancel_needs_senior";

/** "Orders".status 8 — placed, not yet accepted to the kitchen, never ticketed. */
export const PENDING_ORDER_STATUS_CODE = 8;

export function mayCancelTicketed(
	input: RoleScopeInput,
	previousStatusCode: number | null | undefined,
	printedKotNos: readonly number[] = [],
): boolean {
	if (!isWaiterOnly(input)) { return true; }
	return previousStatusCode === PENDING_ORDER_STATUS_CODE
		&& !printedKotNos.some((n) => Number.isFinite(n) && n > 0);
}

/**
 * May this login put an order back to PENDING (status 8)?
 *
 * "Pending" is the one status that means "the kitchen was never told", and it
 * is what lets a waiter decline an order (mayCancelTicketed). So a waiter-only
 * login may name it only for an order that is ALREADY Pending: moving a
 * Preparing, Served or Bill Verification ticket back to it was the first half
 * of a two-request cancel that closed none of item 3's doors. No screen offers
 * the move — the app's stage sheet and the dashboard's stage buttons never list
 * Pending — so the only request this refuses is a crafted one.
 *
 * A senior role keeps whatever it had: it may cancel the ticket outright, so a
 * rewind gives it nothing it did not already hold.
 */
export function mayPutBackToPending(input: RoleScopeInput, previousStatusCode: number | null | undefined): boolean {
	if (!isWaiterOnly(input)) { return true; }
	return previousStatusCode === PENDING_ORDER_STATUS_CODE;
}

/**
 * The session flag both clients draw "Cancel KOT" (and the stage sheet's
 * "Cancelled") from. A Pending order's Decline does not read it — see above.
 */
export function mayCancelKot(input: RoleScopeInput): boolean {
	return !isWaiterOnly(input);
}
