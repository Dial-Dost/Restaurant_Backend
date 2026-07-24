// Shared test login helper for token-authenticated integration tests.
// REQUIRES a running backend with DB + Redis and a seeded restaurant/employee.
export const API_BASE = process.env.BACKEND_API_BASE_URL || "http://localhost:3001";

export interface LoginResult {
	token: string;
	res_id: string;
	outlet_id: string;
	employeeId: string;
}

export async function login(
	restaurantName: string,
	employeeUsername: string,
	password: string,
): Promise<LoginResult> {
	const res = await fetch(`${API_BASE}/auth/employee-login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ restaurantName, employeeUsername, password }),
	});
	if (!res.ok) {
		throw new Error(`login failed (${res.status}): ${await res.text()}`);
	}
	const data = (await res.json()) as Record<string, any>;
	if (typeof data.token !== "string" || !data.token) {
		throw new Error("login response missing token");
	}
	return {
		token: data.token,
		res_id: data.res_id,
		outlet_id: data.outlet_id,
		employeeId: data.employeeId,
	};
}

export function authHeaders(
	token: string,
	extra: Record<string, string> = {},
): Record<string, string> {
	return { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...extra };
}
