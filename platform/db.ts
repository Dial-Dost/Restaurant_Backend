import { Pool, type QueryResultRow } from "pg";

// Dedicated connection pool for the SaaS control plane, connecting as the
// platform_runtime role (access to the `platform` schema + "Restaurant"). Kept
// entirely separate from the tenant pool so a tenant request can never reach
// the control plane, and a platform request never runs under tenant RLS context.
const connectionString = process.env.PLATFORM_DATABASE_URL ?? process.env.PLATFORM_DIRECT_URL;

if (!connectionString) {
	console.warn(
		"PLATFORM_DATABASE_URL is not set; platform (SaaS admin) endpoints will be unavailable.",
	);
}

const pool = connectionString
	? new Pool({
		connectionString,
		ssl: { rejectUnauthorized: false },
		max: Math.max(1, Number(process.env.PLATFORM_PG_POOL_MAX) || 5),
		idleTimeoutMillis: Math.max(0, Number(process.env.PG_IDLE_TIMEOUT_MS) || 30_000),
		connectionTimeoutMillis: Math.max(0, Number(process.env.PG_CONNECTION_TIMEOUT_MS) || 10_000),
	})
	: null;

// Don't let an idle-client error (DB restart/blip) crash the process.
pool?.on("error", (err) => { console.error("[pg] platform pool idle error:", (err as any)?.message ?? err); });

export function platformDbConfigured(): boolean {
	return pool !== null;
}

/** A caught value's message, without asserting it is an Error (a pg driver can
 *  reject with anything). Used by the log lines below. */
function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function platformQuery<TRow extends QueryResultRow = QueryResultRow>(
	sql: string,
	params: unknown[] = [],
): Promise<TRow[]> {
	if (!pool) {
		throw new Error("PLATFORM_DATABASE_URL is not configured");
	}
	const result = await pool.query<TRow>(sql, params);
	return result.rows;
}

/**
 * The query function handed to withPlatformTransaction's callback. Same shape as
 * platformQuery, except every statement runs on the SAME checked-out client and
 * inside the SAME transaction.
 */
export type PlatformTx = <TRow extends QueryResultRow = QueryResultRow>(
	sql: string,
	params?: unknown[],
) => Promise<TRow[]>;

/**
 * Run `work` inside ONE platform-pool transaction.
 *
 * WHY THIS EXISTS. platformQuery is pool.query, which checks out a connection per
 * statement — so two consecutive platformQuery calls run on two different pooled
 * connections and cannot be part of one atomic unit. Archiving a tenant writes
 * "Restaurant".account_status AND platform.subscriptions.status AND the
 * platform.audit row that restore later reads to undo it. Any of those landing
 * without the others is a real production outcome: a departed tenant flagged gone
 * while its subscription keeps generating monthly invoices, with no recovery row
 * to restore from. All three belong in one transaction.
 *
 * Deliberately mirrors database_supabase.ts's withTransaction (:1393) rather than
 * inventing a second transaction idiom: check out, BEGIN, work, COMMIT, ROLLBACK
 * on throw, release in finally. It does NOT model nesting — the control plane has
 * no ambient request-bound client the way the tenant side does, so there is
 * nothing to nest into and a savepoint stack would be dead code.
 *
 * NOTE ON SCOPE: only PLATFORM-pool statements can join this transaction. Work on
 * the tenant pool (CountOpenBillsForRestaurant) and in Redis
 * (destroyAllForRestaurant) cannot, and callers must sequence those around it —
 * see the archive route for how each is made safe on its own.
 */
export async function withPlatformTransaction<T>(work: (tx: PlatformTx) => Promise<T>): Promise<T> {
	if (!pool) {
		throw new Error("PLATFORM_DATABASE_URL is not configured");
	}
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const tx = (async <TRow extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) => {
			const result = await client.query<TRow>(sql, params);
			return result.rows;
		}) as PlatformTx;
		const value = await work(tx);
		await client.query("COMMIT");
		return value;
	} catch (error) {
		// Guarded: an un-guarded ROLLBACK that itself throws (connection already
		// dropped) would REPLACE the real failure with a rollback error, and the
		// caller would log the wrong cause. The server rolls back a broken
		// connection's transaction on its own anyway.
		try { await client.query("ROLLBACK"); } catch (rollbackErr) {
			console.error("[pg] platform transaction rollback failed:", errText(rollbackErr));
		}
		throw error;
	} finally {
		client.release();
	}
}

// Run `work` while holding a Postgres session-level advisory lock on one pooled
// connection, so only one replica executes it at a time (leader election for the
// in-process billing scheduler). Returns false without running when another
// holder already owns the lock.
export async function withPlatformAdvisoryLock(lockKey: number, work: () => Promise<void>): Promise<boolean> {
	if (!pool) {return false;}
	const client = await pool.connect();
	try {
		const r = await client.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [lockKey]);
		if (!r.rows[0]?.locked) {return false;}
		try {
			await work();
		} finally {
			await client.query("select pg_advisory_unlock($1)", [lockKey]);
		}
		return true;
	} finally {
		client.release();
	}
}

// --- Migration 028 gate -----------------------------------------------------
//
// THE FAILURE THIS EXISTS TO MAKE IMPOSSIBLE. Archiving writes
// "Restaurant".account_status = 'archived'. NOTHING enforces that value directly:
// every enforcement point (the login gate at routes/auth.ts:141, the guest write
// gate in routes/_shared.ts, the scheduled-report sweep at report_schedules.ts:215)
// asks platform.restaurant_status, and migration 011's version of that function
// matches the literal 'suspended' and FALLS THROUGH TO 'active' for anything else.
// Migration 028 adds the 'archived' arm.
//
// Until 028 is applied the archive route is therefore INERT AND SILENT: the
// operator console renders the tenant as Archived, and its staff keep signing in,
// its QR keeps taking orders and its scheduled reports keep being delivered. The
// operator has no way to notice. Worse, the container deploy path does not apply
// migrations at all — Dockerfile.node's CMD is `node build/index.js`, not
// `npm run start:prod` (the only script that chains `npm run migrate`), so 028 is
// a MANUAL step that must happen BEFORE this code serves traffic.
//
// So: the archive route refuses outright when the arm is missing (a loud 503 the
// operator reads, instead of a lie they act on), and bootstrap logs a banner.
//
// HOW IT CHECKS. It reads the function's own body out of pg_proc. prosrc is the
// SQL text of a LANGUAGE sql function and pg_proc is world-readable, so this needs
// no grant beyond what platform_runtime already has — unlike pg_get_functiondef,
// which is easier to get wrong under a least-privilege role.
const ARCHIVED_ARM = /account_status\s*=\s*'archived'/i;

// Memoised only on SUCCESS. A negative answer is re-checked on the next call so
// applying the migration takes effect immediately — the operator should not have
// to restart the server to clear an error the migration just fixed.
let archivedArmConfirmed = false;

export interface ArchivedStatusSupport {
	supported: boolean;
	/** Why not, for the operator-facing message. Null when supported. */
	reason: "function_missing" | "arm_missing" | "unavailable" | null;
}

export async function archivedStatusSupported(): Promise<ArchivedStatusSupport> {
	if (archivedArmConfirmed) { return { supported: true, reason: null }; }
	if (!pool) { return { supported: false, reason: "unavailable" }; }
	let rows: { src: string | null }[];
	try {
		rows = (await pool.query<{ src: string | null }>(
			`select p.prosrc as src
			   from pg_proc p
			   join pg_namespace n on n.oid = p.pronamespace
			  where n.nspname = 'platform' and p.proname = 'restaurant_status'
			  order by p.oid desc
			  limit 1`,
		)).rows;
	} catch (err) {
		// Fail CLOSED. Everywhere else in this codebase a control-plane read failure
		// degrades to "assume active" so tenants keep working; here the caller is
		// about to make an irreversible-looking operator promise ("this restaurant is
		// gone"), and promising it while unable to verify the mechanism is the
		// failure mode this whole gate exists to prevent.
		console.error("[platform] could not verify migration 028:", errText(err));
		return { supported: false, reason: "unavailable" };
	}
	if (rows.length === 0) { return { supported: false, reason: "function_missing" }; }
	if (!ARCHIVED_ARM.test(rows[0]?.src ?? "")) { return { supported: false, reason: "arm_missing" }; }
	archivedArmConfirmed = true;
	return { supported: true, reason: null };
}

/** The one operator/operator-log-facing explanation of a missing 028. */
export function archivedStatusUnsupportedMessage(reason: ArchivedStatusSupport["reason"]): string {
	const why =
		reason === "function_missing"
			? "platform.restaurant_status does not exist"
			: reason === "arm_missing"
				? "platform.restaurant_status has no 'archived' arm (migration 028 has not been applied)"
				: "the control plane database could not be reached to verify it";
	return (
		`Archiving is disabled: ${why}. ` +
		"Until it is applied, an archived restaurant still reads as ACTIVE — its staff can sign in, " +
		"its QR keeps taking orders and its scheduled reports keep being delivered, while the console says Archived. " +
		"Run `npm run migrate` against the platform database, then retry."
	);
}

// Test seam: platform_lifecycle's "028 not applied" case needs the memo cleared
// between cases. Not called by any runtime path.
export function resetArchivedStatusSupportCache(): void { archivedArmConfirmed = false; }

// Graceful-shutdown hook for the platform pool.
export async function closePlatformPool(): Promise<void> {
	if (pool) {await pool.end();}
}
