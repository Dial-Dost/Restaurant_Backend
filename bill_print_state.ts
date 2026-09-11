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

/** The "PrintJobs" columns this rule reads. Everything else is ignored. */
export interface BillPrintJobRow {
	bill_id: unknown;
	created_at: unknown;
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
	const t = v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
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

/** Does this print job belong to this table's CURRENT seating? */
export function billPrintJobBelongsToSeating(job: BillPrintJobRow, seating: BillPrintSeating): boolean {
	const billId = String(job?.bill_id ?? "").trim();
	if (!billId) { return false; }

	const openId = String(seating.open_bill_id ?? "").trim();
	const addressed = (openId !== "" && billId === openId) || billId.startsWith(billPrintFallbackPrefix(seating.table_name));
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
