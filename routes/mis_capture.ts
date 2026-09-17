/**
 * THE THREE MANAGER ACTS — the HTTP surface over migrations 034, 035 and 036.
 *
 * Comp a dish off what the guest pays and record who gave it away. Void a
 * rung-up order and record why. Take the service charge off an open bill and
 * record on whose say-so. The recording is all in place already
 * (database_supabase.ts, `MIS DATA CAPTURE`); this file is the only way to reach
 * it, and it is deliberately small: every rule about money lives in
 * billing_math.ts, every rule about vocabulary lives in mis_capture.ts, and what
 * is left here is authorisation, the shape of a request, and the audit line.
 *
 * ============================================================================
 * WHY THESE ARE NOT ON AN EXISTING PERMISSION
 * ============================================================================
 * All three REDUCE what a guest pays. The permission every floor write already
 * rides on — 4ad474d4… "Add Orders" — is held by waiter, captain and cashier
 * alike, so gating a comp on it would mean any waiter can comp their own
 * friend's table. Each act therefore gets its own grantable Action
 * (PERM_NON_CHARGEABLE / PERM_VOID_ORDER / PERM_SERVICE_CHARGE_WAIVER in
 * _shared.ts), granted to the core `manager` role and to admin via "*", and
 * grantable to any custom role a tenant wants to define. They are separate from
 * each other because a restaurant that lets a floor manager comp a dessert does
 * not necessarily let them waive 10% off a ₹40,000 bill.
 *
 * Every gate is `validateAction(<uuid>)` in registration position. The bare
 * `validate` export is a NO-OP and is never used here.
 *
 * ============================================================================
 * THE SECOND NAME — what "authorisation" means without a step-up credential
 * ============================================================================
 * Migrations 034/035/036 make `authorised_by_username` NOT NULL because a staff
 * member comping their own friend's table is the commonest till fraud there is,
 * and the only defence that survives a busy Saturday is a second name against
 * every giveaway. CaptureActor's contract is explicit that the route must NOT
 * default that field to the actor — doing so would make the one field that
 * matters the one field that is always a copy of its neighbour.
 *
 * So `authorised_by` is REQUIRED in the body, and it is resolved, not trusted:
 * ResolveAuthoriser looks it up as a real employee of this restaurant AND this
 * outlet, checks they hold the SAME permission that gates the route, and hands
 * back the username as STORED (so "MANAGER01" and "manager01" are one person in
 * the report). A name that resolves to nobody is a 400; a name that resolves to
 * someone who could not have authorised it is a 403.
 *
 * WHAT THIS IS NOT, said plainly: it is not proof the manager was standing
 * there. This system has no step-up credential, and inventing one behind a body
 * field ("send the manager's password") would be a worse control than an honest
 * one — it would put a second password on the wire on a route a waiter can call.
 * What it guarantees is that every authoriser named in a control ledger is a
 * real person who could have authorised it, that the acting user is one too, and
 * that neither name came from the client. A manager acting alone passes their
 * own username and the row then says so, which is exactly the case 034's header
 * describes.
 *
 * THE ACTOR NEVER COMES FROM THE BODY. `marked_by` / `voided_by` / `waived_by`
 * are taken from the verified session (extractEmployeeUsername) and there is no
 * body field that can set them. A till that could name its own actor could sign
 * a comp as the manager.
 *
 * ============================================================================
 * NO idempotent() ON ANY ROUTE HERE — and therefore no change to the Flutter
 * outbox.dart ALLOWLIST
 * ============================================================================
 * Three reasons, any one sufficient:
 *
 *   1. THE WAIVER ROUTE CAN MINT A BILL. WaiveServiceCharge resolves the table's
 *      open bill through ensureOpenBillIdForTable, which allocates a bill row
 *      (and with it an invoice number) when the table has none. idempotency.ts's
 *      header puts anything that mints a bill or KOT number explicitly out of
 *      scope, and routes/bills.ts carries no guard from that file for the same
 *      reason. A queued waiver is a queued invoice number.
 *
 *   2. THESE ARE NOT WRITES A WAITER MAKES DURING SERVICE AND FORGETS ABOUT.
 *      All three change what the guest is handed. An offline-queued comp means
 *      the printed bill says one total and the server later says another — the
 *      exact divergence openBillChargeConfig was consolidated to prevent. The
 *      right offline behaviour for a comp is "refuse now", not "apply later".
 *
 *   3. THE DOUBLE-TAP HAZARD IS ALREADY CLOSED SERVER-SIDE, in the database
 *      rather than in a key store: `orderitemnc_live_line_uidx` allows one live
 *      NC per line (and MarkOrderItemNonChargeable refuses an already-comped
 *      line by name), `ordervoids_one_per_order_uidx` + ON CONFLICT DO NOTHING
 *      make a second void return the FIRST reason, and `scwaivers_live_bill_uidx`
 *      allows one live waiver per bill — surfaced here as a 409, not a 500.
 *
 * ============================================================================
 * WHAT THIS FILE DOES NOT EXPOSE, AND WHY
 * ============================================================================
 *   * ITEM-LEVEL VOIDS. "OrderVoids".scope supports 'item' and the data layer
 *     will record one, but removing a line and recording its void must happen in
 *     ONE transaction and the existing DELETE /orders/:id/items/:itemId does its
 *     line surgery in the route over UpdateOrderItemsSplit. Wiring a reason onto
 *     it from here would be two writes that can half-fail. It needs a
 *     transactional data-layer composer of its own, like VoidOrderWithReason.
 *
 *   * REASONS ON PATCH /orders/:id/status → Cancelled. That route is unchanged:
 *     it is what every shipped client calls today and requiring a reason and an
 *     authoriser on it would stop a live floor from cancelling anything. Cancels
 *     that come through it keep landing with no OrderVoids row, which the void
 *     report already reports as "unknown" and COUNTS, so the gap is visible
 *     rather than silent (see GetOrderVoidRecords). Closing it is a client
 *     migration to POST /orders/:id/void, then a refusal here.
 *
 *   * UNDO. None of these audit entries carries an `undo` envelope, so the
 *     deny-by-default audit-undo registry will not touch them. Reversal is
 *     supersession through the explicit reverse routes below, which record who
 *     reversed and why — an undo that silently deleted a comp would delete the
 *     argument along with it.
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
	Audit_log_category,
	GetBillChargeConfigForTable,
	GetBillForTable,
	GetNonChargeablesForOrders,
	GetRestaurantProfile,
	GetRestaurantSettings,
	GetTableNameById,
	MarkOrderItemNonChargeable,
	ResolveAuthoriser,
	ReverseNonChargeable,
	ReverseServiceChargeWaiver,
	VoidOrderWithReason,
	WaiveServiceCharge,
	resolveServiceChargeWaiverReasonOptional,
} from "../database_supabase.js";
import { dispatchCancellationKot } from "../kot_print.js";
import { NON_CHARGEABLE_KINDS, SERVICE_CHARGE_WAIVER_KINDS, VOID_KINDS } from "../mis_capture.js";
import { logger } from "../observability.js";
import { emitRestaurant } from "../realtime.js";
import { claimClientRenderedBillPrint, printOpenTableBill, refuseWaiterBillReprint } from "./bills.js";
import {
	PERM_NON_CHARGEABLE,
	PERM_SERVICE_CHARGE_WAIVER,
	PERM_VOID_ORDER,
	callerHasPermission,
	extractEmployeeId,
	extractEmployeeUsername,
	extractOutletId,
	extractRestaurantId,
	log_audit,
	nextPartyPrintMessage,
	validateAction,
	validateBody,
} from "./_shared.js";


// --- Body shapes -------------------------------------------------------------
//
// The vocabularies are asserted here as well as in mis_capture.ts, and that is
// not a duplicate rule: this one exists so a typo comes back as a structured 400
// naming the allowed values instead of a generic message from the data layer.
// Both read from the SAME exported const, so a vocabulary can never drift
// between the two. `.passthrough()` matches the house style in routes/bills.ts.
const sReason = z.string().min(1).max(400);
const sAuthorisedBy = z.string().min(1).max(120);

const sMarkNonChargeable = z.object({
	nc_kind: z.enum(NON_CHARGEABLE_KINDS),
	reason: sReason,
	authorised_by: sAuthorisedBy,
	// Absent = the WHOLE line. A partial comp splits the line in the data layer.
	quantity: z.number().positive().optional(),
}).passthrough();

const sReverse = z.object({ reason: sReason }).passthrough();

const sVoidOrder = z.object({
	void_kind: z.enum(VOID_KINDS),
	reason: sReason,
	authorised_by: sAuthorisedBy,
}).passthrough();

// A service-charge waiver's reason is OPTIONAL (client item, 2.0.1): absent,
// "", whitespace and null all mean "no reason given", and the data layer stores
// NULL — never '' — where migration 051 lets it, and refuses as before where it
// does not. The kind and the second name stay required. Every other capture
// keeps sReason: a comp, a void and both reversals still need one.
const sOptionalWaiverReason = z.string().max(400).nullish();

const sWaiveServiceCharge = z.object({
	waiver_kind: z.enum(SERVICE_CHARGE_WAIVER_KINDS),
	reason: sOptionalWaiverReason,
	authorised_by: sAuthorisedBy,
	table_name: z.string().optional(),
	bill_id: z.string().optional(),
}).passthrough().refine(
	(b) => (typeof b.table_name === "string" && b.table_name.trim().length > 0)
		|| (typeof b.bill_id === "string" && b.bill_id.trim().length > 0),
	{ message: "table_name or bill_id is required" },
);

// The one-step "Remove service charge & print". Everything about the WAIVER is
// optional here because a bill that already carries one is simply reprinted and
// needs no second reason — the handler, not the schema, decides whether this
// call has to write a waiver and refuses the missing fields then. When they ARE
// sent they are held to exactly the vocabulary and lengths the waiver route
// holds them to, from the same consts. `table_name` only: WaiveServiceCharge
// can mint the table's bill, and a print is addressed by table everywhere else.
const sRemoveServiceChargeAndPrint = z.object({
	table_name: z.string(),
	waiver_kind: z.enum(SERVICE_CHARGE_WAIVER_KINDS).optional(),
	reason: sOptionalWaiverReason,
	authorised_by: sAuthorisedBy.optional(),
	// "client" is the web dashboard, which renders its own paper in the browser
	// and only needs the print CLAIMED (POST /print/bill/claim's half).
	render: z.enum(["thermal", "client"]).optional(),
}).passthrough();


// --- Shared handler plumbing -------------------------------------------------

/** The refusals resolveActors answers itself (its 500 is not one). */
type ActorRefusal = "no_username" | "authoriser_missing" | "authoriser_not_found" | "authoriser_not_permitted";

/**
 * Resolve BOTH names for one capture write: the acting user (session only) and
 * the authoriser (body, resolved and permission-checked).
 *
 * Answers the request itself and returns null on every failure, so a handler
 * reads as `const who = await resolveActors(...); if (!who) {return;}` — the same
 * shape enforcePermission uses.
 *
 * `onRefused` is told about each 400/403 BEFORE it is answered, for a caller
 * that puts its refusals on the record (the composite waiver-and-print route).
 * A 500 from the authoriser lookup is a failure to decide, not a refusal, and is
 * not reported to it.
 */
export async function resolveActors(
	req: Request,
	res: Response,
	restaurantId: string,
	actionId: string,
	act: string,
	onRefused?: (refusal: ActorRefusal, authorisedBy: string | null) => Promise<void>,
): Promise<{
	employee_id: string | null;
	username: string;
	authorised_by_employee_id: string | null;
	authorised_by_username: string;
	authorised_by_display: string;
} | null> {
	const username = extractEmployeeUsername(req);
	if (!username) {
		// A session with no username cannot sign a control ledger. This is not a
		// 401 (the session is valid) and not a silent fallback to a display name
		// or an employee id — the column stores a login identity or nothing.
		await onRefused?.("no_username", null);
		res.status(400).json({ error: "Your session does not carry a username. Sign out and sign in again." });
		return null;
	}
	const raw = (req.body ?? {}) as Record<string, unknown>;
	const wanted = typeof raw.authorised_by === "string" ? raw.authorised_by.trim() : "";
	if (!wanted) {
		await onRefused?.("authoriser_missing", null);
		res.status(400).json({ error: `authorised_by is required — record who approved ${act}.` });
		return null;
	}
	let resolved;
	try {
		resolved = await ResolveAuthoriser(restaurantId, wanted, actionId);
	} catch (err) {
		logger.error({ err }, "resolve_authoriser_failed");
		res.status(500).json({ error: "Unable to check the authoriser." });
		return null;
	}
	if (!resolved.ok) {
		if (resolved.reason === "not_found") {
			await onRefused?.("authoriser_not_found", wanted);
			res.status(400).json({ error: `No staff member '${wanted}' in this outlet — authorised_by must name one.` });
		} else {
			await onRefused?.("authoriser_not_permitted", wanted);
			res.status(403).json({ error: `'${wanted}' is not permitted to authorise ${act}.` });
		}
		return null;
	}
	return {
		employee_id: extractEmployeeId(req),
		username,
		authorised_by_employee_id: resolved.identity.employee_id,
		authorised_by_username: resolved.identity.username,
		authorised_by_display: resolved.identity.display_name,
	};
}

/** Postgres unique_violation — a live NC / void / waiver already exists. */
function isUniqueViolation(err: unknown): boolean {
	return (err as { code?: unknown })?.code === "23505";
}

/**
 * One error shape for all six writes.
 *
 * The data layer's messages are written to be shown to the person at the till
 * ("That item is already non-chargeable. Reverse it first if the reason was
 * wrong.") so they are surfaced verbatim on a 400, exactly as every other
 * money route in this codebase does. A unique violation is the one case that
 * would otherwise leak as a 500, and it always means the same thing.
 */
function failCapture(res: Response, err: unknown, log: string, conflict: string): void {
	if (isUniqueViolation(err)) {
		logger.warn({ err }, `${log}_conflict`);
		res.status(409).json({ error: conflict });
		return;
	}
	logger.error({ err }, log);
	res.status(400).json({ error: String((err as { message?: unknown })?.message ?? "Unable to complete that change") });
}

/**
 * THE AUDIT LINE A SERVICE-CHARGE WAIVER FILES, written in one place because two
 * routes now record a waiver: POST /bills/service-charge-waiver and the one-step
 * POST /bills/service-charge-waiver/print.
 *
 * The Bill Edit report classifies waivers off the PERM_SERVICE_CHARGE_WAIVER
 * action id on this line, and a manager reads its sentence beside the Service
 * Charge Deny report's row. A waiver recorded by the composite route that filed
 * a subtly different line would be the same fact told two ways in one control
 * ledger, so both routes hand this function what WaiveServiceCharge returned and
 * it writes the bytes. Never throws: the waiver it describes has committed.
 */
async function auditServiceChargeWaiver(
	req: Request,
	who: { authorised_by_username: string },
	result: Awaited<ReturnType<typeof WaiveServiceCharge>>,
	emitTable: string | null,
): Promise<void> {
	const rec = result.record;
	try {
		await log_audit(
			req,
			PERM_SERVICE_CHARGE_WAIVER,
			`Waived the service charge (₹${rec.amount_waived.toFixed(2)}; ₹${rec.grand_total_reduction.toFixed(2)} with its tax, before round-off; grand total ₹${result.grand_total_before.toFixed(2)} → ₹${result.grand_total_after.toFixed(2)}) on bill ${rec.bill_id}${emitTable ? ` (table ${String(emitTable)})` : ""} — authorised by ${who.authorised_by_username}`,
			Audit_log_category.Bill,
			{
				waiver_id: rec.id, bill_id: rec.bill_id, table: emitTable || null,
				waiver_kind: rec.waiver_kind, reason: rec.reason,
				basis: rec.basis, basis_percent: rec.basis_percent, basis_amount: rec.basis_amount,
				amount_waived: rec.amount_waived, tax_on_waived: rec.tax_on_waived,
				grand_total_reduction: rec.grand_total_reduction,
				grand_total_before: result.grand_total_before, grand_total_after: result.grand_total_after,
				authorised_by: who.authorised_by_username,
			},
		);
	} catch (err) { logger.warn({ err }, "log_audit service_charge_waiver failed"); }
}

/** Why a "Remove service charge & print" was refused, as the audit line says it. */
const SERVICE_CHARGE_REMOVAL_REFUSALS = {
	waiver_required: "the caller does not hold the 'Waive Service Charge' permission",
	reason_required: "no waiver kind or reason was given",
	// Once the reason is optional (051) only the kind can be missing, and the
	// line says exactly that rather than naming a field nobody has to send.
	kind_required: "no waiver kind was given",
	no_username: "the session carries no username to sign a waiver with",
	authoriser_missing: "no authoriser was named",
	authoriser_not_found: "the named authoriser is not a staff member of this outlet",
	authoriser_not_permitted: "the named authoriser may not authorise a service-charge waiver",
} as const satisfies Record<"waiver_required" | "reason_required" | "kind_required" | ActorRefusal, string>;

/**
 * A REFUSED "REMOVE SERVICE CHARGE & PRINT", ON THE RECORD.
 *
 * AUDITED EVEN THOUGH NOTHING HAPPENED, like a refused reprint (C3) and a
 * refused item removal: an attempt to take the service charge off a bill that
 * is carrying one is exactly what a manager scans the log for. Before 2.0.0 the
 * same attempt went through POST /print/bill with no_service_charge:true and
 * left "asked WITHOUT the service charge; no waiver is recorded" behind; the
 * composite route replaced that request in both clients, so without this line
 * the attempt vanished from the log along with the paper.
 *
 * Filed only for refusals where a charge IS on the bill and no waiver is: the
 * missing permission, the missing kind or reason, and resolveActors' 400/403s.
 * An empty table, a bill with no charge (nothing_to_remove) and C3 are not
 * attempts on a charge — and C3 files its own line.
 *
 * THE SENTENCE CARRIES NO TYPED TEXT. The Bill Edit classifier reads catch-all
 * sentences by pattern, so a typed authoriser name could make a refusal look
 * like an edit; the name goes in the details. `service_charge_waiver_required`
 * keeps the key the old print line used, and it is true on every refusal here
 * for the reason it was true there: a waiver is what this needed.
 *
 * Best-effort: a failed audit write must never turn a 4xx into a 500.
 */
async function auditRefusedServiceChargeRemoval(
	req: Request,
	tableName: string,
	refusal: keyof typeof SERVICE_CHARGE_REMOVAL_REFUSALS,
	basis: string,
	authorisedBy: string | null,
): Promise<void> {
	try {
		await log_audit(
			req, "4ad474d4-5230-449c-874f-6a238b833bca",
			`REFUSED removal of the service charge on table ${tableName} — ${SERVICE_CHARGE_REMOVAL_REFUSALS[refusal]}; nothing was waived or printed`,
			Audit_log_category.Bill,
			{
				table: tableName, refused: true, refusal,
				service_charge_basis: basis, service_charge_waiver_required: true,
				authorised_by: authorisedBy,
			},
		);
	} catch (err) { logger.warn({ err }, "log_audit service_charge_removal_refusal failed"); }
}

/** Best-effort floor refresh. Never fails a write that already committed. */
function announceBill(restaurantId: string, tableName: string | null, orderId: string | null): void {
	try {
		if (tableName) {emitRestaurant(restaurantId, "bill:updated", { table: tableName });}
		if (orderId) {emitRestaurant(restaurantId, "order:updated", { order_id: orderId });}
	} catch {/* ignore */}
}


export function registerMisCaptureRoutes(app: Express): void {

// --- 034: NON-CHARGEABLE -----------------------------------------------------

/*
	Comp one order line — take it OUT of what the guest pays while still counting
	it as revenue given away.

	POST /orders/:id/items/:itemId/non-chargeable
	  body { nc_kind, reason, authorised_by, quantity? }
	  -> 201 { non_chargeable, order_subtotal, order_nc_total, table_subtotal }

	`quantity` comps part of a line ("one of the three desserts was on the
	house"); omitted, the whole line goes. The data layer splits the line for a
	partial comp and leaves the ORIGINAL id on the chargeable remainder, because
	prep timers and served state key on that id and belong to the food being paid
	for.

	Refused on a settled or cancelled order — a comp after the money has moved is
	a refund, and refunds have their own path and their own columns.
*/
app.post("/orders/:id/items/:itemId/non-chargeable", validateAction(PERM_NON_CHARGEABLE), validateBody(sMarkNonChargeable), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const orderId = String(req.params.id ?? "").trim();
	const itemId = String(req.params.itemId ?? "").trim();
	if (!orderId || !itemId) { res.status(400).json({ error: "order id and item id are required" }); return; }
	const body = req.body as { nc_kind: string; reason: string; quantity?: number };

	const who = await resolveActors(req, res, restaurantId, PERM_NON_CHARGEABLE, "a non-chargeable item");
	if (!who) {return;}

	try {
		const result = await MarkOrderItemNonChargeable(restaurantId, {
			order_id: orderId,
			item_id: itemId,
			nc_kind: body.nc_kind,
			reason: body.reason,
			...(body.quantity === undefined ? {} : { quantity: body.quantity }),
			actor: {
				employee_id: who.employee_id,
				username: who.username,
				authorised_by_employee_id: who.authorised_by_employee_id,
				authorised_by_username: who.authorised_by_username,
			},
		});
		const rec = result.record;
		const tableName = await GetTableNameById(restaurantId, rec.table_id).catch(() => null);
		announceBill(restaurantId, tableName, orderId);
		// The Bill Edit report classifies on this action id, so `reversal` is
		// absent here and true on the reverse route below — the writer's own flag
		// rather than a reading of the prose.
		try {
			await log_audit(
				req,
				PERM_NON_CHARGEABLE,
				`Made ${String(rec.quantity)} x ${rec.item_name} non-chargeable (${rec.nc_kind}, ₹${rec.value.toFixed(2)}) on order ${orderId} — authorised by ${who.authorised_by_username}`,
				Audit_log_category.Bill,
				{
					nc_id: rec.id, order_id: orderId, item_id: rec.item_id, item: rec.item_name,
					table: tableName, nc_kind: rec.nc_kind, quantity: rec.quantity,
					unit_price: rec.unit_price, value: rec.value, reason: rec.reason,
					authorised_by: who.authorised_by_username,
					order_subtotal: result.order_subtotal, table_subtotal: result.table_subtotal,
				},
			);
		} catch (err) { logger.warn({ err }, "log_audit non_chargeable failed"); }
		res.status(201).json({
			non_chargeable: rec,
			order_subtotal: result.order_subtotal,
			order_nc_total: result.order_nc_total,
			table_subtotal: result.table_subtotal,
		});
	} catch (err) {
		failCapture(res, err, "mark_non_chargeable_failed", "That item is already non-chargeable.");
	}
});

/*
	Put a comped dish back on the bill.

	POST /non-chargeables/:id/reverse
	  body { reason }
	  -> 200 { non_chargeable }

	SUPERSESSION, NOT DELETION: the ledger row stays and is stamped, so a control
	report shows "12 comps, 2 of them reversed" instead of showing 10 and hiding
	the argument. No authoriser is required to reverse — putting a charge BACK on
	a guest's bill is not the act the second-name control exists to catch, and
	requiring a second person to undo a mistake is how mistakes get left standing.
*/
app.post("/non-chargeables/:id/reverse", validateAction(PERM_NON_CHARGEABLE), validateBody(sReverse), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const ncId = String(req.params.id ?? "").trim();
	if (!ncId) { res.status(400).json({ error: "non-chargeable id is required" }); return; }
	const username = extractEmployeeUsername(req);
	if (!username) { res.status(400).json({ error: "Your session does not carry a username. Sign out and sign in again." }); return; }
	const body = req.body as { reason: string };

	try {
		const rec = await ReverseNonChargeable(restaurantId, ncId, { reason: body.reason, by_username: username });
		const tableName = await GetTableNameById(restaurantId, rec.table_id).catch(() => null);
		announceBill(restaurantId, tableName, rec.order_id);
		try {
			await log_audit(
				req,
				PERM_NON_CHARGEABLE,
				`Reversed the non-chargeable on ${rec.item_name} (₹${rec.value.toFixed(2)}) — it is chargeable again`,
				Audit_log_category.Bill,
				{
					reversal: true, nc_id: rec.id, order_id: rec.order_id, item_id: rec.item_id,
					item: rec.item_name, table: tableName, value: rec.value,
					reason: rec.reversal_reason, original_reason: rec.reason,
					originally_authorised_by: rec.authorised_by_username,
				},
			);
		} catch (err) { logger.warn({ err }, "log_audit non_chargeable_reverse failed"); }
		res.json({ non_chargeable: rec });
	} catch (err) {
		failCapture(res, err, "reverse_non_chargeable_failed", "That non-chargeable has already been reversed.");
	}
});

/*
	The comps on one order, with reason, value and both names.

	GET /orders/:id/non-chargeables -> 200 { non_chargeables: [...] }

	Gated on the comp permission rather than "View Bill": the bill view already
	shows a waiter WHICH lines are non-chargeable and what the total comes to
	(GetBillForTable returns `nc`/`nc_kind` per line and `nc_total`). What this
	adds is the control data — the reason, the authoriser, the ledger id needed to
	reverse — and that is manager information.
*/
app.get("/orders/:id/non-chargeables", validateAction(PERM_NON_CHARGEABLE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const orderId = String(req.params.id ?? "").trim();
	if (!orderId) { res.status(400).json({ error: "order id is required" }); return; }
	try {
		const byOrder = await GetNonChargeablesForOrders(restaurantId, [orderId]);
		res.json({ non_chargeables: byOrder.get(orderId) ?? [] });
	} catch (err) {
		logger.error({ err }, "get_order_non_chargeables_failed");
		res.status(400).json({ error: String((err as { message?: unknown })?.message ?? "Unable to read non-chargeables") });
	}
});

// --- 035: VOID REASON + STAGE ------------------------------------------------

/*
	Cancel an order AND record why, in one transaction.

	POST /orders/:id/void
	  body { void_kind, reason, authorised_by }
	  -> 200 { void, previous_status }

	`stage` (before_print / after_print / after_bill) is NOT accepted from the
	body and never will be: it is derived server-side from facts the client
	cannot reach — whether a bill exists for the table, whether the order was
	barked, whether a KOT print job went out — because the person whose void it
	is has an obvious interest in it reading "before_print".

	Already cancelled is a 400, not a no-op. Attaching a reason after the fact
	would derive the stage from the table's state NOW about a void that happened
	THEN, which is a fabricated fraud signal pointing at a named employee. A
	missing order is a 404.
*/
app.post("/orders/:id/void", validateAction(PERM_VOID_ORDER), validateBody(sVoidOrder), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const orderId = String(req.params.id ?? "").trim();
	if (!orderId) { res.status(400).json({ error: "order id is required" }); return; }
	const body = req.body as { void_kind: string; reason: string };

	const who = await resolveActors(req, res, restaurantId, PERM_VOID_ORDER, "a void");
	if (!who) {return;}

	try {
		const result = await VoidOrderWithReason(restaurantId, {
			order_id: orderId,
			void_kind: body.void_kind,
			reason: body.reason,
			actor: {
				employee_id: who.employee_id,
				username: who.username,
				authorised_by_employee_id: who.authorised_by_employee_id,
				authorised_by_username: who.authorised_by_username,
			},
		});
		if (!result.ok) { res.status(404).json({ error: "Order not found" }); return; }
		const rec = result.record;
		const tableName = await GetTableNameById(restaurantId, rec.table_id).catch(() => null);
		announceBill(restaurantId, tableName, orderId);
		try {
			await log_audit(
				req,
				PERM_VOID_ORDER,
				`Voided order ${orderId} (${rec.void_kind}, ₹${rec.value_voided.toFixed(2)}, ${rec.stage}) — authorised by ${who.authorised_by_username}`,
				Audit_log_category.Orders,
				{
					void_id: rec.id, order_id: orderId, table: tableName,
					void_kind: rec.void_kind, reason: rec.reason,
					stage: rec.stage, stage_evidence: rec.stage_evidence,
					value_voided: rec.value_voided, previous_status: result.previous_status,
					authorised_by: who.authorised_by_username,
				},
			);
		} catch (err) { logger.warn({ err }, "log_audit void_order failed"); }
		// THE CANCELLATION SLIP. The void is committed — money off the bill, row at
		// status 5, floor told — and the kitchen's docket is still on the rail.
		// Until this printed, the only path in the system that records WHY food was
		// cancelled was also a path that never told the kitchen it had been.
		//
		// `void_kind` rather than `reason` on the paper: it is a controlled
		// vocabulary, so it is short by construction and fits a 32-column roll
		// without truncation, and it is the half a chef can act on. The free-text
		// reason is a control document for the auditor and lives on the
		// "OrderVoids" row and in the audit entry above.
		//
		// NON-FATAL BY CONSTRUCTION: dispatchCancellationKot returns its outcome
		// and never throws, so a dead printer cannot turn a completed void into a
		// 400 and send a waiter round to void it a second time.
		const cancelPrint = await dispatchCancellationKot({
			restaurantId, orderId, where: "order_voided",
			reason: rec.void_kind, previousStatus: result.previous_status,
		});
		res.json({
			void: rec, previous_status: result.previous_status,
			cancel_kot_printed: cancelPrint.printed,
			cancel_kot_no: cancelPrint.kot_no,
			cancel_kot_tickets: cancelPrint.tickets,
			...(cancelPrint.reason ? { cancel_kot_skipped: cancelPrint.reason } : {}),
		});
	} catch (err) {
		failCapture(res, err, "void_order_failed", "That order has already been voided.");
	}
});

// --- 036: SERVICE CHARGE WAIVER ----------------------------------------------

/*
	Take the service charge off a table's OPEN bill.

	POST /bills/service-charge-waiver
	  body { table_name | bill_id, waiver_kind, reason?, authorised_by }
	  -> 201 { waiver, grand_total_before, grand_total_after }

	The reason is optional (migration 051); WaiveServiceCharge stores a missing
	one as NULL, or refuses it with its own 400 where the column is still NOT
	NULL.

	Works in BOTH shapes this fleet runs — "Restaurant".service_charge and a
	"Service Charge" line inside "Outlets".default_tax — because the saving is
	measured by running the real charge computation twice and differencing, never
	by a second implementation of the arithmetic. In the first shape GST sits on
	the charge, so the bill falls by MORE than the charge itself; in the second it
	does not.

	TWO DIFFERENT NUMBERS, AND NEITHER IS THE OTHER (migration 048). The recorded
	`grand_total_reduction` is the charge plus the tax on it, measured on the
	totals BEFORE round-off, so amount_waived + tax_on_waived equals it exactly.
	`grand_total_before/after` are what the guest is asked to pay either side of
	the waiver, each rounded to the rupee — what the till shows the guest. Their
	gap can differ from the recorded reduction by the two round-offs (under a
	rupee), so nothing may label the reduction as "the difference of the totals",
	the audit line included.

	OPEN BILLS ONLY. A settled bill is final; a post-payment dispute is a refund,
	which has its own path, its own columns and its own audit entry.
*/
app.post("/bills/service-charge-waiver", validateAction(PERM_SERVICE_CHARGE_WAIVER), validateBody(sWaiveServiceCharge), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = req.body as { waiver_kind: string; reason?: string | null; table_name?: string; bill_id?: string };
	const tableName = String(body.table_name ?? "").trim();
	const billId = String(body.bill_id ?? "").trim();

	const who = await resolveActors(req, res, restaurantId, PERM_SERVICE_CHARGE_WAIVER, "a service-charge waiver");
	if (!who) {return;}

	try {
		const result = await WaiveServiceCharge(restaurantId, {
			...(tableName ? { table_name: tableName } : {}),
			...(billId ? { bill_id: billId } : {}),
			waiver_kind: body.waiver_kind,
			reason: body.reason ?? null,
			actor: {
				employee_id: who.employee_id,
				username: who.username,
				authorised_by_employee_id: who.authorised_by_employee_id,
				authorised_by_username: who.authorised_by_username,
			},
		});
		const rec = result.record;
		const emitTable = tableName || await GetTableNameById(restaurantId, rec.table_id).catch(() => null);
		announceBill(restaurantId, emitTable || null, null);
		await auditServiceChargeWaiver(req, who, result, emitTable || null);
		res.status(201).json({
			waiver: rec,
			grand_total_before: result.grand_total_before,
			grand_total_after: result.grand_total_after,
		});
	} catch (err) {
		failCapture(res, err, "waive_service_charge_failed", "This bill's service charge has already been waived.");
	}
});

/*
	Put the service charge back.

	POST /bills/service-charge-waiver/:id/reverse
	  body { reason }
	  -> 200 { waiver }

	Supersession, like the NC reversal, and for the same reason: the row stays and
	is stamped so the report can show a waiver a manager overturned. No authoriser
	— this puts money back ON the bill.
*/
app.post("/bills/service-charge-waiver/:id/reverse", validateAction(PERM_SERVICE_CHARGE_WAIVER), validateBody(sReverse), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const waiverId = String(req.params.id ?? "").trim();
	if (!waiverId) { res.status(400).json({ error: "waiver id is required" }); return; }
	const username = extractEmployeeUsername(req);
	if (!username) { res.status(400).json({ error: "Your session does not carry a username. Sign out and sign in again." }); return; }
	const body = req.body as { reason: string };

	try {
		const rec = await ReverseServiceChargeWaiver(restaurantId, waiverId, { reason: body.reason, by_username: username });
		const tableName = await GetTableNameById(restaurantId, rec.table_id).catch(() => null);
		announceBill(restaurantId, tableName, null);
		try {
			await log_audit(
				req,
				PERM_SERVICE_CHARGE_WAIVER,
				`Reversed the service-charge waiver on bill ${rec.bill_id} — the charge is back on (₹${rec.amount_waived.toFixed(2)})`,
				Audit_log_category.Bill,
				{
					reversal: true, waiver_id: rec.id, bill_id: rec.bill_id, table: tableName,
					amount_waived: rec.amount_waived, grand_total_reduction: rec.grand_total_reduction,
					reason: rec.reversal_reason, original_reason: rec.reason,
					originally_authorised_by: rec.authorised_by_username,
				},
			);
		} catch (err) { logger.warn({ err }, "log_audit service_charge_waiver_reverse failed"); }
		res.json({ waiver: rec });
	} catch (err) {
		failCapture(res, err, "reverse_service_charge_waiver_failed", "That waiver has already been reversed.");
	}
});

/*
	REMOVE THE SERVICE CHARGE AND PRINT THE BILL — ONE ACT, ONE REQUEST.

	POST /bills/service-charge-waiver/print
	  body { table_name, waiver_kind?, reason?, authorised_by?, render?: "thermal" | "client" }
	  -> 200 { success, waiver, waiver_created, grand_total_before, grand_total_after,
	           service_charge_removed, printed, print_error?, render, ...the print's own fields }
	  -> 400 nothing on the table / no service charge on it (nothing_to_remove) /
	         a missing kind or authoriser (or reason, before migration 051) /
	         anything WaiveServiceCharge refuses
	  -> 403 C3's reprint refusal (reprint_needs_senior) / no waive permission (waiver_required)

	============================================================================
	WHY IT EXISTS
	============================================================================
	The client: "reprint without service charge and waive service charge should
	be merged as one option instead of being 2 separate steps." Since the paper
	was made to equal the drawer, the RECORDED WAIVER is the only thing that takes
	the charge off a bill, so the old "Reprint (no service charge)" could not do
	its job alone — its own dialog sent the user to "Waive service charge", and a
	press in the wrong order spent a full-charge copy (and a waiter's one print)
	for nothing. Production showed the result: a refused print, a waiver, a
	reprint, 3 to 30 seconds apart, on table after table.

	============================================================================
	THE ORDER IS THE CONTROL
	============================================================================
	Nothing that moves money is written until every refusal has been answered:

	  1. an empty table — the same 400 and sentence as /print/bill;
	  2. C3 — refuseWaiterBillReprint, the SAME function /print/bill and
	     /print/bill/claim call. Asked before the waiver, so a waiter who may not
	     print this bill again can never record a waiver they cannot then hand
	     over (the drawer would drop and the guest would hold the old paper);
	  3. a bill that ALREADY carries a live waiver is a plain reprint of it: no
	     permission beyond printing, no second reason, no second row, no second
	     audit line. That is also what a lost response on a flaky line recovers
	     to, instead of a dead-end "already waived";
	  4. no charge to remove — 400 `nothing_to_remove`, and nothing prints: the
	     user asked for a removal, and an ordinary print would answer a different
	     question;
	  5. the waive permission, checked HERE rather than in the guard chain,
	     because step 3 needs none. The guard is "Add Orders", the print's own —
	     the manifest shows one gate, and this is the second;
	  6. the kind and the authoriser, then resolveActors — the same 400/403
	     answers the waiver route gives. The reason is optional where migration
	     051 has made the column nullable, and required, as it always was, where
	     it has not.

	Steps 5 and 6 refuse an attempt on a charge that IS on the bill, so each of
	their refusals files a REFUSED line first (auditRefusedServiceChargeRemoval)
	— the record the old no_service_charge print left, which this route replaced.

	Then the waiver is WaiveServiceCharge, unchanged, and its audit line is
	auditServiceChargeWaiver's — so the Service Charge Deny report and the Bill
	Edit report see the same row and the same line whichever route wrote it. A
	23505 means another device waived between step 3 and the insert; the charge
	is off, which is what was asked, so this carries on as a reprint of THAT
	waiver.

	============================================================================
	THE PAPER IS READ AFTER THE COMMIT, THROUGH THE SAME CODE
	============================================================================
	The print re-reads the bill (the waiver may have minted its number) and goes
	through printOpenTableBill — /print/bill's own render, dispatch and audit —
	which reads the charge configuration itself, so the charge comes off the
	paper because the waiver is in the database. `render: "client"` is the web
	dashboard, which draws its own paper: claimClientRenderedBillPrint records
	the print exactly as /print/bill/claim does and hands back `printable_bill`.

	It is not atomic with the paper and cannot be: a printer does not join a
	transaction. It does not need to be. The invariant is "no paper without the
	charge unless a waiver has committed", and the order above guarantees it. A
	print that fails AFTER the commit is answered 200 with `printed: false` and
	`print_error` — never a 5xx, which would hide a committed change to what the
	guest owes from the person who has to tell them.

	No idempotent(), for the reasons in this file's header: it can mint a bill,
	and a repeated request for paper is a request for a second piece of paper.

	============================================================================
	A PRINT DOOR THAT IS NOT UNDER /print/
	============================================================================
	The thermal path ends in /print/bill's 'bill:print' emit. The serverless
	topology (deploy/template.yaml, parked) serves /print/* and /publish/* from
	the always-on task that owns the printer sockets, because an emit made on
	Lambda can be frozen in the container. This path matches neither, so the
	template names it as its own behaviour. Move or rename the route and that
	behaviour must follow, or a committed waiver answers printed:true with no
	paper — jest-tests/bill_print_doors_always_on.test.ts fails if it does not.
*/
app.post("/bills/service-charge-waiver/print", validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), validateBody(sRemoveServiceChargeAndPrint), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	const outletId = extractOutletId(req);
	if (!restaurantId || !outletId) { res.status(400).json({ error: "Missing restaurant/outlet" }); return; }
	const body = req.body as { table_name: string; waiver_kind?: string; reason?: string | null; authorised_by?: string; render?: string };
	const tableName = String(body.table_name ?? "").trim();
	if (!tableName) { res.status(400).json({ error: "table_name is required" }); return; }
	const render = body.render === "client" ? "client" : "thermal";

	// --- 1-4: the reads every refusal is decided on. Nothing is written. -------
	let waiver: Awaited<ReturnType<typeof GetBillChargeConfigForTable>>["waiver"] = null;
	let basis: Awaited<ReturnType<typeof GetBillChargeConfigForTable>>["basis"] = "none";
	try {
		const bill = await GetBillForTable(restaurantId, tableName);
		if (!bill || !Array.isArray(bill.items) || bill.items.length === 0) {
			res.status(400).json({ error: "Nothing to print for this table" });
			return;
		}
		if (await refuseWaiterBillReprint(req, res, tableName, bill, restaurantId)) { return; }
		const cfg = await GetBillChargeConfigForTable(restaurantId, tableName);
		waiver = cfg.waiver;
		basis = cfg.basis;
	} catch (err) {
		logger.error({ err }, "remove_service_charge_print_read_failed");
		res.status(500).json({ error: String((err as { message?: unknown })?.message ?? "Unable to read this table's bill") });
		return;
	}

	let created: { before: number; after: number } | null = null;
	if (!waiver) {
		if (basis === "none") {
			res.status(400).json({ error: "This bill carries no service charge, so there is nothing to remove.", nothing_to_remove: true });
			return;
		}
		// From here on a charge is on the bill and no waiver is, so every refusal
		// is a refused attempt on that charge and goes on the record first.
		// --- 5: the second gate. Named, in the shape validateAction refuses in. --
		if (!callerHasPermission(req, PERM_SERVICE_CHARGE_WAIVER)) {
			await auditRefusedServiceChargeRemoval(req, tableName, "waiver_required", basis, null);
			res.status(403).json({
				error: "Forbidden",
				details: "Removing the service charge needs the 'Waive Service Charge' permission. Ask a manager to do it, or an admin to grant it to your role.",
				requiredPermission: PERM_SERVICE_CHARGE_WAIVER,
				waiver_required: true,
			});
			return;
		}
		// --- 6: the control document's fields. ----------------------------------
		const kind = String(body.waiver_kind ?? "").trim();
		const reason = String(body.reason ?? "").trim();
		if (!kind || !reason) {
			// Something is missing, and whether that is a refusal is the schema's
			// answer (migration 051). A complete form never asks, so it is today's
			// request on every server.
			if (!(await resolveServiceChargeWaiverReasonOptional())) {
				// Before 051: today's refusal, byte for byte.
				await auditRefusedServiceChargeRemoval(req, tableName, "reason_required", basis, null);
				res.status(400).json({ error: "Say why the service charge is coming off — waiver_kind and reason are required." });
				return;
			}
			if (!kind) {
				await auditRefusedServiceChargeRemoval(req, tableName, "kind_required", basis, null);
				res.status(400).json({ error: "Say why the service charge is coming off — waiver_kind is required." });
				return;
			}
		}
		const who = await resolveActors(
			req, res, restaurantId, PERM_SERVICE_CHARGE_WAIVER, "a service-charge waiver",
			(refusal, authorisedBy) => auditRefusedServiceChargeRemoval(req, tableName, refusal, basis, authorisedBy),
		);
		if (!who) {return;}

		try {
			const result = await WaiveServiceCharge(restaurantId, {
				table_name: tableName,
				waiver_kind: kind,
				reason: reason || null,
				actor: {
					employee_id: who.employee_id,
					username: who.username,
					authorised_by_employee_id: who.authorised_by_employee_id,
					authorised_by_username: who.authorised_by_username,
				},
			});
			waiver = result.record;
			created = { before: result.grand_total_before, after: result.grand_total_after };
			announceBill(restaurantId, tableName, null);
			await auditServiceChargeWaiver(req, who, result, tableName);
		} catch (err) {
			if (!isUniqueViolation(err)) {
				failCapture(res, err, "remove_service_charge_print_failed", "This bill's service charge has already been waived.");
				return;
			}
			// Another device waived it between the read and the insert. Reprint
			// THAT waiver rather than refusing what has, in fact, happened.
			logger.warn({ err }, "remove_service_charge_print_raced");
			waiver = await GetBillChargeConfigForTable(restaurantId, tableName).then((c) => c.waiver).catch(() => null);
			if (!waiver) {
				res.status(409).json({ error: "This bill's service charge has already been waived." });
				return;
			}
		}
	}

	// --- the paper, from the state AFTER the commit --------------------------------
	let printed = false;
	let printError: string | null = null;
	let serviceChargeRemoved = true;
	let grandTotalAfter: number | null = created?.after ?? null;
	let paper: Record<string, unknown> = {};
	try {
		if (render === "client") {
			const fresh = await GetBillForTable(restaurantId, tableName);
			if (!fresh || !Array.isArray(fresh.items) || fresh.items.length === 0) { throw new Error("Nothing to print for this table"); }
			paper = await claimClientRenderedBillPrint(req, { restaurantId, outletId, tableName, bill: fresh });
			serviceChargeRemoved = fresh.service_charge_waived === true;
			grandTotalAfter = fresh.grand_total;
		} else {
			// The same three reads, with the same fallbacks, /print/bill makes.
			const [fresh, settings, profile] = await Promise.all([
				GetBillForTable(restaurantId, tableName),
				GetRestaurantSettings(restaurantId).catch(() => ({ currency: "₹" } as any)),
				GetRestaurantProfile(restaurantId).catch(() => null),
			]);
			if (!fresh || !Array.isArray(fresh.items) || fresh.items.length === 0) { throw new Error("Nothing to print for this table"); }
			const out = await printOpenTableBill(req, {
				restaurantId, outletId, tableName, bill: fresh, settings, profile,
				// It WAS asked for without the charge. If the waiver were somehow
				// reversed between the commit and this read, the paper would carry
				// the charge and the audit line would say so — which is the truth.
				askedWithoutServiceCharge: true,
			});
			paper = {
				billId: out.billId, jobId: out.jobId, destination: out.destination, device: out.device,
				next_party_table: out.next_party_table, next_party_message: nextPartyPrintMessage(out.next_party_table),
			};
			serviceChargeRemoved = out.service_charge_removed;
			grandTotalAfter = out.grand_total;
		}
		printed = true;
	} catch (err) {
		logger.error({ err }, "remove_service_charge_print_paper_failed");
		printError = String((err as { message?: unknown })?.message ?? "Unable to print");
	}

	res.json({
		success: true,
		waiver,
		waiver_created: created !== null,
		// What the guest was asked for before this waiver — null on a reprint of
		// an existing one, whose "before" belongs to whoever recorded it.
		grand_total_before: created?.before ?? null,
		// What is on the paper when there is paper; the waiver's own figure when
		// the print failed. Both are the drawer's.
		grand_total_after: grandTotalAfter,
		service_charge_removed: serviceChargeRemoved,
		printed,
		...(printError !== null ? { print_error: printError } : {}),
		render,
		...paper,
	});
});
}
