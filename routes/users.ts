/**
 * Restaurant staff accounts: listing, creation, deletion, password changes and the
 * password-reset request queue.
 */
import type { Express, Request, Response } from "express";
import { AddPasswordResetRequest, AddRestaurantUser, Audit_log_category, DeleteRestaurantUser, GetPasswordResetRequests, GetRestaurantEmployeeCount, GetRestaurantUsers, GetSuperadminEmployeeId, ResolvePasswordResetRequest, SetUserPassword } from "../database_supabase.js";
import { logger } from "../observability.js";
import { emitRestaurant } from "../realtime.js";
import { PERM_PASSWORDS, callerIsAdmin, callerIsSuperadmin, enforcePermission, enforceRoles, enforceRolesIgnoreOutletID, extractOutletId, isAdminRoleName, log_audit, optionalMobile10, rateLimit, revokeEmployeeSessions, validateAction } from "./_shared.js";


export function registerUserRoutes(app: Express): void {

app.get("/restaurant/users", validateAction("92cb8236-1039-4b47-a66f-6c7c8b0144ae"), async (req: Request, res: Response) => {
	const auth = await enforceRolesIgnoreOutletID(req, res, ["admin", "employee"]);
	if (!auth) {return;}

	try {
		const users = await GetRestaurantUsers(auth.restaurantId);
		res.json({ users });
	} catch (err) {
		logger.error({ err }, 'get_restaurant_users_failed');
		res.status(500).json({ error: 'Unable to fetch restaurant users' });
	}
});

app.post("/restaurant/users", validateAction("58fdfca7-7a97-439b-aeb2-00e4395a9a30"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin"]);
	if (!auth) {return;}

	// Enforce the subscribed plan's employee limit, when it defines one.
	const empLimit = Number(req.auth?.limits?.employees ?? 0);
	if (empLimit > 0) {
		try {
			const count = await GetRestaurantEmployeeCount(auth.restaurantId);
			if (count >= empLimit) {
				res.status(403).json({ error: `Your plan allows up to ${empLimit} employees. Upgrade to add more.` });
				return;
			}
		} catch (e) {
			logger.warn({ err: e }, "employee_limit_check_failed");
		}
	}

	const body = req.body ?? {};
	const empF = typeof body.emp_Fname === 'string' ? body.emp_Fname.trim() : (typeof body.firstName === 'string' ? body.firstName.trim() : '');
	const empL = typeof body.emp_Lname === 'string' ? body.emp_Lname.trim() : (typeof body.lastName === 'string' ? body.lastName.trim() : null);
	const username = typeof body.username === 'string' ? body.username.trim() : '';
	const email = typeof body.email === 'string' ? body.email.trim() : null;
	const role = typeof body.role === 'string' ? body.role : 'employee';
	const password = body.password;
	// Staff phone is optional, but a typed one must be a full 10-digit mobile
	// (it is the number rosters/shift messages use).
	const staffPhone = optionalMobile10(res, body.ph);
	if (!staffPhone.ok) {return;}
	const ph = staffPhone.value ?? undefined;
	const add = typeof body.add === 'string' ? body.add : undefined;

	// Creating a user directly WITH the admin role is owner-only, matching the
	// /roles/assign guard (an admin cannot mint more admins by any path).
	if (isAdminRoleName(role) && !(await callerIsSuperadmin(req))) {
		res.status(403).json({ error: "Only the owner (super-admin) can create an admin user." });
		return;
	}

	try {
		const created = await AddRestaurantUser(auth.restaurantId, auth.outletId, {
			emp_Fname: empF,
			emp_Lname: empL,
			email,
			role,
			password,
			employeeId: body.employeeId,
			username,
			ph,
			add
		});

		if (!created) {
			res.status(500).json({ error: 'Unable to create user' });
			return;
		}

		try { emitRestaurant(auth.restaurantId, 'restaurant:user:created', { user: created }); } catch (e) { logger.warn({ err: e }, 'emit user created failed'); }
		try { await log_audit(req, "58fdfca7-7a97-439b-aeb2-00e4395a9a30", `Created user '${username}' with role '${role}'`, Audit_log_category.Roles, { username, role }); } catch (err) { logger.warn({ err }, "log_audit create-user failed"); }

		res.status(201).json({ success: true, user: created });
	} catch (err) {
		logger.error({ err }, 'create_restaurant_user_failed');
		res.status(500).json({ error: 'Unable to create user' });
	}
});

app.delete("/restaurant/users", validateAction("a978f15d-1043-417a-b07b-05f6bddad875"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin"]);
	if (!auth) {return;}

	const outletId = extractOutletId(req);

	const body = req.body ?? {};
	const employeeId = typeof body.employeeId === 'string' ? body.employeeId.trim() : '';
	if (!employeeId) {
		res.status(400).json({ error: 'Missing employeeId' });
		return;
	}

	try {
		const ok = await DeleteRestaurantUser(auth.restaurantId, employeeId, outletId);
		if (!ok) {
			res.status(500).json({ error: 'Unable to delete user' });
			return;
		}

		// The login row is gone — kill the bearer tokens too, or a deleted user
		// keeps working until their sliding session lapses.
		await revokeEmployeeSessions(employeeId, "user_deleted");

		try { emitRestaurant(auth.restaurantId, 'restaurant:user:deleted', { employeeId }); } catch (e) { /* ignore emit errors */ }

		res.json({ success: true });
	} catch (error: any) {
		logger.error({ err: error }, 'delete_restaurant_user_failed');
		// Surface meaningful errors (e.g. the owner-protection guard) to the client.
		res.status(400).json({ error: String(error?.message ?? 'Unable to delete user') });
	}
});

// Admin sets/resets a user's password (directly, or to fulfil a forgot-password
// request). A non-superadmin admin cannot reset the superadmin's password.
app.post("/restaurant/users/password", async (req: Request, res: Response) => {
	const admin = await enforcePermission(req, res, PERM_PASSWORDS);
	if (!admin) {return;}
	const body = (req.body ?? {}) as Record<string, unknown>;
	const employeeId = typeof body.employeeId === "string" ? body.employeeId.trim() : "";
	const password = typeof body.password === "string" ? body.password : "";
	if (!employeeId || !password) { res.status(400).json({ error: "employeeId and password are required" }); return; }
	try {
		// Owner id resolved restaurant-wide (stable across outlets — the owner may
		// not be a user of the currently-viewed outlet); the outlet-scoped list
		// still drives the target-is-admin escalation guard below.
		const users = await GetRestaurantUsers(admin.restaurantId);
		const superId = await GetSuperadminEmployeeId(admin.restaurantId);
		const target = users.find((u) => u.employee_id === employeeId);
		const targetIsAdmin = !!target && (target.role === "admin" || (target.role_all ?? []).includes("admin") || target.is_superadmin === true);

		if (superId && employeeId === superId && req.auth?.employeeId !== superId) {
			res.status(403).json({ error: "Only the superadmin can reset the superadmin's password." });
			return;
		}
		// Escalation guard: a non-admin caller (e.g. a custom role merely granted
		// "Manage User Passwords") must not be able to reset an ADMIN's password —
		// that would be a back door to full admin. Admins (actions include "*") are
		// unaffected and can still reset regular staff and fellow admins.
		if (targetIsAdmin && !callerIsAdmin(req)) {
			res.status(403).json({ error: "Only an admin can reset an admin's password." });
			return;
		}
		await SetUserPassword(admin.restaurantId, employeeId, password);
		// A password reset must invalidate whatever was issued under the OLD
		// credential (the usual reason for a reset is that it leaked).
		await revokeEmployeeSessions(employeeId, "password_reset");
		// Log under the PASSWORD action (not a978f15d, whose real name is "Remove
		// Employee") — the audit log shows the action's NAME as the entry title, so
		// reusing an unrelated id titled a password reset "Remove Employee".
		try { await log_audit(req, PERM_PASSWORDS, `Reset password for a user`, Audit_log_category.General, { employeeId }); } catch {/* ignore */}
		res.json({ success: true });
	} catch (e: any) {
		logger.error({ err: e }, "set_user_password_failed");
		res.status(400).json({ error: String(e?.message ?? "Unable to set password") });
	}
});

// Admin: list pending forgot-password requests for this restaurant.
app.get("/restaurant/password-requests", async (req: Request, res: Response) => {
	const admin = await enforcePermission(req, res, PERM_PASSWORDS);
	if (!admin) {return;}
	try {
		res.json({ requests: await GetPasswordResetRequests(admin.restaurantId) });
	} catch (e) {
		logger.error({ err: e }, "get_password_requests_failed");
		res.status(500).json({ error: "Unable to load password requests" });
	}
});

// Admin: dismiss a pending password request without resetting.
app.post("/restaurant/password-requests/:id/dismiss", async (req: Request, res: Response) => {
	const admin = await enforcePermission(req, res, PERM_PASSWORDS);
	if (!admin) {return;}
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!id) { res.status(400).json({ error: "Missing request id" }); return; }
	try {
		await ResolvePasswordResetRequest(admin.restaurantId, id);
		res.json({ success: true });
	} catch (e) {
		logger.error({ err: e }, "dismiss_password_request_failed");
		res.status(500).json({ error: "Unable to dismiss request" });
	}
});

// Public: a staff member who forgot their password requests a reset. The
// restaurant slug identifies the tenant; their admin fulfils it from the app.
app.post("/auth/forgot-password", rateLimit("forgot", 5, 60_000), async (req: Request, res: Response) => {
	const body = (req.body ?? {}) as Record<string, unknown>;
	const slug = typeof body.restaurant === "string" ? body.restaurant.trim()
		: typeof body.restaurantUsername === "string" ? body.restaurantUsername.trim() : "";
	const username = typeof body.username === "string" ? body.username.trim() : "";
	// Optional: the outlet the client picked in the pre-auth /auth/outlets picker.
	// The same username can name different people in different outlets, so this is
	// what tells them apart; without it the request is filed for every match.
	const outletId = typeof body.outletId === "string" ? body.outletId.trim() : "";
	if (!slug || !username) { res.status(400).json({ error: "restaurant and username are required" }); return; }
	try {
		await AddPasswordResetRequest(slug, username, outletId || undefined);
		// Always 200 (don't reveal whether the account exists).
		res.json({ success: true });
	} catch (e: any) {
		// A missing restaurant still returns success-shaped to avoid enumeration.
		logger.warn({ err: e }, "forgot_password_request_failed");
		res.json({ success: true });
	}
});
}
