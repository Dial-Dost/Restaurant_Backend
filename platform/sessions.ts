import { randomBytes } from "node:crypto";
import { getStore } from "../auth/store.js";

// Platform-admin sessions, kept in a separate keyspace (psession:) from tenant
// sessions so the two auth domains never overlap. Same store as tenant sessions
// (Redis when configured, else in-memory).

export interface PlatformSession {
	adminId: string;
	email: string;
	name: string | null;
}

const TTL = Number(process.env.PLATFORM_SESSION_TTL_SECONDS ?? 60 * 60 * 8); // sliding 8h
const PREFIX = "psession:";

function newToken(): string {
	return randomBytes(32).toString("base64url");
}

export async function createPlatformSession(payload: PlatformSession): Promise<string> {
	const store = await getStore();
	const token = newToken();
	await store.set(PREFIX + token, JSON.stringify(payload), TTL);
	return token;
}

export async function getPlatformSession(token: string): Promise<PlatformSession | null> {
	if (!token) {return null;}
	const store = await getStore();
	const raw = await store.get(PREFIX + token);
	if (!raw) {return null;}
	try {
		return JSON.parse(raw) as PlatformSession;
	} catch {
		return null;
	}
}

export async function refreshPlatformTtl(token: string): Promise<void> {
	if (!token) {return;}
	const store = await getStore();
	await store.expire(PREFIX + token, TTL);
}

export async function destroyPlatformSession(token: string): Promise<void> {
	if (!token) {return;}
	const store = await getStore();
	await store.del(PREFIX + token);
}
