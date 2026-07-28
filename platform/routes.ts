import type { Express, NextFunction, Request, Response } from "express";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { destroyAllForRestaurant } from "../auth/sessions.js";
import { platformQuery, platformDbConfigured, withPlatformAdvisoryLock } from "./db.js";
import { applyScheduledDowngrades, markInvoicePaidAndActivate, activateSubscriptionPlan } from "./tenant_billing.js";
import {
	createPlatformSession,
	getPlatformSession,
	refreshPlatformTtl,
	destroyPlatformSession,
	type PlatformSession,
} from "./sessions.js";
import { logger } from "../observability.js";

declare global {
	namespace Express {
		interface Request {
			platformAdmin?: PlatformSession;
		}
	}
}

function bearer(req: Request): string | null {
	const h = req.headers.authorization;
	const v = Array.isArray(h) ? h[0] : h;
	if (typeof v === "string" && v.toLowerCase().startsWith("bearer ")) {
		const t = v.slice(7).trim();
		return t.length > 0 ? t : null;
	}
	return null;
}

// Verifies the platform-admin bearer token against the platform Redis session
// store. Completely separate from the tenant requireAuth.
async function requirePlatformAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
	const token = bearer(req);
	if (!token) {
		res.status(401).json({ error: "Unauthorized" });
		return;
	}
	let session: PlatformSession | null;
	try {
		session = await getPlatformSession(token);
	} catch (err) {
		logger.error({ err }, "platform_session_lookup_failed");
		res.status(503).json({ error: "Session store unavailable" });
		return;
	}
	if (!session) {
		res.status(401).json({ error: "Unauthorized" });
		return;
	}
	// The session store alone is not authority: an operator who is deactivated or
	// deleted in platform.admins must lose fleet-wide access IMMEDIATELY, not when
	// their (constantly refreshed) 8h TTL happens to lapse. The control plane is
	// low-traffic, so this re-check runs per request rather than on a cache.
	let stillActive = false;
	try {
		const rows = await platformQuery<{ active: boolean | null }>(
			`select active from platform.admins where id = $1 limit 1`,
			[session.adminId],
		);
		stillActive = rows.length > 0 && rows[0]?.active !== false;
	} catch (err) {
		logger.error({ err }, "platform_admin_recheck_failed");
		res.status(503).json({ error: "Control plane unavailable" });
		return;
	}
	if (!stillActive) {
		// The account is gone or disabled — drop the token so it stops resolving.
		try { await destroyPlatformSession(token); } catch (err) { logger.error({ err }, "platform_session_destroy_failed"); }
		res.status(401).json({ error: "Unauthorized" });
		return;
	}
	req.platformAdmin = session;
	void refreshPlatformTtl(token);
	next();
}

async function audit(
	adminId: string,
	action: string,
	targetResId: string | null,
	detail: unknown,
): Promise<void> {
	try {
		await platformQuery(
			`insert into platform.audit (admin_id, action, target_res_id, detail) values ($1, $2, $3, $4)`,
			[adminId, action, targetResId, detail === undefined ? null : JSON.stringify(detail)],
		);
	} catch (err) {
		logger.error({ err }, "platform_audit_failed");
	}
}

// Per-IP brute-force guard for the platform login (10 attempts / minute).
const _platformLoginBuckets = new Map<string, { count: number; resetAt: number }>();
function platformLoginAllowed(ip: string): boolean {
	const now = Date.now();
	let b = _platformLoginBuckets.get(ip);
	if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + 60_000 }; _platformLoginBuckets.set(ip, b); }
	b.count++;
	if (_platformLoginBuckets.size > 5000) {
		for (const [k, v] of _platformLoginBuckets) {if (v.resetAt <= now) {_platformLoginBuckets.delete(k);}}
	}
	return b.count <= 10;
}

function addMonths(d: Date, n: number): Date {
	const x = new Date(d.getTime());
	const day = x.getDate();
	x.setDate(1); // avoid month-end overflow (e.g. Jan 31 + 1mo -> Mar 3)
	x.setMonth(x.getMonth() + n);
	// Clamp to the last valid day of the target month.
	const daysInMonth = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
	x.setDate(Math.min(day, daysInMonth));
	return x;
}
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

// Automated recurring billing: for every active, priced subscription whose
// current_period_end has passed, generate a `pending` invoice for each elapsed
// monthly period (deduped on period_end so it's safe to run repeatedly) and roll
// current_period_end forward. Idempotent — designed for a daily cron OR the
// in-process scheduler below. No-ops when the control plane isn't configured.
export async function runBillingCycle(): Promise<{ generated: number; past_due: number; suspended: number }> {
	if (!platformDbConfigured()) {return { generated: 0, past_due: 0, suspended: 0 };}
	let generated = 0;
	let past_due = 0;
	let suspended = 0;
	// Apply scheduled downgrades whose period has ended BEFORE invoicing the
	// (now-current) plan for the next period.
	try { await applyScheduledDowngrades(); } catch (err) { logger.error({ err }, "apply_downgrades_failed"); }

	// 1) Lapsed active priced subscriptions → cut ONE renewal invoice and flag
	//    past_due (grace: login still allowed so the tenant can pay). Do NOT advance
	//    current_period_end — payment (markInvoicePaidAndActivate) rolls it forward.
	//    Dedup is atomic via the invoices_res_period_uniq index (migration 010).
	const lapsed = await platformQuery<{ res_id: string; plan_id: string | null; current_period_end: string; price_cents: number | null }>(
		`select s.res_id, s.plan_id, s.current_period_end, p.price_cents
		   from platform.subscriptions s
		   join platform.plans p on p.id = s.plan_id
		  where s.status = 'active' and coalesce(p.price_cents, 0) > 0
		    and s.current_period_end is not null and s.current_period_end < now()`,
	);
	for (const s of lapsed) {
		const periodStart = new Date(s.current_period_end);
		const periodEnd = addMonths(periodStart, 1);
		const ins = await platformQuery<{ id: string }>(
			`insert into platform.invoices (res_id, plan_id, amount_cents, status, period_start, period_end, note)
			 values ($1, $2, $3, 'pending', $4::date, $5::date, 'Auto-generated (renewal)')
			 on conflict (res_id, period_end) do nothing
			 returning id`,
			[s.res_id, s.plan_id, s.price_cents ?? 0, isoDate(periodStart), isoDate(periodEnd)],
		);
		if (ins.length > 0) {generated++;}
		await platformQuery(
			`update platform.subscriptions set status = 'past_due', updated_at = now() where res_id = $1 and status = 'active'`,
			[s.res_id],
		);
		past_due++;
	}

	// 2) Grace cutoff: past_due beyond SAAS_GRACE_DAYS → suspend (blocks login) and
	//    revoke live sessions. Payment or an operator re-activation restores access.
	const graceDays = Math.max(0, Number(process.env.SAAS_GRACE_DAYS) || 7);
	const overdue = await platformQuery<{ res_id: string }>(
		`update platform.subscriptions set status = 'suspended', updated_at = now()
		   where status = 'past_due' and current_period_end is not null
		     and current_period_end < now() - ($1 || ' days')::interval
		   returning res_id`,
		[String(graceDays)],
	);
	for (const o of overdue) {
		suspended++;
		try { await destroyAllForRestaurant(o.res_id); } catch (err) { logger.error({ err }, "revoke_sessions_failed"); }
	}
	return { generated, past_due, suspended };
}

let billingSchedulerStarted = false;
// Arbitrary fixed key identifying the billing-cycle advisory lock fleet-wide.
const BILLING_LOCK_KEY = 0x5245_5342; // "RESB"
// Run the billing cycle shortly after boot, then daily. Invoice creation is
// deduped on (res_id, period_end) (migration 007), AND a Postgres advisory lock
// elects a single leader so only one replica runs the cycle at a time.
function startBillingScheduler(): void {
	if (billingSchedulerStarted || !platformDbConfigured()) {return;}
	billingSchedulerStarted = true;
	const run = () => {
		withPlatformAdvisoryLock(BILLING_LOCK_KEY, async () => {
			const r = await runBillingCycle();
			if (r.generated || r.past_due || r.suspended) {
				logger.info(`billing_cycle: ${r.generated} renewal invoice(s), ${r.past_due} past-due, ${r.suspended} suspended`);
			}
		})
			.then((ran) => { if (!ran) {logger.info("billing_cycle: skipped (another replica holds the lock)");} })
			.catch((err) => { logger.error({ err }, "billing_cycle_failed"); });
	};
	setTimeout(run, 60_000).unref?.(); // ~1 min after boot
	setInterval(run, 24 * 60 * 60 * 1000).unref?.(); // daily
}

export function registerPlatformRoutes(app: Express): void {
	// --- Auth -------------------------------------------------------------
	app.post("/platform/auth/login", async (req: Request, res: Response) => {
		if (!platformDbConfigured()) {
			res.status(503).json({ error: "Platform control plane is not configured" });
			return;
		}
		// Brute-force guard: cap login attempts per IP (this endpoint controls the
		// whole fleet, so it's the highest-value target).
		const ip = (req.ip || req.socket?.remoteAddress || "unknown");
		if (!platformLoginAllowed(ip)) {
			res.setHeader("Retry-After", "60");
			res.status(429).json({ error: "Too many attempts. Please wait a minute and try again." });
			return;
		}
		const body = (req.body ?? {}) as Record<string, unknown>;
		const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
		const password = typeof body.password === "string" ? body.password : "";
		if (!email || !password) {
			res.status(400).json({ error: "email and password are required" });
			return;
		}
		try {
			const rows = await platformQuery<{
				id: string;
				email: string;
				pass_hash: string;
				name: string | null;
				active: boolean;
			}>(
				`select id, email, pass_hash, name, active from platform.admins where email = $1 limit 1`,
				[email],
			);
			const admin = rows[0];
			if (!admin || !admin.active || !(await verifyPassword(admin.pass_hash, password))) {
				res.status(401).json({ error: "Invalid credentials" });
				return;
			}
			const token = await createPlatformSession({ adminId: admin.id, email: admin.email, name: admin.name });
			res.json({ token, admin: { id: admin.id, email: admin.email, name: admin.name } });
		} catch (err) {
			logger.error({ err }, "platform_login_failed");
			res.status(500).json({ error: "Unable to sign in" });
		}
	});

	app.post("/platform/auth/logout", async (req: Request, res: Response) => {
		const token = bearer(req);
		if (token) {
			try {
				await destroyPlatformSession(token);
			} catch (err) {
				logger.error({ err }, "platform_logout_failed");
			}
		}
		res.json({ ok: true });
	});

	app.get("/platform/auth/me", requirePlatformAuth, (req: Request, res: Response) => {
		res.json({ admin: req.platformAdmin });
	});

	// --- Tenant lifecycle -------------------------------------------------
	app.get("/platform/restaurants", requirePlatformAuth, async (_req: Request, res: Response) => {
		try {
			const rows = await platformQuery(
				`
					select
						r.id, r.res_username, r.res_name, r.account_status, r.created_at,
						s.status as sub_status, s.trial_ends_at, s.current_period_end,
						p.code as plan_code, p.name as plan_name
					from "Restaurant" r
					left join platform.subscriptions s on s.res_id = r.id
					left join platform.plans p on p.id = s.plan_id
					order by r.created_at desc
				`,
			);

			// Attach per-tenant health metrics (counts) in one aggregate call.
			const metrics = new Map<string, { employees: number; outlets: number }>();
			try {
				const m = await platformQuery<{ res_id: string; employees: string; outlets: string }>(
					`select res_id, employees, outlets from platform.all_restaurant_metrics()`,
				);
				for (const row of m) {
					metrics.set(row.res_id, { employees: Number(row.employees), outlets: Number(row.outlets) });
				}
			} catch (err: any) {
				if (!(err?.code === "42883" || err?.code === "3F000")) {
					logger.error({ err }, "platform_metrics_failed");
				}
			}
			const restaurants = (rows as Record<string, any>[]).map((r) => ({
				...r,
				employees: metrics.get(r.id)?.employees ?? null,
				outlets: metrics.get(r.id)?.outlets ?? null,
			}));
			res.json({ restaurants });
		} catch (err) {
			logger.error({ err }, "platform_list_restaurants_failed");
			res.status(500).json({ error: "Unable to list restaurants" });
		}
	});

	app.get("/platform/restaurants/:id", requirePlatformAuth, async (req: Request, res: Response) => {
		try {
			const rows = await platformQuery(
				`
					select
						r.id, r.res_username, r.res_name, r.account_status, r.created_at, r.main_office_add,
						s.status as sub_status, s.trial_ends_at, s.current_period_end, s.plan_id,
						p.code as plan_code, p.name as plan_name
					from "Restaurant" r
					left join platform.subscriptions s on s.res_id = r.id
					left join platform.plans p on p.id = s.plan_id
					where r.id = $1
					limit 1
				`,
				[req.params.id],
			);
			if (!rows[0]) {
				res.status(404).json({ error: "Restaurant not found" });
				return;
			}
			// Best-effort owner lookup (earliest admin) so the operator knows whose
			// password the reset-owner action will change. Optional — degrades to null
			// if the platform DB role can't read the tenant Login/Employees tables.
			let owner: { username: string; name: string } | null = null;
			try {
				// SECURITY DEFINER fn (migration 012) so this works whether the platform
				// connects as the owner or the least-privilege platform_runtime role.
				const o = await platformQuery<{ emp_username: string; fname: string | null; lname: string | null }>(
					`select emp_username, fname, lname from platform.get_restaurant_owner($1)`,
					[req.params.id],
				);
				if (o[0]) {owner = { username: o[0].emp_username, name: `${String(o[0].fname ?? "").trim()} ${String(o[0].lname ?? "").trim()}`.trim() };}
			} catch {/* owner is optional */}
			res.json({ restaurant: { ...rows[0], owner } });
		} catch (err) {
			logger.error({ err }, "platform_get_restaurant_failed");
			res.status(500).json({ error: "Unable to load restaurant" });
		}
	});

	app.post("/platform/restaurants/:id/suspend", requirePlatformAuth, async (req: Request, res: Response) => {
		const resId = req.params.id!;
		try {
			const rows = await platformQuery<{ id: string }>(
				`update "Restaurant" set account_status = 'suspended' where id = $1 returning id`,
				[resId],
			);
			if (!rows[0]) {
				res.status(404).json({ error: "Restaurant not found" });
				return;
			}
			// Revoke every active tenant session immediately.
			await destroyAllForRestaurant(resId);
			await audit(req.platformAdmin!.adminId, "restaurant.suspend", resId, null);
			res.json({ ok: true, account_status: "suspended" });
		} catch (err) {
			logger.error({ err }, "platform_suspend_failed");
			res.status(500).json({ error: "Unable to suspend restaurant" });
		}
	});

	app.post("/platform/restaurants/:id/activate", requirePlatformAuth, async (req: Request, res: Response) => {
		const resId = req.params.id!;
		try {
			const rows = await platformQuery<{ id: string }>(
				`update "Restaurant" set account_status = 'active' where id = $1 returning id`,
				[resId],
			);
			if (!rows[0]) {
				res.status(404).json({ error: "Restaurant not found" });
				return;
			}
			await audit(req.platformAdmin!.adminId, "restaurant.activate", resId, null);
			res.json({ ok: true, account_status: "active" });
		} catch (err) {
			logger.error({ err }, "platform_activate_failed");
			res.status(500).json({ error: "Unable to activate restaurant" });
		}
	});

	// --- Plans ------------------------------------------------------------
	app.get("/platform/plans", requirePlatformAuth, async (_req: Request, res: Response) => {
		try {
			const rows = await platformQuery(`select * from platform.plans order by price_cents asc, created_at asc`);
			res.json({ plans: rows });
		} catch (err) {
			logger.error({ err }, "platform_list_plans_failed");
			res.status(500).json({ error: "Unable to list plans" });
		}
	});

	app.post("/platform/plans", requirePlatformAuth, async (req: Request, res: Response) => {
		const body = (req.body ?? {}) as Record<string, unknown>;
		const code = typeof body.code === "string" ? body.code.trim() : "";
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!code || !name) {
			res.status(400).json({ error: "code and name are required" });
			return;
		}
		try {
			const rows = await platformQuery(
				`
					insert into platform.plans (code, name, price_cents, features, limits, active)
					values ($1, $2, $3, $4, $5, coalesce($6, true))
					returning *
				`,
				[
					code,
					name,
					Number(body.price_cents ?? 0),
					JSON.stringify(body.features ?? {}),
					JSON.stringify(body.limits ?? {}),
					typeof body.active === "boolean" ? body.active : null,
				],
			);
			await audit(req.platformAdmin!.adminId, "plan.create", null, { code });
			res.status(201).json({ plan: rows[0] });
		} catch (err: any) {
			if (err?.code === "23505") {
				res.status(409).json({ error: `Plan code "${code}" already exists` });
				return;
			}
			logger.error({ err }, "platform_create_plan_failed");
			res.status(500).json({ error: "Unable to create plan" });
		}
	});

	app.patch("/platform/plans/:id", requirePlatformAuth, async (req: Request, res: Response) => {
		const body = (req.body ?? {}) as Record<string, unknown>;
		try {
			const rows = await platformQuery(
				`
					update platform.plans set
						name = coalesce($2, name),
						price_cents = coalesce($3, price_cents),
						features = coalesce($4, features),
						limits = coalesce($5, limits),
						active = coalesce($6, active)
					where id = $1
					returning *
				`,
				[
					req.params.id,
					typeof body.name === "string" ? body.name.trim() : null,
					body.price_cents === undefined ? null : Number(body.price_cents),
					body.features === undefined ? null : JSON.stringify(body.features),
					body.limits === undefined ? null : JSON.stringify(body.limits),
					typeof body.active === "boolean" ? body.active : null,
				],
			);
			if (!rows[0]) {
				res.status(404).json({ error: "Plan not found" });
				return;
			}
			await audit(req.platformAdmin!.adminId, "plan.update", null, { id: req.params.id });
			res.json({ plan: rows[0] });
		} catch (err) {
			logger.error({ err }, "platform_update_plan_failed");
			res.status(500).json({ error: "Unable to update plan" });
		}
	});

	// --- Subscription assignment -----------------------------------------
	app.put("/platform/restaurants/:id/subscription", requirePlatformAuth, async (req: Request, res: Response) => {
		const resId = req.params.id!;
		const body = (req.body ?? {}) as Record<string, unknown>;
		const status = typeof body.status === "string" ? body.status.trim() : "active";
		const allowed = new Set(["trial", "active", "past_due", "suspended", "cancelled", "expired"]);
		if (!allowed.has(status)) {
			res.status(400).json({ error: `invalid status; one of ${[...allowed].join(", ")}` });
			return;
		}
		try {
			const rows = await platformQuery(
				`
					insert into platform.subscriptions (res_id, plan_id, status, trial_ends_at, current_period_end, updated_at)
					values (
						$1, $2, $3, $4,
						coalesce($5::timestamptz, case when $3 = 'active' then now() + interval '1 month' else null end),
						now()
					)
					on conflict (res_id) do update set
						plan_id = excluded.plan_id,
						status = excluded.status,
						trial_ends_at = excluded.trial_ends_at,
						-- Default an active assignment to a 1-month period so it is billable and
						-- downgrades can apply; keep the existing period when none is implied.
						current_period_end = coalesce(excluded.current_period_end, platform.subscriptions.current_period_end),
						updated_at = now()
					returning *
				`,
				[
					resId,
					typeof body.plan_id === "string" ? body.plan_id : null,
					status,
					body.trial_ends_at ? new Date(String(body.trial_ends_at)) : null,
					body.current_period_end ? new Date(String(body.current_period_end)) : null,
				],
			);
			// If the new status is non-active, revoke the tenant's live sessions.
			if (status === "suspended" || status === "cancelled" || status === "expired") {
				await destroyAllForRestaurant(resId);
			}
			await audit(req.platformAdmin!.adminId, "subscription.set", resId, { status });
			res.json({ subscription: rows[0] });
		} catch (err) {
			logger.error({ err }, "platform_set_subscription_failed");
			res.status(500).json({ error: "Unable to set subscription" });
		}
	});

	// --- Billing history (invoices) -----------------------------------------
	app.get("/platform/restaurants/:id/invoices", requirePlatformAuth, async (req: Request, res: Response) => {
		const resId = req.params.id!;
		try {
			const rows = await platformQuery(
				`select i.*, p.name as plan_name, p.code as plan_code
				   from platform.invoices i
				   left join platform.plans p on p.id = i.plan_id
				   where i.res_id = $1
				   order by i.created_at desc limit 200`,
				[resId],
			);
			res.json({ invoices: rows });
		} catch (err) {
			logger.error({ err }, "platform_invoices_failed");
			res.status(500).json({ error: "Unable to fetch invoices" });
		}
	});

	app.post("/platform/restaurants/:id/invoices", requirePlatformAuth, async (req: Request, res: Response) => {
		const resId = req.params.id!;
		const body = (req.body ?? {}) as Record<string, unknown>;
		const status = typeof body.status === "string" && ["paid", "pending", "void"].includes(body.status) ? body.status : "paid";
		try {
			// Default the amount + plan from the restaurant's current subscription plan.
			let amountCents = typeof body.amount_cents === "number" ? Math.round(body.amount_cents) : null;
			let planId = typeof body.plan_id === "string" ? body.plan_id : null;
			if (amountCents == null || !planId) {
				const sub = await platformQuery<{ plan_id: string | null; price_cents: number | null }>(
					`select s.plan_id, p.price_cents from platform.subscriptions s left join platform.plans p on p.id = s.plan_id where s.res_id = $1 limit 1`,
					[resId],
				);
				if (!planId) {planId = sub[0]?.plan_id ?? null;}
				if (amountCents == null) {amountCents = sub[0]?.price_cents ?? 0;}
			}
			const rows = await platformQuery(
				`insert into platform.invoices (res_id, plan_id, amount_cents, status, period_start, period_end, note)
				   values ($1, $2, $3, $4, $5, $6, $7) returning *`,
				[
					resId,
					planId,
					amountCents ?? 0,
					status,
					body.period_start ? new Date(String(body.period_start)) : null,
					body.period_end ? new Date(String(body.period_end)) : null,
					typeof body.note === "string" ? body.note : null,
				],
			);
			// Recording a directly-paid invoice should also activate its plan, matching
			// the paid => active contract (otherwise "Record payment" leaves the plan stale).
			if (status === "paid" && planId) {
				try { await activateSubscriptionPlan(resId, planId); } catch (e) { logger.error({ err: e }, "activate_on_record_payment_failed"); }
			}
			await audit(req.platformAdmin!.adminId, "invoice.create", resId, { amount_cents: amountCents, status });
			res.status(201).json({ invoice: rows[0] });
		} catch (err) {
			logger.error({ err }, "platform_create_invoice_failed");
			res.status(500).json({ error: "Unable to create invoice" });
		}
	});

	// Mark an existing invoice paid AND activate its plan (manual/offline payment
	// confirmation). Switches the restaurant's subscription to the invoice's plan.
	app.post("/platform/invoices/:id/mark-paid", requirePlatformAuth, async (req: Request, res: Response) => {
		try {
			const result = await markInvoicePaidAndActivate(String(req.params.id));
			if (!result) { res.status(404).json({ error: "Invoice not found" }); return; }
			await audit(req.platformAdmin!.adminId, "invoice.mark_paid", result.res_id, { invoice_id: req.params.id, plan_id: result.plan_id });
			res.json({ ok: true, ...result });
		} catch (err) {
			logger.error({ err }, "platform_mark_invoice_paid_failed");
			res.status(500).json({ error: "Unable to mark invoice paid" });
		}
	});

	// Manually trigger the recurring-billing run (also runs automatically daily).
	// Serialized under the same advisory lock as the scheduler so a manual run and
	// the daily timer (or two operators/replicas) can't run the cycle concurrently.
	app.post("/platform/billing/run", requirePlatformAuth, async (req: Request, res: Response) => {
		try {
			let result: { generated: number; past_due: number; suspended: number } | null = null;
			const ran = await withPlatformAdvisoryLock(BILLING_LOCK_KEY, async () => { result = await runBillingCycle(); });
			if (!ran || !result) { res.status(409).json({ error: "A billing run is already in progress. Try again shortly." }); return; }
			await audit(req.platformAdmin!.adminId, "billing.run", null, result);
			res.json({ ok: true, ...(result as { generated: number; past_due: number; suspended: number }) });
		} catch (err) {
			logger.error({ err }, "platform_billing_run_failed");
			res.status(500).json({ error: "Unable to run billing" });
		}
	});

	app.get("/platform/invoices", requirePlatformAuth, async (_req: Request, res: Response) => {
		try {
			const rows = await platformQuery(
				`select i.*, r.res_name as restaurant_name, p.name as plan_name
				   from platform.invoices i
				   left join "Restaurant" r on r.id = i.res_id
				   left join platform.plans p on p.id = i.plan_id
				   order by i.created_at desc limit 200`,
			);
			res.json({ invoices: rows });
		} catch (err) {
			logger.error({ err }, "platform_all_invoices_failed");
			res.status(500).json({ error: "Unable to fetch invoices" });
		}
	});

	// --- Monitoring: fleet + system health -------------------------------
	// One call the operator can poll to see whether the platform is healthy and
	// how the tenant fleet breaks down (active/suspended/trial, recent signups).
	app.get("/platform/health", requirePlatformAuth, async (_req: Request, res: Response) => {
		const health: Record<string, unknown> = { db: false, ts: new Date().toISOString() };
		try {
			await platformQuery(`select 1 as ok`);
			health.db = true;
		} catch (err) {
			logger.error({ err }, "platform_health_db_failed");
		}
		try {
			const rows = await platformQuery<{
				total: number; active: number; suspended: number; new_this_week: number;
			}>(
				`select
				   count(*)::int as total,
				   count(*) filter (where coalesce(account_status, 'active') = 'active')::int as active,
				   count(*) filter (where account_status = 'suspended')::int as suspended,
				   count(*) filter (where created_at > now() - interval '7 days')::int as new_this_week
				 from "Restaurant"`,
			);
			health.fleet = rows[0] ?? null;
		} catch (err) {
			logger.error({ err }, "platform_health_fleet_failed");
		}
		try {
			const subs = await platformQuery<{ status: string; n: number }>(
				`select coalesce(status, 'none') as status, count(*)::int as n
				   from platform.subscriptions group by status`,
			);
			const byStatus: Record<string, number> = {};
			for (const s of subs) {byStatus[s.status] = Number(s.n);}
			// Trials expiring within 7 days — worth the operator's attention.
			const expiring = await platformQuery<{ n: number }>(
				`select count(*)::int as n from platform.subscriptions
				   where status = 'trial' and trial_ends_at is not null
				     and trial_ends_at between now() and now() + interval '7 days'`,
			);
			health.subscriptions = { by_status: byStatus, trials_expiring_soon: Number(expiring[0]?.n ?? 0) };
		} catch (err: any) {
			if (!(err?.code === "42883" || err?.code === "3F000" || err?.code === "42P01")) {
				logger.error({ err }, "platform_health_subs_failed");
			}
		}
		res.json(health);
	});

	// --- Monitoring: read the platform audit trail -----------------------
	// The audit table is written on every privileged action; surface it so the
	// operator can see who did what (optionally filtered to one tenant).
	app.get("/platform/audit", requirePlatformAuth, async (req: Request, res: Response) => {
		const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
		const limit = Math.min(500, Math.max(1, Number.parseInt(String(rawLimit ?? "100"), 10) || 100));
		const resId = typeof req.query.res_id === "string" ? req.query.res_id : null;
		try {
			const rows = await platformQuery(
				`select a.id, a.admin_id, a.action, a.target_res_id, a.detail, a.created_at,
				        ad.email as admin_email, r.res_name as target_name
				   from platform.audit a
				   left join platform.admins ad on ad.id = a.admin_id
				   left join "Restaurant" r on r.id = a.target_res_id
				   where ($2::uuid is null or a.target_res_id = $2::uuid)
				   order by a.created_at desc
				   limit $1`,
				[limit, resId],
			);
			res.json({ entries: rows });
		} catch (err) {
			logger.error({ err }, "platform_audit_read_failed");
			res.status(500).json({ error: "Unable to read audit log" });
		}
	});

	// --- Intervention: reset a locked-out tenant owner's password --------
	// The key "fix from behind the scenes" capability: when a restaurant owner is
	// locked out, the operator sets a new password for the owner (earliest-created
	// admin) and all that tenant's live sessions are revoked.
	app.post("/platform/restaurants/:id/reset-owner-password", requirePlatformAuth, async (req: Request, res: Response) => {
		const resId = req.params.id!;
		const body = (req.body ?? {}) as Record<string, unknown>;
		const password = typeof body.password === "string" ? body.password.trim() : "";
		if (password.length < 4) {
			res.status(400).json({ error: "Password must be at least 4 characters" });
			return;
		}
		try {
			// Find-and-update atomically via the SECURITY DEFINER fn (migration 012) so
			// the least-privilege platform_runtime role can do this one cross-tenant
			// operation without direct grants on / RLS exceptions for Login/Employees.
			const hash = await hashPassword(password);
			const owner = await platformQuery<{ emp_id: string; emp_username: string }>(
				`select emp_id, emp_username from platform.reset_owner_password($1, $2)`,
				[resId, hash],
			);
			if (!owner[0]) {
				res.status(404).json({ error: "No owner (admin) account found for this restaurant" });
				return;
			}
			// Force re-login everywhere for this tenant.
			await destroyAllForRestaurant(resId);
			await audit(req.platformAdmin!.adminId, "restaurant.reset_owner_password", resId, { username: owner[0].emp_username });
			res.json({ ok: true, username: owner[0].emp_username });
		} catch (err) {
			logger.error({ err }, "platform_reset_owner_password_failed");
			res.status(500).json({ error: "Unable to reset owner password" });
		}
	});

	// Kick off the automated recurring-billing scheduler (daily).
	startBillingScheduler();
}
