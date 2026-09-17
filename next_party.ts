/**
 * THE NEXT PARTY AT A PRINTED TABLE — client item 6 (migration 053).
 *
 * ============================================================================
 * WHAT WAS ASKED
 * ============================================================================
 * "Table where bill is printed is disappearing from the waiter app. There
 * should be a duplicate table showing same number for order taking for the
 * next round of guests."
 *
 * The disappearing is C3, and it stays: a waiter's printed party is finished
 * business for them and a manager settles it. What was missing is the NUMBER.
 * At Gaia Global Vegetarian a printed table sat unsettled for a median of 26
 * minutes, and the waiters, with no "12" left to order on, seated the next
 * guests on table 15 and had a manager move them back once 12 was paid.
 *
 * ============================================================================
 * WHY A SECOND "Tables" ROW AND NOT A SECOND PARTY ON THE SAME ROW
 * ============================================================================
 * Every money path in this system is keyed by table_id: the bill is the sum of
 * the table's still-owing orders, settle closes ALL of them, approval re-prices
 * from all of them, there is one open bill per table, and covers, seatings, the
 * KOT key and the print ledger all hang off the table row. A second party on
 * the same row would be settled with the first party's printed bill. So the
 * next party gets its OWN row — "12 #2" — a real, non-virtual table whose
 * `parent_table_id` names the root, and every one of those paths separates the
 * two parties for free because they are two table ids.
 *
 * The cost is one rule every future reader must keep: NEVER fold a sibling into
 * its root by NAME on a bill, settle or approval path. Labels may fold (a
 * table-wise report reads "12"); money never does.
 *
 * ============================================================================
 * THE NAME
 * ============================================================================
 * `<root> #<n>`, n >= 2. The separator is " #" and NOT "-": the print ledger's
 * fallback bill id is `<table name>-<epoch>` and is matched as a PREFIX
 * (bill_print_state.ts), so a sibling called "12-2" would have its prints read
 * as the parent's. "12 #2-…" does not start with "12-", and "12-…" does not
 * start with "12 #2-".
 *
 * The name is the internal handle — every route addresses a table by name, so
 * it must be unique — and it is what the KOT, the bill and every cashier list
 * print, so two open bills for "12" stay distinguishable at the till. The
 * waiter's tile shows the root's number big with a "Next party" chip; that is
 * `display_name` plus `parent_table`, and both clients say it in the same words
 * (NEXT_PARTY_CHIP, nextPartyLabel).
 *
 * A name that already ENDS in " #<digits>" is reserved for this and refused on
 * create. Production had none on 2026-09-16 (the only lookalikes, 31A/32A/33A,
 * are real tables and do not match).
 *
 * This module is pure: the data layer and both route files decide with it, and
 * next_party.test.ts pins it.
 */

/** Between the root's name and the party number. See the header for why not "-". */
export const NEXT_PARTY_SEPARATOR = " #";

/** The first sibling is "#2": the root is party 1. */
export const FIRST_NEXT_PARTY_SEQ = 2;

/**
 * The highest party number handed out. `party_seq` is a smallint, and a family
 * with this many live rows is a runaway loop rather than a restaurant, so the
 * data layer stops rather than minting further.
 */
export const MAX_NEXT_PARTY_SEQ = 99;

/** The reserved shape: whitespace, "#", digits, at the END of the name. */
const RESERVED_TAIL = /\s#\d+$/;

/** "12" + 2 -> "12 #2". The root is trimmed; the number is an integer >= 2. */
export function nextPartyName(root: string, seq: number): string {
	const n = Math.round(Number(seq));
	if (!Number.isFinite(n) || n < FIRST_NEXT_PARTY_SEQ) {
		throw new Error(`A next-party number starts at ${String(FIRST_NEXT_PARTY_SEQ)}`);
	}
	return `${String(root ?? "").trim()}${NEXT_PARTY_SEPARATOR}${String(n)}`;
}

/** True for a name only the server may create — "12 #2", "Patio 4 #13". */
export function isReservedPartyName(name: unknown): boolean {
	return RESERVED_TAIL.test(String(name ?? "").trim());
}

/** "12 #2" -> { root: "12", seq: 2 }; anything else -> null. */
export function parseNextPartyName(name: unknown): { root: string; seq: number } | null {
	const s = String(name ?? "").trim();
	const m = /^(.*\S)\s#(\d+)$/.exec(s);
	if (!m) { return null; }
	const seq = Number(m[2]);
	if (!Number.isSafeInteger(seq) || seq < FIRST_NEXT_PARTY_SEQ) { return null; }
	return { root: m[1]!, seq };
}

/** The sentence POST /add-table answers a reserved name with. Both clients show it verbatim. */
export const RESERVED_TABLE_NAME_ERROR =
	"Table names ending in \"#\" and a number (like \"12 #2\") are kept for the next party at a printed table. Pick another name.";

// ---------------------------------------------------------------------------
// The words. Web and app say these, and nothing else, about a sibling.
// ---------------------------------------------------------------------------

/** The chip on a sibling's tile. */
export const NEXT_PARTY_CHIP = "Next party";

/** "12" -> "12 (next party)" — how a sibling is named in any sentence or picker. */
export function nextPartyLabel(root: string): string {
	return `${String(root ?? "").trim()} (next party)`;
}

/**
 * What a table is CALLED in a sentence: its own name for a root, the root's
 * name with "(next party)" for a sibling. `parentTable` is the root's name, as
 * GET /get-tables sends it.
 */
export function tableSentenceName(tableName: string, parentTable: string | null | undefined): string {
	const parent = String(parentTable ?? "").trim();
	return parent ? nextPartyLabel(parent) : String(tableName ?? "").trim();
}

/** The big label on a tile: the root's number for a sibling, the table's own name otherwise. */
export function tableDisplayName(tableName: string, parentTable: string | null | undefined): string {
	const parent = String(parentTable ?? "").trim();
	return parent || String(tableName ?? "").trim();
}

// ---------------------------------------------------------------------------
// The family: which seat to hand out, and which idle rows to retire.
// ---------------------------------------------------------------------------

/**
 * One live row of a family as the data layer read it. `party_seq` is null for
 * the root. `free` = not seated, no still-owing order and no open bill — a seat
 * a new party can be put in without joining anybody's money.
 */
export interface NextPartyFamilyMember {
	id: string;
	table_name: string;
	party_seq: number | null;
	free: boolean;
}

const bySeq = (a: NextPartyFamilyMember, b: NextPartyFamilyMember): number =>
	(a.party_seq ?? 1) - (b.party_seq ?? 1);

/**
 * The seat to give the next party, or null when the whole family is busy.
 *
 * THE ROOT FIRST. A free "12" is where the next party at 12 belongs — the
 * sibling only exists because the root was taken — then the lowest-numbered
 * free sibling, so the same "12 #2" keeps being reused rather than the numbers
 * climbing across a service.
 */
export function freeFamilySeat(family: readonly NextPartyFamilyMember[]): NextPartyFamilyMember | null {
	const free = family.filter((m) => m.free);
	if (free.length === 0) { return null; }
	return free.find((m) => m.party_seq === null) ?? [...free].sort(bySeq)[0] ?? null;
}

/**
 * The lowest party number >= 2 that no live sibling holds and whose name is not
 * taken, or null when there is none up to MAX_NEXT_PARTY_SEQ.
 *
 * `nameTaken` answers for the NAME, because a grandfathered physical table
 * could already be called "12 #3" and two live rows may not share a name.
 */
export function nextFreePartySeq(
	liveSeqs: Iterable<number>,
	nameTaken: (seq: number) => boolean = () => false,
): number | null {
	const held = new Set<number>();
	for (const s of liveSeqs) { held.add(Math.round(Number(s))); }
	for (let n = FIRST_NEXT_PARTY_SEQ; n <= MAX_NEXT_PARTY_SEQ; n += 1) {
		if (!held.has(n) && !nameTaken(n)) { return n; }
	}
	return null;
}

/**
 * THE RETIREMENT RULE — at most one FREE seat per family, preferring the root.
 *
 *   * root free    -> every free sibling goes; "12" itself is the free seat.
 *   * root busy    -> exactly one free sibling stays (the lowest-numbered, so
 *                     the waiter keeps seeing the same "12 #2"), the rest go.
 *   * a busy sibling is NEVER retired, whatever the root is doing: it has a
 *     party, an order or an open bill on it, and retiring it would hide money.
 *
 * Returns the ids to soft-delete. The data layer re-checks "free" in the same
 * statement that retires, so a row that got a party between the read and the
 * write is left alone.
 */
export function planNextPartyRetirement(family: readonly NextPartyFamilyMember[]): string[] {
	const root = family.find((m) => m.party_seq === null);
	const freeSiblings = family.filter((m) => m.party_seq !== null && m.free).sort(bySeq);
	if (freeSiblings.length === 0) { return []; }
	// No root in the family (it was deleted from under its siblings, which the
	// delete guard refuses): nothing to prefer, so keep one seat as if it were busy.
	const keep = root?.free === true ? 0 : 1;
	return freeSiblings.slice(keep).map((m) => m.id);
}

// ---------------------------------------------------------------------------
// The money guard on new orders.
// ---------------------------------------------------------------------------

/** The machine-readable code on the refusal. Both clients key their action on it. */
export const BILL_PRINTED_CODE = "bill_printed";

/**
 * MAY THIS CALLER ADD TO A TABLE WHOSE CURRENT BILL HAS BEEN PRINTED?
 *
 * The printed paper is what the guest pays against, and a waiter cannot
 * reprint (C3). So an order added after the print by a waiter makes the paper
 * disagree with the drawer, with nobody able to fix it but a manager who does
 * not know it happened. The QR guest is refused for a sharper reason: the table
 * card's QR is signed for "12", and whoever scans it after the print may be the
 * NEXT party, whose food would land on the old party's bill.
 *
 *   * "allow"          — nothing printed yet, or no print state to go on.
 *   * "reprint_needed" — a senior role: allowed, and told the paper is now stale.
 *   * "refuse"         — a waiter-only login or a QR guest.
 */
export type PrintedBillOrderVerdict = "allow" | "reprint_needed" | "refuse";

export function orderOnPrintedBillVerdict(input: {
	printCount: number;
	waiterOnly: boolean;
	guest: boolean;
	/**
	 * Does this write put MORE on the bill? True for every new order and every
	 * new line; for POST /orders used as an UPSERT of an existing order (the
	 * dashboard's status change and its edit dialog both are) it is
	 * orderUpsertAddsToBill's answer. A write that adds nothing leaves the
	 * paper right, so it is never refused and never told to reprint.
	 */
	addsToBill?: boolean;
}): PrintedBillOrderVerdict {
	if (!(Number(input.printCount) > 0)) { return "allow"; }
	if (input.addsToBill === false) { return "allow"; }
	if (input.guest || input.waiterOnly) { return "refuse"; }
	return "reprint_needed";
}

/**
 * One stored line of an order, as AddOrder keys it: by line id, with the
 * quantity AddOrder would compare an incoming line against.
 */
export interface StoredOrderLine {
	id: string;
	quantity: number;
}

/**
 * The lines of an INCOMING order's `items` in either shape a client sends —
 * the list `[{id, …}, …]` or the split `[["Served", [ … ]], ["Preparing",
 * [ … ]]]` — flattened. The tuple test is AddOrder's own: the FIRST entry
 * decides, and a tuple whose second member is not a list contributes nothing.
 */
function flattenOrderItems(items: unknown): unknown[] {
	const list: unknown[] = Array.isArray(items) ? items : [];
	const first: unknown = list[0];
	const tupleShape = Array.isArray(first) && typeof first[0] === "string" && Array.isArray(first[1]);
	if (!tupleShape) { return list; }
	return list.flatMap((t) => (Array.isArray(t) && Array.isArray(t[1]) ? (t[1] as unknown[]) : []));
}

/**
 * The stored order's lines, read EXACTLY as AddOrder's merge reads them
 * (`existingItems` / `existingById`): the split flattened when the order has a
 * non-empty one, else its `items` list AS IT STANDS (a legacy tuple-shaped
 * `items` holds no line AddOrder can match, so it holds none here either); a
 * line with no id is not a line an incoming one can match; and when an id
 * repeats, the LAST one wins.
 */
export function storedOrderLines(food: { items?: unknown; items_split?: unknown } | null | undefined): StoredOrderLine[] {
	const split = Array.isArray(food?.items_split) && food.items_split.length > 0 ? (food.items_split as unknown[]) : null;
	const lines: unknown[] = split
		? split.flatMap((t) => (Array.isArray(t) && Array.isArray(t[1]) ? (t[1] as unknown[]) : []))
		: Array.isArray(food?.items) ? (food.items as unknown[]) : [];
	const byId = new Map<string, number>();
	for (const line of lines) {
		const l = (line && typeof line === "object" ? line : {}) as { id?: unknown; quantity?: unknown };
		const id = String(l.id ?? "");
		if (!id) { continue; }
		byId.set(id, Number(l.quantity ?? 0) || 0);
	}
	return [...byId.entries()].map(([id, quantity]) => ({ id, quantity }));
}

/**
 * DOES THIS UPSERT PUT MORE ON THE BILL THAN THE ORDER ALREADY HAS?
 *
 * POST /orders is also how the dashboard CHANGES an order: a status change
 * resends the order with its lines untouched, and the edit dialog resends it
 * with lines added. A waiter changing a printed table's order to "Served" is
 * not adding to the bill and must not be refused; the same waiter adding a
 * dessert through the edit dialog is, and must be.
 *
 * DECIDED LINE BY LINE, THE WAY AddOrder MERGES — NOT BY COMPARING TOTALS.
 * AddOrder starts from EVERY stored line and applies the incoming ones on top:
 * a line id it does not know is appended as a new Preparing line, and a known
 * id sent with a higher quantity has the difference appended. Lines the resend
 * leaves out are KEPT. So a resend that names the order and carries ONLY the
 * new dessert looks smaller than the stored order by any total, and grows the
 * bill all the same — the hole a totals comparison left open (a waiter-only
 * login added to a printed 4 x Thali this way, and the paper read 2,100 while
 * the bill read 2,220). This asks AddOrder's own question instead: would the
 * merge append anything?
 *
 *   * an incoming line with no id, or an id the stored order lacks -> adds;
 *   * a known id with a quantity above the stored one               -> adds;
 *   * anything else (the same lines, fewer, a lower quantity)        -> does not.
 *
 * Quantities are read as AddOrder reads them: incoming `Number(q ?? 1) || 1`,
 * stored `Number(q ?? 0) || 0`. `existing` null = there is no such order — a
 * new one, which always adds.
 */
export function orderUpsertAddsToBill(
	incomingItems: unknown,
	existing: readonly StoredOrderLine[] | null,
): boolean {
	if (!existing) { return true; }
	const stored = new Map(existing.map((l) => [l.id, l.quantity]));
	for (const line of flattenOrderItems(incomingItems)) {
		const l = (line && typeof line === "object" ? line : {}) as { id?: unknown; quantity?: unknown };
		const id = String(l.id ?? "");
		const quantity = Number(l.quantity ?? 1) || 1;
		const before = id ? stored.get(id) : undefined;
		if (before === undefined) { return true; }
		if (quantity > before) { return true; }
	}
	return false;
}

/**
 * THE STATUS OF THE REFUSAL: 423 Locked, and deliberately NOT 409.
 *
 * The till's outbox (restaurant_owner_app lib/services/outbox.dart — 2.0.0
 * included, which cannot be patched in the field) reads 409 on an allowlisted
 * write as "this Idempotency-Key is still in flight, retry", because
 * idempotency.ts is the only thing that answers 409 there. A printed-bill
 * refusal sent as 409 was therefore retried eight times instead of being
 * parked, and while it sat pending the outbox's ordering rule queued every
 * later write from that device behind it: new orders for OTHER tables read
 * "Not sent yet" for as long as the refusal kept coming back. Any other 4xx is
 * parked on the first answer, with this body's sentence on the chip. 423 is the
 * one that says what happened — the bill is locked by its print — and nothing
 * else in the backend answers it.
 */
export const BILL_PRINTED_STATUS = 423;

/**
 * What the refused write was. An ORDER is pointed at the next party's seat; a
 * MERGE into, or an item MOVED onto, a printed table is food that already
 * belongs to somebody seated, so it is only ever a manager's (add it,
 * reprint) and no seat is offered.
 */
export type BillPrintedWrite = "order" | "merge" | "move";

/**
 * The refusal's body, sent with BILL_PRINTED_STATUS. `error` is a sentence
 * both clients show as it stands, and
 * `next_party_action` is the label of the button beside it ("Take it on 12
 * (next party)") — null when there is nowhere else to take the order.
 */
export interface BillPrintedRefusal {
	error: string;
	code: typeof BILL_PRINTED_CODE;
	table: string;
	next_party_table: string | null;
	next_party_action: string | null;
	print_count: number;
}

export function billPrintedRefusal(input: {
	table: string;
	nextPartyTable: string | null;
	printCount: number;
	guest: boolean;
	/** The root's name when [table] is itself a sibling, so the sentence says "12". */
	parentTable?: string | null;
	/** An order (the default), or a merge into / an item moved onto [table]. */
	write?: BillPrintedWrite;
}): BillPrintedRefusal {
	const named = tableSentenceName(input.table, input.parentTable ?? null);
	const write = input.write ?? "order";
	// A merge or a move is never pointed anywhere: see BillPrintedWrite.
	const next = write === "order" ? String(input.nextPartyTable ?? "").trim() : "";
	const nextParent = parseNextPartyName(next)?.root ?? null;
	const nextNamed = next ? tableSentenceName(next, nextParent) : "";
	const elsewhere = next !== "" && next.toLowerCase() !== String(input.table ?? "").trim().toLowerCase();
	const managerDoes = write === "merge"
		? "Ask a manager to merge it and reprint the bill."
		: write === "move"
			? "Ask a manager to move it and reprint the bill."
			: "Ask a manager to add it and reprint the bill.";
	const error = input.guest
		? "This table's bill has already been printed, so nothing more can be ordered on it here. Please ask a member of staff."
		: elsewhere
			? `${named}'s bill has already been printed, so nothing more can be added to it. Take a new party's order on ${nextNamed}. If it is for the same guests, ask a manager to add it and reprint the bill.`
			: `${named}'s bill has already been printed, so nothing more can be added to it. ${managerDoes}`;
	return {
		error,
		code: BILL_PRINTED_CODE,
		table: String(input.table ?? "").trim(),
		next_party_table: next || null,
		// A guest is never handed a table to walk to.
		next_party_action: elsewhere && !input.guest ? takeItOnNextPartyLabel(next) : null,
		print_count: Math.max(0, Math.round(Number(input.printCount) || 0)),
	};
}

/** The action both clients put beside the refusal's sentence. */
export function takeItOnNextPartyLabel(nextPartyTable: string): string {
	const next = String(nextPartyTable ?? "").trim();
	const parent = parseNextPartyName(next)?.root ?? null;
	return `Take it on ${tableSentenceName(next, parent)}`;
}

/**
 * The line a successful print answers with once a seat exists for the next
 * party. Null when there is none (a takeaway, or the feature is off).
 */
export function nextPartyAfterPrintMessage(nextPartyTable: string | null): string | null {
	const next = String(nextPartyTable ?? "").trim();
	if (!next) { return null; }
	return `Seat the next party at ${tableSentenceName(next, parseNextPartyName(next)?.root ?? null)}.`;
}

/**
 * THE LINE A SENIOR ROLE'S ADDITION TO A PRINTED BILL IS ANSWERED WITH.
 *
 * A manager, cashier or captain may add to a printed table (the refusal's own
 * sentence sends a waiter to them for exactly that), but the paper in the
 * guest's hand no longer covers what was added: the guest would pay the printed
 * total while the settle books the larger one. The route answers
 * `reprint_needed: true` with this sentence beside it as `reprint_message`, and
 * both clients show it with a Reprint action, in these words.
 */
export function reprintNeededMessage(table: string, parentTable?: string | null): string {
	return `${tableSentenceName(table, parentTable ?? null)}'s bill was already printed, so the paper no longer shows this. Reprint the bill before the guest pays.`;
}
