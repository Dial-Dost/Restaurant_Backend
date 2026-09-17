/**
 * HAS THIS SEATING'S BILL BEEN PRINTED? — one rule, two payloads.
 *
 * ============================================================================
 * THE DEFECT THIS ENDS: A CLIENT READ WITH NO SERVER FIELD BEHIND IT
 * ============================================================================
 * C3 ("a waiter may print the bill once, and the table then clears from their
 * view") is answered on GET /bill-for-table, which carries `print_count`,
 * `bill_printed_at` and `printed_at`. The Flutter FLOOR GRID asks the same
 * question of a different payload — the `/get-tables` row it renders — and that
 * payload never carried any of the three. So `serverBillPrintState(row)` came
 * back null on every table, every time, and the grid silently fell back to
 * [PrintedBills], a per-DEVICE memory that survives neither a reinstall nor a
 * second tablet. A rule that means something different on every device in the
 * building is the exact failure role_scope.ts and service_clock.ts were written
 * to end, and it is the FOURTH time in this project that a client read was
 * shipped with nothing feeding it.
 *
 * So the three names ship on the table list too — the same three spellings, so
 * the client needs no second code path — and table_list_print_state.test.ts
 * fails if either payload stops sending them.
 *
 * ============================================================================
 * WHY THE RULE IS HERE AND NOT IN SQL
 * ============================================================================
 * /bill-for-table asks about ONE table; /get-tables asks about forty, and it is
 * the most-polled endpoint in the product, so it cannot run one aggregate query
 * per table. Two queries answering one question is how the release preflight and
 * the bill math ended up disagreeing about status 6. The fix is the same shape:
 * ONE coarse read of the "PrintJobs" rows both callers care about, and ONE pure
 * reduction — this module — applied per table. Neither caller owns the rule.
 *
 * ============================================================================
 * WHICH JOBS COUNT (unchanged from billPrintHistoryForTable's SQL)
 * ============================================================================
 *   * kind='bill'. A kitchen docket is not a bill.
 *   * status 'pending', 'delivered' or 'acked' — paper that came out, or paper
 *     on its way to a till that will print it when it reconnects. 'failed' and
 *     'expired' are TERMINAL NON-EVENTS and deliberately do not count: burning a
 *     waiter's single attempt on a paper jam leaves them holding a table they
 *     cannot bill.
 *   * raised at or after this party sat down. The seating bound is what stops
 *     the previous party's prints following the table into the next service.
 *   * addressed either to the open bill's id, or to the `<table name>-<epoch>`
 *     fallback routes/bills.ts uses when a table has no "Bills" row yet. Both
 *     shapes are written, so both must be matched.
 *
 * FAILS SAFE, IN THE DIRECTION THE CLIENT ALREADY CHOSE. No rows, or a
 * deployment where migration 027 has not been applied, means "not printed" —
 * the waiter keeps their button. A waiter standing at a table with a guest
 * waiting and no way to produce a bill is a worse outage than a second copy of
 * one.
 */

import type { BillPaperRecord } from "./bill_paper_digest.js";

/** The "PrintJobs" columns this rule reads. Everything else is ignored. */
export interface BillPrintJobRow {
	bill_id: unknown;
	created_at: unknown;
	/**
	 * Migration 055: what the paper said (bill_paper_digest.ts). Absent on a
	 * database without 055 and null on every print made before it — both mean
	 * "nobody recorded it", which latestBillPaper answers as unknown.
	 */
	bill_digest?: unknown;
	lines_digest?: unknown;
	bill_grand_total?: unknown;
	table_name?: unknown;
}

/** Which seating a job has to belong to. */
export interface BillPrintSeating {
	/** "Bills".id of the table's OPEN bill, or null when it has none yet. */
	open_bill_id: string | null;
	/** The table's name, for the `<name>-<epoch>` fallback bill_id. */
	table_name: string;
	/** When this party sat down. Null = no bound (count everything we were given). */
	seating_start: Date | string | number | null;
}

/**
 * The three field names the clients read, exactly as they read them. Spread this
 * object into a payload rather than writing the keys out again — a fourth
 * spelling is how the floor grid ended up reading fields nobody sent.
 */
export interface BillPrintState {
	/** How many times THIS seating's bill has been printed. 0 = never. */
	print_count: number;
	/** The FIRST print (the one that used a waiter's single attempt), ISO. */
	bill_printed_at: string | null;
	/** The LATEST print, ISO, so a till can say "last printed 19:42". */
	printed_at: string | null;
}

/** A table whose bill has never been printed — and the migration-027-missing answer. */
export const NO_BILL_PRINTS: BillPrintState = { print_count: 0, bill_printed_at: null, printed_at: null };

/** The job statuses that count as a print. See the header for why not 'failed'. */
export const COUNTED_PRINT_JOB_STATUSES: readonly string[] = ["pending", "delivered", "acked"];

/** kind='bill' — the only kind this rule is about. */
export const BILL_PRINT_JOB_KIND = "bill";

const asTime = (v: unknown): number | null => {
	if (v === null || v === undefined || v === "") { return null; }
	// An epoch number is an instant as it stands; `new Date(String(n))` would
	// read "1789545774907" as a date STRING and answer NaN.
	const t = typeof v === "number" ? v : v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
	return Number.isFinite(t) ? t : null;
};

/**
 * The `<table name>-<epoch>` prefix routes/bills.ts writes as bill_id when a
 * table has no "Bills" row yet. Matched as a PREFIX on the exact name, never as
 * a LIKE pattern: "T_1" as a pattern would have counted "TX1-…" as its own
 * print, which is why the SQL version escapes the metacharacters. Doing it in
 * TypeScript removes the escaping question entirely.
 */
export function billPrintFallbackPrefix(tableName: string): string {
	return `${String(tableName ?? "").trim()}-`;
}

/**
 * WHEN THIS PARTY SAT DOWN, for the purpose of counting its prints — the
 * EARLIER of the open bill's created_at and the earliest still-owing order.
 *
 * THE DEFECT THIS ENDS. Both payloads used the bill row's created_at whenever a
 * bill row existed, and fell back to the first order only when it did not. But
 * a bill row is often born AFTER the print: a waiter prints a table that has no
 * "Bills" row (the job is filed under `<name>-<epoch>`), and a discount, a
 * service-charge waiver or a tender then creates the row. The seating then
 * "started" after its own print, the print stopped counting, the table came
 * back onto the waiter's floor and their one print was handed back. Production
 * GGV table 12 on 2026-09-16 only escaped it because the manager reprinted.
 *
 * Every order of this party was placed before its bill was printed (there is
 * nothing to print until there is an order), so the earliest still-owing order
 * is never later than the print, and taking the earlier of the two keeps the
 * print inside the seating whichever row came first. Null when neither is
 * known — a table with no bill and no order has nothing to have printed.
 */
export function seatingStartOf(
	billCreatedAt: Date | string | number | null | undefined,
	firstOrderAt: Date | string | number | null | undefined,
): Date | null {
	const bill = asTime(billCreatedAt);
	const order = asTime(firstOrderAt);
	if (bill === null && order === null) { return null; }
	if (bill === null) { return new Date(order!); }
	if (order === null) { return new Date(bill); }
	return new Date(Math.min(bill, order));
}

/**
 * The bill_id each part of a split print is filed under: `<bill id>-split-<i>of<n>`
 * when the table has a bill row (routes/bills.ts, POST /print/bill/split). The
 * no-row shape `<name>-split-…` is already covered by the fallback prefix.
 */
export function splitPrintPrefix(openBillId: string): string {
	return `${String(openBillId ?? "").trim()}-split-`;
}

/**
 * The bill_id a NON-CHARGEABLE bill's paper is filed under: `<bill id>-nc`. The
 * settle-as-NC original (routes/nc_settle.ts) and the accounting reprint of an
 * NC bill (POST /print/bill/settled) both use it.
 *
 * NOT THE BILL'S OWN ID, because that id is what this rule counts, and an NC
 * paper is not this seating's bill. It reads 0.00 "Non-chargeable"; nobody was
 * handed an amount to pay. While the bill stays closed nothing asks, but a
 * RE-OPENED NC bill is an open, unpaid bill again under that same id, and a
 * paper filed under it made the seating read as printed: a waiter's order was
 * refused 423, a waiter could not print the real bill, seniors were told to
 * reprint, and the floor read opened a next-party seat beside a table whose
 * chargeable bill nobody had seen. `<id>-nc` is neither the id nor
 * `<id>-split-…`, and it starts with a UUID rather than `<table name>-`, so no
 * seating counts it. "PrintJobs".bill_id is free text (027) and the tills only
 * log it.
 */
export function ncSettlementPrintJobId(billId: string): string {
	return `${billId.trim()}-nc`;
}

/**
 * What a PREVIOUS party's fallback-addressed print is re-filed as when a moved
 * party lands on its table (MoveTableParty): `previous-party:<old bill_id>`.
 *
 * THE DEFECT THIS ENDS. A moved party keeps its orders' created_at, so its
 * seating starts BEFORE the move — and at the destination that start counted
 * every `<dst>-<epoch>` print made after it, including the bill of the party
 * that sat there, paid and left in the meantime. The moved party arrived
 * "printed" (orange, a 423 on a plain order, a next-party seat, "Replaces the
 * bill printed 12:01" on somebody else's paper). Production: 4 of the last 12
 * party moves had that shape.
 *
 * The destination is free with no open bill when this is written, so those
 * prints belong to nobody seated. The new id keeps the old one whole (the
 * ledger still says what was printed) and no longer starts with
 * `<table name>-`, so no seating counts it. Like `<id>-nc`, it is free text the
 * tills only log.
 */
export const PREVIOUS_PARTY_PRINT_MARK = "previous-party:";

export function previousPartyPrintJobId(billId: string): string {
	return `${PREVIOUS_PARTY_PRINT_MARK}${String(billId ?? "").trim()}`;
}

/** Does this print job belong to this table's CURRENT seating? */
export function billPrintJobBelongsToSeating(job: BillPrintJobRow, seating: BillPrintSeating): boolean {
	const billId = String(job?.bill_id ?? "").trim();
	if (!billId) { return false; }

	const openId = String(seating.open_bill_id ?? "").trim();
	// A SPLIT PRINT IS A PRINT OF THIS BILL. Its parts were filed under
	// `<bill id>-split-…` and matched nothing here, so a split-printed table with
	// a bill row read as never printed while the same table without one (whose
	// parts start `<name>-`) read as printed — and the next-party seat, which
	// every successful print now opens, sat beside a root that had not left the
	// waiter's floor.
	const addressed = (openId !== "" && (billId === openId || billId.startsWith(splitPrintPrefix(openId))))
		|| billId.startsWith(billPrintFallbackPrefix(seating.table_name));
	if (!addressed) { return false; }

	const start = asTime(seating.seating_start);
	if (start === null) { return true; }
	const at = asTime(job?.created_at);
	// A job with no readable timestamp is counted rather than dropped: it is a
	// print that happened, and the seating bound is a refinement, not the rule.
	return at === null || at >= start;
}

/** Reduce the jobs belonging to one seating to the three fields the clients read. */
export function summarizeBillPrints(
	jobs: readonly BillPrintJobRow[] | null | undefined,
	seating: BillPrintSeating,
): BillPrintState {
	let count = 0;
	let first: number | null = null;
	let last: number | null = null;
	for (const job of jobs ?? []) {
		if (!billPrintJobBelongsToSeating(job, seating)) { continue; }
		count += 1;
		const at = asTime(job?.created_at);
		if (at === null) { continue; }
		if (first === null || at < first) { first = at; }
		if (last === null || at > last) { last = at; }
	}
	if (count === 0) { return NO_BILL_PRINTS; }
	return {
		print_count: count,
		bill_printed_at: first === null ? null : new Date(first).toISOString(),
		printed_at: last === null ? null : new Date(last).toISOString(),
	};
}

/**
 * WHAT THE LATEST PAPER OF THIS SEATING SAID (migration 055) — the content the
 * guest is holding, or null when nothing of this seating was printed.
 *
 * THE LATEST, NOT ANY. An updated print replaces the one before it; the guest
 * pays against the newest paper, so that is the one the current bill is
 * compared with. Counted by the same membership rule as summarizeBillPrints, so
 * a failed or expired job — a print that never came out — is never "the paper".
 * A job whose content was not recorded answers null digests: unknown, not
 * "matches".
 *
 * Several parts of a split print share one instant and carry the WHOLE bill's
 * digests (routes/bills.ts), so which of them wins a tie does not matter.
 */
export function latestBillPaper(
	jobs: readonly BillPrintJobRow[] | null | undefined,
	seating: BillPrintSeating,
): BillPaperRecord | null {
	let latest: BillPrintJobRow | null = null;
	let latestAt = -Infinity;
	for (const job of jobs ?? []) {
		if (!billPrintJobBelongsToSeating(job, seating)) { continue; }
		const at = asTime(job?.created_at) ?? -Infinity;
		if (latest === null || at >= latestAt) {
			latest = job;
			latestAt = at;
		}
	}
	if (latest === null) { return null; }
	const str = (v: unknown): string | null => {
		const s = String(v ?? "").trim();
		return s === "" ? null : s;
	};
	const total = latest.bill_grand_total === null || latest.bill_grand_total === undefined || latest.bill_grand_total === ""
		? null
		: Number(latest.bill_grand_total);
	return {
		bill_digest: str(latest.bill_digest),
		lines_digest: str(latest.lines_digest),
		bill_grand_total: total !== null && Number.isFinite(total) ? total : null,
		table_name: str(latest.table_name),
	};
}
