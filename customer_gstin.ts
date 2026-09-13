// Round 2, item 1 — THE CUSTOMER'S GSTIN ON A BILL (a corporate party's tax
// registration, printed under the bill header so the paper is claimable).
//
// Pure module — NO database, network or native dependencies (same rationale as
// phone_validation.ts / billing_math.ts), so routes/bills.ts and
// database_supabase.ts share ONE rule and the jest suite can exercise it without
// a tenant context. The web dashboard and the app mirror this rule for instant
// feedback; the server is the authority.
//
// ----------------------------------------------------------------------------
// THE RULE
// ----------------------------------------------------------------------------
// trim, uppercase, strip internal spaces ("29abcde 1234 f1z5" is what a cashier
// types off a visiting card), then the 15-character GSTIN shape:
//
//   2 digits      state code
//   5 letters     |
//   4 digits      | the party's PAN
//   1 letter      |
//   1 char 1-9A-Z entity number under that PAN
//   Z             fixed
//   1 char 0-9A-Z check character
//
// The check character is NOT verified against its mod-36 checksum. The contract
// every client builds against is the shape above, and a checksum the clients do
// not also compute would turn "the field went green" into a server 400 the
// cashier cannot explain.
//
// Blank CLEARS (null) rather than storing an empty string — the same rule the
// customer name follows — so a bill with no GSTIN prints no GSTIN line at all.

/** The one client-facing message for a bad GSTIN. Every 400 uses it verbatim. */
export const CUSTOMER_GSTIN_ERROR = "GSTIN must be 15 characters, e.g. 29ABCDE1234F1Z5";

/** The 503 sentence for a GSTIN write that reaches a database without migration 046. */
export const CUSTOMER_GSTIN_SCHEMA_PENDING_ERROR = "This server has not finished updating — try again shortly";

export const CUSTOMER_GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/**
 * Normalize a GSTIN typed into either bill-name dialog.
 *
 *   - { ok: true, value: null }               null / undefined / blank — CLEARS it
 *   - { ok: true, value: "29ABCDE1234F1Z5" }  a valid GSTIN, normalized
 *   - { ok: false }                           something was typed but it is not one
 *
 * "Omitted means unchanged" is the ROUTE's decision (it is a property of the
 * request body, not of the value), so undefined here simply reads as blank.
 */
export function normalizeCustomerGstin(raw: unknown): { ok: true; value: string | null } | { ok: false } {
	if (raw === null || raw === undefined) {return { ok: true, value: null };}
	// A number or an object is not a GSTIN; String() of it can never match the
	// pattern (it needs letters), so it falls through to the refusal below
	// instead of being special-cased.
	const s = (typeof raw === "string" ? raw : String(raw)).replace(/\s+/g, "").toUpperCase();
	if (s.length === 0) {return { ok: true, value: null };}
	return CUSTOMER_GSTIN_PATTERN.test(s) ? { ok: true, value: s } : { ok: false };
}

/**
 * Thrown by the data layer when a GSTIN WRITE reaches a database on which
 * migration 046 ("Bills".customer_gstin) has not been applied yet. Routes answer
 * it with 503 and CUSTOMER_GSTIN_SCHEMA_PENDING_ERROR. A name-only edit never
 * throws it — the name has no column of its own.
 */
export class CustomerGstinSchemaPendingError extends Error {
	constructor() {
		super(CUSTOMER_GSTIN_SCHEMA_PENDING_ERROR);
		this.name = "CustomerGstinSchemaPendingError";
	}
}

/** Thrown by the data layer for a GSTIN that fails normalizeCustomerGstin. Routes answer 400. */
export class CustomerGstinInvalidError extends Error {
	constructor() {
		super(CUSTOMER_GSTIN_ERROR);
		this.name = "CustomerGstinInvalidError";
	}
}
