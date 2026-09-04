/**
 * Orders: listing, creation (dine-in/takeaway), item edits, status, deletion and the
 * kitchen timing actions (pause/resume/serve/fire/bark).
 */
import type { Express, Request, Response } from "express";
import { randomUUID } from "crypto";
import { AddOrder, AddTakeawayOrder, Audit_log_category, BARK_ORDER_ACTION_ID, BarkOrder, DeleteOrder, FIRE_COURSE_ACTION_ID, FireOrderItems, GetOrders, GetOrdersScope, IsOrderItemServed, OrderTimingAction, SetOrderStatus, UpdateOrderItemsSplit, applyMenuPriceFloor } from "../database_supabase.js";
import { idempotent } from "../idempotency.js";
import { resolveServeIntent } from "../order_intent.js";
import { logger } from "../observability.js";
import { emitRestaurant } from "../realtime.js";
import type { CreatedOrderInfo } from "./_shared.js";
import { PERM_CLOSE_BILL, PERM_ORDER_DELETE, emitOrderCreated, enforcePermission, extractEmployeeId, extractRestaurantId, linkOrderToCustomer, log_audit, notifyOrderCreated, optionalMobile10, validateAction } from "./_shared.js";


// --- Order/item preparation timers (pause/resume, mark item served) ---------
const ORDER_ACTION = "4ad474d4-5230-449c-874f-6a238b833bca";
// Barking pushes a ticket to the kitchen — a different job from taking the order.
// It used to share "Add Orders", which every waiter needs, so waiters could bark.
const PERM_BARK = "3f6a9c1e-8d24-4b7a-b5c9-2e1f7d4a8b63"; // Bark Order
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
		res.json(items);
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

	try {
		const body: Record<string, unknown> = { ...orderBody, ...(orderPhone.value ? { customer_phone: orderPhone.value } : {}) };
		const result = await AddOrder(restaurantId, body);
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
		res.status(201).json(result);
	} catch (error: any) {
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
		res.status(201).json(result);
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
// does today: still gated on PERM_CLOSE_BILL below, still refused by
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
	const settles = ["paid", "closed"].includes(status.toLowerCase());
	if (settles && !(await enforcePermission(req, res, PERM_CLOSE_BILL))) {return;}
	try {
		const result = await SetOrderStatus(restaurantId, orderId, status);
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
		try {
			await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Order ${orderId} -> ${status}`, Audit_log_category.Orders, { order_id: orderId, status, ...undoEnvelope });
		} catch (e) { logger.warn({ err: e }, "log_audit order status failed"); }
		res.json({ success: true });
	} catch (error: any) {
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

		await UpdateOrderItemsSplit(restaurantId, orderId, split);
		// Titled by the action's NAME in the audit log, so use the item-level action
		// ("Update Order - Add Food Item") rather than the generic "Add Orders".
		try { await log_audit(req, "d6bebeb5-111f-4371-b373-a99158116d71", `Added item ${newItem.id} to order ${orderId}`, Audit_log_category.Bill, { order_id: orderId, item: newItem }); } catch (err) { logger.warn({ err }, 'log_audit add-order-item failed'); }

		res.status(201).json({ success: true, item: newItem });
	} catch (err: any) {
		logger.error({ err }, 'add_order_item_failed');
		res.status(500).json({ error: String(err?.message ?? 'Unable to add item') });
	}
});

// Delete single item from order
app.delete('/orders/:id/items/:itemId', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), idempotent(), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: 'Missing restaurantId' }); return; }
	const orderId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
	const itemId = typeof req.params.itemId === 'string' ? req.params.itemId.trim() : '';
	if (!orderId || !itemId) { res.status(400).json({ error: 'Missing order id or item id' }); return; }
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
		for (const tuple of split) {
			if (Array.isArray(tuple[1])) {
				const before = (tuple[1]).length;
				tuple[1] = (tuple[1]).filter((it) => String(it.id) !== itemId);
				const after = (tuple[1] as any[]).length;
				if (after !== before) {break;}
			}
		}

		await UpdateOrderItemsSplit(restaurantId, orderId, split as any[]);
		try { await log_audit(req, "371ecf9f-303e-4114-92fb-3a5120d1565e", `Deleted item ${itemId} from order ${orderId}`, Audit_log_category.Bill, { order_id: orderId, deleted_item_id: itemId }); } catch (err) { logger.warn({ err }, 'log_audit delete-order-item failed'); }

		res.json({ success: true });
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
		if (!result.already_barked) {
			try { await log_audit(req, BARK_ORDER_ACTION_ID, `Barked order ${orderId} to the kitchen`, Audit_log_category.Orders, { order_id: orderId, barked_at: result.barked_at }); } catch {/* ignore */}
			try { emitRestaurant(restaurantId, "order:updated", { order_id: orderId, barked: true }); } catch {/* ignore */}
		}
		res.json({ success: true, barked_at: result.barked_at, already_barked: result.already_barked });
	} catch (err: any) {
		logger.error({ err }, "bark_order_failed");
		res.status(400).json({ error: String(err?.message ?? "Unable to bark order") });
	}
});
}
