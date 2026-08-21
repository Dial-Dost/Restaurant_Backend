import { randomBytes } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { destroyAllForRestaurant } from "../auth/sessions.js";
import { CountOpenBillsForRestaurant } from "../database_supabase.js";
import { normalizeRestaurantSlug, provisionRestaurant, RestaurantExistsError } from "../provisioning.js";
import { passwordPolicyError, rateLimit } from "../routes/_shared.js";
import {
	platformQuery,
	platformDbConfigured,
	withPlatformAdvisoryLock,
	withPlatformTransaction,
	archivedStatusSupported,
	archivedStatusUnsupportedMessage,
} from "./db.js";
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

// The subscription statuses platform.subscriptions.status may hold. Shared by the
// assignment route (which validates operator input against it) and the restore
// route (which will only put back a status from this set), so the two can never
// disagree about what a legal status is.
const SUBSCRIPTION_STATUSES = new Set(["trial", "active", "past_due", "suspended", "cancelled", "expired"]);

// The subscription statuses platform.restaurant_status maps to something OTHER
// than 'active' (migrations/011_billing_grace.sql:18-20, unchanged by 028), i.e.
// the ones that make routes/auth.ts refuse a login. Restore reads this to tell the
// operator when a tenant is un-archived but still locked out. Kept next to
// SUBSCRIPTION_STATUSES so the two lists are read — and updated — together.
const LOGIN_BLOCKING_SUBSCRIPTION_STATUSES = new Set(["suspended", "cancelled", "expired"]);

// Archive's subscription cancel, written once and used by BOTH the fresh-archive
// path and the re-assertion path so they can never drift apart.
//
// `status <> 'cancelled'` makes it a no-op on an already-cancelled subscription,
// and `returning res_id` reports whether it actually changed anything — which is
// how the re-assertion branch knows it caught a subscription that had been moved
// back off 'cancelled' while the tenant was archived.
//
// REQUIRED, not best-effort. runBillingCycle selects purely on
// platform.subscriptions.status and never reads account_status, so a departed
// tenant left on a priced 'active' subscription keeps generating monthly invoices
// forever — and after SAAS_GRACE_DAYS "suspends" an already-archived one, muddying
// the audit story. 'cancelled' is an existing accepted status and every billing
// predicate excludes it.
const CANCEL_SUBSCRIPTION_SQL =
	`update platform.subscriptions set status = 'cancelled', updated_at = now()
	  where res_id = $1 and status <> 'cancelled' returning res_id`;

// A first-login credential for a restaurant the OPERATOR created. Generated
// server-side and returned exactly once, in the 201 body: the operator reads it
// to the owner, who changes it in Settings. It is never stored anywhere but the
// argon2 hash EnsureRestaurantSeed writes, never logged, and never put in the
// audit detail. Lost before handover => reset-owner-password.
//
// The create route deliberately does NOT accept a password. Note that
// reset-owner-password (below) still accepts anything >= 4 characters — do not
// copy that floor here; this asserts the tenant's OWN policy instead, so an
// operator-created owner is never weaker than a self-registered one.
function generateTemporaryPassword(): string {
	// base64url of 18 bytes = 24 characters. The alphabet is [A-Za-z0-9_-], so it
	// almost always satisfies "letters and digits" — but "almost always" is not a
	// guarantee, hence the check rather than an assumption.
	for (let i = 0; i < 20; i++) {
		const candidate = randomBytes(18).toString("base64url");
		if (!passwordPolicyError(candidate)) {return candidate;}
	}
	throw new Error("Unable to generate a temporary password that meets the password policy");
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
		// One tenant's failure must not abort the sweep — every other lapsed tenant,
		// and the grace/suspend pass below, still have to run.
		try {
			const periodStart = new Date(s.current_period_end);
			const periodEnd = addMonths(periodStart, 1);
			const ins = await platformQuery<{ id: string }>(
				// invoices_res_period_uniq is PARTIAL (where period_end is not null), and
				// Postgres will not infer a partial index unless the ON CONFLICT clause
				// repeats its predicate — without it this INSERT raised 42P10 on every
				// run, so no tenant was ever invoiced or moved off 'active'.
				`insert into platform.invoices (res_id, plan_id, amount_cents, status, period_start, period_end, note)
				 values ($1, $2, $3, 'pending', $4::date, $5::date, 'Auto-generated (renewal)')
				 on conflict (res_id, period_end) where period_end is not null do nothing
				 returning id`,
				[s.res_id, s.plan_id, s.price_cents ?? 0, isoDate(periodStart), isoDate(periodEnd)],
			);
			if (ins.length > 0) {generated++;}
			await platformQuery(
				`update platform.subscriptions set status = 'past_due', updated_at = now() where res_id = $1 and status = 'active'`,
				[s.res_id],
			);
			past_due++;
		} catch (err) {
			logger.error({ err, res_id: s.res_id }, "billing_cycle_invoice_failed");
		}
	}

	// 1b) Lapsed subscriptions with nothing to charge (free plan, or no plan yet)
	//     are never invoiced, so nothing else would ever move their period end —
	//     they would sit 'active' with a period end drifting further into the past.
	//     Roll them forward to the next period that is still in the future.
	const freeLapsed = await platformQuery<{ res_id: string; current_period_end: string }>(
		`select s.res_id, s.current_period_end
		   from platform.subscriptions s
		   left join platform.plans p on p.id = s.plan_id
		  where s.status = 'active' and coalesce(p.price_cents, 0) = 0
		    and s.current_period_end is not null and s.current_period_end < now()`,
	);
	for (const s of freeLapsed) {
		try {
			let next = new Date(s.current_period_end);
			const now = Date.now();
			// Bounded: even a period end years stale converges in a few dozen steps.
			for (let i = 0; i < 600 && next.getTime() <= now; i++) {next = addMonths(next, 1);}
			await platformQuery(
				`update platform.subscriptions set current_period_end = $2, updated_at = now()
				  where res_id = $1 and status = 'active'`,
				[s.res_id, next.toISOString()],
			);
		} catch (err) {
			logger.error({ err, res_id: s.res_id }, "billing_cycle_free_rollover_failed");
		}
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

	// Operator-driven onboarding: create a tenant on the customer's behalf, with a
	// slug the operator controls and (optionally) the plan they just sold.
	//
	// The seeding itself is NOT done here. platform_runtime holds no INSERT on
	// "Restaurant" and no grants at all on "Outlets"/"Employees"/"Login"
	// (migrations/004_platform_schema.sql:75), all of which are additionally under
	// fail-closed RLS — so this cannot be written with platformQuery. It goes
	// through provisionRestaurant, the same function POST /auth/register-restaurant
	// uses, which runs on the tenant pool as app_runtime. No new grant, no new
	// SECURITY DEFINER function, and no second copy of the creation logic.
	//
	// Rate limited on its OWN bucket: sharing the public "register" bucket would
	// 429 an operator onboarding a chain and would let operator traffic eat the
	// public allowance. The real guard is requirePlatformAuth.
	app.post("/platform/restaurants", requirePlatformAuth, rateLimit("platform-create-restaurant", 20, 60_000), async (req: Request, res: Response) => {
		const body = (req.body ?? {}) as Record<string, unknown>;
		const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
		const resName = str(body.res_name);
		const ownerName = str(body.owner_name);
		const ownerUsername = str(body.owner_username);
		const planId = typeof body.plan_id === "string" && body.plan_id.trim() ? body.plan_id.trim() : null;

		if (!resName || !ownerName || !ownerUsername) {
			res.status(400).json({ error: "res_name, owner_name and owner_username are required" });
			return;
		}
		if (resName.length > 120 || ownerName.length > 120 || ownerUsername.length > 120) {
			res.status(400).json({ error: "res_name, owner_name and owner_username must be 120 characters or fewer" });
			return;
		}

		// The slug is the operator's to choose (a colliding or ugly derived slug is
		// exactly why this route exists), but it must survive normalization
		// unchanged — the value is written raw to res_username while every lookup
		// reads lower(res_username), and it is baked into every printed QR URL, so a
		// slug the operator cannot retype is a slug nobody can support.
		const supplied = str(body.res_username);
		const slug = supplied ? normalizeRestaurantSlug(supplied) : normalizeRestaurantSlug(resName);
		if (!slug) {
			res.status(400).json({ error: "res_username must contain letters or numbers" });
			return;
		}
		if (supplied && supplied !== slug) {
			res.status(400).json({ error: `res_username must be lowercase letters and digits only — did you mean "${slug}"?` });
			return;
		}

		const profile = {
			...(str(body.address) ? { address: str(body.address) } : {}),
			...(str(body.phone) ? { phone: str(body.phone) } : {}),
			...(str(body.email) ? { email: str(body.email) } : {}),
			...(str(body.hours) ? { hours: str(body.hours) } : {}),
		};

		// Validate plan_id BEFORE anything is written. activateSubscriptionPlan runs
		// AFTER the seed has committed and outside any transaction, so a bad plan_id
		// used to answer 400 with the restaurant, its outlet, its owner and its
		// "Login" row already created — and the generated temporary password
		// discarded, never returned. The operator saw a validation error, retried,
		// and got 409 slug already taken, with nothing telling them the tenant
		// existed or that recovery was reset-owner-password. Checking first turns
		// the common case (a typo, or a stale plan picker) into a clean 400 with
		// nothing created. The 23503 handler below stays as the backstop for a plan
		// deleted between this read and the assignment.
		if (planId) {
			let known: boolean | null = null;   // null = could not determine
			try {
				known = (await platformQuery<{ id: string }>(
					`select id from platform.plans where id = $1 limit 1`,
					[planId],
				)).length > 0;
			} catch (err) {
				// 22P02 is "invalid input syntax for type uuid" — the operator sent
				// something that is not a plan id at all, which is an unknown plan, not
				// an outage. Any other error means the control plane is genuinely
				// unreachable; leave `known` null and let the create proceed exactly as
				// it did before, so a transient blip does not block onboarding.
				if ((err as { code?: string } | null)?.code === "22P02") { known = false; }
				else { logger.warn({ err, plan_id: planId }, "platform_create_plan_precheck_failed"); }
			}
			if (known === false) {
				res.status(400).json({ error: "Unknown plan_id" });
				return;
			}
		}

		const temporaryPassword = generateTemporaryPassword();
		// Everything after provisionRestaurant returns runs against a tenant that
		// ALREADY EXISTS and whose owner password is this (unpersisted) string, so a
		// failure past this point must never read as "nothing happened".
		let seeded = false;
		try {
			const created = await provisionRestaurant({
				restaurantName: resName,
				slug,
				adminName: ownerName,
				adminUsername: ownerUsername,
				password: temporaryPassword,
				...(Object.keys(profile).length > 0 ? { profile } : {}),
				// An operator with a signed plan gets that plan, not a trial. With no
				// plan named, fall back to the same trial self-serve signup starts.
				startTrial: planId === null,
			});
			seeded = true;

			// Every console action keys on "Restaurant".id, so a null here would hand
			// back a tenant the operator cannot manage. provisionRestaurant's read-back
			// is best-effort on the TENANT pool; platform_runtime has SELECT on
			// "Restaurant" (004:75), so try once more on this pool before giving up.
			let resId = created.res_id;
			if (!resId) {
				const found = await platformQuery<{ id: string }>(
					`select id from "Restaurant" where lower(res_username) = lower($1) limit 1`,
					[created.res_username],
				);
				resId = found[0]?.id ?? null;
			}
			if (!resId) {
				// The tenant WAS created — a retry will 409 on the slug. Say so, rather
				// than pretending nothing happened.
				logger.error({ res_username: created.res_username }, "platform_create_restaurant_id_unresolved");
				res.status(500).json({ error: `Restaurant "${slug}" was created but its id could not be read back. Find it in the restaurant list and set the owner password there.` });
				return;
			}

			// A plan the operator already sold: activate it now (1-month period), the
			// same transition "Record payment" performs.
			if (planId) {
				await activateSubscriptionPlan(resId, planId);
			}

			await audit(req.platformAdmin!.adminId, "restaurant.create", resId, {
				res_username: created.res_username,
				res_name: resName,
				owner_username: ownerUsername,
				plan_id: planId,
			});

			res.status(201).json({
				restaurant: { id: resId, res_username: created.res_username, res_name: resName },
				owner: {
					username: ownerUsername,
					// Shown ONCE. There is no forced-change-on-first-login mechanism in
					// this codebase, so the operator must tell the owner to change it.
					temporary_password: temporaryPassword,
				},
			});
		} catch (err) {
			if (err instanceof RestaurantExistsError) {
				res.status(409).json({ error: `The slug "${slug}" is already taken. Choose a different res_username.`, res_username: slug });
				return;
			}
			// Two callers racing the existence pre-check both reach the INSERT; the
			// loser trips Restaurant_res_username_key. With a hand-typed slug that is
			// a normal correctable outcome, so it answers 409 like the check above
			// rather than a 500.
			if ((err as { code?: string } | null)?.code === "23505") {
				res.status(409).json({ error: `The slug "${slug}" is already taken. Choose a different res_username.`, res_username: slug });
				return;
			}
			// A plan deleted between the pre-check above and activateSubscriptionPlan.
			// The seed has already COMMITTED by then and the temporary password is
			// gone, so answering a bare "Unknown plan_id" sends the operator into a
			// retry that 409s on the slug with nothing explaining why. Say what
			// happened and how to finish, exactly as the id-unresolved branch above
			// already does.
			if ((err as { code?: string } | null)?.code === "23503") {
				logger.error({ err, res_username: slug, plan_id: planId }, "platform_create_plan_assignment_failed");
				res.status(400).json({
					error: seeded
						? `Unknown plan_id. Restaurant "${slug}" WAS created, but no plan could be assigned to it. Find it in the restaurant list, assign a plan, and set the owner password there — the temporary password from this request was not saved.`
						: "Unknown plan_id",
					...(seeded ? { restaurant_created: true, res_username: slug } : {}),
				});
				return;
			}
			if (seeded) {
				// Same reasoning for every other late failure: the tenant exists.
				logger.error({ err, res_username: slug }, "platform_create_restaurant_failed_after_seed");
				res.status(500).json({
					error: `Restaurant "${slug}" was created, but the rest of the setup failed. Find it in the restaurant list, check its plan, and set the owner password there — the temporary password from this request was not saved.`,
					restaurant_created: true,
					res_username: slug,
				});
				return;
			}
			logger.error({ err }, "platform_create_restaurant_failed");
			res.status(500).json({ error: "Unable to create restaurant" });
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
			// Refuse to lift an ARCHIVE. This write used to be unconditional, which
			// meant the wrong button produced a tenant that is live and trading again
			// while its subscription stays 'cancelled' — i.e. unbilled, and with no
			// record of what its plan had been. Restore exists to undo both halves.
			const rows = await platformQuery<{ id: string }>(
				`update "Restaurant" set account_status = 'active'
				  where id = $1 and coalesce(account_status, 'active') <> 'archived' returning id`,
				[resId],
			);
			if (!rows[0]) {
				const current = await platformQuery<{ account_status: string | null }>(
					`select account_status from "Restaurant" where id = $1 limit 1`,
					[resId],
				);
				if (!current[0]) {
					res.status(404).json({ error: "Restaurant not found" });
					return;
				}
				res.status(409).json({ error: "This restaurant is archived. Use Restore to bring it back." });
				return;
			}
			await audit(req.platformAdmin!.adminId, "restaurant.activate", resId, null);
			res.json({ ok: true, account_status: "active" });
		} catch (err) {
			logger.error({ err }, "platform_activate_failed");
			res.status(500).json({ error: "Unable to activate restaurant" });
		}
	});

	// --- Tenant removal: ARCHIVE, and its exact inverse ---------------------
	//
	// THERE IS NO DELETE ROUTE, AND THERE MUST NOT BE ONE. Every tenant table —
	// "Orders", "Bills" (with their tax_breakdown), "Audit_logs",
	// "Feedback_entries", "Customers", "Employees", "Outlets" — declares
	// `res_id ... ON DELETE CASCADE` to "Restaurant"(id)
	// (migrations/000_base_schema.sql:433-477). So `delete from "Restaurant"
	// where id = $1` is one statement that erases a tenant's entire statutory
	// financial history, irrecoverably. Removing a restaurant means this flag
	// plus a cancelled subscription; not a single row is deleted or rewritten.
	//
	// Archive touches exactly TWO columns — "Restaurant".account_status and
	// platform.subscriptions.status — which is the property that makes restore
	// honest: it only has to put those two back.
	app.post("/platform/restaurants/:id/archive", requirePlatformAuth, async (req: Request, res: Response) => {
		const resId = req.params.id!;
		const body = (req.body ?? {}) as Record<string, unknown>;
		const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;
		try {
			// RELEASE GATE. Nothing reads account_status = 'archived' until migration
			// 028 replaces platform.restaurant_status; before that this route writes a
			// flag that the login gate, the guest-write gate and the report sweep all
			// ignore, so the console would say "Archived" while the tenant kept trading
			// and kept taking QR orders. Refuse rather than lie — the full argument,
			// and why the container deploy path does not apply it, is in platform/db.ts.
			const support = await archivedStatusSupported();
			if (!support.supported) {
				logger.error({ res_id: resId, reason: support.reason }, "platform_archive_blocked_migration_028_missing");
				res.status(503).json({
					error: archivedStatusUnsupportedMessage(support.reason),
					migration_required: "028_restaurant_archived_status.sql",
				});
				return;
			}

			const current = await platformQuery<{ account_status: string | null }>(
				`select account_status from "Restaurant" where id = $1 limit 1`,
				[resId],
			);
			if (!current[0]) {
				res.status(404).json({ error: "Restaurant not found" });
				return;
			}

			// Best-effort, on the tenant pool (the control plane cannot read "Bills").
			// Runs BEFORE the transaction opens: it is a different pool, and holding a
			// platform connection open across a tenant round trip would stretch the
			// transaction for no benefit. Recorded because archiving mid-service
			// strands an unsettled bill: the row stays open, the table stays occupied,
			// and nobody can log in to settle it. NOT auto-settled — inventing a
			// settlement for money that may never have been collected writes a false
			// financial record, which is strictly worse.
			let openBills: number | null = null;
			try {
				openBills = await CountOpenBillsForRestaurant(resId);
			} catch (err) {
				logger.warn({ err, res_id: resId }, "platform_archive_open_bills_unavailable");
			}

			// ONE CLIENT, ONE TRANSACTION. These writes used to be separate
			// platformQuery calls, i.e. separate pooled connections. If the
			// subscription cancel failed after the flag was written, the tenant was
			// archived but still on a priced 'active' subscription — invoiced monthly
			// forever — and no audit row existed, so restore had lost its recovery data
			// too. The retry then short-circuited on "already archived" and repaired
			// none of it. Now the flag, the cancel and the recovery row commit together
			// or not at all.
			const outcome = await withPlatformTransaction(async (tx) => {
				// FOR UPDATE: two operators clicking Archive at the same moment would
				// otherwise both read 'active' and both write a recovery row, and the
				// second would record the POST-archive values ('archived' / 'cancelled')
				// — destroying the only way back. The lock serialises them, so the
				// second one sees 'archived' and takes the re-assertion branch below.
				const locked = await tx<{ account_status: string | null }>(
					`select account_status from "Restaurant" where id = $1 for update`,
					[resId],
				);
				if (!locked[0]) { return { kind: "missing" as const }; }
				const priorStatus = locked[0].account_status ?? "active";

				const priorSub = await tx<{ status: string | null; plan_id: string | null }>(
					`select status, plan_id from platform.subscriptions where res_id = $1 limit 1`,
					[resId],
				);

				// The SAME statement restore reads, so the two can never disagree about
				// which row is the recovery row. Its presence means a previous archive
				// of this tenant committed and its pre-archive subscription status is
				// already on record.
				const recovery = await tx<{ detail: Record<string, unknown> | null }>(
					`select detail from platform.audit
					  where target_res_id = $1 and action = 'restaurant.archive'
					  order by created_at desc limit 1`,
					[resId],
				);

				// RE-ASSERTION, NOT A SHORT-CIRCUIT. An already-archived tenant with a
				// recovery row is fully archived — but its subscription can have been
				// moved off 'cancelled' since, because PUT /platform/restaurants/:id/
				// subscription writes it without looking at account_status. That
				// silently resumes invoicing a departed tenant, so re-cancel it.
				// Deliberately WITHOUT a second recovery row: a second one would record
				// 'archived' / 'cancelled' as the prior state and restore would then put
				// the tenant back cancelled, i.e. still locked out.
				if (priorStatus === "archived" && recovery.length > 0) {
					const recancelled = await tx<{ res_id: string }>(CANCEL_SUBSCRIPTION_SQL, [resId]);
					return { kind: "already" as const, subscription_recancelled: recancelled.length > 0 };
				}

				// Either a fresh archive, or a REPAIR: flagged 'archived' with no
				// recovery row, which is exactly what a partial write (or a row flipped
				// by hand) leaves behind. Repairing is sound because the two cases are
				// the same situation — the cancel never happened, so the subscription
				// still holds its genuine pre-archive status, and recording it now
				// recovers precisely the information the failed attempt would have.
				await tx(`update "Restaurant" set account_status = 'archived' where id = $1`, [resId]);
				await tx<{ res_id: string }>(CANCEL_SUBSCRIPTION_SQL, [resId]);

				// Written INSIDE the transaction, and NOT through audit() (which swallows
				// its own failures), because for archive this row is not a log line — it
				// is restore's only recovery data. If it cannot be written the archive
				// must not commit: an unrecoverable archive is worse than a refused one.
				await tx(
					`insert into platform.audit (admin_id, action, target_res_id, detail) values ($1, $2, $3, $4)`,
					[
						req.platformAdmin!.adminId,
						"restaurant.archive",
						resId,
						JSON.stringify({
							reason,
							prev_account_status: priorStatus,
							prev_sub_status: priorSub[0]?.status ?? null,
							prev_plan_id: priorSub[0]?.plan_id ?? null,
							open_bills: openBills,
							// Present only when this call finished a previous attempt's
							// work, so the normal detail shape is untouched.
							...(priorStatus === "archived" ? { repaired: true } : {}),
						}),
					],
				);
				return { kind: priorStatus === "archived" ? ("repaired" as const) : ("archived" as const) };
			});

			if (outcome.kind === "missing") {
				res.status(404).json({ error: "Restaurant not found" });
				return;
			}

			// AFTER the commit and outside it: revocation is Redis, not Postgres, so it
			// cannot join the transaction. The ordering is still right — the flag is
			// committed before the tokens are dropped, so a login racing the gap is
			// already refused by routes/auth.ts. It is idempotent, and every branch runs
			// it, because an archived tenant must never have a live session.
			await destroyAllForRestaurant(resId);

			if (outcome.kind === "already") {
				res.json({
					ok: true,
					account_status: "archived",
					already_archived: true,
					open_bills: openBills,
					subscription_recancelled: outcome.subscription_recancelled,
				});
				return;
			}
			res.json({
				ok: true,
				account_status: "archived",
				open_bills: openBills,
				...(outcome.kind === "repaired" ? { already_archived: true, repaired: true } : {}),
			});
		} catch (err) {
			logger.error({ err }, "platform_archive_failed");
			res.status(500).json({ error: "Unable to archive restaurant" });
		}
	});

	// The inverse of archive. Restores to a KNOWN state, not a guessed one:
	// blindly setting the subscription back to 'active' would resume billing for a
	// tenant who left while on 'trial' or 'past_due'.
	app.post("/platform/restaurants/:id/restore", requirePlatformAuth, async (req: Request, res: Response) => {
		const resId = req.params.id!;
		try {
			// Same transaction argument as archive: putting account_status back while
			// the subscription rollback lands on a different pooled connection can
			// leave a tenant 'active' but still 'cancelled' — which
			// platform.restaurant_status maps to 'suspended', so "restored" staff still
			// cannot sign in. Both writes and the audit row move together.
			const outcome = await withPlatformTransaction(async (tx) => {
				const locked = await tx<{ account_status: string | null }>(
					`select account_status from "Restaurant" where id = $1 for update`,
					[resId],
				);
				if (!locked[0]) { return { kind: "missing" as const }; }
				if (locked[0].account_status !== "archived") { return { kind: "not_archived" as const }; }

				// audit() swallows its own insert failures elsewhere, and a row can
				// predate this route, so the recovery row may legitimately be missing —
				// degrade to "left cancelled, re-assign the plan" rather than throwing,
				// which would strand the tenant archived with no way back.
				const lastArchive = await tx<{ detail: Record<string, unknown> | null }>(
					`select detail from platform.audit
					  where target_res_id = $1 and action = 'restaurant.archive'
					  order by created_at desc limit 1`,
					[resId],
				);
				const prevSubStatus = lastArchive[0]?.detail?.["prev_sub_status"];

				await tx(`update "Restaurant" set account_status = 'active' where id = $1`, [resId]);

				let restoredSubStatus: string | null = null;
				if (typeof prevSubStatus === "string" && SUBSCRIPTION_STATUSES.has(prevSubStatus)) {
					// `and status = 'cancelled'` so a subscription an operator re-assigned
					// while the tenant was archived is never clobbered by this rollback.
					const restored = await tx<{ status: string }>(
						`update platform.subscriptions set status = $2, updated_at = now()
						  where res_id = $1 and status = 'cancelled' returning status`,
						[resId, prevSubStatus],
					);
					restoredSubStatus = restored[0]?.status ?? null;
				}

				// The tenant is un-archived either way. Whether it can actually TRADE
				// depends on where its subscription ended up, because
				// platform.restaurant_status maps 'cancelled' / 'suspended' / 'expired'
				// to a non-active status and the login gate refuses all of them. Read it
				// back and say so plainly, rather than answering a bare
				// `subscription_status: null` that reads as "nothing to do" — the
				// degraded case is a tenant marked Active in the console whose staff
				// still cannot sign in, with no signal anywhere that a plan must be
				// re-assigned.
				const live = await tx<{ status: string | null }>(
					`select status from platform.subscriptions where res_id = $1 limit 1`,
					[resId],
				);
				const liveStatus = live[0]?.status ?? null;
				const blocked = liveStatus !== null && LOGIN_BLOCKING_SUBSCRIPTION_STATUSES.has(liveStatus);

				// Sessions are NOT restored — the tenant's staff sign in again.
				await tx(
					`insert into platform.audit (admin_id, action, target_res_id, detail) values ($1, $2, $3, $4)`,
					[
						req.platformAdmin!.adminId,
						"restaurant.restore",
						resId,
						JSON.stringify({ restored_sub_status: restoredSubStatus }),
					],
				);
				return {
					kind: "restored" as const,
					restoredSubStatus,
					subscriptionStatus: liveStatus,
					requiresPlanAssignment: blocked,
				};
			});

			if (outcome.kind === "missing") {
				res.status(404).json({ error: "Restaurant not found" });
				return;
			}
			if (outcome.kind === "not_archived") {
				res.status(409).json({ error: "This restaurant is not archived. Use Activate to lift a suspension." });
				return;
			}
			res.json({
				ok: true,
				account_status: "active",
				// Unchanged field, unchanged meaning: the status this call ROLLED BACK,
				// or null when it rolled nothing back.
				subscription_status: outcome.restoredSubStatus,
				// New, and the point of the two below: what the subscription actually is
				// now, and whether that leaves the tenant locked out.
				current_subscription_status: outcome.subscriptionStatus,
				requires_plan_assignment: outcome.requiresPlanAssignment,
				...(outcome.requiresPlanAssignment
					? {
						warning:
							`This restaurant is no longer archived, but its subscription is '${String(outcome.subscriptionStatus)}', ` +
							"so its staff still cannot sign in. Assign a plan to finish restoring it.",
					}
					: {}),
			});
		} catch (err) {
			logger.error({ err }, "platform_restore_failed");
			res.status(500).json({ error: "Unable to restore restaurant" });
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
		if (!SUBSCRIPTION_STATUSES.has(status)) {
			res.status(400).json({ error: `invalid status; one of ${[...SUBSCRIPTION_STATUSES].join(", ")}` });
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
				total: number; active: number; suspended: number; archived: number; new_this_week: number;
			}>(
				// `archived` is counted explicitly: without it those tenants land in
				// `total` and in neither bucket, so the fleet numbers stop adding up the
				// first time an operator archives someone.
				`select
				   count(*)::int as total,
				   count(*) filter (where coalesce(account_status, 'active') = 'active')::int as active,
				   count(*) filter (where account_status = 'suspended')::int as suspended,
				   count(*) filter (where account_status = 'archived')::int as archived,
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
