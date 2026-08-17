/**
 * Read-only analytics: APC, revenue, staff, kitchen, concerns, menu insights and
 * operations.
 */
import type { Express, Request, Response } from "express";
import { METRIC_EXPLAINERS } from "../analytics_explainers.js";
import { GetAdvancedAnalytics, GetApcTrends, GetConcerns, GetDailyRevenueSeries, GetKitchenAnalytics, GetMenuPerformanceInsights, GetMonthlyApcInsights, GetMonthlyHistory, GetOperationsAnalytics, GetOutletsComparison, GetOverviewInsights, GetStaffPerformance, GetTimingStats, RunExceptionChecks } from "../database_supabase.js";
import { logger } from "../observability.js";
import { billingConfigured, getTenantBilling } from "../platform/tenant_billing.js";
import { extractRestaurantId, validateAction } from "./_shared.js";


export function registerApcAnalyticsRoutes(app: Express): void {

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
}


export function registerAnalyticsRoutes(app: Express): void {

app.get("/orders/timing-stats", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try { res.json(await GetTimingStats(restaurantId)); }
	catch (err) { logger.error({ err }, "timing_stats_failed"); res.status(500).json({ error: "Unable to fetch timing stats" }); }
});

// Kitchen analytics: per-dish prep time, per-section (station) averages and an
// order-level prep summary over the last `days` days (default 30, clamped 1..365).
// Overview tab: every quick insight in ONE read. Composed from the same helpers
// the detailed panels use, so an Overview figure can never disagree with the
// screen it drills into.
app.get("/analytics/overview", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const daysRaw = typeof req.query.days === "string" ? Number.parseInt(req.query.days, 10) : 30;
	const days = Math.min(365, Math.max(1, Number.isFinite(daysRaw) ? daysRaw : 30));
	try { res.json(await GetOverviewInsights(restaurantId, days)); }
	catch (err) { logger.error({ err }, "overview_insights_failed"); res.status(500).json({ error: "Unable to fetch overview insights" }); }
});

// Per-employee composite performance score AND the components behind it — never
// a bare number, so the app can always show WHY.
//
// Gated on the SAME analytics permission as the rest of /analytics/*. That is
// deliberate and not a widening: /analytics/overview already returns per-employee
// revenue, orders and average rating under this exact id (top_staff), so anyone
// who can read this could already read the parts it is built from.
app.get("/analytics/staff-performance", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const daysRaw = typeof req.query.days === "string" ? Number.parseInt(req.query.days, 10) : 30;
	const days = Math.min(365, Math.max(1, Number.isFinite(daysRaw) ? daysRaw : 30));
	try { res.json(await GetStaffPerformance(restaurantId, days)); }
	catch (err) { logger.error({ err }, "staff_performance_failed"); res.status(500).json({ error: "Unable to fetch staff performance" }); }
});

// Everything needing attention today, each with a severity and what to do about
// it. Extends the Overview strip's needs_attention rather than re-detecting it,
// so the two can never disagree — hence the same permission as the Overview.
app.get("/analytics/concerns", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const daysRaw = typeof req.query.days === "string" ? Number.parseInt(req.query.days, 10) : 30;
	const days = Math.min(365, Math.max(1, Number.isFinite(daysRaw) ? daysRaw : 30));
	try {
		// The subscription lives in the CONTROL PLANE (a separate database), which
		// the tenant data layer deliberately does not reach into — so it is read
		// here and injected. Undeployed control plane => no subscription concern,
		// which is correct: there is genuinely nothing to be behind on.
		let subscription = null;
		const authResId = req.auth?.res_id;
		if (billingConfigured() && authResId) {
			try {
				const billing = await getTenantBilling(authResId);
				subscription = billing.subscription
					? {
						status: billing.subscription.status,
						current_period_end: billing.subscription.current_period_end,
						trial_ends_at: billing.subscription.trial_ends_at,
						plan_name: billing.plan?.name ?? null,
					}
					: null;
			} catch (err) {
				// A control-plane outage must not take the whole concerns list down —
				// but it is logged, and the row is OMITTED rather than reported as
				// "subscription fine", which would be a claim we cannot make.
				logger.warn({ err }, "concerns_subscription_lookup_failed");
			}
		}
		res.json(await GetConcerns(restaurantId, days, { subscription }));
	}
	catch (err) { logger.error({ err }, "concerns_failed"); res.status(500).json({ error: "Unable to fetch concerns" }); }
});

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
}


export function registerOperationsAnalyticsRoute(app: Express): void {

// Real operational analytics (order volume + revenue by hour-of-day and weekday).
app.get("/analytics/operations", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const daysRaw = typeof req.query.days === "string" ? Number.parseInt(req.query.days, 10) : 30;
	try { res.json(await GetOperationsAnalytics(restaurantId, Number.isFinite(daysRaw) ? daysRaw : 30)); }
	catch (e) { logger.error({ err: e }, "operations_analytics_failed"); res.status(500).json({ error: "Unable to fetch operations analytics" }); }
});
}
