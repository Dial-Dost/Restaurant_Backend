// AWS Lambda entrypoint.
//
// This file is ADDITIVE: `node build/index.js` still works exactly as before
// (Railway, Docker, a VM). Nothing here runs unless the Lambda runtime imports
// this module.
//
// ---------------------------------------------------------------------------
// WHY THE IMPORTS ARE DYNAMIC
// ---------------------------------------------------------------------------
// The app reads configuration from process.env at MODULE LOAD, not lazily:
// qr_signing.ts throws without QR_SIGNING_SECRET, database_supabase.ts throws
// without a connection string, auth/store.ts getStore() picks Redis vs memory
// from REDIS_URL. Static ESM imports are hoisted above every statement, so a
// plain `import { app } from "./index.js"` would evaluate all of that BEFORE the
// Secrets Manager fetch could populate the environment. Top-level await plus
// `await import(...)` is the only ordering that works, and it keeps full type
// inference because the specifiers are still static strings.
//
// ---------------------------------------------------------------------------
// WHAT HAPPENS AT COLD START, AND WHAT DOES NOT REPEAT PER REQUEST
// ---------------------------------------------------------------------------
// Everything below the imports runs ONCE per container. Warm invocations enter
// at `handler` and touch nothing else.
//
// Importing ./index.js does two things:
//
//   1. Builds the complete Express app. All middleware, registerPlatformRoutes(app),
//      every register*Routes(app) call for the modules under routes/, and both
//      error handlers run in index.ts MODULE SCOPE. By the time the import
//      resolves, `app` is finished and can serve.
//
//   2. Fires the trailing `bootstrap().catch(...)`, which the module graph
//      does NOT await. It runs as a detached promise alongside our first
//      invocation. On Lambda it does the following, and it cannot be changed
//      from here (index.ts is owned elsewhere — see deploy/README.md "Changes
//      index.ts needs"):
//
//        * EnsureRestaurantSeed — skipped when NODE_ENV=production and SEED_DEMO
//          is unset. deploy/template.yaml sets both. Keep it that way.
//        * ensureFeaturePermissionActions — a DB write on EVERY cold start.
//        * WarmReportingSchema — only when REPORT_SCHEDULER=true.
//        * verifyTenantRlsAtBoot — one DB read per cold start. With
//          ENFORCE_RLS_AT_BOOT=true it throws, bootstrap's .catch calls
//          process.exit(1), and the container dies. That is the correct
//          fail-closed behaviour; it shows up as a Runtime.ExitError, not as a
//          tidy message.
//        * createServer(app) + httpServer.listen(PORT) — binds a port inside the
//          Lambda sandbox that nothing routes to. Harmless; each container has
//          its own network namespace.
//        * initRealtime(httpServer) — see the dedicated section below; this file
//          no longer relies on bootstrap() to have reached it.
//        * the three setInterval timers. Effectively inert here (a frozen
//          container runs no timers) and every sweep they drive is idempotent,
//          so the EventBridge schedules below are the real driver.
//
// bootstrap() is deliberately NOT awaited before serving. Nothing the HTTP path
// needs comes from it, and blocking every cold start on two DB round-trips would
// push latency into the p99 of every route.
//
// ---------------------------------------------------------------------------
// WHY initRealtime IS AWAITED, AND WHY THAT IS NOT THE SAME AS AWAITING bootstrap
// ---------------------------------------------------------------------------
// emitRestaurant/emitOutlet start with `if (!io) {return;}` (realtime.ts:117,
// :128), and `io` is assigned only inside initRealtime. bootstrap() reaches
// initRealtime only AFTER a DB write and a DB read — and Lambda freezes the
// container the moment the in-flight handler promise settles, so a detached
// bootstrap() advances only while an invocation is running. A cold container
// that serves one fast request and then idles can still have `io === null`. The
// emit is dropped silently: no log line, no metric, no error. What breaks is the
// KDS ticket feed, order:updated, table:updated and the waitlist "call customer"
// pop-up — a stale POS screen until someone refreshes, on cold containers only.
//
// So this file awaits `ensureRealtime()` (index.ts) BEFORE it builds the
// serverless adapter. That helper is the createServer + initRealtime pair
// bootstrap() used to inline, memoised: whichever of the two callers arrives
// first runs it, and the other awaits the same promise, so there is still
// exactly one Socket.IO server and one pair of Redis clients per container.
//
// It costs what it costs, stated plainly: two Redis connections and their TLS
// handshakes are now ON the cold-start path instead of racing it. That is the
// price of the emits actually leaving the container. Printing does not depend on
// it either way — POST /print/bill, POST /publish/bill and POST
// /bills/service-charge-waiver/print are routed to the always-on Fargate task by
// the CloudFront behaviours in deploy/template.yaml.
// ---------------------------------------------------------------------------

import type { RequestListener } from "node:http";
import type { Context, Handler } from "aws-lambda";
import { loadSecretsIntoEnv } from "./deploy/secrets.js";

// ---- Ordered startup ------------------------------------------------------
await loadSecretsIntoEnv();

const { app, ensureRealtime } = await import("./index.js");
const { logger } = await import("./observability.js");
const { ListRestaurantIds, RunExceptionChecks, withTenant } = await import("./database_supabase.js");
const { runReportScheduleSweep } = await import("./report_schedules.js");
const { runBillingCycle } = await import("./platform/routes.js");
const { withPlatformAdvisoryLock } = await import("./platform/db.js");
const { sendDueBookingReminders } = await import("./routes/_shared.js");

// Socket.IO up before the adapter below exists, and therefore before this
// container can serve a single request. See "WHY initRealtime IS AWAITED" above.
// ensureRealtime never rejects — it logs and resolves — so a Redis outage
// degrades realtime instead of taking the whole HTTP surface down with it.
await ensureRealtime();

// ---------------------------------------------------------------------------
// HTTP: one adapter instance, reused for the life of the container
// ---------------------------------------------------------------------------
// CJS interop, resolved defensively. The package's src/index.js does
// `module.exports = configure` and ALSO attaches `.configure`. TypeScript models
// the resulting namespace differently under the two tsconfigs this repo uses
// (`bundler` for `tsc --noEmit`, `NodeNext` for the build), and Node's own
// cjs-module-lexer decides independently whether to surface the named export. So
// pick the callable at runtime and type it against the single call signature
// this file needs, instead of betting on one interop shape.
type ServerlessExpressFactory = (options: {
	app: RequestListener;
	binarySettings?: { contentTypes?: string[] };
}) => Handler<unknown, unknown>;

const seModule = (await import("@codegenie/serverless-express")) as unknown as Record<string, unknown>;
const seFactory = typeof seModule.default === "function" ? seModule.default : seModule.configure;
if (typeof seFactory !== "function") {
	throw new Error("@codegenie/serverless-express did not export a callable factory");
}
const serverlessExpress = seFactory as ServerlessExpressFactory;

// binarySettings: the adapter base64-encodes a response only when it decides the
// body is binary. Two routes return raw bytes and would be corrupted otherwise:
//   * GET /restaurant/logo/escpos          -> application/octet-stream
//                                            (routes/settings.ts)
//   * GET /reports/deliveries/:id/download -> artifact.mime
//                                            (routes/accounting.ts)
// Text types (JSON, CSV, XML) stay UTF-8 strings.
const serverlessHandler = serverlessExpress({
	app: app as unknown as RequestListener,
	binarySettings: {
		contentTypes: [
			"application/octet-stream",
			"application/pdf",
			"application/zip",
			"image/*",
			"font/*",
		],
	},
});

// ---------------------------------------------------------------------------
// Scheduled sweeps — the three setInterval timers, moved to EventBridge
// ---------------------------------------------------------------------------

type SweepName = "exceptions" | "reports" | "billing";

/**
 * Advisory-lock key for the billing cycle. MUST stay identical to
 * BILLING_LOCK_KEY in platform/routes.ts:220 (0x5245_5342, "RESB"). That
 * constant is module-private there, so it is mirrored rather than imported; if
 * it changes there and not here, the two schedulers stop excluding each other.
 */
const BILLING_LOCK_KEY = 0x5245_5342;

/**
 * Stop a tenant loop this many ms before Lambda would kill the container, so a
 * long sweep degrades into "resumes on the next tick" instead of being cut off
 * mid-tenant with nothing in the log.
 */
const SWEEP_DEADLINE_MARGIN_MS = 20_000;

// Per-container reentrancy guards, mirroring the exceptionSweepRunning /
// reportSweepRunning flags in index.ts bootstrap(). They only matter if one warm
// container is asked to run the same sweep twice at once.
// Correctness ACROSS containers comes from the dedupe rules noted on each sweep,
// never from these flags.
let exceptionSweepRunning = false;
let reportSweepRunning = false;
let billingSweepRunning = false;

/** What a sweep pass actually did. `tenants` is tenants VISITED, not tenants that succeeded. */
interface ExceptionSweepResult {
	tenants: number;
	checksFailed: number;
	remindersFailed: number;
	stoppedEarly: boolean;
}

/**
 * 30-minute sweep (the exceptionSweep closure in index.ts bootstrap()). Per
 * tenant: the 24h exception checks (discount spikes / void streaks /
 * negative-feedback streaks -> notification bell), then the booking reminders.
 *
 * Safe alongside the always-on task's in-process timer: the per-alert 24h dedupe
 * inside RunExceptionChecks makes a duplicate run a no-op, and the reminder pass
 * stamps reminder_sent BEFORE sending (routes/_shared.ts,
 * sendDueBookingReminders).
 *
 * PER-TENANT FAILURES ARE COUNTED, NOT JUST LOGGED. One tenant's bad data must
 * not abort the fleet, which is why each call is caught — but a caught error
 * that only reaches a log line is indistinguishable from success to anyone
 * reading the invocation's return value, and there is a specific failure that
 * hits EVERY tenant at once: RunExceptionChecks calls ensureBrandingColumns() on
 * entry (database_supabase.ts:22830), which issues
 * `alter table "Restaurant" add column if not exists ...` and does NOT swallow
 * the error. Under the least-privilege app_runtime role that migration 002
 * creates, Postgres raises 42501 "must be owner of table" even when the column
 * already exists, and inside withTenant's explicit transaction that aborts the
 * transaction. So the counters below are what stops "the sweep ran and did
 * nothing" from reading as "the sweep ran".
 */
async function runExceptionSweep(context: Context): Promise<ExceptionSweepResult> {
	if (exceptionSweepRunning) {
		logger.warn("exception_sweep_already_running");
		return { tenants: 0, checksFailed: 0, remindersFailed: 0, stoppedEarly: false };
	}
	exceptionSweepRunning = true;
	let tenants = 0;
	let checksFailed = 0;
	let remindersFailed = 0;
	let stoppedEarly = false;
	try {
		const tenantIds = await ListRestaurantIds();
		for (const resId of tenantIds) {
			if (context.getRemainingTimeInMillis() < SWEEP_DEADLINE_MARGIN_MS) {
				stoppedEarly = true;
				logger.warn({ done: tenants, total: tenantIds.length }, "exception_sweep_deadline_reached");
				break;
			}
			try {
				// Each tenant gets its own RLS-scoped connection; a scheduled
				// invocation has no ambient request context to inherit.
				await withTenant(
					{ res_id: resId, outlet_id: "", employeeId: "", role: "" },
					() => RunExceptionChecks(resId),
				);
			} catch (err) {
				checksFailed += 1;
				logger.warn({ err, resId }, "exception_sweep_tenant_failed");
			}
			try {
				// Booking reminders ride the same tick, exactly as the in-process
				// sweep does. sendDueBookingReminders opens its OWN tenant context,
				// so it must NOT be nested inside the withTenant above.
				await sendDueBookingReminders(resId);
			} catch (err) {
				remindersFailed += 1;
				logger.warn({ err, resId }, "reminder_sweep_tenant_failed");
			}
			tenants += 1;
		}
	} finally {
		exceptionSweepRunning = false;
	}
	if (checksFailed > 0 || remindersFailed > 0) {
		// error, not warn: this is the line a CloudWatch metric filter should key
		// on, because the -sweep-errors alarm watches the Lambda Errors metric and
		// a partially-failed sweep does not increment it.
		logger.error(
			{ tenants, checksFailed, remindersFailed },
			"exception_sweep_completed_with_failures",
		);
	}
	return { tenants, checksFailed, remindersFailed, stoppedEarly };
}

/**
 * Scheduled report delivery (the reportSweep closure in index.ts bootstrap()).
 * Ships DARK: the EventBridge
 * schedule is created DISABLED and only enabled by the ReportScheduler stack
 * parameter, matching REPORT_SCHEDULER's posture in the code.
 *
 * At-most-once comes from the (schedule_id, occurrence_key) unique index and the
 * attempts compare-and-swap inside the sweep, not from any lock — so an
 * overlapping run on the always-on task is safe.
 */
async function runReportSweep(): Promise<void> {
	if (reportSweepRunning) {
		logger.warn("report_sweep_already_running");
		return;
	}
	reportSweepRunning = true;
	try {
		await runReportScheduleSweep();
	} finally {
		reportSweepRunning = false;
	}
}

/**
 * Daily subscription billing (startBillingScheduler, platform/routes.ts:224).
 * Held under the same
 * Postgres session advisory lock the in-process scheduler uses, so this
 * invocation and the always-on task's daily timer elect one leader instead of
 * both generating invoices. Invoice creation is additionally deduped on
 * (res_id, period_end) by migration 007.
 *
 * NOTE: pg_try_advisory_lock is a SESSION-level lock. It is correct on the
 * platform pool as configured (direct, or session-mode pooling) and would break
 * silently under transaction-mode pooling — see deploy/README.md "Problem 3".
 */
async function runBillingSweep(): Promise<{ ran: boolean }> {
	if (billingSweepRunning) {
		logger.warn("billing_sweep_already_running");
		return { ran: false };
	}
	billingSweepRunning = true;
	try {
		const ran = await withPlatformAdvisoryLock(BILLING_LOCK_KEY, async () => {
			const r = await runBillingCycle();
			logger.info(
				{ generated: r.generated, past_due: r.past_due, suspended: r.suspended },
				"billing_cycle_complete",
			);
		});
		if (!ran) {
			logger.info("billing_cycle_skipped_lock_held");
		}
		return { ran };
	} finally {
		billingSweepRunning = false;
	}
}

// ---------------------------------------------------------------------------
// Event dispatch
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

/**
 * Recognise a scheduled invocation and name the sweep.
 *
 * Accepts both wirings so the handler works either way:
 *   1. EventBridge Scheduler with a literal Input -> {"sweep":"exceptions"}
 *      (this is what deploy/template.yaml uses)
 *   2. An EventBridge *rule* event -> { source, detail-type, detail:{ sweep } }
 * and therefore also a hand-rolled `aws lambda invoke --payload` of either.
 *
 * Returns null for anything else, which is treated as an HTTP request. An API
 * Gateway v2 event carries no `sweep` key at either level, so there is no
 * ambiguity between the two.
 */
function sweepFromEvent(event: unknown): SweepName | null {
	if (!isRecord(event)) { return null; }
	const direct = event.sweep;
	const nested = isRecord(event.detail) ? event.detail.sweep : undefined;
	const raw = typeof direct === "string" ? direct : typeof nested === "string" ? nested : null;
	if (raw === "exceptions" || raw === "reports" || raw === "billing") { return raw; }
	if (raw !== null) { logger.warn({ sweep: raw }, "unknown_scheduled_sweep"); }
	return null;
}

export const handler: Handler<unknown, unknown> = async (event, context) => {
	const sweep = sweepFromEvent(event);

	if (sweep !== null) {
		const startedAt = Date.now();
		try {
			switch (sweep) {
				case "exceptions": {
					const r = await runExceptionSweep(context);
					// `ok` is the honest summary, not a constant. README §6 step 6
					// tells the owner to read it, and it must not say true when
					// every tenant's checks threw. Nothing else changes shape:
					// tenants/stoppedEarly still mean what they meant.
					const ok = r.checksFailed === 0 && r.remindersFailed === 0;
					// Every tenant failing is not a data problem, it is a broken
					// sweep — most likely the app_runtime DDL case described on
					// runExceptionSweep. Throw so it reaches the Errors metric, the
					// EventBridge retry and ultimately the dead-letter queue the
					// template alarms on, instead of being a field in a 200 that
					// nobody reads. The sweep is idempotent, so a retry is safe.
					if (r.tenants > 0 && r.checksFailed === r.tenants) {
						logger.error({ sweep, ...r, ms: Date.now() - startedAt }, "sweep_failed_for_every_tenant");
						throw new Error(
							"exception sweep failed for all " + String(r.tenants) + " tenants " +
							"(check the exception_sweep_tenant_failed log lines; a 42501 " +
							"\"must be owner of table\" means the runtime role cannot run " +
							"ensureBrandingColumns' lazy DDL)",
						);
					}
					logger.info({ sweep, ...r, ok, ms: Date.now() - startedAt }, "sweep_complete");
					return { ok, sweep, ...r };
				}
				case "reports": {
					await runReportSweep();
					logger.info({ sweep, ms: Date.now() - startedAt }, "sweep_complete");
					return { ok: true, sweep };
				}
				case "billing": {
					const r = await runBillingSweep();
					logger.info({ sweep, ...r, ms: Date.now() - startedAt }, "sweep_complete");
					return { ok: true, sweep, ...r };
				}
			}
		} catch (err) {
			// Rethrow so EventBridge sees the failure: it drives the retry, the
			// Errors metric and ultimately the dead-letter queue the template
			// alarms on. Every sweep is idempotent, so a retry is always safe.
			logger.error({ err, sweep, ms: Date.now() - startedAt }, "sweep_failed");
			throw err;
		}
	}

	const result = await serverlessHandler(event, context, () => undefined);

	// Realtime emits made by the route just served (order:updated, table:updated,
	// ...) are published to Redis by @socket.io/redis-adapter, which QUEUES the
	// PUBLISH on the node-redis client. Lambda freezes the container the instant
	// this promise settles, so yield once to let node-redis flush its queue into
	// the socket first.
	//
	// Honest about what this buys: it gets the command out of the client's queue.
	// It does NOT confirm Redis received it. The routes where a lost emit costs
	// money — POST /print/bill (routes/bills.ts, which also emits the per-station
	// KOTs), POST /publish/bill (routes/bills.ts), and the one that is not under
	// /print/, POST /bills/service-charge-waiver/print (routes/mis_capture.ts,
	// which records a waiver and then prints through printOpenTableBill) — are
	// therefore routed to the always-on task by the CloudFront behaviours in
	// deploy/template.yaml and never reach this code path.
	// jest-tests/bill_print_doors_always_on.test.ts holds that list to the routes.
	await new Promise<void>((resolve) => { setImmediate(resolve); });

	return result;
};
