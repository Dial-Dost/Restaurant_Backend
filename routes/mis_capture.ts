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
	GetNonChargeablesForOrders,
	GetTableNameById,
	MarkOrderItemNonChargeable,
	ResolveAuthoriser,
	ReverseNonChargeable,
	ReverseServiceChargeWaiver,
	VoidOrderWithReason,
	WaiveServiceCharge,
} from "../database_supabase.js";
import { dispatchCancellationKot } from "../kot_print.js";
import { NON_CHARGEABLE_KINDS, SERVICE_CHARGE_WAIVER_KINDS, VOID_KINDS } from "../mis_capture.js";
import { logger } from "../observability.js";
import { emitRestaurant } from "../realtime.js";
import {
	PERM_NON_CHARGEABLE,
	PERM_SERVICE_CHARGE_WAIVER,
	PERM_VOID_ORDER,
	extractEmployeeId,
	extractEmployeeUsername,
	extractRestaurantId,
	log_audit,
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

const sWaiveServiceCharge = z.object({
	waiver_kind: z.enum(SERVICE_CHARGE_WAIVER_KINDS),
	reason: sReason,
	authorised_by: sAuthorisedBy,
	table_name: z.string().optional(),
	bill_id: z.string().optional(),
}).passthrough().refine(
	(b) => (typeof b.table_name === "string" && b.table_name.trim().length > 0)
		|| (typeof b.bill_id === "string" && b.bill_id.trim().length > 0),
	{ message: "table_name or bill_id is required" },
);


// --- Shared handler plumbing -------------------------------------------------

/**
 * Resolve BOTH names for one capture write: the acting user (session only) and
 * the authoriser (body, resolved and permission-checked).
 *
 * Answers the request itself and returns null on every failure, so a handler
 * reads as `const who = await resolveActors(...); if (!who) {return;}` — the same
 * shape enforcePermission uses.
 */
async function resolveActors(
	req: Request,
	res: Response,
	restaurantId: string,
	actionId: string,
	act: string,
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
		res.status(400).json({ error: "Your session does not carry a username. Sign out and sign in again." });
		return null;
	}
	const raw = (req.body ?? {}) as Record<string, unknown>;
	const wanted = typeof raw.authorised_by === "string" ? raw.authorised_by.trim() : "";
	if (!wanted) {
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
			res.status(400).json({ error: `No staff member '${wanted}' in this outlet — authorised_by must name one.` });
		} else {
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
	  body { table_name | bill_id, waiver_kind, reason, authorised_by }
	  -> 201 { waiver, grand_total_before, grand_total_after }

	Works in BOTH shapes this fleet runs — "Restaurant".service_charge and a
	"Service Charge" line inside "Outlets".default_tax — because the saving is
	measured by running the real charge computation twice and differencing, never
	by a second implementation of the arithmetic. In the first shape GST sits on
	the charge, so the grand total falls by MORE than the charge itself; in the
	second it does not. `grand_total_before/after` are the two totals that
	difference, so the till can show the guest what actually changed.

	OPEN BILLS ONLY. A settled bill is final; a post-payment dispute is a refund,
	which has its own path, its own columns and its own audit entry.
*/
app.post("/bills/service-charge-waiver", validateAction(PERM_SERVICE_CHARGE_WAIVER), validateBody(sWaiveServiceCharge), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = req.body as { waiver_kind: string; reason: string; table_name?: string; bill_id?: string };
	const tableName = String(body.table_name ?? "").trim();
	const billId = String(body.bill_id ?? "").trim();

	const who = await resolveActors(req, res, restaurantId, PERM_SERVICE_CHARGE_WAIVER, "a service-charge waiver");
	if (!who) {return;}

	try {
		const result = await WaiveServiceCharge(restaurantId, {
			...(tableName ? { table_name: tableName } : {}),
			...(billId ? { bill_id: billId } : {}),
			waiver_kind: body.waiver_kind,
			reason: body.reason,
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
		try {
			await log_audit(
				req,
				PERM_SERVICE_CHARGE_WAIVER,
				`Waived the service charge (₹${rec.amount_waived.toFixed(2)}, grand total −₹${rec.grand_total_reduction.toFixed(2)}) on bill ${rec.bill_id}${emitTable ? ` (table ${String(emitTable)})` : ""} — authorised by ${who.authorised_by_username}`,
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
}
