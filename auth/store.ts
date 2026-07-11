import { createClient } from "redis";

// Minimal key/value + set store used by the tenant and platform session stores.
// Backed by Redis when REDIS_URL is set; otherwise an in-memory store so the
// backend runs with zero extra infrastructure for local dev / single-node
// deployments. Redis is still required to persist sessions across restarts and
// to share them across multiple backend instances (horizontal scale).

export interface SessionStore {
	set(key: string, value: string, ttlSeconds: number): Promise<void>;
	get(key: string): Promise<string | null>;
	expire(key: string, ttlSeconds: number): Promise<void>;
	del(key: string | string[]): Promise<void>;
	sAdd(key: string, member: string): Promise<void>;
	sRem(key: string, member: string): Promise<void>;
	sMembers(key: string): Promise<string[]>;
	// Atomic counter for rate limiting: increments key, sets the TTL on first
	// increment, returns the new count. Shared across replicas when Redis-backed.
	incr(key: string, ttlSeconds: number): Promise<number>;
}

type RedisClient = ReturnType<typeof createClient>;

class RedisStore implements SessionStore {
	constructor(private readonly client: RedisClient) {}
	async set(k: string, v: string, ttl: number): Promise<void> {
		await this.client.set(k, v, { EX: ttl });
	}
	async get(k: string): Promise<string | null> {
		return (await this.client.get(k)) ?? null;
	}
	async expire(k: string, ttl: number): Promise<void> {
		await this.client.expire(k, ttl);
	}
	async del(k: string | string[]): Promise<void> {
		await this.client.del(k as never);
	}
	async sAdd(k: string, m: string): Promise<void> {
		await this.client.sAdd(k, m);
	}
	async sRem(k: string, m: string): Promise<void> {
		await this.client.sRem(k, m);
	}
	async sMembers(k: string): Promise<string[]> {
		return this.client.sMembers(k);
	}
	async incr(k: string, ttl: number): Promise<number> {
		const n = await this.client.incr(k);
		if (n === 1) await this.client.expire(k, ttl);
		return n;
	}
}

class MemoryStore implements SessionStore {
	private kv = new Map<string, { value: string; expiresAt: number }>();
	private sets = new Map<string, Set<string>>();

	async set(k: string, v: string, ttl: number): Promise<void> {
		this.kv.set(k, { value: v, expiresAt: Date.now() + ttl * 1000 });
	}
	async get(k: string): Promise<string | null> {
		const e = this.kv.get(k);
		if (!e) return null;
		if (e.expiresAt <= Date.now()) {
			this.kv.delete(k);
			return null;
		}
		return e.value;
	}
	async expire(k: string, ttl: number): Promise<void> {
		const e = this.kv.get(k);
		if (e) e.expiresAt = Date.now() + ttl * 1000;
	}
	async del(k: string | string[]): Promise<void> {
		for (const key of Array.isArray(k) ? k : [k]) {
			this.kv.delete(key);
			this.sets.delete(key);
		}
	}
	async sAdd(k: string, m: string): Promise<void> {
		let s = this.sets.get(k);
		if (!s) {
			s = new Set<string>();
			this.sets.set(k, s);
		}
		s.add(m);
	}
	async sRem(k: string, m: string): Promise<void> {
		this.sets.get(k)?.delete(m);
	}
	async sMembers(k: string): Promise<string[]> {
		return Array.from(this.sets.get(k) ?? []);
	}
	private counters = new Map<string, { count: number; expiresAt: number }>();
	async incr(k: string, ttl: number): Promise<number> {
		const now = Date.now();
		let e = this.counters.get(k);
		if (!e || e.expiresAt <= now) {
			e = { count: 0, expiresAt: now + ttl * 1000 };
			this.counters.set(k, e);
		}
		e.count++;
		return e.count;
	}
}

let storePromise: Promise<SessionStore> | null = null;
let warned = false;

export async function getStore(): Promise<SessionStore> {
	if (!storePromise) {
		const url = process.env.REDIS_URL;
		if (url) {
			storePromise = (async () => {
				const c = createClient({ url });
				c.on("error", (err) => console.error("redis_client_error", err));
				await c.connect();
				return new RedisStore(c);
			})().catch((err) => {
				storePromise = null;
				throw err;
			});
		} else {
			// In-memory sessions are process-local: they don't survive a restart and
			// cause split-brain auth (random 401s) across replicas. Refuse to start in
			// that mode when the operator has declared a multi-replica deployment.
			if (process.env.REQUIRE_REDIS === "true") {
				throw new Error(
					"REQUIRE_REDIS=true but REDIS_URL is not set. A shared Redis is mandatory " +
						"for multi-replica session storage. Set REDIS_URL or unset REQUIRE_REDIS.",
				);
			}
			if (!warned) {
				warned = true;
				console.warn(
					"REDIS_URL not set — using in-memory session store. Sessions will not " +
						"survive a restart or scale across instances. Set REDIS_URL (and " +
						"REQUIRE_REDIS=true) for a multi-replica production deployment.",
				);
			}
			storePromise = Promise.resolve(new MemoryStore());
		}
	}
	return storePromise;
}
