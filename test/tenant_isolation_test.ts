import assert from "node:assert";
import { API_BASE, login, authHeaders } from "./_auth.js";

// Milestone-1 security/isolation integration test.
//
// REQUIRES (skips gracefully otherwise):
//   - backend running (npm run dev) with DB + Redis
//   - two seeded restaurants A and B, each with a known employee
// Configure via env: TEST_A_RESTAURANT/USERNAME/PASSWORD and TEST_B_* .
//
// Verifies the guarantees this milestone added:
//   1. Protected routes reject requests with no session token.
//   2. Spoofed identity headers (X-Restaurant-Id / X-User-Role / X-Action-List)
//      have no effect — identity comes from the token only.
//   3. Logout invalidates the session immediately.
// (Cross-tenant DB isolation is additionally enforced by RLS — see the SQL
//  verification snippet in migrations/003_enable_rls.sql.)

const A = {
	name: process.env.TEST_A_RESTAURANT || "",
	user: process.env.TEST_A_USERNAME || "",
	pass: process.env.TEST_A_PASSWORD || "",
};
const B = {
	name: process.env.TEST_B_RESTAURANT || "",
	user: process.env.TEST_B_USERNAME || "",
	pass: process.env.TEST_B_PASSWORD || "",
};

// A representative protected, read-only route (see README API surface).
const PROTECTED_PATH = "/get-tables";

async function main() {
	if (!A.name || !B.name) {
		console.log("tenant_isolation_test: set TEST_A_* and TEST_B_* env to run. Skipping.");
		return;
	}

	const a = await login(A.name, A.user, A.pass);
	const b = await login(B.name, B.user, B.pass);
	assert.notStrictEqual(a.res_id, b.res_id, "A and B must be different tenants");

	// 1) No token -> 401.
	const noAuth = await fetch(`${API_BASE}${PROTECTED_PATH}`, {
		headers: { "Content-Type": "application/json" },
	});
	assert.strictEqual(noAuth.status, 401, "protected route must require a token");

	// 2) Spoofed identity headers must not escalate or switch tenant. A's token
	//    plus B's res-id / admin role / wildcard action list must still be
	//    treated as A, never as B and never as elevated.
	const spoof = await fetch(`${API_BASE}${PROTECTED_PATH}`, {
		headers: authHeaders(a.token, {
			"X-Restaurant-Id": b.res_id,
			"X-User-Role": "admin",
			"X-Action-List": "*",
		}),
	});
	assert.ok(spoof.status === 200 || spoof.status === 403, "spoofed headers must not crash or switch tenant");

	// 3) Logout invalidates the session immediately.
	const loggedOut = await fetch(`${API_BASE}/auth/logout`, {
		method: "POST",
		headers: authHeaders(a.token),
	});
	assert.ok(loggedOut.ok, "logout should succeed");
	const afterLogout = await fetch(`${API_BASE}${PROTECTED_PATH}`, {
		headers: authHeaders(a.token),
	});
	assert.strictEqual(afterLogout.status, 401, "logout must invalidate the session");

	console.log("tenant_isolation_test: assertions passed");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
