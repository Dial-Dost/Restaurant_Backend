/**
 * Shared HTTP layer for the split route modules.
 *
 * Owns the request-context helpers (auth identity, outlet/restaurant resolution),
 * the guard factories used in registration position (validate, validateAction,
 * validateBody, rateLimit), the permission-UUID catalogue, audit logging, the
 * env-derived config constants, and the cross-domain helpers that more than one
 * route module (or index.ts itself) needs.
 *
 * This module is a LEAF: it imports from the data/infra layer only, never from
 * index.ts and never from a routes/ module, so there is no import cycle.
 */
import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "crypto";
import { z } from "zod";
import { destroyAllForEmployee } from "../auth/sessions.js";
import { getStore } from "../auth/store.js";
import type { CustomerDemographics } from "../database_supabase.js";
import { AddAuditLogEntry, AddCustomer, AddEmailToCustomer, AddNotification, Audit_log_category, GetCustomerId, GetDueBookingReminders, GetEmployeeDetailsFromEmpID, GetMessagingConfig, GetRestaurantLogoRaw, GetRestaurantAccountStatus, GetRestaurantProfile, GetRestaurantRazorpayKeys, GetRestaurantSettings, GetSuperadminEmployeeId, GetTableFeedbackContext, MarkBookingReminderSent, RecordOutboundMessage, SetOrderCustomerId, UpdateCustomerDemographics, sanitizeTimezone, withTenant, zonedWallToUtc } from "../database_supabase.js";
import { logger } from "../observability.js";
import { MOBILE_10_ERROR, normalizeMobile10, normalizeOptionalMobile10 } from "../phone_validation.js";
import type { ReportWindowQuery } from "../report_window.js";
import { emitRestaurant } from "../realtime.js";


// Python feedback service URL. Use container host (PY_SERVER_URL) when set,
// otherwise fall back to localhost with optional port override.
export const PY_SERVER_URL = process.env.PY_SERVER_URL ?? `http://127.0.0.1:${process.env.PY_SERVER_PORT ?? "8000"}`;

// Where the customer feedback form is hosted. The printed-bill QR and the
// post-payment redirect both point here, carrying the table's assigned waiter so
// the rating is credited to them. The form now lives INSIDE the dashboard app at
// /feedback, so the default derives from DASHBOARD_BASE_URL; setting
// FEEDBACK_BASE_URL still wins (e.g. an operator keeping the old standalone
// Restaurant_Feedback_UI deployment).
const FEEDBACK_BASE_URL = (
	process.env.FEEDBACK_BASE_URL ??
	`${(process.env.DASHBOARD_BASE_URL ?? "http://localhost:9002").replace(/\/+$/, "")}/feedback`
).replace(/\/+$/, "");

// Build the feedback-form URL for a table, encoding the restaurant, the table's
// assigned waiter (eid) and outlet (oid). Returns null when the table has no
// waiter assigned (the form requires a real employee to attribute the rating).
export async function feedbackUrlForTable(slug: string, tableName: string): Promise<string | null> {
	try {
		const ctx = await GetTableFeedbackContext(slug, tableName);
		if (!ctx) {return null;}
		// Always include rid + oid so the customer is redirected to the feedback
		// form; include eid only when a waiter could be resolved (for attribution).
		const qs = new URLSearchParams({ rid: slug, oid: ctx.outlet_id });
		if (ctx.employee_id) {qs.set("eid", ctx.employee_id);}
		// No "/" before the query: the base may now carry a path (…/feedback), and
		// "…/feedback/?rid=" would bounce through Next's trailing-slash redirect.
		return `${FEEDBACK_BASE_URL}?${qs.toString()}`;
	} catch {
		return null;
	}
}

// Retained for the public auth/health/reception routes that legitimately run
// without a session. Authenticated routes are gated by requireAuth, not this.
export function validate(_req: Request, _res: Response, next: NextFunction) {
	next();
}

// Authorize against the permitted action UUIDs resolved at login and stored on
// the verified session (req.auth) — never from a client-supplied header.
export function validateAction(expectedUUID: string) {
	return (req: Request, res: Response, next: NextFunction) => {
		const actions = req.auth?.actions ?? [];
		if (!actions.includes(expectedUUID) && !actions.includes("*")) {
			res.status(403).json({ error: "Action not permitted" });
			return;
		}
		next();
	};
}

export async function log_audit(req: Request, action_id: string, action_description: string, category: Audit_log_category, additional_details?: Record<string, any>) {
	const employeeID = extractEmployeeId(req);
	if (!employeeID) {throw new Error("Cannot log audit entry without employee ID");}
	const emp_dets = await GetEmployeeDetailsFromEmpID(employeeID);
	if (!emp_dets) {throw new Error("Employee details not found for ID");}
	await AddAuditLogEntry(
		emp_dets.res_id,
		// The outlet the write actually landed on, NOT the actor's home outlet: an
		// admin acting on another branch via the X-Outlet-Id override was leaving
		// that branch's audit trail with no record of the change, since GetAuditLogs
		// (and PerformAuditUndo) scope to the ACTIVE outlet.
		extractOutletId(req),
		employeeID,
		action_id,
		action_description,
		category,
		additional_details
	);
}


type AppRole = "admin" | "employee" | "valet" | "waiter" | "cashier" | "captain" | "manager";

export function normalizeRole(rawRole: unknown): AppRole | null {
	if (typeof rawRole !== "string") {
		return null;
	}

	const lowered = rawRole.trim().toLowerCase();
	if (lowered === "admin" || lowered === "employee" || lowered === "valet" || lowered === "waiter" || lowered === "cashier" || lowered === "captain" || lowered === "manager") {
		return lowered;
	}

	return null;
}

interface AuthContext {
	employeeId: string;
	res_id: string;
	outlet_id: string;
	role: AppRole;
	role_all: string[];
	actions: string[];
	features: Record<string, unknown>;
	limits: Record<string, unknown>;
	// ALL-OUTLETS aggregate READ mode: set when an admin/manager sends the
	// X-Outlet-Id "all" sentinel. outlet_id above stays a CONCRETE default outlet
	// (so writes/app.outlet_id are real); reads span every outlet of the res_id.
	// Mutations are rejected while true (write guard in requireAuth).
	allOutlets: boolean;
}

declare global {
	namespace Express {
		interface Request {
			auth?: AuthContext;
		}
	}
}

export function extractBearerToken(req: Request): string | null {
	const header = req.headers.authorization;
	const value = Array.isArray(header) ? header[0] : header;
	if (typeof value === "string" && value.toLowerCase().startsWith("bearer ")) {
		const token = value.slice(7).trim();
		return token.length > 0 ? token : null;
	}
	return null;
}

// Tenant identity comes only from the verified session (req.auth), never from
// client-supplied headers/query/body.
export function extractRestaurantId(req: Request): string | null {
	return req.auth?.res_id ?? null;
}

/**
 * The ONE way a reporting route reads a date window off the query string.
 *
 * It deliberately does NOT parse, validate or clamp: the tenant's timezone
 * decides what "2026-08-01" means and only the data layer has it, so the raw
 * values travel down and report_window.ts resolves them ONCE against that zone.
 * A route that pre-parsed here would be answering a calendar question in the
 * SERVER's zone, which is the bug this whole contract exists to remove.
 *
 * `from`/`to` are inclusive YYYY-MM-DD days and win over `days`; `days` is the
 * rolling span the shipped clients send and still means the last N days ending
 * today. See report_window.ts for the precedence and every clamp.
 */
export function windowQuery(req: Request): ReportWindowQuery {
	return { from: req.query.from, to: req.query.to, days: req.query.days };
}

export function extractRestaurantUsername(req: Request): string | null {
	const headerValue = req.headers["x-restaurant-username"];
	const headerId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
	if (typeof headerId === "string" && headerId.trim().length > 0) {
		return headerId.trim();
	}

	const queryValue = req.query.restaurantUsername;
	const queryId = Array.isArray(queryValue) ? queryValue[0] : queryValue;
	if (typeof queryId === "string" && queryId.trim().length > 0) {
		return queryId.trim();
	}

	const body = req.body as Record<string, unknown> | undefined;
	const bodyValue = body?.restaurantUsername;
	if (typeof bodyValue === "string" && bodyValue.trim().length > 0) {
		return bodyValue.trim();
	}

	return null;
}

export function extractEmployeeId(req: Request): string | null {
	return req.auth?.employeeId ?? null;
}

export async function enforceRoles(
	req: Request,
	res: Response,
	allowedRoles: readonly AppRole[],
): Promise<{ restaurantId: string; role: AppRole; outletId: string } | null> {
	const auth = req.auth;
	if (!auth) {
		res.status(401).json({ error: "Unauthorized", details: "Missing session" });
		return null;
	}

	if (!allowedRoles.includes(auth.role)) {
		res.status(403).json({ error: "Forbidden", requiredRoles: allowedRoles });
		return null;
	}

	return { restaurantId: auth.res_id, role: auth.role, outletId: extractOutletId(req) };
}

export async function enforceRolesIgnoreOutletID(
	req: Request,
	res: Response,
	allowedRoles: readonly AppRole[],
): Promise<{ restaurantId: string; role: AppRole; } | null> {
	const auth = req.auth;
	if (!auth) {
		res.status(401).json({ error: "Unauthorized", details: "Missing session" });
		return null;
	}

	if (!allowedRoles.includes(auth.role)) {
		res.status(403).json({ error: "Forbidden", requiredRoles: allowedRoles });
		return null;
	}

	return { restaurantId: auth.res_id, role: auth.role };
}

// Admin gate for sensitive configuration (settings, branding, user/role admin).
// Checks BOTH the primary role and the full role set so a multi-role employee
// who has been granted "admin" passes, while a waiter never can — even if the
// client UI mistakenly exposes the control.
export async function enforceAdmin(
	req: Request,
	res: Response,
): Promise<{ restaurantId: string; outletId: string } | null> {
	const auth = req.auth;
	if (!auth) {
		res.status(401).json({ error: "Unauthorized", details: "Missing session" });
		return null;
	}
	const roles = [auth.role, ...(auth.role_all ?? [])].map((r) => String(r).toLowerCase());
	if (!roles.includes("admin")) {
		res.status(403).json({ error: "Forbidden", details: "Admin access required", requiredRoles: ["admin"] });
		return null;
	}
	return { restaurantId: auth.res_id, outletId: extractOutletId(req) };
}

// Stable Action UUIDs for the feature-permission gates below. Seeded into the
// global "Actions" table by ensureFeaturePermissionActions() at boot, so each
// auto-appears as a grantable checkbox (grouped) in both role-creation UIs.
// Admin ("*") always passes these; a custom role passes only if granted the UUID.
export const PERM_CAMPAIGNS = "3f9a1c72-6b04-4e19-9d2a-8c5e7f01a4b3"; // Manage Campaigns (Customer)
export const PERM_COUPONS = "7c1e4d90-2a6b-4f83-b5c1-9e0d6a2f3418"; // Manage Coupons & Vouchers (Customer)
export const PERM_MESSAGING = "5b8d2f16-4c93-47a0-a1e6-3d7f9b0c5e24"; // Guest Messaging (Customer)
export const PERM_DISCOUNTS = "9a3c6e81-7d40-4b52-8f19-2c6b4a0e7d35"; // Approve Discounts (Bills)
export const PERM_ATTENDANCE = "2e7b9c40-1f83-4d6a-b902-5a8c3e1f6047"; // Review Attendance (Restaurant Specific)
export const PERM_SETTINGS = "6d0f3a94-8b21-4c67-9e53-1a4d7b2f8c60"; // Manage Restaurant Settings (Restaurant Specific)
export const PERM_BRANDING = "4a1c8e73-5f60-49b2-a3d8-7c2e0b6f9153"; // Manage Branding (Restaurant Specific)
export const PERM_BILLING = "1c6e9b34-7a52-4f80-9d13-3b8c5a0e6f27"; // Manage Subscription & Billing (Restaurant Specific)
export const PERM_PASSWORDS = "0b4d7f92-6c81-43a5-b7e0-2f9a1c8d5e36"; // Manage User Passwords (Roles)
// Split out of over-broad permissions (audit 2026-07-27): "Add Orders" used to
// let a WAITER delete an order and settle it to Paid, and "Update Menu" covered
// category deletion plus the full-menu replace. Destructive/financial work is
// now grantable on its own instead of riding along with everyday duties.
export const PERM_ORDER_DELETE = "8c3f5b21-0e74-4a96-b2d8-6f1a9c4e7b53"; // Delete Orders (Orders)
export const PERM_MENU_CAT_DELETE = "3d9e7a05-6c18-4f2b-9a41-8b5d0e3c6f72"; // Delete Menu Categories (Menu)
export const PERM_MENU_BULK_REPLACE = "7b2c9d48-3a51-4e07-8d6f-1c4e5a9b0837"; // Bulk Replace Menu (Menu)
export const PERM_FEEDBACK_RESOLVE = "5e8a1f36-9b47-42c0-a7e5-0d3b6c8f4291"; // Resolve Feedback Recovery (Feedback Questions)
export const PERM_CLOSE_BILL = "a953d044-31ba-4e31-b96f-99304fe43dfa"; // Close Bill (Bills) — required to settle an order to Paid
export const PERM_VALET_CHARGE = "6c2e8a4d-7f1b-4d9c-8e35-b0a4d6c2f791"; // Valet Charge to Bill (existing, was unused as a gate)
export const PERM_VALET_OPS = "8e4b2d6f-3a1c-4f7e-9b05-d2c6a8e0f413"; // Valet Ops Update (existing, was unused as a gate)
export const PERM_VALET_KEYS = "4a7d1c9e-5b3f-4e8a-a6d2-0c9f7b3e5a18"; // Valet Key Log (existing, was unused as a gate)
// Floor-section ADMINISTRATION. Split out of "Table Added" (194ce6ee…), which
// section create/rename/delete used to ride on. See TABLE_SECTION_PERM below for
// why MOVING a table between existing sections deliberately stays on 194ce6ee.
export const PERM_TABLE_SECTIONS = "2f7c5a94-8e13-4b60-9d27-6a0f3c8e5b41"; // Manage Table Sections (Tables)
// AUDIT LABEL ONLY — never passed to validateAction. Editing a table stays gated
// on "Table Added" (194ce6ee…), which every floor role already holds; gating on
// this id would strip that ability from every existing role the moment migration
// 023 landed. Audit titles render from "Actions".action_name, so without this row
// every move and capacity edit was filed under "Table Added" and was unfindable.
export const AUDIT_TABLE_UPDATED = "526c6b48-4036-4d0d-b617-b34acba3a1d2"; // Table Updated (Tables)

// Permission gate for a specific granted Action. Admin (actions include "*")
// always passes; any role granted this action UUID passes; everyone else 403.
// Same return shape as enforceAdmin so it's a drop-in swap in handler bodies.
export async function enforcePermission(req: Request, res: Response, actionId: string): Promise<{ restaurantId: string; outletId: string } | null> {
	const auth = req.auth;
	if (!auth) { res.status(401).json({ error: "Unauthorized", details: "Missing session" }); return null; }
	const actions = auth.actions ?? [];
	if (!actions.includes(actionId) && !actions.includes("*")) {
		res.status(403).json({ error: "Forbidden", details: "You do not have permission for this action" });
		return null;
	}
	return { restaurantId: auth.res_id, outletId: extractOutletId(req) };
}

// Revoke every live session of an employee. Must run whenever the identity or
// the permissions behind an issued token change — the employee is deleted, their
// password is reset, or their roles change — because session.actions is resolved
// ONCE at login and refreshTtl slides the TTL on every request, so an un-revoked
// token would otherwise stay valid (with stale permissions) indefinitely.
// Best-effort: a store failure is logged, never surfaced as a request failure.
export async function revokeEmployeeSessions(employeeId: string, reason: string): Promise<void> {
	if (!employeeId) {return;}
	try {
		await destroyAllForEmployee(employeeId);
	} catch (err) {
		logger.error({ err, employeeId, reason }, "revoke_employee_sessions_failed");
	}
}

// Non-responding permission check (for handlers that shape their own response
// instead of rejecting — e.g. redacting fields the caller may not read).
export function callerHasPermission(req: Request, actionId: string): boolean {
	const actions = req.auth?.actions ?? [];
	return actions.includes(actionId) || actions.includes("*");
}

// Non-responding admin check (for guards that decide their own error).
export function callerIsAdmin(req: Request): boolean {
	const auth = req.auth;
	if (!auth) {return false;}
	return [auth.role, ...(auth.role_all ?? [])].map((r) => String(r).toLowerCase()).includes("admin");
}

// Core roles that expand to elevated/["*"] permissions — grantable only by an admin.
export function isPrivilegedRoleName(roleName: string): boolean {
	return ["admin", "manager"].includes(roleName.trim().toLowerCase());
}

// Only the restaurant OWNER (super-admin = earliest-created admin) may grant or
// revoke the admin role itself — a regular admin cannot mint more admins.
export function isAdminRoleName(roleName: string): boolean {
	return roleName.trim().toLowerCase() === "admin";
}
export async function callerIsSuperadmin(req: Request): Promise<boolean> {
	const auth = req.auth;
	if (!auth) {return false;}
	try {
		const superId = await GetSuperadminEmployeeId(auth.res_id);
		return !!superId && superId === auth.employeeId;
	} catch {
		return false;
	}
}

// Return an error message safe to show an anonymous customer: our own thrown
// business errors pass through, but raw Postgres/driver errors (which carry a
// 5-char SQLSTATE code and can leak table/column/constraint names) are replaced
// with a generic message — public /qr/* & /feedback/* handlers use this.
export function safeClientError(err: unknown, fallback: string): string {
	const e = err as { code?: unknown; severity?: unknown; message?: unknown } | null;
	const isPgError = !!e && ((typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) || typeof e.severity === "string");
	if (isPgError) {return fallback;}
	const msg = typeof e?.message === "string" ? e.message : "";
	return msg && msg.length <= 200 ? msg : fallback;
}

// Sentinel an admin/manager sends as the outlet id (X-Outlet-Id header / ?outletId
// / body.outletId) to request an AGGREGATE READ across every outlet of their own
// restaurant. Case-insensitive; "__all__" is accepted as an alias so callers can
// disambiguate from a literal outlet named "all". This mode is READ-ONLY — any
// mutation while it is active is rejected (see the write guard in requireAuth).
// Ignored for non-privileged roles (they stay pinned to their session outlet).
const ALL_OUTLETS_SENTINELS = new Set(["all", "__all__"]);
export function isAllOutletsSentinel(value: string | null | undefined): boolean {
	return typeof value === "string" && ALL_OUTLETS_SENTINELS.has(value.trim().toLowerCase());
}

// Admins/managers may act across outlets within their own restaurant; everyone
// else is pinned to their session outlet. RLS still bounds all of them to res_id.
export function rawRequestedOutletId(req: Request): string | null {
	const headerValue = req.headers["x-outlet-id"];
	const headerId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
	if (typeof headerId === "string" && headerId.trim().length > 0) {
		return headerId.trim();
	}

	const queryValue = req.query.outletId;
	const queryId = Array.isArray(queryValue) ? queryValue[0] : queryValue;
	if (typeof queryId === "string" && queryId.trim().length > 0) {
		return queryId.trim();
	}

	const body = req.body as Record<string, unknown> | undefined;
	const bodyValue = body?.outletId;
	if (typeof bodyValue === "string" && bodyValue.trim().length > 0) {
		return bodyValue.trim();
	}

	return null;
}

export function extractOutletId(req: Request): string {
	const auth = req.auth;
	if (!auth) {
		throw new Error("Missing authenticated context");
	}
	// Always the outlet requireAuth RESOLVED and bound the connection to: a
	// validated (and canonicalised) X-Outlet-Id override for an admin/manager, or
	// the session outlet. Never the raw header — an unvalidated value here used to
	// let a write land on an outlet the caller never proved membership of, and the
	// "all" sentinel is not a real outlet at all.
	return auth.outlet_id;
}

// fetch with a hard timeout so a hung external dependency (payment gateway,
// OpenAI, the feedback service) can't tie up a request indefinitely.
// NOTE: `Response` is shadowed by Express's Response in this file, so the return
// type is derived from the global fetch instead of naming it.
export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 12000): Promise<Awaited<ReturnType<typeof fetch>>> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => { ctrl.abort(); }, timeoutMs);
	try {
		return await fetch(url, { ...init, signal: ctrl.signal });
	} finally {
		clearTimeout(timer);
	}
}

// --- Mobile-number gate (WRITE paths) ---------------------------------------
// Indian mobile numbers are exactly 10 digits, so every endpoint that STORES a
// phone runs it through the shared validator (phone_validation.ts) and rejects
// anything else with one consistent 400 — a client cannot bypass the UI's
// maxLength by calling the API directly.
//
// Applies to NEW writes only: lookup-by-phone paths (loyalty balance, coupon
// eligibility) still accept whatever is on existing rows, so customers stored
// with other lengths before this rule keep working.

/** Required phone. Returns the normalized 10 digits, or null AFTER sending the 400. */
export function requireMobile10(res: Response, raw: unknown): string | null {
	const value = normalizeMobile10(raw);
	if (!value) {
		res.status(400).json({ error: MOBILE_10_ERROR });
		return null;
	}
	return value;
}

/**
 * Optional phone. Blank/absent is allowed (value null); anything typed must be
 * exactly 10 digits. On failure the 400 is already sent and `ok` is false.
 */
export function optionalMobile10(res: Response, raw: unknown): { ok: true; value: string | null } | { ok: false } {
	const result = normalizeOptionalMobile10(raw);
	if (!result.ok) {
		res.status(400).json({ error: MOBILE_10_ERROR });
		return { ok: false };
	}
	return result;
}

// Minimum password policy for account-creation / reset paths. Returns an error
// message, or null when the password is acceptable.
const COMMON_WEAK_PASSWORDS = new Set([
	"password", "password1", "password123", "12345678", "123456789", "1234567890",
	"qwerty123", "admin123", "letmein1", "welcome1", "iloveyou", "changeme",
]);
export function passwordPolicyError(pw: string): string | null {
	if (typeof pw !== "string" || pw.length < 10) {
		return "Password must be at least 10 characters long.";
	}
	if (COMMON_WEAK_PASSWORDS.has(pw.toLowerCase())) {
		return "That password is too common. Please choose a stronger one.";
	}
	if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) {
		return "Password must contain both letters and numbers.";
	}
	return null;
}

// --- The guest/partner write gate -------------------------------------------
//
// THE FAILURE THIS CLOSES. index.ts:306 exempts the whole /qr/ prefix from the
// tenant auth gate, and /aggregator/order is in PUBLIC_PATHS (:297), so those
// handlers resolve a tenant straight from the URL slug (or an API key) and
// proceed. Nothing on that surface has ever read account_status. An ARCHIVED
// restaurant therefore kept accepting guest QR orders, coupon applications,
// payments, reservations, waitlist joins and Swiggy/Zomato intake — while the
// operator console showed it as gone and, crucially, while NOBODY COULD SIGN IN
// TO COOK OR SETTLE any of it, because archiving revokes every session and blocks
// every login. Orders accumulate against bills that can never be closed.
//
// WHY IT GATES EVERY NON-ACTIVE STATUS, not just 'archived'. Suspended and
// expired tenants are locked out of their own POS by the same login gate
// (routes/auth.ts:141), so guest orders land in exactly the same unsettleable
// pile. A gate that special-cased 'archived' would be a second lifecycle rule to
// keep in sync with platform.restaurant_status, and the first one to drift.
// past_due WITHIN grace still reads 'active' (migrations/011_billing_grace.sql:21),
// so a merely-late tenant keeps trading — this only bites tenants who are already
// shut out of their own dashboard.
//
// IT IS ADDITIVE AND FAILS OPEN. GetRestaurantAccountStatus returns 'active' when
// the control plane is not deployed or the lookup errors (database_supabase.ts:
// 24829-24835), so a deployment without the platform schema, or a blip, behaves
// exactly as before rather than closing every restaurant's QR ordering.
export async function restaurantAcceptsGuestWrites(resId: string): Promise<boolean> {
	return (await GetRestaurantAccountStatus(resId)) === "active";
}

/**
 * The guest-facing half of the gate. Answers 404 with the SAME body the unknown-
 * slug branch of every /qr/ handler already returns, and reports whether the
 * caller should stop.
 *
 * WHY 404 AND NOT 403. The response is read by a stranger holding a printed QR
 * code, and it is the tenant's dignity being spent: "Restaurant not found" is
 * what a guest can act on (this menu is dead), whereas "suspended" broadcasts a
 * restaurant's billing trouble to its own customers. It also needs no client
 * change — the guest pages already handle this exact 404 — and it can never
 * surface as a 500.
 */
export async function refuseGuestWriteIfClosed(res: Response, resId: string): Promise<boolean> {
	if (await restaurantAcceptsGuestWrites(resId)) {return false;}
	res.status(404).json({ error: "Restaurant not found" });
	return true;
}

// Clamp a client-supplied ?limit= to a sane range so a huge/negative value can't
// turn a list endpoint into a DoS (unbounded scan) or error.
export function clampLimit(raw: unknown, def = 100, max = 500): number {
	const v = Array.isArray(raw) ? raw[0] : raw;
	const n = (typeof v === "string" || typeof v === "number") ? Number.parseInt(String(v), 10) : NaN;
	if (!Number.isFinite(n) || n <= 0) {return def;}
	return Math.min(n, max);
}

// Upper bound of a date range. A bare "YYYY-MM-DD" parses as MIDNIGHT, so
// `to=2026-07-28` silently excluded everything that happened on the 28th — never
// what a date picker means. Widen a bare date to the end of that day; anything
// that already carries a time (full ISO) is passed through untouched.
export function endOfDayBound(raw: unknown): string | undefined {
	const v = Array.isArray(raw) ? raw[0] : raw;
	if (typeof v !== "string" || v.trim().length === 0) {return undefined;}
	const s = v.trim().slice(0, 40);
	return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:59.999Z` : s;
}

// Validate req.body against a zod schema and 400 on failure (replaces the no-op
// `validate` for routes where the shape is known). On success req.body is the
// parsed/coerced data. Apply to new/abuse-prone routes; broaden over time.
export function validateBody(schema: z.ZodTypeAny) {
	return (req: Request, res: Response, next: NextFunction) => {
		const result = schema.safeParse(req.body ?? {});
		if (!result.success) {
			res.status(400).json({
				error: "Invalid request body.",
				details: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
			});
			return;
		}
		req.body = result.data;
		next();
	};
}

// Constant-time string comparison for secrets/signatures (avoids timing oracles).
export function timingSafeStrEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) {return false;}
	try {
		return timingSafeEqual(ab, bb);
	} catch {
		return false;
	}
}

// Rate limiter for abuse-prone public routes: brute-forcing logins, enumerating
// coupon codes, spamming reset requests. Keyed by client IP (needs `trust proxy`
// so req.ip is the real IP behind Railway's proxy). Backed by the shared session
// store — Redis-backed in production so the window is enforced FLEET-WIDE rather
// than multiplied per replica; in-memory otherwise. Fails OPEN on a store error
// so a transient Redis blip never locks out all users.
export function rateLimit(label: string, maxPerWindow: number, windowMs: number) {
	const ttlSeconds = Math.max(1, Math.ceil(windowMs / 1000));
	return (req: Request, res: Response, next: NextFunction) => {
		const ip = req.ip || req.socket?.remoteAddress || "unknown";
		const key = `rl:${label}:${ip}`;
		void (async () => {
			try {
				const store = await getStore();
				const count = await store.incr(key, ttlSeconds);
				if (count > maxPerWindow) {
					res.setHeader("Retry-After", String(ttlSeconds));
					res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
					return;
				}
			} catch (err) {
				logger.warn({ err: (err as any)?.message ?? err }, "rate_limit_store_error (failing open)");
			}
			next();
		})();
	};
}

// --- New-order fan-out (notification + realtime) ---------------------------
// EVERY route that creates an order goes through these two helpers, so a
// staff-typed order is indistinguishable from a guest QR order downstream: the
// same `order` notification shape (AddNotification stamps module/entity_type/
// entity_id/outlet_id from meta.order_id, so the bell's target resolver and both
// clients' deep-links keep working unchanged) and the same realtime event.
//
// `order:updated` is the ONLY new-order event the clients already subscribe to
// (web: the orders grid and the KDS/expo screen, via the RealtimeContext →
// `realtime:event` bridge). Reusing it makes both refresh immediately instead of
// waiting out their 10s poll. Neither helper ever throws — a notification or a
// dead socket must never fail an order that is already committed.

/** Total units on an order payload (falls back to 1 per line). */
function orderItemCount(items: unknown): number {
	if (!Array.isArray(items)) {return 0;}
	return items.reduce<number>((sum, raw) => {
		const q = Math.round(Number((raw as Record<string, unknown> | null)?.quantity ?? 1) || 1);
		return sum + Math.max(1, q);
	}, 0);
}

/** Channel of an order: takeaway/delivery name themselves, everything else is dine-in. */
function orderChannelOf(orderType: unknown): "takeaway" | "delivery" | null {
	const t = String(orderType ?? "").trim().toLowerCase();
	if (t === "delivery") {return "delivery";}
	if (t === "takeaway") {return "takeaway";}
	return null;
}

export interface CreatedOrderInfo {
	orderId: string;
	/** Physical table for dine-in, virtual table for takeaway/delivery; may be absent. */
	table?: string | null;
	items?: unknown;
	total?: unknown;
	/** Resulting order status — "Pending" means a staffer still has to approve it. */
	status?: unknown;
	orderType?: unknown;
}

export function emitOrderCreated(restaurantId: string, o: CreatedOrderInfo): void {
	const channel = orderChannelOf(o.orderType);
	try {
		emitRestaurant(restaurantId, "order:updated", {
			order_id: o.orderId,
			table: String(o.table ?? "").trim() || null,
			created: true,
			...(channel ? { order_type: channel } : {}),
		});
	} catch (err) { logger.warn({ err }, "emit order:updated failed"); }
}

export async function notifyOrderCreated(restaurantId: string, o: CreatedOrderInfo): Promise<void> {
	try {
		const table = String(o.table ?? "").trim();
		const channel = orderChannelOf(o.orderType);
		const pending = String(o.status ?? "").trim().toLowerCase() === "pending";
		const count = orderItemCount(o.items);
		const total = Number(o.total);
		// Takeaway/delivery name the CHANNEL — their table is a hidden virtual row
		// that would mean nothing to a waiter. Dine-in names the table when we know
		// it, and simply says "New order" when we don't.
		const what = channel ? `${channel} order` : "order";
		const where = channel ? "" : (table ? ` · Table ${table}` : "");
		const title = pending
			? `${channel ? `New ${what} to approve` : "Order to approve"}${where}`
			: `New ${what}${where}`;
		const parts: string[] = [];
		if (count > 0) {parts.push(`${count} item${count > 1 ? "s" : ""}`);}
		if (Number.isFinite(total) && total > 0) {parts.push(`₹${total}`);}
		if (pending) {parts.push("tap Orders to approve");}
		await AddNotification(restaurantId, {
			type: "order",
			title,
			body: parts.join(" · ") || null,
			meta: {
				table: table || null,
				order_id: o.orderId,
				needs_approval: pending,
				...(channel ? { order_type: channel } : {}),
			},
		});
	} catch (err) { logger.warn({ err }, "order created notification failed"); }
}

// --- Razorpay online payment (primary). -------------------------------------
// Each restaurant supplies its OWN Razorpay keys in Settings so funds settle to
// their account directly (we never middle-man). Falls back to the platform env
// keys only if a restaurant hasn't configured its own. Gateway-verified, so a
// successful verify finalizes the bill (no manual approval).
export const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
export const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

// Resolve the keys to use for a restaurant: its own first, else the platform env.
export async function resolveRazorpayKeys(slug: string, resId: string): Promise<{ key_id: string; key_secret: string } | null> {
	try {
		const own = await withTenant(
			{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
			() => GetRestaurantRazorpayKeys(slug),
		);
		if (own) {return own;}
	} catch {/* fall through to env */}
	if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {return { key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET };}
	return null;
}

// --- Guest messaging (SMS / WhatsApp) ----------------------------------------
// Provider-agnostic dispatch: per-tenant provider config lives in Settings
// (msg_provider 'none' | 'twilio' | 'meta'). With no provider configured every
// send is still logged to OutboundMessages as 'skipped_no_provider', so
// confirmations/reminders are observable (and testable) before the owner picks
// a provider — flipping the setting later requires no code change.

// Public reservation page (dashboard host) — linked from WhatsApp replies when
// a booking needs an online deposit that chat can't collect.
export const DASHBOARD_BASE_URL = (process.env.DASHBOARD_BASE_URL ?? "http://localhost:9002").replace(/\/+$/, "");

// Best-effort E.164: keep an explicit +CC; assume India (+91) for bare
// 10-digit numbers (the product's home market — same assumption as billing's
// ₹ default). Wrong guesses surface as carrier errors on the messages log.
function normalizeMsgPhone(raw: string): string {
	const trimmed = String(raw ?? "").trim();
	const digits = trimmed.replace(/[^0-9]/g, "");
	if (!digits) {return "";}
	if (trimmed.startsWith("+")) {return `+${digits}`;}
	if (digits.length === 10) {return `+91${digits}`;}
	return `+${digits}`;
}

// Send one guest message via the tenant's configured provider and log the
// outcome. Best-effort by contract: never throws, so callers can fire it from
// money/booking paths without risk. Must run inside a tenant context
// (request-scoped or withTenant).
export async function sendMessage(
	restaurantId: string,
	opts: { to: string; body: string; channel?: "sms" | "whatsapp"; kind: "booking_confirm" | "booking_reminder" | "wa_reply"; refId?: string | null },
): Promise<void> {
	try {
		const cfg = await GetMessagingConfig(restaurantId);
		// Meta Cloud API only does WhatsApp; Twilio defaults to SMS unless asked.
		const channel: "sms" | "whatsapp" = cfg.provider === "meta" ? "whatsapp" : (opts.channel ?? "sms");
		const to = normalizeMsgPhone(opts.to);
		const record = async (status: "sent" | "failed" | "skipped_no_provider", error: string | null = null) => {
			try {
				await RecordOutboundMessage(restaurantId, {
					channel,
					to_phone: to || (opts.to ?? null),
					body: opts.body,
					kind: opts.kind,
					ref_id: opts.refId ?? null,
					status,
					error,
					provider: cfg.provider,
				});
			} catch (err) {
				logger.warn({ err }, "record_outbound_message_failed");
			}
		};

		if (cfg.provider === "twilio" && cfg.key_id && cfg.key_secret && cfg.sender && to) {
			try {
				const form = new URLSearchParams({
					To: channel === "whatsapp" ? `whatsapp:${to}` : to,
					From: channel === "whatsapp" && !cfg.sender.startsWith("whatsapp:") ? `whatsapp:${cfg.sender}` : cfg.sender,
					Body: opts.body,
				});
				const resp = await fetchWithTimeout(
					`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.key_id)}/Messages.json`,
					{
						method: "POST",
						headers: {
							Authorization: "Basic " + Buffer.from(`${cfg.key_id}:${cfg.key_secret}`).toString("base64"),
							"Content-Type": "application/x-www-form-urlencoded",
						},
						body: form.toString(),
					},
				);
				if (resp.ok) {await record("sent");}
				else {await record("failed", `HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 500)}`);}
			} catch (err: any) {
				await record("failed", String(err?.message ?? err).slice(0, 500));
			}
			return;
		}

		if (cfg.provider === "meta" && cfg.key_secret && cfg.sender && to) {
			try {
				const resp = await fetchWithTimeout(
					`https://graph.facebook.com/v20.0/${encodeURIComponent(cfg.sender)}/messages`,
					{
						method: "POST",
						headers: { Authorization: `Bearer ${cfg.key_secret}`, "Content-Type": "application/json" },
						body: JSON.stringify({ messaging_product: "whatsapp", to: to.replace(/^\+/, ""), type: "text", text: { body: opts.body } }),
					},
				);
				if (resp.ok) {await record("sent");}
				else {await record("failed", `HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 500)}`);}
			} catch (err: any) {
				await record("failed", String(err?.message ?? err).slice(0, 500));
			}
			return;
		}

		// Provider off / creds incomplete / no usable phone: keep the audit row.
		await record("skipped_no_provider", to ? null : "no guest phone");
	} catch (err) {
		logger.warn({ err }, "send_message_failed"); // best-effort by contract
	}
}

// Fire-and-forget booking confirmation (public reserve + staff/reception
// create paths). Opens its OWN tenant context so it can safely outlive the
// request that queued it.
export function queueBookingConfirm(
	resId: string,
	restaurantId: string,
	args: { bookingId: string; phone: string; party: number; date: Date; table?: string | null; depositAmount?: number | null },
): void {
	void withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, async () => {
		const profile = await GetRestaurantProfile(restaurantId).catch(() => null);
		const name = profile?.restaurant_name || restaurantId;
		const when = args.date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
		const depositNote = args.depositAmount && args.depositAmount > 0
			? ` Note: a ₹${args.depositAmount} deposit is pending — please complete the online payment to confirm.`
			: "";
		await sendMessage(restaurantId, {
			to: args.phone,
			body: `${name}: Reservation received — party of ${args.party} on ${when}${args.table ? ` (table ${args.table})` : ""}.${depositNote}`,
			kind: "booking_confirm",
			refId: args.bookingId,
		});
	}).catch((err) => { logger.warn({ err }, "booking_confirm_message_failed"); });
}

// Reminder pass for one tenant: message every booking starting within the
// configured window (msg_reminder_hours, 0 = off) that hasn't been reminded.
// The slot stamp happens FIRST, so a crashed/overlapping sweep skips rather
// than double-sends. Returns how many reminders were dispatched.
export async function sendDueBookingReminders(resId: string): Promise<number> {
	return withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, async () => {
		const cfg = await GetMessagingConfig(resId);
		if (cfg.reminder_hours <= 0) {return 0;}
		const due = await GetDueBookingReminders(resId, cfg.reminder_hours);
		if (due.length === 0) {return 0;}
		const profile = await GetRestaurantProfile(resId).catch(() => null);
		const name = profile?.restaurant_name || resId;
		let sent = 0;
		for (const b of due) {
			const first = await MarkBookingReminderSent(resId, b.booking_id);
			if (!first) {continue;} // another sweep got there first
			const when = b.start.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
			await sendMessage(resId, {
				to: b.phone,
				body: `${name}: Reminder — your table for ${b.party} is booked for ${when}${b.table_name ? ` (table ${b.table_name})` : ""}. See you soon!`,
				kind: "booking_reminder",
				refId: b.booking_id,
			});
			sent += 1;
		}
		return sent;
	});
}

// Parse a WhatsApp booking command: `book <party> <today|tomorrow|YYYY-MM-DD> <HH:mm>`
// (e.g. "book 4 tomorrow 19:30", "book 2 2026-07-12 20.00"). Returns null when
// the text isn't a well-formed command — the webhook replies with usage help.
export function parseWaBookingCommand(text: string, now = new Date(), tz = "Asia/Kolkata"): { party: number; date: Date } | null {
	const m = /^\s*book\s+(\d{1,3})\s+(today|tomorrow|\d{4}-\d{2}-\d{2})\s+(\d{1,2})[:.](\d{2})\s*$/i.exec(String(text ?? ""));
	if (!m) {return null;}
	const [, partyStr = "", dateToken = "", hhStr = "", mmStr = ""] = m;
	const party = Number.parseInt(partyStr, 10);
	const hh = Number.parseInt(hhStr, 10);
	const mm = Number.parseInt(mmStr, 10);
	if (!Number.isFinite(party) || party <= 0 || hh > 23 || mm > 59) {return null;}
	const zone = sanitizeTimezone(tz);
	const token = dateToken.toLowerCase();
	// Resolve the requested day as a wall-clock date IN THE RESTAURANT TIMEZONE,
	// then interpret the time in that zone — so "book 4 today 20:00" on a UTC prod
	// server still means 8pm local, not 8pm UTC.
	let Y: number, Mo: number, D: number;
	if (token === "today" || token === "tomorrow") {
		const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
		const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
		Y = get("year"); Mo = get("month"); D = get("day");
		if (token === "tomorrow") {
			const d = new Date(Date.UTC(Y, Mo - 1, D));
			d.setUTCDate(d.getUTCDate() + 1);
			Y = d.getUTCFullYear(); Mo = d.getUTCMonth() + 1; D = d.getUTCDate();
		}
	} else {
		Y = Number(dateToken.slice(0, 4));
		Mo = Number(dateToken.slice(5, 7));
		D = Number(dateToken.slice(8, 10));
	}
	const date = zonedWallToUtc(Y, Mo, D, hh, mm, zone);
	if (Number.isNaN(date.getTime())) {return null;}
	return { party, date };
}

export const WA_USAGE_REPLY =
	'To book a table, send: book <guests> <date> <time> — for example "book 4 tomorrow 19:30" or "book 2 2026-07-12 20:00".';

export async function GetCustomerIdOrCreateCustomer(
	restaurantId: string,
	name: string,
	number: string,
	email?: string  ,
	demographics?: CustomerDemographics | null,
): Promise<string | null> {
	const normalizedName = name.trim();
	const normalizedNumber = number.trim();
	let customerId = await GetCustomerId(restaurantId, normalizedName, normalizedNumber);

	if (!customerId) {
		const createdCustomer = await AddCustomer(
			restaurantId,
			normalizedName,
			normalizedNumber,
			email,
			demographics,
		);
		customerId = createdCustomer._id;
	} else if (demographics) {
		// Existing customer: backfill any demographic tags we didn't have yet.
		try { await UpdateCustomerDemographics(restaurantId, String(customerId), demographics); } catch (err) { logger.warn({ err }, "update_customer_demographics_failed"); }
	}

	if (customerId && email) {
		await AddEmailToCustomer(restaurantId, customerId, email);
	}

	if (!customerId) {
		return null;
	}

	return String(customerId);
}

// Best-effort guest registration for ORDERS (QR self-order, staff POS,
// takeaway/delivery): when an order carries a usable phone, find-or-create the
// Customers row and stamp Orders.cust_id so the CRM page counts the visit.
// Never fails the order — customer capture is an enrichment, not a gate.
export async function linkOrderToCustomer(
	restaurantId: string,
	orderId: string,
	name: unknown,
	phone: unknown,
): Promise<void> {
	try {
		const digits = String(phone ?? "").replace(/[^0-9]/g, "");
		if (digits.length < 7 || !orderId) {return;} // no usable identity → skip
		const trimmed = String(name ?? "").trim().replace(/\s+/g, " ");
		// "Guest"/"QR Guest" placeholders aren't real names — store as "Guest"
		// (identity is the phone; GetCustomerId matches name + phone together).
		const displayName = trimmed && !/^(qr )?guest$/i.test(trimmed) ? trimmed.slice(0, 80) : "Guest";
		const custId = await GetCustomerIdOrCreateCustomer(restaurantId, displayName, digits);
		if (custId) {await SetOrderCustomerId(restaurantId, orderId, custId);}
	} catch (err) {
		logger.warn({ err, orderId }, "link_order_customer_failed");
	}
}

// Build the ESC/POS raster (GS v 0) for the restaurant's bill logo, preferring the
// SVG bill logo (rasterized via sharp) and falling back to the PNG logo. Returns
// null when no logo is configured or sharp is unavailable. Reused by the
// /restaurant/logo/escpos endpoint and embedded at the top of printed bills.
export async function buildLogoEscPos(restaurantId: string, targetWidth = 576): Promise<Buffer | null> {
	let raw: Buffer | null = null;
	try {
		const settings = await GetRestaurantSettings(restaurantId);
		const svg = settings.bill_logo_svg?.trim();
		if (svg) {raw = Buffer.from(svg, 'utf8');}
	} catch {/* ignore — fall back to the PNG logo */}
	if (!raw) {raw = await GetRestaurantLogoRaw(restaurantId).catch(() => null);}
	if (!raw) {return null;}

	let sharp: any;
	try { sharp = (await import('sharp')).default ?? (await import('sharp')); } catch (err) {
		logger.error({ err }, 'sharp not available');
		return null;
	}

	// Fit within the paper width (576 dots for 80mm, 384 for 58mm) AND a sane max
	// height so a tall logo can't overflow the printer's single-raster image buffer.
	const img = sharp(raw).flatten({ background: '#ffffff' }).resize({ width: targetWidth, height: 240, fit: 'inside', withoutEnlargement: true }).threshold(128).raw();
	const { data, info } = await img.toBuffer({ resolveWithObject: true });
	const width = info.width;
	const height = info.height;
	const widthBytes = Math.ceil(width / 8);

	const bytes: number[] = [];
	for (let y = 0; y < height; y++) {
		for (let xb = 0; xb < widthBytes; xb++) {
			let byte = 0;
			for (let bit = 0; bit < 8; bit++) {
				const x = xb * 8 + bit;
				const idx = y * width + x;
				const pixel = x < width ? data[idx] : 255;
				// in thresholded raw, 0=black, 255=white
				if (pixel === 0) {byte |= (1 << (7 - bit));}
			}
			bytes.push(byte);
		}
	}

	const xL = widthBytes & 0xff;
	const xH = (widthBytes >> 8) & 0xff;
	const yL = height & 0xff;
	const yH = (height >> 8) & 0xff;
	// GS v 0 m xL xH yL yH d
	const header = Buffer.from([0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
	return Buffer.concat([header, Buffer.from(bytes)]);
}

// --- Vendors + stock movements (purchases / wastage) ------------------------
export const INV_VIEW = "77e41c84-ebf4-4542-a75b-c9e72e03b570";
export const INV_MANAGE = "dfe2cde8-c159-4685-b015-ec7b0d4386eb";

// --- Accounting & reporting --------------------------------------------------
// Gated by the analytics/financial-reports permission.
export const ACCOUNTING_PERM = "df75119b-e5f1-4f38-aba5-78a1cf182f56";

// --- Tenant subscription & billing (restaurant admin) ----------------------
// Platform-account Razorpay keys (separate from each restaurant's OWN Razorpay,
// which collects dine-in payments). These collect the SaaS subscription fee.
export const PLATFORM_RAZORPAY_KEY_ID = process.env.PLATFORM_RAZORPAY_KEY_ID || "";
export const PLATFORM_RAZORPAY_KEY_SECRET = process.env.PLATFORM_RAZORPAY_KEY_SECRET || "";
export const platformRazorpayReady = Boolean(PLATFORM_RAZORPAY_KEY_ID && PLATFORM_RAZORPAY_KEY_SECRET);
