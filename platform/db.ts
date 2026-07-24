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

// Graceful-shutdown hook for the platform pool.
export async function closePlatformPool(): Promise<void> {
	if (pool) {await pool.end();}
}
