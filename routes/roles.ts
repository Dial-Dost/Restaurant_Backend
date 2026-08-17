/**
 * Roles, actions and role assignment (the RBAC surface).
 */
import type { Express, Request, Response } from "express";
import { AssignRoleToEmployee, Audit_log_category, CORE_ROLES, CreateRole, DeleteRole, GetActions, GetEmployeeIdsWithRole, GetRoles, RemoveRoleFromEmployee, readEmployeeRolesForUndo } from "../database_supabase.js";
import { logger } from "../observability.js";
import { callerIsAdmin, callerIsSuperadmin, extractRestaurantId, isAdminRoleName, isPrivilegedRoleName, log_audit, revokeEmployeeSessions, validateAction } from "./_shared.js";


export function registerCoreRolesRoute(app: Express): void {

app.get('/core-roles', validateAction("17ba6407-b703-4403-ab59-13235966053f"), async (req: Request, res: Response) => {
	try {
		/* read action — not audited (avoids log clutter) */
		const rows = Object.keys(CORE_ROLES).map((role) => ({ role, actions: CORE_ROLES[role as keyof typeof CORE_ROLES] }));
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
		res.json(roles);
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
	// Privilege-escalation guard: the core "admin"/"manager" roles expand to ["*"]
	// (all permissions). Only a REAL admin may grant them — otherwise the mere
	// assign-role permission on a custom role could bootstrap an employee to full admin.
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
