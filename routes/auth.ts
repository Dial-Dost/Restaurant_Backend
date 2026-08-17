/**
 * Tenant authentication: restaurant self-registration, outlet discovery, employee
 * login/logout, session introspection and the legacy restaurant-login lookup.
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { createSession, destroySession, getSession } from "../auth/sessions.js";
import { AuthenticateRestaurantEmployee, EnsureRestaurantSeed, GetRestaurantAccountStatus, GetRestaurantOutletsPublic, GetRestaurantPlan, GetRestaurantUsers, getRestaurantIdFromUsername } from "../database_supabase.js";
import { logger } from "../observability.js";
import { startTrialIfMissing } from "../platform/tenant_billing.js";
import { extractBearerToken, extractRestaurantUsername, passwordPolicyError, rateLimit, validate, validateBody } from "./_shared.js";


// (extractActionList removed — permissions now come from the verified session.)

function normalizeRestaurantSlug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const registerRestaurantSchema = z.object({
	restaurantName: z.string().trim().min(1).max(120),
	adminName: z.string().trim().min(1).max(120),
	adminEmployeeId: z.string().trim().min(1).max(120),
	password: z.string().min(1).max(200),
}).passthrough();

export function registerAuthRoutes(app: Express): void {
app.post("/auth/register-restaurant", rateLimit("register", 5, 60_000), validateBody(registerRestaurantSchema), validate, async (req: Request, res: Response) => {
	const body = (req.body ?? {}) as Record<string, unknown>;
	const restaurantName = typeof body.restaurantName === "string" ? body.restaurantName.trim() : "";
	const adminName = typeof body.adminName === "string" ? body.adminName.trim() : "";
	const adminEmployeeId = typeof body.adminEmployeeId === "string" ? body.adminEmployeeId.trim() : "";
	const password = typeof body.password === "string" ? body.password : "";

	if (!restaurantName || !adminName || !adminEmployeeId || !password) {
		res.status(400).json({
			error: "restaurantName, adminName, adminEmployeeId, and password are required",
		});
		return;
	}

	const pwError = passwordPolicyError(password);
	if (pwError) {
		res.status(400).json({ error: pwError });
		return;
	}

	const restaurantId = normalizeRestaurantSlug(restaurantName);
	if (!restaurantId) {
		res.status(400).json({ error: "Restaurant name must include letters or numbers" });
		return;
	}

	try {
		try {
			await GetRestaurantUsers(restaurantId);
			res.status(409).json({ error: `Restaurant \"${restaurantName}\" is already registered.` });
			return;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("Unknown restaurant id")) {
				throw error;
			}
		}

		await EnsureRestaurantSeed({
			id: restaurantId,
			name: restaurantName,
			admin: {
				employeeId: adminEmployeeId,
				name: adminName,
				password,
			},
			tables: [],
		});

		// Start a trial on the default plan for the new tenant (best-effort; the
		// operator can reassign the plan in the platform console). Disable with
		// SAAS_AUTO_TRIAL=false.
		if (process.env.SAAS_AUTO_TRIAL !== "false") {
			try {
				const newResId = await getRestaurantIdFromUsername(restaurantId);
				if (newResId) {await startTrialIfMissing(newResId, Number(process.env.SAAS_TRIAL_DAYS || 14));}
			} catch (e) {
				logger.warn({ err: e }, "start_trial_failed");
			}
		}

		res.status(201).json({
			restaurantId,
			restaurantName,
			admin: {
				employeeId: adminEmployeeId,
				name: adminName,
				role: "admin",
			},
		});
	} catch (error) {
		logger.error({ err: error }, "register_restaurant_failed");
		res.status(500).json({ error: "Unable to register restaurant" });
	}
});

// Pre-auth outlet picker: the login screen calls this to list a restaurant's
// outlets so the user can choose WHICH outlet to sign into (employee identity is
// per-outlet — the same username may name different people in different outlets).
// PUBLIC + rate-limited. Never reveals whether a restaurant exists: an unknown
// slug/id returns {outlets:[]} with 200. Returns outlet ids + names ONLY.
app.get("/auth/outlets", rateLimit("auth-outlets", 30, 60_000), async (req: Request, res: Response) => {
	const raw = typeof req.query.restaurant === "string" ? req.query.restaurant.trim() : "";
	if (!raw) {
		res.json({ outlets: [] });
		return;
	}
	try {
		const outlets = await GetRestaurantOutletsPublic(raw);
		res.json({ outlets });
	} catch (error) {
		// Fail closed but shaped — don't leak existence (or errors) via a non-200.
		logger.error({ err: error }, "auth_outlets_failed");
		res.json({ outlets: [] });
	}
});

app.post("/auth/employee-login", rateLimit("login", 15, 60_000), validate, async (req: Request, res: Response) => {
	const body = (req.body ?? {}) as Record<string, unknown>;
	const employeeUsername = typeof body.employeeUsername === "string" ? body.employeeUsername.trim() : "";
	const password = typeof body.password === "string" ? body.password : "";
	const restaurantIdRaw = typeof body.restaurantId === "string" ? body.restaurantId.trim() : "";
	const restaurantName = typeof body.restaurantName === "string" ? body.restaurantName.trim() : "";
	// Optional: the outlet the user chose in the pre-auth picker. Omitted/empty →
	// defaults to the restaurant's first outlet (single-outlet + old clients work).
	const outletId = typeof body.outletId === "string" ? body.outletId.trim() : "";

	if (!employeeUsername || !password || !restaurantName) {
		res.status(400).json({
			error: "employeeUsername, password, and restaurantName are required",
		});
		return;
	}

	const restaurantUsername = restaurantIdRaw || normalizeRestaurantSlug(restaurantName);

	try {
		const user = await AuthenticateRestaurantEmployee(restaurantUsername, employeeUsername, password, outletId || undefined);
		if (!user) {
			res.status(401).json({ error: "Invalid employee ID or password." });
			return;
		}
		// Block sign-in for suspended / expired restaurant accounts.
		const accountStatus = await GetRestaurantAccountStatus(user.res_id);
		if (accountStatus !== "active") {
			res.status(403).json({
				error:
					accountStatus === "expired"
						? "This restaurant's subscription has expired. Please contact support."
						: "This restaurant account is suspended. Please contact support.",
			});
			return;
		}
		const plan = await GetRestaurantPlan(user.res_id);
		const token = await createSession({
			employeeId: user.employeeId,
			res_id: user.res_id,
			outlet_id: user.outlet_id,
			role: user.role,
			role_all: user.role_all,
			actions: Array.from(user.actions_set),
			features: plan.features,
			limits: plan.limits,
			action_names: user.action_names,
			emp_Fname: user.emp_Fname,
			emp_Lname: user.emp_Lname ?? null,
			employeeUsername: user.employeeUsername ?? "",
			restaurantUsername: user.restaurantUsername,
			restaurantName: user.restaurantName,
		});
		res.json({
			token,
			uid: user.employeeId,
			employeeId: user.employeeId,
			employeeUsername: user.employeeUsername ?? undefined,
			role: user.role,
			role_all: user.role_all,
			restaurantUsername: user.restaurantUsername,
			restaurantName: user.restaurantName,
			res_id: user.res_id,
			outlet_id: user.outlet_id,
			emp_Fname: user.emp_Fname,
			emp_Lname: user.emp_Lname ?? null,
			actions_set: Array.from(user.actions_set),
			action_names: user.action_names,
			features: plan.features,
			limits: plan.limits,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("Unknown restaurant id")) {
			res.status(404).json({ error: "Invalid restaurant name." });
			return;
		}

		logger.error({ err: error }, "employee_login_failed");
		res.status(500).json({ error: "Unable to sign in." });
	}
});

app.post("/auth/logout", async (req: Request, res: Response) => {
	const token = extractBearerToken(req);
	if (token) {
		try {
			await destroySession(token);
		} catch (err) {
			logger.error({ err }, "logout_failed");
		}
	}
	res.json({ ok: true });
});

// Re-hydrate the client UI from the verified session (profile + permitted
// action names for display gating). The server remains the source of truth.
app.get("/auth/me", async (req: Request, res: Response) => {
	const token = extractBearerToken(req);
	const session = token ? await getSession(token) : null;
	if (!session) {
		res.status(401).json({ error: "Unauthorized" });
		return;
	}
	res.json({
		employeeId: session.employeeId,
		uid: session.employeeId,
		employeeUsername: session.employeeUsername,
		role: session.role,
		role_all: session.role_all,
		res_id: session.res_id,
		outlet_id: session.outlet_id,
		restaurantUsername: session.restaurantUsername,
		restaurantName: session.restaurantName,
		emp_Fname: session.emp_Fname,
		emp_Lname: session.emp_Lname,
		actions_set: session.actions,
		action_names: session.action_names,
		features: session.features ?? {},
		limits: session.limits ?? {},
	});
});
}


export function registerRestaurantLoginRoute(app: Express): void {

app.get("/auth/restaurant-login", validate, async (req: Request, res: Response) => {
	const restaurantUsername = extractRestaurantUsername(req);
	if (!restaurantUsername) {
		res.status(400).json({ error: "Missing restaurant Username" });
		return;
	}

	const resId = await getRestaurantIdFromUsername(restaurantUsername);
	if (!resId) {
		res.status(404).json({ error: "Restaurant not found" });
		return;
	}
	res.json({ res_id: resId });

});
}
