import 'dotenv/config';
import { randomUUID, createHmac, timingSafeEqual } from 'crypto';
import express from "express";
import helmet from "helmet";
import { z } from "zod";
import { logger, initObservability, captureException, metricsMiddleware, metricsHandler } from "./observability.js";
initObservability();
import { AddBooking, GetBookingsInRange, AddCustomer, AddEmailToCustomer, AddTable, RemoveTable, OccupyTable, UpdateTableCovers, ReleaseTable, GetTableStatus, GetBillForTable, computeBillCharges, RemoveBillItem, SetBillItemNote, MoveBillItem, SetBillDiscount, GetCoupons, UpsertCoupon, DeleteCoupon, ApplyCouponToBill, CheckCoupon, SplitBillForTable, MergeTableBills, RefundBill, SetBillRefundRef, AddExpense, GetExpenses, DeleteExpense, GetCurrentCashSession, OpenCashSession, CloseCashSession, GetCashSessions, GetSalesReport, GetGstReport, GetProfitAndLoss, BuildTallyXml, GetOperationsAnalytics, GetOutlets, AddOutlet, UpdateOutlet, SetOutletActive, DeleteOutlet, GetOutletsRollup, GetBookingsAfterTime, HasActiveBooking, GetCustomerAndBookings, GetCustomerId, GetTables, UpdateBookingStatus, DeleteBooking, AssignTableToBooking, 
// AddAuditLogEntryLegacy,
Audit_log_category, GetEmployeeDetailsFromEmpID, AddAuditLogEntry, GetAuditLogs, GetRestaurantUserRole, EnsureRestaurantSeed, AllocateBestTable, AddFeedbackEntry, GetFeedbackEntries, GetFeedbackSummary, GetRecoveryTickets, ResolveRecoveryTicket, ClockIn, ClockOut, GetMyAttendance, GetAttendanceSummary, GetVendors, AddVendor, UpdateVendor, DeleteVendor, ReceiveStock, RecordWastage, GetStockMovements, CreatePurchaseOrder, GetPurchaseOrders, GetPurchaseOrder, SetPurchaseOrderStatus, ReceivePurchaseOrder, DeletePurchaseOrder, GetRestaurantUsers, GetRestaurantEmployeeCount, AddRestaurantUser, DeleteRestaurantUser, SetUserPassword, GetSuperadminEmployeeId, AddPasswordResetRequest, GetPasswordResetRequests, ResolvePasswordResetRequest, CheckDatabaseHealth, GetInventoryItems, UpsertInventoryItem, DeleteInventoryItem, GetMenuItems, GetMenuCategories, UpsertMenuItem, EnsureMenuCategory, DeleteMenuCategory, SaveMenuItems, GetOrders, AddOrder, AddTakeawayOrder, DeleteOrder, UpdateOrderItemsSplit, SetOrderStatus, GetMonthlyApcInsights, GetRestaurantProfile, UpdateRestaurantProfile, GetPublicBranding, SetBranding, GetRestaurantSettings, SetRestaurantSettings, GetDailyRevenueSeries, GetMenuPerformanceInsights, OrderTimingAction, GetTimingStats, AddNotification, GetNotifications, MarkNotificationRead, MarkAllNotificationsRead, DeleteNotification, ClearNotifications, GetOutletDefaultTax, GetRestaurantLogo, GetRestaurantLogoRaw, GetBillByOrder, UpdateOutletDefaultTax, AddBill, ReplaceBill, UpdateBillStatusByOrder, ConfirmBillPaymentByWaiter, ApproveBillPaymentByAdmin, CloseBillByOrder, GetRoles, GetActions, ValidationError, CreateRole, DeleteRole, AssignRoleToEmployee, RemoveRoleFromEmployee, GetTableAssignments, GetTableFeedbackContext, AssignTableToEmployee, UnassignTableEmployee, GetParkingBays, AddParkingBay, UpdateParkingBay, DeleteParkingBay, SetParkingBayCurrent, GetValetVehicleStates, CreateValetVehicleState, GetValetVehicleState, UpdateValetVehicleState, UpdateValetVehicleBay, GetValetVehicleMetaByBookingIds, UpsertValetVehicleMeta, AuthenticateRestaurantEmployee, CORE_ROLES, getRestaurantIdFromUsername, openTenantConnection, withTenant, FinalizeOnlinePayment, GetRestaurantRazorpayKeys, SubmitCustomerPayment, GetRestaurantAccountStatus, GetRestaurantPlan, closePools, verifyTenantRlsAtBoot, JoinWaitlist, GetWaitlistEntryByToken, SetWaitlistPreorder, CancelWaitlistByToken, GetWaitlist, CallWaitlistEntry, CancelWaitlistEntry, SeatWaitlistEntry, repriceFromMenu, } from "./database_supabase.js";
import { OPENAI_REALTIME_MODEL, checkAvailabilityForRequest, createReceptionSession, createReservationForRequest, getRestaurantKnowledgeSnapshot, } from "./realtime_reception_agent.js";
import { initRealtime, emitRestaurant, emitOutlet, closeRealtime, realtimeAdapterReady } from "./realtime.js";
import { buildReceiptBase64 } from "./escpos.js";
import { createSession, getSession, refreshTtl, destroySession } from "./auth/sessions.js";
import { getStore } from "./auth/store.js";
import { registerPlatformRoutes } from "./platform/routes.js";
import { closePlatformPool } from "./platform/db.js";
import { getTenantBilling, requestPlanChange, getInvoice, setInvoiceOrderId, markInvoicePaidAndActivate, startTrialIfMissing, billingConfigured, } from "./platform/tenant_billing.js";
import { uploadScreenshot, uploadMenuImage } from "./storage_bucket_supabase.js";
import { verifyTable, decodeTableToken } from "./qr_signing.js";
// Resolve the table for a public QR request. Prefers the opaque ?t= token; falls
// back to table_name+sig. Returns the verified table name, or null if invalid.
function resolveQrTable(resId, src) {
    const token = typeof src.t === "string" ? src.t : "";
    if (token)
        return decodeTableToken(resId, token);
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
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
    hsts: { maxAge: 15552000, includeSubDomains: true },
    referrerPolicy: { policy: "no-referrer" },
    frameguard: { action: "deny" },
}));
// Record per-request latency/status for Prometheus (cheap; before routes).
app.use(metricsMiddleware);
const port = process.env.PORT || 3001;
// Python feedback service URL. Use container host (PY_SERVER_URL) when set,
// otherwise fall back to localhost with optional port override.
const PY_SERVER_URL = process.env.PY_SERVER_URL ?? `http://127.0.0.1:${process.env.PY_SERVER_PORT ?? "8000"}`;
// Where the customer feedback web app (Restaurant_Feedback_UI) is hosted. The
// printed-bill QR and the post-payment redirect both point here, carrying the
// table's assigned waiter so the rating is credited to them.
const FEEDBACK_BASE_URL = (process.env.FEEDBACK_BASE_URL ?? "http://localhost:9003").replace(/\/+$/, "");
// Build the feedback-form URL for a table, encoding the restaurant, the table's
// assigned waiter (eid) and outlet (oid). Returns null when the table has no
// waiter assigned (the form requires a real employee to attribute the rating).
async function feedbackUrlForTable(slug, tableName) {
    try {
        const ctx = await GetTableFeedbackContext(slug, tableName);
        if (!ctx)
            return null;
        // Always include rid + oid so the customer is redirected to the feedback
        // form; include eid only when a waiter could be resolved (for attribution).
        const qs = new URLSearchParams({ rid: slug, oid: ctx.outlet_id });
        if (ctx.employee_id)
            qs.set("eid", ctx.employee_id);
        return `${FEEDBACK_BASE_URL}/?${qs.toString()}`;
    }
    catch {
        return null;
    }
}
// Concise, structured (JSON line) per-request access log. Deliberately logs only
// method/path/status/latency/ip — never headers or body — so auth tokens are never
// written to logs (the old logger dumped the whole req object). Skips /health to
// avoid healthcheck noise. Set REQUEST_LOG=off to disable.
function requestLog(req, res, next) {
    if (req.path === "/health" || process.env.REQUEST_LOG === "off") {
        next();
        return;
    }
    const start = Date.now();
    res.on("finish", () => {
        const fields = { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start, ip: req.ip };
        if (res.statusCode >= 500)
            logger.error(fields, "request");
        else if (res.statusCode >= 400)
            logger.warn(fields, "request");
        else
            logger.info(fields, "request");
    });
    next();
}
app.use(requestLog);
// Retained for the public auth/health/reception routes that legitimately run
// without a session. Authenticated routes are gated by requireAuth, not this.
function validate(_req, _res, next) {
    next();
}
// Authorize against the permitted action UUIDs resolved at login and stored on
// the verified session (req.auth) — never from a client-supplied header.
function validateAction(expectedUUID) {
    return (req, res, next) => {
        const actions = req.auth?.actions ?? [];
        if (!actions.includes(expectedUUID) && !actions.includes("*")) {
            res.status(403).json({ error: "Action not permitted" });
            return;
        }
        next();
    };
}
async function log_audit(req, action_id, action_description, category, additional_details) {
    const employeeID = extractEmployeeId(req);
    if (!employeeID)
        throw new Error("Cannot log audit entry without employee ID");
    const emp_dets = await GetEmployeeDetailsFromEmpID(employeeID);
    if (!emp_dets)
        throw new Error("Employee details not found for ID");
    await AddAuditLogEntry(emp_dets.res_id, emp_dets.outlet_id, employeeID, action_id, action_description, category, additional_details);
}
function normalizeRole(rawRole) {
    if (typeof rawRole !== "string") {
        return null;
    }
    const lowered = rawRole.trim().toLowerCase();
    if (lowered === "admin" || lowered === "employee" || lowered === "valet" || lowered === "waiter" || lowered === "cashier" || lowered === "captain" || lowered === "manager") {
        return lowered;
    }
    return null;
}
function extractBearerToken(req) {
    const header = req.headers["authorization"];
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
async function requireAuth(req, res, next) {
    const token = extractBearerToken(req);
    if (!token) {
        res.status(401).json({ error: "Unauthorized", details: "Missing bearer token" });
        return;
    }
    let session;
    try {
        session = await getSession(token);
    }
    catch (err) {
        logger.error({ err }, "session_lookup_failed");
        res.status(503).json({ error: "Session store unavailable" });
        return;
    }
    if (!session) {
        res.status(401).json({ error: "Unauthorized", details: "Invalid or expired session" });
        return;
    }
    const normalizedRole = normalizeRole(session.role) ?? "employee";
    // Admins/managers may act on another of their restaurant's outlets by passing
    // an X-Outlet-Id header/param (RLS still bounds them to their own res_id, and
    // resolveRestaurantContext falls back to their home outlet if it doesn't
    // match). Everyone else is pinned to their session outlet.
    const requestedOutlet = rawRequestedOutletId(req);
    const effectiveOutlet = requestedOutlet && (normalizedRole === "admin" || normalizedRole === "manager")
        ? requestedOutlet
        : session.outlet_id;
    req.auth = {
        employeeId: session.employeeId,
        res_id: session.res_id,
        outlet_id: effectiveOutlet,
        role: normalizedRole,
        role_all: session.role_all,
        actions: session.actions,
        features: session.features ?? {},
        limits: session.limits ?? {},
    };
    void refreshTtl(token); // sliding expiry, best-effort
    try {
        const conn = await openTenantConnection({
            res_id: session.res_id,
            outlet_id: effectiveOutlet,
            employeeId: session.employeeId,
            role: session.role,
        });
        const release = () => {
            void conn.release();
        };
        res.once("finish", release);
        res.once("close", release);
        conn.run(() => next());
    }
    catch (err) {
        logger.error({ err }, "tenant_connection_open_failed");
        res.status(503).json({ error: "Database unavailable" });
    }
}
function getFeedbackCategoryLabel(category) {
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
    if (normalized === "1")
        return "initial greeting";
    if (normalized === "2")
        return "waiter service";
    if (normalized === "3")
        return "food";
    if (normalized === "4")
        return "ambience";
    if (normalized === "5")
        return "restroom";
    if (normalized === "6")
        return "valet parking";
    return normalized.replace(/_/g, " ");
}
function normalizeFollowUpPromptForCategory(prompt, categoryLabel, rate) {
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
function extractRestaurantId(req) {
    return req.auth?.res_id ?? null;
}
function extractRestaurantUsername(req) {
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
    const body = req.body;
    const bodyValue = body?.restaurantUsername;
    if (typeof bodyValue === "string" && bodyValue.trim().length > 0) {
        return bodyValue.trim();
    }
    return null;
}
function extractEmployeeId(req) {
    return req.auth?.employeeId ?? null;
}
// The customer feedback app is unauthenticated (a guest, no session). It carries
// the restaurant/outlet/employee from the feedback link as headers (or body), the
// same way the public /qr/* endpoints identify their tenant.
function feedbackHeader(req, name, bodyKey) {
    const v = req.headers[name];
    const h = Array.isArray(v) ? v[0] : v;
    if (typeof h === "string" && h.trim())
        return h.trim();
    const body = req.body;
    const bv = body?.[bodyKey];
    return typeof bv === "string" ? bv.trim() : "";
}
const feedbackRestaurantId = (req) => feedbackHeader(req, "x-restaurant-id", "restaurantId");
const feedbackOutletId = (req) => feedbackHeader(req, "x-outlet-id", "outletId");
const feedbackEmployeeId = (req) => feedbackHeader(req, "x-employee-id", "employeeId");
// (extractActionList removed — permissions now come from the verified session.)
function normalizeRestaurantSlug(value) {
    return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
async function enforceRoles(req, res, allowedRoles) {
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
async function enforceRolesIgnoreOutletID(req, res, allowedRoles) {
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
async function enforceAdmin(req, res) {
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
// Non-responding admin check (for guards that decide their own error).
function callerIsAdmin(req) {
    const auth = req.auth;
    if (!auth)
        return false;
    return [auth.role, ...(auth.role_all ?? [])].map((r) => String(r).toLowerCase()).includes("admin");
}
// Core roles that expand to elevated/["*"] permissions — grantable only by an admin.
function isPrivilegedRoleName(roleName) {
    return ["admin", "manager"].includes(roleName.trim().toLowerCase());
}
// Return an error message safe to show an anonymous customer: our own thrown
// business errors pass through, but raw Postgres/driver errors (which carry a
// 5-char SQLSTATE code and can leak table/column/constraint names) are replaced
// with a generic message — public /qr/* & /feedback/* handlers use this.
function safeClientError(err, fallback) {
    const e = err;
    const isPgError = !!e && ((typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) || typeof e.severity === "string");
    if (isPgError)
        return fallback;
    const msg = typeof e?.message === "string" ? e.message : "";
    return msg && msg.length <= 200 ? msg : fallback;
}
// Admins/managers may act across outlets within their own restaurant; everyone
// else is pinned to their session outlet. RLS still bounds all of them to res_id.
function rawRequestedOutletId(req) {
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
    const body = req.body;
    const bodyValue = body?.outletId;
    if (typeof bodyValue === "string" && bodyValue.trim().length > 0) {
        return bodyValue.trim();
    }
    return null;
}
function extractOutletId(req) {
    const auth = req.auth;
    if (!auth) {
        throw new Error("Missing authenticated context");
    }
    const requested = rawRequestedOutletId(req);
    if (requested && (auth.role === "admin" || auth.role === "manager")) {
        return requested;
    }
    return auth.outlet_id;
}
// fetch with a hard timeout so a hung external dependency (payment gateway,
// OpenAI, the feedback service) can't tie up a request indefinitely.
// NOTE: `Response` is shadowed by Express's Response in this file, so the return
// type is derived from the global fetch instead of naming it.
async function fetchWithTimeout(url, init = {}, timeoutMs = 12000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: ctrl.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
// Minimum password policy for account-creation / reset paths. Returns an error
// message, or null when the password is acceptable.
const COMMON_WEAK_PASSWORDS = new Set([
    "password", "password1", "password123", "12345678", "123456789", "1234567890",
    "qwerty123", "admin123", "letmein1", "welcome1", "iloveyou", "changeme",
]);
function passwordPolicyError(pw) {
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
function clampLimit(raw, def = 100, max = 500) {
    const v = Array.isArray(raw) ? raw[0] : raw;
    const n = (typeof v === "string" || typeof v === "number") ? Number.parseInt(String(v), 10) : NaN;
    if (!Number.isFinite(n) || n <= 0)
        return def;
    return Math.min(n, max);
}
// Validate req.body against a zod schema and 400 on failure (replaces the no-op
// `validate` for routes where the shape is known). On success req.body is the
// parsed/coerced data. Apply to new/abuse-prone routes; broaden over time.
function validateBody(schema) {
    return (req, res, next) => {
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
    .refine((b) => (typeof b.bill_id === "string" && b.bill_id.trim().length > 0) || (typeof b.table_name === "string" && b.table_name.trim().length > 0), { message: "bill_id or table_name is required" });
// Constant-time string comparison for secrets/signatures (avoids timing oracles).
function timingSafeStrEqual(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length)
        return false;
    try {
        return timingSafeEqual(ab, bb);
    }
    catch {
        return false;
    }
}
// Rate limiter for abuse-prone public routes: brute-forcing logins, enumerating
// coupon codes, spamming reset requests. Keyed by client IP (needs `trust proxy`
// so req.ip is the real IP behind Railway's proxy). Backed by the shared session
// store — Redis-backed in production so the window is enforced FLEET-WIDE rather
// than multiplied per replica; in-memory otherwise. Fails OPEN on a store error
// so a transient Redis blip never locks out all users.
function rateLimit(label, maxPerWindow, windowMs) {
    const ttlSeconds = Math.max(1, Math.ceil(windowMs / 1000));
    return (req, res, next) => {
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
            }
            catch (err) {
                logger.warn({ err: err?.message ?? err }, "rate_limit_store_error (failing open)");
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
const allowedOrigins = new Set([
    "http://localhost:9002",
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:5173",
    "http://localhost:9003",
    ...(process.env.ALLOWED_ORIGINS ?? process.env.EXTRA_CORS_ORIGINS ?? "")
        .split(",")
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
]);
const allowRailwayWildcard = process.env.ALLOW_RAILWAY_WILDCARD !== "false";
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.has(origin) || (allowRailwayWildcard && origin.endsWith('.up.railway.app')))) {
        res.header("Access-Control-Allow-Origin", origin);
        res.header("Vary", "Origin");
    }
    res.header("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Outlet-Id,X-Restaurant-Username");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
    }
    next();
});
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));
// SaaS control-plane routes. These have their own platform-admin auth and are
// registered before — and excluded from — the tenant auth gate below.
registerPlatformRoutes(app);
// Routes that legitimately run without a session (login, registration, health,
// the public reception/voice endpoints, and the customer feedback form — a guest
// has no session; the restaurant/outlet/employee come from the feedback link).
const PUBLIC_PATHS = new Set([
    "/",
    "/health",
    "/metrics",
    "/auth/register-restaurant",
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
]);
// Gate every other route behind a verified session: this authenticates the
// caller (sets req.auth) and binds the tenant-scoped DB connection used by RLS.
app.use((req, res, next) => {
    if (req.method === "OPTIONS" ||
        req.path.startsWith("/platform/") ||
        req.path.startsWith("/qr/") ||
        PUBLIC_PATHS.has(req.path)) {
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
const FEATURE_BY_PREFIX = [
    [/^\/(reports|expenses|cash)\b/, "accounting"],
    [/^\/analytics\b/, "analytics"],
    [/^\/(inventory|purchase-orders|vendors)\b/, "inventory"],
    [/^\/(valet|create_valet|update_valet|add-valet|delete-valet)/, "valet"],
    [/^\/coupons\b/, "coupons"],
    [/^\/attendance\b/, "attendance"],
];
app.use((req, res, next) => {
    const features = (req.auth?.features ?? {});
    for (const [re, key] of FEATURE_BY_PREFIX) {
        if (re.test(req.path) && features[key] === false) {
            res.status(403).json({ error: `Your plan does not include ${key.replace(/_/g, " ")}.`, feature: key });
            return;
        }
    }
    next();
});
// ---------------------------------------------------------------------------
// Public QR self-ordering (no staff login). The restaurant is identified by the
// slug in the URL; queries run inside that tenant's context so RLS still
// isolates data, and orders append to the table's single bill (AddOrder syncs).
// ---------------------------------------------------------------------------
app.get("/qr/:slug/menu", async (req, res) => {
    const slug = String(req.params.slug ?? "").trim();
    let resId = null;
    try {
        resId = await getRestaurantIdFromUsername(slug);
    }
    catch {
        resId = null;
    }
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
                GetPublicBranding(slug).catch(() => ({ logo_url: null, theme_color: null, theme_primary: null, theme_secondary: null, currency: "₹", payment_methods: [] })),
            ]);
            return {
                restaurant_name: profile?.restaurant_name ?? slug,
                logo_url: branding.logo_url,
                theme_color: branding.theme_color,
                theme_primary: branding.theme_primary,
                theme_secondary: branding.theme_secondary,
                currency: branding.currency,
                payment_methods: branding.payment_methods,
                categories,
                items,
            };
        });
        res.json(data);
    }
    catch (err) {
        logger.error({ err }, "qr_menu_failed");
        res.status(500).json({ error: "Unable to load menu" });
    }
});
app.post("/qr/:slug/order", rateLimit("qr_order", 30, 60_000), async (req, res) => {
    const slug = String(req.params.slug ?? "").trim();
    let resId = null;
    try {
        resId = await getRestaurantIdFromUsername(slug);
    }
    catch {
        resId = null;
    }
    if (!resId) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
    }
    const body = (req.body ?? {});
    const tableName = resolveQrTable(resId, body);
    const customer = typeof body.customer === "string" ? body.customer.trim() : "";
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
    const items = (Array.isArray(body.items) ? body.items : [])
        .slice(0, 100) // cap line count (anti-DoS), like the waitlist preorder path
        .map((it) => {
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
    // Server-computed total — never trust a client-sent total for billing.
    const subtotal = Math.round(items.reduce((s, it) => s + it.price * it.quantity, 0) * 100) / 100;
    try {
        const result = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, async () => {
            // SECURITY: never bill at client-sent prices. Re-price every line from the
            // menu (floor mode keeps modifier upcharges that are >= the menu base);
            // items with no current menu match are dropped.
            const priced = await repriceFromMenu(slug, items, true);
            if (priced.length === 0)
                throw new Error("None of those items are available right now. Please refresh the menu.");
            const pricedSubtotal = Math.round(priced.reduce((s, it) => s + it.price * it.quantity, 0) * 100) / 100;
            // When the restaurant disables auto-push, customer orders land as
            // "Pending" and a staffer must approve them before the kitchen sees them.
            const settings = await GetRestaurantSettings(slug).catch(() => ({ auto_push_orders: true }));
            const orderStatus = settings.auto_push_orders ? "Preparing" : "Pending";
            const orderPayload = {
                table: tableName,
                customer: customer || "QR Guest",
                note,
                items: priced,
                subtotal: pricedSubtotal,
                total: pricedSubtotal,
                taxes: [],
                applyServiceCharge: false,
                status: orderStatus,
            };
            let order;
            try {
                order = await AddOrder(slug, orderPayload);
            }
            catch (e) {
                // Customers may only order at a table a staff member has already
                // seated/occupied — never self-seat from the QR page.
                if (String(e?.message ?? "").toLowerCase().includes("unoccupied")) {
                    throw new Error("This table isn't active yet. Please ask a staff member to start your table before ordering.");
                }
                throw e;
            }
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
        }
        catch { /* ignore */ }
        res.status(201).json({ success: true, ...result });
    }
    catch (err) {
        logger.error({ err }, "qr_order_failed");
        res.status(400).json({ error: safeClientError(err, "Unable to place order") });
    }
});
// Customer pays from the QR page. Uploads the screenshot (if any), records the
// payment as PENDING STAFF APPROVAL, and notifies staff in realtime.
// Customer: preview a coupon code (read-only) against a subtotal.
app.post("/qr/:slug/check-coupon", rateLimit("coupon", 20, 60_000), async (req, res) => {
    const slug = String(req.params.slug ?? "").trim();
    let resId = null;
    try {
        resId = await getRestaurantIdFromUsername(slug);
    }
    catch {
        resId = null;
    }
    if (!resId) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
    }
    const body = (req.body ?? {});
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const subtotal = Number(body.subtotal ?? 0) || 0;
    const phone = typeof body.customer_phone === "string" ? body.customer_phone.trim() : undefined;
    if (!code) {
        res.status(400).json({ error: "code is required" });
        return;
    }
    try {
        const result = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => CheckCoupon(slug, code, subtotal, phone));
        res.json(result);
    }
    catch (e) {
        logger.error({ err: e }, "qr_check_coupon_failed");
        res.status(400).json({ error: safeClientError(e, "Unable to check coupon") });
    }
});
// Customer: apply a coupon code to their table's open bill.
app.post("/qr/:slug/coupon", rateLimit("coupon", 20, 60_000), async (req, res) => {
    const slug = String(req.params.slug ?? "").trim();
    let resId = null;
    try {
        resId = await getRestaurantIdFromUsername(slug);
    }
    catch {
        resId = null;
    }
    if (!resId) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
    }
    const body = (req.body ?? {});
    const tableName = resolveQrTable(resId, body);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const phone = typeof body.customer_phone === "string" ? body.customer_phone.trim() : undefined;
    if (!tableName) {
        res.status(403).json({ error: "Invalid table code. Please re-scan the QR at your table." });
        return;
    }
    if (!code) {
        res.status(400).json({ error: "code is required" });
        return;
    }
    try {
        const result = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => ApplyCouponToBill(slug, tableName, code, phone));
        try {
            emitRestaurant(resId, "bill:updated", { table: tableName });
        }
        catch { /* ignore */ }
        res.json(result);
    }
    catch (e) {
        logger.error({ err: e }, "qr_apply_coupon_failed");
        res.status(400).json({ error: safeClientError(e, "Unable to apply coupon") });
    }
});
app.post("/qr/:slug/pay", rateLimit("qr_pay", 15, 60_000), async (req, res) => {
    const slug = String(req.params.slug ?? "").trim();
    let resId = null;
    try {
        resId = await getRestaurantIdFromUsername(slug);
    }
    catch {
        resId = null;
    }
    if (!resId) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
    }
    const body = (req.body ?? {});
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
            if (settings && (!cfg || !cfg.enabled)) {
                throw new Error("This payment method isn't accepted here.");
            }
            let screenshotUrl = typeof body.screenshot_url === "string" ? body.screenshot_url.trim() : "";
            if (!screenshotUrl && typeof body.screenshot_base64 === "string" && body.screenshot_base64.length > 0) {
                const url = await uploadScreenshot(body.screenshot_base64, typeof body.screenshot_content_type === "string" ? body.screenshot_content_type : "image/jpeg");
                if (url)
                    screenshotUrl = url;
            }
            return SubmitCustomerPayment(slug, tableName, method, screenshotUrl || null, cfg?.requires_screenshot);
        });
        try {
            emitRestaurant(resId, "bill:payment_submitted", {
                table: tableName,
                payment_method: result.payment_method,
                total: result.total_amt,
            });
        }
        catch { /* ignore realtime errors */ }
        try {
            await AddNotification(slug, {
                type: "payment",
                title: `Table ${tableName} paid`,
                body: `₹${result.total_amt} via ${result.payment_method} — review & approve`,
                meta: { table: tableName, order_id: result.order_id },
            });
        }
        catch { /* ignore */ }
        // After paying, the customer is sent to the feedback form for the waiter
        // who handled this table (null when no waiter is assigned).
        const feedback_url = await feedbackUrlForTable(slug, tableName);
        res.json({ ...result, feedback_url });
    }
    catch (err) {
        logger.error({ err }, "qr_pay_failed");
        res.status(400).json({ error: safeClientError(err, "Unable to submit payment") });
    }
});
// Customer views their table's running bill (public).
app.get("/qr/:slug/bill", async (req, res) => {
    const slug = String(req.params.slug ?? "").trim();
    let resId = null;
    try {
        resId = await getRestaurantIdFromUsername(slug);
    }
    catch {
        resId = null;
    }
    if (!resId) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
    }
    const tableName = resolveQrTable(resId, req.query);
    if (!tableName) {
        res.status(403).json({ error: "Invalid table code. Please re-scan the QR at your table." });
        return;
    }
    try {
        const bill = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => GetBillForTable(slug, tableName));
        res.json(bill ?? { total_amt: 0, covers: 0, apc: 0, order_ids: [], payment_status: null });
    }
    catch (err) {
        logger.error({ err }, "qr_bill_failed");
        res.status(400).json({ error: safeClientError(err, "Unable to load bill") });
    }
});
// Public customer reservation (from the reservation web page). Auto-allocates a
// table if one is free; records the booking as "Requested" for staff to confirm.
app.post("/qr/:slug/reserve", rateLimit("qr_reserve", 8, 60_000), async (req, res) => {
    const slug = String(req.params.slug ?? "").trim();
    let resId = null;
    try {
        resId = await getRestaurantIdFromUsername(slug);
    }
    catch {
        resId = null;
    }
    if (!resId) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
    }
    const body = (req.body ?? {});
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : undefined;
    const notes = typeof body.notes === "string" ? body.notes.trim() : null;
    const partySize = Number.parseInt(String(body.party_size ?? body.number_of_people ?? ""), 10);
    const duration = Number.isFinite(Number(body.duration)) ? Number(body.duration) : 90;
    const dateStr = typeof body.date === "string" ? body.date.trim() : "";
    if (!name || !phone) {
        res.status(400).json({ error: "Name and phone are required" });
        return;
    }
    if (!Number.isFinite(partySize) || partySize <= 0) {
        res.status(400).json({ error: "A valid party size is required" });
        return;
    }
    const date = new Date(dateStr);
    if (!dateStr || Number.isNaN(date.getTime())) {
        res.status(400).json({ error: "A valid date/time is required" });
        return;
    }
    if (date.getTime() < Date.now() - 60_000) {
        res.status(400).json({ error: "Please pick a future date and time" });
        return;
    }
    try {
        const result = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, async () => {
            const custId = await GetCustomerIdOrCreateCustomer(slug, name, phone, email);
            if (!custId)
                throw new Error("Unable to record the guest");
            let tableName = null;
            try {
                tableName = await AllocateBestTable(slug, date, duration, partySize);
            }
            catch { /* assign later */ }
            const booking = await AddBooking(slug, custId, date, duration, partySize, tableName, "Online", "Requested", "qr", notes);
            return { booking_id: String(booking._id), table_name: tableName };
        });
        try {
            emitRestaurant(resId, "booking:created", { booking_id: result.booking_id, source: "online" });
        }
        catch { /* ignore */ }
        try {
            await AddNotification(slug, {
                type: "reservation",
                title: "New reservation request",
                body: `${name} · party ${partySize} · ${date.toLocaleString()}${result.table_name ? ` · ${result.table_name}` : ""}`,
                meta: { booking_id: result.booking_id },
            });
        }
        catch { /* ignore */ }
        res.status(201).json({ success: true, status: "Requested", ...result });
    }
    catch (err) {
        logger.error({ err }, "qr_reserve_failed");
        res.status(400).json({ error: safeClientError(err, "Unable to create reservation") });
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
async function resolveRazorpayKeys(slug, resId) {
    try {
        const own = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => GetRestaurantRazorpayKeys(slug));
        if (own)
            return own;
    }
    catch { /* fall through to env */ }
    if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET)
        return { key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET };
    return null;
}
// --- Public waitlist / queue (walk-ins, no session) ---
app.post("/qr/:slug/waitlist/join", rateLimit("waitlist", 12, 60_000), async (req, res) => {
    const slug = String(req.params.slug ?? "").trim();
    let resId = null;
    try {
        resId = await getRestaurantIdFromUsername(slug);
    }
    catch {
        resId = null;
    }
    if (!resId) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
    }
    const body = (req.body ?? {});
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    const party = Number(body.party_size ?? 1) || 1;
    // Multi-outlet: a branch's entrance QR can carry ?outlet=<id> so the walk-in
    // lands in that branch's queue (where its staff are looking). Single-outlet
    // restaurants omit it and fall back to the default outlet.
    const outlet = (typeof body.outlet === "string" && body.outlet.trim()) || (typeof req.query.outlet === "string" ? req.query.outlet.trim() : "");
    if (!name) {
        res.status(400).json({ error: "Please enter your name" });
        return;
    }
    try {
        const entry = await withTenant({ res_id: resId, outlet_id: outlet, employeeId: "", role: "" }, async () => {
            const e = await JoinWaitlist(slug, { name, phone, party_size: party });
            try {
                await AddNotification(slug, { type: "waitlist", title: `New in queue: ${name}`, body: `Party of ${e.party_size}`, meta: { waitlist_id: e.id } });
            }
            catch { /* ignore */ }
            return e;
        });
        try {
            emitRestaurant(resId, "waitlist:updated", { action: "join" });
        }
        catch { /* ignore */ }
        res.status(201).json({ token: entry.token, id: entry.id, position: entry.position, status: entry.status, party_size: entry.party_size });
    }
    catch (e) {
        logger.error({ err: e }, "waitlist_join_failed");
        res.status(400).json({ error: safeClientError(e, "Unable to join the queue") });
    }
});
app.get("/qr/:slug/waitlist/:token", async (req, res) => {
    const slug = String(req.params.slug ?? "").trim();
    let resId = null;
    try {
        resId = await getRestaurantIdFromUsername(slug);
    }
    catch {
        resId = null;
    }
    if (!resId) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
    }
    try {
        const entry = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => GetWaitlistEntryByToken(slug, String(req.params.token)));
        if (!entry) {
            res.status(404).json({ error: "Queue entry not found" });
            return;
        }
        res.json(entry);
    }
    catch (e) {
        logger.error({ err: e }, "waitlist_get_failed");
        res.status(500).json({ error: "Unable to fetch queue status" });
    }
});
app.post("/qr/:slug/waitlist/:token/preorder", rateLimit("waitlist", 20, 60_000), async (req, res) => {
    const slug = String(req.params.slug ?? "").trim();
    let resId = null;
    try {
        resId = await getRestaurantIdFromUsername(slug);
    }
    catch {
        resId = null;
    }
    if (!resId) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
    }
    const body = (req.body ?? {});
    try {
        const r = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => SetWaitlistPreorder(slug, String(req.params.token), body.items));
        if ("error" in r) {
            res.status(400).json(r);
            return;
        }
        res.json(r);
    }
    catch (e) {
        logger.error({ err: e }, "waitlist_preorder_failed");
        res.status(500).json({ error: "Unable to save your selection" });
    }
});
app.post("/qr/:slug/waitlist/:token/cancel", rateLimit("waitlist", 20, 60_000), async (req, res) => {
    const slug = String(req.params.slug ?? "").trim();
    let resId = null;
    try {
        resId = await getRestaurantIdFromUsername(slug);
    }
    catch {
        resId = null;
    }
    if (!resId) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
    }
    try {
        await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => CancelWaitlistByToken(slug, String(req.params.token)));
        try {
            emitRestaurant(resId, "waitlist:updated", { action: "cancel" });
        }
        catch { /* ignore */ }
        res.json({ success: true });
    }
    catch (e) {
        logger.error({ err: e }, "waitlist_cancel_failed");
        res.status(500).json({ error: "Unable to leave the queue" });
    }
});
app.post("/qr/:slug/razorpay/create", async (req, res) => {
    const slug = String(req.params.slug ?? "").trim();
    let resId = null;
    try {
        resId = await getRestaurantIdFromUsername(slug);
    }
    catch {
        resId = null;
    }
    if (!resId) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
    }
    const keys = await resolveRazorpayKeys(slug, resId);
    if (!keys) {
        res.status(503).json({ error: "Online payment isn't set up for this restaurant" });
        return;
    }
    const tableName = resolveQrTable(resId, (req.body ?? {}));
    if (!tableName) {
        res.status(403).json({ error: "Invalid table code. Please re-scan the QR at your table." });
        return;
    }
    try {
        const bill = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => GetBillForTable(slug, tableName));
        const amount = Math.round((bill?.grand_total ?? bill?.total_amt ?? 0) * 100); // paise (tax-inclusive)
        if (amount <= 0) {
            res.status(400).json({ error: "Nothing to pay yet" });
            return;
        }
        const rp = await fetchWithTimeout("https://api.razorpay.com/v1/orders", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Basic " + Buffer.from(`${keys.key_id}:${keys.key_secret}`).toString("base64"),
            },
            body: JSON.stringify({ amount, currency: "INR", receipt: `${slug}:${tableName}:${Date.now()}` }),
        });
        const data = (await rp.json());
        if (!rp.ok) {
            logger.error({ err: data }, "razorpay_create_failed");
            res.status(502).json({ error: "Razorpay order creation failed" });
            return;
        }
        res.json({ razorpay_order_id: data.id, key_id: keys.key_id, amount, currency: "INR" });
    }
    catch (err) {
        logger.error({ err }, "razorpay_create_error");
        res.status(500).json({ error: "Unable to start payment" });
    }
});
app.post("/qr/:slug/razorpay/verify", async (req, res) => {
    const slug = String(req.params.slug ?? "").trim();
    let resId = null;
    try {
        resId = await getRestaurantIdFromUsername(slug);
    }
    catch {
        resId = null;
    }
    if (!resId) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
    }
    const keys = await resolveRazorpayKeys(slug, resId);
    if (!keys) {
        res.status(503).json({ error: "Online payment isn't set up for this restaurant" });
        return;
    }
    const body = (req.body ?? {});
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
        const result = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, () => FinalizeOnlinePayment(slug, tableName, paymentId));
        const feedback_url = await feedbackUrlForTable(slug, tableName);
        res.json({ ...result, feedback_url });
    }
    catch (err) {
        logger.error({ err }, "razorpay_verify_finalize_failed");
        res.status(400).json({ error: safeClientError(err, "Unable to finalize payment") });
    }
});
app.get('/core-roles', validateAction("17ba6407-b703-4403-ab59-13235966053f"), async (req, res) => {
    try {
        /* read action — not audited (avoids log clutter) */
        const rows = Object.keys(CORE_ROLES).map((role) => ({ role, actions: CORE_ROLES[role] }));
        res.json(rows);
    }
    catch (err) {
        logger.error({ err }, 'error_fetching_core_roles');
        res.status(500).json({ error: 'Unable to fetch core roles' });
    }
});
// Lightweight health endpoint for readiness/liveness checks
app.get("/", (_req, res) => {
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
app.get("/app/version", (_req, res) => {
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
app.get("/health", async (_req, res) => {
    const result = { status: "ok", uptime: process.uptime(), time: new Date().toISOString() };
    let dbOk = false;
    try {
        dbOk = await CheckDatabaseHealth();
    }
    catch {
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
app.post("/auth/register-restaurant", rateLimit("register", 5, 60_000), validateBody(registerRestaurantSchema), validate, async (req, res) => {
    const body = (req.body ?? {});
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
        }
        catch (error) {
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
                if (newResId)
                    await startTrialIfMissing(newResId, Number(process.env.SAAS_TRIAL_DAYS || 14));
            }
            catch (e) {
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
    }
    catch (error) {
        logger.error({ err: error }, "register_restaurant_failed");
        res.status(500).json({ error: "Unable to register restaurant" });
    }
});
app.post("/auth/employee-login", rateLimit("login", 15, 60_000), validate, async (req, res) => {
    const body = (req.body ?? {});
    const employeeUsername = typeof body.employeeUsername === "string" ? body.employeeUsername.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const restaurantIdRaw = typeof body.restaurantId === "string" ? body.restaurantId.trim() : "";
    const restaurantName = typeof body.restaurantName === "string" ? body.restaurantName.trim() : "";
    if (!employeeUsername || !password || !restaurantName) {
        res.status(400).json({
            error: "employeeUsername, password, and restaurantName are required",
        });
        return;
    }
    const restaurantUsername = restaurantIdRaw || normalizeRestaurantSlug(restaurantName);
    try {
        const user = await AuthenticateRestaurantEmployee(restaurantUsername, employeeUsername, password);
        if (!user) {
            res.status(401).json({ error: "Invalid employee ID or password." });
            return;
        }
        // Block sign-in for suspended / expired restaurant accounts.
        const accountStatus = await GetRestaurantAccountStatus(user.res_id);
        if (accountStatus !== "active") {
            res.status(403).json({
                error: accountStatus === "expired"
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
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Unknown restaurant id")) {
            res.status(404).json({ error: "Invalid restaurant name." });
            return;
        }
        logger.error({ err: error }, "employee_login_failed");
        res.status(500).json({ error: "Unable to sign in." });
    }
});
app.post("/auth/logout", async (req, res) => {
    const token = extractBearerToken(req);
    if (token) {
        try {
            await destroySession(token);
        }
        catch (err) {
            logger.error({ err }, "logout_failed");
        }
    }
    res.json({ ok: true });
});
// Re-hydrate the client UI from the verified session (profile + permitted
// action names for display gating). The server remains the source of truth.
app.get("/auth/me", async (req, res) => {
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
app.get("/reception/info", (_req, res) => {
    const snapshot = getRestaurantKnowledgeSnapshot();
    res.json(snapshot);
});
app.post("/reception/check-availability", rateLimit("reception", 10, 60_000), async (req, res) => {
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
    }
    catch (error) {
        logger.error({ err: error }, "check_availability_failed");
        res.status(500).json({ error: "Unable to check availability" });
    }
});
app.post("/reception/create-reservation", rateLimit("reception_create", 6, 60_000), async (req, res) => {
    const payload = req.body ?? {};
    const required = ["guestName", "contactNumber", "partySize", "reservationDate", "reservationTime"];
    const missing = required.filter((key) => !payload[key]);
    if (missing.length > 0) {
        res.status(400).json({ error: `Missing fields: ${missing.join(", ")}` });
        return;
    }
    try {
        const result = await createReservationForRequest({
            guestName: String(payload.guestName),
            contactNumber: String(payload.contactNumber),
            partySize: Number(payload.partySize),
            reservationDate: String(payload.reservationDate),
            reservationTime: String(payload.reservationTime),
            tablePreference: payload.tablePreference === null || payload.tablePreference === undefined
                ? null
                : String(payload.tablePreference),
            specialRequests: payload.specialRequests === null || payload.specialRequests === undefined
                ? null
                : String(payload.specialRequests),
        });
        res.json(result);
    }
    catch (error) {
        logger.error({ err: error }, "create_reservation_failed");
        res.status(500).json({ error: "Unable to create reservation" });
    }
});
app.post("/realtime/session", rateLimit("realtime", 5, 60_000), async (_req, res) => {
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
        const data = (dataUnknown ?? {});
        if (!response.ok) {
            res.status(response.status).json(data);
            return;
        }
        res.json(data);
    }
    catch (error) {
        logger.error({ err: error }, "realtime_session_failed");
        res.status(500).json({ error: "Unable to create realtime session" });
    }
});
async function GetCustomerIdOrCreateCustomer(restaurantId, name, number, email) {
    const normalizedName = name.trim();
    const normalizedNumber = number.trim();
    let customerId = await GetCustomerId(restaurantId, normalizedName, normalizedNumber);
    if (!customerId) {
        const createdCustomer = await AddCustomer(restaurantId, normalizedName, normalizedNumber, email);
        customerId = createdCustomer._id;
    }
    if (customerId && email) {
        await AddEmailToCustomer(restaurantId, customerId, email);
    }
    if (!customerId) {
        return null;
    }
    return String(customerId);
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
app.post("/add-customer", validateAction("daf1d71f-2b37-4cd1-b951-28fece7719cd"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    let customer = req.body.customer;
    if (!(customer.name && customer.number)) {
        res.status(400).json({ error: "Missing required fields" });
        return;
    }
    let cust_id = await GetCustomerIdOrCreateCustomer(restaurantId, customer.name, customer.number, customer.email);
    try {
        await log_audit(req, "daf1d71f-2b37-4cd1-b951-28fece7719cd", `Created or linked customer ${customer.name}`, Audit_log_category.Customer, { customer_id: cust_id });
    }
    catch (err) {
        logger.warn({ err }, 'log_audit add-customer failed');
    }
    res.send(cust_id);
});
/*
    Needs request body as
    {
       "table": {
           "name": "T1",
           "capacity": 4 // Optional
       }
    }
    returns the table_name if you want to store it somewhere
*/
app.post("/add-table", validateAction("194ce6ee-b867-4be3-b5f0-48c28ce0a81b"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    let table = req.body.table;
    if (!table.name) {
        res.status(400).json({ error: "Missing required fields" });
        return;
    }
    let table_name = null;
    try {
        const created = await AddTable(restaurantId, table.name, table.capacity !== undefined ? parseInt(table.capacity) : undefined);
        table_name = created.table_name;
    }
    catch (error) {
        logger.info(error);
        table_name = null;
    }
    if (!table_name) {
        res.status(400).json({ error: "Table exists" });
        return;
    }
    try {
        emitRestaurant(restaurantId, "table:added", { table_name, capacity: table.capacity });
    }
    catch (err) {
        logger.warn({ err }, "emit table:added failed");
    }
    try {
        await log_audit(req, "194ce6ee-b867-4be3-b5f0-48c28ce0a81b", `Added table ${table_name}`, Audit_log_category.Tables, { capacity: table.capacity });
    }
    catch (err) {
        logger.warn({ err }, 'log_audit add-table failed');
    }
    res.send(table_name);
});
app.delete("/table/:name", validateAction("5777c4aa-29df-4ea1-9c45-c1038d25f746"), async (req, res) => {
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
    }
    catch (err) {
        logger.warn({ err }, "emit table:deleted failed");
    }
    try {
        await log_audit(req, "5777c4aa-29df-4ea1-9c45-c1038d25f746", `Removed table ${tableName}`, Audit_log_category.Tables, { table_name: tableName });
    }
    catch (err) {
        logger.warn({ err }, 'log_audit delete-table failed');
    }
    res.status(204).send();
});
// Occupy a table (mark as occupied and set number of covers)
app.post("/occupy-table", validateAction("090ea8d4-e348-4e1b-9723-11131a73a085"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = req.body;
    const tableName = typeof body?.table_name === 'string' ? body.table_name.trim() : '';
    const numCovers = typeof body?.num_covers === 'number' ? body.num_covers : 1;
    const orderId = typeof body?.order_id === 'string' ? body.order_id.trim() : undefined;
    if (!tableName) {
        res.status(400).json({ error: "table_name is required" });
        return;
    }
    try {
        const result = await OccupyTable(restaurantId, tableName, numCovers, orderId ?? null, extractEmployeeId(req));
        try {
            await log_audit(req, "090ea8d4-e348-4e1b-9723-11131a73a085", `Occupied table ${tableName} with ${numCovers} covers`, Audit_log_category.Tables, { table_name: tableName, num_covers: numCovers });
        }
        catch (err) {
            logger.warn({ err }, 'log_audit occupy-table failed');
        }
        res.json(result);
    }
    catch (error) {
        logger.error({ err: error }, "occupy_table_failed");
        res.status(400).json({ error: String(error?.message ?? "Unable to occupy table") });
    }
});
// Update number of covers at a table
app.patch("/table-covers", validateAction("090ea8d4-e348-4e1b-9723-11131a73a085"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = req.body;
    const tableName = typeof body?.table_name === 'string' ? body.table_name.trim() : '';
    const numCovers = typeof body?.num_covers === 'number' ? body.num_covers : 1;
    if (!tableName) {
        res.status(400).json({ error: "table_name is required" });
        return;
    }
    try {
        const result = await UpdateTableCovers(restaurantId, tableName, numCovers);
        try {
            await log_audit(req, "090ea8d4-e348-4e1b-9723-11131a73a085", `Updated table ${tableName} covers to ${numCovers}`, Audit_log_category.Tables, { table_name: tableName, num_covers: numCovers });
        }
        catch (err) {
            logger.warn({ err }, 'log_audit table-covers failed');
        }
        res.json(result);
    }
    catch (error) {
        logger.error({ err: error }, "table_covers_failed");
        res.status(400).json({ error: String(error?.message ?? "Unable to update table covers") });
    }
});
// Release/unoccupy a table
app.post("/release-table", validateAction("090ea8d4-e348-4e1b-9723-11131a73a085"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = req.body;
    const tableName = typeof body?.table_name === 'string' ? body.table_name.trim() : '';
    if (!tableName) {
        res.status(400).json({ error: "table_name is required" });
        return;
    }
    try {
        const result = await ReleaseTable(restaurantId, tableName);
        try {
            await log_audit(req, "090ea8d4-e348-4e1b-9723-11131a73a085", `Released table ${tableName}`, Audit_log_category.Tables, { table_name: tableName });
        }
        catch (err) {
            logger.warn({ err }, 'log_audit release-table failed');
        }
        res.json(result);
    }
    catch (error) {
        logger.error({ err: error }, "release_table_failed");
        res.status(400).json({ error: String(error?.message ?? "Unable to release table") });
    }
});
// Get table status
app.get("/table-status", validateAction("090ea8d4-e348-4e1b-9723-11131a73a085"), async (req, res) => {
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
    }
    catch (error) {
        logger.error({ err: error }, "get_table_status_failed");
        res.status(400).json({ error: String(error?.message ?? "Unable to get table status") });
    }
});
// Get bill for a table (returns the current open bill and all associated orders)
app.get("/bill-for-table", validateAction("98b10bde-802d-4a5b-a726-53a826424f79"), async (req, res) => {
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
    }
    catch (error) {
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
        "date": "YYYY-MM-DDThh:mm:ssTZD"
        "duration": "30" // in minutes
        "number_of_people": "3"
        "source": "EasyDiner" //Optional
   }
}
returns the booking id
*/
app.post("/add-booking", validateAction("3ec33182-ceb4-4d07-ac7e-84214adcf104"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    let customer = req.body.customer;
    if (!(customer.name && customer.number)) {
        res.status(400).json({ error: "Missing customer field(s)" });
        return;
    }
    let booking_request = req.body.booking;
    if (!(booking_request &&
        booking_request.date &&
        booking_request.duration &&
        booking_request.number_of_people)) {
        res.status(400).json({ error: "Missing booking field(s)" });
        return;
    }
    let cust_id = await GetCustomerIdOrCreateCustomer(restaurantId, customer.name, customer.number, customer.email);
    if (cust_id == null) {
        res.status(400).json({
            error: "Something went wrong in creating/getting customer id",
        });
        return;
    }
    let date = new Date(booking_request.date);
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
    let booking;
    let tableName = (booking_request.table_name ?? null);
    try {
        if (!tableName) {
            // Auto-allocate best fitting table if none provided
            try {
                const allocated = await AllocateBestTable(restaurantId, date, durationMinutes, partySize);
                if (allocated) {
                    tableName = allocated;
                }
            }
            catch (allocErr) {
                logger.warn({ restaurantId, error: allocErr }, "table_allocation_failed");
            }
            if (!tableName) {
                return res.status(409).json({ error: "No table available for the requested time window", reason: "no_table_available" });
            }
        }
        booking = await AddBooking(restaurantId, cust_id, date, durationMinutes, partySize, tableName, booking_request.source, booking_request.status ?? "Confirmed", booking_request.from, booking_request.notes ?? booking_request.additional_information ?? null);
    }
    catch (error) {
        res.status(400).json({ error: "Oops something went wrong" });
        return;
    }
    const booking_id = String(booking._id);
    try {
        emitRestaurant(restaurantId, "booking:created", { booking_id, table_name: tableName });
    }
    catch (err) {
        logger.warn({ err }, "emit booking:created failed");
    }
    try {
        await log_audit(req, "3ec33182-ceb4-4d07-ac7e-84214adcf104", `Created booking for customer ${customer.name} at ${booking_request.date}`, Audit_log_category.Bookings, { booking_id, table_name: tableName });
    }
    catch (err) {
        logger.warn({ err }, 'log_audit add-booking failed');
    }
    res.json({ booking_id, table_name: tableName });
});
function FoldedTables(table) {
    if (table.length == 0) {
        return [];
    }
    let min = table[0]["capacity"];
    let max = table[table.length - 1]["capacity"];
    let folded_tables = [];
    let curr_index = 0;
    for (let capacity = min; capacity <= max; capacity++) {
        let cur_table = [];
        let push = false;
        while (table.length > curr_index &&
            table[curr_index]["capacity"] == capacity) {
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
app.get("/get-tables", validateAction("090ea8d4-e348-4e1b-9723-11131a73a085"), async (req, res) => {
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
        }
        catch (err) {
            logger.warn({ err }, 'log_audit get-tables failed');
        }
        res.send(tables ?? []);
    }
    catch (e) {
        res.status(400).send({ error: "Oops something went wrong" });
        return;
    }
});
function IsActiveBooking(booking, time) {
    let booking_start = new Date(booking.booking_date_time).getTime();
    let booking_end = new Date(booking_start).getTime() + booking.duration_mins * 60 * 1000;
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
app.get("/get-bookings", validate, async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    let bookings;
    const time = new Date();
    const timeQuery = Array.isArray(req.query.time) ? req.query.time[0] : req.query.time;
    const requestedTime = typeof timeQuery === "string" ? timeQuery : undefined;
    try {
        bookings = await GetBookingsAfterTime(restaurantId, requestedTime);
    }
    catch (error) {
        logger.info(error);
        res.status(400).send({ error: "Oops something went wrong" });
        return;
    }
    if (bookings == null) {
        res.status(400).send({ error: "Time is invalid" });
        return;
    }
    res.send(bookings.map((booking) => ({
        ...booking,
        active: IsActiveBooking(booking, time),
    })));
});
app.get("/valet-info", validateAction("9e37297d-408b-446d-a51b-7892ad216b7d"), async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin", "valet"]);
    if (!auth) {
        return;
    }
    try {
        const [records, bays] = await Promise.all([
            GetValetVehicleStates(auth.restaurantId, auth.outletId),
            GetParkingBays(auth.restaurantId, auth.outletId),
        ]);
        const metaByBookingId = await GetValetVehicleMetaByBookingIds(auth.restaurantId, records.map((row) => row.booking_id), auth.outletId);
        const bayById = new Map((bays ?? []).map((bay) => [String(bay.Bay_id), bay.Bay_name]));
        const stateMap = {
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
            };
        });
        try {
            /* read action — not audited (avoids log clutter) */
        }
        catch (err) {
            logger.warn({ err }, 'log_audit valet-info failed');
        }
        res.json({
            role: auth.role,
            generated_at: new Date().toISOString(),
            bays,
            bookings,
        });
    }
    catch (error) {
        logger.error({ err: error }, "valet_info_failed");
        res.status(500).json({ error: "Unable to fetch valet info" });
    }
});
// (debug endpoint removed)
app.patch("/booking/:id/status", validateAction("fdeecab6-7c3a-4239-b87c-99a96f50c551"), async (req, res) => {
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
    const updated = await UpdateBookingStatus(auth.restaurantId, bookingId, status);
    if (!updated) {
        res.status(404).json({ error: "Booking not found" });
        return;
    }
    try {
        emitRestaurant(auth.restaurantId, "booking:status_updated", { booking_id: bookingId, status });
    }
    catch (err) {
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
app.post("/bills", validateAction("9186e53e-0fda-4ec8-ad20-2f9feaadb77f"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = (req.body ?? {});
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
        }
        catch (err) {
            logger.warn({ err }, 'log_audit add-bill failed');
        }
        res.status(201).json(result);
    }
    catch (error) {
        logger.error({ err: error }, 'add_bill_failed');
        res.status(500).json({ error: String(error?.message ?? 'Unable to create bill') });
    }
});
app.post('/bills/replace', validateAction("383cc261-7e5c-4745-b16f-06a41e2ae047"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId)
        return res.status(400).json({ error: 'Missing restaurantId' });
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
        if (!result)
            return res.status(500).json({ error: 'Replace operation failed' });
        // emit realtime events for UI updates — use order:updated for in-place changes
        try {
            const payloadForEmit = {
                order_id: old_order_id,
                bill_id: result.newBillId,
                new_order_id: result.newOrderId,
            };
            emitRestaurant(restaurantId, 'order:updated', payloadForEmit);
        }
        catch (e) { }
        try {
            await log_audit(req, "383cc261-7e5c-4745-b16f-06a41e2ae047", `Replaced bill for order ${old_order_id}`, Audit_log_category.Bill, { old_order_id, newBillId: result.newBillId });
        }
        catch (err) {
            logger.warn({ err }, 'log_audit replace-bill failed');
        }
        return res.status(200).json(result);
    }
    catch (err) {
        logger.error({ err }, 'replace_bill_failed');
        return res.status(500).json({ error: String(err?.message ?? 'Internal') });
    }
});
app.get('/bills/order/:orderId', validateAction("98b10bde-802d-4a5b-a726-53a826424f79"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId)
        return res.status(400).json({ error: 'Missing restaurantId' });
    const orderId = String(req.params.orderId ?? '').trim();
    if (!orderId)
        return res.status(400).json({ error: 'Missing orderId' });
    try {
        const bill = await GetBillByOrder(restaurantId, orderId);
        if (!bill)
            return res.status(404).json({ error: 'Bill not found' });
        try {
            /* read action — not audited (avoids log clutter) */
        }
        catch (err) {
            logger.warn({ err }, 'log_audit get-bill-by-order failed');
        }
        return res.json(bill);
    }
    catch (err) {
        logger.error({ err }, 'get bill by order failed');
        return res.status(500).json({ error: 'Internal' });
    }
});
app.get('/restaurant/logo', validate, async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId)
        return res.status(400).json({ error: 'Missing restaurantId' });
    try {
        const logoBase64 = await GetRestaurantLogo(restaurantId);
        if (!logoBase64)
            return res.status(404).json({ error: 'Logo not found' });
        return res.json({ logo_base64: logoBase64 });
    }
    catch (err) {
        logger.error({ err }, 'get restaurant logo failed');
        return res.status(500).json({ error: 'Internal' });
    }
});
// Build the ESC/POS raster (GS v 0) for the restaurant's bill logo, preferring the
// SVG bill logo (rasterized via sharp) and falling back to the PNG logo. Returns
// null when no logo is configured or sharp is unavailable. Reused by the
// /restaurant/logo/escpos endpoint and embedded at the top of printed bills.
async function buildLogoEscPos(restaurantId, targetWidth = 576) {
    let raw = null;
    try {
        const settings = await GetRestaurantSettings(restaurantId);
        const svg = settings.bill_logo_svg?.trim();
        if (svg)
            raw = Buffer.from(svg, 'utf8');
    }
    catch { /* ignore — fall back to the PNG logo */ }
    if (!raw)
        raw = await GetRestaurantLogoRaw(restaurantId).catch(() => null);
    if (!raw)
        return null;
    let sharp;
    try {
        sharp = (await import('sharp')).default ?? (await import('sharp'));
    }
    catch (err) {
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
    const bytes = [];
    for (let y = 0; y < height; y++) {
        for (let xb = 0; xb < widthBytes; xb++) {
            let byte = 0;
            for (let bit = 0; bit < 8; bit++) {
                const x = xb * 8 + bit;
                const idx = y * width + x;
                const pixel = x < width ? data[idx] : 255;
                // in thresholded raw, 0=black, 255=white
                if (pixel === 0)
                    byte |= (1 << (7 - bit));
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
app.get('/restaurant/logo/escpos', validate, async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId)
        return res.status(400).json({ error: 'Missing restaurantId' });
    try {
        const out = await buildLogoEscPos(restaurantId);
        if (!out)
            return res.status(404).json({ error: 'Logo not found' });
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(out.length));
        return res.send(out);
    }
    catch (err) {
        logger.error({ err }, 'get restaurant escpos failed');
        return res.status(500).json({ error: 'Internal' });
    }
});
app.patch('/bills/order/:orderId/status', validateAction("07e364cc-f40d-46f3-b691-0f719dd38e0f"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: 'Missing restaurantId' });
        return;
    }
    const orderId = typeof req.params.orderId === 'string' ? req.params.orderId.trim() : '';
    const body = (req.body ?? {});
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
            }
            catch (err) {
                logger.error({ err }, 'update_order_items_split_failed');
                res.status(400).json({ error: String(err?.message ?? 'Unable to update order items') });
                return;
            }
        }
        // If numeric status provided, still update bill status
        if (Number.isFinite(status)) {
            await UpdateBillStatusByOrder(restaurantId, orderId, status);
            try {
                await log_audit(req, "07e364cc-f40d-46f3-b691-0f719dd38e0f", `Updated bill status for order ${orderId} to ${status}`, Audit_log_category.Bill, { order_id: orderId, status });
            }
            catch (err) {
                logger.warn({ err }, 'log_audit update-bill-status failed');
            }
        }
        res.json({ success: true });
    }
    catch (error) {
        logger.error({ err: error }, 'update_bill_status_failed');
        res.status(400).json({ error: String(error?.message ?? 'Unable to update bill status') });
    }
});
app.post('/bills/order/:orderId/waiter-confirm-payment', validateAction("2393edd7-cdd9-439c-9ff3-d563d5216967"), async (req, res) => {
    // Permission is enforced by validateAction above, so any role (admin or a
    // custom role granted this permission) may record payment.
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const auth = { restaurantId };
    const orderId = typeof req.params.orderId === 'string' ? req.params.orderId.trim() : '';
    const paymentMethod = typeof req.body?.payment_method === 'string' ? req.body.payment_method.trim() : '';
    const paymentProofScreenshotUrl = typeof req.body?.payment_proof_screenshot_url === 'string'
        ? req.body.payment_proof_screenshot_url.trim()
        : '';
    const waiterEmployeeId = extractEmployeeId(req);
    if (!orderId || !paymentMethod || !waiterEmployeeId) {
        res.status(400).json({ error: 'Missing orderId, payment_method, or employee identity' });
        return;
    }
    try {
        const result = await ConfirmBillPaymentByWaiter(auth.restaurantId, orderId, waiterEmployeeId, paymentMethod, paymentProofScreenshotUrl || null);
        try {
            emitRestaurant(auth.restaurantId, 'bill:waiter_confirmed_payment', {
                order_id: orderId,
                payment_method: result.payment_method,
                waiter: waiterEmployeeId,
            });
        }
        catch {
            // ignore realtime failures
        }
        try {
            await log_audit(req, "2393edd7-cdd9-439c-9ff3-d563d5216967", `Waiter confirmed payment for order ${orderId}`, Audit_log_category.Bill, { order_id: orderId, waiter: waiterEmployeeId, payment_method: result.payment_method });
        }
        catch (err) {
            logger.warn({ err }, 'log_audit waiter-confirm-payment failed');
        }
        res.json(result);
    }
    catch (error) {
        logger.error({ err: error }, 'waiter_confirm_bill_payment_failed');
        res.status(400).json({ error: String(error?.message ?? 'Unable to confirm payment') });
    }
});
app.post('/bills/order/:orderId/admin-approve-payment', validateAction("fc57d407-4bba-442c-97a2-9e6f3c57f288"), async (req, res) => {
    // Approval is gated by the permission (validateAction), so admin OR any
    // custom role granted "approve payment" can approve.
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
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
        }
        catch {
            // ignore realtime failures
        }
        try {
            await log_audit(req, "fc57d407-4bba-442c-97a2-9e6f3c57f288", `Admin approved payment for order ${orderId}`, Audit_log_category.Bill, { order_id: orderId, admin: adminEmployeeId });
        }
        catch (err) {
            logger.warn({ err }, 'log_audit admin-approve-payment failed');
        }
        res.json(result);
    }
    catch (error) {
        logger.error({ err: error }, 'admin_approve_bill_payment_failed');
        res.status(400).json({ error: String(error?.message ?? 'Unable to approve payment') });
    }
});
app.post('/bills/order/:orderId/close', validateAction("a953d044-31ba-4e31-b96f-99304fe43dfa"), async (req, res) => {
    // Gated by the close permission (validateAction) — admin or permissioned custom role.
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
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
        }
        catch {
            // ignore realtime failures
        }
        try {
            await log_audit(req, "a953d044-31ba-4e31-b96f-99304fe43dfa", `Closed bill for order ${orderId}`, Audit_log_category.Bill, { order_id: orderId, admin: adminEmployeeId });
        }
        catch (err) {
            logger.warn({ err }, 'log_audit close-bill failed');
        }
        res.json(result);
    }
    catch (error) {
        logger.error({ err: error }, 'close_bill_failed');
        res.status(400).json({ error: String(error?.message ?? 'Unable to close bill') });
    }
});
app.patch("/booking/:id/table", validateAction("c7699d46-0e2f-4448-b325-8ca490a5296b"), async (req, res) => {
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
    const tableName = tableNameRaw === null || tableNameRaw === undefined
        ? null
        : String(tableNameRaw).trim() || null;
    try {
        const updated = await AssignTableToBooking(auth.restaurantId, bookingId, tableName);
        if (!updated) {
            res.status(404).json({ error: "Booking not found" });
            return;
        }
    }
    catch (error) {
        res.status(400).json({ error: "Unable to assign table" });
        return;
    }
    try {
        await log_audit(req, "c7699d46-0e2f-4448-b325-8ca490a5296b", `Assigned table ${tableName ?? 'null'} to booking ${bookingId}`, Audit_log_category.Bookings, { booking_id: bookingId, table_name: tableName });
    }
    catch (err) {
        logger.warn({ err }, 'log_audit assign-table-to-booking failed');
    }
    res.json({ success: true });
});
app.delete("/booking/:id", validateAction("1f176202-d5e7-4bb0-802c-275a42425394"), async (req, res) => {
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
    const deleted = await DeleteBooking(restaurantId, bookingId);
    if (!deleted) {
        res.status(404).json({ error: "Booking not found" });
        return;
    }
    try {
        emitRestaurant(restaurantId, "booking:deleted", { booking_id: bookingId });
    }
    catch (err) {
        logger.warn({ err }, "emit booking:deleted failed");
    }
    try {
        await log_audit(req, "1f176202-d5e7-4bb0-802c-275a42425394", `Canceled booking ${bookingId}`, Audit_log_category.Bookings, { booking_id: bookingId });
    }
    catch (err) {
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
app.get("/get-customers", validateAction("3c530903-324c-4bbe-802b-849763518920"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    let customers;
    try {
        customers = await GetCustomerAndBookings(restaurantId);
    }
    catch {
        res.status(400).send({ error: "Oops something went wrong" });
        return;
    }
    const customersWithStatus = await Promise.all(customers.map(async (customer) => ({
        ...customer,
        has_booking: await HasActiveBooking(restaurantId, customer.customer_id),
    })));
    try {
        /* read action — not audited (avoids log clutter) */
    }
    catch (err) {
        logger.warn({ err }, 'log_audit get-customers failed');
    }
    res.send(customersWithStatus);
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
app.get("/get-withen-range", validateAction("0a98cf2b-8b42-47a7-a523-b7bb73cb870e"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).send({ Error: "Missing restaurantId" });
        return;
    }
    if (!(req.body["start"] && req.body["end"])) {
        res.status(400).send({ Error: "Missing fields" });
    }
    let start = new Date(req.body.start);
    let end = new Date(req.body.end);
    if (isNaN(start.valueOf()) || isNaN(end.valueOf())) {
        res.status(400).send({
            Error: "Dates provided is not formated correctley",
        });
    }
    let count = await GetBookingsInRange(restaurantId, start, end);
    if (count == null) {
        res.status(400).send({ Error: "Oops something went wrong" });
    }
    try {
        /* read action — not audited (avoids log clutter) */
    }
    catch (err) {
        logger.warn({ err }, 'log_audit get-withen-range failed');
    }
    res.send(count);
});
app.get("/audit-logs", validateAction("91b24293-7b88-4fe4-8cf5-deb6faaba4f5"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const limit = clampLimit(req.query.limit, 100, 500);
    try {
        const logs = await GetAuditLogs(restaurantId, limit);
        // try {
        // 	await log_audit(req, "91b24293-7b88-4fe4-8cf5-deb6faaba4f5", `Fetched audit logs`, Audit_log_category.General, { limit });
        // } catch (err) {
        // 	console.warn('log_audit get-audit-logs failed', err);
        // }
        res.json(logs);
    }
    catch (error) {
        res.status(500).json({ error: "Unable to fetch audit logs" });
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
app.get("/inventory", validateAction("77e41c84-ebf4-4542-a75b-c9e72e03b570"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    try {
        const items = await GetInventoryItems(restaurantId);
        try {
            /* read action — not audited (avoids log clutter) */
        }
        catch (err) {
            logger.warn({ err }, 'log_audit get-inventory failed');
        }
        res.json(items);
    }
    catch (error) {
        logger.error({ err: error }, "get_inventory_failed");
        res.status(500).json({ error: "Unable to fetch inventory" });
    }
});
app.post("/inventory", validateAction("dfe2cde8-c159-4685-b015-ec7b0d4386eb"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = (req.body ?? {});
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
    }
    catch (error) {
        logger.error({ err: error }, "upsert_inventory_failed");
        res.status(500).json({ error: "Unable to save inventory item" });
    }
});
// --- Vendors + stock movements (purchases / wastage) ------------------------
const INV_VIEW = "77e41c84-ebf4-4542-a75b-c9e72e03b570";
const INV_MANAGE = "dfe2cde8-c159-4685-b015-ec7b0d4386eb";
app.get("/vendors", validateAction(INV_VIEW), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    try {
        res.json({ vendors: await GetVendors(restaurantId) });
    }
    catch (e) {
        logger.error({ err: e }, "get_vendors_failed");
        res.status(500).json({ error: "Unable to fetch vendors" });
    }
});
app.post("/vendors", validateAction(INV_MANAGE), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const b = (req.body ?? {});
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) {
        res.status(400).json({ error: "Vendor name is required" });
        return;
    }
    try {
        res.status(201).json(await AddVendor(restaurantId, { name, phone: typeof b.phone === "string" ? b.phone : undefined, email: typeof b.email === "string" ? b.email : undefined, notes: typeof b.notes === "string" ? b.notes : undefined }));
    }
    catch (e) {
        logger.error({ err: e }, "add_vendor_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to add vendor") });
    }
});
app.put("/vendors/:id", validateAction(INV_MANAGE), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    const b = (req.body ?? {});
    try {
        await UpdateVendor(restaurantId, id, { name: typeof b.name === "string" ? b.name : undefined, phone: typeof b.phone === "string" ? b.phone : undefined, email: typeof b.email === "string" ? b.email : undefined, notes: typeof b.notes === "string" ? b.notes : undefined });
        res.json({ success: true });
    }
    catch (e) {
        logger.error({ err: e }, "update_vendor_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to update vendor") });
    }
});
app.delete("/vendors/:id", validateAction(INV_MANAGE), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    try {
        await DeleteVendor(restaurantId, id);
        res.json({ success: true });
    }
    catch (e) {
        logger.error({ err: e }, "delete_vendor_failed");
        res.status(400).json({ error: "Unable to delete vendor" });
    }
});
app.post("/inventory/receive", validateAction(INV_MANAGE), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const b = (req.body ?? {});
    const inventory_id = typeof b.inventory_id === "string" ? b.inventory_id.trim() : "";
    const qty = Number(b.qty ?? 0) || 0;
    if (!inventory_id || qty <= 0) {
        res.status(400).json({ error: "inventory_id and a positive qty are required" });
        return;
    }
    try {
        const r = await ReceiveStock(restaurantId, { inventory_id, qty, vendor_id: typeof b.vendor_id === "string" ? b.vendor_id : undefined, unit_cost: typeof b.unit_cost === "number" ? b.unit_cost : undefined, note: typeof b.note === "string" ? b.note : undefined, createdBy: extractEmployeeId(req) ?? undefined });
        try {
            await log_audit(req, INV_MANAGE, `Received ${qty} stock`, Audit_log_category.Inventory, { inventory_id });
        }
        catch { /* ignore */ }
        res.json(r);
    }
    catch (e) {
        logger.error({ err: e }, "receive_stock_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to receive stock") });
    }
});
app.post("/inventory/wastage", validateAction(INV_MANAGE), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const b = (req.body ?? {});
    const inventory_id = typeof b.inventory_id === "string" ? b.inventory_id.trim() : "";
    const qty = Number(b.qty ?? 0) || 0;
    if (!inventory_id || qty <= 0) {
        res.status(400).json({ error: "inventory_id and a positive qty are required" });
        return;
    }
    try {
        const r = await RecordWastage(restaurantId, { inventory_id, qty, reason: typeof b.reason === "string" ? b.reason : undefined, createdBy: extractEmployeeId(req) ?? undefined });
        try {
            await log_audit(req, INV_MANAGE, `Wastage ${qty}`, Audit_log_category.Inventory, { inventory_id });
        }
        catch { /* ignore */ }
        res.json(r);
    }
    catch (e) {
        logger.error({ err: e }, "record_wastage_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to record wastage") });
    }
});
app.get("/inventory/movements", validateAction(INV_VIEW), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    try {
        res.json({ movements: await GetStockMovements(restaurantId, from, to) });
    }
    catch (e) {
        logger.error({ err: e }, "get_movements_failed");
        res.status(500).json({ error: "Unable to fetch movements" });
    }
});
// --- Purchase orders ---
app.get("/purchase-orders", validateAction(INV_VIEW), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    try {
        res.json({ orders: await GetPurchaseOrders(restaurantId, { status, from, to }) });
    }
    catch (e) {
        logger.error({ err: e }, "get_purchase_orders_failed");
        res.status(500).json({ error: "Unable to fetch purchase orders" });
    }
});
app.get("/purchase-orders/:id", validateAction(INV_VIEW), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    try {
        const order = await GetPurchaseOrder(restaurantId, String(req.params.id));
        if (!order) {
            res.status(404).json({ error: "Purchase order not found" });
            return;
        }
        res.json(order);
    }
    catch (e) {
        logger.error({ err: e }, "get_purchase_order_failed");
        res.status(500).json({ error: "Unable to fetch purchase order" });
    }
});
app.post("/purchase-orders", validateAction(INV_MANAGE), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const b = (req.body ?? {});
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
        try {
            await log_audit(req, INV_MANAGE, `Created purchase order ${created.id} (${created.items.length} items, ${created.total_cost})`, Audit_log_category.Inventory, { id: created.id });
        }
        catch { /* ignore */ }
        res.json(created);
    }
    catch (e) {
        logger.error({ err: e }, "create_purchase_order_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to create purchase order") });
    }
});
app.post("/purchase-orders/:id/status", validateAction(INV_MANAGE), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const b = (req.body ?? {});
    const status = typeof b.status === "string" ? b.status : "";
    try {
        const updated = await SetPurchaseOrderStatus(restaurantId, String(req.params.id), status);
        try {
            await log_audit(req, INV_MANAGE, `Purchase order ${updated.id} → ${updated.status}`, Audit_log_category.Inventory, { id: updated.id });
        }
        catch { /* ignore */ }
        res.json(updated);
    }
    catch (e) {
        logger.error({ err: e }, "set_po_status_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to update purchase order") });
    }
});
app.post("/purchase-orders/:id/receive", validateAction(INV_MANAGE), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const b = (req.body ?? {});
    const lines = Array.isArray(b.lines)
        ? b.lines.map((l) => ({ inventory_id: String(l?.inventory_id ?? ""), qty_received: Number(l?.qty_received ?? 0) || 0 }))
        : [];
    try {
        const updated = await ReceivePurchaseOrder(restaurantId, String(req.params.id), lines, extractEmployeeId(req) ?? undefined);
        try {
            await log_audit(req, INV_MANAGE, `Received against purchase order ${updated.id} (now ${updated.status})`, Audit_log_category.Inventory, { id: updated.id });
        }
        catch { /* ignore */ }
        res.json(updated);
    }
    catch (e) {
        logger.error({ err: e }, "receive_po_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to receive purchase order") });
    }
});
app.delete("/purchase-orders/:id", validateAction(INV_MANAGE), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    try {
        await DeletePurchaseOrder(restaurantId, String(req.params.id));
        try {
            await log_audit(req, INV_MANAGE, `Deleted purchase order ${req.params.id}`, Audit_log_category.Inventory, { id: req.params.id });
        }
        catch { /* ignore */ }
        res.json({ success: true });
    }
    catch (e) {
        logger.error({ err: e }, "delete_po_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to delete purchase order") });
    }
});
app.delete("/inventory/:id", validateAction("add0a9ec-a563-4903-9a24-d2e0b46361a5"), async (req, res) => {
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
    }
    catch (error) {
        logger.error({ err: error }, "delete_inventory_failed");
        res.status(500).json({ error: "Unable to delete inventory item" });
    }
});
app.get("/menu", validateAction("f4177b38-77fa-4d8c-9fbd-c4f06bf28610"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    try {
        const items = await GetMenuItems(restaurantId);
        res.json(items);
    }
    catch (error) {
        logger.error({ err: error }, "get_menu_failed");
        res.status(500).json({ error: "Unable to fetch menu" });
    }
});
app.get("/menu/categories", validateAction("f4177b38-77fa-4d8c-9fbd-c4f06bf28610"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    try {
        const categories = await GetMenuCategories(restaurantId);
        res.json(categories);
    }
    catch (error) {
        logger.error({ err: error }, "get_menu_categories_failed");
        res.status(500).json({ error: "Unable to fetch menu categories" });
    }
});
app.post("/menu", validateAction("88a87943-8f0b-43e2-b85e-192fdc901ed2"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = (req.body ?? {});
    if (typeof body.name !== "string" || typeof body.category !== "string") {
        res.status(400).json({ error: "name and category are required" });
        return;
    }
    try {
        const result = await UpsertMenuItem(restaurantId, {
            id: typeof body.id === "string" ? body.id : "",
            name: body.name,
            price: Number(body.price ?? 0),
            category: body.category,
            image_url: typeof body.image_url === "string" ? body.image_url : null,
            available: typeof body.available === "boolean" ? body.available : true,
            modifiers: Array.isArray(body.modifiers) ? body.modifiers : [],
            recipe: Array.isArray(body.recipe) ? body.recipe : [],
        });
        try {
            await log_audit(req, "88a87943-8f0b-43e2-b85e-192fdc901ed2", `Saved menu item ${body.name}`, Audit_log_category.Menu, { id: result.id, available: body.available });
        }
        catch (err) {
            logger.warn({ err }, "log_audit menu-upsert failed");
        }
        res.status(201).json(result);
    }
    catch (error) {
        logger.error({ err: error }, "upsert_menu_item_failed");
        res.status(500).json({ error: "Unable to save menu item" });
    }
});
app.post("/menu/upload-image", validateAction("88a87943-8f0b-43e2-b85e-192fdc901ed2"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = (req.body ?? {});
    const b64 = typeof body.image_base64 === "string" ? body.image_base64 : "";
    const ct = typeof body.content_type === "string" ? body.content_type : "image/jpeg";
    if (!b64) {
        res.status(400).json({ error: "image_base64 is required" });
        return;
    }
    try {
        const url = await uploadMenuImage(b64, ct);
        if (!url) {
            res.status(502).json({ error: "Image upload failed (storage not configured)" });
            return;
        }
        res.json({ image_url: url });
    }
    catch (err) {
        logger.error({ err }, "menu_upload_image_failed");
        res.status(500).json({ error: "Unable to upload image" });
    }
});
// Set the restaurant's customer-facing branding (logo + theme color). Accepts a
// logo as a hosted URL or base64 (uploaded server-side).
app.post("/restaurant/branding", validate, async (req, res) => {
    if (!(await enforceAdmin(req, res)))
        return;
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = (req.body ?? {});
    let logoUrl = typeof body.logo_url === "string" ? body.logo_url.trim() : undefined;
    const themeColor = typeof body.theme_color === "string" && /^#[0-9a-fA-F]{6}$/.test(body.theme_color)
        ? body.theme_color
        : undefined;
    try {
        if (!logoUrl && typeof body.logo_base64 === "string" && body.logo_base64.length > 0) {
            const url = await uploadMenuImage(body.logo_base64, typeof body.content_type === "string" ? body.content_type : "image/png");
            if (url)
                logoUrl = url;
        }
        const result = await SetBranding(restaurantId, { logo_url: logoUrl ?? null, theme_color: themeColor ?? null });
        try {
            await log_audit(req, "60d14e9c-45cc-4dc2-b017-56058cc3ae33", `Updated customer-page branding`, Audit_log_category.General, { theme_color: result.theme_color, logo: !!result.logo_url });
        }
        catch (err) {
            logger.warn({ err }, "log_audit branding failed");
        }
        res.json(result);
    }
    catch (err) {
        logger.error({ err }, "set_branding_failed");
        res.status(500).json({ error: "Unable to save branding" });
    }
});
// Restaurant operational settings (e.g. push orders straight to kitchen vs. require approval).
app.get("/restaurant/settings", validate, async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    try {
        res.json(await GetRestaurantSettings(restaurantId));
    }
    catch (err) {
        logger.error({ err }, "get_settings_failed");
        res.status(500).json({ error: "Unable to load settings" });
    }
});
app.post("/restaurant/settings", validate, async (req, res) => {
    // Settings hold payment keys, taxes and operational toggles — admin-only.
    if (!(await enforceAdmin(req, res)))
        return;
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = (req.body ?? {});
    try {
        const result = await SetRestaurantSettings(restaurantId, {
            auto_push_orders: typeof body.auto_push_orders === "boolean" ? body.auto_push_orders : undefined,
            currency: typeof body.currency === "string" ? body.currency : undefined,
            payment_methods: Array.isArray(body.payment_methods) ? body.payment_methods : undefined,
            taxes: Array.isArray(body.taxes) ? body.taxes : undefined,
            razorpay_key_id: typeof body.razorpay_key_id === "string" ? body.razorpay_key_id : undefined,
            razorpay_key_secret: typeof body.razorpay_key_secret === "string" ? body.razorpay_key_secret : undefined,
            service_charge: typeof body.service_charge === "number" ? body.service_charge : undefined,
            feedback_config: body.feedback_config !== undefined ? body.feedback_config : undefined,
            bill_logo_svg: body.bill_logo_svg !== undefined ? body.bill_logo_svg : undefined,
            bill_paper_width: body.bill_paper_width !== undefined ? body.bill_paper_width : undefined,
        });
        try {
            await log_audit(req, "60d14e9c-45cc-4dc2-b017-56058cc3ae33", `Updated restaurant settings`, Audit_log_category.General, { auto_push_orders: result.auto_push_orders, currency: result.currency });
        }
        catch (err) {
            logger.warn({ err }, "log_audit settings failed");
        }
        res.json(result);
    }
    catch (err) {
        logger.error({ err }, "set_settings_failed");
        res.status(500).json({ error: "Unable to save settings" });
    }
});
// --- Staff notifications (bell) --------------------------------------------
app.get("/notifications", validate, async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    try {
        res.json(await GetNotifications(restaurantId));
    }
    catch (err) {
        logger.error({ err }, "get_notifications_failed");
        res.status(500).json({ error: "Unable to load notifications" });
    }
});
app.post("/notifications/read-all", validate, async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    try {
        await MarkAllNotificationsRead(restaurantId);
        res.json({ success: true });
    }
    catch (err) {
        logger.error({ err }, "notif_read_all_failed");
        res.status(500).json({ error: "Unable to update" });
    }
});
app.post("/notifications/:id/read", validate, async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    try {
        await MarkNotificationRead(restaurantId, String(req.params.id));
        res.json({ success: true });
    }
    catch (err) {
        logger.error({ err }, "notif_read_failed");
        res.status(500).json({ error: "Unable to update" });
    }
});
app.delete("/notifications/:id", validate, async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    try {
        await DeleteNotification(restaurantId, String(req.params.id));
        res.json({ success: true });
    }
    catch (err) {
        logger.error({ err }, "notif_delete_failed");
        res.status(500).json({ error: "Unable to delete" });
    }
});
app.delete("/notifications", validate, async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    try {
        await ClearNotifications(restaurantId);
        res.json({ success: true });
    }
    catch (err) {
        logger.error({ err }, "notif_clear_failed");
        res.status(500).json({ error: "Unable to clear" });
    }
});
// Public read of branding (used by the reservation page).
app.get("/qr/:slug/branding", async (req, res) => {
    const slug = String(req.params.slug ?? "").trim();
    let resId = null;
    try {
        resId = await getRestaurantIdFromUsername(slug);
    }
    catch {
        resId = null;
    }
    if (!resId) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
    }
    try {
        const result = await withTenant({ res_id: resId, outlet_id: "", employeeId: "", role: "" }, async () => {
            const [profile, branding] = await Promise.all([
                GetRestaurantProfile(slug),
                GetPublicBranding(slug).catch(() => ({ logo_url: null, theme_color: null, theme_primary: null, theme_secondary: null, currency: "₹", payment_methods: [] })),
            ]);
            return { restaurant_name: profile?.restaurant_name ?? slug, ...branding };
        });
        res.json(result);
    }
    catch (err) {
        logger.error({ err }, "qr_branding_failed");
        res.status(500).json({ error: "Unable to load branding" });
    }
});
app.put("/menu", validateAction("ed800655-b937-44ba-a7ca-7458295886c9"), async (req, res) => {
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
        await SaveMenuItems(restaurantId, items.map((item) => ({
            id: String(item.id ?? ""),
            name: String(item.name ?? ""),
            price: Number(item.price ?? 0),
            category: String(item.category ?? "General"),
            image_url: typeof item.image_url === "string" ? item.image_url : null,
            available: typeof item.available === "boolean" ? item.available : true,
            modifiers: Array.isArray(item.modifiers) ? item.modifiers : [],
            recipe: Array.isArray(item.recipe) ? item.recipe : [],
        })));
        try {
            await log_audit(req, "ed800655-b937-44ba-a7ca-7458295886c9", `Saved menu (${items.length} items)`, Audit_log_category.Menu, { count: items.length });
        }
        catch (err) {
            logger.warn({ err }, "log_audit menu-save failed");
        }
        res.json({ success: true });
    }
    catch (error) {
        logger.error({ err: error }, "save_menu_failed");
        res.status(500).json({ error: "Unable to save menu" });
    }
});
app.post("/menu/categories", validateAction("88a87943-8f0b-43e2-b85e-192fdc901ed2"), async (req, res) => {
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
        try {
            await log_audit(req, "88a87943-8f0b-43e2-b85e-192fdc901ed2", `Added menu category ${category}`, Audit_log_category.Menu, { category });
        }
        catch (err) {
            logger.warn({ err }, "log_audit add-category failed");
        }
        res.status(201).json({ success: true });
    }
    catch (error) {
        logger.error({ err: error }, "ensure_menu_category_failed");
        res.status(500).json({ error: "Unable to save category" });
    }
});
app.delete("/menu/categories", validateAction("ed800655-b937-44ba-a7ca-7458295886c9"), async (req, res) => {
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
        try {
            await log_audit(req, "ed800655-b937-44ba-a7ca-7458295886c9", `Deleted menu category ${category}`, Audit_log_category.Menu, { category, deletedItems: result.deletedItems });
        }
        catch (err) {
            logger.warn({ err }, "log_audit delete-category failed");
        }
        res.json({ success: true, deletedItems: result.deletedItems });
    }
    catch (error) {
        logger.error({ err: error }, "delete_menu_category_failed");
        res.status(500).json({ error: "Unable to delete category" });
    }
});
app.get("/orders", validateAction("b7f78d0f-323d-4622-8d05-aa2f82d54b2e"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    try {
        const items = await GetOrders(restaurantId);
        res.json(items);
    }
    catch (error) {
        logger.error({ err: error }, "get_orders_failed");
        res.status(500).json({ error: "Unable to fetch orders" });
    }
});
app.post("/orders", validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    try {
        const result = await AddOrder(restaurantId, req.body ?? {});
        res.status(201).json(result);
    }
    catch (error) {
        logger.error({ err: error }, "add_order_failed");
        res.status(400).json({ error: String(error?.message ?? "Unable to add order") });
    }
});
// Place a takeaway / delivery order (no physical table — a hidden virtual table
// is provisioned to carry the bill).
app.post("/orders/takeaway", validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = (req.body ?? {});
    const orderType = String(body.order_type ?? "takeaway").toLowerCase() === "delivery" ? "delivery" : "takeaway";
    if (!Array.isArray(body.items) || body.items.length === 0) {
        res.status(400).json({ error: "At least one item is required" });
        return;
    }
    try {
        const result = await AddTakeawayOrder(restaurantId, { ...body, order_type: orderType });
        try {
            await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `New ${orderType} order ${result.id}`, Audit_log_category.Orders, { order_id: result.id, order_type: orderType });
        }
        catch { /* ignore */ }
        res.status(201).json(result);
    }
    catch (error) {
        logger.error({ err: error }, "add_takeaway_order_failed");
        res.status(400).json({ error: String(error?.message ?? "Unable to add order") });
    }
});
// Advance a single order's stage (Preparing -> Served -> ...). Used by the
// orders list and the kitchen display.
app.patch("/orders/:id/status", validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const orderId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    const status = typeof req.body?.status === "string" ? req.body.status.trim() : "";
    if (!orderId || !status) {
        res.status(400).json({ error: "orderId and status are required" });
        return;
    }
    try {
        const ok = await SetOrderStatus(restaurantId, orderId, status);
        if (!ok) {
            res.status(404).json({ error: "Order not found" });
            return;
        }
        try {
            await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Order ${orderId} -> ${status}`, Audit_log_category.Orders, { order_id: orderId, status });
        }
        catch (e) {
            logger.warn({ err: e }, "log_audit order status failed");
        }
        res.json({ success: true });
    }
    catch (error) {
        logger.error({ err: error }, "set_order_status_failed");
        res.status(400).json({ error: String(error?.message ?? "Unable to update order status") });
    }
});
// Add single item to existing order (adds to Preparing section and logs audit)
app.post('/orders/:id/items', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: 'Missing restaurantId' });
        return;
    }
    const orderId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!orderId) {
        res.status(400).json({ error: 'Missing order id' });
        return;
    }
    const item = req.body ?? {};
    try {
        // fetch existing order
        const existing = await GetOrders(restaurantId);
        const order = existing.find(o => o.id === orderId);
        if (!order) {
            res.status(404).json({ error: 'Order not found' });
            return;
        }
        // build items_split if missing; clone to avoid mutating source
        const rawSplit = Array.isArray(order.items_split) ? JSON.parse(JSON.stringify(order.items_split)) : [["Served", []], ["Preparing", []]];
        // normalize tuples: ensure each tuple is [label, array] and dedupe items across tuples (preserve first occurrence)
        const seenIds = new Set();
        const normalizedSplit = [];
        for (const tup of rawSplit) {
            const label = String(tup?.[0] ?? "").trim() || "";
            const arr = Array.isArray(tup?.[1]) ? tup[1] : [];
            const filtered = [];
            for (const it of arr) {
                const id = String((it && it.id) ?? "");
                if (!id)
                    continue;
                if (seenIds.has(id))
                    continue;
                seenIds.add(id);
                filtered.push(it);
            }
            normalizedSplit.push([label, filtered]);
        }
        // ensure we have a Preparing tuple to add the new item into
        let preparingIndex = normalizedSplit.findIndex((t) => String(t?.[0] ?? "").toLowerCase().includes('prepar'));
        const newItem = { id: String(item.id ?? randomUUID()), name: String(item.name ?? 'Unknown'), quantity: Number(item.quantity ?? 1), price: Number(item.price ?? 0), orderedAt: String(item.orderedAt ?? new Date().toISOString()), note: item.note ?? null };
        if (preparingIndex === -1) {
            normalizedSplit.push(["Preparing", [newItem]]);
        }
        else {
            normalizedSplit[preparingIndex][1] = normalizedSplit[preparingIndex][1] || [];
            normalizedSplit[preparingIndex][1].push(newItem);
        }
        const split = normalizedSplit;
        await UpdateOrderItemsSplit(restaurantId, orderId, split);
        try {
            await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Added item ${newItem.id} to order ${orderId}`, Audit_log_category.Bill, { order_id: orderId, item: newItem });
        }
        catch (err) {
            logger.warn({ err }, 'log_audit add-order-item failed');
        }
        res.status(201).json({ success: true, item: newItem });
    }
    catch (err) {
        logger.error({ err }, 'add_order_item_failed');
        res.status(500).json({ error: String(err?.message ?? 'Unable to add item') });
    }
});
// Delete single item from order
app.delete('/orders/:id/items/:itemId', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: 'Missing restaurantId' });
        return;
    }
    const orderId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    const itemId = typeof req.params.itemId === 'string' ? req.params.itemId.trim() : '';
    if (!orderId || !itemId) {
        res.status(400).json({ error: 'Missing order id or item id' });
        return;
    }
    try {
        const existing = await GetOrders(restaurantId);
        const order = existing.find(o => o.id === orderId);
        if (!order) {
            res.status(404).json({ error: 'Order not found' });
            return;
        }
        const split = order.items_split ?? [["Served", []], ["Preparing", []]];
        // remove item from both sections
        for (const tuple of split) {
            if (Array.isArray(tuple[1])) {
                const before = tuple[1].length;
                tuple[1] = tuple[1].filter((it) => String(it.id) !== itemId);
                const after = tuple[1].length;
                if (after !== before)
                    break;
            }
        }
        await UpdateOrderItemsSplit(restaurantId, orderId, split);
        try {
            await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Deleted item ${itemId} from order ${orderId}`, Audit_log_category.Bill, { order_id: orderId, deleted_item_id: itemId });
        }
        catch (err) {
            logger.warn({ err }, 'log_audit delete-order-item failed');
        }
        res.json({ success: true });
    }
    catch (err) {
        logger.error({ err }, 'delete_order_item_failed');
        res.status(500).json({ error: String(err?.message ?? 'Unable to delete item') });
    }
});
app.delete("/orders/:id", validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req, res) => {
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
        res.status(204).send();
    }
    catch (error) {
        logger.error({ err: error }, "delete_order_failed");
        res.status(400).json({ error: String(error?.message ?? "Unable to delete order") });
    }
});
app.get("/orders/apc", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), async (req, res) => {
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
    let monthStart;
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
    }
    catch (error) {
        logger.error({ err: error }, "get_orders_apc_failed");
        res.status(500).json({ error: "Unable to fetch APC insights" });
    }
});
// --- Order/item preparation timers (pause/resume, mark item served) ---------
const ORDER_ACTION = "4ad474d4-5230-449c-874f-6a238b833bca";
async function handleTiming(req, res, action, withItem) {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const orderId = String(req.params.id ?? "").trim();
    const itemId = withItem ? String(req.params.itemId ?? "").trim() : undefined;
    if (!orderId || (withItem && !itemId)) {
        res.status(400).json({ error: "order id (and item id) required" });
        return;
    }
    try {
        const ok = await OrderTimingAction(restaurantId, orderId, action, itemId);
        if (!ok) {
            res.status(404).json({ error: "Order not found" });
            return;
        }
        try {
            await log_audit(req, ORDER_ACTION, `Timer ${action}${itemId ? ` item ${itemId}` : ""} on order ${orderId}`, Audit_log_category.Orders, { order_id: orderId, item_id: itemId, action });
        }
        catch { /* ignore */ }
        res.json({ success: true });
    }
    catch (err) {
        logger.error({ err }, "order_timing_failed");
        res.status(400).json({ error: String(err?.message ?? "Unable to update timer") });
    }
}
app.post("/orders/:id/pause", validateAction(ORDER_ACTION), (req, res) => handleTiming(req, res, "pause", false));
app.post("/orders/:id/resume", validateAction(ORDER_ACTION), (req, res) => handleTiming(req, res, "resume", false));
app.post("/orders/:id/items/:itemId/serve", validateAction(ORDER_ACTION), (req, res) => handleTiming(req, res, "serve", true));
app.post("/orders/:id/items/:itemId/pause", validateAction(ORDER_ACTION), (req, res) => handleTiming(req, res, "pause", true));
app.post("/orders/:id/items/:itemId/resume", validateAction(ORDER_ACTION), (req, res) => handleTiming(req, res, "resume", true));
app.get("/orders/timing-stats", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    try {
        res.json(await GetTimingStats(restaurantId));
    }
    catch (err) {
        logger.error({ err }, "timing_stats_failed");
        res.status(500).json({ error: "Unable to fetch timing stats" });
    }
});
// Daily revenue/order series for trend charts.
app.get("/orders/daily-revenue", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const daysRaw = typeof req.query.days === "string" ? Number.parseInt(req.query.days, 10) : 14;
    try {
        const series = await GetDailyRevenueSeries(restaurantId, Number.isFinite(daysRaw) ? daysRaw : 14);
        res.json({ series });
    }
    catch (error) {
        logger.error({ err: error }, "get_daily_revenue_failed");
        res.status(500).json({ error: "Unable to fetch daily revenue" });
    }
});
// Actionable menu/staff analytics: top-selling dishes, slow movers, data-driven
// price suggestions, and revenue by waiter over the last ?days days (default 30).
app.get("/analytics/menu-insights", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const daysRaw = typeof req.query.days === "string" ? Number.parseInt(req.query.days, 10) : 30;
    try {
        res.json(await GetMenuPerformanceInsights(restaurantId, Number.isFinite(daysRaw) ? daysRaw : 30));
    }
    catch (error) {
        logger.error({ err: error }, "get_menu_insights_failed");
        res.status(500).json({ error: "Unable to fetch menu insights" });
    }
});
// --- Accounting & reporting --------------------------------------------------
// Gated by the analytics/financial-reports permission.
const ACCOUNTING_PERM = "df75119b-e5f1-4f38-aba5-78a1cf182f56";
function toCsv(headers, rows) {
    const esc = (v) => {
        const s = String(v ?? "");
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}
function reportRange(req) {
    return {
        from: typeof req.query.from === "string" ? req.query.from : undefined,
        to: typeof req.query.to === "string" ? req.query.to : undefined,
    };
}
app.get("/expenses", validateAction(ACCOUNTING_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const { from, to } = reportRange(req);
    try {
        res.json({ expenses: await GetExpenses(restaurantId, from, to) });
    }
    catch (e) {
        logger.error({ err: e }, "get_expenses_failed");
        res.status(500).json({ error: "Unable to fetch expenses" });
    }
});
app.post("/expenses", validateAction(ACCOUNTING_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = (req.body ?? {});
    const amount = Number(body.amount ?? 0) || 0;
    if (amount <= 0) {
        res.status(400).json({ error: "A positive amount is required" });
        return;
    }
    try {
        const created = await AddExpense(restaurantId, {
            amount,
            category: typeof body.category === "string" ? body.category : undefined,
            vendor: typeof body.vendor === "string" ? body.vendor : undefined,
            note: typeof body.note === "string" ? body.note : undefined,
            spent_on: typeof body.spent_on === "string" ? body.spent_on : undefined,
            createdBy: extractEmployeeId(req) ?? undefined,
        });
        try {
            await log_audit(req, ACCOUNTING_PERM, `Added expense ${created.category} ${created.amount}`, Audit_log_category.Bill, { id: created.id });
        }
        catch { /* ignore */ }
        res.json(created);
    }
    catch (e) {
        logger.error({ err: e }, "add_expense_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to add expense") });
    }
});
app.delete("/expenses/:id", validateAction(ACCOUNTING_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) {
        res.status(400).json({ error: "Missing id" });
        return;
    }
    try {
        await DeleteExpense(restaurantId, id);
        try {
            await log_audit(req, ACCOUNTING_PERM, `Deleted expense ${id}`, Audit_log_category.Bill, { id });
        }
        catch { /* ignore */ }
        res.json({ success: true });
    }
    catch (e) {
        logger.error({ err: e }, "delete_expense_failed");
        res.status(400).json({ error: "Unable to delete expense" });
    }
});
// --- Waitlist / queue (staff) ---
const WAITLIST_PERM = "090ea8d4-e348-4e1b-9723-11131a73a085"; // front-of-house (tables/occupy)
app.get("/waitlist", validateAction(WAITLIST_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    try {
        res.json({ entries: await GetWaitlist(restaurantId) });
    }
    catch (e) {
        logger.error({ err: e }, "waitlist_list_failed");
        res.status(500).json({ error: "Unable to fetch waitlist" });
    }
});
app.post("/waitlist/:id/call", validateAction(WAITLIST_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    try {
        const entry = await CallWaitlistEntry(restaurantId, String(req.params.id));
        try {
            emitRestaurant(restaurantId, "waitlist:updated", { action: "call", id: entry.id });
        }
        catch { /* ignore */ }
        try {
            await log_audit(req, WAITLIST_PERM, `Called queue party ${entry.name}`, Audit_log_category.Tables, { id: entry.id });
        }
        catch { /* ignore */ }
        res.json(entry);
    }
    catch (e) {
        logger.error({ err: e }, "waitlist_call_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to call this party") });
    }
});
app.post("/waitlist/:id/seat", validateAction(WAITLIST_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = (req.body ?? {});
    const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
    if (!tableName) {
        res.status(400).json({ error: "table_name is required" });
        return;
    }
    try {
        const r = await SeatWaitlistEntry(restaurantId, String(req.params.id), tableName, extractEmployeeId(req) ?? undefined);
        try {
            emitRestaurant(restaurantId, "waitlist:updated", { action: "seat" });
        }
        catch { /* ignore */ }
        try {
            await log_audit(req, WAITLIST_PERM, `Seated queue party at ${r.table_name}`, Audit_log_category.Tables, { table: r.table_name, order: r.placed_order_id });
        }
        catch { /* ignore */ }
        res.json(r);
    }
    catch (e) {
        logger.error({ err: e }, "waitlist_seat_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to seat this party") });
    }
});
app.post("/waitlist/:id/cancel", validateAction(WAITLIST_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = (req.body ?? {});
    const status = body.status === "no_show" ? "no_show" : "cancelled";
    try {
        await CancelWaitlistEntry(restaurantId, String(req.params.id), status);
        try {
            emitRestaurant(restaurantId, "waitlist:updated", { action: "cancel" });
        }
        catch { /* ignore */ }
        res.json({ success: true });
    }
    catch (e) {
        logger.error({ err: e }, "waitlist_cancel_staff_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to update the queue") });
    }
});
// --- Tenant subscription & billing (restaurant admin) ----------------------
// Platform-account Razorpay keys (separate from each restaurant's OWN Razorpay,
// which collects dine-in payments). These collect the SaaS subscription fee.
const PLATFORM_RAZORPAY_KEY_ID = process.env.PLATFORM_RAZORPAY_KEY_ID || "";
const PLATFORM_RAZORPAY_KEY_SECRET = process.env.PLATFORM_RAZORPAY_KEY_SECRET || "";
const platformRazorpayReady = Boolean(PLATFORM_RAZORPAY_KEY_ID && PLATFORM_RAZORPAY_KEY_SECRET);
app.get("/billing", async (req, res) => {
    const auth = await enforceAdmin(req, res);
    if (!auth)
        return;
    if (!billingConfigured()) {
        res.json({ configured: false, online_pay: false, subscription: null, plan: null, pending_plan: null, plans: [], invoices: [] });
        return;
    }
    try {
        const data = await getTenantBilling(auth.restaurantId);
        res.json({ configured: true, online_pay: platformRazorpayReady, ...data });
    }
    catch (e) {
        logger.error({ err: e }, "billing_get_failed");
        res.status(500).json({ error: "Unable to load billing" });
    }
});
app.post("/billing/change-plan", async (req, res) => {
    const auth = await enforceAdmin(req, res);
    if (!auth)
        return;
    const body = (req.body ?? {});
    const planId = typeof body.plan_id === "string" ? body.plan_id.trim() : "";
    if (!planId) {
        res.status(400).json({ error: "plan_id is required" });
        return;
    }
    try {
        const result = await requestPlanChange(auth.restaurantId, planId);
        res.json(result);
    }
    catch (e) {
        logger.error({ err: e }, "billing_change_plan_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to change plan") });
    }
});
app.post("/billing/pay/create", async (req, res) => {
    const auth = await enforceAdmin(req, res);
    if (!auth)
        return;
    if (!platformRazorpayReady) {
        res.status(503).json({ error: "Online payment isn't set up. Your provider will confirm the payment manually." });
        return;
    }
    const body = (req.body ?? {});
    const invoiceId = typeof body.invoice_id === "string" ? body.invoice_id.trim() : "";
    if (!invoiceId) {
        res.status(400).json({ error: "invoice_id is required" });
        return;
    }
    try {
        const inv = await getInvoice(invoiceId);
        if (!inv || inv.res_id !== auth.restaurantId) {
            res.status(404).json({ error: "Invoice not found" });
            return;
        }
        if (inv.status === "paid") {
            res.status(409).json({ error: "This invoice is already paid" });
            return;
        }
        const rp = await fetchWithTimeout("https://api.razorpay.com/v1/orders", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Basic " + Buffer.from(`${PLATFORM_RAZORPAY_KEY_ID}:${PLATFORM_RAZORPAY_KEY_SECRET}`).toString("base64"),
            },
            body: JSON.stringify({ amount: Math.max(100, Math.round(inv.amount_cents)), currency: "INR", receipt: `inv_${inv.id}` }),
        });
        if (!rp.ok) {
            const t = await rp.text().catch(() => "");
            logger.error({ status: rp.status, body: t.slice(0, 300) }, "platform_razorpay_order_failed");
            res.status(502).json({ error: "Payment gateway error" });
            return;
        }
        const order = await rp.json();
        // Bind the order to THIS invoice so verify can require they match.
        await setInvoiceOrderId(inv.id, String(order.id));
        res.json({ order_id: order.id, amount: order.amount, currency: order.currency, key_id: PLATFORM_RAZORPAY_KEY_ID, invoice_id: inv.id });
    }
    catch (e) {
        logger.error({ err: e }, "billing_pay_create_failed");
        res.status(500).json({ error: "Unable to start payment" });
    }
});
app.post("/billing/pay/verify", async (req, res) => {
    const auth = await enforceAdmin(req, res);
    if (!auth)
        return;
    if (!platformRazorpayReady) {
        res.status(503).json({ error: "Online payment isn't set up." });
        return;
    }
    const body = (req.body ?? {});
    const invoiceId = typeof body.invoice_id === "string" ? body.invoice_id.trim() : "";
    const orderId = typeof body.razorpay_order_id === "string" ? body.razorpay_order_id : "";
    const paymentId = typeof body.razorpay_payment_id === "string" ? body.razorpay_payment_id : "";
    const signature = typeof body.razorpay_signature === "string" ? body.razorpay_signature : "";
    if (!invoiceId || !orderId || !paymentId || !signature) {
        res.status(400).json({ error: "invoice_id and razorpay_* fields are required" });
        return;
    }
    try {
        const inv = await getInvoice(invoiceId);
        if (!inv || inv.res_id !== auth.restaurantId) {
            res.status(404).json({ error: "Invoice not found" });
            return;
        }
        if (inv.status !== "pending") {
            res.status(409).json({ error: "This invoice is no longer payable" });
            return;
        }
        // The order MUST be the one we created for this invoice (no reusing another
        // order's valid signature to settle this invoice).
        if (!inv.razorpay_order_id || inv.razorpay_order_id !== orderId) {
            res.status(400).json({ error: "Payment does not match this invoice" });
            return;
        }
        // Signature authenticity (constant-time).
        const expected = createHmac("sha256", PLATFORM_RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
        if (!timingSafeStrEqual(expected, signature)) {
            res.status(400).json({ error: "Payment verification failed" });
            return;
        }
        // Independently confirm with Razorpay that THIS order was actually captured
        // for the FULL invoice amount (never trust the client's claim alone).
        const expectedAmount = Math.max(100, Math.round(inv.amount_cents));
        const ordRes = await fetchWithTimeout(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`, {
            headers: { Authorization: "Basic " + Buffer.from(`${PLATFORM_RAZORPAY_KEY_ID}:${PLATFORM_RAZORPAY_KEY_SECRET}`).toString("base64") },
        });
        if (!ordRes.ok) {
            logger.error({ err: ordRes.status }, "platform_razorpay_order_fetch_failed");
            res.status(502).json({ error: "Could not confirm payment with the gateway" });
            return;
        }
        const ord = await ordRes.json();
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
        }
        catch (e) {
            if (e?.code === "23505") {
                res.status(409).json({ error: "This payment has already been applied" });
                return;
            }
            throw e;
        }
        if (!result) {
            res.status(409).json({ error: "This invoice is already paid" });
            return;
        }
        res.json({ ok: true, ...result });
    }
    catch (e) {
        logger.error({ err: e }, "billing_pay_verify_failed");
        res.status(500).json({ error: "Unable to verify payment" });
    }
});
// --- Cash register / day-close ---
app.get("/cash/current", validateAction(ACCOUNTING_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    try {
        res.json({ session: await GetCurrentCashSession(restaurantId) });
    }
    catch (e) {
        logger.error({ err: e }, "cash_current_failed");
        res.status(500).json({ error: "Unable to fetch cash session" });
    }
});
app.post("/cash/open", validateAction(ACCOUNTING_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = (req.body ?? {});
    try {
        const session = await OpenCashSession(restaurantId, {
            opening_float: Number(body.opening_float ?? 0) || 0,
            openedBy: extractEmployeeId(req) ?? undefined,
        });
        try {
            await log_audit(req, ACCOUNTING_PERM, `Opened cash session (float ${session.opening_float})`, Audit_log_category.Bill, { id: session.id });
        }
        catch { /* ignore */ }
        res.json(session);
    }
    catch (e) {
        logger.error({ err: e }, "cash_open_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to open cash session") });
    }
});
app.post("/cash/close", validateAction(ACCOUNTING_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = (req.body ?? {});
    const counted = Number(body.counted_cash ?? NaN);
    if (!Number.isFinite(counted) || counted < 0) {
        res.status(400).json({ error: "counted_cash is required" });
        return;
    }
    try {
        const session = await CloseCashSession(restaurantId, {
            counted_cash: counted,
            cash_payouts: Number(body.cash_payouts ?? 0) || 0,
            notes: typeof body.notes === "string" ? body.notes : undefined,
            closedBy: extractEmployeeId(req) ?? undefined,
        });
        try {
            await log_audit(req, ACCOUNTING_PERM, `Closed cash session (variance ${session.variance})`, Audit_log_category.Bill, { id: session.id });
        }
        catch { /* ignore */ }
        res.json(session);
    }
    catch (e) {
        logger.error({ err: e }, "cash_close_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to close cash session") });
    }
});
app.get("/cash/sessions", validateAction(ACCOUNTING_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const { from, to } = reportRange(req);
    try {
        res.json({ sessions: await GetCashSessions(restaurantId, from, to) });
    }
    catch (e) {
        logger.error({ err: e }, "cash_sessions_failed");
        res.status(500).json({ error: "Unable to fetch cash sessions" });
    }
});
app.get("/reports/sales", validateAction(ACCOUNTING_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const { from, to } = reportRange(req);
    try {
        res.json(await GetSalesReport(restaurantId, from, to));
    }
    catch (e) {
        logger.error({ err: e }, "sales_report_failed");
        res.status(500).json({ error: "Unable to build sales report" });
    }
});
app.get("/reports/gst", validateAction(ACCOUNTING_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const { from, to } = reportRange(req);
    try {
        res.json(await GetGstReport(restaurantId, from, to));
    }
    catch (e) {
        logger.error({ err: e }, "gst_report_failed");
        res.status(500).json({ error: "Unable to build GST report" });
    }
});
app.get("/reports/pnl", validateAction(ACCOUNTING_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const { from, to } = reportRange(req);
    try {
        res.json(await GetProfitAndLoss(restaurantId, from, to));
    }
    catch (e) {
        logger.error({ err: e }, "pnl_report_failed");
        res.status(500).json({ error: "Unable to build P&L report" });
    }
});
// CSV exports (Excel-openable). Called by authenticated API clients.
app.get("/reports/sales.csv", validateAction(ACCOUNTING_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const { from, to } = reportRange(req);
    try {
        const r = await GetSalesReport(restaurantId, from, to);
        const rows = r.by_day.map((d) => [d.date, d.bills, d.sales, d.tax, d.refund]);
        rows.push(["Total", r.bill_count, r.total_sales, r.total_tax, r.total_refund]);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="sales_${r.from}_to_${r.to}.csv"`);
        res.send(toCsv(["Date", "Bills", "Sales", "Tax", "Refunds"], rows));
    }
    catch (e) {
        logger.error({ err: e }, "sales_csv_failed");
        res.status(500).json({ error: "Unable to export sales" });
    }
});
app.get("/reports/gst.csv", validateAction(ACCOUNTING_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const { from, to } = reportRange(req);
    try {
        const r = await GetGstReport(restaurantId, from, to);
        const rows = r.by_rate.map((t) => [t.name, t.percentage, t.taxable, t.tax]);
        rows.push(["Total", "", r.total_taxable, r.total_tax]);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="gst_${r.from}_to_${r.to}.csv"`);
        res.send(toCsv(["Tax", "Rate %", "Taxable", "Tax"], rows));
    }
    catch (e) {
        logger.error({ err: e }, "gst_csv_failed");
        res.status(500).json({ error: "Unable to export GST" });
    }
});
// Tally-compatible voucher XML for import into Tally (ERP 9 / Prime).
app.get("/reports/tally.xml", validateAction(ACCOUNTING_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const { from, to } = reportRange(req);
    try {
        const xml = await BuildTallyXml(restaurantId, from, to);
        res.setHeader("Content-Type", "application/xml; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="tally_vouchers.xml"`);
        res.send(xml);
    }
    catch (e) {
        logger.error({ err: e }, "tally_xml_failed");
        res.status(500).json({ error: "Unable to build Tally export" });
    }
});
app.get("/expenses.csv", validateAction(ACCOUNTING_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const { from, to } = reportRange(req);
    try {
        const ex = await GetExpenses(restaurantId, from, to);
        const rows = ex.map((e) => [e.spent_on, e.category, e.vendor ?? "", e.amount, e.note ?? ""]);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="expenses.csv"`);
        res.send(toCsv(["Date", "Category", "Vendor", "Amount", "Note"], rows));
    }
    catch (e) {
        logger.error({ err: e }, "expenses_csv_failed");
        res.status(500).json({ error: "Unable to export expenses" });
    }
});
// Real operational analytics (order volume + revenue by hour-of-day and weekday).
app.get("/analytics/operations", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const daysRaw = typeof req.query.days === "string" ? Number.parseInt(req.query.days, 10) : 30;
    try {
        res.json(await GetOperationsAnalytics(restaurantId, Number.isFinite(daysRaw) ? daysRaw : 30));
    }
    catch (e) {
        logger.error({ err: e }, "operations_analytics_failed");
        res.status(500).json({ error: "Unable to fetch operations analytics" });
    }
});
// --- Attendance / working hours ---------------------------------------------
app.post("/attendance/clock-in", validate, async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    const employeeId = extractEmployeeId(req);
    if (!restaurantId || !employeeId) {
        res.status(400).json({ error: "Missing identity" });
        return;
    }
    try {
        res.json(await ClockIn(restaurantId, employeeId));
    }
    catch (e) {
        logger.error({ err: e }, "clock_in_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to clock in") });
    }
});
app.post("/attendance/clock-out", validate, async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    const employeeId = extractEmployeeId(req);
    if (!restaurantId || !employeeId) {
        res.status(400).json({ error: "Missing identity" });
        return;
    }
    try {
        res.json(await ClockOut(restaurantId, employeeId));
    }
    catch (e) {
        logger.error({ err: e }, "clock_out_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to clock out") });
    }
});
app.get("/attendance/me", validate, async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    const employeeId = extractEmployeeId(req);
    if (!restaurantId || !employeeId) {
        res.status(400).json({ error: "Missing identity" });
        return;
    }
    try {
        res.json(await GetMyAttendance(restaurantId, employeeId));
    }
    catch (e) {
        logger.error({ err: e }, "get_my_attendance_failed");
        res.status(500).json({ error: "Unable to fetch attendance" });
    }
});
app.get("/attendance", validate, async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin", "manager"]);
    if (!auth)
        return;
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    try {
        res.json(await GetAttendanceSummary(auth.restaurantId, from, to));
    }
    catch (e) {
        logger.error({ err: e }, "attendance_summary_failed");
        res.status(500).json({ error: "Unable to fetch attendance summary" });
    }
});
app.get("/restaurant/profile", validate, async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const employeeId = extractEmployeeId(req) ?? undefined;
    try {
        const profile = await GetRestaurantProfile(restaurantId, employeeId);
        res.json(profile);
    }
    catch (error) {
        logger.error({ err: error }, "get_restaurant_profile_failed");
        res.status(500).json({ error: "Unable to fetch profile" });
    }
});
app.get("/auth/restaurant-login", validate, async (req, res) => {
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
app.post('/publish/bill', validateAction("2ae797d9-2bef-4419-a33d-ab09590dbef9"), async (req, res) => {
    logger.info('Received request to publish bill');
    const body = (req.body ?? {});
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
        const outlets = await GetOutlets(restaurantId).catch(() => []);
        const outletBelongs = outlets.some((o) => String(o.id) === String(outletId));
        if (!outletBelongs) {
            res.status(400).json({ error: 'Invalid outletId for the restaurant' });
            return;
        }
        // Emit to outlet-specific room; send billId and base64 payload
        emitOutlet(restaurantId, outletId, 'bill:print', { billId, escBase64, publishedAt: new Date().toISOString() });
        res.json({ success: true });
    }
    catch (err) {
        logger.error({ err }, 'publish_bill_failed');
        res.status(500).json({ error: 'Unable to publish bill' });
    }
});
// Server-side thermal print: builds the ESC/POS receipt for a table's bill using
// the restaurant's configured currency, then emits bill:print to the printer agent.
app.post('/print/bill', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    const outletId = extractOutletId(req);
    if (!restaurantId || !outletId) {
        res.status(400).json({ error: 'Missing restaurant/outlet' });
        return;
    }
    const body = (req.body ?? {});
    const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
    const kind = body.kind === "kot" ? "kot" : "bill";
    if (!tableName) {
        res.status(400).json({ error: 'table_name is required' });
        return;
    }
    try {
        const [bill, settings, profile] = await Promise.all([
            GetBillForTable(restaurantId, tableName),
            GetRestaurantSettings(restaurantId).catch(() => ({ currency: "₹" })),
            GetRestaurantProfile(restaurantId).catch(() => null),
        ]);
        if (!bill || !Array.isArray(bill.items) || bill.items.length === 0) {
            res.status(400).json({ error: 'Nothing to print for this table' });
            return;
        }
        // Reprint without service charge on request (waiver). Recompute taxes on the
        // (discounted) subtotal so the printed total matches the actual bill.
        const includeServiceCharge = body.no_service_charge !== true;
        const charges = computeBillCharges(bill.subtotal ?? bill.total_amt ?? 0, settings.taxes ?? [], settings.service_charge ?? 0, includeServiceCharge, bill.discount_value > 0 ? { type: bill.discount_type ?? "percent", value: bill.discount_value } : undefined);
        // Column layout + logo raster width follow the configured paper size
        // (58mm = 32 cols / 384 dots, 80mm = 48 cols / 576 dots).
        const is58 = settings.bill_paper_width === "58mm";
        const cols = is58 ? 32 : 48;
        // Only the customer bill carries the logo, cashier line and feedback QR
        // (the kitchen ticket stays minimal).
        const isBill = kind !== "kot";
        const feedbackUrl = isBill ? await feedbackUrlForTable(restaurantId, tableName) : null;
        const logo = isBill ? await buildLogoEscPos(restaurantId, is58 ? 384 : 576).catch(() => null) : null;
        let cashier = "";
        if (isBill) {
            try {
                const emp = await GetEmployeeDetailsFromEmpID(extractEmployeeId(req) ?? "");
                cashier = `${emp?.emp_Fname ?? ""} ${emp?.emp_Lname ?? ""}`.trim();
            }
            catch { /* cashier optional */ }
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
        try {
            await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Printed ${kind} for table ${tableName}${includeServiceCharge ? "" : " (no service charge)"}`, Audit_log_category.Bill, { table: tableName, kind, no_service_charge: !includeServiceCharge });
        }
        catch { /* ignore */ }
        res.json({ success: true, billId });
    }
    catch (err) {
        logger.error({ err }, 'print_bill_failed');
        res.status(500).json({ error: String(err?.message ?? 'Unable to print') });
    }
});
// Admin: remove a wrongly-added item from a table's running bill.
app.post('/bills/remove-item', validateBody(sBillRemoveItem), async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin"]);
    if (!auth)
        return;
    const body = (req.body ?? {});
    const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
    const itemName = typeof body.item_name === "string" ? body.item_name.trim() : "";
    const price = Number(body.price ?? 0) || 0;
    if (!tableName || !itemName) {
        res.status(400).json({ error: "table_name and item_name are required" });
        return;
    }
    try {
        const result = await RemoveBillItem(auth.restaurantId, tableName, itemName, price);
        try {
            emitRestaurant(auth.restaurantId, "bill:updated", { table: tableName });
        }
        catch { /* ignore */ }
        try {
            await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Removed item ${result.removed.name} from table ${tableName}`, Audit_log_category.Bill, { table: tableName, item: itemName });
        }
        catch { /* ignore */ }
        res.json(result);
    }
    catch (e) {
        logger.error({ err: e }, 'remove_bill_item_failed');
        res.status(400).json({ error: String(e?.message ?? 'Unable to remove item') });
    }
});
// Move a wrongly-placed item from one table to another (front-of-house fix).
app.post('/bills/move-item', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), validateBody(sBillMoveItem), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = (req.body ?? {});
    const fromTable = typeof body.from_table === "string" ? body.from_table.trim() : "";
    const toTable = typeof body.to_table === "string" ? body.to_table.trim() : "";
    const itemName = typeof body.item_name === "string" ? body.item_name.trim() : "";
    const price = Number(body.price ?? 0) || 0;
    if (!fromTable || !toTable || !itemName) {
        res.status(400).json({ error: "from_table, to_table and item_name are required" });
        return;
    }
    try {
        const result = await MoveBillItem(restaurantId, fromTable, toTable, itemName, price);
        try {
            emitRestaurant(restaurantId, "bill:updated", { table: fromTable });
            emitRestaurant(restaurantId, "bill:updated", { table: toTable });
        }
        catch { /* ignore */ }
        try {
            await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Moved item ${result.moved.name} from ${fromTable} to ${toTable}`, Audit_log_category.Bill, { from: fromTable, to: toTable, item: itemName });
        }
        catch { /* ignore */ }
        res.json(result);
    }
    catch (e) {
        logger.error({ err: e }, 'move_bill_item_failed');
        res.status(400).json({ error: String(e?.message ?? 'Unable to move item') });
    }
});
// Set or clear a discount on a table's open bill (% or flat, off the subtotal).
app.post('/bills/discount', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), validateBody(sBillDiscount), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = (req.body ?? {});
    const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
    const type = body.type === "flat" ? "flat" : "percent";
    const value = Number(body.value ?? 0) || 0;
    if (!tableName) {
        res.status(400).json({ error: "table_name is required" });
        return;
    }
    try {
        const result = await SetBillDiscount(restaurantId, tableName, value > 0 ? type : null, value);
        try {
            emitRestaurant(restaurantId, "bill:updated", { table: tableName });
        }
        catch { /* ignore */ }
        try {
            const desc = value > 0 ? `Applied ${value}${type === "percent" ? "%" : ""} discount to table ${tableName}` : `Cleared discount on table ${tableName}`;
            await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", desc, Audit_log_category.Bill, { table: tableName, type, value });
        }
        catch { /* ignore */ }
        res.json(result);
    }
    catch (e) {
        logger.error({ err: e }, 'set_bill_discount_failed');
        res.status(400).json({ error: String(e?.message ?? 'Unable to set discount') });
    }
});
// --- Coupons (admin-managed promo codes) ------------------------------------
app.get('/coupons', validate, async (req, res) => {
    if (!(await enforceAdmin(req, res)))
        return;
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    try {
        res.json({ coupons: await GetCoupons(restaurantId) });
    }
    catch (e) {
        logger.error({ err: e }, 'get_coupons_failed');
        res.status(500).json({ error: "Unable to fetch coupons" });
    }
});
app.post('/coupons', validate, async (req, res) => {
    if (!(await enforceAdmin(req, res)))
        return;
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const b = (req.body ?? {});
    try {
        const coupon = await UpsertCoupon(restaurantId, b);
        try {
            await log_audit(req, "60d14e9c-45cc-4dc2-b017-56058cc3ae33", `Saved coupon ${coupon.code}`, Audit_log_category.General, { code: coupon.code });
        }
        catch { /* ignore */ }
        res.status(201).json({ coupon });
    }
    catch (e) {
        logger.error({ err: e }, 'upsert_coupon_failed');
        res.status(400).json({ error: String(e?.message ?? "Unable to save coupon") });
    }
});
app.delete('/coupons/:id', validate, async (req, res) => {
    if (!(await enforceAdmin(req, res)))
        return;
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    try {
        await DeleteCoupon(restaurantId, id);
        res.json({ success: true });
    }
    catch (e) {
        logger.error({ err: e }, 'delete_coupon_failed');
        res.status(400).json({ error: "Unable to delete coupon" });
    }
});
// Apply a coupon code to a table's open bill (staff / in-app).
app.post('/bills/apply-coupon', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), validateBody(sBillApplyCoupon), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = (req.body ?? {});
    const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const phone = typeof body.customer_phone === "string" ? body.customer_phone.trim() : undefined;
    if (!tableName || !code) {
        res.status(400).json({ error: "table_name and code are required" });
        return;
    }
    try {
        const result = await ApplyCouponToBill(restaurantId, tableName, code, phone);
        try {
            emitRestaurant(restaurantId, "bill:updated", { table: tableName });
        }
        catch { /* ignore */ }
        try {
            await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Applied coupon ${result.code} to table ${tableName}`, Audit_log_category.Bill, { table: tableName, code: result.code });
        }
        catch { /* ignore */ }
        res.json(result);
    }
    catch (e) {
        logger.error({ err: e }, 'apply_coupon_failed');
        res.status(400).json({ error: String(e?.message ?? "Unable to apply coupon") });
    }
});
// Add / edit / clear the kitchen note on a single bill item (by name + price),
// at any time. Front-of-house staff with bill access can annotate items.
app.post('/bills/item-note', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), validateBody(sBillItemNote), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = (req.body ?? {});
    const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
    const itemName = typeof body.item_name === "string" ? body.item_name.trim() : "";
    const price = Number(body.price ?? 0) || 0;
    const note = typeof body.note === "string" ? body.note : "";
    if (!tableName || !itemName) {
        res.status(400).json({ error: "table_name and item_name are required" });
        return;
    }
    try {
        const result = await SetBillItemNote(restaurantId, tableName, itemName, price, note);
        try {
            emitRestaurant(restaurantId, "bill:updated", { table: tableName });
        }
        catch { /* ignore */ }
        try {
            await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `${note.trim() ? "Set" : "Cleared"} note on ${itemName} (table ${tableName})`, Audit_log_category.Bill, { table: tableName, item: itemName });
        }
        catch { /* ignore */ }
        res.json(result);
    }
    catch (e) {
        logger.error({ err: e }, 'set_bill_item_note_failed');
        res.status(400).json({ error: String(e?.message ?? 'Unable to set item note') });
    }
});
// Compute a split of a table's bill (read-only — does not change the bill).
app.post('/bills/split', validateAction("98b10bde-802d-4a5b-a726-53a826424f79"), validateBody(sBillSplit), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = (req.body ?? {});
    const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
    const mode = body.mode === "item" ? "item" : "even";
    if (!tableName) {
        res.status(400).json({ error: "table_name is required" });
        return;
    }
    try {
        const result = await SplitBillForTable(restaurantId, tableName, mode, {
            parts: Number(body.parts ?? 0) || undefined,
            groups: Array.isArray(body.groups) ? body.groups : undefined,
        });
        res.json(result);
    }
    catch (e) {
        logger.error({ err: e }, 'split_bill_failed');
        res.status(400).json({ error: String(e?.message ?? 'Unable to split bill') });
    }
});
// Merge one table's active orders into another (combine checks).
app.post('/bills/merge', validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), validateBody(sBillMerge), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = (req.body ?? {});
    const fromTable = typeof body.from_table === "string" ? body.from_table.trim() : "";
    const toTable = typeof body.to_table === "string" ? body.to_table.trim() : "";
    if (!fromTable || !toTable) {
        res.status(400).json({ error: "from_table and to_table are required" });
        return;
    }
    try {
        const result = await MergeTableBills(restaurantId, fromTable, toTable);
        try {
            emitRestaurant(restaurantId, "bill:updated", { table: fromTable });
            emitRestaurant(restaurantId, "bill:updated", { table: toTable });
        }
        catch { /* ignore */ }
        try {
            await log_audit(req, "4ad474d4-5230-449c-874f-6a238b833bca", `Merged table ${fromTable} into ${toTable} (${result.moved_orders} orders)`, Audit_log_category.Bill, { from: fromTable, to: toTable });
        }
        catch { /* ignore */ }
        res.json(result);
    }
    catch (e) {
        logger.error({ err: e }, 'merge_bill_failed');
        res.status(400).json({ error: String(e?.message ?? 'Unable to merge bills') });
    }
});
// Refund a settled bill (admin only). Records the reversal; for a Razorpay payment
// it also attempts a gateway refund when keys are configured.
app.post('/bills/refund', validateBody(sBillRefund), async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin"]);
    if (!auth)
        return;
    const restaurantId = auth.restaurantId;
    const body = (req.body ?? {});
    const billId = typeof body.bill_id === "string" ? body.bill_id.trim() : "";
    const tableName = typeof body.table_name === "string" ? body.table_name.trim() : "";
    const amount = Number(body.amount ?? 0) || 0;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!billId && !tableName) {
        res.status(400).json({ error: "bill_id or table_name is required" });
        return;
    }
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
        let gateway = "skipped";
        if (result.payment_method === "Razorpay" && result.payment_ref) {
            const keys = (await GetRestaurantRazorpayKeys(restaurantId).catch(() => null))
                ?? ((RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) ? { key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET } : null);
            if (!keys) {
                gateway = "manual";
            }
            else {
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
                        const j = await rp.json().catch(() => ({}));
                        gateway = "ok";
                        if (typeof j?.id === "string" && j.id) {
                            try {
                                await SetBillRefundRef(restaurantId, result.bill_id, j.id);
                            }
                            catch { /* ignore */ }
                        }
                    }
                    else {
                        // A failed real-money refund must be diagnosable.
                        const errText = await rp.text().catch(() => "");
                        logger.error({ bill_id: result.bill_id, status: rp.status, body: errText.slice(0, 500) }, "razorpay_refund_failed");
                        gateway = "failed";
                    }
                }
                catch (e) {
                    logger.error({ bill_id: result.bill_id, error: String(e?.message ?? e) }, "razorpay_refund_error");
                    gateway = "failed";
                }
            }
        }
        try {
            await log_audit(req, "fc57d407-4bba-442c-97a2-9e6f3c57f288", `Refunded bill ${result.bill_id} (amount ${result.amount}, gateway ${gateway})`, Audit_log_category.Bill, { bill_id: result.bill_id, amount: result.amount, gateway });
        }
        catch { /* ignore */ }
        try {
            if (tableName)
                emitRestaurant(restaurantId, "bill:updated", { table: tableName });
        }
        catch { /* ignore */ }
        res.json({ ...result, gateway });
    }
    catch (e) {
        logger.error({ err: e }, 'refund_bill_failed');
        res.status(400).json({ error: String(e?.message ?? 'Unable to refund bill') });
    }
});
app.put("/restaurant/profile", validateAction("60d14e9c-45cc-4dc2-b017-56058cc3ae33"), async (req, res) => {
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
    const b = (req.body ?? {});
    const str = (v) => (typeof v === "string" ? v : undefined);
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
    }
    catch (error) {
        logger.error({ err: error }, "update_restaurant_profile_failed");
        res.status(500).json({ error: "Unable to update profile" });
    }
});
// --- Multi-outlet management -------------------------------------------------
const OUTLET_ADMIN_PERM = "60d14e9c-45cc-4dc2-b017-56058cc3ae33"; // restaurant-settings permission
// List a restaurant's outlets (any authed user — used by the outlet switcher).
app.get("/outlets", validate, async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    try {
        res.json({ outlets: await GetOutlets(restaurantId) });
    }
    catch (e) {
        logger.error({ err: e }, "get_outlets_failed");
        res.status(500).json({ error: "Unable to fetch outlets" });
    }
});
// Cross-outlet rollup (central owner view): revenue + orders per branch.
app.get("/outlets/rollup", validateAction(OUTLET_ADMIN_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const daysRaw = typeof req.query.days === "string" ? Number.parseInt(req.query.days, 10) : 30;
    try {
        res.json(await GetOutletsRollup(restaurantId, Number.isFinite(daysRaw) ? daysRaw : 30));
    }
    catch (e) {
        logger.error({ err: e }, "outlets_rollup_failed");
        res.status(500).json({ error: "Unable to build rollup" });
    }
});
app.post("/outlets", validateAction(OUTLET_ADMIN_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    // Additive plan gate: only blocks adding outlets when the plan explicitly says so.
    if (req.auth?.features?.multi_outlet === false) {
        res.status(403).json({ error: "Your plan does not include multiple outlets.", feature: "multi_outlet" });
        return;
    }
    const body = (req.body ?? {});
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
        res.status(400).json({ error: "Outlet name is required" });
        return;
    }
    // Enforce the subscribed plan's outlet limit, when it defines one (fail-open).
    const outletLimit = Number(req.auth?.limits?.outlets ?? 0);
    if (outletLimit > 0) {
        try {
            const existing = await GetOutlets(restaurantId);
            if ((existing?.length ?? 0) >= outletLimit) {
                res.status(403).json({ error: `Your plan allows up to ${outletLimit} outlet(s). Upgrade to add more.` });
                return;
            }
        }
        catch (e) {
            logger.warn({ err: e }, "outlet_limit_check_failed");
        }
    }
    try {
        const created = await AddOutlet(restaurantId, {
            name,
            address: typeof body.address === "string" ? body.address : undefined,
            phone: typeof body.phone === "string" ? body.phone : undefined,
            hours: typeof body.hours === "string" ? body.hours : undefined,
        });
        try {
            await log_audit(req, OUTLET_ADMIN_PERM, `Added outlet ${name}`, Audit_log_category.Bill, { id: created.id });
        }
        catch { /* ignore */ }
        res.json(created);
    }
    catch (e) {
        logger.error({ err: e }, "add_outlet_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to add outlet") });
    }
});
app.put("/outlets/:id", validateAction(OUTLET_ADMIN_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) {
        res.status(400).json({ error: "Missing id" });
        return;
    }
    const body = (req.body ?? {});
    try {
        await UpdateOutlet(restaurantId, id, {
            name: typeof body.name === "string" ? body.name : undefined,
            address: typeof body.address === "string" ? body.address : undefined,
            phone: typeof body.phone === "string" ? body.phone : undefined,
            hours: typeof body.hours === "string" ? body.hours : undefined,
        });
        res.json({ success: true });
    }
    catch (e) {
        logger.error({ err: e }, "update_outlet_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to update outlet") });
    }
});
app.post("/outlets/:id/active", validateAction(OUTLET_ADMIN_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    const active = (req.body ?? {}).active !== false;
    try {
        await SetOutletActive(restaurantId, id, active);
        res.json({ success: true });
    }
    catch (e) {
        logger.error({ err: e }, "set_outlet_active_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to update outlet") });
    }
});
app.delete("/outlets/:id", validateAction(OUTLET_ADMIN_PERM), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    try {
        await DeleteOutlet(restaurantId, id);
        try {
            await log_audit(req, OUTLET_ADMIN_PERM, `Deleted outlet ${id}`, Audit_log_category.Bill, { id });
        }
        catch { /* ignore */ }
        res.json({ success: true });
    }
    catch (e) {
        logger.error({ err: e }, "delete_outlet_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to delete outlet") });
    }
});
app.get('/outlets/default-tax', validateAction("d9b3f882-d3cf-46bc-b9ce-4218e8a5c29d"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: 'Missing restaurantId' });
        return;
    }
    try {
        const tax = await GetOutletDefaultTax(restaurantId);
        res.json({ default_tax: tax ?? {} });
    }
    catch (err) {
        logger.error({ err }, 'get_default_tax_failed');
        res.status(500).json({ error: 'Unable to fetch default tax' });
    }
});
app.patch('/outlets/default-tax', validateAction("28fa21cc-0dba-4a0f-bf6f-387089f47bbf"), async (req, res) => {
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
    }
    catch (err) {
        logger.error({ err }, 'update_default_tax_failed');
        res.status(500).json({ error: 'Unable to update default tax' });
    }
});
app.get("/roles", validateAction("17ba6407-b703-4403-ab59-13235966053f"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    try {
        const roles = await GetRoles(restaurantId);
        res.json(roles);
    }
    catch (error) {
        logger.error({ err: error }, "get_roles_failed");
        res.status(500).json({ error: "Unable to fetch roles" });
    }
});
app.get("/actions", validateAction("2b6f7948-0b27-41a9-9727-c04ccc9f4db1"), async (req, res) => {
    try {
        const actions = await GetActions();
        res.json(actions);
    }
    catch (err) {
        logger.error({ err }, 'get_actions_failed');
        res.status(500).json({ error: 'Unable to fetch actions' });
    }
});
app.post("/roles", validateAction("c0135d18-68b4-45e9-9b51-849158df6efd"), async (req, res) => {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const roleName = typeof req.body?.role_name === "string" ? req.body.role_name : "";
    const actions = Array.isArray(req.body?.actions_performable)
        ? req.body.actions_performable.map((entry) => String(entry))
        : [];
    try {
        const role = await CreateRole(restaurantId, roleName, actions);
        res.status(201).json(role);
    }
    catch (error) {
        logger.error({ err: error }, "create_role_failed");
        if (error && error.name === 'ValidationError') {
            // structured response for invalid action ids
            return res.status(400).json({ error: String(error.message), invalidActionIds: error.invalidActionIds ?? [] });
        }
        res.status(400).json({ error: String(error?.message ?? "Unable to create role") });
    }
});
app.delete("/roles/:id", validateAction("53d0927d-00f4-48cc-a40c-51edb09826d8"), async (req, res) => {
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
        const removed = await DeleteRole(restaurantId, roleId);
        if (!removed) {
            res.status(404).json({ error: "Role not found" });
            return;
        }
        res.status(204).send();
    }
    catch (error) {
        logger.error({ err: error }, "delete_role_failed");
        res.status(500).json({ error: "Unable to delete role" });
    }
});
app.post("/roles/assign", validateAction("4bf54bd9-9124-46c0-a7cc-011ea4c4e172"), async (req, res) => {
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
    try {
        await AssignRoleToEmployee(restaurantId, employeeId, roleName);
        res.json({ success: true });
    }
    catch (error) {
        logger.error({ err: error }, "assign_role_failed");
        res.status(400).json({ error: String(error?.message ?? "Unable to assign role") });
    }
});
app.post("/roles/remove", validateAction("9acc9097-4803-4be0-bb6d-fc2c5de57cf5"), async (req, res) => {
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
    try {
        await RemoveRoleFromEmployee(restaurantId, employeeId, roleName);
        res.json({ success: true });
    }
    catch (error) {
        logger.error({ err: error }, "remove_role_failed");
        res.status(400).json({ error: String(error?.message ?? "Unable to remove role") });
    }
});
app.get("/table-assignments", validateAction("f88657ce-0d67-4cd6-aae1-765dec10cd98"), async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin", "employee"]);
    if (!auth) {
        return;
    }
    try {
        const assignments = await GetTableAssignments(auth.restaurantId);
        res.json(assignments);
    }
    catch (error) {
        logger.error({ err: error }, "get_table_assignments_failed");
        res.status(500).json({ error: "Unable to fetch table assignments" });
    }
});
app.post("/table-assignments/assign", validateAction("faf2745b-580c-4529-bbe1-033200cbcf67"), async (req, res) => {
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
    }
    catch (error) {
        logger.error({ err: error }, "assign_table_employee_failed");
        res.status(400).json({ error: String(error?.message ?? "Unable to assign table") });
    }
});
app.post("/table-assignments/unassign", validateAction("e97a2c5d-d83d-48e3-bdea-ef0c3a1c51a7"), async (req, res) => {
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
    }
    catch (error) {
        logger.error({ err: error }, "unassign_table_employee_failed");
        res.status(400).json({ error: String(error?.message ?? "Unable to unassign table") });
    }
});
// Rtamanyu's integration
app.get("/valet-bays", validateAction("9e37297d-408b-446d-a51b-7892ad216b7d"), async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin", "valet"]);
    if (!auth) {
        return;
    }
    try {
        const data = await GetParkingBays(auth.restaurantId, auth.outletId);
        res.json(data);
        return;
    }
    catch (error) {
        logger.error({ err: error }, "fetch_valet_bays_failed");
        res.status(500).json({ error: "Unable to fetch valet bays" });
        return;
    }
});
app.post("/add-valet-bay", validateAction("ae8ce7c0-1e06-4722-8a06-817267eec785"), async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin", "valet"]);
    if (!auth) {
        return;
    }
    const body = req.body;
    const bayName = typeof body?.Bay_name === 'string' ? body.Bay_name.trim() : undefined;
    const totalCapacity = body?.total_capacity === null || body?.total_capacity === undefined ? undefined : Number(body.total_capacity);
    if (!bayName) {
        res.status(400).json({ error: "Missing Bay_name" });
        return;
    }
    try {
        const bay = await AddParkingBay(auth.restaurantId, bayName, Number.isFinite(totalCapacity) ? Number(totalCapacity) : 0, auth.outletId);
        const data = {
            message: "Bay added",
            ...bay,
        };
        // Broadcast bay added
        try {
            emitRestaurant(auth.restaurantId, "valet:bay_added", data);
        }
        catch (err) {
            logger.warn({ err }, "emit valet:bay_added failed");
        }
        res.json(data);
        return;
    }
    catch (error) {
        logger.error({ err: error }, "add_valet_bay_failed");
        res.status(500).json({ error: "Unable to add valet bay" });
        return;
    }
});
app.post("/delete-valet-bay", validateAction("6e9be65f-4081-4b86-8ba0-0592ee26f7f2"), async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin", "valet"]);
    if (!auth) {
        return;
    }
    const body = req.body;
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
        }
        catch (err) {
            logger.warn({ err }, "emit valet:bay_deleted failed");
        }
        res.json(data);
        return;
    }
    catch (error) {
        logger.error({ err: error }, "delete_valet_bay_failed");
        res.status(500).json({ error: "Unable to delete valet bay" });
        return;
    }
});
app.post("/update-valet-bay", validateAction("2caeab74-5941-424d-9c3a-5c68ef0186e1"), async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin", "valet"]);
    if (!auth)
        return;
    const body = req.body;
    const bayId = body?.Bay_id ? String(body.Bay_id) : undefined;
    const bayName = typeof body?.Bay_name === 'string' ? body.Bay_name.trim() : undefined;
    const totalCapacity = body?.total_capacity === null || body?.total_capacity === undefined ? undefined : Number(body.total_capacity);
    if (!bayName) {
        res.status(400).json({ error: "Missing Bay_name" });
        return;
    }
    try {
        const updated = await UpdateParkingBay(auth.restaurantId, bayId ?? null, bayName, Number.isFinite(totalCapacity) ? Number(totalCapacity) : 0, auth.outletId);
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
        }
        catch (err) {
            logger.warn({ err }, "emit valet:bay_updated failed");
        }
        res.json(data);
        return;
    }
    catch (err) {
        logger.error({ err }, "update_valet_bay_failed");
        res.status(500).json({ error: "Unable to update valet bay" });
    }
});
app.post("/set-valet-bay-current", validateAction("2ff51c3d-f18c-406c-9f49-7c54f468c835"), async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin", "valet"]);
    if (!auth)
        return;
    const body = req.body;
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
        }
        catch (err) {
            logger.warn({ err }, "emit valet:bay_current_set failed");
        }
        res.json(data);
        return;
    }
    catch (err) {
        logger.error({ err }, "set_valet_bay_current_failed");
        res.status(500).json({ error: "Unable to set bay current capacity" });
        return;
    }
});
app.post("/create_valet_record", validateAction("892b50f3-51fc-4099-8f31-01e8dd8c3d44"), async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin", "valet"]);
    if (!auth) {
        return;
    }
    const body = req.body;
    const number_plate = typeof body?.number_plate === 'string' ? body.number_plate.trim().toUpperCase() : undefined;
    const customer_name = typeof body?.customer_name === 'string' ? body.customer_name.trim() : undefined;
    const bayIdRaw = typeof body?.bay_id === 'string'
        ? body.bay_id.trim()
        : typeof body?.Bay_id === 'string'
            ? body.Bay_id.trim()
            : undefined;
    const bayNameRaw = typeof body?.bay_name === 'string'
        ? body.bay_name.trim()
        : typeof body?.Bay_name === 'string'
            ? body.Bay_name.trim()
            : undefined;
    const bayIdentifier = bayIdRaw || bayNameRaw;
    const entryTimeRaw = typeof body?.booking_date_time === 'string'
        ? body.booking_date_time
        : typeof body?.entry_time === 'string'
            ? body.entry_time
            : typeof body?.date_time === 'string'
                ? body.date_time
                : undefined;
    let entryTime;
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
        const meta = await UpsertValetVehicleMeta(auth.restaurantId, created.booking_id, number_plate, customer_name, auth.outletId);
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
        try {
            await log_audit(req, "892b50f3-51fc-4099-8f31-01e8dd8c3d44", `Valet checked in ${number_plate}`, Audit_log_category.Valet, { booking_id: created.booking_id, bay_id: created.bay_id });
        }
        catch (err) {
            logger.warn({ err }, "log_audit valet-checkin failed");
        }
        res.json(data);
        return;
    }
    catch (error) {
        logger.error({ err: error }, "create_valet_record_failed");
        res.status(500).json({ error: "Unable to create valet record" });
        return;
    }
});
app.post("/get_valet_info", validateAction("9e37297d-408b-446d-a51b-7892ad216b7d"), async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin", "valet"]);
    if (!auth) {
        return;
    }
    const body = req.body;
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
        });
        return;
    }
    catch (error) {
        logger.error({ err: error }, "fetch_valet_info_failed");
        res.status(500).json({ error: "Unable to fetch valet info" });
        return;
    }
});
async function updateValetStateAndPublish(restaurantId, bookingId, state, outletId) {
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
    const payload = {
        message: "Valet state updated successfully.",
        booking_id: updated.booking_id,
    };
    // Centralized publisher path for valet state updates.
    emitRestaurant(restaurantId, "valet:updated", { booking_id: bookingId, state, detail: payload });
    return payload;
}
app.post("/update_valet_state", validateAction("b8e02c25-b91c-427c-b462-8df009ede055"), async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin", "valet"]);
    if (!auth) {
        return;
    }
    const body = req.body;
    const booking_id = typeof body?.booking_id === 'string' ? body.booking_id.trim() : undefined;
    const state = body?.state === null || body?.state === undefined ? undefined : String(body.state).trim();
    if (!booking_id || !state) {
        res.status(400).json({ error: "Missing booking ID or state" });
        return;
    }
    try {
        const data = await updateValetStateAndPublish(auth.restaurantId, booking_id, state, auth.outletId);
        try {
            await log_audit(req, "b8e02c25-b91c-427c-b462-8df009ede055", `Valet state -> ${state} for ${booking_id}`, Audit_log_category.Valet, { booking_id, state });
        }
        catch (err) {
            logger.warn({ err }, "log_audit valet-state failed");
        }
        res.json(data);
        return;
    }
    catch (error) {
        logger.error({ err: error }, "update_valet_state_failed");
        const status = typeof error?.status === "number"
            ? (error.status)
            : 500;
        const payload = error?.payload;
        if (status !== 500 && payload && typeof payload === "object") {
            res.status(status).json(payload);
            return;
        }
        res.status(500).json({ error: "Unable to update valet state" });
        return;
    }
});
app.post("/update_valet_bay", validateAction("b8e02c25-b91c-427c-b462-8df009ede055"), async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin", "valet"]);
    if (!auth) {
        return;
    }
    const body = req.body;
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
    }
    catch (error) {
        logger.error({ err: error }, "update_valet_bay_failed");
        res.status(500).json({ error: String(error?.message ?? "Unable to update valet bay") });
        return;
    }
});
app.post("/unassign-valet-bay", validateAction("5ef876a7-eb92-4602-b4d3-5590ce379540"), async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin", "valet"]);
    if (!auth)
        return;
    const body = req.body;
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
    }
    catch (error) {
        logger.error({ err: error }, "unassign_valet_bay_failed");
        res.status(500).json({ error: "Unable to unassign valet bay" });
        return;
    }
});
app.post("/get_main_feedback_question", validate, async (req, res) => {
    const restaurantId = feedbackRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = req.body;
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
        const response = await fetchWithTimeout(`${PY_SERVER_URL}/get_main_feedback_question/${encodeURIComponent(category)}`);
        const data = await response.json();
        if (!response.ok) {
            res.status(response.status).json(data);
            return;
        }
        res.json(data);
        return;
    }
    catch (error) {
        logger.error({ err: error }, "get_main_feedback_question_failed");
        res.status(500).json({ error: "Unable to fetch main feedback question" });
        return;
    }
});
app.post("/get_follow_up_question", validate, async (req, res) => {
    const restaurantId = feedbackRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = req.body;
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
        const response = await fetchWithTimeout(`${PY_SERVER_URL}/get_follow_up_question/${encodeURIComponent(category)}/${encodeURIComponent(rate)}`);
        const payload = await response.json();
        const data = (payload ?? {});
        if (!response.ok) {
            res.status(response.status).json(data);
            return;
        }
        const categoryLabel = getFeedbackCategoryLabel(category);
        const rawFeedback = typeof data.feedback === "string" ? data.feedback : "";
        const normalizedFeedback = normalizeFollowUpPromptForCategory(rawFeedback, categoryLabel, rate);
        res.json({ ...data, feedback: normalizedFeedback });
        return;
    }
    catch (error) {
        logger.error({ err: error }, "get_follow_up_question_failed");
        res.status(500).json({ error: "Unable to fetch follow-up question" });
        return;
    }
});
app.post("/feedback/dynamic-follow-up", validate, async (req, res) => {
    const restaurantId = feedbackRestaurantId(req);
    if (!restaurantId) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    const body = req.body;
    const categoryLabel = typeof body?.category_label === "string" ? body.category_label.trim() : "";
    const rating = Number(body?.rating);
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    const mainQuestion = typeof body?.main_question === "string" ? body.main_question.trim() : "";
    const firstFollowUpQuestion = typeof body?.first_follow_up_question === "string" ? body.first_follow_up_question.trim() : "";
    if (!categoryLabel || !Number.isFinite(rating) || !reason) {
        res.status(400).json({ error: "category_label, rating, and reason are required" });
        return;
    }
    if (reason.length < 8) {
        res.status(400).json({ error: "reason is too short" });
        return;
    }
    try {
        const proxyResponse = await fetchWithTimeout(`${PY_SERVER_URL}/get_follow_up_question/${encodeURIComponent(categoryLabel)}/${encodeURIComponent(rating)}`);
        const proxyData = (await proxyResponse.json());
        if (!proxyResponse.ok) {
            res.status(proxyResponse.status).json(proxyData);
            return;
        }
        const aiPrompt = typeof proxyData.feedback === "string" ? proxyData.feedback.trim() : "";
        const normalizedAiPrompt = normalizeFollowUpPromptForCategory(aiPrompt, categoryLabel.toLowerCase(), rating);
        const contextualFallback = mainQuestion && firstFollowUpQuestion
            ? `Thanks for sharing. Based on your feedback about ${categoryLabel}, what one change should we prioritize?`
            : `Thanks for sharing. What one change should we prioritize for ${categoryLabel}?`;
        const followUpPrompt = normalizedAiPrompt.length > 0 ? normalizedAiPrompt : contextualFallback;
        res.json({ follow_up_prompt: followUpPrompt });
    }
    catch (error) {
        logger.error({ err: error }, "feedback_dynamic_follow_up_failed");
        res.status(500).json({ error: "Unable to generate dynamic follow-up" });
    }
});
app.post("/feedback/valet-checkin", rateLimit("valet_checkin", 10, 60_000), validate, async (req, res) => {
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
    const body = req.body;
    const numberPlate = typeof body?.number_plate === "string" ? body.number_plate.trim() : "";
    if (!numberPlate) {
        res.status(400).json({ error: "number_plate is required" });
        return;
    }
    const normalizedPlate = numberPlate.replace(/\s+/g, "").toUpperCase();
    try {
        const outletId = feedbackOutletId(req);
        const recordsResponse = await fetchWithTimeout(`${PY_SERVER_URL}/get_all_valet_records/${encodeURIComponent(restaurantId)}`, { headers: outletId ? { "X-Outlet-Id": outletId } : undefined });
        const recordsPayload = (await recordsResponse.json().catch(() => null));
        if (!recordsResponse.ok) {
            res.status(502).json({
                error: "Unable to verify valet record",
                details: recordsPayload ?? {},
            });
            return;
        }
        const records = Array.isArray(recordsPayload)
            ? recordsPayload
            : Array.isArray(recordsPayload?.records)
                ? recordsPayload.records
                : [];
        const matching = records.filter((record) => {
            const plate = typeof record.number_plate === "string" ? record.number_plate : "";
            return plate.replace(/\s+/g, "").toUpperCase() === normalizedPlate;
        });
        if (matching.length === 0) {
            res.status(404).json({ error: "No valet record found for this vehicle number" });
            return;
        }
        const recordWithState2 = matching.find((record) => Number(record.state) === 2);
        const candidate = recordWithState2 ?? matching[0];
        if (!candidate) {
            res.status(404).json({ error: "No valet record found for this vehicle number" });
            return;
        }
        const currentState = Number(candidate.state);
        if (Number.isFinite(currentState) && currentState > 3) {
            res.json({ success: true, action: "ignored", current_state: currentState });
            return;
        }
        if (currentState === 2) {
            const bookingIdRaw = typeof candidate.booking_id === "string"
                ? candidate.booking_id
                : typeof candidate.bookingId === "string"
                    ? candidate.bookingId
                    : "";
            const bookingId = bookingIdRaw.trim();
            if (!bookingId) {
                res.status(500).json({ error: "Unable to update valet stage: missing booking id" });
                return;
            }
            try {
                await updateValetStateAndPublish(restaurantId, bookingId, "3", outletId ?? undefined);
            }
            catch (error) {
                const payload = error?.payload;
                res.status(502).json({
                    error: "Unable to update valet stage to 3 for this vehicle number",
                    details: payload && typeof payload === "object" ? payload : {},
                });
                return;
            }
            res.json({ success: true, action: "updated_to_3", current_state: 3 });
            return;
        }
        res.json({ success: true, action: "ignored", current_state: Number.isFinite(currentState) ? currentState : null });
    }
    catch (error) {
        logger.error({ err: error }, "feedback_valet_checkin_failed");
        res.status(500).json({ error: "Unable to verify valet vehicle number" });
    }
});
app.post("/feedback/submit", rateLimit("feedback", 20, 60_000), async (req, res) => {
    // Public (customer) endpoint — no session. The restaurant/outlet/employee come
    // from the feedback link via headers (or body), then the write runs inside the
    // tenant context so RLS isolates it.
    const ridInput = feedbackRestaurantId(req);
    // employeeId (the waiter) is OPTIONAL: a table with no resolvable waiter (e.g.
    // QR-self-order only) still submits feedback, just unattributed (emp_id NULL).
    const employeeId = feedbackEmployeeId(req) ?? "";
    if (!ridInput) {
        res.status(400).json({ error: "Missing restaurantId" });
        return;
    }
    let resolvedId = null;
    try {
        resolvedId = await getRestaurantIdFromUsername(ridInput);
    }
    catch {
        resolvedId = null;
    }
    if (!resolvedId) {
        res.status(404).json({ error: "Restaurant not found" });
        return;
    }
    const rid = resolvedId;
    const outletId = feedbackOutletId(req);
    const body = req.body;
    const categoryRatingsRaw = body?.category_ratings;
    if (!Array.isArray(categoryRatingsRaw) || categoryRatingsRaw.length === 0) {
        res.status(400).json({ error: "category_ratings must be a non-empty array" });
        return;
    }
    const category_ratings = categoryRatingsRaw
        .slice(0, 25) // cap categories (anti-DoS); a real feedback form has a handful
        .map((item) => {
        const row = item;
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
    try {
        const saved = await withTenant({ res_id: rid, outlet_id: outletId || "", employeeId, role: "" }, () => AddFeedbackEntry(rid, employeeId, {
            customer_name: typeof body?.customer_name === "string" ? body.customer_name : null,
            visit_date: visitDate && !Number.isNaN(visitDate.getTime()) ? visitDate : null,
            comments: typeof body?.comments === "string" ? body.comments : null,
            category_ratings,
            image_theme: body?.image_theme && typeof body.image_theme === "object"
                ? {
                    background: String(body.image_theme.background ?? ""),
                    surface: String(body.image_theme.surface ?? ""),
                    text: String(body.image_theme.text ?? ""),
                    accent: String(body.image_theme.accent ?? ""),
                }
                : null,
            source: typeof body?.source === "string" ? body.source : "feedback_form",
        }));
        try {
            emitRestaurant(rid, "feedback:created", saved);
        }
        catch (err) {
            logger.warn({ err }, "emit feedback:created failed");
        }
        if (saved.recovery) {
            try {
                emitRestaurant(rid, "feedback:recovery", { id: saved.id });
            }
            catch { /* ignore */ }
        }
        res.status(201).json({ success: true, id: saved.id, submitted_at: saved.submitted_at, recovery: saved.recovery });
    }
    catch (error) {
        logger.error({ err: error }, "submit_feedback_failed");
        res.status(500).json({ error: "Unable to submit feedback" });
    }
});
app.get("/restaurant/users", validateAction("92cb8236-1039-4b47-a66f-6c7c8b0144ae"), async (req, res) => {
    const auth = await enforceRolesIgnoreOutletID(req, res, ["admin", "employee"]);
    if (!auth)
        return;
    try {
        const users = await GetRestaurantUsers(auth.restaurantId);
        res.json({ users });
    }
    catch (err) {
        logger.error({ err }, 'get_restaurant_users_failed');
        res.status(500).json({ error: 'Unable to fetch restaurant users' });
    }
});
app.post("/restaurant/users", validateAction("58fdfca7-7a97-439b-aeb2-00e4395a9a30"), async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin"]);
    if (!auth)
        return;
    // Enforce the subscribed plan's employee limit, when it defines one.
    const empLimit = Number(req.auth?.limits?.employees ?? 0);
    if (empLimit > 0) {
        try {
            const count = await GetRestaurantEmployeeCount(auth.restaurantId);
            if (count >= empLimit) {
                res.status(403).json({ error: `Your plan allows up to ${empLimit} employees. Upgrade to add more.` });
                return;
            }
        }
        catch (e) {
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
    const ph = typeof body.ph === 'string' || typeof body.ph === 'number' ? String(body.ph) : undefined;
    const add = typeof body.add === 'string' ? body.add : undefined;
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
        try {
            emitRestaurant(auth.restaurantId, 'restaurant:user:created', { user: created });
        }
        catch (e) {
            logger.warn({ err: e }, 'emit user created failed');
        }
        res.status(201).json({ success: true, user: created });
    }
    catch (err) {
        logger.error({ err }, 'create_restaurant_user_failed');
        res.status(500).json({ error: 'Unable to create user' });
    }
});
app.delete("/restaurant/users", validateAction("a978f15d-1043-417a-b07b-05f6bddad875"), async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin"]);
    if (!auth)
        return;
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
        try {
            emitRestaurant(auth.restaurantId, 'restaurant:user:deleted', { employeeId });
        }
        catch (e) { /* ignore emit errors */ }
        res.json({ success: true });
    }
    catch (error) {
        logger.error({ err: error }, 'delete_restaurant_user_failed');
        // Surface meaningful errors (e.g. the owner-protection guard) to the client.
        res.status(400).json({ error: String(error?.message ?? 'Unable to delete user') });
    }
});
// Admin sets/resets a user's password (directly, or to fulfil a forgot-password
// request). A non-superadmin admin cannot reset the superadmin's password.
app.post("/restaurant/users/password", async (req, res) => {
    const admin = await enforceAdmin(req, res);
    if (!admin)
        return;
    const body = (req.body ?? {});
    const employeeId = typeof body.employeeId === "string" ? body.employeeId.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!employeeId || !password) {
        res.status(400).json({ error: "employeeId and password are required" });
        return;
    }
    try {
        const superId = await GetSuperadminEmployeeId(admin.restaurantId);
        if (superId && employeeId === superId && req.auth?.employeeId !== superId) {
            res.status(403).json({ error: "Only the superadmin can reset the superadmin's password." });
            return;
        }
        await SetUserPassword(admin.restaurantId, employeeId, password);
        try {
            await log_audit(req, "a978f15d-1043-417a-b07b-05f6bddad875", `Reset password for a user`, Audit_log_category.General, { employeeId });
        }
        catch { /* ignore */ }
        res.json({ success: true });
    }
    catch (e) {
        logger.error({ err: e }, "set_user_password_failed");
        res.status(400).json({ error: String(e?.message ?? "Unable to set password") });
    }
});
// Admin: list pending forgot-password requests for this restaurant.
app.get("/restaurant/password-requests", async (req, res) => {
    const admin = await enforceAdmin(req, res);
    if (!admin)
        return;
    try {
        res.json({ requests: await GetPasswordResetRequests(admin.restaurantId) });
    }
    catch (e) {
        logger.error({ err: e }, "get_password_requests_failed");
        res.status(500).json({ error: "Unable to load password requests" });
    }
});
// Admin: dismiss a pending password request without resetting.
app.post("/restaurant/password-requests/:id/dismiss", async (req, res) => {
    const admin = await enforceAdmin(req, res);
    if (!admin)
        return;
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) {
        res.status(400).json({ error: "Missing request id" });
        return;
    }
    try {
        await ResolvePasswordResetRequest(admin.restaurantId, id);
        res.json({ success: true });
    }
    catch (e) {
        logger.error({ err: e }, "dismiss_password_request_failed");
        res.status(500).json({ error: "Unable to dismiss request" });
    }
});
// Public: a staff member who forgot their password requests a reset. The
// restaurant slug identifies the tenant; their admin fulfils it from the app.
app.post("/auth/forgot-password", rateLimit("forgot", 5, 60_000), async (req, res) => {
    const body = (req.body ?? {});
    const slug = typeof body.restaurant === "string" ? body.restaurant.trim()
        : typeof body.restaurantUsername === "string" ? body.restaurantUsername.trim() : "";
    const username = typeof body.username === "string" ? body.username.trim() : "";
    if (!slug || !username) {
        res.status(400).json({ error: "restaurant and username are required" });
        return;
    }
    try {
        await AddPasswordResetRequest(slug, username);
        // Always 200 (don't reveal whether the account exists).
        res.json({ success: true });
    }
    catch (e) {
        // A missing restaurant still returns success-shaped to avoid enumeration.
        logger.warn({ err: e }, "forgot_password_request_failed");
        res.json({ success: true });
    }
});
app.get("/feedback", validateAction("0cb6768b-92ff-4848-8631-52ef9d65cf53"), async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin", "employee"]);
    if (!auth) {
        return;
    }
    const limit = clampLimit(req.query.limit, 100, 500);
    try {
        const items = await GetFeedbackEntries(auth.restaurantId, limit);
        res.json({ items });
    }
    catch (error) {
        logger.error({ err: error }, "get_feedback_failed");
        res.status(500).json({ error: "Unable to fetch feedback" });
    }
});
// Service-recovery tickets (staff): list open low-rating feedback + resolve.
app.get("/feedback/recovery", validateAction("0cb6768b-92ff-4848-8631-52ef9d65cf53"), async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin", "employee"]);
    if (!auth)
        return;
    const includeResolved = String(req.query.all ?? "") === "1" || req.query.all === "true";
    try {
        res.json({ tickets: await GetRecoveryTickets(auth.restaurantId, includeResolved) });
    }
    catch (err) {
        logger.error({ err }, "get_recovery_tickets_failed");
        res.status(500).json({ error: "Unable to fetch recovery tickets" });
    }
});
app.post("/feedback/recovery/:id/resolve", validateAction("0cb6768b-92ff-4848-8631-52ef9d65cf53"), async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin", "employee"]);
    if (!auth)
        return;
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) {
        res.status(400).json({ error: "Missing id" });
        return;
    }
    const note = typeof req.body?.note === "string" ? String(req.body.note) : undefined;
    try {
        await ResolveRecoveryTicket(auth.restaurantId, id, note, extractEmployeeId(req) ?? undefined);
        try {
            await log_audit(req, "0cb6768b-92ff-4848-8631-52ef9d65cf53", `Resolved service-recovery ticket ${id}`, Audit_log_category.General, { id });
        }
        catch { /* ignore */ }
        res.json({ success: true });
    }
    catch (err) {
        logger.error({ err }, "resolve_recovery_ticket_failed");
        res.status(400).json({ error: "Unable to resolve ticket" });
    }
});
app.get("/feedback/summary", validateAction("0cb6768b-92ff-4848-8631-52ef9d65cf53"), async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin", "employee"]);
    if (!auth) {
        return;
    }
    try {
        const summary = await GetFeedbackSummary(auth.restaurantId);
        res.json(summary);
    }
    catch (error) {
        logger.error({ err: error }, "get_feedback_summary_failed");
        res.status(500).json({ error: "Unable to fetch feedback summary" });
    }
});
app.get("/feedback/stats", validateAction("0cb6768b-92ff-4848-8631-52ef9d65cf53"), async (req, res) => {
    const auth = await enforceRoles(req, res, ["admin", "employee"]);
    if (!auth)
        return;
    try {
        const mode = String(req.query.mode ?? "daily");
        const rows = await GetFeedbackEntries(auth.restaurantId, 5000);
        // helper to parse ISO date (yyyy-mm-dd)
        const parseDateISO = (s) => {
            if (!s)
                return null;
            const d = new Date(s);
            if (!isNaN(d.getTime()))
                return d;
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
                const raw = r.submitted_at ?? r.submittedAt ?? r.submittedAt;
                const s = new Date(raw);
                if (isNaN(s.getTime()))
                    continue;
                const ymd = s.toISOString().slice(0, 10);
                if (ymd === targetYMD) {
                    const h = s.getUTCHours();
                    if (h >= 0 && h < hours.length) {
                        const bucket = hours[h];
                        if (bucket)
                            bucket.count += 1;
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
            const days = [];
            const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
            for (let i = 0; i < 7; i++) {
                const d = new Date(Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate() + i));
                days.push({ label: dayLabels[i], date: d.toISOString().slice(0, 10), count: 0 });
            }
            const startMs = Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate());
            const endMs = startMs + 7 * 24 * 60 * 60 * 1000;
            for (const r of rows) {
                const raw = r.submitted_at ?? r.submittedAt ?? r.submittedAt;
                const s = new Date(raw);
                if (isNaN(s.getTime()))
                    continue;
                const t = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
                if (t >= startMs && t < endMs) {
                    const idx = Math.floor((t - startMs) / (24 * 60 * 60 * 1000));
                    if (idx >= 0 && idx < days.length) {
                        const bucket = days[idx];
                        if (bucket)
                            bucket.count += 1;
                    }
                }
            }
            return res.json({ mode: "weekly", weekStart: days[0].date, days });
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
            const weeks = [];
            while (weekStart < monthEnd) {
                const s = new Date(Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate()));
                const e = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() + 7));
                weeks.push({ start: s.toISOString().slice(0, 10), end: e.toISOString().slice(0, 10), label: `${s.toISOString().slice(5, 10)}`, count: 0 });
                weekStart = new Date(Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate() + 7));
            }
            // count events
            for (const r of rows) {
                const raw = r.submitted_at ?? r.submittedAt ?? r.submittedAt;
                const s = new Date(raw);
                if (isNaN(s.getTime()))
                    continue;
                const t = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
                for (let idx = 0; idx < weeks.length; idx++) {
                    const ws = weeks[idx];
                    const wsMs = Date.UTC(Number(ws.start.slice(0, 4)), Number(ws.start.slice(5, 7)) - 1, Number(ws.start.slice(8, 10)));
                    const weMs = Date.UTC(Number(ws.end.slice(0, 4)), Number(ws.end.slice(5, 7)) - 1, Number(ws.end.slice(8, 10)));
                    if (t >= wsMs && t < weMs) {
                        weeks[idx].count += 1;
                        break;
                    }
                }
            }
            return res.json({ mode: "monthly", month: `${year}-${(month + 1).toString().padStart(2, '0')}`, start: weeks[0]?.start ?? monthStart.toISOString().slice(0, 10), weeks });
        }
        if (mode === "yearly") {
            const yearParam = Number(req.query.year ?? new Date().getUTCFullYear());
            const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, label: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][i], count: 0 }));
            for (const r of rows) {
                const raw = r.submitted_at ?? r.submittedAt ?? r.submittedAt;
                const s = new Date(raw);
                if (isNaN(s.getTime()))
                    continue;
                if (s.getUTCFullYear() === yearParam) {
                    const mi = s.getUTCMonth();
                    if (mi >= 0 && mi < months.length) {
                        const bucket = months[mi];
                        if (bucket)
                            bucket.count += 1;
                    }
                }
            }
            return res.json({ mode: "yearly", year: yearParam, months });
        }
        return res.status(400).json({ error: "Unknown mode" });
    }
    catch (error) {
        logger.error({ err: error }, 'get_feedback_stats_failed');
        res.status(500).json({ error: 'Unable to fetch feedback stats' });
    }
});
export { app };
app.use((err, req, res, next) => {
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
app.use((err, req, res, _next) => {
    const correlationId = randomUUID();
    logger.error({ err, correlationId, method: req.method, path: req.path }, "unhandled_request_error");
    captureException(err, { correlationId, method: req.method, path: req.path });
    if (res.headersSent)
        return;
    const status = Number(err?.status || err?.statusCode) || 500;
    res.status(status >= 400 && status < 600 ? status : 500).json({
        error: "Something went wrong. Please try again.",
        correlationId,
    });
});
async function bootstrap() {
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
        }
        catch (error) {
            logger.error({ err: error }, "Failed to ensure CSR Organics seed");
        }
    }
    else {
        logger.info("Skipping demo seed (production; set SEED_DEMO=true to override)");
    }
    // Fail-closed isolation guard: warn (or abort, if ENFORCE_RLS_AT_BOOT=true) when
    // any tenant table is missing RLS, so a turnkey deploy never silently serves
    // traffic without DB-enforced multi-tenant isolation.
    await verifyTenantRlsAtBoot();
    const httpServer = createServer(app);
    try {
        await initRealtime(httpServer);
    }
    catch (err) {
        logger.warn({ err }, "initRealtime failed");
    }
    httpServer.listen(port, () => {
        logger.info(`Server listening at http://localhost:${port}`);
    });
    // Graceful shutdown: Railway (and most platforms) send SIGTERM on deploy. Drain
    // the HTTP server + socket.io, then close the pg pools so in-flight work can
    // settle and we don't abandon connections. Force-exit if draining stalls.
    let shuttingDown = false;
    const shutdown = async (signal) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        logger.info(`Received ${signal}, shutting down gracefully...`);
        const forceTimer = setTimeout(() => {
            logger.error("Graceful shutdown timed out; forcing exit.");
            process.exit(1);
        }, 15_000);
        forceTimer.unref?.();
        try {
            await new Promise((resolve) => httpServer.close(() => resolve()));
            await closeRealtime();
            await Promise.allSettled([closePools(), closePlatformPool()]);
            logger.info("Shutdown complete.");
            process.exit(0);
        }
        catch (err) {
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
//# sourceMappingURL=index.js.map