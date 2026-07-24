import { randomBytes } from "node:crypto";
import { getStore } from "./store.js";

// Opaque session store (Redis when configured, else in-memory — see store.ts).
// The session token is a random opaque string; the verified identity lives
// server-side so we can revoke instantly and never trust client-supplied identity.

export interface SessionPayload {
	employeeId: string;
	res_id: string;
	outlet_id: string;
	role: string;
	role_all: string[];
	// Resolved permission UUIDs (or ["*"] for admin). Computed at login and
	// cached on the session so per-request authorization needs no DB hit.
	actions: string[];
	// Subscription plan feature flags + limits, resolved at login so the tenant
	// app can gate features without a per-request control-plane call.
	features: Record<string, unknown>;
	limits: Record<string, unknown>;
	// Display/profile fields, so /auth/me can re-hydrate the client UI from the
	// session alone (no DB round-trip). None of this is secret to its owner.
	action_names: string[];
	emp_Fname: string;
	emp_Lname: string | null;
	employeeUsername: string;
	restaurantUsername: string;
	restaurantName: string;
}

const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS ?? 60 * 60 * 12); // sliding 12h
const SESSION_PREFIX = "session:";
const EMP_SESSIONS_PREFIX = "emp_sessions:";
const RES_SESSIONS_PREFIX = "res_sessions:";

function newToken(): string {
	return randomBytes(32).toString("base64url");
}

export async function createSession(payload: SessionPayload): Promise<string> {
	const store = await getStore();
	const token = newToken();
	await store.set(SESSION_PREFIX + token, JSON.stringify(payload), SESSION_TTL_SECONDS);
	// Index the token under the employee so we can revoke every session for a
	// user (role change, password reset, "log out everywhere").
	const empKey = EMP_SESSIONS_PREFIX + payload.employeeId;
	await store.sAdd(empKey, token);
	await store.expire(empKey, SESSION_TTL_SECONDS);
	// Index under the restaurant too, so the platform can revoke every session
	// for a tenant when it is suspended.
	const resKey = RES_SESSIONS_PREFIX + payload.res_id;
	await store.sAdd(resKey, token);
	await store.expire(resKey, SESSION_TTL_SECONDS);
	return token;
}

export async function getSession(token: string): Promise<SessionPayload | null> {
	if (!token) {
		return null;
	}
	const store = await getStore();
	const raw = await store.get(SESSION_PREFIX + token);
	if (!raw) {
		return null;
	}
	try {
		return JSON.parse(raw) as SessionPayload;
	} catch {
		return null;
	}
}

export async function refreshTtl(token: string): Promise<void> {
	if (!token) {
		return;
	}
	const store = await getStore();
	await store.expire(SESSION_PREFIX + token, SESSION_TTL_SECONDS);
}

export async function destroySession(token: string): Promise<void> {
	if (!token) {
		return;
	}
	const store = await getStore();
	const payload = await getSession(token);
	await store.del(SESSION_PREFIX + token);
	if (payload) {
		await store.sRem(EMP_SESSIONS_PREFIX + payload.employeeId, token);
		await store.sRem(RES_SESSIONS_PREFIX + payload.res_id, token);
	}
}

export async function destroyAllForEmployee(employeeId: string): Promise<void> {
	if (!employeeId) {
		return;
	}
	const store = await getStore();
	const empKey = EMP_SESSIONS_PREFIX + employeeId;
	const tokens = await store.sMembers(empKey);
	if (tokens.length > 0) {
		await store.del(tokens.map((t) => SESSION_PREFIX + t));
	}
	await store.del(empKey);
}

// Revoke every active session for a restaurant (used by the platform when a
// tenant is suspended). No tenant DB access required.
export async function destroyAllForRestaurant(resId: string): Promise<void> {
	if (!resId) {
		return;
	}
	const store = await getStore();
	const resKey = RES_SESSIONS_PREFIX + resId;
	const tokens = await store.sMembers(resKey);
	if (tokens.length > 0) {
		await store.del(tokens.map((t) => SESSION_PREFIX + t));
	}
	await store.del(resKey);
}
