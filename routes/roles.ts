/**
 * Roles, actions and role assignment (the RBAC surface).
 *
 * ============================================================================
 * C5 / C6 — WHO MAY SEE AND EDIT ROLES, AND WHY CORE ROLES WERE UNCLICKABLE
 * ============================================================================
 *
 * C6 ASKS FOR "the issue preventing users from clicking and viewing core roles"
 * TO BE FIXED. There were two, and neither was a broken click handler:
 *
 *   1. THE LIST WAS EMPTY, so there was nothing to click. GET /core-roles is
 *      gated on "Get Roles" (17ba6407…), and until now NO core role held that id
 *      — only an admin, via the "*" wildcard, could load it. Every other
 *      identity got a 403, the dashboard's `catch` set `coreRoles` to `[]`, and
 *      the card rendered "No core roles available". A manager opening the
 *      access-control screen saw a screen with no roles on it and no error. The
 *      fix is in CORE_ROLES (database_supabase.ts): the core `manager` now holds
 *      Get Roles, Get Actions and Create/Update Role, which is also exactly what
 *      C5 asks for — "Super Admins and Managers can view and edit custom roles".
 *
 *   2. WHAT CAME BACK WAS UNREADABLE EVEN WHEN IT LOADED. The response was
 *      `{ role, actions: ["4ad474d4-…", "98b10bde-…"] }` — bare uuids. To render
 *      a core role a client had to fetch GET /actions and join, and /actions is
 *      gated on a DIFFERENT permission (2b6f7948…). Any caller holding one and
 *      not the other opened a core role and was shown a column of uuids, which
 *      is "viewing" a role in the same sense that a hex dump is reading a
 *      photograph. So each row now carries `permissions`: the same list, in the
 *      same order, with the name, description and group already attached. One
 *      call renders a readable core role.
 *
 * `actions` IS UNCHANGED AND STILL FIRST. The shipped dashboard reads
 * `r.actions` as an array of strings; turning it into objects would break it on
 * the next deploy. `permissions` is strictly additive beside it.
 */
import type { Express, Request, Response } from "express";
import { AssignRoleToEmployee, Audit_log_category, CORE_ROLES, CreateRole, DeleteRole, GetActions, GetEmployeeIdsWithRole, GetRoles, RemoveRoleFromEmployee, readEmployeeRolesForUndo } from "../database_supabase.js";
import { logger } from "../observability.js";
import { callerIsAdmin, callerIsSuperadmin, extractRestaurantId, isAdminRoleName, isPrivilegedRoleName, log_audit, revokeEmployeeSessions, validateAction } from "./_shared.js";

/** One permission as a role screen needs to render it. `action_name` is null for an id with no "Actions" row. */
interface RolePermissionView {
	id: string;
	action_name: string | null;
	action_desc: string | null;
	group: string | null;
}

/**
 * Attach names to a role's action ids, IN THE SAME ORDER, NEVER DROPPING ONE.
 *
 * An id with no row in "Actions" keeps its place with `action_name: null`, so a
 * client renders "Unknown permission" rather than silently showing a core role
 * with fewer permissions than it actually grants. Quietly shortening the list is
 * how a reviewer concludes a role is safe when it is not.
 */
function describePermissions(ids: readonly string[], catalog: Map<string, RolePermissionView>): RolePermissionView[] {
	return ids.map((id) => {
		// The admin wildcard is not an "Actions" row and never will be — it is the
		// absence of a check. Named here so the admin core role reads as something
		// rather than as one unknown uuid.
		if (id === "*") {
			return { id, action_name: "All actions", action_desc: "Every permission in the system, including any added later", group: null };
		}
		return catalog.get(id) ?? { id, action_name: null, action_desc: null, group: null };
	});
}


export function registerCoreRolesRoute(app: Express): void {

app.get('/core-roles', validateAction("17ba6407-b703-4403-ab59-13235966053f"), async (req: Request, res: Response) => {
	try {
		/* read action — not audited (avoids log clutter) */
		// The catalogue is a small global table and this is a screen-open read, so
		// one query serves every role rather than one per role. A failure to load it
		// DEGRADES rather than fails: the core roles still come back, with
		// `permissions` carrying null names. A roles screen that renders uuids is
		// poor; a roles screen that 500s because the name lookup was unavailable is
		// worse, and it is the regression C6 is about.
		const catalog = new Map<string, RolePermissionView>();
		try {
			for (const a of await GetActions()) {
				catalog.set(a.id, { id: a.id, action_name: a.action_name, action_desc: a.action_desc ?? null, group: a.group ?? null });
			}
		} catch (err) {
			logger.warn({ err }, 'core_roles_action_catalog_unavailable');
		}
		const rows = Object.keys(CORE_ROLES).map((role) => {
			const actions = CORE_ROLES[role as keyof typeof CORE_ROLES] as readonly string[];
			return {
				role,
				// UNCHANGED SHAPE, UNCHANGED POSITION — the shipped dashboard reads this.
				actions,
				// C6: the same ids, already readable. Additive.
				permissions: describePermissions(actions, catalog),
				// A core role is defined in code and cannot be edited through the API, so
				// the client can say so instead of drawing a Save button that 404s. C5
				// asks for CUSTOM roles to be editable; core roles are the fixed floor
				// they are built against.
				editable: false,
			};
		});
		res.json(rows);
	} catch (err: any) {
		logger.error({ err }, 'error_fetching_core_roles');
		res.status(500).json({ error: 'Unable to fetch core roles' });
	}
});
}


export function registerRoleRoutes(app: Express): void {

app.get("/roles", validateAction("17ba6407-b703-4403-ab59-13235966053f"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	try {
		const roles = await GetRoles(restaurantId);
		// C5/C6, same treatment as /core-roles: a custom role comes back with its
		// permission ids ALREADY NAMED, so the role screen renders without a second
		// call to /actions. `actions_performable` is untouched and still the field
		// the shipped clients read; `permissions` rides beside it.
		const catalog = new Map<string, RolePermissionView>();
		try {
			for (const a of await GetActions()) {
				catalog.set(a.id, { id: a.id, action_name: a.action_name, action_desc: a.action_desc ?? null, group: a.group ?? null });
			}
		} catch (err) {
			logger.warn({ err }, 'roles_action_catalog_unavailable');
		}
		res.json(roles.map((role) => ({
			...role,
			permissions: describePermissions(role.actions_performable.map(String), catalog),
			// A custom role IS editable — that is the whole of C5 — and saying so here
			// means a client renders one list of roles with one rule for which ones
			// open an editor, instead of re-deriving "is this name a core role".
			editable: true,
		})));
	} catch (error) {
		logger.error({ err: error }, "get_roles_failed");
		res.status(500).json({ error: "Unable to fetch roles" });
	}
});

app.get("/actions", validateAction("2b6f7948-0b27-41a9-9727-c04ccc9f4db1"), async (req: Request, res: Response) => {

	try {
		const actions = await GetActions();
		res.json(actions);
	} catch (err) {
		logger.error({ err }, 'get_actions_failed');
		res.status(500).json({ error: 'Unable to fetch actions' });
	}
});

app.post("/roles", validateAction("c0135d18-68b4-45e9-9b51-849158df6efd"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const roleName = typeof req.body?.role_name === "string" ? req.body.role_name : "";
	const actions = Array.isArray(req.body?.actions_performable)
		? req.body.actions_performable.map((entry: unknown) => String(entry))
		: [];

	// ============================================================================
	// C5 — DELEGATION MUST NOT BE ESCALATION.
	// ============================================================================
	//
	// C5 opens role editing to managers. The moment a non-admin can write
	// `actions_performable`, "edit a custom role" becomes "grant myself anything":
	// a manager creates (or edits) a role carrying Manage User Passwords, Manage
	// Restaurant Settings and Delete Role, has it assigned, and is an
	// administrator by a route whose name says "roles". Nothing downstream would
	// catch it — CreateRole validates that the ids EXIST, not that the caller may
	// hand them out, and the session's action set is rebuilt from whatever the row
	// says at next login.
	//
	// THE RULE: a non-admin may only put into a role what they themselves hold.
	// It is the ordinary delegation rule — you cannot give away authority you were
	// never given — and it needs no new configuration to be correct for a tenant
	// nobody has thought about.
	//
	// AN ADMIN LOSES NOTHING: callerIsAdmin short-circuits the whole check, so the
	// owner and every admin keep granting every permission exactly as today. This
	// is also why the check is here and not inside CreateRole: the data layer has
	// no caller, and a rule about WHO is asking belongs where the session is.
	//
	// The 403 NAMES THE IDS it refused. "Forbidden" on a save of fourteen
	// checkboxes is unactionable; a list is something an owner can either grant to
	// the manager or untick.
	if (!callerIsAdmin(req)) {
		const held = new Set(req.auth?.actions ?? []);
		const ungrantable = actions.filter((id: string) => id !== "*" && !held.has(id));
		// "*" is refused for everyone who is not an admin, unconditionally: it is the
		// absence of a permission check, not a permission, and a custom role carrying
		// it would be an unnamed second admin.
		if (actions.includes("*") || ungrantable.length > 0) {
			res.status(403).json({
				error: "You cannot grant permissions you do not hold yourself.",
				ungrantableActionIds: actions.includes("*") ? ["*", ...ungrantable] : ungrantable,
			});
			return;
		}
	}

	try {
		// CreateRole upserts by name — capture the prior permission set so an EDIT
		// of an existing role is undoable (a brand-new role has no prior state).
		const priorRole = (await GetRoles(restaurantId).catch(() => []))
			.find((r) => r.role_name.toLowerCase() === roleName.trim().toLowerCase()) ?? null;
		const role = await CreateRole(restaurantId, roleName, actions);
		// Editing an existing role rewrites what its holders may do, but every live
		// session still carries the action list resolved at ITS login — revoke the
		// holders' sessions so the new list actually applies. A brand-new role has
		// no holders, so nothing to revoke.
		if (priorRole) {
			const holders = await GetEmployeeIdsWithRole(restaurantId, [role.id, role.role_name]).catch(() => [] as string[]);
			for (const holder of holders) {
				await revokeEmployeeSessions(holder, "role_permissions_changed");
			}
		}
		try {
			await log_audit(req, "c0135d18-68b4-45e9-9b51-849158df6efd", priorRole ? `Updated permissions of role '${role.role_name}'` : `Created role '${role.role_name}'`, Audit_log_category.Roles, {
				role_id: role.id,
				role_name: role.role_name,
				...(priorRole
					? { undo: { kind: "role_permissions", target_id: role.id, before: { actions_performable: priorRole.actions_performable }, after: { actions_performable: role.actions_performable } } }
					: {}),
			});
		} catch (err) { logger.warn({ err }, "log_audit create-role failed"); }
		res.status(201).json(role);
	} catch (error: any) {
		logger.error({ err: error }, "create_role_failed");
		if (error && error.name === 'ValidationError') {
			// structured response for invalid action ids
			return res.status(400).json({ error: String(error.message), invalidActionIds: error.invalidActionIds ?? [] });
		}
		res.status(400).json({ error: String(error?.message ?? "Unable to create role") });
	}
});

app.delete("/roles/:id", validateAction("53d0927d-00f4-48cc-a40c-51edb09826d8"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const roleId = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!roleId) {
		res.status(400).json({ error: "Invalid role id" });
		return;
	}

	try {
		// Capture the holders before the role disappears — their sessions carry the
		// permissions this role granted and must be revoked with it.
		const holders = await GetEmployeeIdsWithRole(restaurantId, [roleId]).catch(() => [] as string[]);
		const removed = await DeleteRole(restaurantId, roleId);
		if (!removed) {
			res.status(404).json({ error: "Role not found" });
			return;
		}
		for (const holder of holders) {
			await revokeEmployeeSessions(holder, "role_deleted");
		}
		res.status(204).send();
	} catch (error) {
		logger.error({ err: error }, "delete_role_failed");
		res.status(500).json({ error: "Unable to delete role" });
	}
});

app.post("/roles/assign", validateAction("4bf54bd9-9124-46c0-a7cc-011ea4c4e172"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const employeeId = typeof req.body?.employeeId === "string" ? req.body.employeeId.trim() : "";
	const roleName = typeof req.body?.role_name === "string" ? req.body.role_name.trim() : "";
	if (!employeeId || !roleName) {
		res.status(400).json({ error: "employeeId and role_name are required" });
		return;
	}
	// Privilege-escalation guard. "admin" expands to the ["*"] wildcard; "manager"
	// resolves to a concrete list that carries the till (C2) and view/edit of
	// custom roles (C5). Either one changes who runs the restaurant, so only a REAL
	// admin may grant them — otherwise the mere assign-role permission on a custom
	// role could bootstrap an employee to full admin.
	if (isPrivilegedRoleName(roleName) && !callerIsAdmin(req)) {
		res.status(403).json({ error: "Only an admin can assign the admin or manager role." });
		return;
	}
	// The admin role itself is owner-only: an admin cannot mint more admins.
	if (isAdminRoleName(roleName) && !(await callerIsSuperadmin(req))) {
		res.status(403).json({ error: "Only the owner (super-admin) can grant the admin role." });
		return;
	}

	try {
		const priorRoles = await readEmployeeRolesForUndo(restaurantId, employeeId).catch(() => null);
		await AssignRoleToEmployee(restaurantId, employeeId, roleName);
		// Permissions are cached on the session at login, so the new role only
		// takes effect once the holder re-authenticates.
		await revokeEmployeeSessions(employeeId, "role_assigned");
		const nextRoles = priorRoles ? await readEmployeeRolesForUndo(restaurantId, employeeId).catch(() => null) : null;
		try {
			await log_audit(req, "4bf54bd9-9124-46c0-a7cc-011ea4c4e172", `Assigned role '${roleName}' to employee ${employeeId}`, Audit_log_category.Roles, {
				employee_id: employeeId, role: roleName,
				...(priorRoles && nextRoles
					// `primary` is captured so the undo restores the recorded primary
					// role verbatim instead of recomputing one from the role list.
					? { undo: { kind: "role_assign", target_id: employeeId, before: { roles: priorRoles.roles, primary: priorRoles.primary }, after: { roles: nextRoles.roles, primary: nextRoles.primary } } }
					: {}),
			});
		} catch (err) { logger.warn({ err }, "log_audit assign-role failed"); }
		res.json({ success: true });
	} catch (error: any) {
		logger.error({ err: error }, "assign_role_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to assign role") });
	}
});

app.post("/roles/remove", validateAction("9acc9097-4803-4be0-bb6d-fc2c5de57cf5"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const employeeId = typeof req.body?.employeeId === "string" ? req.body.employeeId.trim() : "";
	const roleName = typeof req.body?.role_name === "string" ? req.body.role_name.trim() : "";
	if (!employeeId || !roleName) {
		res.status(400).json({ error: "employeeId and role_name are required" });
		return;
	}
	// Only a real admin may add/remove the privileged admin/manager roles.
	if (isPrivilegedRoleName(roleName) && !callerIsAdmin(req)) {
		res.status(403).json({ error: "Only an admin can change the admin or manager role." });
		return;
	}
	// Demoting an admin is owner-only too (and the owner themself can never be
	// demoted — RemoveRoleFromEmployee already refuses the superadmin).
	if (isAdminRoleName(roleName) && !(await callerIsSuperadmin(req))) {
		res.status(403).json({ error: "Only the owner (super-admin) can remove the admin role." });
		return;
	}

	try {
		const priorRoles = await readEmployeeRolesForUndo(restaurantId, employeeId).catch(() => null);
		await RemoveRoleFromEmployee(restaurantId, employeeId, roleName);
		// A revoked role must stop working NOW, not at the holder's next logout.
		await revokeEmployeeSessions(employeeId, "role_removed");
		const nextRoles = priorRoles ? await readEmployeeRolesForUndo(restaurantId, employeeId).catch(() => null) : null;
		try {
			await log_audit(req, "9acc9097-4803-4be0-bb6d-fc2c5de57cf5", `Removed role '${roleName}' from employee ${employeeId}`, Audit_log_category.Roles, {
				employee_id: employeeId, role: roleName,
				...(priorRoles && nextRoles
					? { undo: { kind: "role_remove", target_id: employeeId, before: { roles: priorRoles.roles, primary: priorRoles.primary }, after: { roles: nextRoles.roles, primary: nextRoles.primary } } }
					: {}),
			});
		} catch (err) { logger.warn({ err }, "log_audit remove-role failed"); }
		res.json({ success: true });
	} catch (error: any) {
		logger.error({ err: error }, "remove_role_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to remove role") });
	}
});
}
