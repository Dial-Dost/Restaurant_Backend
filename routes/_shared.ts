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
import { AddAuditLogEntry, AddCustomer, AddEmailToCustomer, AddNotification, Audit_log_category, EnsureNextPartyTable, GetCustomerId, GetDueBookingReminders, GetEmployeeDetailsFromEmpID, GetMessagingConfig, GetOrderKotNumbers, GetOrderingPrintGuard, GetRestaurantLogoRaw, GetRestaurantAccountStatus, GetRestaurantProfile, GetRestaurantRazorpayKeys, GetRestaurantSettings, GetSuperadminEmployeeId, GetTableFeedbackContext, ListBillingCounters, MarkBookingReminderSent, RecordOutboundMessage, SetOrderCustomerId, UpdateCustomerDemographics, sanitizeTimezone, withTenant, zonedWallToUtc } from "../database_supabase.js";
import { rasterizeBillLogo, type BillLogoRaster } from "../bill_logo.js";
import { logger } from "../observability.js";
import { MOBILE_10_ERROR, normalizeMobile10, normalizeOptionalMobile10 } from "../phone_validation.js";
import type { ReportWindowQuery } from "../report_window.js";
import { emitRestaurant } from "../realtime.js";
import { BILL_PRINTED_STATUS, billPrintedRefusal, nextPartyAfterPrintMessage, orderOnPrintedBillVerdict, orderUpsertAddsToBill, reprintNeededMessage, type BillPrintedWrite } from "../next_party.js";
import { isWaiterOnly, mayCancelKot, type RoleScopeInput } from "../role_scope.js";
import { cancelNeedsSeniorBody, type CancelNeedsSeniorError } from "../cancel_authority.js";


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
//
// THE REFUSAL CARRIES A BODY. This is the commonest 403 in the product, and for
// most of its life it was the bare word "Action not permitted" — which tells the
// waiter standing at the table nothing and sends the owner hunting through the
// role editor with no idea which checkbox is missing. `details` is the sentence
// a client shows; `requiredPermission` is the id an owner (or a support ticket)
// can match against the role editor without guessing from the URL. Additive:
// `error` is unchanged, so anything already keying on it still works. Same shape
// as enforceSettleAuthority, mayReleaseTable and the discount write-off refusal,
// deliberately — three refusals in three shapes is how a client ends up handling
// none of them.
export function validateAction(expectedUUID: string) {
	return (req: Request, res: Response, next: NextFunction) => {
		const actions = req.auth?.actions ?? [];
		if (!actions.includes(expectedUUID) && !actions.includes("*")) {
			res.status(403).json({
				error: "Action not permitted",
				details: "Your role does not have permission for this action. Ask an admin to grant it in Roles & Permissions.",
				requiredPermission: expectedUUID,
			});
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
	// The login username from the VERIFIED session (SessionPayload.employeeUsername),
	// never from the body — the 034/035/036 control ledgers store it as
	// marked_by/voided_by/waived_by, and a client that could name its own actor
	// could sign a comp as the manager. Optional because a session minted before
	// this field existed carries none; extractEmployeeUsername then returns null
	// and the route refuses rather than writing an identity it cannot stand behind.
	employeeUsername?: string;
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

/**
 * The signed-in user's LOGIN USERNAME, from the verified session only.
 *
 * This is what the 034/035/036 ledgers store as `marked_by` / `voided_by` /
 * `waived_by`, so it must never be readable from the body: a client that could
 * name its own actor could sign a comp as the manager. Returns null (rather than
 * a display name or the employee id) when the session carries none, so the route
 * refuses instead of writing an identity it cannot stand behind.
 */
export function extractEmployeeUsername(req: Request): string | null {
	const raw = req.auth?.employeeUsername;
	const name = typeof raw === "string" ? raw.trim() : "";
	return name.length > 0 ? name : null;
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

// --- MIS CAPTURE (migrations 034/035/036) — the three MANAGER acts -----------
//
// Each of these three is BOTH the permission gate AND the audit action id, the
// same double duty PERM_ORDER_DELETE does. That is not a shortcut: "Audit_logs"
// has a foreign key to "Actions", audit titles render from
// "Actions".action_name, and the Bill Edit report prefilters on action id
// (BILL_EDIT_ACTION_IDS in mis_report_math.ts). Reusing 4ad474d4… ("Add
// Orders") — the catch-all every floor write already files under — would have
// filed a comp under "Add Orders" and left the report guessing from reason text.
//
// WHY THEY ARE SEPARATE FROM EVERYTHING THAT EXISTS. Marking a dish
// non-chargeable, voiding a rung-up order and taking the service charge off a
// bill each REDUCE what a guest pays. None of them may ride on a permission a
// waiter already holds: 4ad474d4… ("Add Orders") is held by waiter, captain and
// cashier alike, so gating a comp on it would mean every waiter can comp their
// own friend's table and sign for it themselves. They are also separate from
// EACH OTHER, because a restaurant that lets a floor manager comp a dessert does
// not necessarily let them waive a 10% service charge on a ₹40,000 bill.
//
// Seeded as grantable "Actions" rows by ensureFeaturePermissionActions() and
// granted to the core `manager` role (admin passes on "*"). See the module
// header of routes/mis_capture.ts for how the SECOND name — the authoriser — is
// checked against these same three ids.
export const PERM_NON_CHARGEABLE = "b4e7a1c9-2d58-4f36-9a07-5c81e3b0d472"; // Mark Items Non-Chargeable (Bills)
export const PERM_VOID_ORDER = "c1f83b26-5a97-4e40-b8d3-7e02a9c4f156"; // Void Orders With Reason (Orders)
export const PERM_SERVICE_CHARGE_WAIVER = "d5a06e73-9c41-4b28-8f6a-1b74d3e08c95"; // Waive Service Charge (Bills)

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

/**
 * C2 — SETTLING A BILL IS ONE ACT WITH ONE GATE, and this is it.
 *
 * THE REQUIREMENT: "Only Managers are permitted to settle bills. Waiters must be
 * restricted."
 *
 * WHY A CAPABILITY AND NOT THE WORD "manager". A tenant configures its own
 * roles. A rule that asks `role == "manager"` is a test on SPELLING rather than
 * on authority — which is exactly the defect role_scope.ts exists to document:
 * a restaurant whose senior cashier settles the till, or whose "Floor Manager"
 * is a CUSTOM role (and therefore a uuid), would either be locked out of its own
 * money or, when the test is written the other way round, let everyone through.
 * So "manager" here means WHOEVER THE TENANT HAS GRANTED "Close Bill"
 * (a953d044…) — the core `manager` and `cashier` roles hold it, an admin passes
 * on "*", and a tenant that wants a named custom role to settle ticks one
 * existing checkbox. No new Action id is minted (migration 025's rule): a new id
 * would strip settling from every role that holds it today.
 *
 * WHY IT IS A FUNCTION AND NOT FOUR COPIES OF validateAction. There is no single
 * "settle" endpoint — a settlement is spread over waiter-confirm-payment,
 * admin-approve-payment, close, and the two status writes — and four literals
 * scattered across two route modules is how one of them gets missed. Everything
 * that can move a bill to settled calls THIS, so adding a fifth settle path
 * means calling one named function rather than remembering one uuid.
 *
 * THE HIDDEN-BUTTON RULE. The clients also hide their Settle control (see
 * sessionCapabilities below, which hands them THIS answer rather than letting
 * them derive one). That is the courtesy. This is the control: a deep link, a
 * back-navigation, a stale cached screen or a bare curl all arrive here.
 */
export async function enforceSettleAuthority(req: Request, res: Response): Promise<{ restaurantId: string; outletId: string } | null> {
	const auth = req.auth;
	if (!auth) { res.status(401).json({ error: "Unauthorized", details: "Missing session" }); return null; }
	const actions = auth.actions ?? [];
	if (!actions.includes(PERM_CLOSE_BILL) && !actions.includes("*")) {
		// The message NAMES THE PERMISSION on purpose. "Forbidden" sends an owner
		// hunting through the role editor; "requires Close Bill" is the checkbox.
		res.status(403).json({
			error: "Forbidden",
			details: "Settling a bill requires the 'Close Bill' permission. Ask an admin to grant it to your role.",
			requiredPermission: PERM_CLOSE_BILL,
		});
		return null;
	}
	return { restaurantId: auth.res_id, outletId: extractOutletId(req) };
}

/**
 * THE ANSWERS A CLIENT MUST NOT WORK OUT FOR ITSELF.
 *
 * role_scope.ts settled "is this identity a scoped floor role"; this settles the
 * other half of the same question — "may this identity DO x" — for the handful
 * of controls the V3 requirements ask the clients to hide (C1, C2, C5, C7, D5,
 * H8). It is shipped inside the same `scope` block on /auth/employee-login and
 * /auth/me, because that is the block the clients already read and adding a
 * field to it is additive.
 *
 * WHY THE SERVER SENDS THE ANSWER AND NOT THE INPUTS. `actions_set` is already
 * on the payload, so in principle every client could test for the uuid itself.
 * That is precisely what must not happen: the uuid would then be written out in
 * Dart, in TypeScript and in whatever ships next, the gate on the route would be
 * free to move, and the three would drift — the csrorganics failure mode with a
 * different constant. There is ONE list of which uuid backs which control, it is
 * this one, and it sits beside the guards it describes.
 *
 * EVERY FLAG IS BACKED BY A SERVER GATE ON THE ROUTE IT DESCRIBES. A flag that
 * only hides a button is a lie, because the button is not the control — see the
 * route named in each comment. Nothing is listed here that is not enforced.
 *
 * AN ADMIN LOSES NOTHING: "*" satisfies every entry.
 */
export interface SessionCapabilities {
	/** POST /bills/order/:id/waiter-confirm-payment | /admin-approve-payment | /close, PATCH /orders/:id/status -> Paid. See enforceSettleAuthority. */
	settle_bill: boolean;
	/** DELETE /table/:name — C7/H8. No core role holds this; it is granted, never assumed. */
	delete_table: boolean;
	/** POST /add-table, PATCH /table/:name — the floor-plan writes D5 keeps out of the Tables view. */
	edit_table: boolean;
	/** POST/PATCH/DELETE /table-sections — creating, renaming and removing zones. */
	manage_table_sections: boolean;
	/** POST /orders/:id/items/:itemId/non-chargeable — "Comp an item" (C1: completely hidden for waiters). */
	comp_item: boolean;
	/** POST /bills/service-charge-waiver — "Waive service charge" (C1). */
	waive_service_charge: boolean;
	/** POST /orders/:id/void — cancel a rung-up order with a recorded reason. */
	void_order: boolean;
	/** GET /roles, GET /core-roles — C5/C6: who may OPEN the access-control screen. */
	view_roles: boolean;
	/** POST /roles — C5: who may create and edit a custom role. */
	manage_roles: boolean;
	/**
	 * PATCH /menu/:id/availability — H4's "86 a dish" sidebar.
	 *
	 * The SAME "Edit Menu" uuid the price patch is gated on, deliberately: taking
	 * a dish off changes what a guest can order, which is a menu decision, and
	 * somebody trusted to reprice a dish is certainly trusted to say it has run
	 * out. Not the heavier "create menu item" permission — that would put the
	 * commonest action of a rush behind the rarest one of a quiet morning.
	 */
	edit_menu: boolean;
	/**
	 * "Cancel KOT" on the table sheet and the kitchen board, and "Cancelled" on
	 * the app's stage sheet — cancelling food the kitchen has been told about.
	 * PATCH /orders/:id/status -> Cancelled, POST /orders/:id/void, the POST
	 * /orders upsert and DELETE /orders/:id/items/:itemId all refuse a
	 * waiter-only login with `cancel_needs_senior` (client item 3; see
	 * mayCancelTicketed in role_scope.ts).
	 *
	 * THE ONE FLAG THAT READS THE ROLE, and it is why this function now takes
	 * `role` and `role_all`: the client asked for the WAITER to lose it, so a
	 * waiter-only login is false even when a tenant has granted it "Void Orders
	 * With Reason". Everyone else holds it exactly when they hold one of the two
	 * cancel routes' gates.
	 *
	 * A Pending order's "Decline" does NOT read this flag: that order was never
	 * ticketed, and the server lets a waiter decline it.
	 */
	cancel_kot: boolean;
}

export function sessionCapabilities(input: RoleScopeInput): SessionCapabilities {
	const actions = Array.isArray(input.actions) ? input.actions.map((a) => String(a).trim()) : [];
	const set = new Set(actions);
	const has = (id: string): boolean => set.has("*") || set.has(id);
	return {
		settle_bill: has(PERM_CLOSE_BILL),
		// The literals below are the ones written in registration position on the
		// routes named above. Kept as literals rather than new constants so a
		// reader can grep one string and find both the gate and this answer.
		delete_table: has("5777c4aa-29df-4ea1-9c45-c1038d25f746"), // Table Deleted
		edit_table: has("194ce6ee-b867-4be3-b5f0-48c28ce0a81b"), // Table Added (covers PATCH /table/:name)
		manage_table_sections: has(PERM_TABLE_SECTIONS),
		comp_item: has(PERM_NON_CHARGEABLE),
		waive_service_charge: has(PERM_SERVICE_CHARGE_WAIVER),
		void_order: has(PERM_VOID_ORDER),
		view_roles: has("17ba6407-b703-4403-ab59-13235966053f"), // Get Roles
		manage_roles: has("c0135d18-68b4-45e9-9b51-849158df6efd"), // Create/Update Role
		edit_menu: has("ed800655-b937-44ba-a7ca-7458295886c9"), // Edit Menu
		cancel_kot: mayCancelKot(input) && (has(PERM_VOID_ORDER) || has("4ad474d4-5230-449c-874f-6a238b833bca")), // Add Orders
	};
}

/**
 * CLIENT ITEM 3 — ANSWER A REFUSED CANCEL. Every door that can cancel a
 * ticketed order (PATCH /orders/:id/status, POST /orders, POST
 * /orders/:id/void, DELETE /orders/:id/items/:itemId) turns the data layer's
 * CancelNeedsSeniorError into the same 403 through here, so a client cannot
 * tell which route refused it and a change to the words lands on all four.
 *
 * AUDITED EVEN THOUGH NOTHING HAPPENED, as the refused release and the refused
 * reprint are: a waiter trying to cancel a docket is exactly the event a
 * manager wants to see at the end of a service. The sentence starts "REFUSED",
 * so neither classifyBillEdit nor the Void KOT join reads it as a cancel.
 *
 * The KOT number is read here, after the refusal and outside any transaction,
 * because it is only for the sentence: an unreadable one says "This order".
 * Best-effort throughout — a failed audit or read never turns the 403 into a 500.
 */
export async function refuseTicketedCancel(req: Request, res: Response, err: CancelNeedsSeniorError): Promise<void> {
	const restaurantId = extractRestaurantId(req);
	let kotNos: number[] = [];
	if (restaurantId) {
		try {
			kotNos = (await GetOrderKotNumbers(restaurantId, [err.order_id])).get(err.order_id) ?? [];
		} catch {/* the sentence degrades to "This order" */}
	}
	const handle = kotNos.length > 0 ? ` (${kotNos.map((n) => `KOT-${String(n)}`).join(", ")})` : "";
	const what = err.act === "remove_line" ? "removal of a dish from order" : "cancel of order";
	try {
		await log_audit(
			req, "4ad474d4-5230-449c-874f-6a238b833bca",
			`REFUSED ${what} ${err.order_id}${handle} — it has gone to the kitchen and a waiter cannot cancel it`,
			Audit_log_category.Orders,
			{ order_id: err.order_id, refused: true, code: err.code, act: err.act, kot_nos: kotNos },
		);
	} catch {/* a failed audit write must not turn a 403 into a 500 */}
	res.status(err.status).json(cancelNeedsSeniorBody(err, kotNos));
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

// The two core roles that carry house-wide authority, and are therefore
// grantable only by an admin.
//
// "admin" expands to the ["*"] wildcard. "manager" does NOT and never has — it
// resolves to a concrete list (CORE_ROLES.manager) that now includes the till
// (C2) and view/edit of custom roles (C5). It is on this list anyway, because
// the question this predicate answers is "does handing someone this role change
// who runs the restaurant", and for a manager it does: they can settle money and
// rewrite what other roles may do. Naming it by its authority rather than by the
// wildcard is also what keeps the guard correct as CORE_ROLES.manager grows.
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

/**
 * THE TILL THIS REQUEST WAS RUNG ON (migration 038), or null for "the outlet's
 * single till" — which is what every existing bill and every existing cash
 * session is, and what every tenant that never configures a counter keeps being.
 *
 * `X-Counter-Id` is the primary source, and it is the reason counters never had
 * to be threaded through the settle SIGNATURES: a terminal sets the header once
 * and every request it makes carries it, so which device rang a sale is a
 * property of the REQUEST rather than of the money path. An explicit
 * `counter_id` in the body wins, for the shared till that has to be named per
 * call; `?counter_id=` serves the GETs, which have no body.
 *
 * Body over query over header, because that is increasing order of how
 * deliberate the caller was: a header is ambient configuration, a query string
 * is a screen's current scope, a body field is this one act.
 */
export function counterIdFrom(req: Request): string | null {
	const body = (req.body ?? {}) as Record<string, unknown>;
	const fromBody = typeof body.counter_id === "string" ? body.counter_id.trim() : "";
	if (fromBody) {return fromBody;}
	const q = req.query?.counter_id;
	const fromQuery = Array.isArray(q) ? q[0] : q;
	if (typeof fromQuery === "string" && fromQuery.trim().length > 0) {return fromQuery.trim();}
	const header = req.headers["x-counter-id"];
	const raw = Array.isArray(header) ? header[0] : header;
	return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * Check a counter id against the outlet's configured tills BEFORE any money
 * moves. Throws, so callers surface it as the same 400 every other money route
 * returns.
 *
 * INACTIVE COUNTERS COUNT AS FOUND. Migration 038 deactivates rather than
 * deletes precisely so the attribution on every bill a till ever rang survives
 * it, and a terminal whose counter was retired mid-shift must still be able to
 * take the payment in front of it — refusing here would stop a settle with a
 * guest standing at the counter, over a configuration change.
 *
 * A counter id from ANOTHER outlet is not found, because ListBillingCounters is
 * outlet-scoped: attributing this outlet's bill to another outlet's till would
 * make both cash-ups wrong at once.
 */
export async function requireCounter(restaurantId: string, counterId: string): Promise<void> {
	const counters = await ListBillingCounters(restaurantId, { includeInactive: true });
	if (!counters.some((c) => c.id === counterId)) {
		throw new Error(`No billing counter with id ${counterId} is configured for this outlet`);
	}
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
//
// 5.1 — the pixels themselves are made in bill_logo.ts, which also hands the
// previews a PNG of the SAME raster (buildBillLogoRaster / GET
// /restaurant/logo/bill), so what a preview shows is what the roll prints.
export async function buildLogoEscPos(restaurantId: string, targetWidth = 576): Promise<Buffer | null> {
	const raster = await buildBillLogoRaster(restaurantId, targetWidth);
	return raster ? raster.escpos : null;
}

// The source bytes a tenant's bill logo is drawn from: the stored SVG bill logo
// when there is one, the branding PNG otherwise, null when neither exists.
async function billLogoSource(restaurantId: string): Promise<Buffer | null> {
	try {
		const settings = await GetRestaurantSettings(restaurantId);
		const svg = settings.bill_logo_svg?.trim();
		if (svg) {return Buffer.from(svg, 'utf8');}
	} catch {/* ignore — fall back to the PNG logo */}
	return GetRestaurantLogoRaw(restaurantId).catch(() => null);
}

export async function buildBillLogoRaster(restaurantId: string, targetWidth = 576): Promise<BillLogoRaster | null> {
	const raw = await billLogoSource(restaurantId);
	if (!raw) {return null;}
	const raster = await rasterizeBillLogo(raw, targetWidth);
	if (!raster) {logger.error({ restaurantId }, 'bill logo could not be rasterized (sharp unavailable or unreadable image)');}
	return raster;
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


// --- The next party at a printed table (client item 6) ----------------------
// Two doors, used by every route that prints a bill or adds to one. They live
// here, once, for the reason refuseWaiterBillReprint lives in one place: a
// second copy of the rule is a rule that will drift between the till, the
// dashboard and the guest page.

/**
 * The line a print's response carries beside `next_party_table`, so the till and
 * the dashboard say the same words ("Seat the next party at 12 (next party).").
 * Null when there is no seat.
 */
export function nextPartyPrintMessage(nextPartyTable: string | null): string | null {
	return nextPartyAfterPrintMessage(nextPartyTable);
}

/** "Table Added" — the action a new table is filed under in the audit log. */
const TABLE_ADDED_ACTION = "194ce6ee-b867-4be3-b5f0-48c28ce0a81b";

/**
 * AFTER A SUCCESSFUL BILL PRINT: make sure the next party at this number has a
 * seat, and name it. Called by POST /print/bill, POST /print/bill/claim, POST
 * /print/bill/split and the service-charge waiver print — every door that can
 * put a bill in a guest's hand, whoever pressed it.
 *
 * The answer is `next_party_table` on the print's response: "12 #2" when a
 * sibling is the free seat, "12" when the root itself is free again, null when
 * there is none (a takeaway, or migration 053 is not applied). A row that has
 * just appeared is announced as `table:added`, which the dashboard already
 * reloads its floor on.
 *
 * NEVER THROWS AND NEVER FAILS THE PRINT: the paper is already out.
 */
export async function nextPartyAfterPrint(req: Request, restaurantId: string, tableName: string): Promise<string | null> {
	try {
		const seat = await EnsureNextPartyTable(restaurantId, tableName);
		if (!seat) {return null;}
		if (seat.created) {announceNextPartyTable(restaurantId, seat);}
		if (seat.created) {
			try {
				await log_audit(req, TABLE_ADDED_ACTION,
					`Opened ${seat.table_name} for the next party at ${seat.parent_table} (its bill was printed)`,
					Audit_log_category.Tables,
					{ table_name: seat.table_name, parent_table: seat.parent_table, party_no: seat.party_no, next_party: true });
			} catch {/* a failed audit write must not fail a print */}
		}
		return seat.table_name;
	} catch (err) {
		logger.warn({ err, table: tableName }, "next_party_after_print_failed");
		return null;
	}
}

function announceNextPartyTable(
	restaurantId: string,
	seat: { table_name: string; parent_table: string; party_no: number | null },
): void {
	try {
		emitRestaurant(restaurantId, "table:added", {
			table_name: seat.table_name, parent_table: seat.parent_table, party_no: seat.party_no,
		});
	} catch (err) {
		logger.warn({ err }, "emit table:added (next party) failed");
	}
}

/**
 * THE MONEY GUARD ON NEW ORDERS — an order added to a table whose CURRENT
 * seating's bill has already been printed.
 *
 *   * a waiter-only login or a QR guest -> 423 { code: "bill_printed", table,
 *     next_party_table } and NOTHING is written. The sentence says where the
 *     new party's order goes, and that a same-party addition is a manager's
 *     (who can add it and reprint). 423 and not 409: see BILL_PRINTED_STATUS
 *     for what a 409 did to the till's offline queue;
 *   * a senior role -> allowed; the caller spreads reprintNeededFields(guard)
 *     into its answer (`reprint_needed: true` and the sentence both clients
 *     show beside a Reprint action), because the paper in the guest's hand is
 *     now short;
 *   * no print, no print state, a takeaway, or migration 053 absent -> allowed,
 *     exactly as before this guard existed.
 *
 * WHY THE GUEST IS REFUSED RATHER THAN REROUTED: the table card's QR is signed
 * for "12", and whoever scans it after the print may be the next party. Their
 * order must not land on the printed bill, and it cannot be moved to "12 #2"
 * on the guess that they are the new guests.
 *
 * AN UPSERT IS JUDGED BY WHAT IT ADDS. POST /orders also carries the
 * dashboard's status changes and its edit dialog, as a resend of an existing
 * order; `upsert` names that order, and only a resend that AddOrder would grow
 * (orderUpsertAddsToBill, line by line) is refused — "Served" on a printed
 * table is not.
 *
 * THE OTHER DOORS INTO A PRINTED BILL. POST /bills/merge and POST
 * /bills/move-item put food onto `to_table` just as an order does, and are
 * gated by the same "Add Orders" permission a waiter holds. They pass
 * `write: "merge" | "move"`: the same verdict, but no next-party seat is made
 * or offered — that food belongs to somebody already seated — and the sentence
 * says a manager merges or moves it and reprints.
 *
 * FAILS OPEN on a read error, in the direction bill_print_state.ts already
 * chose: the order path itself is the one that has to work.
 *
 * `restaurantId` is what the data layer is asked with (a staff route's res id,
 * or the QR route's slug); `emitRestaurantId` is the res UUID whose socket room
 * the dashboard listens in, when that differs — the QR route passes it, because
 * `restaurant:<slug>` is a room nobody joins.
 *
 * Returns `refused: true` when it has answered (the caller returns at once).
 */
export type PrintedBillGuard =
	| { refused: true }
	| { refused: false; reprintNeeded: boolean; table: string | null; parentTable: string | null };

export async function refuseOrderOnPrintedBill(
	req: Request,
	res: Response,
	target: {
		restaurantId: string;
		tableName: string;
		guest: boolean;
		/** POST /orders only: the order id the body names, and the lines it sends. */
		upsert?: { orderId: string | null; items: unknown };
		/** What is being put on the bill; an order unless said otherwise. */
		write?: BillPrintedWrite;
		/** The res UUID for the `table:added` emit, when restaurantId is a slug. */
		emitRestaurantId?: string;
	},
): Promise<PrintedBillGuard> {
	const { restaurantId, tableName, guest, upsert } = target;
	const write = target.write ?? "order";
	const allow = { refused: false as const, reprintNeeded: false, table: null, parentTable: null };
	let state: Awaited<ReturnType<typeof GetOrderingPrintGuard>> = null;
	try {
		state = await GetOrderingPrintGuard(restaurantId, tableName, { orderId: upsert?.orderId ?? null });
	} catch (err) {
		logger.warn({ err, table: tableName }, "order_print_guard_read_failed (failing open)");
		return allow;
	}
	if (!state) {return allow;}
	const waiterOnly = !guest && isWaiterOnly({ role: req.auth?.role, role_all: req.auth?.role_all, actions: req.auth?.actions });
	const addsToBill = upsert ? orderUpsertAddsToBill(upsert.items, state.existing_lines ?? null) : true;
	const verdict = orderOnPrintedBillVerdict({ printCount: state.print_count, waiterOnly, guest, addsToBill });
	if (verdict === "allow") {return allow;}
	if (verdict === "reprint_needed") {
		return { refused: false, reprintNeeded: true, table: state.table, parentTable: state.parent_table };
	}

	// The seat is made here too, not only at print time: a print whose seat
	// could not be made (or a seat retired since) must not leave the refusal
	// pointing nowhere. Only for an ORDER — a merge or a move is never pointed
	// at a seat (see BillPrintedWrite).
	const seat = write === "order" ? await EnsureNextPartyTable(restaurantId, state.table) : null;
	if (seat?.created) {announceNextPartyTable(target.emitRestaurantId ?? restaurantId, seat);}
	if (!guest) {
		const what = write === "merge" ? "a merge into" : write === "move" ? "a move onto" : write === "move_off" ? "a move off" : "an order on";
		try {
			await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca",
				`REFUSED ${what} table ${state.table} — its bill was already printed ${String(state.print_count)} time(s)`,
				write === "order" ? Audit_log_category.Orders : Audit_log_category.Bill,
				{ table: state.table, refused: true, code: "bill_printed", write, print_count: state.print_count, next_party_table: seat?.table_name ?? null });
		} catch {/* a failed audit write must not turn a refusal into a 500 */}
	}
	res.status(BILL_PRINTED_STATUS).json(billPrintedRefusal({
		table: state.table,
		nextPartyTable: seat?.table_name ?? null,
		printCount: state.print_count,
		guest,
		parentTable: state.parent_table,
		write,
	}));
	return { refused: true };
}

/**
 * What a route adds to its answer when a senior role has just put more on a
 * printed bill: `reprint_needed` and the sentence both clients show beside a
 * Reprint action (reprintNeededMessage). Nothing at all otherwise, so every
 * other answer is byte-for-byte what it was.
 */
export function reprintNeededFields(
	guard: PrintedBillGuard,
): { reprint_needed?: true; reprint_message?: string; reprint_table?: string } {
	if (guard.refused || !guard.reprintNeeded || !guard.table) {return {};}
	return {
		reprint_needed: true,
		reprint_message: reprintNeededMessage(guard.table, guard.parentTable),
		// The table whose paper is short: the one a Reprint action prints.
		reprint_table: guard.table,
	};
}

/**
 * CLIENT ITEM 4 — A MOVE CHANGES TWO BILLS. A senior role moving an order or a
 * dish between two printed tables leaves BOTH papers wrong: the source's
 * charges for food that has left, the destination's is short. The first table
 * that needs a reprint rides in the ordinary `reprint_*` fields (so an
 * installed app that reads only those still offers one), and when both do, the
 * second rides in `also_reprint_*` with the same shape. Nothing at all when
 * neither paper was printed.
 */
export function moveReprintFields(
	destination: PrintedBillGuard,
	source: PrintedBillGuard,
): {
	reprint_needed?: true; reprint_message?: string; reprint_table?: string;
	also_reprint_needed?: true; also_reprint_message?: string; also_reprint_table?: string;
} {
	const needs = [reprintNeededFields(destination), reprintNeededFields(source)].filter((f) => f.reprint_needed === true);
	const first = needs[0];
	const second = needs[1];
	return {
		...(first ?? {}),
		...(second
			? { also_reprint_needed: true as const, also_reprint_message: second.reprint_message, also_reprint_table: second.reprint_table }
			: {}),
	};
}
