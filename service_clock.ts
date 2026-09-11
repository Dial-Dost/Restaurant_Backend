/**
 * THE SERVICE CLOCK — "how long has this table been in service" — decided ONCE,
 * on the server, so both clients render the SAME number (requirement D2).
 *
 * WHAT D2 ASKS FOR, restated: replace the KOT time on a table's order with a
 * live duration that runs from the moment the order was PLACED to the moment the
 * bill was SETTLED, displayed the way the kitchen section displays its timer.
 *
 * WHY THIS IS A SERVER ANSWER AND NOT A CLIENT SUBTRACTION. Two reasons, and the
 * second is the one that bites:
 *
 *   1. TWO CLIENTS, TWO SUBTRACTIONS. The owner app and the dashboard would each
 *      pick a start (created_at? barked_at? the bill's created_at?) and an end
 *      (closed_at? admin_approved_at? the last status change?), and the two
 *      screens would disagree about the same table in front of the same manager.
 *      That is the shape of the csrorganics defect in role_scope.ts wearing a
 *      different hat: one rule, implemented twice, drifting.
 *
 *   2. A TILL'S WALL CLOCK IS NOT EVIDENCE. A Windows till or an Android tablet
 *      that is ten minutes fast turns `now - created_at` into "this table has
 *      been waiting 10 minutes" the instant the order lands. So the elapsed
 *      figure is computed against the SERVER's clock and shipped as a NUMBER OF
 *      MILLISECONDS together with `as_of`. A client that wants a ticking display
 *      adds its own monotonic delta since the response arrived — it never needs
 *      its own idea of what time it is.
 *
 * THE CLOCK STOPS AND STAYS STOPPED. Once the bill is settled the duration is a
 * FACT about a completed service, not a counter: `running` goes false, `ended_at`
 * is the settle instant, and `elapsed_ms` is frozen. A client that keeps ticking
 * a stopped clock is reporting a table that is not there.
 *
 * ABSENT IS NOT ZERO. An order with no placed-at (a row written before the
 * timestamp columns existed) returns a clock with `started_at: null` and
 * `elapsed_ms: 0` AND `running: false`, so a client can tell "no clock" from
 * "zero seconds". Rendering 0 as "0m" on a table that has been open two hours is
 * worse than rendering nothing.
 *
 * A PURE MODULE WITH NO RUNTIME IMPORTS, for the same reason billing_math.ts,
 * role_scope.ts and report_window.ts are: it answers a question both the data
 * layer and the route layer ask, and it has to be provable without a database.
 */

/** The raw timestamps the data layer has in hand for one order. */
export interface ServiceClockInput {
	/** When the order was PLACED — "Orders".created_at. */
	placed_at?: unknown;
	/**
	 * When the bill was SETTLED — "Bills".closed_at. Absent/null means the bill
	 * is still open and the clock is still running.
	 */
	settled_at?: unknown;
}

/** The one shape both clients render. Additive on every payload that carries it. */
export interface ServiceClock {
	/** ISO instant the service began, or null when the row carries no placed-at. */
	started_at: string | null;
	/** ISO instant the bill settled, or null while the table is still in service. */
	ended_at: string | null;
	/** Server-computed duration. Frozen once `running` is false. */
	elapsed_ms: number;
	/** True while the clock is still moving — the only reason to tick client-side. */
	running: boolean;
	/**
	 * The SERVER instant `elapsed_ms` was measured at. A client ticking a running
	 * clock adds the time elapsed on its own monotonic timer SINCE this response,
	 * never `Date.now() - started_at`, which would import the device's clock error.
	 */
	as_of: string;
}

/** Parse a pg timestamptz / Date / ISO string to epoch ms, or null if unreadable. */
function epochMs(value: unknown): number | null {
	if (value === null || value === undefined || value === "") { return null; }
	if (value instanceof Date) {
		const t = value.getTime();
		return Number.isFinite(t) ? t : null;
	}
	if (typeof value === "number") { return Number.isFinite(value) ? value : null; }
	// Only a STRING is parsed. Anything else (an object, an array, a stray row
	// the driver did not coerce) is "no timestamp" rather than whatever
	// String() would make of it — "[object Object]" parses to NaN, which would
	// then have to be caught downstream instead of here.
	if (typeof value !== "string") { return null; }
	const t = Date.parse(value);
	return Number.isFinite(t) ? t : null;
}

/** A clock that exists but has no origin — see "ABSENT IS NOT ZERO" in the header. */
function nullClock(nowMs: number): ServiceClock {
	return { started_at: null, ended_at: null, elapsed_ms: 0, running: false, as_of: new Date(nowMs).toISOString() };
}

/**
 * The service clock for ONE order.
 *
 * `nowMs` is injectable so the tests can assert an exact duration rather than a
 * range; production always passes the server's own clock.
 */
export function serviceClock(input: ServiceClockInput, nowMs: number = Date.now()): ServiceClock {
	const started = epochMs(input.placed_at);
	if (started === null) { return nullClock(nowMs); }
	const ended = epochMs(input.settled_at);
	const running = ended === null;
	// CLAMPED AT ZERO, not left negative. The order row's created_at comes from
	// the DATABASE clock and `nowMs` from the APP SERVER's; a few hundred
	// milliseconds of skew between them is normal and would otherwise print a
	// table that has been in service for minus one second.
	const elapsed = Math.max(0, (running ? nowMs : ended) - started);
	return {
		started_at: new Date(started).toISOString(),
		ended_at: running ? null : new Date(ended).toISOString(),
		elapsed_ms: elapsed,
		running,
		as_of: new Date(nowMs).toISOString(),
	};
}

/**
 * The service clock for a TABLE, which is a bill made of several orders placed
 * at different times (B3: five interval orders are five KOTs on one bill).
 *
 * THE START IS THE EARLIEST ORDER AND THE END IS THE LAST SETTLEMENT, because
 * the question the floor actually asks is "how long have these guests been
 * sitting here" — not "how long since the most recent round". Taking the latest
 * order as the origin would reset the table's clock every time a guest ordered
 * another drink, which is precisely the display D2 is replacing.
 *
 * STILL RUNNING IF ANY ORDER IS UNSETTLED. A table with four settled orders and
 * one open one is a table that has not paid; reporting it as finished because
 * most of it is finished is the same class of error as the merge-bill phantom
 * revenue. Only when EVERY order carries a settle instant does the clock stop,
 * and it stops at the LAST of them.
 */
export function tableServiceClock(rows: readonly ServiceClockInput[], nowMs: number = Date.now()): ServiceClock {
	let earliestStart: number | null = null;
	let latestEnd: number | null = null;
	let anyRunning = false;
	let sawStart = false;

	for (const row of rows) {
		const started = epochMs(row.placed_at);
		if (started === null) { continue; }
		sawStart = true;
		if (earliestStart === null || started < earliestStart) { earliestStart = started; }
		const ended = epochMs(row.settled_at);
		if (ended === null) { anyRunning = true; continue; }
		if (latestEnd === null || ended > latestEnd) { latestEnd = ended; }
	}

	if (!sawStart || earliestStart === null) { return nullClock(nowMs); }
	// `anyRunning` wins over a recorded end: see the header.
	const running = anyRunning || latestEnd === null;
	return serviceClock(
		{ placed_at: new Date(earliestStart), settled_at: running || latestEnd === null ? null : new Date(latestEnd) },
		nowMs,
	);
}
