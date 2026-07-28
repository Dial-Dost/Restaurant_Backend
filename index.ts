import 'dotenv/config';
import { randomUUID, createHmac, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from "express";
import express from "express";
import helmet from "helmet";
import { z } from "zod";
import { logger, initObservability, captureException, metricsMiddleware, metricsHandler } from "./observability.js";
initObservability();
import {
	AddBooking,
	GetBookingsInRange,
	AddCustomer,
	AddEmailToCustomer,
	AddTable,
	UpdateTable,
	GetSeatingSuggestion,
	RemoveTable,
	OccupyTable,
	UpdateTableCovers,
	ReleaseTable,
	GetTableStatus,
	VerifyTableOtp,
	GetBillForTable,
	computeBillCharges,
	RemoveBillItem,
	SetBillItemNote,
	MoveBillItem,
	SetBillDiscountWithApproval,
	GetDiscountRequests,
	DecideDiscountRequest,
	ReopenBill,
	GetCoupons,
	UpsertCoupon,
	DeleteCoupon,
	CreateGiftVoucher,
	ApplyCouponToBill,
	CheckCoupon,
	GetLoyaltyAccount,
	RedeemLoyaltyPoints,
	LOYALTY_REDEEM_ACTION_ID,
	GenerateAggregatorKey,
	GetRestaurantIdByAggregatorKey,
	AddAggregatorOrder,
	SplitBillForTable,
	MergeTableBills,
	RefundBill,
	SetBillRefundRef,
	AddExpense,
	GetExpenses,
	DeleteExpense,
	GetCurrentCashSession,
	OpenCashSession,
	CloseCashSession,
	GetCashSessions,
	GetSalesReport,
	GetGstReport,
	GetProfitAndLoss,
	GetDiscountsReport,
	GetBalanceSheet,
	GetReconciliation,
	SaveReconciliation,
	DeleteReconciliation,
	RECONCILE_ACTION_ID,
	BuildTallyXml,
	GetOperationsAnalytics,
	GetOutlets,
	AddOutlet,
	UpdateOutlet,
	SetOutletActive,
	DeleteOutlet,
	GetOutletsRollup,
	GetOutletsComparison,
	GetBookingsAfterTime,
	GetBookingSummaryById,
	UpdateBookingDeposit,
	HasActiveBooking,
	GetCustomerAndBookings,
	GetCustomerInsights,
	GetCustomerId,
	GetTables,
	UpdateBookingStatus,
	DeleteBooking,
	AssignTableToBooking,
	// AddAuditLogEntryLegacy,
	Audit_log_category,
	GetEmployeeDetailsFromEmpID,
	AddAuditLogEntry,
	GetAuditLogs,
	PerformAuditUndo,
	AUDIT_UNDO_PERMISSION_ID,
	GetMenuItemUndoState,
	readEmployeeRolesForUndo,
	GetRestaurantUserRole,
	EnsureRestaurantSeed,
	AllocateBestTable,
	GetAvailableTablesForInterval,
	AddFeedbackEntry,
	GetFeedbackEntries,
	GetFeedbackSummary,
	GetRecoveryTickets,
	ResolveRecoveryTicket,
	ClockIn,
	ClockOut,
	GetMyAttendance,
	GetAttendanceSummary,
	GetVendors,
	AddVendor,
	UpdateVendor,
	DeleteVendor,
	ReceiveStock,
	RecordWastage,
	IssueStock,
	ISSUE_STOCK_ACTION_ID,
	type MenuModifierGroup,
	type RecipeItem,
	GetVendorPriceHistory,
	SetInventoryExpiry,
	GetMenuCosting,
	GetStockMovements,
	CreatePurchaseOrder,
	GetPurchaseOrders,
	GetPurchaseOrder,
	SetPurchaseOrderStatus,
	ReceivePurchaseOrder,
	DeletePurchaseOrder,
	GetRestaurantUsers,
	GetEmployeeIdsWithRole,
	ResolveOutletForRestaurant,
	GetRestaurantEmployeeCount,
	AddRestaurantUser,
	DeleteRestaurantUser,
	SetUserPassword,
	GetSuperadminEmployeeId,
	AddPasswordResetRequest,
	GetPasswordResetRequests,
	ResolvePasswordResetRequest,
	CheckDatabaseHealth,
	GetInventoryItems,
	UpsertInventoryItem,
	DeleteInventoryItem,
	GetMenuItems,
	GetMenuCategories,
	UpsertMenuItem,
	EnsureMenuCategory,
	DeleteMenuCategory,
	SaveMenuItems,
	MenuBulkDeleteError,
	UpdateMenuItemPrice,
	RenameMenuStation,
	RenameInventoryCategory,
	GetOrders,
	GetOrdersScope,
	AddOrder,
	AddTakeawayOrder,
	SetOrderCustomerId,
	DeleteOrder,
	UpdateOrderItemsSplit,
	SetOrderStatus,
	GetMonthlyApcInsights,
	GetApcTrends,
	GetAdvancedAnalytics,
	RunExceptionChecks,
	ListRestaurantIds,
	GetMonthlyHistory,
	CreateCampaign,
	DeleteCampaign,
	UpdateCustomerDemographics,
	type CustomerDemographics,
	GetPayroll,
	SetPayrollProfile,
	RecordPayrollPayment,
	SetAttendanceApproval,
	GetRestaurantProfile,
	UpdateRestaurantProfile,
	GetPublicBranding,
	SetBranding,
	GetRestaurantSettings,
	SetRestaurantSettings,
	parseWallClockInZone,
	zonedWallToUtc,
	sanitizeTimezone,
	isTerminalBookingStatus,
	GetMessagingConfig,
	RecordOutboundMessage,
	GetOutboundMessages,
	GetDueBookingReminders,
	MarkBookingReminderSent,
	GetDailyRevenueSeries,
	GetMenuPerformanceInsights,
	OrderTimingAction,
	GetTimingStats,
	GetKitchenAnalytics,
	FireOrderItems,
	GetExpoView,
	FIRE_COURSE_ACTION_ID,
	BarkOrder,
	BARK_ORDER_ACTION_ID,
	AddNotification,
	GetNotifications,
	ResolveNotificationTarget,
	MarkNotificationRead,
	MarkAllNotificationsRead,
	DeleteNotification,
	ClearNotifications,
	GetOutletDefaultTax,
	GetRestaurantLogo,
	GetRestaurantLogoRaw,
	GetBillByOrder,
	UpdateOutletDefaultTax,
	AddBill,
	ReplaceBill,
	UpdateBillStatusByOrder,
	ConfirmBillPaymentByWaiter,
	ApproveBillPaymentByAdmin,
	CloseBillByOrder,
	GetRoles,
	GetActions,
	ValidationError,
	CreateRole,
	DeleteRole,
	AssignRoleToEmployee,
	RemoveRoleFromEmployee,
	GetTableAssignments,
	GetTableFeedbackContext,
	AssignTableToEmployee,
	UnassignTableEmployee,
	GetParkingBays,
	AddParkingBay,
	UpdateParkingBay,
	DeleteParkingBay,
	SetParkingBayCurrent,
	GetValetVehicleStates,
	CreateValetVehicleState,
	GetValetVehicleState,
	UpdateValetVehicleState,
	UpdateValetVehicleOps,
	UpdateValetVehicleBay,
	GetValetVehicleMetaByBookingIds,
	UpsertValetVehicleMeta,
	AuthenticateRestaurantEmployee,
	GetRestaurantOutletsPublic,
	CORE_ROLES,
	getRestaurantIdFromUsername,
	openTenantConnection,
	withTenant,
	FinalizeOnlinePayment,
	GetRestaurantRazorpayKeys,
	SubmitCustomerPayment,
	GetRestaurantAccountStatus,
	GetRestaurantPlan,
	closePools,
	verifyTenantRlsAtBoot,
	ensureFeaturePermissionActions,
	JoinWaitlist,
	GetWaitlistEntryByToken,
	SetWaitlistPreorder,
	AddWaitlistMember,
	CancelWaitlistByToken,
	GetWaitlist,
	CallWaitlistEntry,
	CancelWaitlistEntry,
	SeatWaitlistEntry,
	repriceFromMenu,
	applyMenuPriceFloor,
	type BookingWindow,
} from "./database_supabase.js";
import {
	OPENAI_REALTIME_MODEL,
	checkAvailabilityForRequest,
	createReceptionSession,
	getRestaurantKnowledgeSnapshot,
} from "./realtime_reception_agent.js";
import { initRealtime, emitRestaurant, emitOutlet, closeRealtime, realtimeAdapterReady } from "./realtime.js";
import { buildReceiptBase64, buildKotBase64 } from "./escpos.js";
import { createSession, getSession, refreshTtl, destroySession, destroyAllForEmployee } from "./auth/sessions.js";
import { getStore } from "./auth/store.js";
import { registerPlatformRoutes } from "./platform/routes.js";
import { closePlatformPool } from "./platform/db.js";
import {
	getTenantBilling,
	requestPlanChange,
	getInvoice,
	setInvoiceOrderId,
	markInvoicePaidAndActivate,
	startTrialIfMissing,
	billingConfigured,
} from "./platform/tenant_billing.js";
import { uploadScreenshot, uploadMenuImage } from "./storage_bucket_supabase.js";
import { verifyTable, decodeTableToken } from "./qr_signing.js";
import { METRIC_EXPLAINERS } from "./analytics_explainers.js";
import { MOBILE_10_ERROR, normalizeMobile10, normalizeOptionalMobile10 } from "./phone_validation.js";

// Resolve the table for a public QR request. Prefers the opaque ?t= token; falls
// back to table_name+sig. Returns the verified table name, or null if invalid.
function resolveQrTable(
	resId: string,
	src: { t?: unknown; table_name?: unknown; table?: unknown; sig?: unknown },
): string | null {
	const token = typeof src.t === "string" ? src.t : "";
	if (token) {return decodeTableToken(resId, token);}
	const name = typeof src.table_name === "string"
		? src.table_name.trim()
		: typeof src.table === "string" ? src.table.trim() : "";
	const sig = typeof src.sig === "string" ? src.sig : "";
	return name && verifyTable(resId, name, sig) ? name : null;
}
import { createServer } from "http";
const app = express();
// Behind Railway's proxy — trust the first hop so req.ip is the real client IP
// (used by the rate limiter below).
app.set("trust proxy", 1);
// Hide the framework fingerprint.
app.disable("x-powered-by");
// Baseline HTTP security headers. CSP and COEP are disabled because this is a
// cross-origin JSON/asset API (serves logos + redirects to other origins); the
// high-value wins here are nosniff, HSTS and clickjacking protection.
app.use(
	helmet({
		contentSecurityPolicy: false,
		crossOriginEmbedderPolicy: false,
		crossOriginResourcePolicy: false,
		hsts: { maxAge: 15552000, includeSubDomains: true },
		referrerPolicy: { policy: "no-referrer" },
		frameguard: { action: "deny" },
	}),
);
// Record per-request latency/status for Prometheus (cheap; before routes).
app.use(metricsMiddleware);
const port = process.env.PORT || 3001;

// Python feedback service URL. Use container host (PY_SERVER_URL) when set,
// otherwise fall back to localhost with optional port override.
const PY_SERVER_URL = process.env.PY_SERVER_URL ?? `http://127.0.0.1:${process.env.PY_SERVER_PORT ?? "8000"}`;

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
async function feedbackUrlForTable(slug: string, tableName: string): Promise<string | null> {
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

// Concise, structured (JSON line) per-request access log. Deliberately logs only
// method/path/status/latency/ip — never headers or body — so auth tokens are never
// written to logs (the old logger dumped the whole req object). Skips /health to
// avoid healthcheck noise. Set REQUEST_LOG=off to disable.
function requestLog(req: Request, res: Response, next: NextFunction) {
	if (req.path === "/health" || process.env.REQUEST_LOG === "off") {
		next();
		return;
	}
	const start = Date.now();
	res.on("finish", () => {
		const fields = { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start, ip: req.ip };
		if (res.statusCode >= 500) {logger.error(fields, "request");}
		else if (res.statusCode >= 400) {logger.warn(fields, "request");}
		else {logger.info(fields, "request");}
	});
	next();
}
app.use(requestLog);

// Retained for the public auth/health/reception routes that legitimately run
// without a session. Authenticated routes are gated by requireAuth, not this.
function validate(_req: Request, _res: Response, next: NextFunction) {
	next();
}

// Authorize against the permitted action UUIDs resolved at login and stored on
// the verified session (req.auth) — never from a client-supplied header.
function validateAction(expectedUUID: string) {
	return (req: Request, res: Response, next: NextFunction) => {
		const actions = req.auth?.actions ?? [];
		if (!actions.includes(expectedUUID) && !actions.includes("*")) {
			res.status(403).json({ error: "Action not permitted" });
			return;
		}
		next();
	};
}

async function log_audit(req: Request, action_id: string, action_description: string, category: Audit_log_category, additional_details?: Record<string, any>) {
	const employeeID = extractEmployeeId(req);
	if (!employeeID) {throw new Error("Cannot log audit entry without employee ID");}
	const emp_dets = await GetEmployeeDetailsFromEmpID(employeeID);
	if (!emp_dets) {throw new Error("Employee details not found for ID");}
	await AddAuditLogEntry(
		emp_dets.res_id,
		emp_dets.outlet_id,
		employeeID,
		action_id,
		action_description,
		category,
		additional_details
	);
}


type AppRole = "admin" | "employee" | "valet" | "waiter" | "cashier" | "captain" | "manager";

function normalizeRole(rawRole: unknown): AppRole | null {
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

function extractBearerToken(req: Request): string | null {
	const header = req.headers.authorization;
	const value = Array.isArray(header) ? header[0] : header;
	if (typeof value === "string" && value.toLowerCase().startsWith("bearer ")) {
		const token = value.slice(7).trim();
		return token.length > 0 ? token : null;
	}
	return null;
}

// Verifies the bearer token against the Redis session store, populates req.auth
// with the server-trusted identity, and binds a tenant-scoped DB connection for
// the request so RLS isolates this restaurant's data.
// Requests that must never be rejected for a bad X-Outlet-Id: they are exactly
// how a client holding a stale/foreign stored outlet discovers the truth and
// repairs its selection. Served from the caller's session outlet instead.
const OUTLET_SELF_HEAL_PATHS = new Set(["/outlets", "/auth/me"]);

async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
	const token = extractBearerToken(req);
	if (!token) {
		res.status(401).json({ error: "Unauthorized", details: "Missing bearer token" });
		return;
	}

	let session;
	try {
		session = await getSession(token);
	} catch (err) {
		logger.error({ err }, "session_lookup_failed");
		res.status(503).json({ error: "Session store unavailable" });
		return;
	}
	if (!session) {
		res.status(401).json({ error: "Unauthorized", details: "Invalid or expired session" });
		return;
	}

	const normalizedRole = normalizeRole(session.role) ?? "employee";
	const isPrivileged = normalizedRole === "admin" || normalizedRole === "manager";
	// Admins/managers may act on another of their restaurant's outlets by passing
	// an X-Outlet-Id header/param. Everyone else is pinned to their session outlet
	// (a header they send is ignored, never honoured).
	const requestedOutlet = rawRequestedOutletId(req);
	// The "all" sentinel turns on aggregate READ mode for admins/managers only;
	// the connection stays bound to a CONCRETE default outlet (their session
	// outlet) so app.outlet_id is a real value and writes still target one outlet.
	const allOutlets = isPrivileged && isAllOutletsSentinel(requestedOutlet);
	let effectiveOutlet = session.outlet_id;
	if (!allOutlets && requestedOutlet && isPrivileged && requestedOutlet !== session.outlet_id) {
		// The override is honoured ONLY when it really is one of THIS restaurant's
		// outlets. An unknown, stale or cross-restaurant id used to fall through to
		// resolveRestaurantContext's "first outlet of the restaurant" default, which
		// silently read AND wrote the main outlet's data while the API echoed back
		// the outlet that was asked for — so it is a hard 400 now. Names resolve to
		// their canonical Outlets.id (resolveRestaurantContext accepts either).
		let resolved: string | null = null;
		try {
			resolved = await ResolveOutletForRestaurant(session.res_id, requestedOutlet);
		} catch (err) {
			logger.error({ err }, "outlet_membership_lookup_failed");
			res.status(503).json({ error: "Database unavailable" });
			return;
		}
		if (!resolved) {
			if (OUTLET_SELF_HEAL_PATHS.has(req.path)) {
				// The client's recovery path: these two are how a UI holding a stale
				// stored outlet re-reads who it is and which outlets exist. 400-ing
				// them would make the bad selection unfixable, so serve them from the
				// session outlet — /outlets echoes current_outlet_id, which tells the
				// UI what actually applied.
				effectiveOutlet = session.outlet_id;
			} else {
				res.status(400).json({ error: "Unknown outlet", details: "The requested outlet does not belong to this restaurant" });
				return;
			}
		} else {
			effectiveOutlet = resolved;
		}
	}

	req.auth = {
		employeeId: session.employeeId,
		res_id: session.res_id,
		outlet_id: effectiveOutlet,
		role: normalizedRole,
		role_all: session.role_all,
		actions: session.actions,
		features: session.features ?? {},
		limits: session.limits ?? {},
		allOutlets,
	};
	void refreshTtl(token); // sliding expiry, best-effort

	// WRITE GUARD: "all" is read-only. Reject any state-changing request while the
	// aggregate mode is active (it only ever makes sense for GET/HEAD reads), so a
	// mutation can never be applied ambiguously across outlets. The UI must select
	// a concrete outlet before writing.
	if (allOutlets && req.method !== "GET" && req.method !== "HEAD") {
		res.status(400).json({ error: "Select a specific outlet before making changes" });
		return;
	}

	try {
		const conn = await openTenantConnection({
			res_id: session.res_id,
			outlet_id: effectiveOutlet,
			employeeId: session.employeeId,
			role: session.role,
			allOutlets,
		});
		const release = () => {
			void conn.release();
		};
		res.once("finish", release);
		res.once("close", release);
		conn.run(() => { next(); });
	} catch (err) {
		logger.error({ err }, "tenant_connection_open_failed");
		res.status(503).json({ error: "Database unavailable" });
	}
}

function getFeedbackCategoryLabel(category: number | string): string {
	if (typeof category === "number") {
		switch (category) {
			case 1:
				return "initial greeting";
			case 2:
				return "waiter service";
			case 3:
				return "food";
			case 4:
				return "ambience";
			case 5:
				return "restroom";
			case 6:
				return "valet parking";
			default:
				return "this question";
		}
	}

	const normalized = category.trim().toLowerCase();
	if (!normalized) {
		return "this question";
	}
	if (normalized === "1") {return "initial greeting";}
	if (normalized === "2") {return "waiter service";}
	if (normalized === "3") {return "food";}
	if (normalized === "4") {return "ambience";}
	if (normalized === "5") {return "restroom";}
	if (normalized === "6") {return "valet parking";}
	return normalized.replace(/_/g, " ");
}

function normalizeFollowUpPromptForCategory(prompt: string, categoryLabel: string, rate: number): string {
	const compact = prompt.replace(/\s+/g, " ").trim();
	if (!compact) {
		return `You rated ${categoryLabel} ${rate}/5. Could you share what influenced that rating?`;
	}

	let next = compact;
	const replacement = categoryLabel === "food" ? "food" : categoryLabel;

	if (categoryLabel !== "food") {
		next = next.replace(/\bthe\s+food\b/gi, `the ${replacement}`);
		next = next.replace(/\bfood\b/gi, replacement);
	}

	next = next.replace(/\bthe\s+this\s+question\b/gi, "this question");
	next = next.replace(/\bthe\s+1\b/gi, "this question");
	return next;
}

// Tenant identity comes only from the verified session (req.auth), never from
// client-supplied headers/query/body.
function extractRestaurantId(req: Request): string | null {
	return req.auth?.res_id ?? null;
}

function extractRestaurantUsername(req: Request): string | null {
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

function extractEmployeeId(req: Request): string | null {
	return req.auth?.employeeId ?? null;
}

// The customer feedback app is unauthenticated (a guest, no session). It carries
// the restaurant/outlet/employee from the feedback link as headers (or body), the
// same way the public /qr/* endpoints identify their tenant.
function feedbackHeader(req: Request, name: string, bodyKey: string): string {
	const v = req.headers[name];
	const h = Array.isArray(v) ? v[0] : v;
	if (typeof h === "string" && h.trim()) {return h.trim();}
	const body = req.body as Record<string, unknown> | undefined;
	const bv = body?.[bodyKey];
	return typeof bv === "string" ? bv.trim() : "";
}
const feedbackRestaurantId = (req: Request) => feedbackHeader(req, "x-restaurant-id", "restaurantId");
const feedbackOutletId = (req: Request) => feedbackHeader(req, "x-outlet-id", "outletId");
const feedbackEmployeeId = (req: Request) => feedbackHeader(req, "x-employee-id", "employeeId");

// (extractActionList removed — permissions now come from the verified session.)

function normalizeRestaurantSlug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function enforceRoles(
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

async function enforceRolesIgnoreOutletID(
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
async function enforceAdmin(
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
const PERM_CAMPAIGNS = "3f9a1c72-6b04-4e19-9d2a-8c5e7f01a4b3"; // Manage Campaigns (Customer)
const PERM_COUPONS = "7c1e4d90-2a6b-4f83-b5c1-9e0d6a2f3418"; // Manage Coupons & Vouchers (Customer)
const PERM_MESSAGING = "5b8d2f16-4c93-47a0-a1e6-3d7f9b0c5e24"; // Guest Messaging (Customer)
const PERM_DISCOUNTS = "9a3c6e81-7d40-4b52-8f19-2c6b4a0e7d35"; // Approve Discounts (Bills)
const PERM_ATTENDANCE = "2e7b9c40-1f83-4d6a-b902-5a8c3e1f6047"; // Review Attendance (Restaurant Specific)
const PERM_SETTINGS = "6d0f3a94-8b21-4c67-9e53-1a4d7b2f8c60"; // Manage Restaurant Settings (Restaurant Specific)
const PERM_BRANDING = "4a1c8e73-5f60-49b2-a3d8-7c2e0b6f9153"; // Manage Branding (Restaurant Specific)
const PERM_BILLING = "1c6e9b34-7a52-4f80-9d13-3b8c5a0e6f27"; // Manage Subscription & Billing (Restaurant Specific)
const PERM_PASSWORDS = "0b4d7f92-6c81-43a5-b7e0-2f9a1c8d5e36"; // Manage User Passwords (Roles)
// Split out of over-broad permissions (audit 2026-07-27): "Add Orders" used to
// let a WAITER delete an order and settle it to Paid, and "Update Menu" covered
// category deletion plus the full-menu replace. Destructive/financial work is
// now grantable on its own instead of riding along with everyday duties.
const PERM_ORDER_DELETE = "8c3f5b21-0e74-4a96-b2d8-6f1a9c4e7b53"; // Delete Orders (Orders)
const PERM_MENU_CAT_DELETE = "3d9e7a05-6c18-4f2b-9a41-8b5d0e3c6f72"; // Delete Menu Categories (Menu)
const PERM_MENU_BULK_REPLACE = "7b2c9d48-3a51-4e07-8d6f-1c4e5a9b0837"; // Bulk Replace Menu (Menu)
const PERM_FEEDBACK_RESOLVE = "5e8a1f36-9b47-42c0-a7e5-0d3b6c8f4291"; // Resolve Feedback Recovery (Feedback Questions)
const PERM_CLOSE_BILL = "a953d044-31ba-4e31-b96f-99304fe43dfa"; // Close Bill (Bills) — required to settle an order to Paid
const PERM_VALET_CHARGE = "6c2e8a4d-7f1b-4d9c-8e35-b0a4d6c2f791"; // Valet Charge to Bill (existing, was unused as a gate)
const PERM_VALET_OPS = "8e4b2d6f-3a1c-4f7e-9b05-d2c6a8e0f413"; // Valet Ops Update (existing, was unused as a gate)
const PERM_VALET_KEYS = "4a7d1c9e-5b3f-4e8a-a6d2-0c9f7b3e5a18"; // Valet Key Log (existing, was unused as a gate)

// Permission gate for a specific granted Action. Admin (actions include "*")
// always passes; any role granted this action UUID passes; everyone else 403.
// Same return shape as enforceAdmin so it's a drop-in swap in handler bodies.
async function enforcePermission(req: Request, res: Response, actionId: string): Promise<{ restaurantId: string; outletId: string } | null> {
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
async function revokeEmployeeSessions(employeeId: string, reason: string): Promise<void> {
	if (!employeeId) {return;}
	try {
		await destroyAllForEmployee(employeeId);
	} catch (err) {
		logger.error({ err, employeeId, reason }, "revoke_employee_sessions_failed");
	}
}

// Non-responding permission check (for handlers that shape their own response
// instead of rejecting — e.g. redacting fields the caller may not read).
function callerHasPermission(req: Request, actionId: string): boolean {
	const actions = req.auth?.actions ?? [];
	return actions.includes(actionId) || actions.includes("*");
}

// Non-responding admin check (for guards that decide their own error).
function callerIsAdmin(req: Request): boolean {
	const auth = req.auth;
	if (!auth) {return false;}
	return [auth.role, ...(auth.role_all ?? [])].map((r) => String(r).toLowerCase()).includes("admin");
}

// Core roles that expand to elevated/["*"] permissions — grantable only by an admin.
function isPrivilegedRoleName(roleName: string): boolean {
	return ["admin", "manager"].includes(roleName.trim().toLowerCase());
}

// Only the restaurant OWNER (super-admin = earliest-created admin) may grant or
// revoke the admin role itself — a regular admin cannot mint more admins.
function isAdminRoleName(roleName: string): boolean {
	return roleName.trim().toLowerCase() === "admin";
}
async function callerIsSuperadmin(req: Request): Promise<boolean> {
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
function safeClientError(err: unknown, fallback: string): string {
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
function isAllOutletsSentinel(value: string | null | undefined): boolean {
	return typeof value === "string" && ALL_OUTLETS_SENTINELS.has(value.trim().toLowerCase());
}

// Admins/managers may act across outlets within their own restaurant; everyone
// else is pinned to their session outlet. RLS still bounds all of them to res_id.
function rawRequestedOutletId(req: Request): string | null {
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

function extractOutletId(req: Request): string {
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
async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 12000): Promise<Awaited<ReturnType<typeof fetch>>> {
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
function requireMobile10(res: Response, raw: unknown): string | null {
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
function optionalMobile10(res: Response, raw: unknown): { ok: true; value: string | null } | { ok: false } {
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
function passwordPolicyError(pw: string): string | null {
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

// Clamp a client-supplied ?limit= to a sane range so a huge/negative value can't
// turn a list endpoint into a DoS (unbounded scan) or error.
function clampLimit(raw: unknown, def = 100, max = 500): number {
	const v = Array.isArray(raw) ? raw[0] : raw;
	const n = (typeof v === "string" || typeof v === "number") ? Number.parseInt(String(v), 10) : NaN;
	if (!Number.isFinite(n) || n <= 0) {return def;}
	return Math.min(n, max);
}

// Validate req.body against a zod schema and 400 on failure (replaces the no-op
// `validate` for routes where the shape is known). On success req.body is the
// parsed/coerced data. Apply to new/abuse-prone routes; broaden over time.
function validateBody(schema: z.ZodTypeAny) {
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

// Body schemas for the money/bill-mutation routes. `.passthrough()` keeps every
// field the handlers read (they still coerce numbers themselves) — these only assert
// the required identifiers are present + the right type, returning a structured 400
// instead of a vague downstream error. Authz is enforced separately (validateAction
// / enforceRoles / enforceAdmin in the handlers).
const sBillRemoveItem = z.object({ table_name: z.string(), item_name: z.string() }).passthrough();
const sBillMoveItem = z.object({ from_table: z.string(), to_table: z.string(), item_name: z.string() }).passthrough();
const sBillDiscount = z.object({ table_name: z.string() }).passthrough();
const sBillApplyCoupon = z.object({ table_name: z.string(), code: z.string() }).passthrough();
const sBillItemNote = z.object({ table_name: z.string(), item_name: z.string() }).passthrough();
const sBillSplit = z.object({ table_name: z.string() }).passthrough();
const sBillMerge = z.object({ from_table: z.string(), to_table: z.string() }).passthrough();
const sBillRefund = z.object({ bill_id: z.string().optional(), table_name: z.string().optional() }).passthrough()
	.refine((b) => (typeof b.bill_id === "string" && b.bill_id.trim().length > 0) || (typeof b.table_name === "string" && b.table_name.trim().length > 0),
		{ message: "bill_id or table_name is required" });

// Constant-time string comparison for secrets/signatures (avoids timing oracles).
function timingSafeStrEqual(a: string, b: string): boolean {
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
function rateLimit(label: string, maxPerWindow: number, windowMs: number) {
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

// Localhost dev origins are always allowed; production/extra origins come from
// ALLOWED_ORIGINS (preferred, documented) or its legacy alias EXTRA_CORS_ORIGINS
// (comma-separated) so no dev tunnel is ever compiled into a production build.
// *.up.railway.app is allowed by default for the turnkey Railway setup; set
// ALLOW_RAILWAY_WILDCARD=false to lock CORS down to the explicit list only.
const allowedOrigins = new Set<string>([
	"http://localhost:9002",
	"http://localhost:3000",
	"http://localhost:3001",
	"http://localhost:5173",
	"http://localhost:9003",
	"http://localhost:9005", // temp dashboard dev server used for verification runs
	...(process.env.ALLOWED_ORIGINS ?? process.env.EXTRA_CORS_ORIGINS ?? "")
		.split(",")
		.map((o) => o.trim())
		.filter((o) => o.length > 0),
]);
const allowRailwayWildcard = process.env.ALLOW_RAILWAY_WILDCARD !== "false";

app.use((req: Request, res: Response, next: NextFunction) => {
	const origin = req.headers.origin;
	if (origin && (allowedOrigins.has(origin) || (allowRailwayWildcard && origin.endsWith('.up.railway.app')))) {
		res.header("Access-Control-Allow-Origin", origin);
		res.header("Vary", "Origin");
	}
	res.header(
		"Access-Control-Allow-Headers",
		// Custom tenant headers sent cross-origin by the guest feedback form
		// (X-Restaurant-Id / X-Employee-Id / X-Outlet-Id) must be preflight-allowed
		// or the browser blocks the request before it reaches the handler.
		"Content-Type,Authorization,X-Outlet-Id,X-Restaurant-Id,X-Employee-Id,X-Restaurant-Username",
	);
	res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
	if (req.method === "OPTIONS") {
		res.sendStatus(204);
		return;
	}
	next();
});

app.use(express.json({
	limit: "15mb",
	// Keep the raw bytes for the WhatsApp webhook only: Meta's
	// X-Hub-Signature-256 is an HMAC over the exact payload, which the parsed
	// (re-serialized) body can't reproduce.
	verify: (req, _res, buf) => {
		if ((req.url ?? "").startsWith("/webhooks/")) {(req as any).rawBody = Buffer.from(buf);}
	},
}));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));

// SaaS control-plane routes. These have their own platform-admin auth and are
// registered before — and excluded from — the tenant auth gate below.
registerPlatformRoutes(app);

// Routes that legitimately run without a session (login, registration, health,
// the public reception/voice endpoints, and the customer feedback form — a guest
// has no session; the restaurant/outlet/employee come from the feedback link).
const PUBLIC_PATHS = new Set<string>([
	"/",
	"/health",
	"/metrics",
	// App auto-update manifest: the Flutter app polls this on launch BEFORE any
	// login, so it must be reachable without a bearer token (it exposes only
	// version numbers + download URLs, no tenant data).
	"/app/version",
	"/auth/register-restaurant",
	"/auth/outlets",
	"/auth/employee-login",
	"/auth/restaurant-login",
	"/auth/logout",
	"/auth/forgot-password",
	"/realtime/session",
	"/reception/info",
	"/reception/check-availability",
	"/reception/create-reservation",
	"/feedback/submit",
	"/feedback/dynamic-follow-up",
	"/feedback/valet-checkin",
	"/get_main_feedback_question",
	"/get_follow_up_question",
	// Aggregator (Swiggy/Zomato) order intake — the per-restaurant API key in the
	// body IS the auth (validated in the handler), like the QR table token.
	"/aggregator/order",
]);

// Gate every other route behind a verified session: this authenticates the
// caller (sets req.auth) and binds the tenant-scoped DB connection used by RLS.
app.use((req: Request, res: Response, next: NextFunction) => {
	if (
		req.method === "OPTIONS" ||
		req.path.startsWith("/platform/") ||
		req.path.startsWith("/qr/") ||
		// Provider webhooks (WhatsApp inbound) carry the tenant in the slug and
		// authenticate via the provider signature / verify token in the handler.
		req.path.startsWith("/webhooks/whatsapp/") ||
		PUBLIC_PATHS.has(req.path)
	) {
		next();
		return;
	}
	void requireAuth(req, res, next);
});

// Plan feature-gating. ADDITIVE by design: a route is only blocked when the
// restaurant's plan explicitly sets the feature flag to `false`. An empty plan
// (no subscription / control plane not deployed) or an unset flag always allows,
// so this never breaks tenants without a configured plan. Runs after requireAuth
// so req.auth.features is populated from the session.
// Each entry gates a PREMIUM/tier feature only — core POS (orders, tables, menu,
// bills, payments) is never gated. Fail-open: a path is blocked ONLY when the
// plan explicitly sets features[key] === false, so adding entries never breaks a
// tenant whose plan doesn't set the flag. Operators set these per plan in the
// platform console (Plan → included features).
const FEATURE_BY_PREFIX: [RegExp, string][] = [
	[/^\/(reports|expenses|cash)\b/, "accounting"],
	[/^\/analytics\b/, "analytics"],
	[/^\/(inventory|purchase-orders|vendors)\b/, "inventory"],
	[/^\/(valet|create_valet|update_valet|add-valet|delete-valet)/, "valet"],
	[/^\/coupons\b/, "coupons"],
	[/^\/attendance\b/, "attendance"],
];
app.use((req: Request, res: Response, next: NextFunction) => {
	const features = (req.auth?.features ?? {});
	for (const [re, key] of FEATURE_BY_PREFIX) {
		if (re.test(req.path) && features[key] === false) {
			res.status(403).json({ error: `Your plan does not include ${key.replace(/_/g, " ")}.`, feature: key });
			return;
		}
	}
	next();
});

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

interface CreatedOrderInfo {
	orderId: string;
	/** Physical table for dine-in, virtual table for takeaway/delivery; may be absent. */
	table?: string | null;
	items?: unknown;
	total?: unknown;
	/** Resulting order status — "Pending" means a staffer still has to approve it. */
	status?: unknown;
	orderType?: unknown;
}

function emitOrderCreated(restaurantId: string, o: CreatedOrderInfo): void {
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

async function notifyOrderCreated(restaurantId: string, o: CreatedOrderInfo): Promise<void> {
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

// ---------------------------------------------------------------------------
// Public QR self-ordering (no staff login). The restaurant is identified by the
// slug in the URL; queries run inside that tenant's context so RLS still
// isolates data, and orders append to the table's single bill (AddOrder syncs).
// ---------------------------------------------------------------------------
app.get("/qr/:slug/menu", async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) {
		res.status(404).json({ error: "Restaurant not found" });
		return;
	}
	try {
		const data = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, async () => {
			const [items, categories, profile, branding] = await Promise.all([
				GetMenuItems(slug),
				GetMenuCategories(slug),
				GetRestaurantProfile(slug),
				GetPublicBranding(slug).catch(() => ({ logo_url: null, theme_color: null, theme_primary: null, theme_secondary: null, currency: "₹", payment_methods: [], queue_show_menu: true, require_table_otp: false, brand_config: { font: "Inter", header_style: "gradient", button_shape: "rounded", surface_style: "frosted" } })),
			]);
			return {
				restaurant_name: profile?.restaurant_name ?? slug,
				logo_url: branding.logo_url,
				theme_color: branding.theme_color,
				theme_primary: branding.theme_primary,
				theme_secondary: branding.theme_secondary,
				currency: branding.currency,
				payment_methods: branding.payment_methods,
				queue_show_menu: branding.queue_show_menu,
				// Guest QR order page reads this to know whether to prompt for the
				// per-table OTP before letting the guest place an order.
				require_table_otp: branding.require_table_otp,
				// Customer-page customization, resolved with sane defaults. The LIVE
				// keys the dark guest design consumes are color_primary (accent ramp),
				// font, header_style, button_shape and surface_style; the legacy colour
				// keys are still returned when set but drive nothing (BRAND_LIVE_FIELDS).
				brand_config: branding.brand_config,
				categories,
				items,
			};
		});
		res.json(data);
	} catch (err) {
		logger.error({ err }, "qr_menu_failed");
		res.status(500).json({ error: "Unable to load menu" });
	}
});

app.post("/qr/:slug/order", rateLimit("qr_order", 30, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) {
		res.status(404).json({ error: "Restaurant not found" });
		return;
	}

	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = resolveQrTable(resId, body);
	const customer = typeof body.customer === "string" ? body.customer.trim() : "";
	// Optional guest phone — captured into the order JSON and used to register
	// the guest as a Customer (CRM) when present. Blank stays blank; anything
	// typed must be a real 10-digit mobile (it becomes the CRM identity).
	const phoneCheck = optionalMobile10(res, body.customer_phone);
	if (!phoneCheck.ok) {return;}
	const customerPhone = phoneCheck.value ?? "";
	const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
	const items = (Array.isArray(body.items) ? body.items : [])
		.slice(0, 100) // cap line count (anti-DoS), like the waitlist preorder path
		.map((it: any) => {
			// Per-item note (e.g. "no onions") — optional, kept on the line item so
			// the kitchen sees it. Customers can add a note to any item they order.
			const itemNote = typeof it?.note === "string" ? it.note.trim().slice(0, 280) : "";
			return {
				id: String(it?.id ?? randomUUID()),
				name: String(it?.name ?? "Item"),
				price: Number(it?.price ?? 0) || 0,
				quantity: Math.max(1, Math.round(Number(it?.quantity ?? 1) || 1)),
				...(itemNote ? { note: itemNote } : {}),
			};
		})
		.filter((it) => it.name.length > 0);
	if (!tableName) {
		res.status(403).json({ error: "Invalid table code. Please re-scan the QR at your table." });
		return;
	}
	if (items.length === 0) {
		res.status(400).json({ error: "At least one item is required" });
		return;
	}

	// OTP gate: when the tenant requires a per-table code, the guest must present
	// the 4-digit OTP staff read off the floor grid before any order is accepted.
	// When the setting is OFF, VerifyTableOtp returns ok:true and this is a no-op.
	const providedOtp = typeof body.otp === "string" ? body.otp.trim() : "";
	try {
		const gate = await withTenant(
			{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
			() => VerifyTableOtp(slug, tableName, providedOtp),
		);
		if (!gate.ok) {
			// Distinguish "you typed the wrong code" (otp_wrong) from "you haven't
			// entered one yet / the table isn't seated" (otp_required) so the guest
			// UI can prompt correctly. VerifyTableOtp folds an empty code into
			// reason:"wrong", so key the code off whether an OTP was actually sent.
			const wrongCode = gate.reason === "wrong" && providedOtp.length > 0;
			res.status(403).json(
				wrongCode
					? { error: "That table OTP is incorrect. Please check the code shown by staff.", code: "otp_wrong" }
					: { error: "Enter the table OTP shown by staff before ordering.", code: "otp_required" },
			);
			return;
		}
	} catch (err) {
		// A transient failure verifying the OTP shouldn't hard-block ordering —
		// AddOrder still refuses unoccupied tables, which is the real guard.
		logger.warn({ err: (err as any)?.message ?? err }, "qr_order_otp_gate_error (failing open)");
	}

	// Server-computed total — never trust a client-sent total for billing.
	const subtotal = Math.round(items.reduce((s, it) => s + it.price * it.quantity, 0) * 100) / 100;

	try {
		const result = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, async () => {
			// SECURITY: never bill at client-sent prices. Re-price every line from the
			// menu (floor mode keeps modifier upcharges that are >= the menu base);
			// items with no current menu match are dropped.
			const priced = await repriceFromMenu(slug, items, true);
			if (priced.length === 0) {throw new Error("None of those items are available right now. Please refresh the menu.");}
			const pricedSubtotal = Math.round(priced.reduce((s, it) => s + it.price * it.quantity, 0) * 100) / 100;
			// When the restaurant disables auto-push, customer orders land as
			// "Pending" and a staffer must approve them before the kitchen sees them.
			const settings = await GetRestaurantSettings(slug).catch(() => ({ auto_push_orders: true }));
			const orderStatus = settings.auto_push_orders ? "Preparing" : "Pending";
			const orderPayload = {
				table: tableName,
				customer: customer || "QR Guest",
				...(customerPhone ? { customer_phone: customerPhone } : {}),
				note,
				items: priced,
				subtotal: pricedSubtotal,
				total: pricedSubtotal,
				taxes: [],
				applyServiceCharge: false,
				status: orderStatus,
			};
			let order: { id: string };
			try {
				order = await AddOrder(slug, orderPayload as any);
			} catch (e: any) {
				// Customers may only order at a table a staff member has already
				// seated/occupied — never self-seat from the QR page.
				if (String(e?.message ?? "").toLowerCase().includes("unoccupied")) {
					throw new Error("This table isn't active yet. Please ask a staff member to start your table before ordering.");
				}
				throw e;
			}
			// Register the guest as a Customer (best-effort) so QR orders count as
			// CRM visits instead of leaving everyone at 0 bookings.
			await linkOrderToCustomer(slug, order.id, customer, customerPhone);
			const bill = await GetBillForTable(slug, tableName).catch(() => null);
			return { order_id: order.id, bill_total: bill?.total_amt ?? subtotal, status: orderStatus };
		});
		try {
			const count = items.reduce((s, it) => s + it.quantity, 0);
			const pending = result.status === "Pending";
			await AddNotification(slug, {
				type: "order",
				title: pending ? `Order to approve · Table ${tableName}` : `New order · Table ${tableName}`,
				body: `${count} item${count > 1 ? "s" : ""} · ₹${result.bill_total}${pending ? " · tap Orders to approve" : ""}`,
				meta: { table: tableName, order_id: result.order_id, needs_approval: pending },
			});
		} catch {/* ignore */}
		// This path already notifies (above) — it only lacked the realtime nudge,
		// so the orders grid and the KDS sat on their poll for up to 10s.
		emitOrderCreated(resId, { orderId: result.order_id, table: tableName });
		res.status(201).json({ success: true, ...result });
	} catch (err: any) {
		logger.error({ err }, "qr_order_failed");
		res.status(400).json({ error: safeClientError(err, "Unable to place order") });
	}
});

// Public: verify a per-table OTP for the guest QR flow (resolve the table via the
// signed ?t= token, exactly like the other /qr/:slug/* routes). Rate-limited to a
// few tries/min so the 4-digit code can't be brute-forced. Response shape:
//   { ok:true, required:false }            — gate OFF (no code needed)
//   { ok:false, reason:"not_seated" }      — gate ON, table not occupied yet
//   { ok:false, reason:"wrong" }           — gate ON, code missing/incorrect
//   { ok:true, required:true }             — gate ON, code accepted
app.post("/qr/:slug/verify-otp", rateLimit("qr_verify_otp", 10, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = resolveQrTable(resId, body);
	if (!tableName) { res.status(403).json({ error: "Invalid table code. Please re-scan the QR at your table." }); return; }
	const otp = typeof body.otp === "string" ? body.otp : "";
	try {
		const result = await withTenant(
			{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
			() => VerifyTableOtp(slug, tableName, otp),
		);
		res.json(result);
	} catch (err) {
		logger.error({ err }, "qr_verify_otp_failed");
		res.status(500).json({ error: "Unable to verify code" });
	}
});

// Customer pays from the QR page. Uploads the screenshot (if any), records the
// payment as PENDING STAFF APPROVAL, and notifies staff in realtime.
// Customer: preview a coupon code (read-only) against a subtotal.
app.post("/qr/:slug/check-coupon", rateLimit("coupon", 20, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const code = typeof body.code === "string" ? body.code.trim() : "";
	const subtotal = Number(body.subtotal ?? 0) || 0;
	const phone = typeof body.customer_phone === "string" ? body.customer_phone.trim() : undefined;
	if (!code) { res.status(400).json({ error: "code is required" }); return; }
	try {
		const result = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => CheckCoupon(slug, code, subtotal, phone));
		res.json(result);
	} catch (e: any) { logger.error({ err: e }, "qr_check_coupon_failed"); res.status(400).json({ error: safeClientError(e, "Unable to check coupon") }); }
});

// Customer: apply a coupon code to their table's open bill.
app.post("/qr/:slug/coupon", rateLimit("coupon", 20, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = resolveQrTable(resId, body);
	const code = typeof body.code === "string" ? body.code.trim() : "";
	const phone = typeof body.customer_phone === "string" ? body.customer_phone.trim() : undefined;
	if (!tableName) { res.status(403).json({ error: "Invalid table code. Please re-scan the QR at your table." }); return; }
	if (!code) { res.status(400).json({ error: "code is required" }); return; }
	try {
		const result = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => ApplyCouponToBill(slug, tableName, code, phone));
		try { emitRestaurant(resId, "bill:updated", { table: tableName }); } catch {/* ignore */}
		res.json(result);
	} catch (e: any) { logger.error({ err: e }, "qr_apply_coupon_failed"); res.status(400).json({ error: safeClientError(e, "Unable to apply coupon") }); }
});

app.post("/qr/:slug/pay", rateLimit("qr_pay", 15, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = resolveQrTable(resId, body);
	const method = typeof body.payment_method === "string" ? body.payment_method.trim() : "";
	if (!tableName) {
		res.status(403).json({ error: "Invalid table code. Please re-scan the QR at your table." });
		return;
	}
	if (!method) {
		res.status(400).json({ error: "payment_method is required" });
		return;
	}
	// Cap the decoded upload at ~3MB (base64 is ~4/3 the byte size) so the public
	// payment-proof upload can't be abused to fill storage.
	if (typeof body.screenshot_base64 === "string" && body.screenshot_base64.length > 4_000_000) {
		res.status(413).json({ error: "Payment screenshot is too large (max ~3MB)." });
		return;
	}
	try {
		const result = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, async () => {
			// Enforce the restaurant's configured payment methods + screenshot rules.
			const settings = await GetRestaurantSettings(slug).catch(() => null);
			const cfg = settings?.payment_methods?.find((m) => m.id.toLowerCase() === method.toLowerCase());
			if (settings && (!cfg?.enabled)) {
				throw new Error("This payment method isn't accepted here.");
			}
			let screenshotUrl = typeof body.screenshot_url === "string" ? body.screenshot_url.trim() : "";
			if (!screenshotUrl && typeof body.screenshot_base64 === "string" && body.screenshot_base64.length > 0) {
				const url = await uploadScreenshot(
					body.screenshot_base64,
					typeof body.screenshot_content_type === "string" ? body.screenshot_content_type : "image/jpeg",
				);
				if (url) {screenshotUrl = url;}
			}
			return SubmitCustomerPayment(slug, tableName, method, screenshotUrl || null, cfg?.requires_screenshot);
		});
		try {
			emitRestaurant(resId, "bill:payment_submitted", {
				table: tableName,
				payment_method: result.payment_method,
				total: result.total_amt,
			});
		} catch {/* ignore realtime errors */}
		try {
			await AddNotification(slug, {
				type: "payment",
				title: `Table ${tableName} paid`,
				body: `₹${result.total_amt} via ${result.payment_method} — review & approve`,
				meta: { table: tableName, order_id: result.order_id },
			});
		} catch {/* ignore */}
		// After paying, the customer is sent to the feedback form for the waiter
		// who handled this table (null when no waiter is assigned).
		const feedback_url = await feedbackUrlForTable(slug, tableName);
		res.json({ ...result, feedback_url });
	} catch (err: any) {
		logger.error({ err }, "qr_pay_failed");
		res.status(400).json({ error: safeClientError(err, "Unable to submit payment") });
	}
});

// Customer views their table's running bill (public).
app.get("/qr/:slug/bill", async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const tableName = resolveQrTable(resId, req.query);
	if (!tableName) {
		res.status(403).json({ error: "Invalid table code. Please re-scan the QR at your table." });
		return;
	}
	try {
		const bill = await withTenant(
			{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
			() => GetBillForTable(slug, tableName),
		);
		res.json(bill ?? { total_amt: 0, covers: 0, apc: 0, order_ids: [], payment_status: null });
	} catch (err: any) {
		logger.error({ err }, "qr_bill_failed");
		res.status(400).json({ error: safeClientError(err, "Unable to load bill") });
	}
});

// Public customer reservation (from the reservation web page). Auto-allocates a
// table if one is free; records the booking as "Requested" for staff to confirm.
app.post("/qr/:slug/reserve", rateLimit("qr_reserve", 8, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const name = typeof body.name === "string" ? body.name.trim() : "";
	const rawPhone = typeof body.phone === "string" ? body.phone.trim() : "";
	const email = typeof body.email === "string" ? body.email.trim() : undefined;
	const notes = typeof body.notes === "string" ? body.notes.trim() : null;
	const partySize = Number.parseInt(String(body.party_size ?? body.number_of_people ?? ""), 10);
	const duration = Number.isFinite(Number(body.duration)) ? Number(body.duration) : 90;
	const dateStr = typeof body.date === "string" ? body.date.trim() : "";
	if (!name || !rawPhone) { res.status(400).json({ error: "Name and phone are required" }); return; }
	// The reservation's phone is how staff (and the confirmation SMS) reach the
	// guest, so it must be a real 10-digit mobile.
	const phone = requireMobile10(res, rawPhone);
	if (!phone) {return;}
	if (!Number.isFinite(partySize) || partySize <= 0) { res.status(400).json({ error: "A valid party size is required" }); return; }
	if (!dateStr) { res.status(400).json({ error: "A valid date/time is required" }); return; }
	try {
		// Deposit / min-spend rules (settings). The deposit only ever applies when
		// Razorpay is usable for this restaurant — a booking is NEVER blocked on a
		// missing/broken gateway (order-create failure falls back to no deposit).
		const settings = await withTenant(
			{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
			() => GetRestaurantSettings(slug),
		).catch(() => null);
		// The guest picks a wall-clock date+time in the restaurant's local zone —
		// interpret it in that timezone so a UTC prod server stores the correct
		// instant (bare wall-clock only; an ISO string carrying an explicit offset
		// is an absolute instant and is left untouched).
		const date = parseWallClockInZone(dateStr, settings?.timezone ?? "Asia/Kolkata");
		if (Number.isNaN(date.getTime())) { res.status(400).json({ error: "A valid date/time is required" }); return; }
		if (date.getTime() < Date.now() - 60_000) { res.status(400).json({ error: "Please pick a future date and time" }); return; }
		const depositAmount = settings?.booking_deposit_amount ?? 0;
		const depositMinParty = settings?.booking_deposit_min_party ?? 0;
		const minSpend = settings?.booking_min_spend ?? 0;
		const depositRuleTriggers = depositAmount > 0 && (depositMinParty <= 0 || partySize >= depositMinParty);
		let depositOrder: { order_id: string; key_id: string } | null = null;
		if (depositRuleTriggers) {
			const keys = await resolveRazorpayKeys(slug, resId);
			if (keys) {
				try {
					const rp = await fetchWithTimeout("https://api.razorpay.com/v1/orders", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: "Basic " + Buffer.from(`${keys.key_id}:${keys.key_secret}`).toString("base64"),
						},
						body: JSON.stringify({ amount: Math.round(depositAmount * 100), currency: "INR", receipt: `dep:${slug}:${Date.now()}` }),
					});
					const data = (await rp.json()) as Record<string, unknown>;
					if (rp.ok && typeof data.id === "string" && data.id) {
						depositOrder = { order_id: data.id, key_id: keys.key_id };
					} else {
						logger.error({ err: data }, "reserve_deposit_order_failed"); // booking proceeds without deposit
					}
				} catch (err) {
					logger.error({ err }, "reserve_deposit_order_error"); // booking proceeds without deposit
				}
			}
		}
		const result = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, async () => {
			const custId = await GetCustomerIdOrCreateCustomer(slug, name, phone, email);
			if (!custId) {throw new Error("Unable to record the guest");}
			let tableName: string | null = null;
			try { tableName = await AllocateBestTable(slug, date, duration, partySize); } catch {/* assign later */}
			const booking = await AddBooking(
				slug, custId, date, duration, partySize, tableName, "Online",
				depositOrder ? "Awaiting Deposit" : "Requested", "qr", notes,
				depositOrder ? { amount: depositAmount, status: "pending", order_id: depositOrder.order_id } : null,
				minSpend > 0 ? minSpend : null,
			);
			return { booking_id: String(booking._id), table_name: tableName };
		});
		try { emitRestaurant(resId, "booking:created", { booking_id: result.booking_id, source: "online" }); } catch {/* ignore */}
		// Staff bell: deposit bookings ping on VERIFY instead (avoids a second ping
		// and flags only bookings that are actually actionable).
		if (!depositOrder) {
			try {
				await AddNotification(slug, {
					type: "reservation",
					title: "New reservation request",
					body: `${name} · party ${partySize} · ${date.toLocaleString()}${result.table_name ? ` · ${result.table_name}` : ""}`,
					meta: { booking_id: result.booking_id },
				});
			} catch {/* ignore */}
		}
		// Automated guest confirmation (SMS/WhatsApp — fire-and-forget, logged to
		// OutboundMessages even when no provider is configured).
		queueBookingConfirm(resId, slug, {
			bookingId: result.booking_id,
			phone,
			party: partySize,
			date,
			table: result.table_name,
			depositAmount: depositOrder ? depositAmount : null,
		});
		res.status(201).json({
			success: true,
			status: depositOrder ? "Awaiting Deposit" : "Requested",
			...result,
			...(minSpend > 0 ? { min_spend: minSpend } : {}),
			...(depositOrder
				? { deposit_required: true, amount: depositAmount, order_id: depositOrder.order_id, key_id: depositOrder.key_id }
				: {}),
		});
	} catch (err: any) {
		logger.error({ err }, "qr_reserve_failed");
		res.status(400).json({ error: safeClientError(err, "Unable to create reservation") });
	}
});

// Customer completes the reservation deposit: verify the Razorpay signature
// (same HMAC scheme as /qr/:slug/razorpay/verify), mark the deposit paid and
// promote the booking from "Awaiting Deposit" to the normal "Requested" state.
app.post("/qr/:slug/reserve/verify-deposit", rateLimit("qr_reserve", 12, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const keys = await resolveRazorpayKeys(slug, resId);
	if (!keys) { res.status(503).json({ error: "Online payment isn't set up for this restaurant" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const bookingId = typeof body.booking_id === "string" ? body.booking_id.trim() : "";
	const orderId = typeof body.razorpay_order_id === "string" ? body.razorpay_order_id : "";
	const paymentId = typeof body.razorpay_payment_id === "string" ? body.razorpay_payment_id : "";
	const signature = typeof body.razorpay_signature === "string" ? body.razorpay_signature : "";
	if (!bookingId || !orderId || !paymentId || !signature) {
		res.status(400).json({ error: "booking_id and razorpay_* fields are required" });
		return;
	}
	// Verify the gateway signature (with the restaurant's secret) before trusting it.
	const expected = createHmac("sha256", keys.key_secret).update(`${orderId}|${paymentId}`).digest("hex");
	if (!timingSafeStrEqual(expected, signature)) {
		res.status(400).json({ error: "Payment signature verification failed" });
		return;
	}
	try {
		const booking = await withTenant(
			{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
			() => GetBookingSummaryById(slug, bookingId),
		);
		if (!booking) { res.status(404).json({ error: "Booking not found" }); return; }
		if (!booking.deposit) { res.status(400).json({ error: "This booking has no deposit to pay" }); return; }
		// Bind the payment to THIS booking's order (a signature for some other
		// order must not settle this deposit).
		if (booking.deposit.order_id !== orderId) { res.status(400).json({ error: "Payment does not match this booking" }); return; }
		if (booking.deposit.status === "paid") { res.status(200).json({ success: true, status: booking.status ?? "Requested", already_paid: true }); return; }
		if (booking.deposit.status !== "pending") { res.status(400).json({ error: "This deposit can no longer be paid" }); return; }
		await withTenant(
			{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
			() => UpdateBookingDeposit(slug, bookingId, { deposit_status: "paid", payment_id: paymentId, slot_status: "Requested" }),
		);
		try { emitRestaurant(resId, "booking:status_updated", { booking_id: bookingId, status: "Requested" }); } catch {/* ignore */}
		try {
			await AddNotification(slug, {
				type: "reservation",
				title: "Reservation deposit received",
				body: `${booking.customer_name} · party ${booking.number_of_people} · ₹${booking.deposit.amount} deposit paid${booking.table_name ? ` · ${booking.table_name}` : ""}`,
				meta: { booking_id: bookingId, deposit_amount: booking.deposit.amount },
			});
		} catch {/* ignore */}
		res.json({ success: true, status: "Requested" });
	} catch (err: any) {
		logger.error({ err }, "reserve_verify_deposit_failed");
		res.status(400).json({ error: safeClientError(err, "Unable to confirm the deposit") });
	}
});

// --- Razorpay online payment (primary). -------------------------------------
// Each restaurant supplies its OWN Razorpay keys in Settings so funds settle to
// their account directly (we never middle-man). Falls back to the platform env
// keys only if a restaurant hasn't configured its own. Gateway-verified, so a
// successful verify finalizes the bill (no manual approval).
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

// Resolve the keys to use for a restaurant: its own first, else the platform env.
async function resolveRazorpayKeys(slug: string, resId: string): Promise<{ key_id: string; key_secret: string } | null> {
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
const DASHBOARD_BASE_URL = (process.env.DASHBOARD_BASE_URL ?? "http://localhost:9002").replace(/\/+$/, "");

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
async function sendMessage(
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
function queueBookingConfirm(
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
async function sendDueBookingReminders(resId: string): Promise<number> {
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
function parseWaBookingCommand(text: string, now = new Date(), tz = "Asia/Kolkata"): { party: number; date: Date } | null {
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

const WA_USAGE_REPLY =
	'To book a table, send: book <guests> <date> <time> — for example "book 4 tomorrow 19:30" or "book 2 2026-07-12 20:00".';

// Meta Cloud API webhook verification handshake: echo hub.challenge when the
// verify token matches the tenant's msg_webhook_secret (shown in Settings).
app.get("/webhooks/whatsapp/:slug", async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const token = String(req.query["hub.verify_token"] ?? "");
	const challenge = String(req.query["hub.challenge"] ?? "");
	const cfg = await withTenant(
		{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
		() => GetMessagingConfig(slug),
	).catch(() => null);
	if (cfg?.webhook_secret && token && timingSafeStrEqual(token, cfg.webhook_secret)) {
		res.status(200).type("text/plain").send(challenge);
		return;
	}
	res.status(403).json({ error: "Verification failed" });
});

// Inbound WhatsApp messages → chat-based booking. Accepts BOTH payload shapes:
//  - Meta Cloud API JSON (entry[].changes[].value.messages[]), verified against
//    X-Hub-Signature-256 with msg_webhook_secret when set;
//  - Twilio form-encoding (Body/From). Twilio's own X-Twilio-Signature scheme
//    needs the exact public URL we can't know behind proxies, so Twilio-shape
//    requests are accepted unsigned (same trust level as its shared webhook
//    convention; abuse is bounded by the rate limit + booking validation).
app.post("/webhooks/whatsapp/:slug", rateLimit("wa_webhook", 60, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const body = (req.body ?? {}) as Record<string, any>;
	const tenantCtx = { res_id: resId, outlet_id: "", employeeId: "", role: "" };

	// Detect the payload shape and pull out one inbound text message.
	let inbound: { from: string; text: string; name: string | null; shape: "meta" | "twilio" } | null = null;
	const isMetaShape = Array.isArray(body.entry);
	if (isMetaShape) {
		// Signature check BEFORE trusting anything in the payload.
		try {
			const cfg = await withTenant(tenantCtx, () => GetMessagingConfig(slug));
			if (cfg.webhook_secret) {
				const sig = String(req.headers["x-hub-signature-256"] ?? "");
				const raw = (req as any).rawBody as Buffer | undefined;
				const expected = raw ? "sha256=" + createHmac("sha256", cfg.webhook_secret).update(raw).digest("hex") : "";
				if (!sig || !expected || !timingSafeStrEqual(expected, sig)) {
					res.status(403).json({ error: "Invalid signature" });
					return;
				}
			}
		} catch (err) {
			logger.warn({ err }, "wa_webhook_config_failed");
			res.status(500).json({ error: "Webhook configuration unavailable" });
			return;
		}
		outer: for (const entry of body.entry) {
			for (const change of entry?.changes ?? []) {
				const value = change?.value ?? {};
				const msg = (value.messages ?? [])[0];
				const text = typeof msg?.text?.body === "string" ? msg.text.body : "";
				if (msg && typeof msg.from === "string" && text) {
					const profileName = value.contacts?.[0]?.profile?.name;
					inbound = { from: msg.from, text, name: typeof profileName === "string" ? profileName : null, shape: "meta" };
					break outer;
				}
			}
		}
	} else if (typeof body.Body === "string" && typeof body.From === "string") {
		inbound = {
			from: String(body.From).replace(/^whatsapp:/i, ""),
			text: body.Body,
			name: typeof body.ProfileName === "string" && body.ProfileName.trim() ? body.ProfileName.trim() : null,
			shape: "twilio",
		};
	}

	// Status callbacks / non-text events: acknowledge so the provider stops retrying.
	if (!inbound?.from || !inbound.text.trim()) {
		res.status(200).json({ ignored: true });
		return;
	}

	const guestPhone = inbound.from;
	const guestName = inbound.name || "WhatsApp Guest";
	const reply = (text: string, refId?: string | null) =>
		withTenant(tenantCtx, () =>
			sendMessage(slug, { to: guestPhone, body: text, channel: "whatsapp", kind: "wa_reply", refId: refId ?? null }),
		).catch((err) => { logger.warn({ err }, "wa_reply_failed"); });

	try {
		// Load settings up front for the restaurant timezone (so "today"/"tomorrow"
		// + the requested time resolve in the restaurant's local zone) and the
		// deposit rule below.
		const settings = await withTenant(tenantCtx, () => GetRestaurantSettings(slug)).catch(() => null);
		const cmd = parseWaBookingCommand(inbound.text, new Date(), settings?.timezone ?? "Asia/Kolkata");
		if (!cmd) {
			await reply(WA_USAGE_REPLY);
		} else if (cmd.date.getTime() < Date.now() - 60_000) {
			await reply("That time has already passed — please pick a future date and time.\n" + WA_USAGE_REPLY);
		} else {
			// Same rule as /qr/:slug/reserve: when a deposit applies AND the
			// restaurant's gateway is usable, chat can't collect it — send the guest
			// to the reserve page instead of holding an unpaid slot.
			const depositAmount = settings?.booking_deposit_amount ?? 0;
			const depositMinParty = settings?.booking_deposit_min_party ?? 0;
			const depositRuleTriggers = depositAmount > 0 && (depositMinParty <= 0 || cmd.party >= depositMinParty);
			if (depositRuleTriggers && (await resolveRazorpayKeys(slug, resId))) {
				await reply(
					`Bookings for ${cmd.party} need a ₹${depositAmount} online deposit, which I can't collect over chat. ` +
					`Please book (and pay) here: ${DASHBOARD_BASE_URL}/reserve/${encodeURIComponent(slug)}`,
				);
			} else {
				// Reuse the reserve path's internals: customer → table → booking → bell.
				const result = await withTenant(tenantCtx, async () => {
					const custId = await GetCustomerIdOrCreateCustomer(slug, guestName, guestPhone);
					if (!custId) {throw new Error("Unable to record the guest");}
					let tableName: string | null = null;
					try { tableName = await AllocateBestTable(slug, cmd.date, 90, cmd.party); } catch {/* assign later */}
					const booking = await AddBooking(
						slug, custId, cmd.date, 90, cmd.party, tableName, "WhatsApp", "Requested", "whatsapp", null,
						null, (settings?.booking_min_spend ?? 0) > 0 ? settings!.booking_min_spend : null,
					);
					try {
						await AddNotification(slug, {
							type: "reservation",
							title: "New WhatsApp reservation",
							body: `${guestName} · party ${cmd.party} · ${cmd.date.toLocaleString()}${tableName ? ` · ${tableName}` : ""}`,
							meta: { booking_id: String(booking._id) },
						});
					} catch {/* ignore */}
					return { booking_id: String(booking._id), table_name: tableName };
				});
				try { emitRestaurant(resId, "booking:created", { booking_id: result.booking_id, source: "whatsapp" }); } catch {/* ignore */}
				const profile = await withTenant(tenantCtx, () => GetRestaurantProfile(slug)).catch(() => null);
				const when = cmd.date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
				await reply(
					`${profile?.restaurant_name || slug}: Booked! Party of ${cmd.party} on ${when}` +
					`${result.table_name ? ` (table ${result.table_name})` : ""}. Reply here if your plans change.`,
					result.booking_id,
				);
			}
		}
	} catch (err) {
		logger.error({ err }, "wa_webhook_booking_failed");
		await reply("Sorry — I couldn't complete that booking (no table may be free at that time). Please try another slot or call us.");
	}

	// Twilio expects TwiML (empty <Response/> = no auto-reply); Meta just wants a 2xx.
	if (inbound.shape === "twilio") {res.status(200).type("text/xml").send("<Response/>");}
	else {res.status(200).json({ success: true });}
});

// --- Public waitlist / queue (walk-ins, no session) ---
app.post("/qr/:slug/waitlist/join", rateLimit("waitlist", 12, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const name = typeof body.name === "string" ? body.name.trim() : "";
	// Phone stays optional on a walk-in join (staff can call the party by name),
	// but a typed number must be a full 10-digit mobile — the queue dedupes and
	// texts on it.
	const joinPhone = optionalMobile10(res, body.phone);
	if (!joinPhone.ok) {return;}
	const phone = joinPhone.value ?? "";
	const party = Number(body.party_size ?? 1) || 1;
	// Multi-outlet: a branch's entrance QR can carry ?outlet=<id> so the walk-in
	// lands in that branch's queue (where its staff are looking). Single-outlet
	// restaurants omit it and fall back to the default outlet.
	const outlet = (typeof body.outlet === "string" && body.outlet.trim()) || (typeof req.query.outlet === "string" ? req.query.outlet.trim() : "");
	if (!name) { res.status(400).json({ error: "Please enter your name" }); return; }
	try {
		const entry = await withTenant({ res_id: resId, outlet_id: outlet, employeeId: "", role: "" }, async () => {
			const e = await JoinWaitlist(slug, { name, phone, party_size: party });
			try { await AddNotification(slug, { type: "waitlist", title: `New in queue: ${name}`, body: `Party of ${e.party_size}`, meta: { waitlist_id: e.id } }); } catch {/* ignore */}
			return e;
		});
		try { emitRestaurant(resId, "waitlist:updated", { action: "join" }); } catch {/* ignore */}
		res.status(201).json({ token: entry.token, id: entry.id, position: entry.position, status: entry.status, party_size: entry.party_size });
	} catch (e: any) { logger.error({ err: e }, "waitlist_join_failed"); res.status(400).json({ error: safeClientError(e, "Unable to join the queue") }); }
});

app.get("/qr/:slug/waitlist/:token", async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	try {
		const entry = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => GetWaitlistEntryByToken(slug, String(req.params.token)));
		if (!entry) { res.status(404).json({ error: "Queue entry not found" }); return; }
		res.json(entry);
	} catch (e: any) { logger.error({ err: e }, "waitlist_get_failed"); res.status(500).json({ error: "Unable to fetch queue status" }); }
});

app.post("/qr/:slug/waitlist/:token/preorder", rateLimit("waitlist", 20, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	try {
		const r = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => SetWaitlistPreorder(slug, String(req.params.token), body.items));
		if ("error" in r) { res.status(400).json(r); return; }
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "waitlist_preorder_failed"); res.status(500).json({ error: "Unable to save your selection" }); }
});

// A companion who scanned the shared "join party" QR adds their own name/phone to
// the joiner's queue entry. Additive contact capture only — party_size is untouched.
app.post("/qr/:slug/waitlist/:token/member", rateLimit("waitlist", 20, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	// A party member's phone is their identity in the party list (it dedupes on
	// it), so it is required AND must be exactly 10 digits.
	const memberPhone = requireMobile10(res, body.phone);
	if (!memberPhone) {return;}
	try {
		const r = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => AddWaitlistMember(slug, String(req.params.token), { name: body.name, phone: memberPhone }));
		if ("error" in r) { res.status(400).json(r); return; }
		try { emitRestaurant(resId, "waitlist:updated", { action: "member" }); } catch {/* ignore */}
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "waitlist_member_failed"); res.status(500).json({ error: "Unable to add you to the party" }); }
});

app.post("/qr/:slug/waitlist/:token/cancel", rateLimit("waitlist", 20, 60_000), async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	try {
		await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => CancelWaitlistByToken(slug, String(req.params.token)));
		try { emitRestaurant(resId, "waitlist:updated", { action: "cancel" }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (e: any) { logger.error({ err: e }, "waitlist_cancel_failed"); res.status(500).json({ error: "Unable to leave the queue" }); }
});

app.post("/qr/:slug/razorpay/create", async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const keys = await resolveRazorpayKeys(slug, resId);
	if (!keys) { res.status(503).json({ error: "Online payment isn't set up for this restaurant" }); return; }
	const tableName = resolveQrTable(resId, (req.body ?? {}) as Record<string, unknown>);
	if (!tableName) {
		res.status(403).json({ error: "Invalid table code. Please re-scan the QR at your table." });
		return;
	}
	try {
		const bill = await withTenant(
			{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
			() => GetBillForTable(slug, tableName),
		);
		const amount = Math.round((bill?.grand_total ?? bill?.total_amt ?? 0) * 100); // paise (tax-inclusive)
		if (amount <= 0) { res.status(400).json({ error: "Nothing to pay yet" }); return; }
		const rp = await fetchWithTimeout("https://api.razorpay.com/v1/orders", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Basic " + Buffer.from(`${keys.key_id}:${keys.key_secret}`).toString("base64"),
			},
			body: JSON.stringify({ amount, currency: "INR", receipt: `${slug}:${tableName}:${Date.now()}` }),
		});
		const data = (await rp.json()) as Record<string, unknown>;
		if (!rp.ok) {
			logger.error({ err: data }, "razorpay_create_failed");
			res.status(502).json({ error: "Razorpay order creation failed" });
			return;
		}
		res.json({ razorpay_order_id: data.id, key_id: keys.key_id, amount, currency: "INR" });
	} catch (err) {
		logger.error({ err }, "razorpay_create_error");
		res.status(500).json({ error: "Unable to start payment" });
	}
});

app.post("/qr/:slug/razorpay/verify", async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const keys = await resolveRazorpayKeys(slug, resId);
	if (!keys) { res.status(503).json({ error: "Online payment isn't set up for this restaurant" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = resolveQrTable(resId, body);
	const orderId = typeof body.razorpay_order_id === "string" ? body.razorpay_order_id : "";
	const paymentId = typeof body.razorpay_payment_id === "string" ? body.razorpay_payment_id : "";
	const signature = typeof body.razorpay_signature === "string" ? body.razorpay_signature : "";
	if (!tableName) {
		res.status(403).json({ error: "Invalid table code. Please re-scan the QR at your table." });
		return;
	}
	if (!orderId || !paymentId || !signature) {
		res.status(400).json({ error: "razorpay_* fields are required" });
		return;
	}
	// Verify the gateway signature (with the restaurant's secret) before trusting it.
	const expected = createHmac("sha256", keys.key_secret).update(`${orderId}|${paymentId}`).digest("hex");
	if (!timingSafeStrEqual(expected, signature)) {
		res.status(400).json({ error: "Payment signature verification failed" });
		return;
	}
	try {
		const result = await withTenant(
			{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
			() => FinalizeOnlinePayment(slug, tableName, paymentId),
		);
		const feedback_url = await feedbackUrlForTable(slug, tableName);
		res.json({ ...result, feedback_url });
	} catch (err: any) {
		logger.error({ err }, "razorpay_verify_finalize_failed");
		res.status(400).json({ error: safeClientError(err, "Unable to finalize payment") });
	}
});

app.get('/core-roles', validateAction("17ba6407-b703-4403-ab59-13235966053f"), async (req: Request, res: Response) => {
	try {
		/* read action — not audited (avoids log clutter) */
		const rows = Object.keys(CORE_ROLES).map((role) => ({ role, actions: CORE_ROLES[role as keyof typeof CORE_ROLES] }));
		res.json(rows);
	} catch (err: any) {
		logger.error({ err }, 'error_fetching_core_roles');
		res.status(500).json({ error: 'Unable to fetch core roles' });
	}
});

// Lightweight health endpoint for readiness/liveness checks
app.get("/", (_req: Request, res: Response) => {
	res.json({
		service: "restaurant-backend",
		status: "ok",
		docs: {
			health: "/health",
			bookings: "/get-bookings",
			tables: "/get-tables",
			customers: "/get-customers",
		},
	});
});

// Public app self-update manifest. Apps (Windows/Android/iOS) call this on
// launch, compare to their built-in version, and prompt/download when newer.
// Driven by env so you can roll a release without a code change.
app.get("/app/version", (_req: Request, res: Response) => {
	res.json({
		latest: process.env.APP_LATEST_VERSION ?? "1.0.0",
		// Apps older than this should be forced to update (hard gate).
		min_supported: process.env.APP_MIN_VERSION ?? "0.0.0",
		notes: process.env.APP_UPDATE_NOTES ?? "",
		downloads: {
			windows: process.env.APP_DOWNLOAD_WINDOWS ?? "",
			android: process.env.APP_DOWNLOAD_ANDROID ?? "",
			ios: process.env.APP_DOWNLOAD_IOS ?? "",
		},
	});
});

app.get("/health", async (_req: Request, res: Response) => {
	const result: any = { status: "ok", uptime: process.uptime(), time: new Date().toISOString() };
	let dbOk = false;
	try {
		dbOk = await CheckDatabaseHealth();
	} catch {
		dbOk = false;
	}
	// Do NOT echo the raw error on this anonymous endpoint (pg errors leak schema
	// details). Just the boolean — the real error is logged server-side by the pool.
	result.database = { ok: dbOk, provider: "supabase-postgres" };
	result.realtime = { adapter: realtimeAdapterReady() ? "redis" : "in-memory" };
	if (!dbOk) {
		// Return 503 so Railway/load balancers stop routing traffic to a broken
		// instance instead of seeing a 200 with a "degraded" body.
		result.status = "degraded";
		res.status(503).json(result);
		return;
	}
	res.json(result);
});

// Prometheus scrape endpoint (optionally bearer-gated via METRICS_TOKEN).
app.get("/metrics", metricsHandler);

const registerRestaurantSchema = z.object({
	restaurantName: z.string().trim().min(1).max(120),
	adminName: z.string().trim().min(1).max(120),
	adminEmployeeId: z.string().trim().min(1).max(120),
	password: z.string().min(1).max(200),
}).passthrough();
app.post("/auth/register-restaurant", rateLimit("register", 5, 60_000), validateBody(registerRestaurantSchema), validate, async (req: Request, res: Response) => {
	const body = (req.body ?? {}) as Record<string, unknown>;
	const restaurantName = typeof body.restaurantName === "string" ? body.restaurantName.trim() : "";
	const adminName = typeof body.adminName === "string" ? body.adminName.trim() : "";
	const adminEmployeeId = typeof body.adminEmployeeId === "string" ? body.adminEmployeeId.trim() : "";
	const password = typeof body.password === "string" ? body.password : "";

	if (!restaurantName || !adminName || !adminEmployeeId || !password) {
		res.status(400).json({
			error: "restaurantName, adminName, adminEmployeeId, and password are required",
		});
		return;
	}

	const pwError = passwordPolicyError(password);
	if (pwError) {
		res.status(400).json({ error: pwError });
		return;
	}

	const restaurantId = normalizeRestaurantSlug(restaurantName);
	if (!restaurantId) {
		res.status(400).json({ error: "Restaurant name must include letters or numbers" });
		return;
	}

	try {
		try {
			await GetRestaurantUsers(restaurantId);
			res.status(409).json({ error: `Restaurant \"${restaurantName}\" is already registered.` });
			return;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("Unknown restaurant id")) {
				throw error;
			}
		}

		await EnsureRestaurantSeed({
			id: restaurantId,
			name: restaurantName,
			admin: {
				employeeId: adminEmployeeId,
				name: adminName,
				password,
			},
			tables: [],
		});

		// Start a trial on the default plan for the new tenant (best-effort; the
		// operator can reassign the plan in the platform console). Disable with
		// SAAS_AUTO_TRIAL=false.
		if (process.env.SAAS_AUTO_TRIAL !== "false") {
			try {
				const newResId = await getRestaurantIdFromUsername(restaurantId);
				if (newResId) {await startTrialIfMissing(newResId, Number(process.env.SAAS_TRIAL_DAYS || 14));}
			} catch (e) {
				logger.warn({ err: e }, "start_trial_failed");
			}
		}

		res.status(201).json({
			restaurantId,
			restaurantName,
			admin: {
				employeeId: adminEmployeeId,
				name: adminName,
				role: "admin",
			},
		});
	} catch (error) {
		logger.error({ err: error }, "register_restaurant_failed");
		res.status(500).json({ error: "Unable to register restaurant" });
	}
});

// Pre-auth outlet picker: the login screen calls this to list a restaurant's
// outlets so the user can choose WHICH outlet to sign into (employee identity is
// per-outlet — the same username may name different people in different outlets).
// PUBLIC + rate-limited. Never reveals whether a restaurant exists: an unknown
// slug/id returns {outlets:[]} with 200. Returns outlet ids + names ONLY.
app.get("/auth/outlets", rateLimit("auth-outlets", 30, 60_000), async (req: Request, res: Response) => {
	const raw = typeof req.query.restaurant === "string" ? req.query.restaurant.trim() : "";
	if (!raw) {
		res.json({ outlets: [] });
		return;
	}
	try {
		const outlets = await GetRestaurantOutletsPublic(raw);
		res.json({ outlets });
	} catch (error) {
		// Fail closed but shaped — don't leak existence (or errors) via a non-200.
		logger.error({ err: error }, "auth_outlets_failed");
		res.json({ outlets: [] });
	}
});

app.post("/auth/employee-login", rateLimit("login", 15, 60_000), validate, async (req: Request, res: Response) => {
	const body = (req.body ?? {}) as Record<string, unknown>;
	const employeeUsername = typeof body.employeeUsername === "string" ? body.employeeUsername.trim() : "";
	const password = typeof body.password === "string" ? body.password : "";
	const restaurantIdRaw = typeof body.restaurantId === "string" ? body.restaurantId.trim() : "";
	const restaurantName = typeof body.restaurantName === "string" ? body.restaurantName.trim() : "";
	// Optional: the outlet the user chose in the pre-auth picker. Omitted/empty →
	// defaults to the restaurant's first outlet (single-outlet + old clients work).
	const outletId = typeof body.outletId === "string" ? body.outletId.trim() : "";

	if (!employeeUsername || !password || !restaurantName) {
		res.status(400).json({
			error: "employeeUsername, password, and restaurantName are required",
		});
		return;
	}

	const restaurantUsername = restaurantIdRaw || normalizeRestaurantSlug(restaurantName);

	try {
		const user = await AuthenticateRestaurantEmployee(restaurantUsername, employeeUsername, password, outletId || undefined);
		if (!user) {
			res.status(401).json({ error: "Invalid employee ID or password." });
			return;
		}
		// Block sign-in for suspended / expired restaurant accounts.
		const accountStatus = await GetRestaurantAccountStatus(user.res_id);
		if (accountStatus !== "active") {
			res.status(403).json({
				error:
					accountStatus === "expired"
						? "This restaurant's subscription has expired. Please contact support."
						: "This restaurant account is suspended. Please contact support.",
			});
			return;
		}
		const plan = await GetRestaurantPlan(user.res_id);
		const token = await createSession({
			employeeId: user.employeeId,
			res_id: user.res_id,
			outlet_id: user.outlet_id,
			role: user.role,
			role_all: user.role_all,
			actions: Array.from(user.actions_set),
			features: plan.features,
			limits: plan.limits,
			action_names: user.action_names,
			emp_Fname: user.emp_Fname,
			emp_Lname: user.emp_Lname ?? null,
			employeeUsername: user.employeeUsername ?? "",
			restaurantUsername: user.restaurantUsername,
			restaurantName: user.restaurantName,
		});
		res.json({
			token,
			uid: user.employeeId,
			employeeId: user.employeeId,
			employeeUsername: user.employeeUsername ?? undefined,
			role: user.role,
			role_all: user.role_all,
			restaurantUsername: user.restaurantUsername,
			restaurantName: user.restaurantName,
			res_id: user.res_id,
			outlet_id: user.outlet_id,
			emp_Fname: user.emp_Fname,
			emp_Lname: user.emp_Lname ?? null,
			actions_set: Array.from(user.actions_set),
			action_names: user.action_names,
			features: plan.features,
			limits: plan.limits,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("Unknown restaurant id")) {
			res.status(404).json({ error: "Invalid restaurant name." });
			return;
		}

		logger.error({ err: error }, "employee_login_failed");
		res.status(500).json({ error: "Unable to sign in." });
	}
});

app.post("/auth/logout", async (req: Request, res: Response) => {
	const token = extractBearerToken(req);
	if (token) {
		try {
			await destroySession(token);
		} catch (err) {
			logger.error({ err }, "logout_failed");
		}
	}
	res.json({ ok: true });
});

// Re-hydrate the client UI from the verified session (profile + permitted
// action names for display gating). The server remains the source of truth.
app.get("/auth/me", async (req: Request, res: Response) => {
	const token = extractBearerToken(req);
	const session = token ? await getSession(token) : null;
	if (!session) {
		res.status(401).json({ error: "Unauthorized" });
		return;
	}
	res.json({
		employeeId: session.employeeId,
		uid: session.employeeId,
		employeeUsername: session.employeeUsername,
		role: session.role,
		role_all: session.role_all,
		res_id: session.res_id,
		outlet_id: session.outlet_id,
		restaurantUsername: session.restaurantUsername,
		restaurantName: session.restaurantName,
		emp_Fname: session.emp_Fname,
		emp_Lname: session.emp_Lname,
		actions_set: session.actions,
		action_names: session.action_names,
		features: session.features ?? {},
		limits: session.limits ?? {},
	});
});

app.get("/reception/info", (_req: Request, res: Response) => {
	const snapshot = getRestaurantKnowledgeSnapshot();
	res.json(snapshot);
});

app.post("/reception/check-availability", rateLimit("reception", 10, 60_000), async (req: Request, res: Response) => {
	const { reservationDate, reservationTime, partySize } = req.body ?? {};
	if (!reservationDate || !reservationTime || typeof partySize !== "number") {
		res.status(400).json({ error: "reservationDate, reservationTime, and partySize are required" });
		return;
	}

	try {
		const result = await checkAvailabilityForRequest({
			reservationDate: String(reservationDate),
			reservationTime: String(reservationTime),
			partySize: Number(partySize),
		});
		res.json(result);
	} catch (error) {
		logger.error({ err: error }, "check_availability_failed");
		res.status(500).json({ error: "Unable to check availability" });
	}
});

app.post("/reception/create-reservation", rateLimit("reception_create", 6, 60_000), async (req: Request, res: Response) => {
	const payload = req.body ?? {};
	const required = ["guestName", "contactNumber", "partySize", "reservationDate", "reservationTime"] as const;
	const missing = required.filter((key) => !payload[key]);
	if (missing.length > 0) {
		res.status(400).json({ error: `Missing fields: ${missing.join(", ")}` });
		return;
	}

	// The reception agent (and any other caller) must supply a real 10-digit mobile
	// — this becomes the reservation's Customers row.
	const contactNumber = requireMobile10(res, payload.contactNumber);
	if (!contactNumber) {return;}

	// The booking is written IN-PROCESS (like /qr/:slug/reserve). This used to
	// round-trip back into the REST API over HTTP with no Authorization header,
	// against a base URL that isn't even this server's port, so /get-tables always
	// failed and the caller was told "no table available" — with HTTP 200 — while
	// nothing was ever created.
	// Tenant comes from the request (slug/header) so this works in a multi-tenant
	// deployment; RECEPTION_RESTAURANT_ID remains the single-tenant fallback for
	// the voice agent, which has no other way to say who it is answering for.
	const slug = String(
		payload.restaurantId ?? payload.slug ?? req.headers["x-restaurant-id"] ?? process.env.RECEPTION_RESTAURANT_ID ?? "",
	).trim();
	let resId: string | null = null;
	if (slug) {
		try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	}
	if (!resId) {
		res.status(404).json({ status: "failed", message: "I couldn't find that restaurant to book against." });
		return;
	}

	const partySize = Number.parseInt(String(payload.partySize), 10);
	if (!Number.isFinite(partySize) || partySize <= 0) {
		res.status(400).json({ status: "failed", message: "A valid party size is required." });
		return;
	}
	const duration = Number.parseInt(process.env.RECEPTION_BOOKING_DURATION ?? "120", 10) || 120;
	const source = process.env.RECEPTION_BOOKING_SOURCE ?? "Voice";
	const tablePreference = typeof payload.tablePreference === "string" ? payload.tablePreference.trim() : "";
	const notes = typeof payload.specialRequests === "string" && payload.specialRequests.trim()
		? payload.specialRequests.trim()
		: null;
	const guestName = String(payload.guestName).trim();

	try {
		const settings = await withTenant(
			{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
			() => GetRestaurantSettings(slug),
		).catch(() => null);
		// The caller states a wall-clock date + time; interpret it in the
		// restaurant's own timezone so a UTC server stores the right instant.
		const date = parseWallClockInZone(`${String(payload.reservationDate).trim()}T${String(payload.reservationTime).trim()}`, settings?.timezone ?? "Asia/Kolkata");
		if (Number.isNaN(date.getTime())) {
			res.status(400).json({ status: "failed", message: "I couldn't read that date and time." });
			return;
		}
		if (date.getTime() < Date.now() - 60_000) {
			res.status(400).json({ status: "failed", message: "That slot is in the past — could we pick a future time?" });
			return;
		}

		const result = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, async () => {
			// Allocate BEFORE touching Customers so a "no table" answer doesn't leave
			// an orphan customer row behind.
			let tableName: string | null = null;
			if (tablePreference) {
				const free = await GetAvailableTablesForInterval(slug, date, duration).catch(() => []);
				const match = free.find(
					(t) => t.table_name.toLowerCase() === tablePreference.toLowerCase() && (t.capacity ?? Number.MAX_SAFE_INTEGER) >= partySize,
				);
				tableName = match?.table_name ?? null;
			}
			if (!tableName) {
				tableName = await AllocateBestTable(slug, date, duration, partySize);
			}
			if (!tableName) {return null;}
			const custId = await GetCustomerIdOrCreateCustomer(slug, guestName, contactNumber);
			if (!custId) {throw new Error("Unable to record the guest");}
			const booking = await AddBooking(
				slug, custId, date, duration, partySize, tableName, source,
				"Confirmed", "reception", notes,
			);
			return { booking_id: String(booking._id), table_name: tableName };
		});

		if (!result) {
			// Honest failure status — a 200 here is what let callers record a
			// reservation that does not exist.
			res.status(409).json({
				status: "failed",
				message: "I couldn't find an open table that fits that group at that time. I'm happy to look at another slot if you'd like!",
			});
			return;
		}

		try { emitRestaurant(resId, "booking:created", { booking_id: result.booking_id, source: "reception" }); } catch {/* ignore */}
		try {
			await AddNotification(slug, {
				type: "reservation",
				title: "New reservation (reception)",
				body: `${guestName} · party ${partySize} · ${date.toLocaleString()} · ${result.table_name}`,
				meta: { booking_id: result.booking_id },
			});
		} catch {/* ignore */}

		res.json({
			status: "confirmed",
			message: `All set! I've booked ${result.table_name} for ${guestName} on ${payload.reservationDate} at ${payload.reservationTime}. Confirmation ID: ${result.booking_id}.`,
			tableName: result.table_name,
			referenceId: result.booking_id,
		});
	} catch (error) {
		logger.error({ err: error }, "create_reservation_failed");
		res.status(500).json({ status: "failed", error: "Unable to create reservation" });
	}
});

app.post("/realtime/session", rateLimit("realtime", 5, 60_000), async (_req: Request, res: Response) => {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		res.status(500).json({ error: "OPENAI_API_KEY is not configured on the server" });
		return;
	}

	try {
		const response = await fetchWithTimeout("https://api.openai.com/v1/realtime/sessions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: OPENAI_REALTIME_MODEL,
				voice: "alloy",
			}),
		});
		const dataUnknown = await response.json();
		const data = (dataUnknown ?? {}) as Record<string, unknown>;
		if (!response.ok) {
			res.status(response.status).json(data);
			return;
		}
		res.json(data);
	} catch (error) {
		logger.error({ err: error }, "realtime_session_failed");
		res.status(500).json({ error: "Unable to create realtime session" });
	}
});

async function GetCustomerIdOrCreateCustomer(
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
async function linkOrderToCustomer(
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

/*
	Needs request body as
	{
	   "customer": {
		   "name": "Example",
		   "number": "+91 9923523232", // try keeping all in the same format whatever the format is
		   "email": "k@gmail.com" // Optional
	   }
	}
	returns the customer_id if you want to store it somewhere
*/

app.post("/add-customer", validateAction("daf1d71f-2b37-4cd1-b951-28fece7719cd"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const customer = req.body.customer;
	if (!(customer.name && customer.number)) {
		res.status(400).json({ error: "Missing required fields" });
		return;
	}
	// The customer's number IS their CRM identity (GetCustomerId matches on
	// name + number), so a partial one silently creates a duplicate person.
	const customerNumber = requireMobile10(res, customer.number);
	if (!customerNumber) {return;}

	// Optional aggregated-analytics demographics (gender / age group / pincode).
	const demographics = {
		gender: typeof customer.gender === "string" ? customer.gender : null,
		age_group: typeof customer.age_group === "string" ? customer.age_group : null,
		pincode: typeof customer.pincode === "string" ? customer.pincode : null,
	};
	const cust_id = await GetCustomerIdOrCreateCustomer(
		restaurantId,
		customer.name,
		customerNumber,
		customer.email,
		demographics,
	);

	try {
		await log_audit(req, "daf1d71f-2b37-4cd1-b951-28fece7719cd", `Created or linked customer ${customer.name}`, Audit_log_category.Customer, { customer_id: cust_id });
	} catch (err) {
		logger.warn({ err }, 'log_audit add-customer failed');
	}

	res.send(cust_id);
});

/*
	Needs request body as
	{
	   "table": {
		   "name": "T1",
		   "capacity": 4, // Optional — normal (comfortable) seats
		   "max_capacity": 6 // Optional — most it can take with extra chairs.
		                     // Defaults to capacity; clamped up if sent lower.
	   }
	}
	returns the table_name if you want to store it somewhere
*/
app.post("/add-table", validateAction("194ce6ee-b867-4be3-b5f0-48c28ce0a81b"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const table = req.body.table;
	// A whitespace-only name is truthy, so it used to slip past this check and
	// create a permanent, nameless, un-deletable table row (lookups match on the
	// trimmed name, so nothing could ever address it again).
	if (typeof table?.name !== "string" || table.name.trim().length === 0) {
		res.status(400).json({ error: "Table name is required" });
		return;
	}

	// max_capacity must be a whole number >= 1; AddTable clamps it up to capacity.
	if (table.max_capacity !== undefined && table.max_capacity !== null) {
		const requestedMax = Number(table.max_capacity);
		if (!Number.isFinite(requestedMax) || Math.round(requestedMax) < 1) {
			res.status(400).json({ error: "max_capacity must be a whole number >= 1" });
			return;
		}
	}

	let table_name: string | null = null;
	let max_capacity: number | null = null;
	try {
		const created = await AddTable(
			restaurantId,
			table.name,
			table.capacity !== undefined ? parseInt(table.capacity) : undefined,
			table.max_capacity !== undefined && table.max_capacity !== null
				? Math.round(Number(table.max_capacity))
				: undefined,
		);
		table_name = created.table_name;
		max_capacity = created.max_capacity;
	} catch (error) {
		logger.info(error);
		table_name = null;
	}
	if (!table_name) {
		res.status(400).json({ error: "Table exists" });
		return;
	}

	try {
		emitRestaurant(restaurantId, "table:added", { table_name, capacity: table.capacity, max_capacity });
	} catch (err) {
		logger.warn({ err }, "emit table:added failed");
	}

	try {
		await log_audit(req, "194ce6ee-b867-4be3-b5f0-48c28ce0a81b", `Added table ${table_name}`, Audit_log_category.Tables, {
			capacity: table.capacity,
			max_capacity,
			// before.existed=false records that the table did not exist; the undo
			// deletes it again, but only while it is still pristine.
			undo: { kind: "table_added", target_id: null, before: { existed: false }, after: { table_name } },
		});
	} catch (err) {
		logger.warn({ err }, 'log_audit add-table failed');
	}

	res.send(table_name);
});

/*
	Edit an existing table's seating numbers (same permission as adding one).
	PATCH /table/:name  body { "capacity": 4, "max_capacity": 6 } — both optional,
	omitted fields are left alone. max_capacity is clamped up to capacity.
	Returns { table_name, capacity, max_capacity }.
*/
app.patch("/table/:name", validateAction("194ce6ee-b867-4be3-b5f0-48c28ce0a81b"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const rawName = req.params.name;
	const tableName = typeof rawName === "string" ? rawName.trim() : "";
	if (!tableName) {
		res.status(400).json({ error: "Invalid table name" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const readSeats = (value: unknown): number | null | undefined => {
		if (value === undefined || value === null) {return undefined;}
		const num = Number(value);
		if (!Number.isFinite(num) || Math.round(num) < 1) {return null;}
		return Math.round(num);
	};
	const capacity = readSeats(body?.capacity);
	const maxCapacity = readSeats(body?.max_capacity);
	if (capacity === null || maxCapacity === null) {
		res.status(400).json({ error: "capacity and max_capacity must be whole numbers >= 1" });
		return;
	}
	if (capacity === undefined && maxCapacity === undefined) {
		res.status(400).json({ error: "Nothing to update" });
		return;
	}

	try {
		const updated = await UpdateTable(restaurantId, tableName, { capacity, max_capacity: maxCapacity });
		if (!updated) {
			res.status(404).json({ error: "Table not found" });
			return;
		}

		try {
			emitRestaurant(restaurantId, "table:updated", updated);
		} catch (err) {
			logger.warn({ err }, "emit table:updated failed");
		}
		try {
			await log_audit(req, "194ce6ee-b867-4be3-b5f0-48c28ce0a81b", `Updated table ${updated.table_name} seating (capacity ${updated.capacity}, max ${updated.max_capacity})`, Audit_log_category.Tables, updated);
		} catch (err) {
			logger.warn({ err }, 'log_audit update-table failed');
		}

		res.json(updated);
	} catch (error: any) {
		logger.error({ err: error }, "update_table_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to update table") });
	}
});

/*
	Seating suggestion for a party at a time window — SUGGESTS ONLY, never assigns.
	GET /tables/seating-suggestion?party=8&at=<ISO>&duration=<mins>
	Same permission as assigning tables to bookings (c7699d46…).
	See GetSeatingSuggestion for the shape.
*/
app.get("/tables/seating-suggestion", validateAction("c7699d46-0e2f-4448-b325-8ca490a5296b"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const party = Number(Array.isArray(req.query.party) ? req.query.party[0] : req.query.party);
	if (!Number.isFinite(party) || Math.round(party) < 1) {
		res.status(400).json({ error: "party must be a whole number >= 1" });
		return;
	}

	const atRaw = Array.isArray(req.query.at) ? req.query.at[0] : req.query.at;
	const at = typeof atRaw === "string" && atRaw.trim() ? new Date(atRaw) : new Date();
	if (Number.isNaN(at.getTime())) {
		res.status(400).json({ error: "at must be an ISO date-time" });
		return;
	}

	const durationRaw = Array.isArray(req.query.duration) ? req.query.duration[0] : req.query.duration;
	const duration = durationRaw === undefined || durationRaw === "" ? 120 : Number(durationRaw);
	if (!Number.isFinite(duration) || Math.round(duration) < 1) {
		res.status(400).json({ error: "duration must be a whole number of minutes >= 1" });
		return;
	}

	try {
		const suggestion = await GetSeatingSuggestion(restaurantId, Math.round(party), at, Math.round(duration));
		res.json(suggestion);
	} catch (error: any) {
		logger.error({ err: error }, "seating_suggestion_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to build a seating suggestion") });
	}
});

app.delete("/table/:name", validateAction("5777c4aa-29df-4ea1-9c45-c1038d25f746"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const rawName = req.params.name;
	const tableName = typeof rawName === "string" ? rawName.trim() : "";
	if (!tableName) {
		res.status(400).json({ error: "Invalid table name" });
		return;
	}

	const result = await RemoveTable(restaurantId, tableName);
	if (result.status === "not_found") {
		res.status(404).json({ error: "Table not found" });
		return;
	}
	if (result.status === "blocked") {
		res.status(400).json({ error: result.message });
		return;
	}

	try {
		emitRestaurant(restaurantId, "table:deleted", { table_name: tableName });
	} catch (err) {
		logger.warn({ err }, "emit table:deleted failed");
	}

	try {
		await log_audit(req, "5777c4aa-29df-4ea1-9c45-c1038d25f746", `Removed table ${tableName}`, Audit_log_category.Tables, { table_name: tableName });
	} catch (err) {
		logger.warn({ err }, 'log_audit delete-table failed');
	}

	res.status(204).send();
});

// Occupy a table (mark as occupied and set number of covers)
app.post("/occupy-table", validateAction("090ea8d4-e348-4e1b-9723-11131a73a085"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const tableName = typeof body?.table_name === 'string' ? body.table_name.trim() : '';
	const numCovers = typeof body?.num_covers === 'number' && body.num_covers >= 1 ? Math.round(body.num_covers) : null;
	const orderId = typeof body?.order_id === 'string' ? body.order_id.trim() : undefined;

	if (!tableName) {
		res.status(400).json({ error: "table_name is required" });
		return;
	}

	try {
		const result = await OccupyTable(restaurantId, tableName, numCovers, orderId ?? null, extractEmployeeId(req));
		try {
			await log_audit(req, "090ea8d4-e348-4e1b-9723-11131a73a085", `Occupied table ${tableName}${numCovers != null ? ` with ${numCovers} covers` : ""}`, Audit_log_category.Tables, { table_name: tableName, num_covers: numCovers });
		} catch (err) {
			logger.warn({ err }, 'log_audit occupy-table failed');
		}
		res.json(result);
	} catch (error: any) {
		logger.error({ err: error }, "occupy_table_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to occupy table") });
	}
});

// Update number of covers at a table
app.patch("/table-covers", validateAction("090ea8d4-e348-4e1b-9723-11131a73a085"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const tableName = typeof body?.table_name === 'string' ? body.table_name.trim() : '';
	// Covers is the APC denominator, so a missing/garbage value is REJECTED — it
	// used to silently fall back to 1, wiping the real head count (and writing an
	// audit line claiming the caller asked for 1). Numeric strings are accepted.
	const rawCovers = typeof body?.num_covers === 'number' || typeof body?.num_covers === 'string'
		? Number(body.num_covers)
		: Number.NaN;
	const numCovers = Math.round(rawCovers);

	if (!tableName) {
		res.status(400).json({ error: "table_name is required" });
		return;
	}

	if (!Number.isFinite(rawCovers) || numCovers < 1) {
		res.status(400).json({ error: "num_covers must be a whole number of 1 or more" });
		return;
	}

	try {
		const result = await UpdateTableCovers(restaurantId, tableName, numCovers);
		try {
			await log_audit(req, "090ea8d4-e348-4e1b-9723-11131a73a085", `Updated table ${tableName} covers to ${numCovers}`, Audit_log_category.Tables, { table_name: tableName, num_covers: numCovers });
		} catch (err) {
			logger.warn({ err }, 'log_audit table-covers failed');
		}
		res.json(result);
	} catch (error: any) {
		logger.error({ err: error }, "table_covers_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to update table covers") });
	}
});

// Release/unoccupy a table
app.post("/release-table", validateAction("090ea8d4-e348-4e1b-9723-11131a73a085"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const tableName = typeof body?.table_name === 'string' ? body.table_name.trim() : '';

	if (!tableName) {
		res.status(400).json({ error: "table_name is required" });
		return;
	}

	try {
		const result = await ReleaseTable(restaurantId, tableName);
		try {
			await log_audit(req, "090ea8d4-e348-4e1b-9723-11131a73a085", `Released table ${tableName}`, Audit_log_category.Tables, { table_name: tableName });
		} catch (err) {
			logger.warn({ err }, 'log_audit release-table failed');
		}
		res.json(result);
	} catch (error: any) {
		logger.error({ err: error }, "release_table_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to release table") });
	}
});

// Get table status
app.get("/table-status", validateAction("090ea8d4-e348-4e1b-9723-11131a73a085"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const tableName = typeof req.query.table_name === 'string' ? req.query.table_name.trim() : '';

	if (!tableName) {
		res.status(400).json({ error: "table_name query parameter is required" });
		return;
	}

	try {
		const result = await GetTableStatus(restaurantId, tableName);
		if (!result) {
			res.status(404).json({ error: "Table not found" });
			return;
		}
		res.json(result);
	} catch (error: any) {
		logger.error({ err: error }, "get_table_status_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to get table status") });
	}
});

// Get bill for a table (returns the current open bill and all associated orders)
app.get("/bill-for-table", validateAction("98b10bde-802d-4a5b-a726-53a826424f79"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const tableName = typeof req.query.table_name === 'string' ? req.query.table_name.trim() : '';

	if (!tableName) {
		res.status(400).json({ error: "table_name query parameter is required" });
		return;
	}

	try {
		const result = await GetBillForTable(restaurantId, tableName);
		if (!result) {
			res.status(404).json({ error: "No open bill found for this table" });
			return;
		}
		res.json(result);
	} catch (error: any) {
		logger.error({ err: error }, "get_bill_for_table_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to get bill for table") });
	}
});

/*
Needs request body as
{
	// creates customer if the name+number does not exist
	"customer": {
	   "name": "Jhon",
	   "number": "9972955566",
	   "email": "example@gmail.com" //optional
   },
   // Table must exist
   "booking": {
		"table_name": "T1",
		// Optional clubbed booking: EXTRA tables held alongside table_name (all
		// must exist). Only ever set from an explicit staff choice — the server
		// never clubs tables on its own. See GET /tables/seating-suggestion.
		"combined_table_names": ["T2"],
		"date": "YYYY-MM-DDThh:mm:ssTZD"
		"duration": "30" // in minutes
		"number_of_people": "3"
		"source": "EasyDiner" //Optional
   }
}
returns the booking id
*/
app.post("/add-booking", validateAction("3ec33182-ceb4-4d07-ac7e-84214adcf104"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const customer = req.body.customer;
	if (!(customer.name && customer.number)) {
		res.status(400).json({ error: "Missing customer field(s)" });
		return;
	}
	// Bookings are confirmed/reminded by SMS on this number, so it must be a real
	// 10-digit mobile before a Customers row is created for it.
	const bookingCustomerNumber = requireMobile10(res, customer.number);
	if (!bookingCustomerNumber) {return;}

	const booking_request = req.body.booking;
	if (
		!(
			booking_request?.date &&
			booking_request.duration &&
			booking_request.number_of_people
		)
	) {
		res.status(400).json({ error: "Missing booking field(s)" });
		return;
	}
	const cust_id = await GetCustomerIdOrCreateCustomer(
		restaurantId,
		customer.name,
		bookingCustomerNumber,
		customer.email,
	);
	if (cust_id == null) {
		res.status(400).json({
			error: "Something went wrong in creating/getting customer id",
		});
		return;
	}

	const date: Date = new Date(booking_request.date);
	if (isNaN(date.getTime())) {
		res.status(400).json({ error: "Time is in the wrong format" });
		return;
	}

	const durationMinutes = Number.parseInt(booking_request.duration, 10);
	if (!Number.isFinite(durationMinutes)) {
		res.status(400).json({ error: "Duration must be a valid number" });
		return;
	}

	const partySize = Number.parseInt(booking_request.number_of_people, 10);
	if (!Number.isFinite(partySize)) {
		res.status(400).json({ error: "number_of_people must be a valid number" });
		return;
	}

	// Clubbed booking: the caller (staff, after accepting a suggestion) names the
	// EXTRA tables explicitly. Never inferred here.
	const combinedRaw = booking_request.combined_table_names ?? booking_request.table_names;
	let combinedTableNames: string[] | null = null;
	if (combinedRaw !== undefined && combinedRaw !== null) {
		if (!Array.isArray(combinedRaw)) {
			res.status(400).json({ error: "combined_table_names must be an array of table names" });
			return;
		}
		combinedTableNames = combinedRaw.map((n: unknown) => String(n ?? "").trim()).filter((n: string) => n.length > 0);
	}

	let booking;
	let tableName: string | null = (booking_request.table_name ?? null);
	try {
		if (!tableName) {
			// Auto-allocate best fitting table if none provided
			try {
				const allocated = await AllocateBestTable(restaurantId, date, durationMinutes, partySize);
				if (allocated) {
					tableName = allocated;
				}
			} catch (allocErr) {
				logger.warn({ restaurantId, error: allocErr }, "table_allocation_failed");
			}
			if (!tableName) {
				return res.status(409).json({ error: "No table available for the requested time window", reason: "no_table_available" });
			}
		}
		booking = await AddBooking(
			restaurantId,
			cust_id,
			date,
			durationMinutes,
			partySize,
			tableName,
			booking_request.source,
			booking_request.status ?? "Confirmed",
			booking_request.from,
			booking_request.notes ?? booking_request.additional_information ?? null,
			null,
			null,
			combinedTableNames,
		);
	} catch (error) {
		logger.warn({ err: error }, "add_booking_failed");
		res.status(400).json({ error: "Oops something went wrong" });
		return;
	}
	const booking_id = String(booking._id);
	const bookingTableNames = booking.table_names;

	try {
		emitRestaurant(restaurantId, "booking:created", { booking_id, table_name: tableName });
	} catch (err) {
		logger.warn({ err }, "emit booking:created failed");
	}

	try {
		await log_audit(req, "3ec33182-ceb4-4d07-ac7e-84214adcf104", `Created booking for customer ${customer.name} at ${booking_request.date}`, Audit_log_category.Bookings, { booking_id, table_name: tableName });
	}
	catch (err) {
		logger.warn({ err }, 'log_audit add-booking failed');
	}
	// Automated guest confirmation — covers staff/dashboard bookings AND the
	// voice reception agent (which books through this endpoint). Fire-and-forget.
	if (req.auth?.res_id) {
		queueBookingConfirm(req.auth.res_id, restaurantId, {
			bookingId: booking_id,
			phone: bookingCustomerNumber,
			party: partySize,
			date,
			table: tableName,
		});
	}
	// table_name stays the primary (unchanged for single-table callers);
	// table_names lists every table the booking holds.
	res.json({ booking_id, table_name: tableName, table_names: bookingTableNames });
});

function FoldedTables(table: any[]): any[][] {
	if (table.length == 0) {
		return [];
	}

	const min: number = table[0].capacity;
	const max: number = table[table.length - 1].capacity;

	const folded_tables = [];

	let curr_index = 0;
	for (let capacity = min; capacity <= max; capacity++) {
		const cur_table = [];
		let push = false;
		while (
			table.length > curr_index &&
			table[curr_index].capacity == capacity
		) {
			cur_table.push(table[curr_index]);
			curr_index += 1;
			push = true;
		}
		if (push) {
			folded_tables.push(cur_table);
		}
	}

	return folded_tables;
}

/*
Returns tables in a 2d array in ascending order of capacity.
[
	[
		{
			"table_name": "T1",
			"capacity": 1,
			"booked": true
		},
		{
			"table_name": "T2",
			"capacity": 1
			"booked": true
		},
	],
	[
		{
			"table_name": "T6",
			"capacity": 3
			"booked": true
		},
		{
			"table_name": "T7",
			"capacity": 3
			"booked": true
		}
	],
	[
		{
			"table_name": "T10",
			"capacity": 6
			"booked": true
		}
	]
]
*/

app.get("/get-tables", validateAction("090ea8d4-e348-4e1b-9723-11131a73a085"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const timeQuery = Array.isArray(req.query.time) ? req.query.time[0] : req.query.time;
	const requestedTime = typeof timeQuery === "string" ? timeQuery : undefined;
	try {
		const tables = await GetTables(restaurantId, requestedTime);
		try {
			/* read action — not audited (avoids log clutter) */
		} catch (err) {
			logger.warn({ err }, 'log_audit get-tables failed');
		}
		res.send(tables ?? []);
	} catch (e) {
		res.status(400).send({ error: "Oops something went wrong" });
		return;
	}
});

function IsActiveBooking(booking: any, time: Date): boolean {
	const booking_start = new Date(booking.booking_date_time).getTime();
	const booking_end =
		new Date(booking_start).getTime() + booking.duration_mins * 60 * 1000;

	if (booking_start <= time.getTime() && time.getTime() <= booking_end) {
		return true;
	}

	return false;
}

/*
Gets all bookings that have not yet completed 
If needed can be modified to get bookings after a certain time very easily
Returns in this format
[
	{
		"booking_id": 1, //database stuff
		"customer_id": 1, //database stuff
		"customer_name": "Jhon", //name
		"table_name": "T3",
		"booking_date_time": "2025-08-21T23:30:34.036Z", //time of booking ISO string
		"duration_mins": 60,
		"number_of_people": 3,
		"source": null // source of the booking
		"active": true/false //whether or not the booking is currently happening
	}
]
 */
app.get("/get-bookings", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	let bookings;
	const time = new Date();
	const timeQuery = Array.isArray(req.query.time) ? req.query.time[0] : req.query.time;
	const requestedTime = typeof timeQuery === "string" ? timeQuery : undefined;

	// Bug B: `?window=upcoming|past|all` chooses which slice to return. Absent or
	// unrecognised → "upcoming", so the default response is unchanged from before.
	const windowQuery = Array.isArray(req.query.window) ? req.query.window[0] : req.query.window;
	const bookingWindow: BookingWindow =
		windowQuery === "past" || windowQuery === "all" ? windowQuery : "upcoming";

	try {
		bookings = await GetBookingsAfterTime(restaurantId, requestedTime, bookingWindow);
	} catch (error) {
		logger.info(error);
		res.status(400).send({ error: "Oops something went wrong" });
		return;
	}
	if (bookings == null) {
		res.status(400).send({ error: "Time is invalid" });
		return;
	}

	res.send(
		bookings.map((booking) => ({
			...booking,
			// A booking is only "active" while it holds a live slot — a terminal
			// status (cancelled / completed / seated / no-show) is never active even
			// if its original time window hasn't elapsed yet.
			active: !isTerminalBookingStatus(booking.status) && IsActiveBooking(booking, time),
		})),
	);
});

app.get("/valet-info", validateAction("9e37297d-408b-446d-a51b-7892ad216b7d"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	try {
		const [records, bays] = await Promise.all([
			GetValetVehicleStates(auth.restaurantId, auth.outletId),
			GetParkingBays(auth.restaurantId, auth.outletId),
		]);
		const metaByBookingId = await GetValetVehicleMetaByBookingIds(
			auth.restaurantId,
			records.map((row) => row.booking_id),
			auth.outletId,
		);

		const bayById = new Map((bays ?? []).map((bay) => [String(bay.Bay_id), bay.Bay_name]));
		const stateMap: Record<number, string> = {
			1: "Vehicle added",
			2: "Parked",
			3: "Request to bring car (from customer)",
			4: "Request accepted (from valet)",
			5: "Car arrived at entrance",
			6: "Customer took car",
		};

		const bookings = records.map((row) => {
			const meta = metaByBookingId[row.booking_id];
			return {
				booking_id: row.booking_id,
				customer_name: meta?.customer_name ?? undefined,
				bay_id: row.bay_id,
				bay_name: row.bay_id ? (bayById.get(String(row.bay_id)) ?? null) : null,
				booking_date_time: row.entry_time ?? undefined,
				exit_date_time: row.exit_time ?? undefined,
				status: stateMap[row.state] ?? "Vehicle added",
				active: row.state !== 6,
				number_plate: meta?.number_plate ?? undefined,
				// Valet ops depth (Wave D)
				parking_location: row.parking_location,
				key_holder: row.key_holder,
				key_updated_at: row.key_updated_at,
				condition_notes: row.condition_notes,
				condition_photo_url: row.condition_photo_url,
				eta_minutes: row.eta_minutes,
				requested_at: row.requested_at,
			};
		});

		try {
			/* read action — not audited (avoids log clutter) */
		} catch (err) {
			logger.warn({ err }, 'log_audit valet-info failed');
		}

		res.json({
			role: auth.role,
			generated_at: new Date().toISOString(),
			bays,
			bookings,
		});
	} catch (error) {
		logger.error({ err: error }, "valet_info_failed");
		res.status(500).json({ error: "Unable to fetch valet info" });
	}
});

// (debug endpoint removed)


app.patch("/booking/:id/status", validateAction("fdeecab6-7c3a-4239-b87c-99a96f50c551"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const rawId = req.params.id;
	const status = req.body?.status;
	const bookingId = typeof rawId === "string" ? rawId.trim() : "";
	if (!status || !bookingId) {
		res.status(400).json({ error: "Missing or invalid status/booking id" });
		return;
	}

	let updated = false;
	try {
		updated = await UpdateBookingStatus(auth.restaurantId, bookingId, status);
	} catch (error: any) {
		// Seating a party bigger than the table(s) can hold is a 400 with the
		// standard "raise max seats / club another table" message, same as
		// /occupy-table — the booking keeps its previous status.
		logger.error({ err: error }, "update_booking_status_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to update booking status") });
		return;
	}
	if (!updated) {
		res.status(404).json({ error: "Booking not found" });
		return;
	}

	try {
		emitRestaurant(auth.restaurantId, "booking:status_updated", { booking_id: bookingId, status });
	} catch (err) {
		logger.warn({ err }, "emit booking:status_updated failed");
	}

	try {
		await log_audit(req, "fdeecab6-7c3a-4239-b87c-99a96f50c551", `Updated booking status to ${status} for booking ${bookingId}`, Audit_log_category.Bookings, { booking_id: bookingId, status });
	}
	catch (err) {
		logger.warn({ err }, "log_audit booking-status-update failed");
	}

	res.json({ success: true });
});

app.post("/bills", validateAction("9186e53e-0fda-4ec8-ad20-2f9feaadb77f"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = (req.body ?? {}) as Record<string, unknown>;
	const order_id = typeof body.order_id === 'string' ? body.order_id.trim() : '';
	const total_amt = Number(body.total_amt ?? 0);
	const tax_breakdown = body.tax_breakdown ?? undefined;
	const emp_id = typeof body.emp_id === 'string' ? body.emp_id.trim() : null;
	const status = typeof body.status === 'number' ? body.status : Number(body.status ?? 1);
	const reason = typeof body.reason === 'string' ? body.reason.trim() : null;

	if (!order_id || !Number.isFinite(total_amt)) {
		res.status(400).json({ error: 'Missing order_id or total_amt' });
		return;
	}

	try {
		const result = await AddBill(restaurantId, { order_id, total_amt, emp_id, status, reason, tax_breakdown });
		try {
			await log_audit(req, "9186e53e-0fda-4ec8-ad20-2f9feaadb77f", `Created bill for order ${order_id}`, Audit_log_category.Bill, { order_id });
		} catch (err) {
			logger.warn({ err }, 'log_audit add-bill failed');
		}
		res.status(201).json(result);
	} catch (error: any) {
		logger.error({ err: error }, 'add_bill_failed');
		res.status(500).json({ error: String(error?.message ?? 'Unable to create bill') });
	}
});

app.post('/bills/replace', validateAction("383cc261-7e5c-4745-b16f-06a41e2ae047"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {return res.status(400).json({ error: 'Missing restaurantId' });}

	const body = (req.body ?? {});
	const old_order_id = typeof body.old_order_id === 'string' ? body.old_order_id.trim() : '';
	const reason = typeof body.reason === 'string' ? body.reason.trim() : null;
	const new_order = body.new_order ?? null;
	const new_bill = body.new_bill ?? null;

	if (!old_order_id) {
		return res.status(400).json({ error: 'Missing required field: old_order_id' });
	}

	if (!new_order && !new_bill) {
		return res.status(400).json({ error: 'At least one of new_order or new_bill is required' });
	}

	try {
		const result = await ReplaceBill(restaurantId, { old_order_id, reason, new_order, new_bill });
		if (!result) {return res.status(500).json({ error: 'Replace operation failed' });}
		// emit realtime events for UI updates — use order:updated for in-place changes
		try {
			const payloadForEmit = {
				order_id: old_order_id,
				bill_id: result.newBillId,
				new_order_id: result.newOrderId,
			};
			emitRestaurant(restaurantId, 'order:updated', payloadForEmit);
		} catch (e) { }
		try {
			await log_audit(req, "383cc261-7e5c-4745-b16f-06a41e2ae047", `Replaced bill for order ${old_order_id}`, Audit_log_category.Bill, { old_order_id, newBillId: result.newBillId });
		} catch (err) {
			logger.warn({ err }, 'log_audit replace-bill failed');
		}
		return res.status(200).json(result);
	} catch (err: any) {
		logger.error({ err }, 'replace_bill_failed');
		return res.status(500).json({ error: String(err?.message ?? 'Internal') });
	}
});

app.get('/bills/order/:orderId', validateAction("98b10bde-802d-4a5b-a726-53a826424f79"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {return res.status(400).json({ error: 'Missing restaurantId' });}
	const orderId = String(req.params.orderId ?? '').trim();
	if (!orderId) {return res.status(400).json({ error: 'Missing orderId' });}
	try {
		const bill = await GetBillByOrder(restaurantId, orderId);
		if (!bill) {return res.status(404).json({ error: 'Bill not found' });}
		try {
			/* read action — not audited (avoids log clutter) */
		} catch (err) {
			logger.warn({ err }, 'log_audit get-bill-by-order failed');
		}
		return res.json(bill);
	} catch (err) {
		logger.error({ err }, 'get bill by order failed');
		return res.status(500).json({ error: 'Internal' });
	}
});

app.get('/restaurant/logo', validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {return res.status(400).json({ error: 'Missing restaurantId' });}
	try {
		const logoBase64 = await GetRestaurantLogo(restaurantId);
		if (!logoBase64) {return res.status(404).json({ error: 'Logo not found' });}
		return res.json({ logo_base64: logoBase64 });
	} catch (err) {
		logger.error({ err }, 'get restaurant logo failed');
		return res.status(500).json({ error: 'Internal' });
	}
});

// Build the ESC/POS raster (GS v 0) for the restaurant's bill logo, preferring the
// SVG bill logo (rasterized via sharp) and falling back to the PNG logo. Returns
// null when no logo is configured or sharp is unavailable. Reused by the
// /restaurant/logo/escpos endpoint and embedded at the top of printed bills.
async function buildLogoEscPos(restaurantId: string, targetWidth = 576): Promise<Buffer | null> {
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

app.get('/restaurant/logo/escpos', validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {return res.status(400).json({ error: 'Missing restaurantId' });}
	try {
		const out = await buildLogoEscPos(restaurantId);
		if (!out) {return res.status(404).json({ error: 'Logo not found' });}
		res.setHeader('Content-Type', 'application/octet-stream');
		res.setHeader('Content-Length', String(out.length));
		return res.send(out);
	} catch (err) {
		logger.error({ err }, 'get restaurant escpos failed');
		return res.status(500).json({ error: 'Internal' });
	}
});

app.patch('/bills/order/:orderId/status', validateAction("07e364cc-f40d-46f3-b691-0f719dd38e0f"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: 'Missing restaurantId' });
		return;
	}
	const orderId = typeof req.params.orderId === 'string' ? req.params.orderId.trim() : '';
	const body = (req.body ?? {}) as Record<string, unknown>;
	const status = typeof body.status === 'number' ? body.status : Number(body.status ?? 0);

	if (!orderId || !Number.isFinite(status)) {
		res.status(400).json({ error: 'Missing orderId or status' });
		return;
	}

	try {
		// If items_split is provided, update per-item statuses on the order
		if (Array.isArray(body.items_split)) {
			try {
				await UpdateOrderItemsSplit(restaurantId, orderId, body.items_split);
				await log_audit(req, "07e364cc-f40d-46f3-b691-0f719dd38e0f", `Updated per-item statuses for order ${orderId}`, Audit_log_category.Bill, { order_id: orderId });
			} catch (err) {
				logger.error({ err }, 'update_order_items_split_failed');
				res.status(400).json({ error: String((err as any)?.message ?? 'Unable to update order items') });
				return;
			}
		}

		// If numeric status provided, still update bill status
		if (Number.isFinite(status)) {
			await UpdateBillStatusByOrder(restaurantId, orderId, status);
			try {
				await log_audit(req, "07e364cc-f40d-46f3-b691-0f719dd38e0f", `Updated bill status for order ${orderId} to ${status}`, Audit_log_category.Bill, { order_id: orderId, status });
			} catch (err) {
				logger.warn({ err }, 'log_audit update-bill-status failed');
			}
		}

		res.json({ success: true });
	} catch (error: any) {
		logger.error({ err: error }, 'update_bill_status_failed');
		res.status(400).json({ error: String(error?.message ?? 'Unable to update bill status') });
	}
});

app.post('/bills/order/:orderId/waiter-confirm-payment', validateAction("2393edd7-cdd9-439c-9ff3-d563d5216967"), async (req: Request, res: Response) => {
	// Permission is enforced by validateAction above, so any role (admin or a
	// custom role granted this permission) may record payment.
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const auth = { restaurantId };

	const orderId = typeof req.params.orderId === 'string' ? req.params.orderId.trim() : '';
	const paymentMethod = typeof req.body?.payment_method === 'string' ? req.body.payment_method.trim() : '';
	const paymentProofScreenshotUrl =
		typeof req.body?.payment_proof_screenshot_url === 'string'
			? req.body.payment_proof_screenshot_url.trim()
			: '';
	// Split tender: optional [{method, amount}] rows that must sum to the bill
	// total; payment_method becomes 'Split' (validated in the data layer).
	const splits = Array.isArray(req.body?.splits) ? req.body.splits : undefined;
	const waiterEmployeeId = extractEmployeeId(req);

	if (!orderId || (!paymentMethod && !splits) || !waiterEmployeeId) {
		res.status(400).json({ error: 'Missing orderId, payment_method, or employee identity' });
		return;
	}

	try {
		const result = await ConfirmBillPaymentByWaiter(
			auth.restaurantId,
			orderId,
			waiterEmployeeId,
			paymentMethod,
			paymentProofScreenshotUrl || null,
			splits,
		);
		try {
			emitRestaurant(auth.restaurantId, 'bill:waiter_confirmed_payment', {
				order_id: orderId,
				payment_method: result.payment_method,
				waiter: waiterEmployeeId,
			});
		} catch {
			// ignore realtime failures
		}
		try {
			await log_audit(req, "2393edd7-cdd9-439c-9ff3-d563d5216967", `Waiter confirmed payment for order ${orderId}`, Audit_log_category.Bill, { order_id: orderId, waiter: waiterEmployeeId, payment_method: result.payment_method });
		} catch (err) {
			logger.warn({ err }, 'log_audit waiter-confirm-payment failed');
		}
		res.json(result);
	} catch (error: any) {
		logger.error({ err: error }, 'waiter_confirm_bill_payment_failed');
		res.status(400).json({ error: String(error?.message ?? 'Unable to confirm payment') });
	}
});

app.post('/bills/order/:orderId/admin-approve-payment', validateAction("fc57d407-4bba-442c-97a2-9e6f3c57f288"), async (req: Request, res: Response) => {
	// Approval is gated by the permission (validateAction), so admin OR any
	// custom role granted "approve payment" can approve.
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const auth = { restaurantId };

	const orderId = typeof req.params.orderId === 'string' ? req.params.orderId.trim() : '';
	const adminEmployeeId = extractEmployeeId(req);
	if (!orderId || !adminEmployeeId) {
		res.status(400).json({ error: 'Missing orderId or admin identity' });
		return;
	}

	try {
		const result = await ApproveBillPaymentByAdmin(auth.restaurantId, orderId, adminEmployeeId);
		try {
			emitRestaurant(auth.restaurantId, 'bill:admin_approved_payment', {
				order_id: orderId,
				admin: adminEmployeeId,
			});
		} catch {
			// ignore realtime failures
		}
		try {
			await log_audit(req, "fc57d407-4bba-442c-97a2-9e6f3c57f288", `Admin approved payment for order ${orderId}`, Audit_log_category.Bill, { order_id: orderId, admin: adminEmployeeId });
		} catch (err) {
			logger.warn({ err }, 'log_audit admin-approve-payment failed');
		}
		res.json(result);
	} catch (error: any) {
		logger.error({ err: error }, 'admin_approve_bill_payment_failed');
		res.status(400).json({ error: String(error?.message ?? 'Unable to approve payment') });
	}
});

app.post('/bills/order/:orderId/close', validateAction("a953d044-31ba-4e31-b96f-99304fe43dfa"), async (req: Request, res: Response) => {
	// Gated by the close permission (validateAction) — admin or permissioned custom role.
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const auth = { restaurantId };

	const orderId = typeof req.params.orderId === 'string' ? req.params.orderId.trim() : '';
	const adminEmployeeId = extractEmployeeId(req);
	if (!orderId || !adminEmployeeId) {
		res.status(400).json({ error: 'Missing orderId or admin identity' });
		return;
	}

	try {
		const result = await CloseBillByOrder(auth.restaurantId, orderId, adminEmployeeId);
		try {
			emitRestaurant(auth.restaurantId, 'bill:closed', {
				order_id: orderId,
				admin: adminEmployeeId,
			});
		} catch {
			// ignore realtime failures
		}
		try {
			await log_audit(req, "a953d044-31ba-4e31-b96f-99304fe43dfa", `Closed bill for order ${orderId}`, Audit_log_category.Bill, { order_id: orderId, admin: adminEmployeeId });
		} catch (err) {
			logger.warn({ err }, 'log_audit close-bill failed');
		}
		res.json(result);
	} catch (error: any) {
		logger.error({ err: error }, 'close_bill_failed');
		res.status(400).json({ error: String(error?.message ?? 'Unable to close bill') });
	}
});

app.patch("/booking/:id/table", validateAction("c7699d46-0e2f-4448-b325-8ca490a5296b"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const rawId = req.params.id;
	const bookingId = typeof rawId === "string" ? rawId.trim() : "";
	if (!bookingId) {
		res.status(400).json({ error: "Invalid booking id" });
		return;
	}

	const tableNameRaw = req.body?.table_name;
	const tableName =
		tableNameRaw === null || tableNameRaw === undefined
			? null
			: String(tableNameRaw).trim() || null;

	// Clubbed assignment: omit the key to leave the current set alone, send [] to
	// un-club back to the single primary table.
	const combinedRaw = req.body?.combined_table_names;
	let combinedTableNames: string[] | undefined;
	if (combinedRaw !== undefined && combinedRaw !== null) {
		if (!Array.isArray(combinedRaw)) {
			res.status(400).json({ error: "combined_table_names must be an array of table names" });
			return;
		}
		combinedTableNames = combinedRaw.map((n: unknown) => String(n ?? "").trim()).filter((n: string) => n.length > 0);
	}

	try {
		const updated = await AssignTableToBooking(auth.restaurantId, bookingId, tableName, combinedTableNames);
		if (!updated) {
			res.status(404).json({ error: "Booking not found" });
			return;
		}
	} catch (error) {
		res.status(400).json({ error: "Unable to assign table" });
		return;
	}

	try {
		await log_audit(req, "c7699d46-0e2f-4448-b325-8ca490a5296b", `Assigned table ${[tableName ?? 'null', ...(combinedTableNames ?? [])].join(' + ')} to booking ${bookingId}`, Audit_log_category.Bookings, { booking_id: bookingId, table_name: tableName, combined_table_names: combinedTableNames ?? null });
	} catch (err) {
		logger.warn({ err }, 'log_audit assign-table-to-booking failed');
	}

	res.json({ success: true });
});


app.delete("/booking/:id", validateAction("1f176202-d5e7-4bb0-802c-275a42425394"), async (req: Request, res: Response) => {
	const bookingIdParam = req.params.id;
	const bookingId = typeof bookingIdParam === "string" ? bookingIdParam.trim() : "";
	if (!bookingId) {
		res.status(400).json({ error: "Invalid booking id" });
		return;
	}

	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	// Deposit-paid bookings are NOT hard-deleted on cancel: the row is kept as
	// the deposit record (status Cancelled) so staff can see whether the money is
	// refund_due (cancelled earlier than the cancel window before the slot) or
	// forfeited (late cancel). Refunds are made MANUALLY from the restaurant's
	// Razorpay dashboard — no automatic gateway refund is attempted.
	const existing = await GetBookingSummaryById(restaurantId, bookingId).catch(() => null);
	if (existing?.deposit?.status === "paid") {
		const settings = await GetRestaurantSettings(restaurantId).catch(() => null);
		const windowH = settings?.booking_cancel_window_hours ?? 24;
		const start = new Date(existing.booking_date_time).getTime();
		const earlyCancel = Number.isFinite(start) && Date.now() < start - windowH * 3_600_000;
		const depositStatus = earlyCancel ? "refund_due" as const : "forfeited" as const;
		await UpdateBookingDeposit(restaurantId, bookingId, { deposit_status: depositStatus, slot_status: "Cancelled" });
		try {
			await AddNotification(restaurantId, {
				type: "reservation",
				title: earlyCancel ? `Refund due ₹${existing.deposit.amount} to ${existing.customer_name}` : `Deposit ₹${existing.deposit.amount} forfeited`,
				body: earlyCancel
					? `Booking cancelled outside the ${windowH}h window — refund the deposit from your Razorpay dashboard (payment ${existing.deposit.payment_id ?? "n/a"}).`
					: `${existing.customer_name} cancelled inside the ${windowH}h window — deposit is kept.`,
				meta: { booking_id: bookingId, deposit_status: depositStatus, deposit_amount: existing.deposit.amount },
			});
		} catch {/* ignore */}
		try {
			emitRestaurant(restaurantId, "booking:status_updated", { booking_id: bookingId, status: "Cancelled" });
		} catch (err) {
			logger.warn({ err }, "emit booking:cancelled failed");
		}
		try {
			await log_audit(req, "1f176202-d5e7-4bb0-802c-275a42425394", `Canceled booking ${bookingId} (deposit ₹${existing.deposit.amount} ${depositStatus})`, Audit_log_category.Bookings, { booking_id: bookingId, deposit_status: depositStatus });
		} catch (err) {
			logger.warn({ err }, 'log_audit delete-booking failed');
		}
		res.json({ success: true, deposit_status: depositStatus });
		return;
	}

	const deleted = await DeleteBooking(restaurantId, bookingId);
	if (!deleted) {
		res.status(404).json({ error: "Booking not found" });
		return;
	}

	try {
		emitRestaurant(restaurantId, "booking:deleted", { booking_id: bookingId });
	} catch (err) {
		logger.warn({ err }, "emit booking:deleted failed");
	}

	try {
		await log_audit(req, "1f176202-d5e7-4bb0-802c-275a42425394", `Canceled booking ${bookingId}`, Audit_log_category.Bookings, { booking_id: bookingId });
	} catch (err) {
		logger.warn({ err }, 'log_audit delete-booking failed');
	}

	res.status(204).send();
});

/*
	Returns all customer data
	[
		{
			"customer_id": 1,
			"name": "Dodo",
			"booking_count": 5,
			"has_booking": true // Does the customer have an active booking
		}
	]
*/
app.get("/get-customers", validateAction("3c530903-324c-4bbe-802b-849763518920"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	let customers;
	try {
		customers = await GetCustomerAndBookings(restaurantId);
	} catch {
		res.status(400).send({ error: "Oops something went wrong" });
		return;
	}

	const customersWithStatus = await Promise.all(
		customers.map(async (customer) => ({
			...customer,
			has_booking: await HasActiveBooking(restaurantId, customer.customer_id),
		})),
	);

	try {
		/* read action — not audited (avoids log clutter) */
	} catch (err) {
		logger.warn({ err }, 'log_audit get-customers failed');
	}

	res.send(customersWithStatus);
});

// Guest CRM insights: per-customer visits / spend / last visit / avg feedback
// rating + segment (new | regular | high-spend | dormant). Same permission as
// the customer list so the CRM page loads both together.
app.get("/customers/insights", validateAction("3c530903-324c-4bbe-802b-849763518920"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		res.json(await GetCustomerInsights(restaurantId));
	} catch (err) {
		logger.error({ err }, "get_customer_insights_failed");
		res.status(500).json({ error: "Unable to fetch customer insights" });
	}
});

/*
	returns the count of bookings in a range
	requests body must be like this
	{
		start: 1004038434 // anything that can be parsed by Date()
		end: 1004038434 // anything that can be parsed by Date()
	}
	Date.parse documentation
	https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/parse
	for the best results just send ms since epoch
	returns the number of bookings in that range
*/
app.get("/get-withen-range", validateAction("0a98cf2b-8b42-47a7-a523-b7bb73cb870e"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).send({ Error: "Missing restaurantId" });
		return;
	}
	if (!(req.body.start && req.body.end)) {
		res.status(400).send({ Error: "Missing fields" });
	}

	const start = new Date(req.body.start);
	const end = new Date(req.body.end);

	if (isNaN(start.valueOf()) || isNaN(end.valueOf())) {
		res.status(400).send({
			Error: "Dates provided is not formated correctley",
		});
	}

	const count = await GetBookingsInRange(restaurantId, start, end);

	if (count == null) {
		res.status(400).send({ Error: "Oops something went wrong" });
	}

	try {
		/* read action — not audited (avoids log clutter) */
	} catch (err) {
		logger.warn({ err }, 'log_audit get-withen-range failed');
	}

	res.send(count);
});

app.get("/audit-logs", validateAction("91b24293-7b88-4fe4-8cf5-deb6faaba4f5"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const limit = clampLimit(req.query.limit, 100, 500);
	const offset = Math.max(0, Math.min(Number(req.query.offset) || 0, 100000));
	const categoryRaw = typeof req.query.category === "string" ? req.query.category : "";
	const category = (Object.values(Audit_log_category) as string[]).includes(categoryRaw) ? categoryRaw : undefined;
	const search = typeof req.query.search === "string" ? req.query.search.slice(0, 200) : undefined;
	const from = typeof req.query.from === "string" ? req.query.from : undefined;
	const to = typeof req.query.to === "string" ? req.query.to : undefined;

	try {
		const logs = await GetAuditLogs(restaurantId, { limit, offset, category, search, from, to });
		// try {
		// 	await log_audit(req, "91b24293-7b88-4fe4-8cf5-deb6faaba4f5", `Fetched audit logs`, Audit_log_category.General, { limit });
		// } catch (err) {
		// 	console.warn('log_audit get-audit-logs failed', err);
		// }
		res.json(logs);
	} catch (error) {
		res.status(500).json({ error: "Unable to fetch audit logs" });
	}
});

// Reverse one eligible audit entry. Requires BOTH the undo permission AND the
// permission of the ORIGINAL action — you may not undo a menu price change
// unless you could have made one. Admin ("*") satisfies both.
//
// The original row is never touched: a successful undo APPENDS a new entry
// carrying { undo_of: <original id> }. Every refusal class maps to a status:
//   403 no-permission | 404 not-found
//   400 not-allowlisted / blocklisted / missing-before-state / too-old
//       / cannot-restore-null / cannot-restore-key / target-name-taken
//   409 already-undone / superseded / target-gone / bill-settled
//
// The whole reversal (re-evaluation, the compensating write, and the appended
// undo row) runs in ONE transaction with the original row locked FOR UPDATE, so
// concurrent undos of the same entry produce exactly one 200 and 409s for the
// rest — backed by a partial UNIQUE index on the undo_of back-reference.
app.post("/audit-logs/:id/undo", validate, async (req: Request, res: Response) => {
	const scope = await enforcePermission(req, res, AUDIT_UNDO_PERMISSION_ID);
	if (!scope) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const logId = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!logId) { res.status(400).json({ error: "Missing audit log id" }); return; }
	const employeeId = extractEmployeeId(req);
	if (!employeeId) { res.status(401).json({ error: "Unauthorized", details: "Missing employee identity" }); return; }

	const granted = req.auth?.actions ?? [];
	const isAdmin = callerIsAdmin(req);
	const isOwner = await callerIsSuperadmin(req);

	// Mirrors the guards on /roles/assign and /roles/remove: reversing a role
	// change must not become a back door around the privilege-escalation rules
	// those routes enforce. Only the roles the diff actually touches are checked.
	const roleGuard = (kind: string, envelope: { before: Record<string, unknown>; after: Record<string, unknown> }): true | string => {
		if (kind !== "role_assign" && kind !== "role_remove") {return true;}
		const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
		const before = list(envelope.before.roles);
		const after = list(envelope.after.roles);
		const touched = [...before, ...after].filter((r) => !before.includes(r) || !after.includes(r));
		if (touched.some((r) => isAdminRoleName(r)) && !isOwner) {
			return "Only the owner (super-admin) can undo a change to the admin role.";
		}
		if (touched.some((r) => isPrivilegedRoleName(r)) && !isAdmin) {
			return "Only an admin can undo a change to the admin or manager role.";
		}
		return true;
	};

	const permitted = (actionId: string, kind: string, envelope: { before: Record<string, unknown>; after: Record<string, unknown> }): true | string => {
		if (!granted.includes("*") && !granted.includes(actionId)) {
			return "You do not have permission for the action you are trying to undo.";
		}
		return roleGuard(kind, envelope);
	};

	try {
		const result = await PerformAuditUndo(restaurantId, logId, employeeId, permitted);
		if (result.ok) {
			res.json({ success: true, undo_log_id: result.undo_log_id, restored: result.restored });
			return;
		}
		const status = result.code === "not_found"
			? 404
			: result.code === "failed"
				? (result.required_action_id ? 403 : 400)
				: (["already_undone", "superseded", "target_gone", "bill_settled"].includes(result.code) ? 409 : 400);
		res.status(status).json({ error: result.message, reason: result.code });
	} catch (err) {
		logger.error({ err }, "audit_undo_failed");
		res.status(500).json({ error: "Unable to undo this action" });
	}
});

// app.post("/audit-logs", validateAction("722e1023-99f8-4905-ab51-97404694eab6"), async (req: Request, res: Response) => {
// 	const restaurantId = extractRestaurantId(req);
// 	if (!restaurantId) {
// 		res.status(400).json({ error: "Missing restaurantId" });
// 		return;
// 	}

// 	const body = (req.body ?? {}) as Record<string, unknown>;
// 	const employeeFromHeader = extractEmployeeId(req)?.trim() ?? "";
// 	const employeeFromBody = typeof body.employee === "string" ? body.employee.trim() : "";
// 	const employeeIdFromBody = typeof body.employee_id === "string" ? body.employee_id.trim() : "";
// 	const employee = employeeFromHeader || employeeIdFromBody || employeeFromBody;
// 	const action = typeof body.action === "string" ? body.action.trim() : "";
// 	const details = typeof body.details === "string" ? body.details.trim() : "";

// 	if (!employee || !action) {
// 		res.status(400).json({ error: "Missing employee or action" });
// 		return;
// 	}

// 	try {
// 		await AddAuditLogEntryLegacy(restaurantId, {
// 			employee,
// 			employeeId: employeeFromHeader || employeeIdFromBody || null,
// 			action,
// 			details: details || null,
// 			category: Audit_log_category.General
// 		});
// 		try {
// 			await log_audit(req, "722e1023-99f8-4905-ab51-97404694eab6", `Recorded audit-log entry ${action}`, Audit_log_category.General, { employee });
// 		} catch (err) {
// 			console.warn('log_audit post-audit-logs failed', err);
// 		}
// 		res.status(201).json({ success: true });
// 	} catch (error) {
// 		console.error("add_audit_log_failed", error);
// 		res.status(500).json({ error: "Unable to record audit log" });
// 	}
// });

app.get("/inventory", validateAction("77e41c84-ebf4-4542-a75b-c9e72e03b570"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	try {
		const items = await GetInventoryItems(restaurantId);
		try {
			/* read action — not audited (avoids log clutter) */
		} catch (err) {
			logger.warn({ err }, 'log_audit get-inventory failed');
		}
		res.json(items);
	} catch (error) {
		logger.error({ err: error }, "get_inventory_failed");
		res.status(500).json({ error: "Unable to fetch inventory" });
	}
});

app.post("/inventory", validateAction("dfe2cde8-c159-4685-b015-ec7b0d4386eb"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = (req.body ?? {}) as Record<string, unknown>;
	const name = typeof body.name === "string" ? body.name.trim() : "";
	const stock = Number(body.stock ?? 0);
	if (!name || !Number.isFinite(stock)) {
		res.status(400).json({ error: "name and stock are required" });
		return;
	}

	try {
		const result = await UpsertInventoryItem(restaurantId, {
			id: typeof body.id === "string" ? body.id : undefined,
			name,
			category: typeof body.category === "string" ? body.category : undefined,
			stock,
			unit: typeof body.unit === "string" ? body.unit : undefined,
		});
		await log_audit(req, "dfe2cde8-c159-4685-b015-ec7b0d4386eb", `Upserted inventory item ${name} with stock ${stock}`, Audit_log_category.Inventory);
		res.status(201).json(result);
	} catch (error) {
		logger.error({ err: error }, "upsert_inventory_failed");
		res.status(500).json({ error: "Unable to save inventory item" });
	}
});

// --- Vendors + stock movements (purchases / wastage) ------------------------
const INV_VIEW = "77e41c84-ebf4-4542-a75b-c9e72e03b570";
const INV_MANAGE = "dfe2cde8-c159-4685-b015-ec7b0d4386eb";

app.get("/vendors", validateAction(INV_VIEW), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { res.json({ vendors: await GetVendors(restaurantId) }); }
	catch (e) { logger.error({ err: e }, "get_vendors_failed"); res.status(500).json({ error: "Unable to fetch vendors" }); }
});
app.post("/vendors", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	const name = typeof b.name === "string" ? b.name.trim() : "";
	if (!name) { res.status(400).json({ error: "Vendor name is required" }); return; }
	try { res.status(201).json(await AddVendor(restaurantId, { name, phone: typeof b.phone === "string" ? b.phone : undefined, email: typeof b.email === "string" ? b.email : undefined, notes: typeof b.notes === "string" ? b.notes : undefined })); }
	catch (e: any) { logger.error({ err: e }, "add_vendor_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to add vendor") }); }
});
app.put("/vendors/:id", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	const b = (req.body ?? {}) as Record<string, unknown>;
	try { await UpdateVendor(restaurantId, id, { name: typeof b.name === "string" ? b.name : undefined, phone: typeof b.phone === "string" ? b.phone : undefined, email: typeof b.email === "string" ? b.email : undefined, notes: typeof b.notes === "string" ? b.notes : undefined }); res.json({ success: true }); }
	catch (e: any) { logger.error({ err: e }, "update_vendor_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to update vendor") }); }
});
app.delete("/vendors/:id", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	try { await DeleteVendor(restaurantId, id); res.json({ success: true }); }
	catch (e) { logger.error({ err: e }, "delete_vendor_failed"); res.status(400).json({ error: "Unable to delete vendor" }); }
});

app.post("/inventory/receive", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	const inventory_id = typeof b.inventory_id === "string" ? b.inventory_id.trim() : "";
	const qty = Number(b.qty ?? 0) || 0;
	if (!inventory_id || qty <= 0) { res.status(400).json({ error: "inventory_id and a positive qty are required" }); return; }
	try {
		const r = await ReceiveStock(restaurantId, { inventory_id, qty, vendor_id: typeof b.vendor_id === "string" ? b.vendor_id : undefined, unit_cost: typeof b.unit_cost === "number" ? b.unit_cost : undefined, note: typeof b.note === "string" ? b.note : undefined, createdBy: extractEmployeeId(req) ?? undefined });
		// Undo posts a COMPENSATING movement back to the prior quantity — the
		// original StockMovements row is never removed.
		try { await log_audit(req, INV_MANAGE, `Received ${qty} stock`, Audit_log_category.Inventory, {
			inventory_id,
			undo: { kind: "inventory_adjust", target_id: inventory_id, before: { quantity: r.quantity - qty }, after: { quantity: r.quantity } },
		}); } catch {/* ignore */}
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "receive_stock_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to receive stock") }); }
});
app.post("/inventory/wastage", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	const inventory_id = typeof b.inventory_id === "string" ? b.inventory_id.trim() : "";
	const qty = Number(b.qty ?? 0) || 0;
	if (!inventory_id || qty <= 0) { res.status(400).json({ error: "inventory_id and a positive qty are required" }); return; }
	try {
		const r = await RecordWastage(restaurantId, { inventory_id, qty, reason: typeof b.reason === "string" ? b.reason : undefined, createdBy: extractEmployeeId(req) ?? undefined });
		// Undo posts a COMPENSATING receipt back to the prior quantity — the
		// original StockMovements row is never removed.
		try { await log_audit(req, INV_MANAGE, `Wastage ${qty}`, Audit_log_category.Inventory, {
			inventory_id,
			undo: { kind: "inventory_adjust", target_id: inventory_id, before: { quantity: r.quantity + qty }, after: { quantity: r.quantity } },
		}); } catch {/* ignore */}
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "record_wastage_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to record wastage") }); }
});
// Issue stock from the store to the kitchen (feeds the food-cost % KPI).
app.post("/inventory/issue", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	const inventory_id = typeof b.inventory_id === "string" ? b.inventory_id.trim() : "";
	const qty = Number(b.qty ?? 0) || 0;
	if (!inventory_id || qty <= 0) { res.status(400).json({ error: "inventory_id and a positive qty are required" }); return; }
	try {
		const r = await IssueStock(restaurantId, { inventory_id, qty, note: typeof b.note === "string" ? b.note : undefined, createdBy: extractEmployeeId(req) ?? undefined });
		try { await log_audit(req, ISSUE_STOCK_ACTION_ID, `Issued ${qty} to kitchen`, Audit_log_category.Inventory, { inventory_id }); } catch {/* ignore */}
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "issue_stock_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to issue stock") }); }
});
// Vendor price history for one ingredient (costed purchases only).
app.get("/inventory/price-history", validateAction(INV_VIEW), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const inventoryId = typeof req.query.inventory_id === "string" ? req.query.inventory_id.trim() : "";
	if (!inventoryId) { res.status(400).json({ error: "inventory_id is required" }); return; }
	try { res.json(await GetVendorPriceHistory(restaurantId, inventoryId)); }
	catch (e) { logger.error({ err: e }, "get_price_history_failed"); res.status(500).json({ error: "Unable to fetch price history" }); }
});
// Set (or clear, with null) an inventory item's expiry date.
app.post("/inventory/expiry", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	const inventory_id = typeof b.inventory_id === "string" ? b.inventory_id.trim() : "";
	const expiry = typeof b.expiry_date === "string" && b.expiry_date.trim() ? b.expiry_date.trim() : null;
	if (!inventory_id) { res.status(400).json({ error: "inventory_id is required" }); return; }
	try {
		await SetInventoryExpiry(restaurantId, inventory_id, expiry);
		try { await log_audit(req, INV_MANAGE, expiry ? `Set expiry ${expiry}` : "Cleared expiry", Audit_log_category.Inventory, { inventory_id }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (e: any) { logger.error({ err: e }, "set_expiry_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to set expiry") }); }
});
app.get("/inventory/movements", validateAction(INV_VIEW), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const from = typeof req.query.from === "string" ? req.query.from : undefined;
	const to = typeof req.query.to === "string" ? req.query.to : undefined;
	try { res.json({ movements: await GetStockMovements(restaurantId, from, to) }); }
	catch (e) { logger.error({ err: e }, "get_movements_failed"); res.status(500).json({ error: "Unable to fetch movements" }); }
});

// --- Purchase orders ---
app.get("/purchase-orders", validateAction(INV_VIEW), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const status = typeof req.query.status === "string" ? req.query.status : undefined;
	const from = typeof req.query.from === "string" ? req.query.from : undefined;
	const to = typeof req.query.to === "string" ? req.query.to : undefined;
	try { res.json({ orders: await GetPurchaseOrders(restaurantId, { status, from, to }) }); }
	catch (e) { logger.error({ err: e }, "get_purchase_orders_failed"); res.status(500).json({ error: "Unable to fetch purchase orders" }); }
});

app.get("/purchase-orders/:id", validateAction(INV_VIEW), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const order = await GetPurchaseOrder(restaurantId, String(req.params.id));
		if (!order) { res.status(404).json({ error: "Purchase order not found" }); return; }
		res.json(order);
	} catch (e) { logger.error({ err: e }, "get_purchase_order_failed"); res.status(500).json({ error: "Unable to fetch purchase order" }); }
});

app.post("/purchase-orders", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	try {
		const created = await CreatePurchaseOrder(restaurantId, {
			vendor_id: typeof b.vendor_id === "string" ? b.vendor_id : undefined,
			vendor_name: typeof b.vendor_name === "string" ? b.vendor_name : undefined,
			items: b.items,
			notes: typeof b.notes === "string" ? b.notes : undefined,
			expected_date: typeof b.expected_date === "string" ? b.expected_date : undefined,
			status: typeof b.status === "string" ? b.status : undefined,
			createdBy: extractEmployeeId(req) ?? undefined,
		});
		try { await log_audit(req, INV_MANAGE, `Created purchase order ${created.id} (${created.items.length} items, ${created.total_cost})`, Audit_log_category.Inventory, { id: created.id }); } catch {/* ignore */}
		res.json(created);
	} catch (e: any) { logger.error({ err: e }, "create_purchase_order_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to create purchase order") }); }
});

app.post("/purchase-orders/:id/status", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	const status = typeof b.status === "string" ? b.status : "";
	try {
		const updated = await SetPurchaseOrderStatus(restaurantId, String(req.params.id), status);
		try { await log_audit(req, INV_MANAGE, `Purchase order ${updated.id} → ${updated.status}`, Audit_log_category.Inventory, { id: updated.id }); } catch {/* ignore */}
		res.json(updated);
	} catch (e: any) { logger.error({ err: e }, "set_po_status_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to update purchase order") }); }
});

app.post("/purchase-orders/:id/receive", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	const lines = Array.isArray(b.lines)
		? (b.lines).map((l) => ({ inventory_id: String(l?.inventory_id ?? ""), qty_received: Number(l?.qty_received ?? 0) || 0 }))
		: [];
	const qualityRating = typeof b.quality_rating === "number" && b.quality_rating >= 1 && b.quality_rating <= 5 ? b.quality_rating : null;
	try {
		const updated = await ReceivePurchaseOrder(restaurantId, String(req.params.id), lines, extractEmployeeId(req) ?? undefined, qualityRating);
		try { await log_audit(req, INV_MANAGE, `Received against purchase order ${updated.id} (now ${updated.status})`, Audit_log_category.Inventory, { id: updated.id }); } catch {/* ignore */}
		res.json(updated);
	} catch (e: any) { logger.error({ err: e }, "receive_po_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to receive purchase order") }); }
});

app.delete("/purchase-orders/:id", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		await DeletePurchaseOrder(restaurantId, String(req.params.id));
		try { await log_audit(req, INV_MANAGE, `Deleted purchase order ${req.params.id}`, Audit_log_category.Inventory, { id: req.params.id }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (e: any) { logger.error({ err: e }, "delete_po_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to delete purchase order") }); }
});

app.delete("/inventory/:id", validateAction("add0a9ec-a563-4903-9a24-d2e0b46361a5"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const rawId = req.params.id;
	const inventoryId = typeof rawId === "string" ? rawId.trim() : "";
	if (!inventoryId) {
		res.status(400).json({ error: "Invalid inventory id" });
		return;
	}

	try {
		const removed = await DeleteInventoryItem(restaurantId, inventoryId);
		if (!removed) {
			res.status(404).json({ error: "Inventory item not found" });
			return;
		}
		res.status(204).send();
	} catch (error) {
		logger.error({ err: error }, "delete_inventory_failed");
		res.status(500).json({ error: "Unable to delete inventory item" });
	}
});

app.get("/menu", validateAction("f4177b38-77fa-4d8c-9fbd-c4f06bf28610"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	try {
		const items = await GetMenuItems(restaurantId);
		res.json(items);
	} catch (error) {
		logger.error({ err: error }, "get_menu_failed");
		res.status(500).json({ error: "Unable to fetch menu" });
	}
});

// Theoretical food cost + margin per dish, from Menu.description.recipe[] and
// the latest recorded purchase unit costs.
app.get("/menu/costing", validateAction("f4177b38-77fa-4d8c-9fbd-c4f06bf28610"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { res.json(await GetMenuCosting(restaurantId)); }
	catch (e) { logger.error({ err: e }, "get_menu_costing_failed"); res.status(500).json({ error: "Unable to compute menu costing" }); }
});

app.get("/menu/categories", validateAction("f4177b38-77fa-4d8c-9fbd-c4f06bf28610"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	try {
		const categories = await GetMenuCategories(restaurantId);
		res.json(categories);
	} catch (error) {
		logger.error({ err: error }, "get_menu_categories_failed");
		res.status(500).json({ error: "Unable to fetch menu categories" });
	}
});

app.post("/menu", validateAction("88a87943-8f0b-43e2-b85e-192fdc901ed2"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = (req.body ?? {}) as Record<string, unknown>;
	if (typeof body.name !== "string" || typeof body.category !== "string") {
		res.status(400).json({ error: "name and category are required" });
		return;
	}
	// Same rule PATCH /menu/:id/price enforces: a menu price must be a positive
	// finite number. This route always WRITES price (UpsertMenuItem has no
	// "preserve" path for it), so an omitted / zero / negative / non-numeric price
	// silently stored a ₹0 dish — free food that also poisons the order-path
	// re-pricing floor. Rejecting the write leaves the existing row untouched.
	const price = Number(body.price ?? NaN);
	if (!Number.isFinite(price) || price <= 0) {
		res.status(400).json({ error: "price must be a positive number" });
		return;
	}

	try {
		// Snapshot the item BEFORE the upsert so an availability-only toggle can be
		// recorded as undoable (see UNDO_REGISTRY.menu_availability).
		const priorItem = typeof body.id === "string" && body.id
			? await GetMenuItemUndoState(restaurantId, body.id).catch(() => null)
			: null;
		// Fields absent from the request stay `undefined` so UpsertMenuItem
		// preserves the stored value (partial saves must not wipe recipes etc.).
		const result = await UpsertMenuItem(restaurantId, {
			id: typeof body.id === "string" ? body.id : "",
			name: body.name,
			price,
			category: body.category,
			image_url: typeof body.image_url === "string" ? body.image_url : body.image_url === null ? null : undefined,
			available: typeof body.available === "boolean" ? body.available : undefined,
			modifiers: Array.isArray(body.modifiers) ? (body.modifiers as MenuModifierGroup[]) : undefined,
			recipe: Array.isArray(body.recipe) ? (body.recipe as RecipeItem[]) : undefined,
			station: typeof body.station === "string" ? body.station : body.station === null ? null : undefined,
			allergens: Array.isArray(body.allergens) ? (body.allergens as string[]) : undefined,
			// Guest-facing dish description (sanitized in encodeMenuDescription).
			// Absent = keep the stored text; "" / null = clear it.
			blurb: typeof body.blurb === "string" ? body.blurb : body.blurb === null ? null : undefined,
		});
		try {
			// Only an availability-ONLY change is undoable: this route is a general
			// upsert, and reversing just the flag after a broader edit would leave a
			// half-restored item. Anything else records no undo envelope (default deny).
			const nextItem = typeof body.available === "boolean" && priorItem
				? await GetMenuItemUndoState(restaurantId, result.id).catch(() => null)
				: null;
			const availabilityOnly = Boolean(
				priorItem && nextItem
				&& priorItem.available !== nextItem.available
				&& priorItem.name === nextItem.name
				&& priorItem.price === nextItem.price,
			);
			await log_audit(req, "88a87943-8f0b-43e2-b85e-192fdc901ed2", `Saved menu item ${body.name}`, Audit_log_category.Menu, {
				id: result.id,
				available: body.available,
				...(availabilityOnly
					? { undo: { kind: "menu_availability", target_id: result.id, before: { available: priorItem!.available }, after: { available: nextItem!.available } } }
					: {}),
			});
		} catch (err) { logger.warn({ err }, "log_audit menu-upsert failed"); }
		res.status(201).json(result);
	} catch (error) {
		logger.error({ err: error }, "upsert_menu_item_failed");
		res.status(500).json({ error: "Unable to save menu item" });
	}
});

app.post("/menu/upload-image", validateAction("88a87943-8f0b-43e2-b85e-192fdc901ed2"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const b64 = typeof body.image_base64 === "string" ? body.image_base64 : "";
	const ct = typeof body.content_type === "string" ? body.content_type : "image/jpeg";
	if (!b64) { res.status(400).json({ error: "image_base64 is required" }); return; }
	try {
		const url = await uploadMenuImage(b64, ct);
		if (!url) { res.status(502).json({ error: "Image upload failed (storage not configured)" }); return; }
		res.json({ image_url: url });
	} catch (err: any) {
		logger.error({ err }, "menu_upload_image_failed");
		res.status(500).json({ error: "Unable to upload image" });
	}
});

// Set the restaurant's customer-facing branding (logo + theme color). Accepts a
// logo as a hosted URL or base64 (uploaded server-side).
// Settings/branding keys that must NEVER be copied into an audit entry's
// before-state — credentials would then sit in plain text in the log.
const UNDO_SECRET_SETTING_KEYS = new Set(["razorpay_key_secret", "msg_key_secret", "msg_webhook_secret"]);

// Diff two settings snapshots into an undo envelope covering ONLY the keys that
// actually changed. Returns null when nothing reversible changed.
function buildSettingsUndo(priorIn: unknown, nextIn: unknown): Record<string, unknown> | null {
	// Accept any settings-shaped object (interfaces lack an index signature, so we
	// widen at the boundary and treat the payloads as key bags for the diff).
	const prior = priorIn as Record<string, unknown> | null;
	const next = (nextIn ?? {}) as Record<string, unknown>;
	if (!prior) {return null;}
	const before: Record<string, unknown> = {};
	const after: Record<string, unknown> = {};
	for (const key of Object.keys(next)) {
		if (UNDO_SECRET_SETTING_KEYS.has(key)) {continue;}
		if (JSON.stringify(prior[key] ?? null) === JSON.stringify(next[key] ?? null)) {continue;}
		before[key] = prior[key] ?? null;
		after[key] = next[key] ?? null;
	}
	if (Object.keys(after).length === 0) {return null;}
	return { kind: "restaurant_settings", target_id: null, before, after };
}

// Diff two branding snapshots. Top-level fields keep their own names; every
// other key comes from brand_config and is restored back into it.
function buildBrandingUndo(
	priorIn: unknown,
	nextIn: unknown,
): Record<string, unknown> | null {
	// Callers pass richer branding snapshots (GetPublicBranding / SetBranding
	// results whose brand_config is a typed interface); widen at the boundary.
	type BrandingSnap = { logo_url: string | null; theme_color: string | null; queue_show_menu: boolean; brand_config: Record<string, unknown> };
	const prior = priorIn as BrandingSnap | null;
	const next = nextIn as BrandingSnap;
	if (!prior) {return null;}
	const before: Record<string, unknown> = {};
	const after: Record<string, unknown> = {};
	const put = (key: string, a: unknown, b: unknown) => {
		if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) {return;}
		before[key] = a ?? null;
		after[key] = b ?? null;
	};
	put("logo_url", prior.logo_url, next.logo_url);
	put("theme_color", prior.theme_color, next.theme_color);
	put("queue_show_menu", prior.queue_show_menu, next.queue_show_menu);
	for (const key of Object.keys(next.brand_config ?? {})) {
		put(key, (prior.brand_config ?? {})[key], (next.brand_config ?? {})[key]);
	}
	if (Object.keys(after).length === 0) {return null;}
	return { kind: "branding", target_id: null, before, after };
}

app.post("/restaurant/branding", validate, async (req: Request, res: Response) => {
	if (!(await enforcePermission(req, res, PERM_BRANDING))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	let logoUrl: string | undefined = typeof body.logo_url === "string" ? body.logo_url.trim() : undefined;
	const themeColor = typeof body.theme_color === "string" && /^#[0-9a-fA-F]{6}$/.test(body.theme_color)
		? body.theme_color
		: undefined;
	const queueShowMenu = typeof body.queue_show_menu === "boolean" ? body.queue_show_menu : undefined;
	// Customer-page customization object. Live keys: color_primary, font,
	// header_style, button_shape, surface_style (legacy colour keys are still
	// accepted and stored, but drive nothing — see BRAND_LIVE_FIELDS).
	// Passed through as-is — SetBranding sanitizes it (invalid keys dropped) and
	// merges it onto the stored config (keys omitted here keep their value).
	const brandConfig = body.brand_config && typeof body.brand_config === "object" ? body.brand_config : undefined;
	try {
		if (!logoUrl && typeof body.logo_base64 === "string" && body.logo_base64.length > 0) {
			const url = await uploadMenuImage(body.logo_base64, typeof body.content_type === "string" ? body.content_type : "image/png");
			if (url) {logoUrl = url;}
		}
		// Snapshot before the write so the undo restores only the branding fields
		// this request changed (SetBranding merges brand_config key-by-key).
		const priorBranding = await GetPublicBranding(restaurantId).catch(() => null);
		const result = await SetBranding(restaurantId, { logo_url: logoUrl ?? null, theme_color: themeColor ?? null, queue_show_menu: queueShowMenu, brand_config: brandConfig });
		const brandingUndo = buildBrandingUndo(priorBranding, result);
		try {
			await log_audit(req, "60d14e9c-45cc-4dc2-b017-56058cc3ae33", `Updated customer-page branding`, Audit_log_category.General, {
				theme_color: result.theme_color,
				logo: !!result.logo_url,
				...(brandingUndo ? { undo: brandingUndo } : {}),
			});
		} catch (err) { logger.warn({ err }, "log_audit branding failed"); }
		res.json(result);
	} catch (err: any) {
		logger.error({ err }, "set_branding_failed");
		res.status(500).json({ error: "Unable to save branding" });
	}
});

// Settings fields that are CREDENTIALS or fraud-detection thresholds. The rest
// of the document is operational (currency, taxes, service charge, printing,
// kitchen sections, timezone…) and every POS/KDS screen reads it, so the GET
// stays open to any authenticated user — but these keys are stripped for anyone
// without PERM_SETTINGS. msg_webhook_secret in particular is the HMAC key that
// authenticates the PUBLIC /webhooks/whatsapp/:slug endpoint.
const SETTINGS_PRIVILEGED_FIELDS = [
	"msg_provider",
	"msg_sender",
	"msg_key_id",
	"msg_secret_configured",
	"msg_webhook_secret",
	"msg_reminder_hours",
	"razorpay_key_id",
	"razorpay_configured",
	"discount_approval_threshold",
	"alert_discount_pct",
	"alert_void_count",
] as const;

function redactRestaurantSettings(settings: Awaited<ReturnType<typeof GetRestaurantSettings>>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...settings };
	for (const key of SETTINGS_PRIVILEGED_FIELDS) {
		delete out[key];
	}
	return out;
}

// Restaurant operational settings (e.g. push orders straight to kitchen vs. require approval).
app.get("/restaurant/settings", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const settings = await GetRestaurantSettings(restaurantId);
		// Same gate as the POST: the full document is admin-only. Non-holders get
		// the operational subset with the credentials/thresholds removed.
		res.json(callerHasPermission(req, PERM_SETTINGS) ? settings : redactRestaurantSettings(settings));
	}
	catch (err) { logger.error({ err }, "get_settings_failed"); res.status(500).json({ error: "Unable to load settings" }); }
});

app.post("/restaurant/settings", validate, async (req: Request, res: Response) => {
	// Settings hold payment keys, taxes and operational toggles — admin-only.
	if (!(await enforcePermission(req, res, PERM_SETTINGS))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	try {
		// Snapshot before the write so the undo can restore ONLY the keys this
		// request actually changed (never the whole settings document).
		const priorSettings = await GetRestaurantSettings(restaurantId).catch(() => null);
		const result = await SetRestaurantSettings(restaurantId, {
			auto_push_orders: typeof body.auto_push_orders === "boolean" ? body.auto_push_orders : undefined,
			currency: typeof body.currency === "string" ? body.currency : undefined,
			payment_methods: Array.isArray(body.payment_methods) ? body.payment_methods : undefined,
			taxes: Array.isArray(body.taxes) ? body.taxes : undefined,
			razorpay_key_id: typeof body.razorpay_key_id === "string" ? body.razorpay_key_id : undefined,
			razorpay_key_secret: typeof body.razorpay_key_secret === "string" ? body.razorpay_key_secret : undefined,
			service_charge: typeof body.service_charge === "number" ? body.service_charge : undefined,
			discount_approval_threshold: typeof body.discount_approval_threshold === "number" ? body.discount_approval_threshold : undefined,
			bill_reopen_window_min: typeof body.bill_reopen_window_min === "number" ? body.bill_reopen_window_min : undefined,
			alert_discount_pct: typeof body.alert_discount_pct === "number" ? body.alert_discount_pct : undefined,
			alert_void_count: typeof body.alert_void_count === "number" ? body.alert_void_count : undefined,
			loyalty_earn_per_100: typeof body.loyalty_earn_per_100 === "number" ? body.loyalty_earn_per_100 : undefined,
			loyalty_point_value: typeof body.loyalty_point_value === "number" ? body.loyalty_point_value : undefined,
			booking_deposit_amount: typeof body.booking_deposit_amount === "number" ? body.booking_deposit_amount : undefined,
			booking_deposit_min_party: typeof body.booking_deposit_min_party === "number" ? body.booking_deposit_min_party : undefined,
			booking_cancel_window_hours: typeof body.booking_cancel_window_hours === "number" ? body.booking_cancel_window_hours : undefined,
			booking_min_spend: typeof body.booking_min_spend === "number" ? body.booking_min_spend : undefined,
			msg_provider: typeof body.msg_provider === "string" ? body.msg_provider : undefined,
			msg_sender: typeof body.msg_sender === "string" ? body.msg_sender : undefined,
			msg_key_id: typeof body.msg_key_id === "string" ? body.msg_key_id : undefined,
			msg_key_secret: typeof body.msg_key_secret === "string" ? body.msg_key_secret : undefined,
			msg_reminder_hours: typeof body.msg_reminder_hours === "number" ? body.msg_reminder_hours : undefined,
			feedback_config: body.feedback_config !== undefined ? body.feedback_config : undefined,
			bill_logo_svg: body.bill_logo_svg !== undefined ? body.bill_logo_svg : undefined,
			bill_paper_width: body.bill_paper_width !== undefined ? body.bill_paper_width : undefined,
			kitchen_sections: Array.isArray(body.kitchen_sections) ? body.kitchen_sections : undefined,
			inventory_categories: Array.isArray(body.inventory_categories) ? body.inventory_categories : undefined,
			timezone: typeof body.timezone === "string" ? body.timezone : undefined,
			require_table_otp: typeof body.require_table_otp === "boolean" ? body.require_table_otp : undefined,
		});
		const settingsUndo = buildSettingsUndo(priorSettings, result);
		try {
			await log_audit(req, "60d14e9c-45cc-4dc2-b017-56058cc3ae33", `Updated restaurant settings`, Audit_log_category.General, {
				auto_push_orders: result.auto_push_orders,
				currency: result.currency,
				...(settingsUndo ? { undo: settingsUndo } : {}),
			});
		} catch (err) { logger.warn({ err }, "log_audit settings failed"); }
		res.json(result);
	} catch (err) {
		logger.error({ err }, "set_settings_failed");
		res.status(500).json({ error: "Unable to save settings" });
	}
});

// --- Guest messaging: delivery visibility + manual reminder trigger ---------
// Last 50 outbound messages (confirmations, reminders, WhatsApp replies) with
// their sent/failed/skipped status — surfaced on the web bookings page so the
// owner can see whether guests are actually receiving messages.
app.get("/messages", validate, async (req: Request, res: Response) => {
	if (!(await enforcePermission(req, res, PERM_MESSAGING))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { res.json(await GetOutboundMessages(restaurantId, clampLimit(req.query.limit, 50, 200))); }
	catch (err) { logger.error({ err }, "get_messages_failed"); res.status(500).json({ error: "Unable to load messages" }); }
});

// Run the booking-reminder pass for this tenant now (the same function the
// 30-min timer calls) — lets an admin nudge reminders without waiting a tick.
app.post("/messages/run-reminders", validate, async (req: Request, res: Response) => {
	if (!(await enforcePermission(req, res, PERM_MESSAGING))) {return;}
	const resId = req.auth?.res_id;
	if (!resId) { res.status(400).json({ error: "Missing restaurant context" }); return; }
	try { res.json({ success: true, sent: await sendDueBookingReminders(resId) }); }
	catch (err) { logger.error({ err }, "run_reminders_failed"); res.status(500).json({ error: "Unable to run reminders" }); }
});

// --- Staff notifications (bell) --------------------------------------------
app.get("/notifications", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		res.json(await GetNotifications(restaurantId));
	} catch (err) {
		logger.error({ err }, "get_notifications_failed");
		res.status(500).json({ error: "Unable to load notifications" });
	}
});

// Where a tapped notification should go, and whether the record is actually
// reachable from here. Registered BEFORE /notifications/:id/read so the more
// specific path is unambiguous.
//
// Returns 404 only when the NOTIFICATION itself is gone. A notification whose
// target record was deleted / lives on another outlet / has aged out of the live
// orders list still returns 200 with still_exists / visible_here / reason_gone /
// message so the client can say what happened instead of opening a blank screen.
app.get("/notifications/:id/target", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const target = await ResolveNotificationTarget(restaurantId, String(req.params.id));
		if (!target) { res.status(404).json({ error: "Notification not found" }); return; }
		res.json(target);
	} catch (err) {
		logger.error({ err }, "notif_target_failed");
		res.status(500).json({ error: "Unable to resolve notification target" });
	}
});

app.post("/notifications/read-all", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { await MarkAllNotificationsRead(restaurantId); res.json({ success: true }); }
	catch (err) { logger.error({ err }, "notif_read_all_failed"); res.status(500).json({ error: "Unable to update" }); }
});

app.post("/notifications/:id/read", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { await MarkNotificationRead(restaurantId, String(req.params.id)); res.json({ success: true }); }
	catch (err) { logger.error({ err }, "notif_read_failed"); res.status(500).json({ error: "Unable to update" }); }
});

app.delete("/notifications/:id", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { await DeleteNotification(restaurantId, String(req.params.id)); res.json({ success: true }); }
	catch (err) { logger.error({ err }, "notif_delete_failed"); res.status(500).json({ error: "Unable to delete" }); }
});

app.delete("/notifications", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { await ClearNotifications(restaurantId); res.json({ success: true }); }
	catch (err) { logger.error({ err }, "notif_clear_failed"); res.status(500).json({ error: "Unable to clear" }); }
});

// Public read of branding (used by the reservation page).
app.get("/qr/:slug/branding", async (req: Request, res: Response) => {
	const slug = String(req.params.slug ?? "").trim();
	let resId: string | null = null;
	try { resId = await getRestaurantIdFromUsername(slug); } catch { resId = null; }
	if (!resId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	try {
		const result = await withTenant(
			{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
			async () => {
				const [profile, branding] = await Promise.all([
					GetRestaurantProfile(slug),
					GetPublicBranding(slug).catch(() => ({ logo_url: null, theme_color: null, theme_primary: null, theme_secondary: null, currency: "₹", payment_methods: [], queue_show_menu: true, timezone: "Asia/Kolkata", require_table_otp: false, brand_config: { font: "Inter", header_style: "gradient", button_shape: "rounded", surface_style: "frosted" } })),
				]);
				return { restaurant_name: profile?.restaurant_name ?? slug, ...branding };
			},
		);
		res.json(result);
	} catch (err) {
		logger.error({ err }, "qr_branding_failed");
		res.status(500).json({ error: "Unable to load branding" });
	}
});

app.put("/menu", validateAction(PERM_MENU_BULK_REPLACE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const items = Array.isArray(req.body?.items) ? req.body.items : null;
	if (!items) {
		res.status(400).json({ error: "items array is required" });
		return;
	}

	try {
		// Fields absent from the request stay `undefined` so UpsertMenuItem
		// preserves the stored value (bulk reorders must not wipe recipes etc.).
		// A full-menu save prunes anything missing from the payload — the exact
		// mechanism that once destroyed 56 items' images/recipes. SaveMenuItems now
		// refuses to prune more than a couple of items unless the caller explicitly
		// opts in here, so a stale or partially-loaded list can no longer wipe the menu.
		const allowBulkDelete = req.body?.allow_bulk_delete === true;
		await SaveMenuItems(
			restaurantId,
			items.map((item: any) => ({
				id: String(item.id ?? ""),
				name: String(item.name ?? ""),
				price: Number(item.price ?? 0),
				category: String(item.category ?? "General"),
				image_url: typeof item.image_url === "string" ? item.image_url : item.image_url === null ? null : undefined,
				available: typeof item.available === "boolean" ? item.available : undefined,
				modifiers: Array.isArray(item.modifiers) ? item.modifiers : undefined,
				recipe: Array.isArray(item.recipe) ? item.recipe : undefined,
				station: typeof item.station === "string" ? item.station : item.station === null ? null : undefined,
				allergens: Array.isArray(item.allergens) ? item.allergens : undefined,
				// Guest-facing dish description — absent keeps the stored text, so a
				// bulk save from a client that doesn't know the field can't wipe it.
				blurb: typeof item.blurb === "string" ? item.blurb : item.blurb === null ? null : undefined,
			})),
			{ allowBulkDelete },
		);
		try {
			await log_audit(req, "ed800655-b937-44ba-a7ca-7458295886c9", `Saved menu (${items.length} items)`, Audit_log_category.Menu, { count: items.length });
		} catch (err) { logger.warn({ err }, "log_audit menu-save failed"); }
		res.json({ success: true });
	} catch (error) {
		logger.error({ err: error }, "save_menu_failed");
		// The bulk-delete guard is a deliberate refusal, not a server fault.
		if (error instanceof MenuBulkDeleteError) {
			res.status(409).json({
				error: error.message,
				stored: error.stored,
				kept: error.kept,
				would_delete: error.wouldDelete,
			});
			return;
		}
		res.status(500).json({ error: "Unable to save menu" });
	}
});

// Update ONLY a menu item's price (the menu-insights "apply suggestion" flow).
// Same Edit Menu gate as PUT /menu, but never touches any other field of the
// item — clients applying a price suggestion MUST use this, not PUT /menu.
app.patch("/menu/:id/price", validateAction("ed800655-b937-44ba-a7ca-7458295886c9"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}
	const itemId = typeof req.params.id === "string" ? req.params.id.trim() : "";
	const price = Number((req.body ?? {}).price ?? NaN);
	if (!itemId) {
		res.status(400).json({ error: "Missing menu item id" });
		return;
	}
	if (!Number.isFinite(price) || price <= 0) {
		res.status(400).json({ error: "price must be a positive number" });
		return;
	}
	try {
		const result = await UpdateMenuItemPrice(restaurantId, itemId, price);
		try {
			// `undo` carries the prior price triple so the audit entry is reversible
			// (see UNDO_REGISTRY.menu_price). The human `reason` is unchanged.
			await log_audit(req, "ed800655-b937-44ba-a7ca-7458295886c9", `Updated price of ${result.name} to ${result.price}`, Audit_log_category.Menu, {
				id: result.id,
				price: result.price,
				undo: { kind: "menu_price", target_id: result.id, before: result.previous, after: { price: result.price } },
			});
		} catch (err) { logger.warn({ err }, "log_audit menu-price failed"); }
		res.json({ success: true, ...result });
	} catch (error: any) {
		logger.error({ err: error }, "update_menu_price_failed");
		const msg = String(error?.message ?? "Unable to update price");
		res.status(/not found/i.test(msg) ? 404 : 400).json({ error: msg });
	}
});

app.post("/menu/categories", validateAction("88a87943-8f0b-43e2-b85e-192fdc901ed2"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const category = typeof req.body?.category === "string" ? req.body.category.trim() : "";
	if (!category) {
		res.status(400).json({ error: "category is required" });
		return;
	}

	try {
		await EnsureMenuCategory(restaurantId, category);
		try { await log_audit(req, "88a87943-8f0b-43e2-b85e-192fdc901ed2", `Added menu category ${category}`, Audit_log_category.Menu, { category }); } catch (err) { logger.warn({ err }, "log_audit add-category failed"); }
		res.status(201).json({ success: true });
	} catch (error) {
		logger.error({ err: error }, "ensure_menu_category_failed");
		res.status(500).json({ error: "Unable to save category" });
	}
});

app.delete("/menu/categories", validateAction(PERM_MENU_CAT_DELETE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const categoryRaw = typeof req.query?.category === "string"
		? req.query.category
		: typeof req.body?.category === "string"
			? req.body.category
			: "";
	const category = categoryRaw.trim();
	if (!category) {
		res.status(400).json({ error: "category is required" });
		return;
	}

	try {
		const result = await DeleteMenuCategory(restaurantId, category);
		try { await log_audit(req, "ed800655-b937-44ba-a7ca-7458295886c9", `Deleted menu category ${category}`, Audit_log_category.Menu, { category, deletedItems: result.deletedItems }); } catch (err) { logger.warn({ err }, "log_audit delete-category failed"); }
		res.json({ success: true, deletedItems: result.deletedItems });
	} catch (error) {
		logger.error({ err: error }, "delete_menu_category_failed");
		res.status(500).json({ error: "Unable to delete category" });
	}
});

// Rename a kitchen section: updates the managed list in Restaurant settings AND
// cascades to every menu item whose station matched the old name (one
// transaction over the items), so tickets/KDS immediately reflect the new name.
app.post("/kitchen-sections/rename", validateAction("ed800655-b937-44ba-a7ca-7458295886c9"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const from = typeof req.body?.from === "string" ? req.body.from.trim() : "";
	const to = typeof req.body?.to === "string" ? req.body.to.trim().replace(/\s+/g, " ").slice(0, 32) : "";
	if (!from || !to) { res.status(400).json({ error: "from and to are required" }); return; }
	try {
		// Cascade to menu items first (transactional), then swap the managed entry.
		const { updated } = await RenameMenuStation(restaurantId, from, to);
		const current = await GetRestaurantSettings(restaurantId);
		const had = current.kitchen_sections.some((s) => s.toLowerCase() === from.toLowerCase());
		const nextSections = had
			? current.kitchen_sections.map((s) => (s.toLowerCase() === from.toLowerCase() ? to : s))
			: [...current.kitchen_sections, to]; // renaming an unmanaged station adopts it
		const saved = await SetRestaurantSettings(restaurantId, { kitchen_sections: nextSections });
		try {
			await log_audit(req, "ed800655-b937-44ba-a7ca-7458295886c9", `Renamed kitchen section ${from} -> ${to} (${updated} items)`, Audit_log_category.Menu, {
				from, to, updated_items: updated,
				undo: { kind: "kitchen_section_rename", target_id: null, before: { name: from }, after: { name: to } },
			});
		} catch (err) { logger.warn({ err }, "log_audit kitchen-section-rename failed"); }
		res.json({ success: true, updated_items: updated, kitchen_sections: saved.kitchen_sections });
	} catch (error) {
		logger.error({ err: error }, "rename_kitchen_section_failed");
		res.status(500).json({ error: "Unable to rename kitchen section" });
	}
});

// Rename an inventory category: updates the managed list in Restaurant settings
// AND cascades to every inventory item whose category matched the old name (one
// transaction over the items). Mirrors /kitchen-sections/rename.
app.post("/inventory-categories/rename", validateAction(INV_MANAGE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const from = typeof req.body?.from === "string" ? req.body.from.trim() : "";
	const to = typeof req.body?.to === "string" ? req.body.to.trim().replace(/\s+/g, " ").slice(0, 40) : "";
	if (!from || !to) { res.status(400).json({ error: "from and to are required" }); return; }
	try {
		// Cascade to inventory items first (transactional), then swap the managed entry.
		const { updated } = await RenameInventoryCategory(restaurantId, from, to);
		const current = await GetRestaurantSettings(restaurantId);
		const had = current.inventory_categories.some((c) => c.toLowerCase() === from.toLowerCase());
		const nextCategories = had
			? current.inventory_categories.map((c) => (c.toLowerCase() === from.toLowerCase() ? to : c))
			: [...current.inventory_categories, to]; // renaming an unmanaged category adopts it
		const saved = await SetRestaurantSettings(restaurantId, { inventory_categories: nextCategories });
		try {
			await log_audit(req, INV_MANAGE, `Renamed inventory category ${from} -> ${to} (${updated} items)`, Audit_log_category.Inventory, {
				from, to, updated_items: updated,
				undo: { kind: "inventory_category_rename", target_id: null, before: { name: from }, after: { name: to } },
			});
		} catch (err) { logger.warn({ err }, "log_audit inventory-category-rename failed"); }
		res.json({ success: true, updated_items: updated, inventory_categories: saved.inventory_categories });
	} catch (error) {
		logger.error({ err: error }, "rename_inventory_category_failed");
		res.status(500).json({ error: "Unable to rename inventory category" });
	}
});

app.get("/orders", validateAction("b7f78d0f-323d-4622-8d05-aa2f82d54b2e"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	try {
		// Optional per-zone filter: a locked kitchen display can fetch only its own
		// section server-side. Empty/absent => no filter (full set, as before).
		const station = typeof req.query.station === "string" ? req.query.station : "";
		const items = await GetOrders(restaurantId, station);
		res.json(items);
	} catch (error) {
		logger.error({ err: error }, "get_orders_failed");
		res.status(500).json({ error: "Unable to fetch orders" });
	}
});

// Why the orders grid looks the way it does — the context a client needs to
// EXPLAIN an empty list instead of rendering a blank screen.
//
// GET /orders stays scoped to the caller's outlet (a branch view must never leak
// another branch's orders), and guest/QR orders always land on the TABLE's
// outlet — so a staffer signed into a branch with no tables correctly sees zero
// orders. This endpoint hands the UI the numbers to say so out loud:
// "No orders in Branch 2 — 11 are in Main Outlet. Switch outlet?".
//
// Kept as a COMPANION endpoint rather than reshaping GET /orders, whose response
// is a bare array that both clients already consume.
//
// `X-Outlet-Id: all` (admin/manager) works here exactly as it does on GET
// /orders: the counts span every outlet, is_all_outlets is true, and
// other_outlet_orders is 0 because nothing is hidden in that mode.
app.get("/orders/scope", validateAction("b7f78d0f-323d-4622-8d05-aa2f82d54b2e"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}
	try {
		res.json(await GetOrdersScope(restaurantId));
	} catch (error) {
		logger.error({ err: error }, "get_orders_scope_failed");
		res.status(500).json({ error: "Unable to fetch order scope" });
	}
});

app.post("/orders", validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const orderBody = (req.body ?? {}) as Record<string, unknown>;
	// Phone is optional on a dine-in order; a typed one must be a full 10-digit
	// mobile before it becomes a CRM identity.
	const orderPhone = optionalMobile10(res, orderBody.customer_phone);
	if (!orderPhone.ok) {return;}

	try {
		const body: Record<string, unknown> = { ...orderBody, ...(orderPhone.value ? { customer_phone: orderPhone.value } : {}) };
		const result = await AddOrder(restaurantId, body);
		// Best-effort guest registration: orders that carry a phone create/match a
		// Customers row and get cust_id stamped (CRM visit tracking).
		await linkOrderToCustomer(restaurantId, result.id, body.customer, orderPhone.value);
		// A staff-typed dine-in order is a new kitchen ticket exactly like a QR
		// one, so it raises the same notification and the same realtime event.
		const created: CreatedOrderInfo = {
			orderId: result.id,
			table: typeof body.table === "string" ? body.table : null,
			items: body.items,
			total: body.total ?? body.subtotal,
			status: body.status ?? "Preparing",
			orderType: body.order_type,
		};
		await notifyOrderCreated(restaurantId, created);
		// Placing an order was the only order operation with no audit trail.
		try {
			await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca",
				`New order ${created.orderId}${created.table ? ` on table ${created.table}` : ""}`,
				Audit_log_category.Orders, { order_id: created.orderId, table: created.table ?? null });
		} catch (err) { logger.warn({ err }, "log_audit order-create failed"); }
		emitOrderCreated(restaurantId, created);
		res.status(201).json(result);
	} catch (error: any) {
		logger.error({ err: error }, "add_order_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to add order") });
	}
});

// Place a takeaway / delivery order (no physical table — a hidden virtual table
// is provisioned to carry the bill).
app.post("/orders/takeaway", validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const orderType = String(body.order_type ?? "takeaway").toLowerCase() === "delivery" ? "delivery" : "takeaway";
	if (!Array.isArray(body.items) || body.items.length === 0) { res.status(400).json({ error: "At least one item is required" }); return; }
	// A takeaway/delivery guest is reached on this number, so a typed one must be a
	// full 10-digit mobile (still optional for counter takeaways).
	const takeawayPhone = optionalMobile10(res, body.customer_phone);
	if (!takeawayPhone.ok) {return;}
	try {
		const result = await AddTakeawayOrder(restaurantId, {
			...(body as any),
			order_type: orderType,
			...(takeawayPhone.value ? { customer_phone: takeawayPhone.value } : {}),
		});
		// Takeaway/delivery orders usually carry the guest's phone — register them too.
		await linkOrderToCustomer(restaurantId, result.id, body.customer, takeawayPhone.value);
		try { await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `New ${orderType} order ${result.id}`, Audit_log_category.Orders, { order_id: result.id, order_type: orderType }); } catch {/* ignore */}
		// Same fan-out as dine-in, but the copy names the CHANNEL ("New takeaway
		// order") — the carried table is a hidden virtual row, not a real one.
		const createdTakeaway: CreatedOrderInfo = {
			orderId: result.id,
			table: result.table,
			items: body.items,
			total: body.total ?? body.subtotal,
			status: body.status ?? "Preparing",
			orderType: result.order_type ?? orderType,
		};
		await notifyOrderCreated(restaurantId, createdTakeaway);
		emitOrderCreated(restaurantId, createdTakeaway);
		res.status(201).json(result);
	} catch (error: any) {
		logger.error({ err: error }, "add_takeaway_order_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to add order") });
	}
});

// Advance a single order's stage (Preparing -> Served -> ...). Used by the
// orders list and the kitchen display.
app.patch("/orders/:id/status", validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const orderId = typeof req.params.id === "string" ? req.params.id.trim() : "";
	const status = typeof req.body?.status === "string" ? req.body.status.trim() : "";
	if (!orderId || !status) { res.status(400).json({ error: "orderId and status are required" }); return; }
	// Settling money is a different job from moving a ticket along. Everyday
	// transitions (Preparing → Served …) stay with "Add Orders" so waiters keep
	// working, but marking an order PAID additionally requires "Close Bill" —
	// previously any waiter could settle a bill.
	const settles = ["paid", "closed"].includes(status.toLowerCase());
	if (settles && !(await enforcePermission(req, res, PERM_CLOSE_BILL))) {return;}
	try {
		const result = await SetOrderStatus(restaurantId, orderId, status);
		if (!result.ok) { res.status(404).json({ error: "Order not found" }); return; }
		// Re-cancelling an order that is already Cancelled is an idempotent no-op:
		// nothing was written, so nothing is logged (and no second undo envelope
		// is recorded for the same cancellation).
		if (!result.changed) { res.json({ success: true, unchanged: true }); return; }
		// A transition INTO Cancelled is the one order-status change that is
		// undoable — record the before-state envelope the undo registry reads
		// (see UNDO_REGISTRY.order_cancel). Every other status change stays
		// deny-by-default: no envelope, no undo.
		const isCancel = status.trim().toLowerCase() === "cancelled" || status.trim().toLowerCase() === "canceled";
		const undoEnvelope = isCancel && result.previous_status
			? {
				undo: {
					kind: "order_cancel",
					target_id: orderId,
					before: { status: result.previous_status },
					after: { status: "Cancelled" },
				},
			}
			: {};
		try {
			await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Order ${orderId} -> ${status}`, Audit_log_category.Orders, { order_id: orderId, status, ...undoEnvelope });
		} catch (e) { logger.warn({ err: e }, "log_audit order status failed"); }
		res.json({ success: true });
	} catch (error: any) {
		logger.error({ err: error }, "set_order_status_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to update order status") });
	}
});

// Add single item to existing order (adds to Preparing section and logs audit)
app.post('/orders/:id/items', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: 'Missing restaurantId' }); return; }
	const orderId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
	if (!orderId) { res.status(400).json({ error: 'Missing order id' }); return; }
	const item = req.body ?? {};
	try {
		// fetch existing order
		const existing = await GetOrders(restaurantId);
		const order = existing.find(o => o.id === orderId);
		if (!order) { res.status(404).json({ error: 'Order not found' }); return; }

		// build items_split if missing; clone to avoid mutating source
		const rawSplit = Array.isArray((order as any).items_split)
			? JSON.parse(JSON.stringify((order as any).items_split)) as any[]
			// Same legacy-order guard as the delete path: seed from the order's real
			// items so adding one never discards the ones already on the ticket.
			: [["Served", []], ["Preparing", Array.isArray((order as any).items) ? JSON.parse(JSON.stringify((order as any).items)) : []]];
		// normalize tuples: ensure each tuple is [label, array] and dedupe items across tuples (preserve first occurrence)
		const seenIds = new Set<string>();
		const normalizedSplit: any[] = [];
		for (const tup of rawSplit) {
			const label = String(tup?.[0] ?? "").trim() || "";
			const arr = Array.isArray(tup?.[1]) ? tup[1] : [];
			const filtered: any[] = [];
			for (const it of arr) {
				const id = String((it?.id) ?? "");
				if (!id) {continue;}
				if (seenIds.has(id)) {continue;}
				seenIds.add(id);
				filtered.push(it);
			}
			normalizedSplit.push([label, filtered]);
		}

		// ensure we have a Preparing tuple to add the new item into
		const preparingIndex = normalizedSplit.findIndex((t: any) => String(t?.[0] ?? "").toLowerCase().includes('prepar'));
		const typedItem = { id: String(item.id ?? randomUUID()), name: String(item.name ?? 'Unknown'), quantity: Number(item.quantity ?? 1), price: Number(item.price ?? 0), orderedAt: String(item.orderedAt ?? new Date().toISOString()), note: item.note ?? null };
		// SECURITY: same server-side re-pricing the create path applies — an added
		// line that resolves to a menu row is floored at the menu price so it can't
		// be rung in at 1. UpdateOrderItemsSplit then re-derives the order subtotal
		// from these prices. A genuinely off-menu line is kept as typed.
		const [newItem] = await applyMenuPriceFloor(restaurantId, [typedItem]);
		if (preparingIndex === -1) {
			normalizedSplit.push(["Preparing", [newItem]]);
		} else {
			normalizedSplit[preparingIndex][1] = normalizedSplit[preparingIndex][1] || [];
			normalizedSplit[preparingIndex][1].push(newItem);
		}

		const split = normalizedSplit;

		await UpdateOrderItemsSplit(restaurantId, orderId, split);
		// Titled by the action's NAME in the audit log, so use the item-level action
		// ("Update Order - Add Food Item") rather than the generic "Add Orders".
		try { await log_audit(req, "d6bebeb5-111f-4371-b373-a99158116d71", `Added item ${newItem.id} to order ${orderId}`, Audit_log_category.Bill, { order_id: orderId, item: newItem }); } catch (err) { logger.warn({ err }, 'log_audit add-order-item failed'); }

		res.status(201).json({ success: true, item: newItem });
	} catch (err: any) {
		logger.error({ err }, 'add_order_item_failed');
		res.status(500).json({ error: String(err?.message ?? 'Unable to add item') });
	}
});

// Delete single item from order
app.delete('/orders/:id/items/:itemId', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: 'Missing restaurantId' }); return; }
	const orderId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
	const itemId = typeof req.params.itemId === 'string' ? req.params.itemId.trim() : '';
	if (!orderId || !itemId) { res.status(400).json({ error: 'Missing order id or item id' }); return; }
	try {
		const existing = await GetOrders(restaurantId);
		const order = existing.find(o => o.id === orderId);
		if (!order) { res.status(404).json({ error: 'Order not found' }); return; }

		// A legacy order (no items_split — 92 of 94 rows) must seed the skeleton
		// from its REAL items; starting from an empty one flattened the order to
		// zero items while leaving the bill total intact.
		const split = (order as any).items_split
			?? [["Served", []], ["Preparing", Array.isArray((order as any).items) ? (order as any).items : []]];
		// remove item from both sections
		for (const tuple of split) {
			if (Array.isArray(tuple[1])) {
				const before = (tuple[1]).length;
				tuple[1] = (tuple[1]).filter((it) => String(it.id) !== itemId);
				const after = (tuple[1] as any[]).length;
				if (after !== before) {break;}
			}
		}

		await UpdateOrderItemsSplit(restaurantId, orderId, split as any[]);
		try { await log_audit(req, "371ecf9f-303e-4114-92fb-3a5120d1565e", `Deleted item ${itemId} from order ${orderId}`, Audit_log_category.Bill, { order_id: orderId, deleted_item_id: itemId }); } catch (err) { logger.warn({ err }, 'log_audit delete-order-item failed'); }

		res.json({ success: true });
	} catch (err: any) {
		logger.error({ err }, 'delete_order_item_failed');
		res.status(500).json({ error: String(err?.message ?? 'Unable to delete item') });
	}
});

app.delete("/orders/:id", validateAction(PERM_ORDER_DELETE), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const orderId = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!orderId) {
		res.status(400).json({ error: "Invalid order id" });
		return;
	}

	try {
		const deleted = await DeleteOrder(restaurantId, orderId);
		if (!deleted) {
			res.status(404).json({ error: "Order not found" });
			return;
		}
		// Permanent deletion had no audit trail at all — the single most
		// destructive order operation was invisible after the fact.
		try {
			await log_audit(req, PERM_ORDER_DELETE, `Deleted order ${orderId}`,
				Audit_log_category.Orders, { order_id: orderId });
		} catch (err) { logger.warn({ err }, "log_audit order-delete failed"); }
		res.status(204).send();
	} catch (error: any) {
		logger.error({ err: error }, "delete_order_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to delete order") });
	}
});

app.get("/orders/apc", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const periodRaw = typeof req.query.period === "string" ? req.query.period.trim().toLowerCase() : "";
	const period = (periodRaw === "day" || periodRaw === "week" || periodRaw === "month"
		? periodRaw
		: "month");

	const monthRaw = typeof req.query.month === "string" ? req.query.month.trim() : "";
	let monthStart: Date | undefined;
	if (monthRaw) {
		const parsed = new Date(`${monthRaw}-01T00:00:00.000Z`);
		if (Number.isNaN(parsed.getTime())) {
			res.status(400).json({ error: "Invalid month. Use YYYY-MM." });
			return;
		}
		monthStart = parsed;
	}

	// Restaurant-wide APC by default. Only scope to a single employee when one is
	// explicitly requested via ?employeeId= (do NOT implicitly fall back to the
	// logged-in employee, or the Overview shows only the viewer's own orders).
	const employeeQuery = typeof req.query.employeeId === "string" ? req.query.employeeId.trim() : "";
	const employeeId = employeeQuery || undefined;

	try {
		const insight = await GetMonthlyApcInsights(restaurantId, {
			period,
			periodStart: monthStart,
			employeeId,
		});
		res.json(insight);
	} catch (error) {
		logger.error({ err: error }, "get_orders_apc_failed");
		res.status(500).json({ error: "Unable to fetch APC insights" });
	}
});

// Historical month-by-month trend of revenue / covers / APC for the analytics page.
app.get("/orders/apc-trends", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const months = Math.max(1, Math.min(Number(req.query.months) || 12, 24));
	try {
		const data = await GetApcTrends(restaurantId, { months });
		res.json(data);
	} catch (error) {
		logger.error({ err: error }, "get_apc_trends_failed");
		res.status(500).json({ error: "Unable to fetch APC trends" });
	}
});

// Advanced analytics (KPI dashboard): discounts, staff feedback, processing time,
// suppliers, low stock, seasonal — each with a colour-band KPI status.
app.get("/analytics/advanced", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const days = Math.max(7, Math.min(Number(req.query.days) || 90, 365));
	// Piggy-back the exception-alert scan on the KPI dashboard load (cheap, and
	// the 24h alert_key dedupe makes repeat calls no-ops). Best-effort: an alert
	// failure must never fail the analytics payload. Awaited (not detached) so it
	// runs while the request's tenant connection is still alive.
	try { await RunExceptionChecks(restaurantId); } catch (err) { logger.warn({ err }, "exception_checks_failed"); }
	try {
		const data = await GetAdvancedAnalytics(restaurantId, { days });
		res.json(data);
	} catch (error) {
		logger.error({ err: error }, "get_advanced_analytics_failed");
		res.status(500).json({ error: "Unable to fetch advanced analytics" });
	}
});

// Multi-outlet comparison: per-outlet revenue/bills/orders/rating for the window.
// Meaningful when the restaurant has 2+ outlets; single-outlet tenants get a
// one-row list (the web card hides itself in that case).
app.get("/analytics/outlets", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const days = Math.max(1, Math.min(Number(req.query.days) || 30, 365));
	try {
		res.json(await GetOutletsComparison(restaurantId, days));
	} catch (error) {
		logger.error({ err: error }, "get_outlets_comparison_failed");
		res.status(500).json({ error: "Unable to fetch outlet comparison" });
	}
});

// Long-range month-by-month history (up to 3 years) for the History tab.
app.get("/analytics/history", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const months = Math.max(3, Math.min(Number(req.query.months) || 36, 36));
	try {
		const data = await GetMonthlyHistory(restaurantId, { months });
		res.json(data);
	} catch (error) {
		logger.error({ err: error }, "get_monthly_history_failed");
		res.status(500).json({ error: "Unable to fetch history" });
	}
});

// Marketing campaigns (admin): create/delete; ROI is computed by /analytics/advanced.
app.post("/campaigns", async (req: Request, res: Response) => {
	const auth = await enforcePermission(req, res, PERM_CAMPAIGNS);
	if (!auth) {return;}
	const b = (req.body ?? {}) as Record<string, unknown>;
	try {
		const campaign = await CreateCampaign(auth.restaurantId, {
			name: typeof b.name === "string" ? b.name : "",
			cost: Number(b.cost ?? 0) || 0,
			starts_at: typeof b.starts_at === "string" ? b.starts_at : "",
			ends_at: typeof b.ends_at === "string" ? b.ends_at : "",
			notes: typeof b.notes === "string" ? b.notes : undefined,
		});
		try { await log_audit(req, "df75119b-e5f1-4f38-aba5-78a1cf182f56", `Created campaign ${campaign.name}`, Audit_log_category.General, { id: campaign.id }); } catch {/* ignore */}
		res.status(201).json(campaign);
	} catch (e: any) { res.status(400).json({ error: String(e?.message ?? "Unable to create campaign") }); }
});

app.delete("/campaigns/:id", async (req: Request, res: Response) => {
	const auth = await enforcePermission(req, res, PERM_CAMPAIGNS);
	if (!auth) {return;}
	try {
		await DeleteCampaign(auth.restaurantId, String(req.params.id));
		try { await log_audit(req, "df75119b-e5f1-4f38-aba5-78a1cf182f56", `Deleted campaign ${req.params.id}`, Audit_log_category.General, { id: req.params.id }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (e: any) { res.status(400).json({ error: String(e?.message ?? "Unable to delete campaign") }); }
});

// --- Order/item preparation timers (pause/resume, mark item served) ---------
const ORDER_ACTION = "4ad474d4-5230-449c-874f-6a238b833bca";
async function handleTiming(req: Request, res: Response, action: "pause" | "resume" | "serve" | "start", withItem: boolean) {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const orderId = String(req.params.id ?? "").trim();
	const itemId = withItem ? String(req.params.itemId ?? "").trim() : undefined;
	if (!orderId || (withItem && !itemId)) { res.status(400).json({ error: "order id (and item id) required" }); return; }
	try {
		const ok = await OrderTimingAction(restaurantId, orderId, action, itemId);
		if (!ok) { res.status(404).json({ error: "Order not found" }); return; }
		try { await log_audit(req, ORDER_ACTION, `Timer ${action}${itemId ? ` item ${itemId}` : ""} on order ${orderId}`, Audit_log_category.Orders, { order_id: orderId, item_id: itemId, action }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (err: any) {
		logger.error({ err }, "order_timing_failed");
		res.status(400).json({ error: String(err?.message ?? "Unable to update timer") });
	}
}
app.post("/orders/:id/pause", validateAction(ORDER_ACTION), (req, res) => handleTiming(req, res, "pause", false));
app.post("/orders/:id/resume", validateAction(ORDER_ACTION), (req, res) => handleTiming(req, res, "resume", false));
app.post("/orders/:id/items/:itemId/serve", validateAction(ORDER_ACTION), (req, res) => handleTiming(req, res, "serve", true));
app.post("/orders/:id/items/:itemId/pause", validateAction(ORDER_ACTION), (req, res) => handleTiming(req, res, "pause", true));
app.post("/orders/:id/items/:itemId/resume", validateAction(ORDER_ACTION), (req, res) => handleTiming(req, res, "resume", true));

// Fire held course items (hold-and-fire): stamps fired_at, clears course_hold
// and starts their prep timers. Staff-level (same permission as other order ops).
app.post("/orders/:id/fire", validateAction(ORDER_ACTION), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const orderId = String(req.params.id ?? "").trim();
	const body = (req.body ?? {}) as Record<string, unknown>;
	const itemIds = Array.isArray(body.item_ids) ? body.item_ids.map((i) => String(i)) : [];
	if (!orderId || itemIds.length === 0) { res.status(400).json({ error: "order id and item_ids are required" }); return; }
	try {
		const result = await FireOrderItems(restaurantId, orderId, itemIds);
		try { await log_audit(req, FIRE_COURSE_ACTION_ID, `Fired ${result.fired.length} held item(s) on order ${orderId}`, Audit_log_category.Orders, { order_id: orderId, item_ids: result.fired }); } catch {/* ignore */}
		try { emitRestaurant(restaurantId, "order:updated", { order_id: orderId, fired: result.fired }); } catch {/* ignore */}
		res.json({ success: true, fired: result.fired });
	} catch (err: any) {
		logger.error({ err }, "fire_course_failed");
		res.status(400).json({ error: String(err?.message ?? "Unable to fire items") });
	}
});

// Bark an order: the expo announces it to the kitchen — the visible step
// between acceptance and cooking. Stamps barked_at (+ who) and (re)bases the
// order/dish prep timers so kitchen time counts from the bark.
app.post("/orders/:id/bark", validateAction(ORDER_ACTION), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const orderId = String(req.params.id ?? "").trim();
	if (!orderId) { res.status(400).json({ error: "order id is required" }); return; }
	try {
		const result = await BarkOrder(restaurantId, orderId, extractEmployeeId(req));
		if (!result.already_barked) {
			try { await log_audit(req, BARK_ORDER_ACTION_ID, `Barked order ${orderId} to the kitchen`, Audit_log_category.Orders, { order_id: orderId, barked_at: result.barked_at }); } catch {/* ignore */}
			try { emitRestaurant(restaurantId, "order:updated", { order_id: orderId, barked: true }); } catch {/* ignore */}
		}
		res.json({ success: true, barked_at: result.barked_at, already_barked: result.already_barked });
	} catch (err: any) {
		logger.error({ err }, "bark_order_failed");
		res.status(400).json({ error: String(err?.message ?? "Unable to bark order") });
	}
});

// Expo/pass screen: per-table ready-vs-pending consolidation across all active
// orders (read-only; same permission as viewing orders).
app.get("/kds/expo", validateAction("b7f78d0f-323d-4622-8d05-aa2f82d54b2e"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { res.json(await GetExpoView(restaurantId)); }
	catch (err) { logger.error({ err }, "kds_expo_failed"); res.status(500).json({ error: "Unable to load expo view" }); }
});

app.get("/orders/timing-stats", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { res.json(await GetTimingStats(restaurantId)); }
	catch (err) { logger.error({ err }, "timing_stats_failed"); res.status(500).json({ error: "Unable to fetch timing stats" }); }
});

// Kitchen analytics: per-dish prep time, per-section (station) averages and an
// order-level prep summary over the last `days` days (default 30, clamped 1..365).
app.get("/analytics/kitchen", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const daysRaw = typeof req.query.days === "string" ? Number.parseInt(req.query.days, 10) : 30;
	const days = Math.min(365, Math.max(1, Number.isFinite(daysRaw) ? daysRaw : 30));
	try { res.json(await GetKitchenAnalytics(restaurantId, days)); }
	catch (err) { logger.error({ err }, "kitchen_analytics_failed"); res.status(500).json({ error: "Unable to fetch kitchen analytics" }); }
});

// "What does this number mean?" copy for the analytics screens. Static text, no
// restaurant data — served from here so the web and Flutter clients render the
// identical wording for a metric. Keyed by metric id (see METRIC_EXPLAINERS).
app.get("/analytics/metric-explainers", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), (_req: Request, res: Response) => {
	res.json({ explainers: METRIC_EXPLAINERS });
});

// Daily revenue/order series for trend charts.
app.get("/orders/daily-revenue", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const daysRaw = typeof req.query.days === "string" ? Number.parseInt(req.query.days, 10) : 14;
	try {
		const series = await GetDailyRevenueSeries(restaurantId, Number.isFinite(daysRaw) ? daysRaw : 14);
		res.json({ series });
	} catch (error) {
		logger.error({ err: error }, "get_daily_revenue_failed");
		res.status(500).json({ error: "Unable to fetch daily revenue" });
	}
});

// Actionable menu/staff analytics: top-selling dishes, slow movers, data-driven
// price suggestions, and revenue by waiter over the last ?days days (default 30).
app.get("/analytics/menu-insights", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const daysRaw = typeof req.query.days === "string" ? Number.parseInt(req.query.days, 10) : 30;
	try {
		res.json(await GetMenuPerformanceInsights(restaurantId, Number.isFinite(daysRaw) ? daysRaw : 30));
	} catch (error) {
		logger.error({ err: error }, "get_menu_insights_failed");
		res.status(500).json({ error: "Unable to fetch menu insights" });
	}
});

// --- Accounting & reporting --------------------------------------------------
// Gated by the analytics/financial-reports permission.
const ACCOUNTING_PERM = "df75119b-e5f1-4f38-aba5-78a1cf182f56";

function toCsv(headers: string[], rows: (string | number)[][]): string {
	const esc = (v: string | number) => {
		const s = String(v ?? "");
		return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};
	return [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}

function reportRange(req: Request): { from?: string; to?: string } {
	return {
		from: typeof req.query.from === "string" ? req.query.from : undefined,
		to: typeof req.query.to === "string" ? req.query.to : undefined,
	};
}

// --- Payroll (accounting) ---------------------------------------------------
app.get("/payroll", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const period = typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month)
		? req.query.month
		: new Date().toISOString().slice(0, 7);
	try { res.json(await GetPayroll(restaurantId, period)); }
	catch (e: any) { logger.error({ err: e }, "get_payroll_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to load payroll") }); }
});

app.put("/payroll/profile", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	const empId = typeof b.emp_id === "string" ? b.emp_id.trim() : "";
	if (!empId) { res.status(400).json({ error: "emp_id is required" }); return; }
	try {
		await SetPayrollProfile(restaurantId, empId, {
			pay_type: typeof b.pay_type === "string" ? b.pay_type : undefined,
			base_salary: Number(b.base_salary ?? 0) || 0,
			hourly_rate: Number(b.hourly_rate ?? 0) || 0,
			allowances: Number(b.allowances ?? 0) || 0,
			deductions: Number(b.deductions ?? 0) || 0,
			pf_pct: Number(b.pf_pct ?? 0) || 0,
			esi_pct: Number(b.esi_pct ?? 0) || 0,
		});
		try { await log_audit(req, ACCOUNTING_PERM, `Updated payroll profile`, Audit_log_category.General, { emp_id: empId }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (e: any) { res.status(400).json({ error: String(e?.message ?? "Unable to save payroll profile") }); }
});

app.post("/payroll/pay", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	try {
		const r = await RecordPayrollPayment(restaurantId, {
			emp_id: typeof b.emp_id === "string" ? b.emp_id : "",
			period: typeof b.period === "string" ? b.period : "",
			amount: Number(b.amount ?? 0) || 0,
			note: typeof b.note === "string" ? b.note : undefined,
			paidBy: extractEmployeeId(req) ?? undefined,
		});
		try { await log_audit(req, ACCOUNTING_PERM, `Recorded salary payment (${b.period})`, Audit_log_category.General, { emp_id: b.emp_id, amount: r.amount }); } catch {/* ignore */}
		res.status(201).json(r);
	} catch (e: any) { res.status(400).json({ error: String(e?.message ?? "Unable to record payment") }); }
});

// Payroll register CSV for the month — gross + statutory (PF/ESI) split per employee.
app.get("/payroll.csv", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const period = typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month)
		? req.query.month
		: new Date().toISOString().slice(0, 7);
	try {
		const p = await GetPayroll(restaurantId, period);
		const r2 = (n: number) => Math.round(n * 100) / 100;
		const rows: (string | number)[][] = p.rows.map((r) => {
			const prof = r.profile;
			const gross = prof ? r2(prof.pay_type === "hourly" ? r.hours_worked * prof.hourly_rate : prof.base_salary) : 0;
			return [
				r.name,
				r.role,
				prof ? prof.pay_type : "",
				gross,
				prof ? prof.allowances : 0,
				prof ? prof.deductions : 0,
				r.pf_amount ?? 0,
				r.esi_amount ?? 0,
				r.computed_pay ?? 0,
				r.paid ? "Yes" : "No",
			];
		});
		res.setHeader("Content-Type", "text/csv; charset=utf-8");
		res.setHeader("Content-Disposition", `attachment; filename="payroll_${period}.csv"`);
		res.send(toCsv(["Name", "Role", "Type", "Gross", "Allowances", "Deductions", "PF", "ESI", "Net", "Paid"], rows));
	} catch (e: any) { logger.error({ err: e }, "payroll_csv_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to export payroll") }); }
});

app.get("/expenses", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const { from, to } = reportRange(req);
	try { res.json({ expenses: await GetExpenses(restaurantId, from, to) }); }
	catch (e) { logger.error({ err: e }, "get_expenses_failed"); res.status(500).json({ error: "Unable to fetch expenses" }); }
});

app.post("/expenses", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const amount = Number(body.amount ?? 0) || 0;
	if (amount <= 0) { res.status(400).json({ error: "A positive amount is required" }); return; }
	try {
		const created = await AddExpense(restaurantId, {
			amount,
			category: typeof body.category === "string" ? body.category : undefined,
			vendor: typeof body.vendor === "string" ? body.vendor : undefined,
			note: typeof body.note === "string" ? body.note : undefined,
			spent_on: typeof body.spent_on === "string" ? body.spent_on : undefined,
			createdBy: extractEmployeeId(req) ?? undefined,
		});
		try { await log_audit(req, ACCOUNTING_PERM, `Added expense ${created.category} ${created.amount}`, Audit_log_category.Bill, { id: created.id }); } catch {/* ignore */}
		res.json(created);
	} catch (e: any) { logger.error({ err: e }, "add_expense_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to add expense") }); }
});

app.delete("/expenses/:id", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!id) { res.status(400).json({ error: "Missing id" }); return; }
	try {
		await DeleteExpense(restaurantId, id);
		try { await log_audit(req, ACCOUNTING_PERM, `Deleted expense ${id}`, Audit_log_category.Bill, { id }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (e) { logger.error({ err: e }, "delete_expense_failed"); res.status(400).json({ error: "Unable to delete expense" }); }
});

// --- Waitlist / queue (staff) ---
const WAITLIST_PERM = "090ea8d4-e348-4e1b-9723-11131a73a085"; // front-of-house (tables/occupy)
app.get("/waitlist", validateAction(WAITLIST_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { res.json({ entries: await GetWaitlist(restaurantId) }); }
	catch (e) { logger.error({ err: e }, "waitlist_list_failed"); res.status(500).json({ error: "Unable to fetch waitlist" }); }
});

app.post("/waitlist/:id/call", validateAction(WAITLIST_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const entry = await CallWaitlistEntry(restaurantId, String(req.params.id));
		try { emitRestaurant(restaurantId, "waitlist:updated", { action: "call", id: entry.id }); } catch {/* ignore */}
		try { await log_audit(req, WAITLIST_PERM, `Called queue party ${entry.name}`, Audit_log_category.Tables, { id: entry.id }); } catch {/* ignore */}
		res.json(entry);
	} catch (e: any) { logger.error({ err: e }, "waitlist_call_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to call this party") }); }
});

app.post("/waitlist/:id/seat", validateAction(WAITLIST_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	if (!tableName) { res.status(400).json({ error: "table_name is required" }); return; }
	try {
		const r = await SeatWaitlistEntry(restaurantId, String(req.params.id), tableName, extractEmployeeId(req) ?? undefined);
		try { emitRestaurant(restaurantId, "waitlist:updated", { action: "seat" }); } catch {/* ignore */}
		// Seating a queued party auto-places its held pre-order — that is a real new
		// kitchen ticket, so it gets the same notification/realtime fan-out as any
		// other order. Notified HERE (not inside SeatWaitlistEntry) so a rolled-back
		// seat can never leave a notification for an order that does not exist.
		if (r.placed_order_id) {
			const seatedOrder: CreatedOrderInfo = { orderId: r.placed_order_id, table: r.table_name };
			await notifyOrderCreated(restaurantId, seatedOrder);
			emitOrderCreated(restaurantId, seatedOrder);
		}
		try { await log_audit(req, WAITLIST_PERM, `Seated queue party at ${r.table_name}`, Audit_log_category.Tables, { table: r.table_name, order: r.placed_order_id }); } catch {/* ignore */}
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "waitlist_seat_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to seat this party") }); }
});

app.post("/waitlist/:id/cancel", validateAction(WAITLIST_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const status = body.status === "no_show" ? "no_show" : "cancelled";
	try {
		await CancelWaitlistEntry(restaurantId, String(req.params.id), status);
		try { emitRestaurant(restaurantId, "waitlist:updated", { action: "cancel" }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (e: any) { logger.error({ err: e }, "waitlist_cancel_staff_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to update the queue") }); }
});

// --- Tenant subscription & billing (restaurant admin) ----------------------
// Platform-account Razorpay keys (separate from each restaurant's OWN Razorpay,
// which collects dine-in payments). These collect the SaaS subscription fee.
const PLATFORM_RAZORPAY_KEY_ID = process.env.PLATFORM_RAZORPAY_KEY_ID || "";
const PLATFORM_RAZORPAY_KEY_SECRET = process.env.PLATFORM_RAZORPAY_KEY_SECRET || "";
const platformRazorpayReady = Boolean(PLATFORM_RAZORPAY_KEY_ID && PLATFORM_RAZORPAY_KEY_SECRET);

app.get("/billing", async (req: Request, res: Response) => {
	const auth = await enforcePermission(req, res, PERM_BILLING);
	if (!auth) {return;}
	if (!billingConfigured()) {
		res.json({ configured: false, online_pay: false, subscription: null, plan: null, pending_plan: null, plans: [], invoices: [] });
		return;
	}
	try {
		const data = await getTenantBilling(auth.restaurantId);
		res.json({ configured: true, online_pay: platformRazorpayReady, ...data });
	} catch (e) { logger.error({ err: e }, "billing_get_failed"); res.status(500).json({ error: "Unable to load billing" }); }
});

app.post("/billing/change-plan", async (req: Request, res: Response) => {
	const auth = await enforcePermission(req, res, PERM_BILLING);
	if (!auth) {return;}
	const body = (req.body ?? {}) as Record<string, unknown>;
	const planId = typeof body.plan_id === "string" ? body.plan_id.trim() : "";
	if (!planId) { res.status(400).json({ error: "plan_id is required" }); return; }
	try {
		const result = await requestPlanChange(auth.restaurantId, planId);
		res.json(result);
	} catch (e: any) { logger.error({ err: e }, "billing_change_plan_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to change plan") }); }
});

app.post("/billing/pay/create", async (req: Request, res: Response) => {
	const auth = await enforcePermission(req, res, PERM_BILLING);
	if (!auth) {return;}
	if (!platformRazorpayReady) { res.status(503).json({ error: "Online payment isn't set up. Your provider will confirm the payment manually." }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const invoiceId = typeof body.invoice_id === "string" ? body.invoice_id.trim() : "";
	if (!invoiceId) { res.status(400).json({ error: "invoice_id is required" }); return; }
	try {
		const inv = await getInvoice(invoiceId);
		if (!inv || inv.res_id !== auth.restaurantId) { res.status(404).json({ error: "Invoice not found" }); return; }
		if (inv.status === "paid") { res.status(409).json({ error: "This invoice is already paid" }); return; }
		const rp = await fetchWithTimeout("https://api.razorpay.com/v1/orders", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Basic " + Buffer.from(`${PLATFORM_RAZORPAY_KEY_ID}:${PLATFORM_RAZORPAY_KEY_SECRET}`).toString("base64"),
			},
			body: JSON.stringify({ amount: Math.max(100, Math.round(inv.amount_cents)), currency: "INR", receipt: `inv_${inv.id}` }),
		});
		if (!rp.ok) { const t = await rp.text().catch(() => ""); logger.error({ status: rp.status, body: t.slice(0, 300) }, "platform_razorpay_order_failed"); res.status(502).json({ error: "Payment gateway error" }); return; }
		const order: any = await rp.json();
		// Bind the order to THIS invoice so verify can require they match.
		await setInvoiceOrderId(inv.id, String(order.id));
		res.json({ order_id: order.id, amount: order.amount, currency: order.currency, key_id: PLATFORM_RAZORPAY_KEY_ID, invoice_id: inv.id });
	} catch (e: any) { logger.error({ err: e }, "billing_pay_create_failed"); res.status(500).json({ error: "Unable to start payment" }); }
});

app.post("/billing/pay/verify", async (req: Request, res: Response) => {
	const auth = await enforcePermission(req, res, PERM_BILLING);
	if (!auth) {return;}
	if (!platformRazorpayReady) { res.status(503).json({ error: "Online payment isn't set up." }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const invoiceId = typeof body.invoice_id === "string" ? body.invoice_id.trim() : "";
	const orderId = typeof body.razorpay_order_id === "string" ? body.razorpay_order_id : "";
	const paymentId = typeof body.razorpay_payment_id === "string" ? body.razorpay_payment_id : "";
	const signature = typeof body.razorpay_signature === "string" ? body.razorpay_signature : "";
	if (!invoiceId || !orderId || !paymentId || !signature) { res.status(400).json({ error: "invoice_id and razorpay_* fields are required" }); return; }
	try {
		const inv = await getInvoice(invoiceId);
		if (!inv || inv.res_id !== auth.restaurantId) { res.status(404).json({ error: "Invoice not found" }); return; }
		if (inv.status !== "pending") { res.status(409).json({ error: "This invoice is no longer payable" }); return; }
		// The order MUST be the one we created for this invoice (no reusing another
		// order's valid signature to settle this invoice).
		if (!inv.razorpay_order_id || inv.razorpay_order_id !== orderId) { res.status(400).json({ error: "Payment does not match this invoice" }); return; }
		// Signature authenticity (constant-time).
		const expected = createHmac("sha256", PLATFORM_RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
		if (!timingSafeStrEqual(expected, signature)) { res.status(400).json({ error: "Payment verification failed" }); return; }
		// Independently confirm with Razorpay that THIS order was actually captured
		// for the FULL invoice amount (never trust the client's claim alone).
		const expectedAmount = Math.max(100, Math.round(inv.amount_cents));
		const ordRes = await fetchWithTimeout(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`, {
			headers: { Authorization: "Basic " + Buffer.from(`${PLATFORM_RAZORPAY_KEY_ID}:${PLATFORM_RAZORPAY_KEY_SECRET}`).toString("base64") },
		});
		if (!ordRes.ok) { logger.error({ err: ordRes.status }, "platform_razorpay_order_fetch_failed"); res.status(502).json({ error: "Could not confirm payment with the gateway" }); return; }
		const ord: any = await ordRes.json();
		const paid = ord?.status === "paid" || Number(ord?.amount_paid) >= expectedAmount;
		if (!paid || Number(ord?.amount) !== expectedAmount) {
			res.status(400).json({ error: "Payment amount/status mismatch" });
			return;
		}
		// Idempotent + replay-safe: the UPDATE only transitions a pending invoice, and
		// razorpay_payment_id is UNIQUE (a captured payment settles one invoice only).
		let result;
		try {
			result = await markInvoicePaidAndActivate(invoiceId, paymentId);
		} catch (e: any) {
			if (e?.code === "23505") { res.status(409).json({ error: "This payment has already been applied" }); return; }
			throw e;
		}
		if (!result) { res.status(409).json({ error: "This invoice is already paid" }); return; }
		res.json({ ok: true, ...result });
	} catch (e: any) { logger.error({ err: e }, "billing_pay_verify_failed"); res.status(500).json({ error: "Unable to verify payment" }); }
});

// --- Cash register / day-close ---
app.get("/cash/current", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { res.json({ session: await GetCurrentCashSession(restaurantId) }); }
	catch (e) { logger.error({ err: e }, "cash_current_failed"); res.status(500).json({ error: "Unable to fetch cash session" }); }
});

app.post("/cash/open", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	try {
		const session = await OpenCashSession(restaurantId, {
			opening_float: Number(body.opening_float ?? 0) || 0,
			openedBy: extractEmployeeId(req) ?? undefined,
		});
		try { await log_audit(req, ACCOUNTING_PERM, `Opened cash session (float ${session.opening_float})`, Audit_log_category.Bill, { id: session.id }); } catch {/* ignore */}
		res.json(session);
	} catch (e: any) { logger.error({ err: e }, "cash_open_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to open cash session") }); }
});

app.post("/cash/close", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const counted = Number(body.counted_cash ?? NaN);
	if (!Number.isFinite(counted) || counted < 0) { res.status(400).json({ error: "counted_cash is required" }); return; }
	try {
		const session = await CloseCashSession(restaurantId, {
			counted_cash: counted,
			cash_payouts: Number(body.cash_payouts ?? 0) || 0,
			notes: typeof body.notes === "string" ? body.notes : undefined,
			closedBy: extractEmployeeId(req) ?? undefined,
		});
		try { await log_audit(req, ACCOUNTING_PERM, `Closed cash session (variance ${session.variance})`, Audit_log_category.Bill, { id: session.id }); } catch {/* ignore */}
		res.json(session);
	} catch (e: any) { logger.error({ err: e }, "cash_close_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to close cash session") }); }
});

app.get("/cash/sessions", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const { from, to } = reportRange(req);
	try { res.json({ sessions: await GetCashSessions(restaurantId, from, to) }); }
	catch (e) { logger.error({ err: e }, "cash_sessions_failed"); res.status(500).json({ error: "Unable to fetch cash sessions" }); }
});

app.get("/reports/sales", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const { from, to } = reportRange(req);
	try { res.json(await GetSalesReport(restaurantId, from, to)); }
	catch (e) { logger.error({ err: e }, "sales_report_failed"); res.status(500).json({ error: "Unable to build sales report" }); }
});

app.get("/reports/gst", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const { from, to } = reportRange(req);
	try { res.json(await GetGstReport(restaurantId, from, to)); }
	catch (e) { logger.error({ err: e }, "gst_report_failed"); res.status(500).json({ error: "Unable to build GST report" }); }
});

app.get("/reports/pnl", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const { from, to } = reportRange(req);
	try { res.json(await GetProfitAndLoss(restaurantId, from, to)); }
	catch (e) { logger.error({ err: e }, "pnl_report_failed"); res.status(500).json({ error: "Unable to build P&L report" }); }
});

// Discounts & offers given away in the range (money basis). Bill totals are
// already net of these, so this is additive context — see the payload notes.
app.get("/reports/discounts", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const { from, to } = reportRange(req);
	try { res.json(await GetDiscountsReport(restaurantId, from, to)); }
	catch (e) { logger.error({ err: e }, "discounts_report_failed"); res.status(500).json({ error: "Unable to build discounts report" }); }
});

// Pragmatic balance sheet snapshot as of a date (assets / liabilities / equity
// derived from operational data — see the `notes` field for what's counted).
app.get("/reports/balance-sheet", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const asOf = typeof req.query.as_of === "string" ? req.query.as_of : undefined;
	try { res.json(await GetBalanceSheet(restaurantId, asOf)); }
	catch (e) { logger.error({ err: e }, "balance_sheet_failed"); res.status(500).json({ error: "Unable to build balance sheet" }); }
});

// --- Bank / settlement reconciliation ---
// Per-payment-method expected takings for a day (same mode attribution as the
// sales report) merged with any saved actual-settlement entries.
app.get("/reconciliation", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const date = typeof req.query.date === "string" ? req.query.date : undefined;
	try { res.json(await GetReconciliation(restaurantId, date)); }
	catch (e) { logger.error({ err: e }, "reconciliation_get_failed"); res.status(500).json({ error: "Unable to build reconciliation" }); }
});

app.post("/reconciliation", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	try {
		const r = await SaveReconciliation(restaurantId, {
			date: typeof b.date === "string" ? b.date : "",
			method: typeof b.method === "string" ? b.method : "",
			actual: Number(b.actual ?? NaN),
			note: typeof b.note === "string" ? b.note : undefined,
			createdBy: extractEmployeeId(req) ?? undefined,
		});
		try { await log_audit(req, RECONCILE_ACTION_ID, `Reconciled ${r.method} for ${r.date}: expected ${r.expected}, actual ${r.actual} (${r.status})`, Audit_log_category.Bill, { date: r.date, method: r.method, expected: r.expected, actual: r.actual, status: r.status }); } catch {/* ignore */}
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "reconciliation_save_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to save reconciliation") }); }
});

// Undo a saved reconciliation entry for a day+method.
app.delete("/reconciliation", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const date = typeof req.query.date === "string" ? req.query.date : "";
	const method = typeof req.query.method === "string" ? req.query.method : "";
	try {
		const r = await DeleteReconciliation(restaurantId, date, method);
		try { await log_audit(req, RECONCILE_ACTION_ID, `Removed reconciliation entry ${method} for ${date}`, Audit_log_category.Bill, { date, method }); } catch {/* ignore */}
		res.json(r);
	} catch (e: any) { logger.error({ err: e }, "reconciliation_delete_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to delete reconciliation entry") }); }
});

// CSV exports (Excel-openable). Called by authenticated API clients.
app.get("/reports/sales.csv", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const { from, to } = reportRange(req);
	try {
		const r = await GetSalesReport(restaurantId, from, to);
		const rows: (string | number)[][] = r.by_day.map((d) => [d.date, d.bills, d.sales, d.tax, d.refund]);
		rows.push(["Total", r.bill_count, r.total_sales, r.total_tax, r.total_refund]);
		res.setHeader("Content-Type", "text/csv; charset=utf-8");
		res.setHeader("Content-Disposition", `attachment; filename="sales_${r.from}_to_${r.to}.csv"`);
		res.send(toCsv(["Date", "Bills", "Sales", "Tax", "Refunds"], rows));
	} catch (e) { logger.error({ err: e }, "sales_csv_failed"); res.status(500).json({ error: "Unable to export sales" }); }
});

app.get("/reports/gst.csv", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const { from, to } = reportRange(req);
	try {
		const r = await GetGstReport(restaurantId, from, to);
		const rows: (string | number)[][] = r.by_rate.map((t) => [t.name, t.percentage, t.taxable, t.tax]);
		rows.push(["Total", "", r.total_taxable, r.total_tax]);
		res.setHeader("Content-Type", "text/csv; charset=utf-8");
		res.setHeader("Content-Disposition", `attachment; filename="gst_${r.from}_to_${r.to}.csv"`);
		res.send(toCsv(["Tax", "Rate %", "Taxable", "Tax"], rows));
	} catch (e) { logger.error({ err: e }, "gst_csv_failed"); res.status(500).json({ error: "Unable to export GST" }); }
});

// Tally-compatible voucher XML for import into Tally (ERP 9 / Prime).
app.get("/reports/tally.xml", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const { from, to } = reportRange(req);
	try {
		const xml = await BuildTallyXml(restaurantId, from, to);
		res.setHeader("Content-Type", "application/xml; charset=utf-8");
		res.setHeader("Content-Disposition", `attachment; filename="tally_vouchers.xml"`);
		res.send(xml);
	} catch (e) { logger.error({ err: e }, "tally_xml_failed"); res.status(500).json({ error: "Unable to build Tally export" }); }
});

app.get("/expenses.csv", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const { from, to } = reportRange(req);
	try {
		const ex = await GetExpenses(restaurantId, from, to);
		const rows: (string | number)[][] = ex.map((e) => [e.spent_on, e.category, e.vendor ?? "", e.amount, e.note ?? ""]);
		res.setHeader("Content-Type", "text/csv; charset=utf-8");
		res.setHeader("Content-Disposition", `attachment; filename="expenses.csv"`);
		res.send(toCsv(["Date", "Category", "Vendor", "Amount", "Note"], rows));
	} catch (e) { logger.error({ err: e }, "expenses_csv_failed"); res.status(500).json({ error: "Unable to export expenses" }); }
});

// Real operational analytics (order volume + revenue by hour-of-day and weekday).
app.get("/analytics/operations", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const daysRaw = typeof req.query.days === "string" ? Number.parseInt(req.query.days, 10) : 30;
	try { res.json(await GetOperationsAnalytics(restaurantId, Number.isFinite(daysRaw) ? daysRaw : 30)); }
	catch (e) { logger.error({ err: e }, "operations_analytics_failed"); res.status(500).json({ error: "Unable to fetch operations analytics" }); }
});

// --- Attendance / working hours ---------------------------------------------
// Admin reviews a pending clock-in. Approval/rejection stamps who + when; the
// shift's clock_in remains the employee's actual clock-in moment, never the
// approval time.
const ATTENDANCE_REVIEW_ACTION = "e7a41c3b-5a20-4f6e-9d38-6c2b9a51f0aa";
async function handleAttendanceReview(req: Request, res: Response, approve: boolean): Promise<void> {
	const admin = await enforcePermission(req, res, PERM_ATTENDANCE);
	if (!admin) {return;}
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!id) { res.status(400).json({ error: "Missing id" }); return; }
	try {
		const r = await SetAttendanceApproval(admin.restaurantId, id, approve, extractEmployeeId(req) ?? undefined);
		try {
			await log_audit(req, ATTENDANCE_REVIEW_ACTION, `${approve ? "Approved" : "Rejected"} clock-in of employee ${r.emp_id} (clocked in ${r.clock_in})`, Audit_log_category.General, { attendance_id: id, emp_id: r.emp_id, status: r.status });
		} catch (err) { logger.warn({ err }, "log_audit attendance-review failed"); }
		res.json({ success: true, status: r.status, clock_in: r.clock_in });
	} catch (e: any) { res.status(400).json({ error: String(e?.message ?? "Unable to review clock-in") }); }
}
app.post("/attendance/:id/approve", validate, (req: Request, res: Response) => void handleAttendanceReview(req, res, true));
app.post("/attendance/:id/reject", validate, (req: Request, res: Response) => void handleAttendanceReview(req, res, false));

app.post("/attendance/clock-in", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	const employeeId = extractEmployeeId(req);
	if (!restaurantId || !employeeId) { res.status(400).json({ error: "Missing identity" }); return; }
	try {
		const r = await ClockIn(restaurantId, employeeId);
		try { await log_audit(req, "b3f8d6a1-2c47-4e0b-8f5d-9e6a7c8b0d21", `Clocked in at ${r.since} (pending approval)`, Audit_log_category.General, { at: r.since }); } catch (err) { logger.warn({ err }, "log_audit clock-in failed"); }
		res.json(r);
	}
	catch (e: any) { logger.error({ err: e }, "clock_in_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to clock in") }); }
});

app.post("/attendance/clock-out", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	const employeeId = extractEmployeeId(req);
	if (!restaurantId || !employeeId) { res.status(400).json({ error: "Missing identity" }); return; }
	try {
		const r = await ClockOut(restaurantId, employeeId);
		try { await log_audit(req, "b3f8d6a1-2c47-4e0b-8f5d-9e6a7c8b0d21", `Clocked out after ${r.minutes} min`, Audit_log_category.General, { minutes: r.minutes }); } catch (err) { logger.warn({ err }, "log_audit clock-out failed"); }
		res.json(r);
	}
	catch (e: any) { logger.error({ err: e }, "clock_out_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to clock out") }); }
});

app.get("/attendance/me", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	const employeeId = extractEmployeeId(req);
	if (!restaurantId || !employeeId) { res.status(400).json({ error: "Missing identity" }); return; }
	try { res.json(await GetMyAttendance(restaurantId, employeeId)); }
	catch (e) { logger.error({ err: e }, "get_my_attendance_failed"); res.status(500).json({ error: "Unable to fetch attendance" }); }
});

app.get("/attendance", validate, async (req: Request, res: Response) => {
	const auth = await enforcePermission(req, res, PERM_ATTENDANCE);
	if (!auth) {return;}
	const from = typeof req.query.from === "string" ? req.query.from : undefined;
	const to = typeof req.query.to === "string" ? req.query.to : undefined;
	try { res.json(await GetAttendanceSummary(auth.restaurantId, from, to)); }
	catch (e) { logger.error({ err: e }, "attendance_summary_failed"); res.status(500).json({ error: "Unable to fetch attendance summary" }); }
});

app.get("/restaurant/profile", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const employeeId = extractEmployeeId(req) ?? undefined;
	try {
		const profile = await GetRestaurantProfile(restaurantId, employeeId);
		res.json(profile);
	} catch (error) {
		logger.error({ err: error }, "get_restaurant_profile_failed");
		res.status(500).json({ error: "Unable to fetch profile" });
	}
});

app.get("/auth/restaurant-login", validate, async (req: Request, res: Response) => {
	const restaurantUsername = extractRestaurantUsername(req);
	if (!restaurantUsername) {
		res.status(400).json({ error: "Missing restaurant Username" });
		return;
	}

	const resId = await getRestaurantIdFromUsername(restaurantUsername);
	if (!resId) {
		res.status(404).json({ error: "Restaurant not found" });
		return;
	}
	res.json({ res_id: resId });

});

// Publish a bill ESC/POS payload to the appropriate restaurant:outlet pub/sub channel
app.post('/publish/bill', validateAction("2ae797d9-2bef-4419-a33d-ab09590dbef9"), async (req: Request, res: Response) => {
	logger.info('Received request to publish bill');
	const body = (req.body ?? {}) as Record<string, unknown>;
	// Pin to the verified session so a caller cannot publish to another tenant's
	// print channel by spoofing restaurantId/outletId in the body or headers.
	const restaurantId = extractRestaurantId(req);
	const outletId = extractOutletId(req);
	const billId = typeof body.billId === 'string' ? body.billId.trim() : '';
	const escBase64 = typeof body.escBase64 === 'string' ? body.escBase64 : (typeof body.esc === 'string' ? body.esc : null);

	if (!restaurantId || !outletId || !billId || !escBase64) {
		res.status(400).json({ error: 'restaurantId, outletId, billId and escBase64 are required' });
		return;
	}

	try {
		// verify restaurant exists, then verify the outlet belongs to THIS tenant by
		// membership in its Outlets (RLS-scoped to res_id) — not equality to the
		// profile's default outlet, which wrongly rejected valid secondary outlets.
		const profile = await GetRestaurantProfile(restaurantId);
		if (!profile) {
			res.status(404).json({ error: 'Invalid restaurantId' });
			return;
		}

		const outlets = await GetOutlets(restaurantId).catch(() => [] as { id: string }[]);
		const outletBelongs = outlets.some((o) => String(o.id) === String(outletId));
		if (!outletBelongs) {
			res.status(400).json({ error: 'Invalid outletId for the restaurant' });
			return;
		}

		// Emit to outlet-specific room; send billId and base64 payload
		emitOutlet(restaurantId, outletId, 'bill:print', { billId, escBase64, publishedAt: new Date().toISOString() });
		res.json({ success: true });
	} catch (err) {
		logger.error({ err }, 'publish_bill_failed');
		res.status(500).json({ error: 'Unable to publish bill' });
	}
});

// Server-side thermal print: builds the ESC/POS receipt for a table's bill using
// the restaurant's configured currency, then emits bill:print to the printer agent.
app.post('/print/bill', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	const outletId = extractOutletId(req);
	if (!restaurantId || !outletId) { res.status(400).json({ error: 'Missing restaurant/outlet' }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const kind = body.kind === "kot" ? "kot" : "bill";
	if (!tableName) { res.status(400).json({ error: 'table_name is required' }); return; }
	try {
		const [bill, settings, profile] = await Promise.all([
			GetBillForTable(restaurantId, tableName),
			GetRestaurantSettings(restaurantId).catch(() => ({ currency: "₹" } as any)),
			GetRestaurantProfile(restaurantId).catch(() => null),
		]);
		if (!bill || !Array.isArray(bill.items) || bill.items.length === 0) {
			res.status(400).json({ error: 'Nothing to print for this table' });
			return;
		}
		// Reprint without service charge on request (waiver). Recompute taxes on the
		// (discounted) subtotal so the printed total matches the actual bill.
		const includeServiceCharge = body.no_service_charge !== true;
		const charges = computeBillCharges(
			bill.subtotal ?? bill.total_amt ?? 0,
			settings.taxes ?? [],
			settings.service_charge ?? 0,
			includeServiceCharge,
			bill.discount_value > 0 ? { type: bill.discount_type ?? "percent", value: bill.discount_value } : undefined,
		);
		// Column layout + logo raster width follow the configured paper size
		// (58mm = 32 cols / 384 dots, 80mm = 48 cols / 576 dots).
		const is58 = settings.bill_paper_width === "58mm";
		const cols = is58 ? 32 : 48;
		// Kitchen ticket path: enrich each item with its kitchen station (from the
		// menu, by dish name) and split the KOT into ONE ticket per station, so each
		// zone prints only its own items. Each event carries `station` so a printer
		// agent that maps station -> printer can route it; a single-printer agent
		// prints all N tickets on one roll (same paper, just split + labelled).
		if (kind === "kot") {
			const stationByName = new Map<string, string>();
			try {
				const menu = await GetMenuItems(restaurantId);
				for (const m of menu) {if (m.station) {stationByName.set(m.name.trim().toLowerCase(), m.station);}}
			} catch {/* menu unavailable — items fall under a single General ticket */}
			const kotItems = bill.items.map((it) => ({ ...it, station: stationByName.get(String(it.name).trim().toLowerCase()) ?? null }));
			const tickets = buildKotBase64({
				restaurantName: profile?.outlet_name || profile?.restaurant_name || "Receipt",
				table: tableName,
				covers: bill.covers ?? 1,
				items: kotItems,
				total: charges.subtotal,
				currency: settings.currency ?? "₹",
				kind: "kot",
			}, cols);
			const billId = bill.bill_id ?? `${tableName}-${Date.now()}`;
			for (const t of tickets) {
				emitOutlet(restaurantId, outletId, 'bill:print', { billId, escBase64: t.escBase64, station: t.station, kind: "kot", publishedAt: new Date().toISOString() });
			}
			try { await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Printed KOT for table ${tableName} (${tickets.length} station ticket(s))`, Audit_log_category.Bill, { table: tableName, kind, stations: tickets.map((t) => t.station) }); } catch {/* ignore */}
			res.json({ success: true, billId, tickets: tickets.length, stations: tickets.map((t) => t.station) });
			return;
		}
		// The kitchen ticket returned above; everything below is the customer bill,
		// which alone carries the logo, cashier line and feedback QR.
		const isBill = true;
		const feedbackUrl = isBill ? await feedbackUrlForTable(restaurantId, tableName) : null;
		const logo = isBill ? await buildLogoEscPos(restaurantId, is58 ? 384 : 576).catch(() => null) : null;
		let cashier = "";
		if (isBill) {
			try {
				const emp = await GetEmployeeDetailsFromEmpID(extractEmployeeId(req) ?? "");
				cashier = `${emp?.emp_Fname ?? ""} ${emp?.emp_Lname ?? ""}`.trim();
			} catch {/* cashier optional */}
		}
		// Show the service-charge line even when waived ("Opted-out"), matching the web bill.
		const scPercent = charges.service_charge_percent || settings.service_charge || 0;
		const serviceCharge = charges.service_charge > 0
			? { percent: charges.service_charge_percent, amount: charges.service_charge }
			: (!includeServiceCharge && scPercent > 0 ? { percent: scPercent, amount: 0, optedOut: true } : null);
		const escBase64 = buildReceiptBase64({
			restaurantName: profile?.outlet_name || profile?.restaurant_name || "Receipt",
			address: profile?.outlet_add ?? null,
			table: tableName,
			covers: bill.covers ?? 1,
			items: bill.items,
			total: charges.subtotal,
			customer: bill.customer,
			billNo: bill.bill_no,
			cashier: cashier || null,
			discount: charges.discount > 0 ? { amount: charges.discount, label: bill.coupon_code ? `Coupon ${bill.coupon_code}` : "Discount" } : null,
			serviceCharge,
			taxes: charges.taxes,
			currency: settings.currency ?? "₹",
			kind,
			feedbackUrl,
			logo,
			serviceChargeNote: isBill && charges.service_charge > 0
				? "A Voluntary Service Charge is included to support our staff. If you prefer not to contribute, please inform your server before payment and it will be removed."
				: null,
		}, cols);
		const billId = bill.bill_id ?? `${tableName}-${Date.now()}`;
		emitOutlet(restaurantId, outletId, 'bill:print', { billId, escBase64, publishedAt: new Date().toISOString() });
		try { await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Printed ${kind} for table ${tableName}${includeServiceCharge ? "" : " (no service charge)"}`, Audit_log_category.Bill, { table: tableName, kind, no_service_charge: !includeServiceCharge }); } catch {/* ignore */}
		res.json({ success: true, billId });
	} catch (err: any) {
		logger.error({ err }, 'print_bill_failed');
		res.status(500).json({ error: String(err?.message ?? 'Unable to print') });
	}
});

// Admin: remove a wrongly-added item from a table's running bill.
app.post('/bills/remove-item', validateBody(sBillRemoveItem), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin"]);
	if (!auth) {return;}
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const itemName = typeof body.item_name === "string" ? body.item_name.trim() : "";
	const price = Number(body.price ?? 0) || 0;
	if (!tableName || !itemName) { res.status(400).json({ error: "table_name and item_name are required" }); return; }
	try {
		const result = await RemoveBillItem(auth.restaurantId, tableName, itemName, price);
		try { emitRestaurant(auth.restaurantId, "bill:updated", { table: tableName }); } catch {/* ignore */}
		try { await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Removed item ${result.removed.name} from table ${tableName}`, Audit_log_category.Bill, { table: tableName, item: itemName }); } catch {/* ignore */}
		res.json(result);
	} catch (e: any) {
		logger.error({ err: e }, 'remove_bill_item_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to remove item') });
	}
});

// Move a wrongly-placed item from one table to another (front-of-house fix).
app.post('/bills/move-item', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), validateBody(sBillMoveItem), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const fromTable = typeof body.from_table === "string" ? body.from_table.trim() : "";
	const toTable = typeof body.to_table === "string" ? body.to_table.trim() : "";
	const itemName = typeof body.item_name === "string" ? body.item_name.trim() : "";
	const price = Number(body.price ?? 0) || 0;
	if (!fromTable || !toTable || !itemName) { res.status(400).json({ error: "from_table, to_table and item_name are required" }); return; }
	try {
		const result = await MoveBillItem(restaurantId, fromTable, toTable, itemName, price);
		try { emitRestaurant(restaurantId, "bill:updated", { table: fromTable }); emitRestaurant(restaurantId, "bill:updated", { table: toTable }); } catch {/* ignore */}
		try { await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Moved item ${result.moved.name} from ${fromTable} to ${toTable}`, Audit_log_category.Bill, { from: fromTable, to: toTable, item: itemName }); } catch {/* ignore */}
		res.json(result);
	} catch (e: any) {
		logger.error({ err: e }, 'move_bill_item_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to move item') });
	}
});

// Set or clear a discount on a table's open bill (% or flat, off the subtotal).
// When the restaurant configures a discount-approval threshold, a NON-admin
// discount above it is parked as a pending request (managers get a bell ping)
// instead of applying — the response then carries { pending: true, request_id }.
app.post('/bills/discount', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), validateBody(sBillDiscount), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const type = body.type === "flat" ? "flat" : "percent";
	const value = Number(body.value ?? 0) || 0;
	const reason = typeof body.reason === "string" ? body.reason.trim() : "";
	if (!tableName) { res.status(400).json({ error: "table_name is required" }); return; }
	try {
		const result = await SetBillDiscountWithApproval(restaurantId, tableName, value > 0 ? type : null, value, {
			isAdmin: callerIsAdmin(req),
			requestedBy: extractEmployeeId(req),
			reason: reason || null,
		});
		if (result.pending) {
			const label = `${value}${type === "percent" ? "%" : ""} (≈${result.amount})`;
			try {
				await AddNotification(restaurantId, {
					type: "warning",
					title: "Discount approval needed",
					body: `Table ${tableName}: ${label} discount requested — review in Orders`,
					meta: { request_id: result.request_id, table: tableName, amount: result.amount },
				});
			} catch {/* best-effort bell ping */}
			try {
				await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Requested ${label} discount on table ${tableName} (above approval threshold ${result.threshold})`, Audit_log_category.Bill, { table: tableName, type, value, request_id: result.request_id });
			} catch {/* ignore */}
			res.json(result);
			return;
		}
		try { emitRestaurant(restaurantId, "bill:updated", { table: tableName }); } catch {/* ignore */}
		try {
			const desc = value > 0 ? `Applied ${value}${type === "percent" ? "%" : ""} discount to table ${tableName}` : `Cleared discount on table ${tableName}`;
			await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", desc, Audit_log_category.Bill, { table: tableName, type, value });
		} catch {/* ignore */}
		res.json(result);
	} catch (e: any) {
		logger.error({ err: e }, 'set_bill_discount_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to set discount') });
	}
});

// --- Discount approval queue (admin) -----------------------------------------
app.get('/discount-requests', validate, async (req: Request, res: Response) => {
	if (!(await enforcePermission(req, res, PERM_DISCOUNTS))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const status = typeof req.query.status === "string" ? req.query.status : undefined;
	try { res.json({ requests: await GetDiscountRequests(restaurantId, status) }); }
	catch (e) { logger.error({ err: e }, 'get_discount_requests_failed'); res.status(500).json({ error: "Unable to fetch discount requests" }); }
});

// Approve applies the discount to the bill through the SAME path the direct
// discount uses; reject leaves the bill untouched. Both are audit-logged.
for (const decision of ["approve", "reject"] as const) {
	app.post(`/discount-requests/:id/${decision}`, validate, async (req: Request, res: Response) => {
		if (!(await enforcePermission(req, res, PERM_DISCOUNTS))) {return;}
		const restaurantId = extractRestaurantId(req);
		if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
		const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
		if (!id) { res.status(400).json({ error: "Request id is required" }); return; }
		try {
			const request = await DecideDiscountRequest(restaurantId, id, decision === "approve", extractEmployeeId(req));
			if (decision === "approve") {
				try { if (request.table_name) {emitRestaurant(restaurantId, "bill:updated", { table: request.table_name });} } catch {/* ignore */}
			}
			try {
				const label = `${request.discount_value}${request.discount_type === "percent" ? "%" : ""} (≈${request.amount})`;
				await log_audit(req, "c4d2e6f8-1a3b-4c5d-8e7f-2b4a6c8d0e1f", `${decision === "approve" ? "Approved" : "Rejected"} ${label} discount request for table ${request.table_name ?? "?"} (requested by ${request.requested_by ?? "unknown"})`, Audit_log_category.Bill, { request_id: request.id, bill_id: request.bill_id, decision });
			} catch {/* ignore */}
			res.json({ success: true, request });
		} catch (e: any) {
			logger.error({ err: e }, 'decide_discount_request_failed');
			res.status(400).json({ error: String(e?.message ?? 'Unable to update discount request') });
		}
	});
}

// --- Coupons (admin-managed promo codes) ------------------------------------
app.get('/coupons', validate, async (req: Request, res: Response) => {
	if (!(await enforcePermission(req, res, PERM_COUPONS))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { res.json({ coupons: await GetCoupons(restaurantId) }); }
	catch (e) { logger.error({ err: e }, 'get_coupons_failed'); res.status(500).json({ error: "Unable to fetch coupons" }); }
});

app.post('/coupons', validate, async (req: Request, res: Response) => {
	if (!(await enforcePermission(req, res, PERM_COUPONS))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const b = (req.body ?? {}) as Record<string, unknown>;
	try {
		const coupon = await UpsertCoupon(restaurantId, b as any);
		try { await log_audit(req, "60d14e9c-45cc-4dc2-b017-56058cc3ae33", `Saved coupon ${coupon.code}`, Audit_log_category.General, { code: coupon.code }); } catch {/* ignore */}
		res.status(201).json({ coupon });
	} catch (e: any) { logger.error({ err: e }, 'upsert_coupon_failed'); res.status(400).json({ error: String(e?.message ?? "Unable to save coupon") }); }
});

app.delete('/coupons/:id', validate, async (req: Request, res: Response) => {
	if (!(await enforcePermission(req, res, PERM_COUPONS))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	try { await DeleteCoupon(restaurantId, id); res.json({ success: true }); }
	catch (e) { logger.error({ err: e }, 'delete_coupon_failed'); res.status(400).json({ error: "Unable to delete coupon" }); }
});

// Issue a gift voucher (admin). Redemption happens through the normal coupon
// paths (/bills/apply-coupon, /qr/:slug/coupon) — staff just enter the code.
app.post('/vouchers', validate, async (req: Request, res: Response) => {
	if (!(await enforcePermission(req, res, PERM_COUPONS))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const amount = Number(body.amount ?? 0) || 0;
	const code = typeof body.code === "string" ? body.code.trim() : "";
	try {
		const coupon = await CreateGiftVoucher(restaurantId, { code: code || null, amount });
		try { await log_audit(req, "60d14e9c-45cc-4dc2-b017-56058cc3ae33", `Issued gift voucher ${coupon.code} (₹${amount})`, Audit_log_category.General, { code: coupon.code, amount }); } catch {/* ignore */}
		res.status(201).json({ coupon });
	} catch (e: any) { logger.error({ err: e }, 'create_voucher_failed'); res.status(400).json({ error: String(e?.message ?? "Unable to issue voucher") }); }
});

// --- Loyalty points (earn on settle, redeem at billing) ----------------------
// Balance + history for a customer phone (any logged-in staff member).
app.get('/loyalty/:phone', validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const phone = typeof req.params.phone === "string" ? req.params.phone.trim() : "";
	if (!phone) { res.status(400).json({ error: "phone is required" }); return; }
	try { res.json(await GetLoyaltyAccount(restaurantId, phone)); }
	catch (e: any) { logger.error({ err: e }, 'get_loyalty_failed'); res.status(400).json({ error: String(e?.message ?? "Unable to load loyalty account") }); }
});

// Redeem points against a table's open bill (points × point_value → flat
// discount through the standard bill-discount path). Same permission as the
// other bill operations (order action).
app.post('/loyalty/redeem', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const phone = typeof body.phone === "string" ? body.phone.trim() : "";
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const points = Number(body.points ?? 0) || 0;
	if (!phone || !tableName) { res.status(400).json({ error: "phone and table_name are required" }); return; }
	try {
		const result = await RedeemLoyaltyPoints(restaurantId, { phone, points, table_name: tableName });
		try { emitRestaurant(restaurantId, "bill:updated", { table: tableName }); } catch {/* ignore */}
		try { await log_audit(req, LOYALTY_REDEEM_ACTION_ID, `Redeemed ${result.points} loyalty points (₹${result.discount}) on table ${tableName}`, Audit_log_category.Bill, { table: tableName, phone, points: result.points, discount: result.discount }); } catch {/* ignore */}
		res.json(result);
	} catch (e: any) { logger.error({ err: e }, 'loyalty_redeem_failed'); res.status(400).json({ error: String(e?.message ?? "Unable to redeem points") }); }
});

// --- Aggregator (Swiggy/Zomato) order intake ---------------------------------
// Mint/rotate the restaurant's intake API key. The key is returned ONCE here
// (stored plain server-side; generating again rotates it).
app.post('/aggregator/generate-key', validate, async (req: Request, res: Response) => {
	if (!(await enforceAdmin(req, res))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const key = await GenerateAggregatorKey(restaurantId);
		try { await log_audit(req, "60d14e9c-45cc-4dc2-b017-56058cc3ae33", `Generated aggregator intake API key`, Audit_log_category.General, {}); } catch {/* ignore */}
		res.json({ key, note: "Shown once — store it with your Swiggy/Zomato middleware. Generating again rotates (invalidates) this key." });
	} catch (e: any) { logger.error({ err: e }, 'aggregator_key_failed'); res.status(500).json({ error: "Unable to generate key" }); }
});

// Public order intake: the per-restaurant key in the body is the auth. Live
// Swiggy/Zomato webhooks require their partner-API onboarding — this endpoint
// is the integration point their middleware posts to.
app.post('/aggregator/order', rateLimit("aggregator", 120, 60_000), async (req: Request, res: Response) => {
	const body = (req.body ?? {}) as Record<string, unknown>;
	const key = typeof body.key === "string" ? body.key.trim() : "";
	if (!key) { res.status(401).json({ error: "Missing aggregator key" }); return; }
	let resId: string | null = null;
	try { resId = await GetRestaurantIdByAggregatorKey(key); } catch { resId = null; }
	if (!resId) { res.status(401).json({ error: "Invalid aggregator key" }); return; }
	const source = body.source === "zomato" ? "zomato" : body.source === "swiggy" ? "swiggy" : null;
	const externalId = typeof body.external_id === "string" || typeof body.external_id === "number" ? String(body.external_id).trim() : "";
	const items = Array.isArray(body.items) ? body.items : [];
	if (!source) { res.status(400).json({ error: "source must be 'swiggy' or 'zomato'" }); return; }
	if (!externalId) { res.status(400).json({ error: "external_id is required" }); return; }
	if (items.length === 0) { res.status(400).json({ error: "At least one item is required" }); return; }
	try {
		const result = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () =>
			AddAggregatorOrder(resId, {
				source,
				external_id: externalId,
				items: items as any,
				customer_name: typeof body.customer_name === "string" ? body.customer_name : undefined,
				customer_phone: typeof body.customer_phone === "string" ? body.customer_phone : undefined,
			}),
		);
		if (!result.deduped) {
			const label = source === "swiggy" ? "Swiggy" : "Zomato";
			try {
				await AddNotification(resId, {
					type: "order",
					title: `New ${label} order`,
					body: `#${externalId} · ${items.length} item${items.length > 1 ? "s" : ""} · ₹${result.total}`,
					meta: { table: result.table, order_id: result.order_id, source },
				});
			} catch {/* ignore */}
			try { emitRestaurant(resId, "order:updated", { table: result.table, source }); } catch {/* ignore */}
		}
		res.status(result.deduped ? 200 : 201).json({ success: true, ...result });
	} catch (e: any) {
		logger.error({ err: e }, 'aggregator_order_failed');
		res.status(400).json({ error: safeClientError(e, "Unable to place aggregator order") });
	}
});

// Apply a coupon code to a table's open bill (staff / in-app).
app.post('/bills/apply-coupon', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), validateBody(sBillApplyCoupon), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const code = typeof body.code === "string" ? body.code.trim() : "";
	const phone = typeof body.customer_phone === "string" ? body.customer_phone.trim() : undefined;
	if (!tableName || !code) { res.status(400).json({ error: "table_name and code are required" }); return; }
	try {
		const result = await ApplyCouponToBill(restaurantId, tableName, code, phone);
		try { emitRestaurant(restaurantId, "bill:updated", { table: tableName }); } catch {/* ignore */}
		try { await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Applied coupon ${result.code} to table ${tableName}`, Audit_log_category.Bill, { table: tableName, code: result.code }); } catch {/* ignore */}
		res.json(result);
	} catch (e: any) { logger.error({ err: e }, 'apply_coupon_failed'); res.status(400).json({ error: String(e?.message ?? "Unable to apply coupon") }); }
});

// Add / edit / clear the kitchen note on a single bill item (by name + price),
// at any time. Front-of-house staff with bill access can annotate items.
app.post('/bills/item-note', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), validateBody(sBillItemNote), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const itemName = typeof body.item_name === "string" ? body.item_name.trim() : "";
	const price = Number(body.price ?? 0) || 0;
	const note = typeof body.note === "string" ? body.note : "";
	if (!tableName || !itemName) { res.status(400).json({ error: "table_name and item_name are required" }); return; }
	try {
		const result = await SetBillItemNote(restaurantId, tableName, itemName, price, note);
		try { emitRestaurant(restaurantId, "bill:updated", { table: tableName }); } catch {/* ignore */}
		try { await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `${note.trim() ? "Set" : "Cleared"} note on ${itemName} (table ${tableName})`, Audit_log_category.Bill, { table: tableName, item: itemName }); } catch {/* ignore */}
		res.json(result);
	} catch (e: any) {
		logger.error({ err: e }, 'set_bill_item_note_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to set item note') });
	}
});

// Compute a split of a table's bill (read-only — does not change the bill).
app.post('/bills/split', validateAction("98b10bde-802d-4a5b-a726-53a826424f79"), validateBody(sBillSplit), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const mode = body.mode === "item" ? "item" : "even";
	if (!tableName) { res.status(400).json({ error: "table_name is required" }); return; }
	try {
		const result = await SplitBillForTable(restaurantId, tableName, mode, {
			parts: Number(body.parts ?? 0) || undefined,
			groups: Array.isArray(body.groups) ? (body.groups as any) : undefined,
		});
		res.json(result);
	} catch (e: any) {
		logger.error({ err: e }, 'split_bill_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to split bill') });
	}
});

// Merge one table's active orders into another (combine checks).
app.post('/bills/merge', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), validateBody(sBillMerge), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const fromTable = typeof body.from_table === "string" ? body.from_table.trim() : "";
	const toTable = typeof body.to_table === "string" ? body.to_table.trim() : "";
	if (!fromTable || !toTable) { res.status(400).json({ error: "from_table and to_table are required" }); return; }
	try {
		const result = await MergeTableBills(restaurantId, fromTable, toTable);
		try { emitRestaurant(restaurantId, "bill:updated", { table: fromTable }); emitRestaurant(restaurantId, "bill:updated", { table: toTable }); } catch {/* ignore */}
		try { await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Merged table ${fromTable} into ${toTable} (${result.moved_orders} orders)`, Audit_log_category.Bill, { from: fromTable, to: toTable }); } catch {/* ignore */}
		res.json(result);
	} catch (e: any) {
		logger.error({ err: e }, 'merge_bill_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to merge bills') });
	}
});

// Refund a settled bill (admin only). Records the reversal; for a Razorpay payment
// it also attempts a gateway refund when keys are configured.
app.post('/bills/refund', validateBody(sBillRefund), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin"]);
	if (!auth) {return;}
	const restaurantId = auth.restaurantId;
	const body = (req.body ?? {}) as Record<string, unknown>;
	const billId = typeof body.bill_id === "string" ? body.bill_id.trim() : "";
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const amount = Number(body.amount ?? 0) || 0;
	const reason = typeof body.reason === "string" ? body.reason.trim() : "";
	if (!billId && !tableName) { res.status(400).json({ error: "bill_id or table_name is required" }); return; }
	const byUsername = extractEmployeeId(req) ?? undefined;
	try {
		const result = await RefundBill(restaurantId, {
			billId: billId || undefined,
			tableName: tableName || undefined,
			amount: amount || undefined,
			reason: reason || undefined,
			byUsername,
		});
		// For an online (Razorpay) payment, attempt the gateway refund too.
		let gateway: "skipped" | "ok" | "failed" | "manual" = "skipped";
		if (result.payment_method === "Razorpay" && result.payment_ref) {
			const keys = (await GetRestaurantRazorpayKeys(restaurantId).catch(() => null))
				?? ((RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) ? { key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET } : null);
			if (!keys) {
				gateway = "manual";
			} else {
				try {
					const rp = await fetchWithTimeout(`https://api.razorpay.com/v1/payments/${encodeURIComponent(result.payment_ref)}/refund`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: "Basic " + Buffer.from(`${keys.key_id}:${keys.key_secret}`).toString("base64"),
							// Stable per-bill key so retrying a failed refund can't double-refund
							// at the gateway — Razorpay returns the same refund for the same key.
							"X-Razorpay-Idempotency-Key": `refund:${result.bill_id}`,
						},
						body: JSON.stringify({ amount: Math.round(result.amount * 100) }),
					});
					if (rp.ok) {
						const j: any = await rp.json().catch(() => ({}));
						gateway = "ok";
						if (typeof j?.id === "string" && j.id) { try { await SetBillRefundRef(restaurantId, result.bill_id, j.id); } catch {/* ignore */} }
					} else {
						// A failed real-money refund must be diagnosable.
						const errText = await rp.text().catch(() => "");
						logger.error({ bill_id: result.bill_id, status: rp.status, body: errText.slice(0, 500) }, "razorpay_refund_failed");
						gateway = "failed";
					}
				} catch (e) { logger.error({ bill_id: result.bill_id, error: String((e as any)?.message ?? e) }, "razorpay_refund_error"); gateway = "failed"; }
			}
		}
		try { await log_audit(req, "fc57d407-4bba-442c-97a2-9e6f3c57f288", `Refunded bill ${result.bill_id} (amount ${result.amount}, gateway ${gateway})`, Audit_log_category.Bill, { bill_id: result.bill_id, amount: result.amount, gateway }); } catch {/* ignore */}
		try { if (tableName) {emitRestaurant(restaurantId, "bill:updated", { table: tableName });} } catch {/* ignore */}
		res.json({ ...result, gateway });
	} catch (e: any) {
		logger.error({ err: e }, 'refund_bill_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to refund bill') });
	}
});

// Re-open a closed bill (admin only) within the restaurant's configured window
// (Settings → bill_reopen_window_min, default 240). Refunded bills are refused.
app.post('/bills/:id/reopen', validate, async (req: Request, res: Response) => {
	if (!(await enforceAdmin(req, res))) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const billId = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!billId) { res.status(400).json({ error: "Bill id is required" }); return; }
	try {
		const result = await ReopenBill(restaurantId, billId, extractEmployeeId(req));
		try { if (result.bill.table_name) {emitRestaurant(restaurantId, "bill:updated", { table: result.bill.table_name });} } catch {/* ignore */}
		try {
			await log_audit(req, "d5e3f7a9-2b4c-4d6e-9f80-3c5b7d9e1f2a", `Re-opened bill ${result.bill.bill_no ?? result.bill.id} (table ${result.bill.table_name ?? "?"}, ${result.restored_orders} orders restored)`, Audit_log_category.Bill, { bill_id: result.bill.id, table: result.bill.table_name, restored_orders: result.restored_orders });
		} catch {/* ignore */}
		res.json(result);
	} catch (e: any) {
		logger.error({ err: e }, 'reopen_bill_failed');
		res.status(400).json({ error: String(e?.message ?? 'Unable to re-open bill') });
	}
});

app.put("/restaurant/profile", validateAction("60d14e9c-45cc-4dc2-b017-56058cc3ae33"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	// Accept BOTH the short shape sent by the owner app ({name,address,phone,
	// email,hours}) and the long RestaurantProfileRecord shape sent by the web
	// ({restaurant_name,outlet_add,outlet_phone,email,outlet_hours,…}). Previously
	// the endpoint only accepted the short keys while the data layer read the long
	// ones, so the app 500'd ("Unable to update profile") and the web silently
	// no-op'd — this normalizes the two into one record.
	const b = (req.body ?? {}) as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "string" ? v : undefined);
	const restaurant_name = (str(b.name) ?? str(b.restaurant_name) ?? "").trim();
	const outlet_add = (str(b.address) ?? str(b.outlet_add) ?? "").trim();
	const outlet_phone = (str(b.phone) ?? str(b.outlet_phone) ?? "").trim();
	const email = (str(b.email) ?? "").trim();
	const outlet_hours = (str(b.hours) ?? str(b.outlet_hours) ?? "").trim();

	if (!restaurant_name) {
		res.status(400).json({ error: "Restaurant name is required" });
		return;
	}

	const employeeId = extractEmployeeId(req) ?? undefined;
	try {
		await UpdateRestaurantProfile(restaurantId, { restaurant_name, outlet_add, outlet_phone, outlet_hours, email }, employeeId);
		res.json({ success: true });
	} catch (error) {
		logger.error({ err: error }, "update_restaurant_profile_failed");
		res.status(500).json({ error: "Unable to update profile" });
	}
});

// --- Multi-outlet management -------------------------------------------------
const OUTLET_ADMIN_PERM = "60d14e9c-45cc-4dc2-b017-56058cc3ae33"; // restaurant-settings permission

// List a restaurant's outlets (any authed user — used by the outlet switcher).
app.get("/outlets", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	// Echo the aggregate-read mode + the concrete outlet the connection is bound to,
	// so the UI can confirm whether "all outlets" took effect for this request.
	const isAll = req.auth?.allOutlets === true;
	try { res.json({ outlets: await GetOutlets(restaurantId), is_all: isAll, current_outlet_id: req.auth?.outlet_id ?? null }); }
	catch (e) { logger.error({ err: e }, "get_outlets_failed"); res.status(500).json({ error: "Unable to fetch outlets" }); }
});

// Cross-outlet rollup (central owner view): revenue + orders per branch.
app.get("/outlets/rollup", validateAction(OUTLET_ADMIN_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const daysRaw = typeof req.query.days === "string" ? Number.parseInt(req.query.days, 10) : 30;
	try { res.json(await GetOutletsRollup(restaurantId, Number.isFinite(daysRaw) ? daysRaw : 30)); }
	catch (e) { logger.error({ err: e }, "outlets_rollup_failed"); res.status(500).json({ error: "Unable to build rollup" }); }
});

app.post("/outlets", validateAction(OUTLET_ADMIN_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	// Additive plan gate: only blocks adding outlets when the plan explicitly says so.
	if (req.auth?.features?.multi_outlet === false) { res.status(403).json({ error: "Your plan does not include multiple outlets.", feature: "multi_outlet" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (!name) { res.status(400).json({ error: "Outlet name is required" }); return; }
	// Enforce the subscribed plan's outlet limit, when it defines one (fail-open).
	const outletLimit = Number(req.auth?.limits?.outlets ?? 0);
	if (outletLimit > 0) {
		try {
			const existing = await GetOutlets(restaurantId);
			if ((existing?.length ?? 0) >= outletLimit) {
				res.status(403).json({ error: `Your plan allows up to ${outletLimit} outlet(s). Upgrade to add more.` });
				return;
			}
		} catch (e) { logger.warn({ err: e }, "outlet_limit_check_failed"); }
	}
	try {
		const created = await AddOutlet(restaurantId, {
			name,
			address: typeof body.address === "string" ? body.address : undefined,
			phone: typeof body.phone === "string" ? body.phone : undefined,
			hours: typeof body.hours === "string" ? body.hours : undefined,
		});
		try { await log_audit(req, OUTLET_ADMIN_PERM, `Added outlet ${name}`, Audit_log_category.Bill, { id: created.id }); } catch {/* ignore */}
		res.json(created);
	} catch (e: any) { logger.error({ err: e }, "add_outlet_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to add outlet") }); }
});

app.put("/outlets/:id", validateAction(OUTLET_ADMIN_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!id) { res.status(400).json({ error: "Missing id" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;
	try {
		await UpdateOutlet(restaurantId, id, {
			name: typeof body.name === "string" ? body.name : undefined,
			address: typeof body.address === "string" ? body.address : undefined,
			phone: typeof body.phone === "string" ? body.phone : undefined,
			hours: typeof body.hours === "string" ? body.hours : undefined,
		});
		res.json({ success: true });
	} catch (e: any) { logger.error({ err: e }, "update_outlet_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to update outlet") }); }
});

app.post("/outlets/:id/active", validateAction(OUTLET_ADMIN_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	const active = ((req.body ?? {}) as Record<string, unknown>).active !== false;
	try { await SetOutletActive(restaurantId, id, active); res.json({ success: true }); }
	catch (e: any) { logger.error({ err: e }, "set_outlet_active_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to update outlet") }); }
});

app.delete("/outlets/:id", validateAction(OUTLET_ADMIN_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	try {
		await DeleteOutlet(restaurantId, id);
		try { await log_audit(req, OUTLET_ADMIN_PERM, `Deleted outlet ${id}`, Audit_log_category.Bill, { id }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (e: any) { logger.error({ err: e }, "delete_outlet_failed"); res.status(400).json({ error: String(e?.message ?? "Unable to delete outlet") }); }
});

app.get('/outlets/default-tax', validateAction("d9b3f882-d3cf-46bc-b9ce-4218e8a5c29d"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: 'Missing restaurantId' });
		return;
	}

	try {
		const tax = await GetOutletDefaultTax(restaurantId);
		res.json({ default_tax: tax ?? {} });
	} catch (err) {
		logger.error({ err }, 'get_default_tax_failed');
		res.status(500).json({ error: 'Unable to fetch default tax' });
	}
});

app.patch('/outlets/default-tax', validateAction("28fa21cc-0dba-4a0f-bf6f-387089f47bbf"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: 'Missing restaurantId' });
		return;
	}

	const body = req.body ?? {};
	const defaultTax = body.default_tax;
	if (!defaultTax || typeof defaultTax !== 'object') {
		res.status(400).json({ error: 'default_tax object is required' });
		return;
	}

	try {
		await UpdateOutletDefaultTax(restaurantId, defaultTax);
		res.json({ ok: true });
	} catch (err) {
		logger.error({ err }, 'update_default_tax_failed');
		res.status(500).json({ error: 'Unable to update default tax' });
	}
});

app.get("/roles", validateAction("17ba6407-b703-4403-ab59-13235966053f"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	try {
		const roles = await GetRoles(restaurantId);
		res.json(roles);
	} catch (error) {
		logger.error({ err: error }, "get_roles_failed");
		res.status(500).json({ error: "Unable to fetch roles" });
	}
});

app.get("/actions", validateAction("2b6f7948-0b27-41a9-9727-c04ccc9f4db1"), async (req: Request, res: Response) => {

	try {
		const actions = await GetActions();
		res.json(actions);
	} catch (err) {
		logger.error({ err }, 'get_actions_failed');
		res.status(500).json({ error: 'Unable to fetch actions' });
	}
});

app.post("/roles", validateAction("c0135d18-68b4-45e9-9b51-849158df6efd"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const roleName = typeof req.body?.role_name === "string" ? req.body.role_name : "";
	const actions = Array.isArray(req.body?.actions_performable)
		? req.body.actions_performable.map((entry: unknown) => String(entry))
		: [];

	try {
		// CreateRole upserts by name — capture the prior permission set so an EDIT
		// of an existing role is undoable (a brand-new role has no prior state).
		const priorRole = (await GetRoles(restaurantId).catch(() => []))
			.find((r) => r.role_name.toLowerCase() === roleName.trim().toLowerCase()) ?? null;
		const role = await CreateRole(restaurantId, roleName, actions);
		// Editing an existing role rewrites what its holders may do, but every live
		// session still carries the action list resolved at ITS login — revoke the
		// holders' sessions so the new list actually applies. A brand-new role has
		// no holders, so nothing to revoke.
		if (priorRole) {
			const holders = await GetEmployeeIdsWithRole(restaurantId, [role.id, role.role_name]).catch(() => [] as string[]);
			for (const holder of holders) {
				await revokeEmployeeSessions(holder, "role_permissions_changed");
			}
		}
		try {
			await log_audit(req, "c0135d18-68b4-45e9-9b51-849158df6efd", priorRole ? `Updated permissions of role '${role.role_name}'` : `Created role '${role.role_name}'`, Audit_log_category.Roles, {
				role_id: role.id,
				role_name: role.role_name,
				...(priorRole
					? { undo: { kind: "role_permissions", target_id: role.id, before: { actions_performable: priorRole.actions_performable }, after: { actions_performable: role.actions_performable } } }
					: {}),
			});
		} catch (err) { logger.warn({ err }, "log_audit create-role failed"); }
		res.status(201).json(role);
	} catch (error: any) {
		logger.error({ err: error }, "create_role_failed");
		if (error && error.name === 'ValidationError') {
			// structured response for invalid action ids
			return res.status(400).json({ error: String(error.message), invalidActionIds: error.invalidActionIds ?? [] });
		}
		res.status(400).json({ error: String(error?.message ?? "Unable to create role") });
	}
});

app.delete("/roles/:id", validateAction("53d0927d-00f4-48cc-a40c-51edb09826d8"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const roleId = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!roleId) {
		res.status(400).json({ error: "Invalid role id" });
		return;
	}

	try {
		// Capture the holders before the role disappears — their sessions carry the
		// permissions this role granted and must be revoked with it.
		const holders = await GetEmployeeIdsWithRole(restaurantId, [roleId]).catch(() => [] as string[]);
		const removed = await DeleteRole(restaurantId, roleId);
		if (!removed) {
			res.status(404).json({ error: "Role not found" });
			return;
		}
		for (const holder of holders) {
			await revokeEmployeeSessions(holder, "role_deleted");
		}
		res.status(204).send();
	} catch (error) {
		logger.error({ err: error }, "delete_role_failed");
		res.status(500).json({ error: "Unable to delete role" });
	}
});

app.post("/roles/assign", validateAction("4bf54bd9-9124-46c0-a7cc-011ea4c4e172"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const employeeId = typeof req.body?.employeeId === "string" ? req.body.employeeId.trim() : "";
	const roleName = typeof req.body?.role_name === "string" ? req.body.role_name.trim() : "";
	if (!employeeId || !roleName) {
		res.status(400).json({ error: "employeeId and role_name are required" });
		return;
	}
	// Privilege-escalation guard: the core "admin"/"manager" roles expand to ["*"]
	// (all permissions). Only a REAL admin may grant them — otherwise the mere
	// assign-role permission on a custom role could bootstrap an employee to full admin.
	if (isPrivilegedRoleName(roleName) && !callerIsAdmin(req)) {
		res.status(403).json({ error: "Only an admin can assign the admin or manager role." });
		return;
	}
	// The admin role itself is owner-only: an admin cannot mint more admins.
	if (isAdminRoleName(roleName) && !(await callerIsSuperadmin(req))) {
		res.status(403).json({ error: "Only the owner (super-admin) can grant the admin role." });
		return;
	}

	try {
		const priorRoles = await readEmployeeRolesForUndo(restaurantId, employeeId).catch(() => null);
		await AssignRoleToEmployee(restaurantId, employeeId, roleName);
		// Permissions are cached on the session at login, so the new role only
		// takes effect once the holder re-authenticates.
		await revokeEmployeeSessions(employeeId, "role_assigned");
		const nextRoles = priorRoles ? await readEmployeeRolesForUndo(restaurantId, employeeId).catch(() => null) : null;
		try {
			await log_audit(req, "4bf54bd9-9124-46c0-a7cc-011ea4c4e172", `Assigned role '${roleName}' to employee ${employeeId}`, Audit_log_category.Roles, {
				employee_id: employeeId, role: roleName,
				...(priorRoles && nextRoles
					// `primary` is captured so the undo restores the recorded primary
					// role verbatim instead of recomputing one from the role list.
					? { undo: { kind: "role_assign", target_id: employeeId, before: { roles: priorRoles.roles, primary: priorRoles.primary }, after: { roles: nextRoles.roles, primary: nextRoles.primary } } }
					: {}),
			});
		} catch (err) { logger.warn({ err }, "log_audit assign-role failed"); }
		res.json({ success: true });
	} catch (error: any) {
		logger.error({ err: error }, "assign_role_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to assign role") });
	}
});

app.post("/roles/remove", validateAction("9acc9097-4803-4be0-bb6d-fc2c5de57cf5"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const employeeId = typeof req.body?.employeeId === "string" ? req.body.employeeId.trim() : "";
	const roleName = typeof req.body?.role_name === "string" ? req.body.role_name.trim() : "";
	if (!employeeId || !roleName) {
		res.status(400).json({ error: "employeeId and role_name are required" });
		return;
	}
	// Only a real admin may add/remove the privileged admin/manager roles.
	if (isPrivilegedRoleName(roleName) && !callerIsAdmin(req)) {
		res.status(403).json({ error: "Only an admin can change the admin or manager role." });
		return;
	}
	// Demoting an admin is owner-only too (and the owner themself can never be
	// demoted — RemoveRoleFromEmployee already refuses the superadmin).
	if (isAdminRoleName(roleName) && !(await callerIsSuperadmin(req))) {
		res.status(403).json({ error: "Only the owner (super-admin) can remove the admin role." });
		return;
	}

	try {
		const priorRoles = await readEmployeeRolesForUndo(restaurantId, employeeId).catch(() => null);
		await RemoveRoleFromEmployee(restaurantId, employeeId, roleName);
		// A revoked role must stop working NOW, not at the holder's next logout.
		await revokeEmployeeSessions(employeeId, "role_removed");
		const nextRoles = priorRoles ? await readEmployeeRolesForUndo(restaurantId, employeeId).catch(() => null) : null;
		try {
			await log_audit(req, "9acc9097-4803-4be0-bb6d-fc2c5de57cf5", `Removed role '${roleName}' from employee ${employeeId}`, Audit_log_category.Roles, {
				employee_id: employeeId, role: roleName,
				...(priorRoles && nextRoles
					? { undo: { kind: "role_remove", target_id: employeeId, before: { roles: priorRoles.roles, primary: priorRoles.primary }, after: { roles: nextRoles.roles, primary: nextRoles.primary } } }
					: {}),
			});
		} catch (err) { logger.warn({ err }, "log_audit remove-role failed"); }
		res.json({ success: true });
	} catch (error: any) {
		logger.error({ err: error }, "remove_role_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to remove role") });
	}
});

app.get("/table-assignments", validateAction("f88657ce-0d67-4cd6-aae1-765dec10cd98"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "employee"]);
	if (!auth) {
		return;
	}

	try {
		const assignments = await GetTableAssignments(auth.restaurantId);
		res.json(assignments);
	} catch (error) {
		logger.error({ err: error }, "get_table_assignments_failed");
		res.status(500).json({ error: "Unable to fetch table assignments" });
	}
});

app.post("/table-assignments/assign", validateAction("faf2745b-580c-4529-bbe1-033200cbcf67"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin"]);
	if (!auth) {
		return;
	}

	const tableName = typeof req.body?.table_name === "string" ? req.body.table_name.trim() : "";
	const employeeId = typeof req.body?.employeeId === "string" ? req.body.employeeId.trim() : "";
	if (!tableName || !employeeId) {
		res.status(400).json({ error: "table_name and employeeId are required" });
		return;
	}

	try {
		const assigned = await AssignTableToEmployee(auth.restaurantId, tableName, employeeId);
		res.json(assigned);
	} catch (error: any) {
		logger.error({ err: error }, "assign_table_employee_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to assign table") });
	}
});

app.post("/table-assignments/unassign", validateAction("e97a2c5d-d83d-48e3-bdea-ef0c3a1c51a7"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin"]);
	if (!auth) {
		return;
	}

	const tableName = typeof req.body?.table_name === "string" ? req.body.table_name.trim() : "";
	if (!tableName) {
		res.status(400).json({ error: "table_name is required" });
		return;
	}

	try {
		const removed = await UnassignTableEmployee(auth.restaurantId, tableName);
		if (!removed) {
			res.status(404).json({ error: "Table assignment not found" });
			return;
		}
		res.json({ success: true });
	} catch (error: any) {
		logger.error({ err: error }, "unassign_table_employee_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to unassign table") });
	}
});



// Rtamanyu's integration
app.get("/valet-bays", validateAction("9e37297d-408b-446d-a51b-7892ad216b7d"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	try {
		const data = await GetParkingBays(auth.restaurantId, auth.outletId);
		res.json(data);
		return;
	} catch (error) {
		logger.error({ err: error }, "fetch_valet_bays_failed");
		res.status(500).json({ error: "Unable to fetch valet bays" });
		return;
	}
});

app.post("/add-valet-bay", validateAction("ae8ce7c0-1e06-4722-8a06-817267eec785"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const bayName = typeof body?.Bay_name === 'string' ? body.Bay_name.trim() : undefined;
	const totalCapacity = body?.total_capacity === null || body?.total_capacity === undefined ? undefined : Number(body.total_capacity);
	if (!bayName) {
		res.status(400).json({ error: "Missing Bay_name" });
		return;
	}

	try {
		const bay = await AddParkingBay(
			auth.restaurantId,
			bayName,
			Number.isFinite(totalCapacity) ? Number(totalCapacity) : 0,
			auth.outletId,
		);
		const data = {
			message: "Bay added",
			...bay,
		};

		// Broadcast bay added
		try {
			emitRestaurant(auth.restaurantId, "valet:bay_added", data);
		} catch (err) {
			logger.warn({ err }, "emit valet:bay_added failed");
		}
		res.json(data);
		return;
	} catch (error) {
		logger.error({ err: error }, "add_valet_bay_failed");
		res.status(500).json({ error: "Unable to add valet bay" });
		return;
	}
});

app.post("/delete-valet-bay", validateAction("6e9be65f-4081-4b86-8ba0-0592ee26f7f2"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}
	const body = req.body as Record<string, unknown> | undefined;
	const bayId = body?.Bay_id ? String(body.Bay_id) : undefined;
	const bayName = typeof body?.Bay_name === 'string' ? body.Bay_name.trim() : undefined;
	if (!bayId && !bayName) {
		res.status(400).json({ error: "Missing Bay_id or Bay_name" });
		return;
	}

	try {
		const deleted = await DeleteParkingBay(auth.restaurantId, bayId ?? null, bayName ?? null, auth.outletId);
		if (!deleted) {
			res.status(404).json({ error: "Bay not found" });
			return;
		}
		const data = {
			message: "Bay deleted",
			...deleted,
		};

		// Broadcast bay deleted
		try {
			emitRestaurant(auth.restaurantId, "valet:bay_deleted", data);
		} catch (err) {
			logger.warn({ err }, "emit valet:bay_deleted failed");
		}
		res.json(data);
		return;
	} catch (error) {
		logger.error({ err: error }, "delete_valet_bay_failed");
		res.status(500).json({ error: "Unable to delete valet bay" });
		return;
	}
});


app.post("/update-valet-bay", validateAction("2caeab74-5941-424d-9c3a-5c68ef0186e1"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {return;}

	const body = req.body as Record<string, unknown> | undefined;
	const bayId = body?.Bay_id ? String(body.Bay_id) : undefined;
	const bayName = typeof body?.Bay_name === 'string' ? body.Bay_name.trim() : undefined;
	const totalCapacity = body?.total_capacity === null || body?.total_capacity === undefined ? undefined : Number(body.total_capacity);

	if (!bayName) {
		res.status(400).json({ error: "Missing Bay_name" });
		return;
	}

	try {
		const updated = await UpdateParkingBay(
			auth.restaurantId,
			bayId ?? null,
			bayName,
			Number.isFinite(totalCapacity) ? Number(totalCapacity) : 0,
			auth.outletId,
		);
		if (!updated) {
			res.status(404).json({ error: "Bay not found" });
			return;
		}
		const data = {
			message: "Bay updated",
			...updated,
		};

		// Broadcast bay updated
		try {
			emitRestaurant(auth.restaurantId, "valet:bay_updated", data);
		} catch (err) {
			logger.warn({ err }, "emit valet:bay_updated failed");
		}
		res.json(data);
		return;
	} catch (err) {
		logger.error({ err }, "update_valet_bay_failed");
		res.status(500).json({ error: "Unable to update valet bay" });
	}
});


app.post("/set-valet-bay-current", validateAction("2ff51c3d-f18c-406c-9f49-7c54f468c835"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {return;}

	const body = req.body as Record<string, unknown> | undefined;
	const bayId = body?.Bay_id ? String(body.Bay_id) : undefined;
	const current = body?.current_capacity === null || body?.current_capacity === undefined ? undefined : Number(body.current_capacity);

	if (!bayId || current === undefined || Number.isNaN(current)) {
		res.status(400).json({ error: "Missing Bay_id or current_capacity" });
		return;
	}

	try {
		const updated = await SetParkingBayCurrent(auth.restaurantId, bayId, Number(current), auth.outletId);
		if (!updated) {
			res.status(404).json({ error: "Bay not found" });
			return;
		}
		const data = {
			message: "Bay current capacity set",
			...updated,
		};

		// Broadcast bay current capacity update
		try {
			emitRestaurant(auth.restaurantId, "valet:bay_current_set", { Bay_id: body?.Bay_id, current_capacity: Number(current) });
		} catch (err) {
			logger.warn({ err }, "emit valet:bay_current_set failed");
		}
		res.json(data);
		return;
	} catch (err) {
		logger.error({ err }, "set_valet_bay_current_failed");
		res.status(500).json({ error: "Unable to set bay current capacity" });
		return;
	}
});

app.post("/create_valet_record", validateAction("892b50f3-51fc-4099-8f31-01e8dd8c3d44"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const number_plate = typeof body?.number_plate === 'string' ? body.number_plate.trim().toUpperCase() : undefined;
	const customer_name = typeof body?.customer_name === 'string' ? body.customer_name.trim() : undefined;
	const bayIdRaw =
		typeof body?.bay_id === 'string'
			? body.bay_id.trim()
			: typeof body?.Bay_id === 'string'
				? body.Bay_id.trim()
				: undefined;
	const bayNameRaw =
		typeof body?.bay_name === 'string'
			? body.bay_name.trim()
			: typeof body?.Bay_name === 'string'
				? body.Bay_name.trim()
				: undefined;
	const bayIdentifier = bayIdRaw || bayNameRaw;
	const entryTimeRaw =
		typeof body?.booking_date_time === 'string'
			? body.booking_date_time
			: typeof body?.entry_time === 'string'
				? body.entry_time
				: typeof body?.date_time === 'string'
					? body.date_time
					: undefined;

	let entryTime: Date | undefined;
	if (entryTimeRaw) {
		const parsed = new Date(entryTimeRaw);
		if (Number.isNaN(parsed.getTime())) {
			res.status(400).json({ error: "Invalid booking_date_time" });
			return;
		}
		entryTime = parsed;
	}

	if (!number_plate) {
		res.status(400).json({ error: "Missing number plate" });
		return;
	}

	try {
		const created = await CreateValetVehicleState(auth.restaurantId, entryTime, bayIdentifier, auth.outletId);
		const meta = await UpsertValetVehicleMeta(
			auth.restaurantId,
			created.booking_id,
			number_plate,
			customer_name,
			auth.outletId,
		);
		const data = {
			message: "New valet record created successfully.",
			booking_id: created.booking_id,
			entry_time: created.entry_time,
			bay_id: created.bay_id,
			number_plate: meta.number_plate,
			customer_name: meta.customer_name ?? undefined,
		};

		// Broadcast created valet record to connected frontends
		emitRestaurant(auth.restaurantId, "valet:created", data);
		try { await log_audit(req, "892b50f3-51fc-4099-8f31-01e8dd8c3d44", `Valet checked in ${number_plate}`, Audit_log_category.Valet, { booking_id: created.booking_id, bay_id: created.bay_id }); } catch (err) { logger.warn({ err }, "log_audit valet-checkin failed"); }
		res.json(data);
		return;
	} catch (error) {
		logger.error({ err: error }, "create_valet_record_failed");
		res.status(500).json({ error: "Unable to create valet record" });
		return;
	}
});

// Port of the Flutter _extractPlate heuristic (modules.dart) so web scans
// validate plates identically to the on-device Android OCR path: prefer the
// canonical Indian format, else the longest 5-11 char token mixing letters+digits.
function extractPlate(raw: string): string | null {
	const up = raw.toUpperCase();
	const canonical = /[A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{1,3}[\s-]?\d{3,4}/;
	const m = canonical.exec(up);
	if (m) {return m[0].replace(/[\s-]/g, "");}
	let best: string | null = null;
	for (const tok of up.split(/[^A-Z0-9]+/)) {
		if (tok.length < 5 || tok.length > 11) {continue;}
		const hasLetter = /[A-Z]/.test(tok);
		const hasDigit = /\d/.test(tok);
		if (hasLetter && hasDigit && (best === null || tok.length > best.length)) {best = tok;}
	}
	return best;
}

// Web valet plate OCR — mirrors the Flutter app's on-device scan
// (_ValetCheckInDialog._scanPlate). Runs FREE, on-server OCR via tesseract.js
// (no API key, no per-scan cost) so the web valet page offers the same
// "snap a photo -> prefill the plate" flow. The caller always falls back to
// manual entry, so any OCR failure returns { plate: null } with 200, not a 500.
//
// One tesseract worker is created lazily and reused (loading the eng model per
// request would be slow); scans are chained so concurrent calls don't clash on
// the single worker. The eng model + wasm core download once on first use and
// are cached by tesseract.js.
let plateOcrWorkerPromise: Promise<import("tesseract.js").Worker> | null = null;
async function getPlateOcrWorker() {
	if (!plateOcrWorkerPromise) {
		plateOcrWorkerPromise = (async () => {
			const { createWorker, PSM } = await import("tesseract.js");
			const worker = await createWorker("eng");
			// Plates are a single line of A-Z/0-9. SINGLE_LINE page segmentation +
			// a restricted charset markedly improve accuracy vs the default AUTO mode
			// (which mis-segments a plate and drops/garbles characters).
			await worker.setParameters({
				tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -",
				tessedit_pageseg_mode: PSM.SINGLE_LINE,
			});
			return worker;
		})();
		// If init fails, drop the cached promise so the next scan retries fresh.
		plateOcrWorkerPromise.catch(() => { plateOcrWorkerPromise = null; });
	}
	return plateOcrWorkerPromise;
}
let plateOcrChain: Promise<unknown> = Promise.resolve();
function runPlateOcr(buffer: Buffer): Promise<string> {
	const task = plateOcrChain.then(async () => {
		const worker = await getPlateOcrWorker();
		const { data } = await worker.recognize(buffer);
		return data.text ?? "";
	});
	plateOcrChain = task.catch(() => {}); // keep the queue alive past a failed scan
	return task;
}

app.post("/valet/scan-plate", validateAction("892b50f3-51fc-4099-8f31-01e8dd8c3d44"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const imageRaw = typeof body?.image === 'string' ? body.image.trim() : undefined;
	if (!imageRaw) {
		res.status(400).json({ error: "Missing image" });
		return;
	}

	// Accept an optional `data:image/...;base64,` prefix; keep only the payload.
	const base64 = imageRaw.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "").replace(/\s+/g, "");
	if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
		res.status(400).json({ error: "Invalid image data" });
		return;
	}
	// Reject payloads larger than ~6MB (base64 decodes to ~3/4 of its length).
	if (Math.floor((base64.length * 3) / 4) > 6 * 1024 * 1024) {
		res.status(400).json({ error: "Image too large" });
		return;
	}

	try {
		const buffer = Buffer.from(base64, "base64");
		const text = await runPlateOcr(buffer);
		// tesseract often sprinkles stray spaces inside a plate ("KA05 MH 12 34"),
		// which would split it into short tokens. Collapse gaps BETWEEN alphanumerics
		// so the plate stays whole, and try both forms (compacted wins when it yields
		// a longer/canonical match). extractPlate still handles surrounding text.
		const compact = text.replace(/([A-Za-z0-9])[ \t]+([A-Za-z0-9])/g, "$1$2").replace(/([A-Za-z0-9])[ \t]+([A-Za-z0-9])/g, "$1$2");
		const plate = extractPlate(compact) ?? extractPlate(text);
		res.json({ plate: plate ?? null });
		return;
	} catch (error) {
		logger.error({ err: error }, "valet_scan_plate_failed");
		res.json({ plate: null, error: "Plate scanning failed" });
		return;
	}
});

app.post("/get_valet_info", validateAction("9e37297d-408b-446d-a51b-7892ad216b7d"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const booking_id = typeof body?.booking_id === 'string' ? body.booking_id.trim() : undefined;
	if (!booking_id) {
		res.status(400).json({ error: "Missing booking ID" });
		return;
	}

	try {
		const record = await GetValetVehicleState(auth.restaurantId, booking_id, auth.outletId);
		if (!record) {
			res.status(404).json({ error: `No valet found with that booking ID - ${booking_id}.` });
			return;
		}
		const metaByBookingId = await GetValetVehicleMetaByBookingIds(auth.restaurantId, [booking_id], auth.outletId);
		const meta = metaByBookingId[booking_id];
		res.json({
			booking_id: record.booking_id,
			state: record.state,
			entry_time: record.entry_time,
			exit_time: record.exit_time,
			bay_id: record.bay_id,
			number_plate: meta?.number_plate,
			customer_name: meta?.customer_name ?? undefined,
			parking_location: record.parking_location,
			key_holder: record.key_holder,
			key_updated_at: record.key_updated_at,
			condition_notes: record.condition_notes,
			condition_photo_url: record.condition_photo_url,
			eta_minutes: record.eta_minutes,
			requested_at: record.requested_at,
		});
		return;
	} catch (error) {
		logger.error({ err: error }, "fetch_valet_info_failed");
		res.status(500).json({ error: "Unable to fetch valet info" });
		return;
	}
});

async function updateValetStateAndPublish(
	restaurantId: string,
	bookingId: string,
	state: string,
	outletId?: string,
): Promise<Record<string, unknown>> {
	const stateNum = Number(state);
	if (!Number.isFinite(stateNum)) {
		throw Object.assign(new Error("Unable to update valet state"), {
			status: 400,
			payload: { error: "Invalid state" },
		});
	}

	const updated = await UpdateValetVehicleState(restaurantId, bookingId, stateNum, outletId);
	if (!updated) {
		throw Object.assign(new Error("Unable to update valet state"), {
			status: 404,
			payload: { error: `No active valet record found for that booking ID - ${bookingId}.` },
		});
	}

	const payload: Record<string, unknown> = {
		message: "Valet state updated successfully.",
		booking_id: updated.booking_id,
	};

	// Centralized publisher path for valet state updates.
	emitRestaurant(restaurantId, "valet:updated", { booking_id: bookingId, state, detail: payload });
	return payload;
}


app.post("/update_valet_state", validateAction("b8e02c25-b91c-427c-b462-8df009ede055"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const booking_id = typeof body?.booking_id === 'string' ? body.booking_id.trim() : undefined;
	const state = body?.state === null || body?.state === undefined ? undefined : String(body.state).trim();
	if (!booking_id || !state) {
		res.status(400).json({ error: "Missing booking ID or state" });
		return;
	}

	try {
		const data = await updateValetStateAndPublish(auth.restaurantId, booking_id, state, auth.outletId);
		try { await log_audit(req, "b8e02c25-b91c-427c-b462-8df009ede055", `Valet state -> ${state} for ${booking_id}`, Audit_log_category.Valet, { booking_id, state }); } catch (err) { logger.warn({ err }, "log_audit valet-state failed"); }
		res.json(data);
		return;
	} catch (error) {
		logger.error({ err: error }, "update_valet_state_failed");
		const status = typeof (error as { status?: unknown })?.status === "number"
			? ((error as { status: number }).status)
			: 500;
		const payload = (error as { payload?: unknown })?.payload;
		if (status !== 500 && payload && typeof payload === "object") {
			res.status(status).json(payload);
			return;
		}
		res.status(500).json({ error: "Unable to update valet state" });
		return;
	}
});

app.post("/update_valet_bay", validateAction("b8e02c25-b91c-427c-b462-8df009ede055"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const booking_id = typeof body?.booking_id === 'string' ? body.booking_id.trim() : undefined;
	// Accept bay_id in body; fall back to bay_name for backward compatibility
	const bay_id_raw = body?.bay_id ?? body?.bay_name;
	const bay_id = bay_id_raw === null || bay_id_raw === undefined ? undefined : String(bay_id_raw).trim();
	if (!booking_id || !bay_id) {
		res.status(400).json({ error: "Missing booking ID or bay id" });
		return;
	}

	try {
		const updated = await UpdateValetVehicleBay(auth.restaurantId, booking_id, bay_id, auth.outletId);
		if (!updated) {
			res.status(404).json({ error: `No active valet record found for that booking ID - ${booking_id}.` });
			return;
		}
		const data = {
			message: "Valet bay updated successfully.",
			booking_id: updated.booking_id,
			bay_id: updated.bay_id,
		};
		res.json(data);
		return;
	} catch (error) {
		logger.error({ err: error }, "update_valet_bay_failed");
		res.status(500).json({ error: String((error as Error)?.message ?? "Unable to update valet bay") });
		return;
	}
});

app.post("/unassign-valet-bay", validateAction("5ef876a7-eb92-4602-b4d3-5590ce379540"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {return;}

	const body = req.body as Record<string, unknown> | undefined;
	const booking_id = typeof body?.booking_id === 'string' ? body.booking_id.trim() : undefined;
	if (!booking_id) {
		res.status(400).json({ error: "Missing booking ID" });
		return;
	}

	try {
		const updated = await UpdateValetVehicleBay(auth.restaurantId, booking_id, null, auth.outletId);
		if (!updated) {
			res.status(404).json({ error: `No active valet record found for that booking ID - ${booking_id}.` });
			return;
		}
		const data = {
			message: "Valet bay updated successfully.",
			booking_id: updated.booking_id,
			bay_id: updated.bay_id,
		};
		res.json(data);
		return;
	} catch (error) {
		logger.error({ err: error }, "unassign_valet_bay_failed");
		res.status(500).json({ error: "Unable to unassign valet bay" });
		return;
	}
});

// --- Valet ops depth (Wave D) ------------------------------------------------
// Audit actions seeded by ensureValetOpsColumns (database_supabase.ts).
const VALET_ACTION_KEY_LOG = "4a7d1c9e-5b3f-4e8a-a6d2-0c9f7b3e5a18";
const VALET_ACTION_OPS_UPDATE = "8e4b2d6f-3a1c-4f7e-9b05-d2c6a8e0f413";
const VALET_ACTION_CHARGE = "6c2e8a4d-7f1b-4d9c-8e35-b0a4d6c2f791";

// Best-effort number plate lookup for honest audit/notification copy.
async function valetPlateFor(restaurantId: string, bookingId: string, outletId?: string): Promise<string> {
	try {
		const meta = await GetValetVehicleMetaByBookingIds(restaurantId, [bookingId], outletId);
		return meta[bookingId]?.number_plate ?? bookingId.slice(-6).toUpperCase();
	} catch {
		return bookingId.slice(-6).toUpperCase();
	}
}

// Occupied tables a valet fee can be charged to (the valet role cannot call
// /get-tables, so the picker gets its own read under the valet-info action).
app.get("/valet/charge-targets", validateAction("9e37297d-408b-446d-a51b-7892ad216b7d"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {return;}
	try {
		const tables = await GetTables(auth.restaurantId);
		const targets = (tables ?? [])
			.filter((t) => t.occupied === true)
			.map((t) => ({ table_name: t.table_name, covers: t.covers ?? null }));
		res.json({ tables: targets });
	} catch (error) {
		logger.error({ err: error }, "valet_charge_targets_failed");
		res.status(500).json({ error: "Unable to fetch occupied tables" });
	}
});

// Parking location / condition notes (+ optional photo) / retrieval ETA.
app.post("/valet/:bookingId/ops", validateAction(PERM_VALET_OPS), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {return;}
	const bookingId = typeof req.params.bookingId === "string" ? req.params.bookingId.trim() : "";
	if (!bookingId) { res.status(400).json({ error: "Missing booking ID" }); return; }
	const body = (req.body ?? {}) as Record<string, unknown>;

	const patch: import("./database_supabase.js").ValetOpsPatch = {};
	if ("parking_location" in body) {patch.parking_location = typeof body.parking_location === "string" ? body.parking_location.slice(0, 120) : null;}
	if ("condition_notes" in body) {patch.condition_notes = typeof body.condition_notes === "string" ? body.condition_notes.slice(0, 1000) : null;}
	if ("eta_minutes" in body) {
		const eta = Number(body.eta_minutes);
		patch.eta_minutes = Number.isFinite(eta) && eta > 0 ? Math.min(240, Math.round(eta)) : null;
	}
	// Optional condition photo — reuses the menu-image storage helper.
	if (typeof body.condition_photo_base64 === "string" && body.condition_photo_base64.trim()) {
		try {
			const url = await uploadMenuImage(
				body.condition_photo_base64,
				typeof body.condition_photo_content_type === "string" ? body.condition_photo_content_type : "image/jpeg",
			);
			if (url) {patch.condition_photo_url = url;}
		} catch (err) {
			logger.warn({ err }, "valet condition photo upload failed");
		}
	} else if ("condition_photo_url" in body) {
		patch.condition_photo_url = typeof body.condition_photo_url === "string" ? body.condition_photo_url.slice(0, 500) : null;
	}

	if (Object.keys(patch).length === 0) {
		res.status(400).json({ error: "Nothing to update — send parking_location, condition_notes, eta_minutes or a condition photo" });
		return;
	}

	try {
		const updated = await UpdateValetVehicleOps(auth.restaurantId, bookingId, patch, auth.outletId);
		if (!updated) {
			res.status(404).json({ error: `No valet record found for that booking ID - ${bookingId}.` });
			return;
		}
		const plate = await valetPlateFor(auth.restaurantId, bookingId, auth.outletId);
		const changed = Object.keys(patch).join(", ");
		try {
			await log_audit(req, VALET_ACTION_OPS_UPDATE, `Valet ops (${changed}) updated for ${plate}`, Audit_log_category.Valet, { booking_id: bookingId, ...patch });
		} catch (err) { logger.warn({ err }, "log_audit valet-ops failed"); }
		try { emitRestaurant(auth.restaurantId, "valet:updated", { booking_id: bookingId, ops: patch }); } catch (err) { logger.warn({ err }, "emit valet:updated failed"); }
		res.json({ success: true, record: updated });
	} catch (error) {
		logger.error({ err: error }, "update_valet_ops_failed");
		res.status(500).json({ error: "Unable to update valet record" });
	}
});

// Digital key log: "take" puts the keys in the logged-in attendant's hands,
// "handover" records them leaving (returned to guest / hung on the board).
app.post("/valet/:bookingId/keys", validateAction(PERM_VALET_KEYS), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {return;}
	const bookingId = typeof req.params.bookingId === "string" ? req.params.bookingId.trim() : "";
	const action = String((req.body as Record<string, unknown> | undefined)?.action ?? "").trim().toLowerCase();
	if (!bookingId) { res.status(400).json({ error: "Missing booking ID" }); return; }
	if (action !== "take" && action !== "handover") {
		res.status(400).json({ error: "action must be 'take' or 'handover'" });
		return;
	}

	try {
		let holder: string | null = null;
		if (action === "take") {
			const employeeId = extractEmployeeId(req);
			const emp = employeeId ? await GetEmployeeDetailsFromEmpID(employeeId).catch(() => null) : null;
			// Ignore placeholder name parts ("-") so the log reads "Admin", not "Admin -".
			const fullName = [emp?.emp_Fname, emp?.emp_Lname]
				.map((s) => String(s ?? "").trim())
				.filter((s) => s && s !== "-")
				.join(" ");
			holder = fullName || emp?.employee_Username || "attendant";
		}
		const updated = await UpdateValetVehicleOps(auth.restaurantId, bookingId, { key_holder: holder }, auth.outletId);
		if (!updated) {
			res.status(404).json({ error: `No valet record found for that booking ID - ${bookingId}.` });
			return;
		}
		const plate = await valetPlateFor(auth.restaurantId, bookingId, auth.outletId);
		try {
			await log_audit(
				req,
				VALET_ACTION_KEY_LOG,
				action === "take" ? `${holder} took keys for ${plate}` : `Keys for ${plate} handed over`,
				Audit_log_category.Valet,
				{ booking_id: bookingId, action, key_holder: holder },
			);
		} catch (err) { logger.warn({ err }, "log_audit valet-keys failed"); }
		try { emitRestaurant(auth.restaurantId, "valet:updated", { booking_id: bookingId, key_holder: holder }); } catch (err) { logger.warn({ err }, "emit valet:updated failed"); }
		res.json({ success: true, key_holder: updated.key_holder, key_updated_at: updated.key_updated_at });
	} catch (error) {
		logger.error({ err: error }, "update_valet_keys_failed");
		res.status(500).json({ error: "Unable to update key log" });
	}
});

// Valet fee → the table's POS bill (folio integration). The fee is posted as a
// normal ORDER line item ("Valet parking") on the table, so it flows through the
// existing one-bill-per-table math (subtotal → discount → service charge → tax)
// with zero special-casing; AddOrder rejects unoccupied tables, which is exactly
// the "no open session" guard.
app.post("/valet/:bookingId/charge", validateAction(PERM_VALET_CHARGE), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {return;}
	const bookingId = typeof req.params.bookingId === "string" ? req.params.bookingId.trim() : "";
	const body = (req.body ?? {}) as Record<string, unknown>;
	const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
	const amount = Math.round((Number(body.amount) || 0) * 100) / 100;
	if (!bookingId) { res.status(400).json({ error: "Missing booking ID" }); return; }
	if (!tableName) { res.status(400).json({ error: "table_name is required" }); return; }
	if (!(amount > 0)) { res.status(400).json({ error: "amount must be a positive number" }); return; }

	try {
		const record = await GetValetVehicleState(auth.restaurantId, bookingId, auth.outletId);
		if (!record) {
			res.status(404).json({ error: `No valet record found for that booking ID - ${bookingId}.` });
			return;
		}
		const plate = await valetPlateFor(auth.restaurantId, bookingId, auth.outletId);

		const employeeId = extractEmployeeId(req);
		const emp = employeeId ? await GetEmployeeDetailsFromEmpID(employeeId).catch(() => null) : null;

		let orderId: string;
		try {
			const result = await AddOrder(auth.restaurantId, {
				table: tableName,
				customer: "Guest",
				// Served: the fee must never appear as a pending kitchen ticket.
				status: "Served",
				items: [{
					id: randomUUID(),
					name: "Valet parking",
					quantity: 1,
					price: amount,
					orderedAt: new Date().toISOString(),
					note: `Vehicle ${plate}`,
				}],
				subtotal: amount,
				total: amount,
				taxes: [],
				applyServiceCharge: false,
				note: `Valet parking fee — vehicle ${plate}`,
				taken_by_employee_id: employeeId ?? null,
				taken_by_employee_name: emp?.employee_Username ?? null,
				taken_by_employee_role: "valet",
			} as any);
			orderId = result.id;
		} catch (error: any) {
			// AddOrder's guards ("Table not found", "Cannot add order to unoccupied
			// table…") are clean client errors, not server faults.
			res.status(400).json({ error: String(error?.message ?? "Unable to post valet fee") });
			return;
		}

		try {
			await log_audit(req, VALET_ACTION_CHARGE, `Valet fee ${amount} charged to ${tableName} for ${plate}`, Audit_log_category.Valet, { booking_id: bookingId, table_name: tableName, amount, order_id: orderId });
		} catch (err) { logger.warn({ err }, "log_audit valet-charge failed"); }
		try {
			await AddNotification(auth.restaurantId, {
				type: "valet",
				title: `Valet fee added to ${tableName}`,
				body: `Valet parking (${plate}) — ${amount} on the table's bill`,
				meta: { booking_id: bookingId, table_name: tableName, amount, order_id: orderId },
			});
		} catch (err) { logger.warn({ err }, "valet charge notification failed"); }
		try { emitRestaurant(auth.restaurantId, "order:updated", { order_id: orderId, table: tableName }); } catch (err) { logger.warn({ err }, "emit order:updated failed"); }

		res.status(201).json({ success: true, order_id: orderId, table_name: tableName, amount });
	} catch (error) {
		logger.error({ err: error }, "valet_charge_failed");
		res.status(500).json({ error: "Unable to charge valet fee" });
	}
});

app.post("/get_main_feedback_question", validate, async (req: Request, res: Response) => {
	const restaurantId = feedbackRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const category = typeof body?.category === 'number' ? body.category : undefined;
	if (!category) {
		res.status(400).json({ error: "Missing category" });
		return;
	}
	if (category < 1 || category > 7) {
		res.status(400).json({ error: "Invalid category" });
		return;
	}
	try {
		const response = await fetchWithTimeout(
			`${PY_SERVER_URL}/get_main_feedback_question/${encodeURIComponent(category)}`,
		);
		const data = await response.json();
		if (!response.ok) {
			res.status(response.status).json(data);
			return;
		}
		res.json(data);
		return;
	} catch (error) {
		// The Python AI-question service is OPTIONAL. When it's unreachable
		// (not running / ECONNREFUSED / timeout) the feedback form must still
		// work — fall back to a plain category-label question instead of 500.
		logger.warn({ err: error }, "get_main_feedback_question_fallback: py service unreachable, using category label");
		res.json({ feedback: `How was the ${getFeedbackCategoryLabel(category).toLowerCase()}?` });
		return;
	}
});

app.post("/get_follow_up_question", validate, async (req: Request, res: Response) => {
	const restaurantId = feedbackRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const category = typeof body?.category === 'number' ? body.category : undefined;
	const rate = body?.rate === null || body?.rate === undefined ? undefined : Number(body.rate);
	if (!category || !rate) {
		res.status(400).json({ error: "Missing category or rate" });
		return;
	}
	if (category < 1 || category > 7) {
		res.status(400).json({ error: "Invalid category" });
		return;
	}
	if (rate < 1 || rate > 5) {
		res.status(400).json({ error: "Invalid rate" });
		return;
	}

	try {
		const response = await fetchWithTimeout(
			`${PY_SERVER_URL}/get_follow_up_question/${encodeURIComponent(category)}/${encodeURIComponent(rate)}`,
		);
		const payload = await response.json();
		const data = (payload ?? {}) as Record<string, unknown>;
		if (!response.ok) {
			res.status(response.status).json(data);
			return;
		}
		const categoryLabel = getFeedbackCategoryLabel(category);
		const rawFeedback = typeof data.feedback === "string" ? data.feedback : "";
		const normalizedFeedback = normalizeFollowUpPromptForCategory(rawFeedback, categoryLabel, rate);
		res.json({ ...data, feedback: normalizedFeedback });
		return;
	} catch (error) {
		// Optional Python service unreachable — build a follow-up prompt from
		// the category label + rating (same helper the success path uses) so
		// the guest can still add detail instead of hitting a 500.
		logger.warn({ err: error }, "get_follow_up_question_fallback: py service unreachable, using category label");
		res.json({ feedback: normalizeFollowUpPromptForCategory("", getFeedbackCategoryLabel(category), rate) });
		return;
	}
});

app.post("/feedback/dynamic-follow-up", validate, async (req: Request, res: Response) => {
	const restaurantId = feedbackRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const categoryLabel = typeof body?.category_label === "string" ? body.category_label.trim() : "";
	const rating = Number(body?.rating);
	const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
	const mainQuestion = typeof body?.main_question === "string" ? body.main_question.trim() : "";
	const firstFollowUpQuestion =
		typeof body?.first_follow_up_question === "string" ? body.first_follow_up_question.trim() : "";

	if (!categoryLabel || !Number.isFinite(rating) || !reason) {
		res.status(400).json({ error: "category_label, rating, and reason are required" });
		return;
	}

	if (reason.length < 8) {
		res.status(400).json({ error: "reason is too short" });
		return;
	}

	try {
		const proxyResponse = await fetchWithTimeout(
			`${PY_SERVER_URL}/get_follow_up_question/${encodeURIComponent(categoryLabel)}/${encodeURIComponent(rating)}`,
		);

		const proxyData = (await proxyResponse.json()) as Record<string, unknown>;
		if (!proxyResponse.ok) {
			res.status(proxyResponse.status).json(proxyData);
			return;
		}

		const aiPrompt = typeof proxyData.feedback === "string" ? proxyData.feedback.trim() : "";
		const normalizedAiPrompt = normalizeFollowUpPromptForCategory(aiPrompt, categoryLabel.toLowerCase(), rating);
		const contextualFallback =
			mainQuestion && firstFollowUpQuestion
				? `Thanks for sharing. Based on your feedback about ${categoryLabel}, what one change should we prioritize?`
				: `Thanks for sharing. What one change should we prioritize for ${categoryLabel}?`;
		const followUpPrompt = normalizedAiPrompt.length > 0 ? normalizedAiPrompt : contextualFallback;
		res.json({ follow_up_prompt: followUpPrompt });
	} catch (error) {
		logger.error({ err: error }, "feedback_dynamic_follow_up_failed");
		res.status(500).json({ error: "Unable to generate dynamic follow-up" });
	}
});

app.post("/feedback/valet-checkin", rateLimit("valet_checkin", 10, 60_000), validate, async (req: Request, res: Response) => {
	const ridInput = feedbackRestaurantId(req);
	if (!ridInput) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}
	// Resolve+validate the tenant from its public slug (like the sibling /feedback
	// and /qr routes) and use the resolved res_id — never trust the raw client id to
	// address another tenant's valet records. The authenticated valet flow also keys
	// on res_id, so this is consistent as well as safe.
	const restaurantId = await getRestaurantIdFromUsername(ridInput).catch(() => null);
	if (!restaurantId) {
		res.status(404).json({ error: "Restaurant not found" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const numberPlate = typeof body?.number_plate === "string" ? body.number_plate.trim() : "";
	if (!numberPlate) {
		res.status(400).json({ error: "number_plate is required" });
		return;
	}
	const customerName = typeof body?.customer_name === "string" ? body.customer_name.trim() : "";
	const normalizedPlate = numberPlate.replace(/\s+/g, "").toUpperCase();
	const outletId = feedbackOutletId(req) || undefined;

	// Advance a valet record to state 3 (customer requested car) and broadcast it
	// to the live valet board.
	const requestRetrieval = (bookingId: string) =>
		updateValetStateAndPublish(restaurantId, bookingId, "3", outletId);

	try {
		// Read the tenant's valet records. Prefer the optional Python service (keeps
		// the existing read path), but fall back to the TS DB layer so matching still
		// works when Python is down — the guest's "bring my car" must not depend on it.
		interface ValetLite { booking_id: string; number_plate: string; state: number }
		let records: ValetLite[] = [];
		let readOk = false;
		try {
			const recordsResponse = await fetchWithTimeout(
				`${PY_SERVER_URL}/get_all_valet_records/${encodeURIComponent(restaurantId)}`,
				{ headers: outletId ? { "X-Outlet-Id": outletId } : undefined },
			);
			if (recordsResponse.ok) {
				const recordsPayload = (await recordsResponse.json().catch(() => null)) as
					| Record<string, unknown>
					| Record<string, unknown>[]
					| null;
				const raw = Array.isArray(recordsPayload)
					? recordsPayload
					: Array.isArray((recordsPayload)?.records)
						? (((recordsPayload).records as unknown[]) as Record<string, unknown>[])
						: [];
				records = raw.map((r) => ({
					booking_id:
						typeof r.booking_id === "string"
							? r.booking_id
							: typeof (r).bookingId === "string"
								? ((r).bookingId)
								: "",
					number_plate: typeof r.number_plate === "string" ? r.number_plate : "",
					state: Number(r.state),
				}));
				readOk = true;
			} else {
				logger.warn({ status: recordsResponse.status }, "feedback_valet_checkin: py valet read non-ok, falling back to db");
			}
		} catch (err) {
			logger.warn({ err }, "feedback_valet_checkin: py valet read failed, falling back to db");
		}

		if (!readOk) {
			const states = await GetValetVehicleStates(restaurantId, outletId);
			const metaByBookingId = await GetValetVehicleMetaByBookingIds(
				restaurantId,
				states.map((s) => s.booking_id),
				outletId,
			);
			records = states.map((s) => ({
				booking_id: s.booking_id,
				number_plate: metaByBookingId[s.booking_id]?.number_plate ?? "",
				state: s.state,
			}));
		}

		const matching = records.filter((record) => {
			const bookingId = typeof record.booking_id === "string" ? record.booking_id.trim() : "";
			return bookingId.length > 0 && record.number_plate.replace(/\s+/g, "").toUpperCase() === normalizedPlate;
		});

		// A record that's added (1) or parked (2) but not yet requested can be advanced
		// straight to a retrieval request. Prefer a parked car when both exist.
		const advanceable = matching
			.filter((record) => record.state === 1 || record.state === 2)
			.sort((a, b) => b.state - a.state);
		// A retrieval already underway: requested (3), accepted (4), or arrived (5).
		const inProgress = matching.filter((record) => record.state >= 3 && record.state <= 5).sort((a, b) => b.state - a.state);

		if (advanceable.length > 0) {
			const candidate = advanceable[0]!;
			await requestRetrieval(candidate.booking_id.trim());
			res.json({ success: true, action: "updated_to_3", current_state: 3, created: false, booking_id: candidate.booking_id.trim() });
			return;
		}

		if (inProgress.length > 0) {
			const candidate = inProgress[0]!;
			res.json({ success: true, action: "already_requested", current_state: candidate.state, created: false, booking_id: candidate.booking_id.trim() });
			return;
		}

		// No active/in-progress record for this plate (the vehicle was never formally
		// parked, or the only match is a completed past visit). Create one via the TS
		// DB layer — works without Python — then advance it straight to a retrieval
		// request so it lands on the valet board as "customer requested car".
		const created = await CreateValetVehicleState(restaurantId, undefined, undefined, outletId);
		const meta = await UpsertValetVehicleMeta(
			restaurantId,
			created.booking_id,
			normalizedPlate,
			customerName || null,
			outletId,
		);
		// Broadcast the new row (mirrors POST /create_valet_record); the state->3
		// transition below then emits valet:updated so live boards show it as a request.
		emitRestaurant(restaurantId, "valet:created", {
			message: "New valet record created successfully.",
			booking_id: created.booking_id,
			entry_time: created.entry_time,
			bay_id: created.bay_id,
			number_plate: meta.number_plate,
			customer_name: meta.customer_name ?? undefined,
		});
		await requestRetrieval(created.booking_id);
		res.json({ success: true, action: "created", current_state: 3, created: true, booking_id: created.booking_id });
		return;
	} catch (error) {
		// Best-effort: the guest feedback flow must never 500. Log and return a soft
		// failure so the form continues (the feedback submit itself is unaffected).
		logger.error({ err: error }, "feedback_valet_checkin_failed");
		res.json({ success: false, action: "error", current_state: null, created: false });
		return;
	}
});

app.post("/feedback/submit", rateLimit("feedback", 20, 60_000), async (req: Request, res: Response) => {
	// Public (customer) endpoint — no session. The restaurant/outlet/employee come
	// from the feedback link via headers (or body), then the write runs inside the
	// tenant context so RLS isolates it.
	const ridInput = feedbackRestaurantId(req);
	// employeeId (the waiter) is OPTIONAL: a table with no resolvable waiter (e.g.
	// QR-self-order only) still submits feedback, just unattributed (emp_id NULL).
	const employeeId = feedbackEmployeeId(req) ?? "";
	if (!ridInput) { res.status(400).json({ error: "Missing restaurantId" }); return; }

	let resolvedId: string | null = null;
	try { resolvedId = await getRestaurantIdFromUsername(ridInput); } catch { resolvedId = null; }
	if (!resolvedId) { res.status(404).json({ error: "Restaurant not found" }); return; }
	const rid: string = resolvedId;
	const outletId = feedbackOutletId(req);

	const body = req.body as Record<string, unknown> | undefined;
	const categoryRatingsRaw = body?.category_ratings;
	if (!Array.isArray(categoryRatingsRaw) || categoryRatingsRaw.length === 0) {
		res.status(400).json({ error: "category_ratings must be a non-empty array" });
		return;
	}

	const category_ratings = categoryRatingsRaw
		.slice(0, 25) // cap categories (anti-DoS); a real feedback form has a handful
		.map((item) => {
			const row = item as Record<string, unknown>;
			return {
				key: String(row.key ?? "").trim(),
				label: String(row.label ?? "").trim(),
				rating: Number(row.rating),
				question: row.question === null || row.question === undefined ? null : String(row.question),
				follow_up: row.follow_up === null || row.follow_up === undefined ? null : String(row.follow_up),
				follow_up_answer: row.follow_up_answer === null || row.follow_up_answer === undefined ? null : String(row.follow_up_answer),
			};
		})
		.filter((item) => item.key.length > 0 && item.label.length > 0 && Number.isFinite(item.rating));
	if (category_ratings.length === 0) {
		res.status(400).json({ error: "No valid category ratings found" });
		return;
	}

	const visitDateRaw = body?.visit_date;
	const visitDate = typeof visitDateRaw === "string" && visitDateRaw.trim().length > 0 ? new Date(visitDateRaw) : null;

	// Optional NPS (0–10) — only stored when the guest actually answered it.
	const npsRaw = body?.nps;
	const npsNum = typeof npsRaw === "number" ? npsRaw : typeof npsRaw === "string" && npsRaw.trim() !== "" ? Number(npsRaw) : NaN;
	const nps = Number.isFinite(npsNum) ? Math.max(0, Math.min(10, Math.round(npsNum))) : null;

	try {
		const saved = await withTenant({ res_id: rid, outlet_id: outletId || "", employeeId, role: "" }, async () => {
			const s = await AddFeedbackEntry(rid, employeeId, {
				customer_name: typeof body?.customer_name === "string" ? body.customer_name : null,
				visit_date: visitDate && !Number.isNaN(visitDate.getTime()) ? visitDate : null,
				comments: typeof body?.comments === "string" ? body.comments : null,
				category_ratings,
				image_theme:
					body?.image_theme && typeof body.image_theme === "object"
						? {
							background: String((body.image_theme as Record<string, unknown>).background ?? ""),
							surface: String((body.image_theme as Record<string, unknown>).surface ?? ""),
							text: String((body.image_theme as Record<string, unknown>).text ?? ""),
							accent: String((body.image_theme as Record<string, unknown>).accent ?? ""),
						}
						: null,
				source: typeof body?.source === "string" ? body.source : "feedback_form",
				nps,
			});
			// Real-time low-score alert: a ≤2/5 rating pings the manager notification
			// bell immediately. Best-effort — a bell failure never fails the submit.
			if (s.overall_rating <= 2) {
				try {
					const guest = typeof body?.customer_name === "string" && body.customer_name.trim() ? body.customer_name.trim() : "a guest";
					const snippet = typeof body?.comments === "string" && body.comments.trim() ? `"${body.comments.trim().slice(0, 140)}"` : "No comment left.";
					await AddNotification(rid, {
						type: "warning",
						title: `⚠ Low feedback: ${s.overall_rating}/5 from ${guest}`,
						body: s.waiter_name ? `${snippet} — served by ${s.waiter_name}` : snippet,
						meta: { feedback_id: s.id, overall_rating: s.overall_rating, waiter_name: s.waiter_name },
					});
				} catch (err) { logger.warn({ err }, "low_feedback_notification_failed"); }
			}
			return s;
		});
		try { emitRestaurant(rid, "feedback:created", saved); } catch (err) { logger.warn({ err }, "emit feedback:created failed"); }
		if (saved.recovery) { try { emitRestaurant(rid, "feedback:recovery", { id: saved.id }); } catch {/* ignore */} }
		res.status(201).json({ success: true, id: saved.id, submitted_at: saved.submitted_at, recovery: saved.recovery });
	} catch (error) {
		logger.error({ err: error }, "submit_feedback_failed");
		res.status(500).json({ error: "Unable to submit feedback" });
	}
});

app.get("/restaurant/users", validateAction("92cb8236-1039-4b47-a66f-6c7c8b0144ae"), async (req: Request, res: Response) => {
	const auth = await enforceRolesIgnoreOutletID(req, res, ["admin", "employee"]);
	if (!auth) {return;}

	try {
		const users = await GetRestaurantUsers(auth.restaurantId);
		res.json({ users });
	} catch (err) {
		logger.error({ err }, 'get_restaurant_users_failed');
		res.status(500).json({ error: 'Unable to fetch restaurant users' });
	}
});

app.post("/restaurant/users", validateAction("58fdfca7-7a97-439b-aeb2-00e4395a9a30"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin"]);
	if (!auth) {return;}

	// Enforce the subscribed plan's employee limit, when it defines one.
	const empLimit = Number(req.auth?.limits?.employees ?? 0);
	if (empLimit > 0) {
		try {
			const count = await GetRestaurantEmployeeCount(auth.restaurantId);
			if (count >= empLimit) {
				res.status(403).json({ error: `Your plan allows up to ${empLimit} employees. Upgrade to add more.` });
				return;
			}
		} catch (e) {
			logger.warn({ err: e }, "employee_limit_check_failed");
		}
	}

	const body = req.body ?? {};
	const empF = typeof body.emp_Fname === 'string' ? body.emp_Fname.trim() : (typeof body.firstName === 'string' ? body.firstName.trim() : '');
	const empL = typeof body.emp_Lname === 'string' ? body.emp_Lname.trim() : (typeof body.lastName === 'string' ? body.lastName.trim() : null);
	const username = typeof body.username === 'string' ? body.username.trim() : '';
	const email = typeof body.email === 'string' ? body.email.trim() : null;
	const role = typeof body.role === 'string' ? body.role : 'employee';
	const password = body.password;
	// Staff phone is optional, but a typed one must be a full 10-digit mobile
	// (it is the number rosters/shift messages use).
	const staffPhone = optionalMobile10(res, body.ph);
	if (!staffPhone.ok) {return;}
	const ph = staffPhone.value ?? undefined;
	const add = typeof body.add === 'string' ? body.add : undefined;

	// Creating a user directly WITH the admin role is owner-only, matching the
	// /roles/assign guard (an admin cannot mint more admins by any path).
	if (isAdminRoleName(role) && !(await callerIsSuperadmin(req))) {
		res.status(403).json({ error: "Only the owner (super-admin) can create an admin user." });
		return;
	}

	try {
		const created = await AddRestaurantUser(auth.restaurantId, auth.outletId, {
			emp_Fname: empF,
			emp_Lname: empL,
			email,
			role,
			password,
			employeeId: body.employeeId,
			username,
			ph,
			add
		});

		if (!created) {
			res.status(500).json({ error: 'Unable to create user' });
			return;
		}

		try { emitRestaurant(auth.restaurantId, 'restaurant:user:created', { user: created }); } catch (e) { logger.warn({ err: e }, 'emit user created failed'); }
		try { await log_audit(req, "58fdfca7-7a97-439b-aeb2-00e4395a9a30", `Created user '${username}' with role '${role}'`, Audit_log_category.Roles, { username, role }); } catch (err) { logger.warn({ err }, "log_audit create-user failed"); }

		res.status(201).json({ success: true, user: created });
	} catch (err) {
		logger.error({ err }, 'create_restaurant_user_failed');
		res.status(500).json({ error: 'Unable to create user' });
	}
});

app.delete("/restaurant/users", validateAction("a978f15d-1043-417a-b07b-05f6bddad875"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin"]);
	if (!auth) {return;}

	const outletId = extractOutletId(req);

	const body = req.body ?? {};
	const employeeId = typeof body.employeeId === 'string' ? body.employeeId.trim() : '';
	if (!employeeId) {
		res.status(400).json({ error: 'Missing employeeId' });
		return;
	}

	try {
		const ok = await DeleteRestaurantUser(auth.restaurantId, employeeId, outletId);
		if (!ok) {
			res.status(500).json({ error: 'Unable to delete user' });
			return;
		}

		// The login row is gone — kill the bearer tokens too, or a deleted user
		// keeps working until their sliding session lapses.
		await revokeEmployeeSessions(employeeId, "user_deleted");

		try { emitRestaurant(auth.restaurantId, 'restaurant:user:deleted', { employeeId }); } catch (e) { /* ignore emit errors */ }

		res.json({ success: true });
	} catch (error: any) {
		logger.error({ err: error }, 'delete_restaurant_user_failed');
		// Surface meaningful errors (e.g. the owner-protection guard) to the client.
		res.status(400).json({ error: String(error?.message ?? 'Unable to delete user') });
	}
});

// Admin sets/resets a user's password (directly, or to fulfil a forgot-password
// request). A non-superadmin admin cannot reset the superadmin's password.
app.post("/restaurant/users/password", async (req: Request, res: Response) => {
	const admin = await enforcePermission(req, res, PERM_PASSWORDS);
	if (!admin) {return;}
	const body = (req.body ?? {}) as Record<string, unknown>;
	const employeeId = typeof body.employeeId === "string" ? body.employeeId.trim() : "";
	const password = typeof body.password === "string" ? body.password : "";
	if (!employeeId || !password) { res.status(400).json({ error: "employeeId and password are required" }); return; }
	try {
		// Owner id resolved restaurant-wide (stable across outlets — the owner may
		// not be a user of the currently-viewed outlet); the outlet-scoped list
		// still drives the target-is-admin escalation guard below.
		const users = await GetRestaurantUsers(admin.restaurantId);
		const superId = await GetSuperadminEmployeeId(admin.restaurantId);
		const target = users.find((u) => u.employee_id === employeeId);
		const targetIsAdmin = !!target && (target.role === "admin" || (target.role_all ?? []).includes("admin") || target.is_superadmin === true);

		if (superId && employeeId === superId && req.auth?.employeeId !== superId) {
			res.status(403).json({ error: "Only the superadmin can reset the superadmin's password." });
			return;
		}
		// Escalation guard: a non-admin caller (e.g. a custom role merely granted
		// "Manage User Passwords") must not be able to reset an ADMIN's password —
		// that would be a back door to full admin. Admins (actions include "*") are
		// unaffected and can still reset regular staff and fellow admins.
		if (targetIsAdmin && !callerIsAdmin(req)) {
			res.status(403).json({ error: "Only an admin can reset an admin's password." });
			return;
		}
		await SetUserPassword(admin.restaurantId, employeeId, password);
		// A password reset must invalidate whatever was issued under the OLD
		// credential (the usual reason for a reset is that it leaked).
		await revokeEmployeeSessions(employeeId, "password_reset");
		// Log under the PASSWORD action (not a978f15d, whose real name is "Remove
		// Employee") — the audit log shows the action's NAME as the entry title, so
		// reusing an unrelated id titled a password reset "Remove Employee".
		try { await log_audit(req, PERM_PASSWORDS, `Reset password for a user`, Audit_log_category.General, { employeeId }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (e: any) {
		logger.error({ err: e }, "set_user_password_failed");
		res.status(400).json({ error: String(e?.message ?? "Unable to set password") });
	}
});

// Admin: list pending forgot-password requests for this restaurant.
app.get("/restaurant/password-requests", async (req: Request, res: Response) => {
	const admin = await enforcePermission(req, res, PERM_PASSWORDS);
	if (!admin) {return;}
	try {
		res.json({ requests: await GetPasswordResetRequests(admin.restaurantId) });
	} catch (e) {
		logger.error({ err: e }, "get_password_requests_failed");
		res.status(500).json({ error: "Unable to load password requests" });
	}
});

// Admin: dismiss a pending password request without resetting.
app.post("/restaurant/password-requests/:id/dismiss", async (req: Request, res: Response) => {
	const admin = await enforcePermission(req, res, PERM_PASSWORDS);
	if (!admin) {return;}
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!id) { res.status(400).json({ error: "Missing request id" }); return; }
	try {
		await ResolvePasswordResetRequest(admin.restaurantId, id);
		res.json({ success: true });
	} catch (e) {
		logger.error({ err: e }, "dismiss_password_request_failed");
		res.status(500).json({ error: "Unable to dismiss request" });
	}
});

// Public: a staff member who forgot their password requests a reset. The
// restaurant slug identifies the tenant; their admin fulfils it from the app.
app.post("/auth/forgot-password", rateLimit("forgot", 5, 60_000), async (req: Request, res: Response) => {
	const body = (req.body ?? {}) as Record<string, unknown>;
	const slug = typeof body.restaurant === "string" ? body.restaurant.trim()
		: typeof body.restaurantUsername === "string" ? body.restaurantUsername.trim() : "";
	const username = typeof body.username === "string" ? body.username.trim() : "";
	if (!slug || !username) { res.status(400).json({ error: "restaurant and username are required" }); return; }
	try {
		await AddPasswordResetRequest(slug, username);
		// Always 200 (don't reveal whether the account exists).
		res.json({ success: true });
	} catch (e: any) {
		// A missing restaurant still returns success-shaped to avoid enumeration.
		logger.warn({ err: e }, "forgot_password_request_failed");
		res.json({ success: true });
	}
});

app.get("/feedback", validateAction("0cb6768b-92ff-4848-8631-52ef9d65cf53"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "employee"]);
	if (!auth) {
		return;
	}

	const limit = clampLimit(req.query.limit, 100, 500);

	try {
		const items = await GetFeedbackEntries(auth.restaurantId, limit);
		res.json({ items });
	} catch (error) {
		logger.error({ err: error }, "get_feedback_failed");
		res.status(500).json({ error: "Unable to fetch feedback" });
	}
});

// Service-recovery tickets (staff): list open low-rating feedback + resolve.
app.get("/feedback/recovery", validateAction("0cb6768b-92ff-4848-8631-52ef9d65cf53"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "employee"]);
	if (!auth) {return;}
	const includeResolved = String(req.query.all ?? "") === "1" || req.query.all === "true";
	try { res.json({ tickets: await GetRecoveryTickets(auth.restaurantId, includeResolved) }); }
	catch (err) { logger.error({ err }, "get_recovery_tickets_failed"); res.status(500).json({ error: "Unable to fetch recovery tickets" }); }
});

app.post("/feedback/recovery/:id/resolve", validateAction(PERM_FEEDBACK_RESOLVE), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "employee"]);
	if (!auth) {return;}
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!id) { res.status(400).json({ error: "Missing id" }); return; }
	const note = typeof (req.body as Record<string, unknown> | undefined)?.note === "string" ? String((req.body as Record<string, unknown>).note) : undefined;
	try {
		await ResolveRecoveryTicket(auth.restaurantId, id, note, extractEmployeeId(req) ?? undefined);
		try { await log_audit(req, "0cb6768b-92ff-4848-8631-52ef9d65cf53", `Resolved service-recovery ticket ${id}`, Audit_log_category.General, { id }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (err) { logger.error({ err }, "resolve_recovery_ticket_failed"); res.status(400).json({ error: "Unable to resolve ticket" }); }
});

app.get("/feedback/summary", validateAction("0cb6768b-92ff-4848-8631-52ef9d65cf53"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "employee"]);
	if (!auth) {
		return;
	}

	try {
		const summary = await GetFeedbackSummary(auth.restaurantId);
		res.json(summary);
	} catch (error) {
		logger.error({ err: error }, "get_feedback_summary_failed");
		res.status(500).json({ error: "Unable to fetch feedback summary" });
	}
});

app.get("/feedback/stats", validateAction("0cb6768b-92ff-4848-8631-52ef9d65cf53"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "employee"]);
	if (!auth) {return;}

	try {
		const mode = String(req.query.mode ?? "daily");
		const rows = await GetFeedbackEntries(auth.restaurantId, 5000);

		// helper to parse ISO date (yyyy-mm-dd)
		const parseDateISO = (s: string | undefined | null) => {
			if (!s) {return null;}
			const d = new Date(s);
			if (!isNaN(d.getTime())) {return d;}
			const parts = (s || "").split("-");
			if (parts.length >= 3) {
				const y = Number(parts[0]);
				const m = Number(parts[1]) - 1;
				const day = Number(parts[2]);
				const dt = new Date(Date.UTC(y, m, day));
				return dt;
			}
			return null;
		};

		if (mode === "daily") {
			const dateParam = String(req.query.date ?? "");
			const date = parseDateISO(dateParam) ?? new Date();
			const targetYMD = date.toISOString().slice(0, 10);
			const hours = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0 }));
			for (const r of rows) {
				const raw = (r).submitted_at ?? (r).submittedAt ?? (r).submittedAt;
				const s = new Date(raw);
				if (isNaN(s.getTime())) {continue;}
				const ymd = s.toISOString().slice(0, 10);
				if (ymd === targetYMD) {
					const h = s.getUTCHours();
					if (h >= 0 && h < hours.length) {
						const bucket = hours[h];
						if (bucket) {bucket.count += 1;}
					}
				}
			}
			return res.json({ mode: "daily", date: targetYMD, hours });
		}

		if (mode === "weekly") {
			const weekParam = String(req.query.weekStart ?? "");
			let weekStart = parseDateISO(weekParam) ?? new Date();
			const day = weekStart.getUTCDay();
			const diff = (day + 6) % 7;
			weekStart = new Date(Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate() - diff));
			const days = [] as { label: string; date: string; count: number }[];
			const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
			for (let i = 0; i < 7; i++) {
				const d = new Date(Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate() + i));
				days.push({ label: dayLabels[i]!, date: d.toISOString().slice(0, 10), count: 0 });
			}
			const startMs = Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate());
			const endMs = startMs + 7 * 24 * 60 * 60 * 1000;
			for (const r of rows) {
				const raw = (r).submitted_at ?? (r).submittedAt ?? (r).submittedAt;
				const s = new Date(raw);
				if (isNaN(s.getTime())) {continue;}
				const t = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
				if (t >= startMs && t < endMs) {
					const idx = Math.floor((t - startMs) / (24 * 60 * 60 * 1000));
					if (idx >= 0 && idx < days.length) {
						const bucket = days[idx];
						if (bucket) {bucket.count += 1;}
					}
				}
			}
			return res.json({ mode: "weekly", weekStart: days[0]!.date, days });
		}

		if (mode === "monthly") {
			// For monthly mode, return week buckets that cover the full calendar month of the provided start date.
			const startParam = String(req.query.start ?? "");
			const requested = parseDateISO(startParam) ?? new Date();
			const year = requested.getUTCFullYear();
			const month = requested.getUTCMonth();
			// monthStart is first day of the month (UTC)
			const monthStart = new Date(Date.UTC(year, month, 1));
			const monthEnd = new Date(Date.UTC(year, month + 1, 1));
			// weekStart is the Monday on or before monthStart
			const day0 = monthStart.getUTCDay();
			const diff0 = (day0 + 6) % 7; // days since Monday
			let weekStart = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), monthStart.getUTCDate() - diff0));
			const weeks = [] as { start: string; end: string; label: string; count: number }[];
			while (weekStart < monthEnd) {
				const s = new Date(Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate()));
				const e = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() + 7));
				weeks.push({ start: s.toISOString().slice(0, 10), end: e.toISOString().slice(0, 10), label: s.toISOString().slice(5, 10), count: 0 });
				weekStart = new Date(Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate() + 7));
			}
			// count events
			for (const r of rows) {
				const raw = (r).submitted_at ?? (r).submittedAt ?? (r).submittedAt;
				const s = new Date(raw);
				if (isNaN(s.getTime())) {continue;}
				const t = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
				for (let idx = 0; idx < weeks.length; idx++) {
					const ws = weeks[idx]!;
					const wsMs = Date.UTC(Number(ws.start.slice(0, 4)), Number(ws.start.slice(5, 7)) - 1, Number(ws.start.slice(8, 10)));
					const weMs = Date.UTC(Number(ws.end.slice(0, 4)), Number(ws.end.slice(5, 7)) - 1, Number(ws.end.slice(8, 10)));
					if (t >= wsMs && t < weMs) { weeks[idx]!.count += 1; break; }
				}
			}
			return res.json({ mode: "monthly", month: `${year}-${(month + 1).toString().padStart(2, '0')}`, start: weeks[0]?.start ?? monthStart.toISOString().slice(0, 10), weeks });
		}

		if (mode === "yearly") {
			const yearParam = Number(req.query.year ?? new Date().getUTCFullYear());
			const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, label: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][i], count: 0 }));
			for (const r of rows) {
				const raw = (r).submitted_at ?? (r).submittedAt ?? (r).submittedAt;
				const s = new Date(raw);
				if (isNaN(s.getTime())) {continue;}
				if (s.getUTCFullYear() === yearParam) {
					const mi = s.getUTCMonth();
					if (mi >= 0 && mi < months.length) {
						const bucket = months[mi];
						if (bucket) {bucket.count += 1;}
					}
				}
			}
			return res.json({ mode: "yearly", year: yearParam, months });
		}

		return res.status(400).json({ error: "Unknown mode" });
	} catch (error) {
		logger.error({ err: error }, 'get_feedback_stats_failed');
		res.status(500).json({ error: 'Unable to fetch feedback stats' });
	}
});


export { app };

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
	if (err instanceof SyntaxError && "body" in err) {
		return res
			.status(400)
			.json({ error: "The request body contains invalid JSON." });
	}
	next(err);
});

// Terminal error handler. Express 5 forwards rejected async handlers here. Log the
// real error server-side with a correlation id and return a generic message so raw
// pg/internal details (schema, constraints, SQL) never leak to clients.
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
	const correlationId = randomUUID();
	logger.error({ err, correlationId, method: req.method, path: req.path }, "unhandled_request_error");
	captureException(err, { correlationId, method: req.method, path: req.path });
	if (res.headersSent) {return;}
	const status = Number(err?.status || err?.statusCode) || 500;
	res.status(status >= 400 && status < 600 ? status : 500).json({
		error: "Something went wrong. Please try again.",
		correlationId,
	});
});

async function bootstrap(): Promise<void> {
	// The CSR Organics demo tenant (admin/admin123) must NOT be auto-created on a
	// production/turnkey deploy. Seed only when explicitly opted in, or outside
	// production. EnsureRestaurantSeed is idempotent, so existing tenants are safe.
	const shouldSeedDemo = process.env.SEED_DEMO === "true" || process.env.NODE_ENV !== "production";
	if (shouldSeedDemo) {
		try {
			await EnsureRestaurantSeed({
				name: "CSR Organics",
				admin: {
					employeeId: "admin",
					name: "Admin",
					password: "admin123",
				},
				tables: [
					{ name: "T1", capacity: 2 },
					{ name: "T2", capacity: 4 },
					{ name: "T3", capacity: 4 },
					{ name: "T4", capacity: 6 },
				],
				profile: {
					address: "12 Example Street, Bengaluru",
					phone: "+91 98765 43210",
					email: "reservations@csrorganics.example",
					hours: "11:00 AM - 11:00 PM",
				},
			});
			logger.info("✅ CSR Organics seed ensured");
		} catch (error) {
			logger.error({ err: error }, "Failed to ensure CSR Organics seed");
		}
	} else {
		logger.info("Skipping demo seed (production; set SEED_DEMO=true to override)");
	}

	// Seed the feature-permission Action rows so the newer (formerly admin-only)
	// features are grantable to custom roles and auto-appear in the role UIs.
	// Idempotent; tolerant of a least-privilege runtime (seeded via migrations there).
	try {
		await ensureFeaturePermissionActions();
		logger.info("✅ Feature-permission actions ensured");
	} catch (error) {
		logger.warn({ err: error }, "Failed to ensure feature-permission actions");
	}

	// Fail-closed isolation guard: warn (or abort, if ENFORCE_RLS_AT_BOOT=true) when
	// any tenant table is missing RLS, so a turnkey deploy never silently serves
	// traffic without DB-enforced multi-tenant isolation.
	await verifyTenantRlsAtBoot();

	const httpServer = createServer(app);
	try {
		await initRealtime(httpServer);
	} catch (err) {
		logger.warn({ err }, "initRealtime failed");
	}

	httpServer.listen(port, () => {
		logger.info(`Server listening at http://localhost:${port}`);
	});

	// Exception-alert sweep: every 30 min, run the 24h exception checks for every
	// tenant (discount spikes / void streaks / negative-feedback streaks →
	// notification bell). There is no cross-instance leader-lock pattern in this
	// codebase (this is its first interval job); the per-alert 24h dedupe inside
	// RunExceptionChecks makes overlapping instances safe — a rare race pings at
	// most twice, and every later run is a no-op. The in-process flag just stops
	// one slow sweep from stacking on the next tick.
	let exceptionSweepRunning = false;
	const exceptionSweep = async () => {
		if (exceptionSweepRunning) {return;}
		exceptionSweepRunning = true;
		try {
			const tenantIds = await ListRestaurantIds();
			for (const resId of tenantIds) {
				try {
					// Each tenant gets its own RLS-scoped connection (no ambient request context here).
					await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => RunExceptionChecks(resId));
				} catch (err) {
					logger.warn({ err, resId }, "exception_sweep_tenant_failed");
				}
				try {
					// Booking reminders ride the same 30-min tick: the slot-JSON
					// reminder_sent stamp (set before sending) makes overlap safe.
					await sendDueBookingReminders(resId);
				} catch (err) {
					logger.warn({ err, resId }, "reminder_sweep_tenant_failed");
				}
			}
		} catch (err) {
			logger.warn({ err }, "exception_sweep_failed");
		} finally {
			exceptionSweepRunning = false;
		}
	};
	const exceptionSweepTimer = setInterval(() => void exceptionSweep(), 30 * 60_000);
	exceptionSweepTimer.unref?.();

	// Graceful shutdown: Railway (and most platforms) send SIGTERM on deploy. Drain
	// the HTTP server + socket.io, then close the pg pools so in-flight work can
	// settle and we don't abandon connections. Force-exit if draining stalls.
	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		if (shuttingDown) {return;}
		shuttingDown = true;
		logger.info(`Received ${signal}, shutting down gracefully...`);
		const forceTimer = setTimeout(() => {
			logger.error("Graceful shutdown timed out; forcing exit.");
			process.exit(1);
		}, 15_000);
		forceTimer.unref?.();
		try {
			await new Promise<void>((resolve) => httpServer.close(() => { resolve(); }));
			await closeRealtime();
			await Promise.allSettled([closePools(), closePlatformPool()]);
			logger.info("Shutdown complete.");
			process.exit(0);
		} catch (err) {
			logger.error({ err }, "Error during shutdown");
			process.exit(1);
		}
	};
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));
}

// Last-resort safety net so a stray rejected promise or thrown error logs instead
// of silently crashing the process with no diagnostics. We intentionally keep the
// process alive on unhandledRejection (log only); a true uncaughtException leaves
// the process in an unknown state, so we log and exit to let the platform restart.
process.on("unhandledRejection", (reason) => {
	logger.error({ reason }, "unhandledRejection");
	captureException(reason);
});
process.on("uncaughtException", (err) => {
	logger.fatal({ err }, "uncaughtException");
	captureException(err);
	process.exit(1);
});

bootstrap().catch(error => {
	logger.error({ err: error }, "Server bootstrap failed");
	process.exit(1);
});
// hot-reload nudge
