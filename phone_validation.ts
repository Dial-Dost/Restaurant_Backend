// Single source of truth for mobile-number validation on WRITE paths.
//
// Pure module — NO database, network or native dependencies (same rationale as
// billing_math.ts / analytics_explainers.ts), so index.ts and
// database_supabase.ts can both import it and the jest suite can exercise it
// without a tenant context.
//
// Product rule (Indian mobile): a guest/staff mobile number is EXACTLY 10
// digits. Nothing shorter, nothing longer. Formatting noise (spaces, dashes,
// brackets, a leading "+91" or "0091" or "0") is stripped before the length is
// checked, so a number pasted from a contacts app still validates.
//
// Deliberately NOT enforced: a leading 6-9 series check. The codebase never had
// one, and inventing it here would start rejecting numbers the product accepted
// yesterday.
//
// Scope: NEW writes only. Rows already stored with other lengths (legacy CRM
// entries, imported customers) are never rewritten or re-validated — lookup
// paths keep accepting whatever is on the row.

/** The one client-facing message for a bad mobile number. Every 400 uses it verbatim. */
export const MOBILE_10_ERROR = "Enter a 10-digit mobile number";

/**
 * Strip formatting and return the number only when it is exactly 10 digits.
 *
 * Accepts an Indian country prefix and/or a trunk 0 before the 10 digits
 * ("+91 98765 43210", "0091-9876543210", "09876543210") and returns the bare
 * 10-digit form. Anything else — 9 digits, 11 digits, letters only, empty —
 * returns null.
 *
 * @returns the normalized 10-digit string, or null when the input is not a
 *          valid 10-digit mobile number.
 */
export function normalizeMobile10(raw: unknown): string | null {
	if (raw === null || raw === undefined) {return null;}
	let digits = String(raw).replace(/[^0-9]/g, "");
	// Peel a country code / trunk prefix so the *subscriber* number is measured.
	// Only ever peels down TO 10 digits — never below, so a 9-digit number stays
	// 9 digits and is rejected.
	if (digits.length === 13 && digits.startsWith("0091")) {digits = digits.slice(4);}
	if (digits.length === 12 && digits.startsWith("91")) {digits = digits.slice(2);}
	if (digits.length === 11 && digits.startsWith("0")) {digits = digits.slice(1);}
	return digits.length === 10 ? digits : null;
}

/**
 * Optional-field variant. Returns:
 *   - { ok: true, value: null }          when the field was left blank (allowed)
 *   - { ok: true, value: "9876543210" }  when it is a valid 10-digit number
 *   - { ok: false }                      when something was typed but is not 10 digits
 *
 * Use on endpoints where the phone is genuinely optional (guest QR order,
 * walk-in queue join, employee record) so blank stays blank but a typo is still
 * a clean 400 instead of a silently-stored broken number.
 */
export function normalizeOptionalMobile10(raw: unknown): { ok: true; value: string | null } | { ok: false } {
	if (raw === null || raw === undefined) {return { ok: true, value: null };}
	const s = String(raw).trim();
	if (s.length === 0) {return { ok: true, value: null };}
	const normalized = normalizeMobile10(s);
	return normalized ? { ok: true, value: normalized } : { ok: false };
}
