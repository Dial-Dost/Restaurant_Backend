/**
 * CLIENT ITEM 4 (2026-09-17) — "Right now there are no item names visible when
 * an order is moved from one table to another. This needs to be visible and
 * implemented correctly."
 *
 * "MOVED" IS THREE DIFFERENT WRITES, and GGV used all three on 2026-09-14:
 *
 *   * MOVE AN ORDER (POST /tables/move-order, MoveOrderToTable) — one ticket to
 *     another table. The kitchen docket already named every dish; nothing else
 *     did. The picker read "3 items · ₹1427.00", the audit line read "Moved
 *     order 5a4099ef-… from 12 to 15", and nothing on the moved order said where
 *     it had come from.
 *   * MOVE THE PARTY (POST /tables/move, MoveTableParty) — audited as counts.
 *   * MOVE ONE DISH (POST /bills/move-item, MoveBillItem) — the worst of the
 *     three. The source ticket was left as "Cancelled · 0 item(s)" with no word
 *     of what left it, and the dish arrived as a fresh "Moved item" order with
 *     no KOT number, no variation, no note, no hold and — for a comped dish —
 *     no comp, so the destination was charged for food the NC ledger says was
 *     given away.
 *
 * This file is the vocabulary those writes share: what is stamped on an order
 * when it moves, what GET /orders hands a client about it, and the sentences
 * the audit trail carries. PURE, so every rule here is testable without a
 * database; the writers in database_supabase.ts and the routes call it.
 *
 * NO PRICES LEAVE THROUGH THE READ SIDE. `orderMoveProvenance` projects names,
 * sizes and quantities only, so a waiter-only session (whose GET /orders is
 * redacted by price_scope.ts) is handed nothing that needs redacting.
 *
 * NOTHING IS BACK-FILLED. An order moved before this shipped carries none of
 * these keys and reads exactly as it did.
 */
import { isNonChargeableLine } from "./billing_math.js";
import { voidItemsText, voidLineIdentity, type VoidKotLine } from "./mis_report_math.js";

/** "Orders".food key: every whole-order move, oldest first. */
export const ORDER_MOVES_KEY = "moves";

/** "Orders".food key on an order a dish move CREATED: where its food came from. */
export const MOVED_FROM_KEY = "moved_from";

/** One whole-order move, as stamped by MoveOrderToTable. */
export interface OrderMoveEntry {
	from_table: string;
	to_table: string;
	/** ISO instant of the move. */
	at: string;
	/** Who pressed it (username), when the route knew. */
	by: string | null;
}

/** Where a dish-move order's food came from. */
export interface MovedFromRecord {
	table: string;
	order_id: string;
	/** The ticket(s) the food was cooked under at the source. */
	kot_nos: number[];
	at: string;
	by: string | null;
}

/** One dish as a move names it: never a price. */
export type MovedDish = Pick<VoidKotLine, "name" | "variation" | "quantity">;

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function asRecord(v: unknown): Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * The stored lines of an order, read the way GET /orders reads them: the split
 * flattened when there is a non-empty one, else `items` (a legacy tuple-shaped
 * `items` flattened too).
 */
export function storedLinesOf(food: Readonly<Record<string, unknown>>): Record<string, unknown>[] {
	const flatten = (list: unknown[]): unknown[] => list.flatMap((t) => (Array.isArray(t) && Array.isArray(t[1]) ? (t[1] as unknown[]) : []));
	const split = food.items_split;
	if (Array.isArray(split) && split.length > 0) { return flatten(split).map(asRecord); }
	const items = Array.isArray(food.items) ? (food.items as unknown[]) : [];
	const first: unknown = items[0];
	const tupleShaped = Array.isArray(first) && typeof first[0] === "string" && Array.isArray(first[1]);
	return (tupleShaped ? flatten(items) : items).map(asRecord);
}

/** A stored line as a move names it: `Biryani (Half)` and a whole quantity. */
export function movedDish(line: unknown): MovedDish {
	const { name, variation } = voidLineIdentity(line);
	const q = Math.round(Number(asRecord(line).quantity ?? 1));
	return { name, variation, quantity: Number.isFinite(q) && q >= 1 ? q : 1 };
}

/** Every dish on an order, in the order the ticket lists them. */
export function orderDishes(food: Readonly<Record<string, unknown>>): MovedDish[] {
	return storedLinesOf(food).map(movedDish);
}

/**
 * The food after MoveOrderToTable: the printed table name follows the order,
 * and the move is appended to its history. Never drops a key the blob carries.
 */
export function appendOrderMove(
	food: Readonly<Record<string, unknown>>,
	entry: OrderMoveEntry,
): Record<string, unknown> {
	const prior = Array.isArray(food[ORDER_MOVES_KEY]) ? (food[ORDER_MOVES_KEY] as unknown[]) : [];
	return { ...food, table: entry.to_table, [ORDER_MOVES_KEY]: [...prior, { ...entry }] };
}

/** What GET /orders adds to an order that has moved, or had dishes moved off it. */
export interface OrderMoveProvenance {
	/** The table the order (or its food) came from. */
	moved_from?: string;
	moved_at?: string;
	/** Which writer emptied a cancelled ticket — "move" or "remove". */
	emptied_by?: string;
	/** The dishes a dish move took OFF this order, and where each went. */
	moved_items?: { name: string; variation: string | null; quantity: number; to_table: string; moved_at: string | null }[];
}

/**
 * The provenance block, read off the stored food. Absent keys stay absent, so
 * an order that never moved gains nothing on the wire.
 *
 * THE LATEST MOVE WINS when an order carries both histories (a dish-move order
 * later moved as a whole): the question a screen asks is "where did this
 * ticket last come from".
 */
export function orderMoveProvenance(food: Readonly<Record<string, unknown>>): OrderMoveProvenance {
	const out: OrderMoveProvenance = {};
	const candidates: { from: string; at: string }[] = [];
	const moves = Array.isArray(food[ORDER_MOVES_KEY]) ? (food[ORDER_MOVES_KEY] as unknown[]) : [];
	const lastMove = moves.length > 0 ? asRecord(moves[moves.length - 1]) : null;
	if (lastMove && text(lastMove.from_table)) {
		candidates.push({ from: text(lastMove.from_table), at: text(lastMove.at) });
	}
	const movedFrom = asRecord(food[MOVED_FROM_KEY]);
	if (text(movedFrom.table)) {
		candidates.push({ from: text(movedFrom.table), at: text(movedFrom.at) });
	}
	if (candidates.length > 0) {
		const latest = candidates.reduce((a, b) => (b.at > a.at ? b : a));
		out.moved_from = latest.from;
		if (latest.at) { out.moved_at = latest.at; }
	}
	const emptiedBy = text(food.emptied_by);
	if (emptiedBy) { out.emptied_by = emptiedBy; }
	const movedItems = Array.isArray(food.moved_items) ? (food.moved_items as unknown[]) : [];
	if (movedItems.length > 0) {
		out.moved_items = movedItems.map((raw) => {
			const line = asRecord(raw);
			return {
				...movedDish(line),
				to_table: text(line.to_table),
				moved_at: text(line.moved_at) || null,
			};
		});
	}
	return out;
}

/** "KOT-65" / "KOT-65, KOT-66" / "" — the handle the pass quotes. */
export function kotHandles(kotNos: readonly number[]): string {
	const nos = [...new Set(kotNos.filter((n) => Number.isFinite(n) && n > 0).map((n) => Math.round(n)))];
	return nos.map((n) => `KOT-${String(n)}`).join(", ");
}

/** Why a correction docket did not print, in the audit line's words. */
function noCorrectionWhy(reason: string | null | undefined): string {
	switch ((reason ?? "").trim()) {
		case "never_ticketed": return "no docket was on the pass";
		case "disabled": return "automatic dockets are off";
		case "": return "no correction docket printed";
		default: return "the correction docket did not print";
	}
}

/**
 * THE MOVE-ORDER AUDIT LINE, naming the ticket and its dishes:
 *
 *   Moved KOT-65 (KUNAFA BIRDS NEST x1; STIR FRIED WATERCHESTNUT x1) from 12 to 15 (correction docket printed)
 *   Moved order (Dal x2) from 12 to 15 (no docket was on the pass)
 *
 * `x` and `; ` are voidItemsText's, so a manager reads a moved ticket the way
 * the Void KOT sheet names a cancelled one. It starts "Moved KOT" / "Moved
 * order", which is what classifyBillEdit keys "order_moved" on.
 */
export function moveOrderAuditSentence(input: {
	kotNos: readonly number[];
	dishes: readonly MovedDish[];
	fromTable: string;
	toTable: string;
	printed: boolean;
	printReason?: string | null;
}): string {
	const handle = kotHandles(input.kotNos) || "order";
	const dishes = voidItemsText(input.dishes);
	const what = dishes ? `${handle} (${dishes})` : handle;
	const docket = input.printed ? "correction docket printed" : noCorrectionWhy(input.printReason);
	return `Moved ${what} from ${input.fromTable} to ${input.toTable} (${docket})`;
}

/**
 * THE MOVE-ITEM AUDIT LINE:
 *
 *   Moved item NOT YOUR PUCHKA x1 from 31A (KOT-35) to 31
 *
 * Keeps the "Moved item " prefix classifyBillEdit has always keyed
 * "item_moved" on.
 */
export function moveItemAuditSentence(input: {
	dishes: readonly MovedDish[];
	fallbackName: string;
	fromTable: string;
	toTable: string;
	kotNos: readonly number[];
}): string {
	const dishes = voidItemsText(input.dishes) ?? input.fallbackName;
	const kots = kotHandles(input.kotNos);
	return `Moved item ${dishes} from ${input.fromTable}${kots ? ` (${kots})` : ""} to ${input.toTable}`;
}

/**
 * A COMPED DISH IS NOT MOVED — client decision, 2026-09-17.
 *
 * Moving it would either charge the destination for food the NC ledger records
 * as given away (what the rebuild used to do) or carry an NC flag whose ledger
 * row still names the source order. The comp is reversed first, by somebody who
 * holds the comp permission, and then the dish moves as the chargeable line it
 * has become.
 */
export function comppedMoveRefusal(itemName: string, fromTable: string): string {
	return `${itemName} is non-chargeable on ${fromTable}. Reverse the comp first, then move it.`;
}

/** Does this set of matched lines hold a comped one? */
export function holdsComppedLine(lines: readonly unknown[]): boolean {
	return lines.some((l) => isNonChargeableLine(asRecord(l) as { nc?: unknown }));
}

/**
 * The keys a whole line keeps when a dish move carries it to another table —
 * everything the kitchen and the bill read — less the ones that belong to the
 * SOURCE order's own history (a timer, a stamp of a removal).
 */
const LINE_KEYS_LEFT_BEHIND = ["removed_at", "moved_at", "to_table", "to_order_id"];

export function carriedLine(line: Readonly<Record<string, unknown>>, price: number, quantity: number): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(line)) {
		if (LINE_KEYS_LEFT_BEHIND.includes(k)) { continue; }
		out[k] = v;
	}
	out.price = price;
	out.quantity = quantity;
	return out;
}

/**
 * The status a dish-move order starts in: the SOURCE ticket's, where it is one
 * the food can honestly be in. Served food stays served; a Pending ticket stays
 * Pending (the kitchen was never told about it); anything else is being cooked.
 */
export function movedOrderStatusCode(sourceStatusCode: unknown): number {
	const code = Math.round(Number(sourceStatusCode ?? 1));
	if (code === 2) { return 2; }
	if (code === 8) { return 8; }
	return 1;
}

/**
 * THE ORDER A DISH MOVE CREATES on the destination table, for ONE source order.
 *
 * The lines arrive whole (`carriedLine`), so a "(Half)" is still a half, a note
 * still reaches the pass, and a held course stays held. The customer is the
 * destination's "Guest" (the old "Moved item" was never a person), the
 * source's order-taker and channel come across, and `moved_from` names the
 * table, the order and the ticket the food was cooked under.
 */
export function movedDestinationFood(input: {
	orderId: string;
	toTable: string;
	lines: readonly Record<string, unknown>[];
	source: Readonly<Record<string, unknown>>;
	statusLabel: string;
	movedFrom: MovedFromRecord;
	/** When the source order had a Served/Preparing split: the label each carried line sat under. */
	splitLabelOf?: ((line: Readonly<Record<string, unknown>>) => string | null) | null;
}): Record<string, unknown> {
	const subtotal = Math.round(input.lines.reduce((sum, l) => (isNonChargeableLine(l as { nc?: unknown })
		? sum
		: sum + (Number(l.price) || 0) * (Number(l.quantity) || 0)), 0) * 100) / 100;
	const src = input.source;
	const food: Record<string, unknown> = {
		id: input.orderId,
		table: input.toTable,
		customer: "Guest",
		taken_by_employee_id: text(src.taken_by_employee_id) || null,
		taken_by_employee_name: text(src.taken_by_employee_name) || null,
		taken_by_employee_role: text(src.taken_by_employee_role) || null,
		items: input.lines.map((l) => ({ ...l })),
		subtotal,
		total: subtotal,
		taxes: [],
		applyServiceCharge: false,
		status: input.statusLabel,
		order_type: text(src.order_type) || "dine_in",
		// The order-level note travels with the food it may be about — an allergy
		// written against the source ticket must not stay behind at a table that
		// no longer has the dish.
		note: text(src.note) || null,
		[MOVED_FROM_KEY]: { ...input.movedFrom, kot_nos: [...input.movedFrom.kot_nos] },
	};
	if (input.splitLabelOf) {
		const served: Record<string, unknown>[] = [];
		const preparing: Record<string, unknown>[] = [];
		for (const l of input.lines) {
			(String(input.splitLabelOf(l) ?? "").toLowerCase().includes("serv") ? served : preparing).push({ ...l });
		}
		food.items_split = [["Served", served], ["Preparing", preparing]];
	}
	return food;
}

/**
 * The KOT numbers GET /orders shows for an order: the printed ones, else the
 * ones a dish move recorded it was cooked under. An order moved while dockets
 * were off (or whose correction failed to print) still reads "KOT 35" rather
 * than "No KOT number" — it is the same food, and 35 is what the pass called it.
 */
export function movedFromKotNos(food: Readonly<Record<string, unknown>>): number[] {
	const raw = asRecord(food[MOVED_FROM_KEY]).kot_nos;
	if (!Array.isArray(raw)) { return []; }
	return [...new Set(raw.map(Number).filter((n) => Number.isFinite(n) && n > 0).map((n) => Math.round(n)))];
}

// ---------------------------------------------------------------------------
// WHEN AN ORDER ARRIVED ON ITS TABLE — the settled-bill window's clock.
// ---------------------------------------------------------------------------

/**
 * "Orders".food key: the instant this order landed on the table it is on now,
 * stamped by the database (`now()`) by every door that changes an order's
 * table_id: MoveTableParty, MoveOrderToTable and MergeTableBills. Absent on an
 * order that never changed table, which arrived when it was created.
 *
 * THE DEFECT THIS ENDS. A settled bill's orders are found by time: everything
 * settled on its table after the PREVIOUS bill there closed, up to this one's
 * close (ReopenBill, GetClosedBill, the History list). The three doors change
 * table_id and keep created_at, so an order placed at 15 before 14's party paid,
 * then moved to 14, sat inside 14's PREVIOUS bill's window. Production GGV bill
 * #3 (2120.58) reconstructed as 3891 with the moved party's 2055 on it, and the
 * moved party's own #14 (3421.10) as 907. A re-open of #3 would have put an
 * order the guest had already paid back on it. The window is therefore read on
 * the arrival, not the creation.
 *
 * SERVER-OWNED, like the move history: AddOrder's upsert carries it from the
 * stored row and never reads it off a request.
 */
export const ORDER_TABLE_SINCE_KEY = "table_since";

/**
 * The SQL that writes a food blob (a `json` parameter) with this instant
 * stamped. `now()`: the database's clock, the one every closed_at is written
 * with, so the window compares like with like.
 */
export function foodWithTableSinceSql(foodParam: string): string {
	return `jsonb_set((${foodParam})::jsonb, '{${ORDER_TABLE_SINCE_KEY}}', to_jsonb(now()), true)::json`;
}

/** An ISO-looking instant the database can cast. Server-written values only reach here. */
const INSTANT_SQL_SHAPE = "'^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])[T ]([01][0-9]|2[0-3]):[0-5][0-9]'";
const INSTANT_SHAPE = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])[T ]([01][0-9]|2[0-3]):[0-5][0-9]/;

/**
 * THE ARRIVAL, IN SQL — `food.table_since`; else the latest whole-order move
 * onto this table's name (MoveOrderToTable has stamped `food.moves` since
 * before table_since existed, so a ticket moved then still reads right); else
 * created_at. Never earlier than created_at for a server-written row.
 *
 * `tableName` is an SQL expression for the name of the table the order is on.
 * COALESCE evaluates lazily, so the move history is only read for an order
 * without the stamp.
 */
export function orderArrivalSql(input: { food: string; createdAt: string; tableName: string }): string {
	const f = `(${input.food})::jsonb`;
	return `coalesce(
      case when (${f} ->> '${ORDER_TABLE_SINCE_KEY}') ~ ${INSTANT_SQL_SHAPE}
           then (${f} ->> '${ORDER_TABLE_SINCE_KEY}')::timestamptz end,
      (select max((mv ->> 'at')::timestamptz)
         from jsonb_array_elements(case when jsonb_typeof(${f} -> '${ORDER_MOVES_KEY}') = 'array'
                                        then ${f} -> '${ORDER_MOVES_KEY}' else '[]'::jsonb end) mv
        where (mv ->> 'at') ~ ${INSTANT_SQL_SHAPE}
          and lower(btrim(mv ->> 'to_table')) = lower(btrim(${input.tableName}))),
      ${input.createdAt})`;
}

/**
 * THE SETTLED-BILL WINDOW — "arrived on this table after the previous bill
 * here closed, and no later than this bill's close" — for an order row `o`.
 *
 * The first two terms are a cheap, necessary pre-filter that keeps the JSON
 * read off every order the table has ever had: an order arrives after it is
 * created, and every update (the move, the settle) stamps updated_at
 * (orders_touch_trg), so an order that arrived after `prevClosed` was updated
 * after it too. A row with no updated_at has never been updated since that
 * column existed — never moved — and arrived when it was created.
 */
export function settledWindowSql(input: { alias: string; tableName: string; prevClosed: string; closedAt: string }): string {
	const o = input.alias;
	const arrival = orderArrivalSql({ food: `${o}.food`, createdAt: `${o}.created_at`, tableName: input.tableName });
	return `${o}.created_at <= ${input.closedAt}
        and coalesce(${o}.updated_at, ${o}.created_at) > ${input.prevClosed}
        and ${arrival} > ${input.prevClosed}
        and ${arrival} <= ${input.closedAt}`;
}

const instantOf = (v: unknown): number | null => {
	if (v === null || v === undefined || v === "") { return null; }
	const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : new Date(String(v)).getTime();
	return Number.isFinite(t) ? t : null;
};

/**
 * THE ARRIVAL, IN TYPESCRIPT — orderArrivalSql's rule for a row already read
 * (the running bill and the floor read hold the food anyway). Null only when
 * nothing is known.
 */
export function orderArrivedAt(
	food: Readonly<Record<string, unknown>>,
	tableName: string,
	createdAt: Date | string | number | null | undefined,
): number | null {
	const since = text(food[ORDER_TABLE_SINCE_KEY]);
	if (INSTANT_SHAPE.test(since)) {
		const t = instantOf(since);
		if (t !== null) { return t; }
	}
	const name = String(tableName ?? "").trim().toLowerCase();
	const moves = Array.isArray(food[ORDER_MOVES_KEY]) ? (food[ORDER_MOVES_KEY] as unknown[]) : [];
	let latest: number | null = null;
	for (const raw of moves) {
		const m = asRecord(raw);
		const at = text(m.at);
		if (!INSTANT_SHAPE.test(at) || text(m.to_table).toLowerCase() !== name) { continue; }
		const t = instantOf(at);
		if (t !== null && (latest === null || t > latest)) { latest = t; }
	}
	return latest ?? instantOf(createdAt);
}

// ---------------------------------------------------------------------------
// WHOSE BILL A MOVED TICKET IS ON — the guest identity after "Move an order".
// ---------------------------------------------------------------------------

/** The guest identity a seating's paper prints: first non-empty of each, in order. */
export interface SeatingIdentity {
	customer: string | null;
	customer_gstin: string | null;
	customer_address: string | null;
}

const identityText = (v: unknown): string => {
	const s = typeof v === "string" ? v.trim() : "";
	return s.toLowerCase() === "null" || s.toLowerCase() === "undefined" ? "" : s;
};

/**
 * The identity GetBillForTable would print for these orders (oldest first):
 * the first name that is not a placeholder, the first GSTIN and the first
 * address — each on its own, exactly as that reader takes them.
 */
export function seatingIdentityOf(foods: readonly Readonly<Record<string, unknown>>[]): SeatingIdentity {
	let customer = "";
	let gstin = "";
	let address = "";
	for (const f of foods) {
		if (!customer) {
			// GetBillForTable's name rule, character for character.
			const c = String(f.customer ?? "").trim();
			if (c && c.toLowerCase() !== "guest" && c.toLowerCase() !== "qr guest") { customer = c; }
		}
		if (!gstin) { gstin = identityText(f.customer_gstin); }
		if (!address) { address = identityText(f.customer_address); }
	}
	return { customer: customer || null, customer_gstin: gstin || null, customer_address: address || null };
}

/**
 * A MOVED TICKET TAKES THE DESTINATION'S GUEST, not the source's.
 *
 * The name, GSTIN and address on an order are the SEATING's (SetBillCustomerName
 * writes them onto every running order of the table), so a ticket moved from a
 * named 12 carried 12's company, GSTIN and address onto 15, and 15's GST invoice
 * printed them whenever the ticket was 15's oldest identified order. The ticket
 * is re-stamped with the identity 15's paper already prints (none at all:
 * "Guest", as a dish move writes), so the correction changes 15's paper by its
 * lines alone.
 */
export function withSeatingIdentity(
	food: Readonly<Record<string, unknown>>,
	identity: SeatingIdentity,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...food, customer: identity.customer ?? "Guest" };
	if (identity.customer_gstin) { out.customer_gstin = identity.customer_gstin; } else { delete out.customer_gstin; }
	if (identity.customer_address) { out.customer_address = identity.customer_address; } else { delete out.customer_address; }
	return out;
}

/**
 * ...AND THE SOURCE KEEPS ITS GUEST. A seating named, then ordered on again,
 * carries its name, GSTIN and address only on the orders that existed when it
 * was named — so moving the first ticket away took 12's identity off 12's
 * paper. The orders left behind are filled with the identity 12's paper printed
 * before the move, field by field, where they carry none of their own; a value
 * an order already carries is never overwritten. Null when nothing changes.
 */
export function withFilledSeatingIdentity(
	food: Readonly<Record<string, unknown>>,
	identity: SeatingIdentity,
): Record<string, unknown> | null {
	const out: Record<string, unknown> = { ...food };
	let changed = false;
	const name = String(food.customer ?? "").trim().toLowerCase();
	if (identity.customer && (name === "" || name === "guest" || name === "qr guest")) {
		out.customer = identity.customer;
		changed = true;
	}
	if (identity.customer_gstin && !identityText(food.customer_gstin)) {
		out.customer_gstin = identity.customer_gstin;
		changed = true;
	}
	if (identity.customer_address && !identityText(food.customer_address)) {
		out.customer_address = identity.customer_address;
		changed = true;
	}
	return changed ? out : null;
}
