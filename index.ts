import 'dotenv/config';
import type { NextFunction, Request, Response } from "express";
import express from "express";
import { randomUUID } from "crypto";
import helmet from "helmet";
import { createServer, type Server as HttpServer } from "http";
import { getSession, refreshTtl } from "./auth/sessions.js";
import { DbBusyError, EnsureRestaurantSeed, ListRestaurantIds, ResolveOutletForRestaurant, RunExceptionChecks, WarmReportingSchema, closePools, ensureFeaturePermissionActions, openTenantConnection, verifyTenantRlsAtBoot, withTenant } from "./database_supabase.js";
import { captureException, initObservability, logger, metricsMiddleware } from "./observability.js";
import { archivedStatusSupported, archivedStatusUnsupportedMessage, closePlatformPool, platformDbConfigured } from "./platform/db.js";
import { registerPlatformRoutes } from "./platform/routes.js";
import { closeRealtime, initRealtime } from "./realtime.js";
import { runReportScheduleSweep } from "./report_schedules.js";
import { warnAboutLegacyReleaseEnv } from "./app_release.js";
import { runIdempotencyReaperSweep } from "./idempotency.js";
import { runPrintJobReaperSweep } from "./print_jobs.js";
import { extractBearerToken, isAllOutletsSentinel, normalizeRole, rawRequestedOutletId, sendDueBookingReminders } from "./routes/_shared.js";
import { registerGuestOrderingRoutes, registerGuestWaitlistAndPaymentRoutes, registerGuestBrandingRoute } from "./routes/guest.js";
import { registerWhatsAppWebhookRoutes } from "./routes/webhooks.js";
import { registerCoreRolesRoute, registerRoleRoutes } from "./routes/roles.js";
import { registerSystemRoutes, registerReceptionRoutes } from "./routes/misc.js";
import { registerAuthRoutes, registerRestaurantLoginRoute } from "./routes/auth.js";
import { registerCustomerCreateRoute, registerCustomerQueryRoutes } from "./routes/customers.js";
import { registerTableRoutes, registerTableListRoute } from "./routes/tables.js";
import { registerBookingCreateRoute, registerBookingListRoute, registerBookingStatusRoute, registerBookingTableAndCancelRoutes, registerBookingRangeRoute } from "./routes/bookings.js";
import { registerValetInfoRoute, registerValetRoutes } from "./routes/valet.js";
import { registerBillRoutes, registerBillPaymentRoutes, registerBillPrintAndEditRoutes, registerBillOpsRoutes, registerTenderRoutes } from "./routes/bills.js";
import { registerRestaurantLogoRoutes, registerSettingsRoutes, registerRestaurantProfileReadRoute, registerRestaurantProfileWriteRoute } from "./routes/settings.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerInventoryRoutes, registerInventoryMovementRoutes, registerInventoryDeleteRoute, registerInventoryCategoryRenameRoute } from "./routes/inventory.js";
import { registerVendorRoutes } from "./routes/vendors.js";
import { registerPurchaseOrderRoutes } from "./routes/purchasing.js";
import { registerMenuRoutes, registerMenuAdminRoutes } from "./routes/menu.js";
import { registerMessagingRoutes } from "./routes/messaging.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerOrderRoutes, registerOrderTimingRoutes } from "./routes/orders.js";
import { registerApcAnalyticsRoutes, registerAnalyticsRoutes, registerOperationsAnalyticsRoute } from "./routes/analytics.js";
import { registerCampaignRoutes } from "./routes/campaigns.js";
import { registerKdsRoutes } from "./routes/kds.js";
import { registerPayrollRoutes } from "./routes/payroll.js";
import { registerExpenseRoutes, registerAccountingRoutes } from "./routes/accounting.js";
import { registerWaitlistRoutes } from "./routes/waitlist.js";
import { registerTenantBillingRoutes } from "./routes/tenant_billing.js";
import { registerAttendanceRoutes } from "./routes/attendance.js";
import { registerLeaveRoutes } from "./routes/leaves.js";
import { registerDiscountRequestRoutes } from "./routes/discounts.js";
import { registerCouponRoutes } from "./routes/coupons.js";
import { registerLoyaltyRoutes } from "./routes/loyalty.js";
import { registerAggregatorRoutes } from "./routes/aggregator.js";
import { registerOutletRoutes } from "./routes/outlets.js";
import { registerTableAssignmentRoutes } from "./routes/table_assignments.js";
import { registerGuestFeedbackRoutes, registerFeedbackAdminRoutes } from "./routes/feedback.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerSimulationRoutes } from "./routes/simulation.js";
import { registerPosterRoutes } from "./routes/posters.js";
import { registerMisCaptureRoutes } from "./routes/mis_capture.js";
import { registerMisReportRoutes } from "./routes/reports_mis.js";
import { registerMenuTaxonomyRoutes } from "./routes/menu_taxonomy.js";

initObservability();
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
		employeeUsername: session.employeeUsername,
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
		if (err instanceof DbBusyError) {
			// Pool saturation: already logged as a WARN with live pool counts at the
			// acquire site (logPoolSaturation), so no error-level stack here. This is
			// a retryable condition, and saying so lets clients back off briefly
			// instead of treating it as an outage.
			res.setHeader("Retry-After", "2");
			res.status(503).json({ error: "Server busy", details: err.message, retryable: true });
			return;
		}
		logger.error({ err }, "tenant_connection_open_failed");
		res.status(503).json({ error: "Database unavailable" });
	}
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
		// Idempotency-Key is the retry-safety key (idempotency.ts). It MUST be
		// listed here or the browser fails the preflight and the dashboard's keyed
		// writes never leave the tab — the Flutter app, which does no preflight,
		// would keep working and the breakage would look web-only.
		"Content-Type,Authorization,X-Outlet-Id,X-Restaurant-Id,X-Employee-Id,X-Restaurant-Username,Idempotency-Key",
	);
	// Paging metadata on list endpoints (audit logs, closed bills) travels in
	// headers so the response body can stay the shape existing clients expect.
	// Without this a browser hides them from fetch() even on a same-tenant call.
	// Idempotent-Replay tells a caller its write was already applied and this is
	// the stored answer — hidden from fetch() without the expose header.
	res.header("Access-Control-Expose-Headers", "X-Total-Count,X-Has-More,Idempotent-Replay");
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
	// Leave IS attendance — a plan that excludes one must not hand over the other
	// through a differently-named route.
	[/^\/leaves\b/, "attendance"],
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

// ---------------------------------------------------------------------------
// Routes. Express matches in REGISTRATION ORDER, so the order of these calls
// is load-bearing: it is exactly the order the handlers were registered in
// before they were split out of this file. scripts/route_manifest.ts freezes
// that order; `--check` fails on any drift.
// ---------------------------------------------------------------------------
registerGuestOrderingRoutes(app);
registerWhatsAppWebhookRoutes(app);
registerGuestWaitlistAndPaymentRoutes(app);
registerCoreRolesRoute(app);
registerSystemRoutes(app);
registerAuthRoutes(app);
registerReceptionRoutes(app);
registerCustomerCreateRoute(app);
registerTableRoutes(app);
registerBookingCreateRoute(app);
registerTableListRoute(app);
registerBookingListRoute(app);
registerValetInfoRoute(app);
registerBookingStatusRoute(app);
registerBillRoutes(app);
registerRestaurantLogoRoutes(app);
registerBillPaymentRoutes(app);
registerBookingTableAndCancelRoutes(app);
registerCustomerQueryRoutes(app);
registerBookingRangeRoute(app);
registerAuditRoutes(app);
registerInventoryRoutes(app);
registerVendorRoutes(app);
registerInventoryMovementRoutes(app);
registerPurchaseOrderRoutes(app);
registerInventoryDeleteRoute(app);
registerMenuRoutes(app);
registerSettingsRoutes(app);
registerMessagingRoutes(app);
registerNotificationRoutes(app);
registerGuestBrandingRoute(app);
registerMenuAdminRoutes(app);
registerInventoryCategoryRenameRoute(app);
registerOrderRoutes(app);
registerApcAnalyticsRoutes(app);
registerCampaignRoutes(app);
registerOrderTimingRoutes(app);
registerKdsRoutes(app);
registerAnalyticsRoutes(app);
registerPayrollRoutes(app);
registerExpenseRoutes(app);
registerWaitlistRoutes(app);
registerTenantBillingRoutes(app);
registerAccountingRoutes(app);
registerOperationsAnalyticsRoute(app);
registerAttendanceRoutes(app);
registerLeaveRoutes(app);
registerRestaurantProfileReadRoute(app);
registerRestaurantLoginRoute(app);
registerBillPrintAndEditRoutes(app);
registerDiscountRequestRoutes(app);
registerCouponRoutes(app);
registerLoyaltyRoutes(app);
registerAggregatorRoutes(app);
registerBillOpsRoutes(app);
registerRestaurantProfileWriteRoute(app);
registerOutletRoutes(app);
registerRoleRoutes(app);
registerTableAssignmentRoutes(app);
registerValetRoutes(app);
registerGuestFeedbackRoutes(app);
registerUserRoutes(app);
registerFeedbackAdminRoutes(app);
registerSimulationRoutes(app);
registerPosterRoutes(app);
// The MIS / control reports (Insights -> Reports). Registered LAST, and every
// one of its paths is a literal under /reports/mis/, so it can neither shadow
// nor be shadowed by the accounting /reports/* routes registered far above.
registerMisReportRoutes(app);
// The MIS CAPTURE writes (non-chargeable, order voids, service-charge waivers).
// These are the control ledgers the reports above read; without them the reports
// are permanently empty, so an unregistered file here is a silent no-op.
registerMisCaptureRoutes(app);
// TENDERS, TIPS AND BILLING COUNTERS (migrations 037/038). Registered after
// everything else so no earlier pattern can swallow /bills/tenders,
// /bills/counter, /billing-counters or /tips, and so none of them can shadow a
// bill route that already exists — every path here is a literal.
registerTenderRoutes(app);
// Menu groups + item variations (migration 039). Registered last, beside the
// other 039 surface: every path is a literal under /menu-groups,
// /menu-group-assignments or /menu-variations, none of which any earlier pattern
// can match, so its position cannot shadow or be shadowed by anything above —
// including the /menu/* routes it sits conceptually next to.
registerMenuTaxonomyRoutes(app);



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

// Socket.IO bring-up, split out of bootstrap() and memoised so it can be awaited
// on its own.
//
// WHY THIS IS SEPARATE. emitRestaurant/emitOutlet open with `if (!io) {return;}`
// (realtime.ts:117, :128) and `io` is only assigned inside initRealtime. In a
// long-lived process that is invisible: bootstrap() runs to completion in the
// first moments and every later emit finds `io` set. Under a serverless runtime
// it is not invisible at all — the platform freezes the container as soon as the
// in-flight handler settles, so a detached bootstrap() only advances WHILE a
// request is being served. A cold container that serves one fast request and
// idles can still have `io === null`, and the emit is then dropped with no log
// line, no metric and no error: a stale KDS/orders/tables/waitlist screen until
// someone hits refresh, on cold containers only, which is the hardest possible
// thing to reproduce. (Printing is unaffected — POST /print/bill and
// POST /publish/bill are routed to the always-on task, see deploy/README.md 2.1.)
//
// So the serverless entrypoint awaits THIS before it serves anything
// (lambda.ts), while bootstrap() below awaits the same promise at the same point
// in its sequence. Memoised, so whichever gets there first wins and initRealtime
// runs exactly once per process — two Socket.IO servers, or a second pair of
// Redis clients, would be a real regression.
let realtimeServerPromise: Promise<HttpServer> | null = null;
export function ensureRealtime(): Promise<HttpServer> {
	if (!realtimeServerPromise) {
		const httpServer = createServer(app);
		realtimeServerPromise = initRealtime(httpServer)
			.catch((err: unknown) => {
				// Same posture as before the split: a realtime failure degrades
				// realtime, it does not stop the process from serving HTTP.
				logger.warn({ err }, "initRealtime failed");
			})
			.then(() => httpServer);
	}
	return realtimeServerPromise;
}

async function bootstrap(): Promise<void> {
	// Say once, at boot, if the old release variables are still set on this box.
	// They are inert now (app_release.ts owns the manifest), and discovering that
	// mid-incident — after editing .env and restarting and seeing no change — is
	// the worst possible moment to learn it.
	warnAboutLegacyReleaseEnv(logger);
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

	// Run the reporting path's lazy DDL ONCE here, outside any transaction, so the
	// scheduled-report sweep never triggers it inside withTenant's real one:
	// ensureLazyTable swallows a 42501 in JavaScript but Postgres has already
	// aborted the transaction, and every statement after it returns 25P02.
	// Individually tolerant, so a least-privilege runtime just logs and moves on.
	//
	// Behind the SAME flag that arms the sweep below. It exists only for the sweep,
	// and running it unconditionally would move four previously-lazy DDL blocks to
	// every boot of every deployment — a real behaviour change in deployments that
	// never asked for this feature, and the one thing that made "ships dark" false.
	if (process.env.REPORT_SCHEDULER === "true") {
		try {
			await WarmReportingSchema();
			logger.info("✅ Reporting schema warmed");
		} catch (error) {
			logger.warn({ err: error }, "Failed to warm reporting schema");
		}
	}

	// Fail-closed isolation guard: warn (or abort, if ENFORCE_RLS_AT_BOOT=true) when
	// any tenant table is missing RLS, so a turnkey deploy never silently serves
	// traffic without DB-enforced multi-tenant isolation.
	await verifyTenantRlsAtBoot();

	// Migration 028 banner. The archive route refuses outright when the 'archived'
	// arm is missing from platform.restaurant_status (platform/routes.ts), so the
	// feature can never half-work — but the operator only finds out when they click
	// Archive. Say it at boot instead, because the container deploy path does NOT
	// apply migrations: Dockerfile.node's CMD is `node build/index.js`, not
	// `npm run start:prod` (the only script that chains `npm run migrate`).
	//
	// A WARNING, not a hard failure: every other feature works fine without 028, so
	// refusing to boot over it would take a whole fleet down to protect one button.
	if (platformDbConfigured()) {
		try {
			const support = await archivedStatusSupported();
			if (support.supported) {
				logger.info("✅ Tenant archiving available (migration 028 applied)");
			} else {
				logger.error({ reason: support.reason }, archivedStatusUnsupportedMessage(support.reason));
			}
		} catch (error) {
			logger.warn({ err: error }, "Could not check migration 028 (tenant archiving)");
		}
	}

	// Same createServer + initRealtime, at the same point in the sequence — just
	// reached through the memoised helper above, so a serverless entrypoint that
	// already awaited it does not get a second Socket.IO server here.
	const httpServer = await ensureRealtime();

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

	// Scheduled report sweep. A SEPARATE timer from the 30-minute exception sweep
	// on purpose: on a 30-minute tick an "08:00 report" arrives at 08:29, and a
	// slow report run would delay booking reminders, which share that one serial
	// loop with the exception checks.
	//
	// There is no leader lock available on the tenant pool
	// (withPlatformAdvisoryLock is bound to the platform pool, platform/db.ts:48).
	// Replica safety comes ENTIRELY from the (schedule_id, occurrence_key) unique
	// index and the attempts compare-and-swap — not from this flag, which is
	// per-process and worthless across instances. It only stops one slow sweep
	// from stacking on the next tick.
	let reportSweepRunning = false;
	const reportSweep = async () => {
		if (reportSweepRunning) {return;}
		reportSweepRunning = true;
		try {
			await runReportScheduleSweep();
		} catch (err) {
			logger.warn({ err }, "report_sweep_failed");
		} finally {
			reportSweepRunning = false;
		}
	};
	// Ships DARK. Flip REPORT_SCHEDULER on once migration 026 is verified in prod;
	// same posture as SEED_DEMO above.
	if (process.env.REPORT_SCHEDULER === "true") {
		const reportSweepTimer = setInterval(
			() => void reportSweep(),
			Math.max(1, Number(process.env.REPORT_SWEEP_INTERVAL_MIN) || 5) * 60_000,
		);
		reportSweepTimer.unref?.();
		logger.info("✅ Scheduled report sweep armed");
	} else {
		logger.info("Scheduled report sweep disabled (set REPORT_SCHEDULER=true)");
	}

	// Print-job reaper: mark outstanding jobs that outlived their TTL 'expired',
	// then delete settled rows past the retention window.
	//
	// ARMED BY DEFAULT, unlike the report sweep above, because it is pure hygiene
	// and cannot mis-send anything: the TTL that stops a stale kitchen docket ever
	// replaying is the read-time predicate inside ClaimPrintJobsForAgent, not this
	// timer. What it does buy is a bounded table and a queryable record of receipts
	// that were never delivered. On a database that has not run migration 027 it
	// bails out on the first tenant with one loud log line and stays a no-op.
	//
	// Same replica posture as the two sweeps above: no leader lock exists on the
	// tenant pool, and none is needed — both statements are idempotent and two
	// replicas racing them converge. The flag only stops one slow sweep stacking on
	// the next tick.
	if (process.env.PRINT_JOB_REAPER !== "false") {
		let printReaperRunning = false;
		const printReaperSweep = async () => {
			if (printReaperRunning) {return;}
			printReaperRunning = true;
			try {
				await runPrintJobReaperSweep();
			} catch (err) {
				logger.warn({ err }, "print_job_reaper_failed");
			} finally {
				printReaperRunning = false;
			}
		};
		const printReaperTimer = setInterval(
			() => void printReaperSweep(),
			Math.max(1, Number(process.env.PRINT_JOB_REAPER_INTERVAL_MIN) || 15) * 60_000,
		);
		printReaperTimer.unref?.();
		logger.info("✅ Print job reaper armed");
	} else {
		logger.info("Print job reaper disabled (PRINT_JOB_REAPER=false)");
	}

	// Idempotency-key reaper: delete keys past their 48h window.
	//
	// PURE HYGIENE, and more obviously so than the print reaper above: the claim
	// statement refuses to honour an expired row at READ time
	// (ClaimIdempotencyKey's takeover predicate), so a database whose sweep never
	// runs still applies every key exactly once. All this buys is a bounded table.
	//
	// HOURLY, not 15-minutely like the print reaper, and that gap is deliberate:
	// every sweep here opens one tenant connection per tenant against a 15-slot
	// session pooler, and the 2026-08-24 standstill is what that budget looks like
	// when it runs out. Nothing is late by an hour that matters — the window is
	// two days.
	//
	// Same replica posture as the sweeps above: no leader lock exists on the
	// tenant pool and none is needed, because the DELETE is idempotent and two
	// replicas racing it converge. The flag only stops one slow sweep stacking on
	// the next tick.
	if (process.env.IDEMPOTENCY_REAPER !== "false") {
		let idemReaperRunning = false;
		const idemReaperSweep = async () => {
			if (idemReaperRunning) {return;}
			idemReaperRunning = true;
			try {
				await runIdempotencyReaperSweep();
			} catch (err) {
				logger.warn({ err }, "idempotency_reaper_failed");
			} finally {
				idemReaperRunning = false;
			}
		};
		const idemReaperTimer = setInterval(
			() => void idemReaperSweep(),
			Math.max(1, Number(process.env.IDEMPOTENCY_REAPER_INTERVAL_MIN) || 60) * 60_000,
		);
		idemReaperTimer.unref?.();
		logger.info("✅ Idempotency key reaper armed");
	} else {
		logger.info("Idempotency key reaper disabled (IDEMPOTENCY_REAPER=false)");
	}

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
