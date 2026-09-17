/**
 * Orders: listing, creation (dine-in/takeaway), item edits, status, deletion and the
 * kitchen timing actions (pause/resume/serve/fire/bark).
 */
import type { Express, Request, Response } from "express";
import { randomUUID } from "crypto";
import { AddOrder, AddTakeawayOrder, Audit_log_category, BARK_ORDER_ACTION_ID, BarkOrder, DeleteOrder, FIRE_COURSE_ACTION_ID, FireOrderItems, GetOrderKotContext, GetOrders, GetOrdersScope, IsOrderItemServed, OrderTimingAction, RecordOrderVoid, SetOrderStatus, UpdateOrderItemsSplit, applyMenuPriceFloor } from "../database_supabase.js";
import { isCancelNeedsSeniorError } from "../cancel_authority.js";
import { isDiscountAuthorityError } from "../discount_authority.js";
import { autoPrintOrderKot, dispatchCancellationKot, type KotLine } from "../kot_print.js";
import { idempotent } from "../idempotency.js";
import { resolveServeIntent } from "../order_intent.js";
import { logger } from "../observability.js";
import { hidesPrices, redactOrderList } from "../price_scope.js";
import { emitRestaurant } from "../realtime.js";
import type { CreatedOrderInfo } from "./_shared.js";
import { PERM_CLOSE_BILL, PERM_ORDER_DELETE, emitOrderCreated, enforceSettleAuthority, extractEmployeeId, extractEmployeeUsername, extractOutletId, extractRestaurantId, linkOrderToCustomer, log_audit, notifyOrderCreated, optionalMobile10, refuseOrderOnPrintedBill, refuseTicketedCancel, reprintNeededFields, validateAction } from "./_shared.js";
import type { RoleScopeInput } from "../role_scope.js";


// --- Order/item preparation timers (pause/resume, mark item served) ---------
const ORDER_ACTION = "4ad474d4-5230-449c-874f-6a238b833bca";
// Barking pushes a ticket to the kitchen — a different job from taking the order.
// It used to share "Add Orders", which every waiter needs, so waiters could bark.
const PERM_BARK = "3f6a9c1e-8d24-4b7a-b5c9-2e1f7d4a8b63"; // Bark Order

/**
 * WHERE THE KITCHEN DOCKET IS TRIGGERED FROM, and why it is four places.
 *
 * THE TRIGGER MOVED. It used to be the BARK and only the bark. It is now ORDER
 * PLACED — POST /orders and POST /orders/takeaway below, plus the guest QR page
 * in routes/guest.ts — because that is the moment the restaurant wants paper on
 * the pass. Three consequences, all of them deliberate:
 *
 *   1. THE APPROVAL GATE STILL HOLDS. An order placed while auto-push is off is
 *      created Pending, and autoPrintOrderKot refuses to print a Pending order.
 *      The accept transition (PATCH /orders/:id/status -> Preparing) prints it
 *      instead. Without that the printer would be approving orders.
 *
 *   2. BARK NO LONGER PRINTS, in practice. It still calls in, but the order was
 *      ticketed at placement, so the content memo answers "already KOT-26" and
 *      nothing is built. It fires for real only on an order the placement path
 *      never ticketed — auto-print switched off at the time and switched on
 *      since, a print that failed before it could allocate. Keeping the call is
 *      what makes bark the safety net rather than a second docket.
 *
 *   3. BARK IS STILL A REAL STEP. barked_at is the KITCHEN CLOCK: un-barked
 *      orders never age (loadOrderTiming), prep timers rebase on it, and
 *      bark-to-served is the number the analytics report. Removing it would not
 *      remove a print, it would remove the timing baseline.
 *
 * WHY THE DOCKET IS ORDER-SCOPED AND NOT TABLE-SCOPED
 * ---------------------------------------------------
 * The manual thermal KOT (POST /print/bill {kind:"kot"}) prints the TABLE: it
 * goes through GetBillForTable, which aggregates every active order on the
 * table. Automatic printing is not that. A party orders starters at 19:00
 * (cooked, eaten) and mains at 19:40; printing the table aggregate for the
 * second order would put the starters in front of the kitchen again and the
 * restaurant would cook and eat the cost of them. So every automatic path reads
 * the ORDER's own lines (GetOrderKotContext) and prints those — and the add-item
 * path narrows it further, to the one line that was added.
 *
 * WHY NONE OF THESE CAN MINT A SECOND KOT NUMBER
 * ----------------------------------------------
 * The ticket key is (outlet, business day, table, normalised item set, scope).
 * An unchanged order hashes to the same key wherever it is dispatched from, so
 * AllocateKotNumber returns the memoised number with reused:true — and
 * skipIfTicketed turns that into "print nothing", which is what makes place-then
 * -bark one docket instead of two. The manual reprint
 * (POST /print/kot/order/:id) leaves skipIfTicketed off, so it still reprints
 * the same number and the same bytes on demand.
 */
async function handleTiming(req: Request, res: Response, action: "pause" | "resume" | "serve" | "start" | "unserve", withItem: boolean) {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const orderId = String(req.params.id ?? "").trim();
	const itemId = withItem ? String(req.params.itemId ?? "").trim() : undefined;
	if (!orderId || (withItem && !itemId)) { res.status(400).json({ error: "order id (and item id) required" }); return; }
	try {
		const ok = await OrderTimingAction(restaurantId, orderId, action, itemId);
		if (!ok) { res.status(404).json({ error: "Order not found" }); return; }
		try { await log_audit(req, ORDER_ACTION, `Timer ${action}${itemId ? ` item ${itemId}` : ""} on order ${orderId}`, Audit_log_category.Orders, { order_id: orderId, item_id: itemId, action }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (err: any) {
		logger.error({ err }, "order_timing_failed");
		res.status(400).json({ error: String(err?.message ?? "Unable to update timer") });
	}
}

/**
 * The session's role inputs, for the data layer's client-item-3 rule
 * (mayCancelTicketed). Passed down rather than judged here because the verdict
 * needs the order's status as the writer reads it — see cancel_authority.ts.
 */
function actorOf(req: Request): RoleScopeInput {
	return { role: req.auth?.role, role_all: req.auth?.role_all, actions: req.auth?.actions };
}

export function registerOrderRoutes(app: Express): void {

app.get("/orders", validateAction("b7f78d0f-323d-4622-8d05-aa2f82d54b2e"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	try {
		// Optional per-zone filter: a locked kitchen display can fetch only its own
		// section server-side. Empty/absent => no filter (full set, as before).
		const station = typeof req.query.station === "string" ? req.query.station : "";
		const items = await GetOrders(restaurantId, station);
		// C4 — THE THIRD SURFACE, AND THE ONE THAT WOULD HAVE MADE THE OTHER TWO
		// POINTLESS. A table's running bill IS the sum of its active orders, and
		// this feed carries every one of them with `items[].price` on each line
		// plus the ticket's own `subtotal` and `total` — so a waiter refused the
		// prices on /bill-for-table could have read the same numbers, line for
		// line, off the orders grid they already have open. The Flutter app
		// gates all three behind the same `RoleScope.showsMoney`
		// (modules.dart:2772, :3073, :3186); the server now does too.
		//
		// The KITCHEN half of this payload is untouched — station, prep timers,
		// hold/fire, notes, variations, KOT numbers, who took it — because none
		// of it is money and the KDS reads this same endpoint.
		res.json(hidesPrices(req.auth) ? redactOrderList(items) : items);
	} catch (error) {
		logger.error({ err: error }, "get_orders_failed");
		res.status(500).json({ error: "Unable to fetch orders" });
	}
});

// Why the orders grid looks the way it does — the context a client needs to
// EXPLAIN an empty list instead of rendering a blank screen.
//
// GET /orders stays scoped to the caller's outlet (a branch view must never leak
// another branch's orders), and guest/QR orders always land on the TABLE's
// outlet — so a staffer signed into a branch with no tables correctly sees zero
// orders. This endpoint hands the UI the numbers to say so out loud:
// "No orders in Branch 2 — 11 are in Main Outlet. Switch outlet?".
//
// Kept as a COMPANION endpoint rather than reshaping GET /orders, whose response
// is a bare array that both clients already consume.
//
// `X-Outlet-Id: all` (admin/manager) works here exactly as it does on GET
// /orders: the counts span every outlet, is_all_outlets is true, and
// other_outlet_orders is 0 because nothing is hidden in that mode.
app.get("/orders/scope", validateAction("b7f78d0f-323d-4622-8d05-aa2f82d54b2e"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}
	try {
		res.json(await GetOrdersScope(restaurantId));
	} catch (error) {
		logger.error({ err: error }, "get_orders_scope_failed");
		res.status(500).json({ error: "Unable to fetch order scope" });
	}
});

app.post("/orders", validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), idempotent(), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const orderBody = (req.body ?? {}) as Record<string, unknown>;
	// Phone is optional on a dine-in order; a typed one must be a full 10-digit
	// mobile before it becomes a CRM identity.
	const orderPhone = optionalMobile10(res, orderBody.customer_phone);
	if (!orderPhone.ok) {return;}
	// THE SAME MONEY GATE AS PATCH /orders/:id/status. This route is also the
	// dashboard's upsert, and AddOrder writes whatever status the body names —
	// so "Paid" or "Closed" through here settled an order with no settle
	// authority at all (found while closing client item 3's side door below).
	const upsertStatus = typeof orderBody.status === "string" ? orderBody.status.trim().toLowerCase() : "";
	if (["paid", "closed"].includes(upsertStatus) && !(await enforceSettleAuthority(req, res))) {return;}

	try {
		const body: Record<string, unknown> = { ...orderBody, ...(orderPhone.value ? { customer_phone: orderPhone.value } : {}) };
		// CLIENT ITEM 6 — THE PRINTED BILL IS WHAT THE GUEST PAYS AGAINST. A waiter
		// adding to it after the print makes the paper short and cannot reprint
		// (C3), so they are refused and pointed at the next party's seat; a senior
		// role is allowed and told to reprint. Before AddOrder, so a refusal writes
		// nothing. This route is ALSO the dashboard's upsert (a status change, an
		// edit), so the order the body names is passed along and only a resend
		// that adds to the bill is judged. See refuseOrderOnPrintedBill.
		const guard = await refuseOrderOnPrintedBill(req, res, {
			restaurantId, tableName: typeof body.table === "string" ? body.table : "", guest: false,
			upsert: { orderId: typeof body.id === "string" ? body.id : null, items: body.items },
		});
		if (guard.refused) {return;}
		// CLIENT ITEM 3 — the upsert is a door to "Cancelled" too; AddOrder
		// refuses a waiter-only login on a ticketed order before writing.
		const result = await AddOrder(restaurantId, body, { actor: actorOf(req) });
		// Best-effort guest registration: orders that carry a phone create/match a
		// Customers row and get cust_id stamped (CRM visit tracking).
		await linkOrderToCustomer(restaurantId, result.id, body.customer, orderPhone.value);
		// A staff-typed dine-in order is a new kitchen ticket exactly like a QR
		// one, so it raises the same notification and the same realtime event.
		const created: CreatedOrderInfo = {
			orderId: result.id,
			table: typeof body.table === "string" ? body.table : null,
			items: body.items,
			total: body.total ?? body.subtotal,
			status: body.status ?? "Preparing",
			orderType: body.order_type,
		};
		await notifyOrderCreated(restaurantId, created);
		// Placing an order was the only order operation with no audit trail.
		try {
			await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca",
				`New order ${created.orderId}${created.table ? ` on table ${created.table}` : ""}`,
				Audit_log_category.Orders, { order_id: created.orderId, table: created.table ?? null });
		} catch (err) { logger.warn({ err }, "log_audit order-create failed"); }
		emitOrderCreated(restaurantId, created);
		// THE KITCHEN DOCKET, at the moment the order is placed. Never throws and
		// never fails the order: the row is committed and the guest has been told
		// it was taken, so a printer problem is reported, not raised.
		const printed = await autoPrintOrderKot({ restaurantId, orderId: result.id, where: "order_placed" });
		res.status(201).json({
			...result,
			kot_printed: printed.printed, kot_no: printed.kot_no, kot_tickets: printed.tickets,
			...(printed.reason ? { kot_skipped: printed.reason } : {}),
			// The bill in the guest's hand no longer covers this order: the
			// flag, the sentence and the table a Reprint action prints.
			...reprintNeededFields(guard),
		});
	} catch (error: any) {
		if (isCancelNeedsSeniorError(error)) { await refuseTicketedCancel(req, res, error); return; }
		logger.error({ err: error }, "add_order_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to add order") });
	}
});

// Place a takeaway / delivery order (no physical table — a hidden virtual table
// is provisioned to carry the bill).
app.post("/orders/takeaway", validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), idempotent(), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const orderType = String(body.order_type ?? "takeaway").toLowerCase() === "delivery" ? "delivery" : "takeaway";
	if (!Array.isArray(body.items) || body.items.length === 0) { res.status(400).json({ error: "At least one item is required" }); return; }
	// A takeaway/delivery guest is reached on this number, so a typed one must be a
	// full 10-digit mobile (still optional for counter takeaways).
	const takeawayPhone = optionalMobile10(res, body.customer_phone);
	if (!takeawayPhone.ok) {return;}
	try {
		const result = await AddTakeawayOrder(restaurantId, {
			...(body as any),
			order_type: orderType,
			...(takeawayPhone.value ? { customer_phone: takeawayPhone.value } : {}),
		});
		// Takeaway/delivery orders usually carry the guest's phone — register them too.
		await linkOrderToCustomer(restaurantId, result.id, body.customer, takeawayPhone.value);
		try { await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `New ${orderType} order ${result.id}`, Audit_log_category.Orders, { order_id: result.id, order_type: orderType }); } catch {/* ignore */}
		// Same fan-out as dine-in, but the copy names the CHANNEL ("New takeaway
		// order") — the carried table is a hidden virtual row, not a real one.
		const createdTakeaway: CreatedOrderInfo = {
			orderId: result.id,
			table: result.table,
			items: body.items,
			total: body.total ?? body.subtotal,
			status: body.status ?? "Preparing",
			orderType: result.order_type ?? orderType,
		};
		await notifyOrderCreated(restaurantId, createdTakeaway);
		emitOrderCreated(restaurantId, createdTakeaway);
		// Same trigger as dine-in. A takeaway is backed by a hidden virtual
		// "Tables" row, so it keys and numbers exactly like any other order.
		const printedTakeaway = await autoPrintOrderKot({ restaurantId, orderId: result.id, where: "order_placed" });
		res.status(201).json({
			...result,
			kot_printed: printedTakeaway.printed, kot_no: printedTakeaway.kot_no, kot_tickets: printedTakeaway.tickets,
			...(printedTakeaway.reason ? { kot_skipped: printedTakeaway.reason } : {}),
		});
	} catch (error: any) {
		logger.error({ err: error }, "add_takeaway_order_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to add order") });
	}
});

// Advance a single order's stage (Preparing -> Served -> ...). Used by the
// orders list and the kitchen display.
//
// KEYED, INCLUDING WHEN status IS "Paid", and that is not a hole in the
// offline-settlement scope decision. Settlement is out of scope because an
// invoice number cannot be minted offline: "Outlets".bill_seq and
// AllocateKotNumber are cloud atomic counters behind a gap-free per-outlet GST
// series, and every route that touches them lives in routes/bills.ts, which
// carries no guard from idempotency.ts. SetOrderStatus touches neither counter.
// What the key buys here is the everyday transition a waiter makes fifty times a
// service — and since it is additive, a Paid transition behaves exactly as it
// does today: still gated on enforceSettleAuthority below, still refused by
// assertOrderStatusEditable on a settled order. A key never makes a request
// succeed that would otherwise fail.
app.patch("/orders/:id/status", validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), idempotent(), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const orderId = typeof req.params.id === "string" ? req.params.id.trim() : "";
	const status = typeof req.body?.status === "string" ? req.body.status.trim() : "";
	if (!orderId || !status) { res.status(400).json({ error: "orderId and status are required" }); return; }
	// Settling money is a different job from moving a ticket along. Everyday
	// transitions (Preparing → Served …) stay with "Add Orders" so waiters keep
	// working, but marking an order PAID additionally requires "Close Bill" —
	// previously any waiter could settle a bill.
	//
	// C2: the check itself moved to enforceSettleAuthority so that every settle
	// path in the codebase asks ONE function rather than repeating one uuid. Same
	// capability, same verdict — what changes is that a fifth settle path added
	// later cannot quietly disagree with this one, and the 403 now names the
	// permission the operator has to grant.
	const settles = ["paid", "closed"].includes(status.toLowerCase());
	if (settles && !(await enforceSettleAuthority(req, res))) {return;}
	// A2 — THE REASON THE CLIENTS ALREADY SEND, WHICH THIS ROUTE USED TO DISCARD.
	//
	// "A reason is required before the action is processed and finalized" was
	// true of the prompt and false of the database: the owner app and the
	// dashboard both prompt unconditionally before a cancel and put the answer in
	// the body, and this handler read `status` and nothing else. The reason
	// reached the server, was parsed by nobody, and the void report went on
	// showing "unknown" beside every cancelled ticket.
	//
	// READ HERE, ACTED ON BELOW, AND NOT MANDATORY — see the recording block
	// after the status write for why the server records what it is given rather
	// than refusing what it is not.
	const cancelReason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
	const cancelKind = typeof req.body?.void_kind === "string" ? req.body.void_kind.trim() : "";
	try {
		// CLIENT ITEM 3 — the session's roles travel with the write, and
		// SetOrderStatus refuses a waiter-only cancel of a ticketed order before
		// it writes anything: no status flip, no void row, no slip.
		const result = await SetOrderStatus(restaurantId, orderId, status, { actor: actorOf(req) });
		if (!result.ok) { res.status(404).json({ error: "Order not found" }); return; }
		// Re-cancelling an order that is already Cancelled is an idempotent no-op:
		// nothing was written, so nothing is logged (and no second undo envelope
		// is recorded for the same cancellation).
		if (!result.changed) { res.json({ success: true, unchanged: true }); return; }
		// A transition INTO Cancelled is the one order-status change that is
		// undoable — record the before-state envelope the undo registry reads
		// (see UNDO_REGISTRY.order_cancel). Every other status change stays
		// deny-by-default: no envelope, no undo.
		const isCancel = status.trim().toLowerCase() === "cancelled" || status.trim().toLowerCase() === "canceled";
		const undoEnvelope = isCancel && result.previous_status
			? {
				undo: {
					kind: "order_cancel",
					target_id: orderId,
					before: { status: result.previous_status },
					after: { status: "Cancelled" },
				},
			}
			: {};
		// A2 — PERSIST THE REASON AGAINST THE CANCELLED ORDER.
		//
		// WHERE IT GOES: "OrderVoids" (migration 035), scope='order'. That is not a
		// new home invented here — 035's own header names "PATCH /orders/:id/status
		// -> Cancelled" as one of the two writes it exists to record, and it was
		// simply never wired. Writing it there rather than into a new column is
		// what makes the reason reach the void report, the stage derivation (which
		// is the fraud signal, and which the server derives — a client cannot
		// self-report it) and the money figure, all of which already exist.
		//
		// WHY IT IS NOT MANDATORY SERVER-SIDE, STATED PLAINLY: every till in the
		// field today is a shipped binary, and some of them do not send a reason.
		// A 400 on a missing reason would mean a live floor cannot cancel a
		// mis-keyed order, which is a service-stopping outage traded for a
		// reporting improvement. So the rule is RECORD WHAT YOU ARE GIVEN: a cancel
		// with a reason is ledgered, a cancel without one behaves exactly as it did
		// yesterday and shows in the report as "unknown", and the report already
		// counts that gap. Making it mandatory is a separate, deliberate step to
		// take once the fleet has turned over — not a side effect of this fix.
		//
		// BEST-EFFORT, AFTER THE FACT, AND IT CANNOT FAIL THE CANCEL. The order is
		// already cancelled by the time this runs; a ledger write that throws (035
		// unapplied on this deployment, a constraint, a dead connection) must not
		// turn a completed cancellation into a 400 the till will retry. It is
		// logged loudly instead, and the audit entry below still carries the reason
		// verbatim, so the reason is never lost to both records at once.
		//
		// `void_kind` defaults to 'other' because the clients send free text: 035's
		// CHECK constraint only accepts its seven vocabulary values, and rejecting
		// a real reason for want of a category would discard exactly the thing this
		// change exists to keep. A client that sends a recognised kind gets it.
		let voidRecord: Awaited<ReturnType<typeof RecordOrderVoid>> | null = null;
		if (isCancel && cancelReason) {
			try {
				voidRecord = await RecordOrderVoid(restaurantId, {
					order_id: orderId,
					scope: "order",
					void_kind: cancelKind || "other",
					reason: cancelReason,
					actor: {
						employee_id: extractEmployeeId(req),
						username: extractEmployeeUsername(req) ?? extractEmployeeId(req) ?? "unknown",
						// SELF-AUTHORISED, AND THE ROW SAYS SO. 035 requires an
						// authoriser name and refuses to infer one from a blank. This
						// route is the everyday cancel, not the manager-void route
						// (POST /orders/:id/void, gated on PERM_VOID_ORDER, which is
						// where a second name is demanded and permission-checked by
						// ResolveAuthoriser). Recording the actor as their own
						// authoriser is the honest shape 034's header describes for a
						// manager acting alone — it says who did it and claims nothing
						// more. An auditor reading `voided_by = authorised_by` can see
						// at a glance that nobody countersigned.
						authorised_by_employee_id: extractEmployeeId(req),
						authorised_by_username: extractEmployeeUsername(req) ?? extractEmployeeId(req) ?? "unknown",
					},
				});
			} catch (e) {
				logger.error({ err: e, order_id: orderId }, "record_order_void_reason_failed");
			}
		}
		try {
			// THE REASON IS IN THE AUDIT LINE ITSELF, not only in the details blob.
			// The audit trail is what a manager reads at the end of a service, and a
			// reason that is only reachable by expanding a JSON column is a reason
			// nobody reads.
			const reasonNote = isCancel && cancelReason ? ` — reason: ${cancelReason}` : "";
			await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Order ${orderId} -> ${status}${reasonNote}`, Audit_log_category.Orders, {
				order_id: orderId, status,
				...(isCancel && cancelReason
					? {
						reason: cancelReason,
						void_kind: voidRecord?.void_kind ?? (cancelKind || "other"),
						void_id: voidRecord?.id ?? null,
						void_stage: voidRecord?.stage ?? null,
						void_recorded: voidRecord !== null,
					}
					: {}),
				...undoEnvelope,
			});
		} catch (e) { logger.warn({ err: e }, "log_audit order status failed"); }
		// THE APPROVAL TRIGGER. An order placed while auto-push is off is created
		// Pending and the placement path deliberately printed nothing; this is the
		// transition that accepts it to the kitchen, so this is where its docket
		// comes out.
		//
		// GUARDED BY THE CONTENT MEMO, not by inspecting the previous status. Every
		// OTHER route into "Preparing" — a Served order corrected back, a re-open —
		// lands here too, and every one of them is an order that was already
		// ticketed, so AllocateKotNumber answers reused and skipIfTicketed prints
		// nothing. One rule covers the approval and every look-alike after it.
		let approvalPrint: Awaited<ReturnType<typeof autoPrintOrderKot>> | null = null;
		if (status.trim().toLowerCase() === "preparing") {
			approvalPrint = await autoPrintOrderKot({ restaurantId, orderId, where: "order_approved" });
		}
		// THE CANCELLATION SLIP. This transition is the commonest way food stops
		// being cooked and, until now, the kitchen was never told: the KDS card
		// vanishes and the docket stays on the rail, so the dish is cooked for a
		// table that has cancelled it. dispatchCancellationKot resolves the number
		// already on that paper and never mints one — see its header.
		//
		// AFTER the `result.changed` guard above, so re-cancelling an already
		// cancelled order (an offline retry, a double tap) prints nothing: the
		// early return has already answered.
		//
		// `previous_status` is passed because by now the row says Cancelled, and an
		// order cancelled while still PENDING was never ticketed — a slip for it
		// would be paper about an order the kitchen has never heard of.
		let cancelPrint: Awaited<ReturnType<typeof dispatchCancellationKot>> | null = null;
		if (isCancel) {
			cancelPrint = await dispatchCancellationKot({
				restaurantId, orderId, where: "order_cancelled",
				previousStatus: result.previous_status,
			});
		}
		res.json({
			success: true,
			...(approvalPrint
				? {
					kot_printed: approvalPrint.printed, kot_no: approvalPrint.kot_no, kot_tickets: approvalPrint.tickets,
					...(approvalPrint.reason ? { kot_skipped: approvalPrint.reason } : {}),
				}
				: {}),
			// Reported under their own names so a client can tell "the KOT printed"
			// from "the CANCELLATION printed" — they mean opposite things.
			...(cancelPrint
				? {
					cancel_kot_printed: cancelPrint.printed, cancel_kot_no: cancelPrint.kot_no, cancel_kot_tickets: cancelPrint.tickets,
					...(cancelPrint.reason ? { cancel_kot_skipped: cancelPrint.reason } : {}),
				}
				: {}),
			// A2 — DID THE REASON LAND? Reported rather than assumed, because the
			// ledger write is best-effort: a till that sent a reason and got
			// `void_reason_recorded: false` knows the audit line still carries it and
			// the void report will not, which is a fact somebody can act on. Absent
			// entirely when no reason was sent, so a shipped client that never sends
			// one reads the same body it always did.
			...(isCancel && cancelReason
				? {
					void_reason_recorded: voidRecord !== null,
					void_id: voidRecord?.id ?? null,
					void_stage: voidRecord?.stage ?? null,
				}
				: {}),
		});
	} catch (error: any) {
		if (isCancelNeedsSeniorError(error)) { await refuseTicketedCancel(req, res, error); return; }
		logger.error({ err: error }, "set_order_status_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to update order status") });
	}
});

// Add single item to existing order (adds to Preparing section and logs audit)
app.post('/orders/:id/items', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), idempotent(), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: 'Missing restaurantId' }); return; }
	const orderId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
	if (!orderId) { res.status(400).json({ error: 'Missing order id' }); return; }
	const item = req.body ?? {};
	try {
		// fetch existing order
		const existing = await GetOrders(restaurantId);
		const order = existing.find(o => o.id === orderId);
		if (!order) { res.status(404).json({ error: 'Order not found' }); return; }
		// CLIENT ITEM 6 — the same guard POST /orders applies, on the order's own
		// table: a line added here lands on the same printed bill.
		const guard = await refuseOrderOnPrintedBill(req, res, {
			restaurantId, tableName: String(order.table ?? ""), guest: false,
		});
		if (guard.refused) {return;}

		// build items_split if missing; clone to avoid mutating source
		const rawSplit = Array.isArray((order as any).items_split)
			? JSON.parse(JSON.stringify((order as any).items_split)) as any[]
			// Same legacy-order guard as the delete path: seed from the order's real
			// items so adding one never discards the ones already on the ticket.
			: [["Served", []], ["Preparing", Array.isArray((order as any).items) ? JSON.parse(JSON.stringify((order as any).items)) : []]];
		// normalize tuples: ensure each tuple is [label, array] and dedupe items across tuples (preserve first occurrence)
		const seenIds = new Set<string>();
		const normalizedSplit: any[] = [];
		for (const tup of rawSplit) {
			const label = String(tup?.[0] ?? "").trim() || "";
			const arr = Array.isArray(tup?.[1]) ? tup[1] : [];
			const filtered: any[] = [];
			for (const it of arr) {
				const id = String((it?.id) ?? "");
				if (!id) {continue;}
				if (seenIds.has(id)) {continue;}
				seenIds.add(id);
				filtered.push(it);
			}
			normalizedSplit.push([label, filtered]);
		}

		// ensure we have a Preparing tuple to add the new item into
		const preparingIndex = normalizedSplit.findIndex((t: any) => String(t?.[0] ?? "").toLowerCase().includes('prepar'));
		// The chosen price point (migration 039). This route builds its line field
		// by field, so an id the till sent would otherwise be dropped here and the
		// Half plate added to an existing order would bill — and print — at the
		// dish's full price, while the same dish added through POST /orders (which
		// passes the body straight to AddOrder) billed at the Half price. Only the
		// ID is carried; applyMenuPriceFloor below re-resolves it, sets the floor
		// from it and stamps the label. Omitted when absent.
		const itemVariationId = typeof item.variation_id === 'string' ? item.variation_id.trim().slice(0, 64) : '';
		const typedItem = { id: String(item.id ?? randomUUID()), name: String(item.name ?? 'Unknown'), quantity: Number(item.quantity ?? 1), price: Number(item.price ?? 0), orderedAt: String(item.orderedAt ?? new Date().toISOString()), note: item.note ?? null, ...(itemVariationId ? { variation_id: itemVariationId } : {}) };
		// SECURITY: same server-side re-pricing the create path applies — an added
		// line that resolves to a menu row is floored at the menu price so it can't
		// be rung in at 1. UpdateOrderItemsSplit then re-derives the order subtotal
		// from these prices. A genuinely off-menu line is kept as typed.
		const [newItem] = await applyMenuPriceFloor(restaurantId, [typedItem]);
		if (preparingIndex === -1) {
			normalizedSplit.push(["Preparing", [newItem]]);
		} else {
			normalizedSplit[preparingIndex][1] = normalizedSplit[preparingIndex][1] || [];
			normalizedSplit[preparingIndex][1].push(newItem);
		}

		const split = normalizedSplit;

		// The caller's actions travel with the write for the reason the delete path
		// below spells out. ADDING a line hands nothing back, so the write-off gate
		// inside UpdateOrderItemsSplit never engages here and this costs nothing —
		// but a client that sent a split which happened to DROP lines would be
		// judged, and judged with the right identity rather than with an empty one.
		await UpdateOrderItemsSplit(restaurantId, orderId, split, {
			actions: req.auth?.actions ?? [],
			closeBillPermission: PERM_CLOSE_BILL,
		});
		// Titled by the action's NAME in the audit log, so use the item-level action
		// ("Update Order - Add Food Item") rather than the generic "Add Orders".
		try { await log_audit(req, "d6bebeb5-111f-4371-b373-a99158116d71", `Added item ${newItem.id} to order ${orderId}`, Audit_log_category.Bill, { order_id: orderId, item: newItem }); } catch (err) { logger.warn({ err }, 'log_audit add-order-item failed'); }

		// THE ADDED LINE, AND NOTHING ELSE.
		//
		// The rest of this order is on the pass already — cooked, cooking, or in
		// some cases eaten. Re-printing the whole order because one line was added
		// asks the kitchen to make all of it a second time, and the restaurant eats
		// the cost. So the docket carries exactly the line that was just added.
		//
		// `scope` IS THE LINE ID AND IT IS LOAD-BEARING. The ticket key is the
		// content fingerprint, so two separate presses of "add a Gulab Jamun" on the
		// same table on the same day are byte-identical item sets: without a
		// discriminator the second hashes to the first one's key, comes back reused
		// and the kitchen is never told about the second sweet. The line id — a
		// fresh randomUUID per add — is what makes each one its own ticket with its
		// own number. And because each key is unique by construction, this is the
		// one automatic path that does NOT suppress on reused: there is nothing to
		// suppress, and suppressing would be the bug.
		//
		// A retry of this REQUEST is a different question, and idempotent() above
		// already answers it: the same key replays the stored response without
		// re-running the handler, so no second docket.
		// applyMenuPriceFloor is generic in its element type, so the label it stamps
		// on a variation line is not on the returned type. Read through one narrow
		// record view rather than an `any`, and carry the same four fields the
		// ticket key hashes: name, quantity, note and variation.
		const printedLine = newItem as unknown as Record<string, unknown>;
		const addedNote = typeof printedLine.note === "string" ? printedLine.note.trim() : "";
		const addedVariation = typeof printedLine.variation_name === "string" ? printedLine.variation_name.trim() : "";
		const printedItem = await autoPrintOrderKot({
			restaurantId, orderId, where: "order_item_added",
			only: [{
				name: String(printedLine.name ?? "Item"),
				quantity: Number(printedLine.quantity ?? 1),
				price: Number(printedLine.price ?? 0),
				...(addedNote ? { note: addedNote } : {}),
				...(addedVariation ? { variation: addedVariation } : {}),
			}],
			scope: String(printedLine.id ?? ""),
			skipIfTicketed: false,
		});

		res.status(201).json({
			success: true, item: newItem,
			kot_printed: printedItem.printed, kot_no: printedItem.kot_no, kot_tickets: printedItem.tickets,
			...(printedItem.reason ? { kot_skipped: printedItem.reason } : {}),
			...reprintNeededFields(guard),
		});
	} catch (err: any) {
		logger.error({ err }, 'add_order_item_failed');
		res.status(500).json({ error: String(err?.message ?? 'Unable to add item') });
	}
});

/*
	REMOVE ONE LINE FROM AN ORDER — and the sixth door, which is the worst of the
	six because it DEFEATS a gate this block had just built.

	THE HOLE. UpdateOrderItemsSplit re-prices an order to whatever lines remain,
	so stripping every line leaves subtotal 0 and total 0 WHILE THE ORDER STAYS
	ACTIVE. It is not a cancellation, so — unlike PATCH /orders/:id/status ->
	Cancelled, which is deliberately open to the floor precisely because it
	records a reason — it wrote NO "OrderVoids" row, carried NO reason, and never
	reached the void report. The release write-off preflight then computed 0 for
	the table and let the SAME waiter release it, with an audit line that read
	like an ordinary release of an empty table. This route is gated on 4ad474d4
	"Add Orders", which the core WAITER role holds.

	THE GATE DEPENDS ON WHAT IS HANDED BACK, NOT ON THE ROUTE. Taking off one
	mis-keyed line is ordinary floor work and stays instant for every waiter:
	a rule that makes correcting a wrong entry need a manager will be worked
	around, and a worked-around rule protects nothing. Taking off MOST of a
	table's value is the same act as discounting it to nothing and meets the same
	authority — PERM_CLOSE_BILL, via the SAME mayDiscountBill the discount and
	coupon doors answer to. The rule, the cumulative baseline and the refusal live
	in UpdateOrderItemsSplit; this handler supplies the identity and turns the
	tagged refusal into the 403 shape every other money gate in the codebase uses.

	AND THE REMOVAL IS NOW TRACEABLE. Every line that comes off writes an
	"OrderVoids" row (scope='item', migration 035 — which names this route as one
	of the two writes it exists to record and was never wired to it), carrying the
	dish, the quantity and the money. The audit line carries the same, instead of
	the bare uuid it used to carry: a manager reading the log can now see WHAT was
	taken off a bill and WHAT IT WAS WORTH.
*/
app.delete('/orders/:id/items/:itemId', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), idempotent(), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: 'Missing restaurantId' }); return; }
	const orderId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
	const itemId = typeof req.params.itemId === 'string' ? req.params.itemId.trim() : '';
	if (!orderId || !itemId) { res.status(400).json({ error: 'Missing order id or item id' }); return; }
	// RECORD WHAT YOU ARE GIVEN, exactly as PATCH /orders/:id/status does with the
	// cancel reason, and for the same stated reason: every till in the field today
	// is a shipped binary and none of them send a reason on THIS route yet. A 400
	// on a missing reason would mean a live floor cannot correct a mis-keyed line,
	// which is a service-stopping outage traded for a reporting improvement. So a
	// removal with a reason is ledgered with it, and one without is ledgered as
	// exactly that — see the void write below for why a placeholder is written
	// rather than the row being skipped.
	const removeBody = (req.body ?? {}) as Record<string, unknown>;
	const removeReason = typeof removeBody.reason === 'string' ? removeBody.reason.trim() : '';
	const removeKind = typeof removeBody.void_kind === 'string' ? removeBody.void_kind.trim() : '';
	try {
		const existing = await GetOrders(restaurantId);
		const order = existing.find(o => o.id === orderId);
		if (!order) { res.status(404).json({ error: 'Order not found' }); return; }

		// A legacy order (no items_split — 92 of 94 rows) must seed the skeleton
		// from its REAL items; starting from an empty one flattened the order to
		// zero items while leaving the bill total intact.
		const split = (order as any).items_split
			?? [["Served", []], ["Preparing", Array.isArray((order as any).items) ? (order as any).items : []]];
		// remove item from both sections
		// The removed LINE is kept, not just the fact that a line went: the
		// cancellation slip has to name the dish, and after the filter below there
		// is nowhere left to read it from.
		//
		// StoredOrderLine is a READ VIEW, not a schema. "Orders".food holds
		// free-form JSON written by four clients over three years, so every field
		// is `unknown` and every read below narrows it — the alternative is an
		// `any` that would let a number where a dish name belongs reach the printer
		// as "[object Object]".
		interface StoredOrderLine { id?: unknown; name?: unknown; quantity?: unknown; price?: unknown; note?: unknown; variation_name?: unknown; menu_id?: unknown; nc?: unknown }
		const asText = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
		let removed: StoredOrderLine | null = null;
		for (const tuple of split) {
			if (Array.isArray(tuple[1])) {
				const before = (tuple[1]).length;
				const hit = (tuple[1] as StoredOrderLine[]).find((it) => asText(it.id) === itemId) ?? null;
				tuple[1] = (tuple[1]).filter((it) => String(it.id) !== itemId);
				const after = (tuple[1] as any[]).length;
				if (after !== before) { removed = hit; break; }
			}
		}

		// READ BEFORE THE EDIT. A ticket key is a fingerprint of the item SET, so
		// the instant this line leaves the order the whole-order key no longer
		// hashes to the one its docket was minted under and the KOT number on the
		// pass becomes unresolvable. Read here, used after the write commits.
		// Best-effort: an unreadable context costs the slip, never the delete.
		const kotContext = removed ? await GetOrderKotContext(restaurantId, orderId).catch(() => null) : null;

		// WHAT THIS LINE IS WORTH, computed BEFORE the write because the write
		// destroys it. A comped line (migration 034) is worth nothing to the
		// restaurant — it was already given away by somebody holding
		// PERM_NON_CHARGEABLE and is already out of every figure the table is
		// judged by — so removing one hands nothing back, which is the same answer
		// the gate inside UpdateOrderItemsSplit reaches.
		const removedQty = Math.max(1, Number(removed?.quantity ?? 1) || 1);
		const removedUnit = Number(removed?.price ?? 0) || 0;
		const removedValue = removed && removed.nc !== true
			? Math.round(removedUnit * removedQty * 100) / 100
			: 0;
		const removedName = (removed && typeof removed.name === 'string' ? removed.name.trim() : '') || 'item';

		// THE IDENTITY TRAVELS WITH THE WRITE. The gate has to be sized against the
		// table's subtotal and the value already stripped off it, both of which are
		// read in the data layer, so the verdict is reached there and arrives here
		// as a tagged error — the same shape, and for the same reasons, as the
		// discount write-off refusal (discount_authority.ts's header). Passing the
		// actions rather than pre-checking here is what makes a stale client, a
		// deep link or a bare curl meet the same answer as the button.
		try {
			await UpdateOrderItemsSplit(restaurantId, orderId, split as any[], {
				actions: req.auth?.actions ?? [],
				closeBillPermission: PERM_CLOSE_BILL,
				// CLIENT ITEM 3 — a waiter-only login does not take a dish off a
				// ticket the kitchen holds; refused before anything is written, so
				// no void row and no CANCELLED slip follow.
				actor: actorOf(req),
			});
		} catch (e: unknown) {
			if (isCancelNeedsSeniorError(e)) { await refuseTicketedCancel(req, res, e); return; }
			if (isDiscountAuthorityError(e)) {
				// AUDITED EVEN THOUGH NOTHING HAPPENED, exactly as the refused release
				// is. An attempt to walk a table's value off the bill is precisely the
				// event a manager wants to see, and a refusal that leaves no trace is
				// indistinguishable from one that was never made. Best-effort: a failed
				// audit write must never turn a 403 into a 500.
				try {
					await log_audit(
						req, "371ecf9f-303e-4114-92fb-3a5120d1565e",
						`REFUSED removal of ${String(removedQty)}x ${removedName} (${removedValue.toFixed(2)}) from order ${orderId} — would have written off ${e.discount_amount.toFixed(2)}, leaving ${e.remaining_value.toFixed(2)}, without Close Bill`,
						Audit_log_category.Bill,
						{
							order_id: orderId, deleted_item_id: itemId, item_name: removedName,
							quantity: removedQty, unit_price: removedUnit, value_removed: removedValue,
							refused: true, discount_amount: e.discount_amount, remaining_value: e.remaining_value,
						},
					);
				} catch (err) { logger.warn({ err }, 'log_audit delete-order-item refusal failed'); }
				res.status(403).json({
					error: "Forbidden",
					details: e.details,
					requiredPermission: e.requiredPermission,
					// Named for what they are on THIS route: the money this removal (with
					// everything already stripped off the table) hands back, and what
					// would still be on the bill afterwards.
					value_removed: removedValue,
					write_off_value: e.discount_amount,
					remaining_value: e.remaining_value,
				});
				return;
			}
			throw e;
		}

		// THE LEDGER ROW — "OrderVoids", scope='item' (migration 035). Without it a
		// line could leave a live bill and appear in no report at all: the void
		// report, the stage derivation (the fraud signal, which the SERVER derives
		// because the person whose void it is has an obvious interest in it reading
		// "before_print") and the money figure all already existed and this route
		// simply never wrote to them.
		//
		// A PLACEHOLDER REASON IS WRITTEN RATHER THAN THE ROW BEING SKIPPED. 035
		// requires a non-empty reason, and no shipped till sends one here yet; a
		// row that says plainly that none was given is honest, and it is strictly
		// better than the alternative on offer, which is that the worst of the six
		// doors keeps leaving no trace at all. `void_kind` defaults to 'other'
		// because the clients send free text and 035's CHECK accepts only its seven
		// values — rejecting a real reason for want of a category would discard the
		// thing this is here to keep.
		//
		// AFTER THE FACT AND BEST-EFFORT, for the reason the cancel path states: the
		// line is already gone by the time this runs, and a ledger write that throws
		// (035 unapplied on this deployment, a constraint, a dead connection) must
		// not turn a completed removal into a 500 the till will retry. `value_voided`
		// is passed explicitly BECAUSE the line no longer exists to be read.
		let voidRecord: Awaited<ReturnType<typeof RecordOrderVoid>> | null = null;
		if (removed) {
			try {
				voidRecord = await RecordOrderVoid(restaurantId, {
					order_id: orderId,
					scope: "item",
					item_id: itemId,
					item_name: removedName,
					void_kind: removeKind.length > 0 ? removeKind : "other",
					reason: removeReason.length > 0 ? removeReason : "Line removed from order (no reason given)",
					value_voided: removedValue,
					actor: {
						employee_id: extractEmployeeId(req),
						username: extractEmployeeUsername(req) ?? extractEmployeeId(req) ?? "unknown",
						// SELF-AUTHORISED, AND THE ROW SAYS SO — the same honest shape the
						// everyday cancel records. An auditor reading voided_by =
						// authorised_by can see at a glance that nobody countersigned.
						authorised_by_employee_id: extractEmployeeId(req),
						authorised_by_username: extractEmployeeUsername(req) ?? extractEmployeeId(req) ?? "unknown",
					},
				});
			} catch (e) { logger.error({ err: e, order_id: orderId, item_id: itemId }, "record_item_void_failed"); }
		}

		// THE AUDIT LINE NAMES THE DISH AND THE MONEY. It used to read "Deleted item
		// <uuid> from order <uuid>" — no dish, no price, no money — which is a line
		// nobody can act on. The audit log is what a manager reads at the end of a
		// service, and a fact that is only reachable by joining two uuids to a JSON
		// column is a fact nobody reads.
		try {
			const reasonNote = removeReason ? ` — reason: ${removeReason}` : "";
			await log_audit(
				req, "371ecf9f-303e-4114-92fb-3a5120d1565e",
				`Removed ${String(removedQty)}x ${removedName} (${removedValue.toFixed(2)}) from order ${orderId}${order.table ? ` on table ${order.table}` : ""}${reasonNote}`,
				Audit_log_category.Bill,
				{
					order_id: orderId, deleted_item_id: itemId, item_name: removedName,
					quantity: removedQty, unit_price: removedUnit, value_removed: removedValue,
					table: order.table,
					...(removeReason ? { reason: removeReason } : {}),
					void_id: voidRecord?.id ?? null,
					void_kind: voidRecord?.void_kind ?? (removeKind.length > 0 ? removeKind : "other"),
					void_stage: voidRecord?.stage ?? null,
					void_recorded: voidRecord !== null,
				},
			);
		} catch (err) { logger.warn({ err }, 'log_audit delete-order-item failed'); }

		// THE CANCELLATION SLIP FOR ONE LINE. This route is how a waiter takes a
		// single dish off an order that is already on the pass, and it printed
		// nothing — so the line stayed on the kitchen's docket and was cooked.
		//
		// THE FOUR FIELDS THE TICKET KEY HASHES — name, quantity, note, variation —
		// are built here the SAME way POST /orders/:id/items builds them, down to
		// the trim, because the docket this slip cancels may well be that route's
		// added-line ticket, scoped by this very item id. Anything spelled
		// differently would miss that ticket and the slip would print unnumbered.
		// (price and menu_id are not part of the key: price is never printed on a
		// KOT, and menu_id rides along so a since-renamed dish still routes to the
		// station cooking it.)
		let cancelPrint: Awaited<ReturnType<typeof dispatchCancellationKot>> | null = null;
		if (removed) {
			const removedNote = asText(removed.note);
			const removedVariation = asText(removed.variation_name);
			const removedMenuId = asText(removed.menu_id);
			const line: KotLine = {
				name: typeof removed.name === "string" ? removed.name : "Item",
				quantity: Number(removed.quantity ?? 1),
				price: Number(removed.price ?? 0),
				...(removedNote ? { note: removedNote } : {}),
				...(removedVariation ? { variation: removedVariation } : {}),
				...(removedMenuId ? { menu_id: removedMenuId } : {}),
			};
			cancelPrint = await dispatchCancellationKot({
				restaurantId, orderId, where: "order_item_removed",
				order: kotContext, only: [line], itemId,
			});
		}

		res.json({
			success: true,
			...(cancelPrint
				? {
					cancel_kot_printed: cancelPrint.printed, cancel_kot_no: cancelPrint.kot_no, cancel_kot_tickets: cancelPrint.tickets,
					...(cancelPrint.reason ? { cancel_kot_skipped: cancelPrint.reason } : {}),
				}
				: {}),
			// ADDITIVE, and reported rather than assumed: the ledger write is
			// best-effort, so a till that gets `void_recorded: false` knows the audit
			// line still carries the removal and the void report will not — which is a
			// fact somebody can act on. Present only when a line actually went, so a
			// request for an id that was not on the order reads exactly as it did.
			...(removed
				? {
					value_removed: removedValue,
					void_recorded: voidRecord !== null,
					void_id: voidRecord?.id ?? null,
					void_stage: voidRecord?.stage ?? null,
				}
				: {}),
		});
	} catch (err: any) {
		logger.error({ err }, 'delete_order_item_failed');
		res.status(500).json({ error: String(err?.message ?? 'Unable to delete item') });
	}
});

app.delete("/orders/:id", validateAction(PERM_ORDER_DELETE), idempotent(), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const orderId = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!orderId) {
		res.status(400).json({ error: "Invalid order id" });
		return;
	}

	try {
		// READ BEFORE THE DELETE, because the delete DESTROYS the row this reads.
		// This is the one cancellation path with no "after" to work from: the
		// items, the table, the covers and the approval state all cease to exist
		// the moment DeleteOrder returns, so the slip is built from facts captured
		// here. Best-effort — an unreadable order costs the slip, not the delete.
		const kotContext = await GetOrderKotContext(restaurantId, orderId).catch(() => null);
		const deleted = await DeleteOrder(restaurantId, orderId);
		if (!deleted) {
			res.status(404).json({ error: "Order not found" });
			return;
		}
		// Permanent deletion had no audit trail at all — the single most
		// destructive order operation was invisible after the fact.
		try {
			await log_audit(req, PERM_ORDER_DELETE, `Deleted order ${orderId}`,
				Audit_log_category.Orders, { order_id: orderId });
		} catch (err) { logger.warn({ err }, "log_audit order-delete failed"); }
		// THE CANCELLATION SLIP. A deleted order is the most complete way food
		// stops being cooked — the row itself is gone — and it was the quietest:
		// nothing on the pass changed, so the kitchen cooked an order that no
		// longer exists anywhere in the system.
		//
		// The RESPONSE STAYS 204. A no-content contract is what both clients parse,
		// and a printer outcome is not worth reshaping it over; the outcome is in
		// the kot_dispatched log line, which is where every other automatic docket
		// is accounted for.
		await dispatchCancellationKot({
			restaurantId, orderId, where: "order_deleted",
			order: kotContext, reason: "order deleted",
		});
		res.status(204).send();
	} catch (error: any) {
		logger.error({ err: error }, "delete_order_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to delete order") });
	}
});
}


export function registerOrderTimingRoutes(app: Express): void {
app.post("/orders/:id/pause", validateAction(ORDER_ACTION), idempotent(), (req, res) => handleTiming(req, res, "pause", false));
app.post("/orders/:id/resume", validateAction(ORDER_ACTION), idempotent(), (req, res) => handleTiming(req, res, "resume", false));
// The tick is a TOGGLE: tapping a served item again un-serves it (a mis-tap is
// otherwise unrecoverable). Explicit `?undo=1` / {undo:true} forces the undo.
// Un-serving is refused once the whole order is Served — see OrderTimingAction.
app.post("/orders/:id/items/:itemId/serve", validateAction(ORDER_ACTION), idempotent(), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	const orderId = String(req.params.id ?? "").trim();
	const itemId = String(req.params.itemId ?? "").trim();
	let action: "serve" | "unserve" = "serve";
	// See order_intent.ts: the caller may state intent, and the state-derived
	// toggle is only the fallback. An offline-queued serve replayed after
	// someone else served the item must stay a serve, not flip to an un-serve.
	const intent = resolveServeIntent(req.query, req.body);
	if (intent === "unserve") {
		action = "unserve";
	} else if (intent === "toggle" && restaurantId && orderId && itemId) {
		// Already served? then this tap means "undo".
		try {
			const served = await IsOrderItemServed(restaurantId, orderId, itemId);
			if (served) {action = "unserve";}
		} catch { /* fall through as a normal serve */ }
	}
	return handleTiming(req, res, action, true);
});
app.post("/orders/:id/items/:itemId/unserve", validateAction(ORDER_ACTION), idempotent(), (req, res) => handleTiming(req, res, "unserve", true));
app.post("/orders/:id/items/:itemId/pause", validateAction(ORDER_ACTION), idempotent(), (req, res) => handleTiming(req, res, "pause", true));
app.post("/orders/:id/items/:itemId/resume", validateAction(ORDER_ACTION), idempotent(), (req, res) => handleTiming(req, res, "resume", true));

// Fire held course items (hold-and-fire): stamps fired_at, clears course_hold
// and starts their prep timers. Staff-level (same permission as other order ops).
app.post("/orders/:id/fire", validateAction(ORDER_ACTION), idempotent(), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const orderId = String(req.params.id ?? "").trim();
	const body = (req.body ?? {}) as Record<string, unknown>;
	const itemIds = Array.isArray(body.item_ids) ? body.item_ids.map((i) => String(i)) : [];
	if (!orderId || itemIds.length === 0) { res.status(400).json({ error: "order id and item_ids are required" }); return; }
	try {
		const result = await FireOrderItems(restaurantId, orderId, itemIds);
		try { await log_audit(req, FIRE_COURSE_ACTION_ID, `Fired ${result.fired.length} held item(s) on order ${orderId}`, Audit_log_category.Orders, { order_id: orderId, item_ids: result.fired }); } catch {/* ignore */}
		try { emitRestaurant(restaurantId, "order:updated", { order_id: orderId, fired: result.fired }); } catch {/* ignore */}
		res.json({ success: true, fired: result.fired });
	} catch (err: any) {
		logger.error({ err }, "fire_course_failed");
		res.status(400).json({ error: String(err?.message ?? "Unable to fire items") });
	}
});

// Bark an order: the expo announces it to the kitchen — the visible step
// between acceptance and cooking. Stamps barked_at (+ who) and (re)bases the
// order/dish prep timers so kitchen time counts from the bark.
app.post("/orders/:id/bark", validateAction(PERM_BARK), idempotent(), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const orderId = String(req.params.id ?? "").trim();
	if (!orderId) { res.status(400).json({ error: "order id is required" }); return; }
	try {
		const result = await BarkOrder(restaurantId, orderId, extractEmployeeId(req));
		// BARK IS NOW THE SAFETY NET, NOT THE TRIGGER. The order was ticketed when
		// it was placed (or approved), so this call normally finds the content
		// already memoised and prints nothing — reporting "already_printed" and
		// the number that is on the paper. It puts a docket out only for an order
		// those paths never ticketed: auto-print switched off at the time and
		// switched on since, or a placement print that failed before it could
		// allocate a number.
		//
		// Two independent interlocks stop it becoming a second ticket, and both
		// still hold. already_barked is BarkOrder's compare-and-set, which stops a
		// re-announcement ever reaching the printer at all; skipIfTicketed (the
		// default inside autoPrintOrderKot) is the content memo, which holds even
		// when two replicas race the first bark or an offline outbox replay
		// arrives carrying a fresh idempotency key. A deliberate second copy is
		// what POST /print/kot/order/:id is for, and that route is a true reprint
		// (same key, same number, same bytes).
		const printed = result.already_barked
			? { printed: false, kot_no: null, tickets: 0, reason: "already_barked" }
			: await autoPrintOrderKot({ restaurantId, orderId, where: "order_barked" });
		if (!result.already_barked) {
			try { await log_audit(req, BARK_ORDER_ACTION_ID, `Barked order ${orderId} to the kitchen${printed.kot_no ? ` (KOT-${printed.kot_no})` : ""}`, Audit_log_category.Orders, { order_id: orderId, barked_at: result.barked_at, kot_no: printed.kot_no, auto_printed: printed.printed }); } catch {/* ignore */}
			try { emitRestaurant(restaurantId, "order:updated", { order_id: orderId, barked: true }); } catch {/* ignore */}
		}
		// The print outcome rides the bark response so the app can say "sent to
		// the kitchen, KOT-26" or "barked, but the docket did not print" instead
		// of a bare tick that means one of two very different things.
		res.json({
			success: true, barked_at: result.barked_at, already_barked: result.already_barked,
			kot_printed: printed.printed, kot_no: printed.kot_no, kot_tickets: printed.tickets,
			...(printed.reason ? { kot_skipped: printed.reason } : {}),
		});
	} catch (err: any) {
		logger.error({ err }, "bark_order_failed");
		res.status(400).json({ error: String(err?.message ?? "Unable to bark order") });
	}
});
}
