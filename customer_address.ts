// Client item 7 — THE GUEST'S ADDRESS ON A BILL. "An option in the tables
// section to add the ADDRESS of a guest to the bill, like name and GSTIN,
// especially for corporate parties." A tax invoice to a registered party
// carries the recipient's name, address and GSTIN (GST Rule 46), so the address
// rides beside the two fields round 2 item 1 already put on the bill.
//
// Pure module — NO database, network or native dependencies (the same
// rationale as customer_gstin.ts), so routes/bills.ts, database_supabase.ts and
// escpos.ts share ONE rule and the jest suite can exercise it without a tenant
// context. The web dashboard and the app mirror this rule for instant feedback;
// the server is the authority.
//
// ----------------------------------------------------------------------------
// THE RULE
// ----------------------------------------------------------------------------
//   * line breaks are KEPT — an address is typed as lines ("4th Floor, Prestige
//     Tower" / "12 Residency Road" / "Bengaluru 560025") and prints as lines.
//     CRLF, CR and the Unicode line/paragraph separators all become LF;
//   * every other control character is dropped, each line is trimmed, and a run
//     of spaces or tabs inside a line becomes one space;
//   * blank lines are dropped, so a trailing Enter never prints as a gap;
//   * nothing left CLEARS it (null), the rule the name and GSTIN follow;
//   * MORE THAN 5 LINES OR MORE THAN 250 CHARACTERS IS REFUSED, NEVER CUT. The
//     name is silently sliced at 120 because a long name is still a name; half
//     an address on a tax invoice is a wrong address, and the person typing it
//     is the only one who can decide what to leave out. 250 counts the stored
//     value, line breaks included — what the column holds is what is measured.
//
// Non-ASCII is accepted (a guest's address can be in any script) and printed
// the way every other bill field is: escpos.ts folds it to ASCII, so what the
// printer cannot draw comes out as "?". The clients say so under the box.

/** Lines an address may have once blank ones are dropped. */
export const CUSTOMER_ADDRESS_MAX_LINES = 5;

/** Characters the stored address may have, its line breaks included. */
export const CUSTOMER_ADDRESS_MAX_CHARS = 250;

/** The one client-facing message for an address over either limit. Every 400 uses it verbatim. */
export const CUSTOMER_ADDRESS_ERROR = "Address can be at most 5 lines and 250 characters";

/** The label the paper, the preview and the settled sheet put before the first line. */
export const CUSTOMER_ADDRESS_LABEL = "Address:";

/**
 * The 503 sentence for an address write that reaches a database without
 * migration 054 — the GSTIN's sentence, word for word, because the person
 * holding the till is being told the same thing.
 */
export const CUSTOMER_ADDRESS_SCHEMA_PENDING_ERROR = "This server has not finished updating — try again shortly";

/**
 * Normalize an address typed into either bill-name dialog.
 *
 *   - { ok: true, value: null }       null / undefined / nothing but whitespace — CLEARS it
 *   - { ok: true, value: "a\nb" }     the address, normalized, lines joined by LF
 *   - { ok: false }                   not a string, or over a limit
 *
 * "Omitted means unchanged" is the ROUTE's decision (a property of the request
 * body, not of the value), so undefined here simply reads as blank.
 */
export function normalizeCustomerAddress(raw: unknown): { ok: true; value: string | null } | { ok: false } {
	if (raw === null || raw === undefined) {return { ok: true, value: null };}
	// A number or an object is not an address. Unlike a GSTIN, String() of one
	// could pass every check below, so it is refused here rather than printed.
	if (typeof raw !== "string") {return { ok: false };}
	const lines = raw
		.replace(/\r\n?|[\u0085\u2028\u2029]/g, "\n")
		// Tabs first, so a tab between two words is a space and not a join.
		.replace(/\t/g, " ")
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
		.split("\n")
		.map((l) => l.replace(/\s+/g, " ").trim())
		.filter((l) => l.length > 0);
	if (lines.length === 0) {return { ok: true, value: null };}
	const value = lines.join("\n");
	if (lines.length > CUSTOMER_ADDRESS_MAX_LINES || value.length > CUSTOMER_ADDRESS_MAX_CHARS) {return { ok: false };}
	return { ok: true, value };
}

/**
 * THE ADDRESS AS THE BILL PRINTS IT: one entry per stored line, the first one
 * labelled — `Address: <line 1>`, then `<line 2>`, … — to be word-wrapped ONE
 * ENTRY AT A TIME by the renderer.
 *
 * SPLIT BEFORE WRAPPING, OR THE LINES ARE LOST. Both wrapText implementations
 * (escpos.ts, the web's bill-escpos.ts) split on any whitespace, so an address
 * handed over as one string reflows "…Tower\n12 Residency Road" into
 * "…Tower 12 Residency Road". The web's billCustomerLines and the app's
 * billCustomerLines make exactly these entries, so the three bills agree.
 *
 * Empty for a bill with none — and a JSON-round-tripped "null"/"undefined" is
 * none, the rule every header field on the bill obeys.
 */
export function customerAddressBillLines(address: string | null | undefined): string[] {
	const s = String(address ?? "").trim();
	if (s === "" || /^(null|undefined)$/i.test(s)) {return [];}
	return s
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.map((l, i) => (i === 0 ? `${CUSTOMER_ADDRESS_LABEL} ${l}` : l));
}

/**
 * Thrown by the data layer when an ADDRESS write reaches a database on which
 * migration 054 ("Bills".customer_address) has not been applied and the
 * runtime could not add it at boot. Routes answer it with 503 and
 * CUSTOMER_ADDRESS_SCHEMA_PENDING_ERROR. A name- or GSTIN-only edit never
 * throws it.
 */
export class CustomerAddressSchemaPendingError extends Error {
	constructor() {
		super(CUSTOMER_ADDRESS_SCHEMA_PENDING_ERROR);
		this.name = "CustomerAddressSchemaPendingError";
	}
}

/** Thrown by the data layer for an address that fails normalizeCustomerAddress. Routes answer 400. */
export class CustomerAddressInvalidError extends Error {
	constructor() {
		super(CUSTOMER_ADDRESS_ERROR);
		this.name = "CustomerAddressInvalidError";
	}
}
