/**
 * Audit log: querying the immutable trail and the allowlisted undo path.
 */
import type { Express, Request, Response } from "express";
import { AUDIT_UNDO_PERMISSION_ID, Audit_log_category, GetAuditLogs, PerformAuditUndo } from "../database_supabase.js";
import { logger } from "../observability.js";
import { callerIsAdmin, callerIsSuperadmin, clampLimit, endOfDayBound, enforcePermission, extractEmployeeId, extractRestaurantId, isAdminRoleName, isPrivilegedRoleName, validate, validateAction } from "./_shared.js";


export function registerAuditRoutes(app: Express): void {

app.get("/audit-logs", validateAction("91b24293-7b88-4fe4-8cf5-deb6faaba4f5"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const limit = clampLimit(req.query.limit, 100, 500);
	const offset = Math.max(0, Math.min(Number(req.query.offset) || 0, 100000));
	const categoryRaw = typeof req.query.category === "string" ? req.query.category : "";
	const category = (Object.values(Audit_log_category) as string[]).includes(categoryRaw) ? categoryRaw : undefined;
	const search = typeof req.query.search === "string" ? req.query.search.slice(0, 200) : undefined;
	const from = typeof req.query.from === "string" ? req.query.from : undefined;
	// A bare YYYY-MM-DD upper bound means "through the end of that day".
	const to = endOfDayBound(req.query.to);

	// Infinite scroll needs to know when to stop, but the response has always been
	// a bare ARRAY and both the web dashboard and the owner app parse it that way.
	// So: the array stays the default, the paging metadata rides along in headers
	// (always), and `?meta=1` opts into the enveloped body for new clients.
	const wantMeta = req.query.meta === "1" || req.query.meta === "true";

	try {
		const page = await GetAuditLogs(restaurantId, { limit, offset, category, search, from, to });
		// try {
		// 	await log_audit(req, "91b24293-7b88-4fe4-8cf5-deb6faaba4f5", `Fetched audit logs`, Audit_log_category.General, { limit });
		// } catch (err) {
		// 	console.warn('log_audit get-audit-logs failed', err);
		// }
		res.setHeader("X-Total-Count", String(page.total));
		res.setHeader("X-Has-More", page.has_more ? "1" : "0");
		if (wantMeta) {
			res.json(page);
			return;
		}
		res.json(page.logs);
	} catch (error) {
		res.status(500).json({ error: "Unable to fetch audit logs" });
	}
});

// Reverse one eligible audit entry. Requires BOTH the undo permission AND the
// permission of the ORIGINAL action — you may not undo a menu price change
// unless you could have made one. Admin ("*") satisfies both.
//
// The original row is never touched: a successful undo APPENDS a new entry
// carrying { undo_of: <original id> }. Every refusal class maps to a status:
//   403 no-permission | 404 not-found
//   400 not-allowlisted / blocklisted / missing-before-state / too-old
//       / cannot-restore-null / cannot-restore-key / target-name-taken
//   409 already-undone / superseded / target-gone / bill-settled
//
// The whole reversal (re-evaluation, the compensating write, and the appended
// undo row) runs in ONE transaction with the original row locked FOR UPDATE, so
// concurrent undos of the same entry produce exactly one 200 and 409s for the
// rest — backed by a partial UNIQUE index on the undo_of back-reference.
app.post("/audit-logs/:id/undo", validate, async (req: Request, res: Response) => {
	const scope = await enforcePermission(req, res, AUDIT_UNDO_PERMISSION_ID);
	if (!scope) {return;}
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const logId = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!logId) { res.status(400).json({ error: "Missing audit log id" }); return; }
	const employeeId = extractEmployeeId(req);
	if (!employeeId) { res.status(401).json({ error: "Unauthorized", details: "Missing employee identity" }); return; }

	const granted = req.auth?.actions ?? [];
	const isAdmin = callerIsAdmin(req);
	const isOwner = await callerIsSuperadmin(req);

	// Mirrors the guards on /roles/assign and /roles/remove: reversing a role
	// change must not become a back door around the privilege-escalation rules
	// those routes enforce. Only the roles the diff actually touches are checked.
	const roleGuard = (kind: string, envelope: { before: Record<string, unknown>; after: Record<string, unknown> }): true | string => {
		if (kind !== "role_assign" && kind !== "role_remove") {return true;}
		const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
		const before = list(envelope.before.roles);
		const after = list(envelope.after.roles);
		const touched = [...before, ...after].filter((r) => !before.includes(r) || !after.includes(r));
		if (touched.some((r) => isAdminRoleName(r)) && !isOwner) {
			return "Only the owner (super-admin) can undo a change to the admin role.";
		}
		if (touched.some((r) => isPrivilegedRoleName(r)) && !isAdmin) {
			return "Only an admin can undo a change to the admin or manager role.";
		}
		return true;
	};

	const permitted = (actionId: string, kind: string, envelope: { before: Record<string, unknown>; after: Record<string, unknown> }): true | string => {
		if (!granted.includes("*") && !granted.includes(actionId)) {
			return "You do not have permission for the action you are trying to undo.";
		}
		return roleGuard(kind, envelope);
	};

	try {
		const result = await PerformAuditUndo(restaurantId, logId, employeeId, permitted);
		if (result.ok) {
			res.json({ success: true, undo_log_id: result.undo_log_id, restored: result.restored });
			return;
		}
		const status = result.code === "not_found"
			? 404
			: result.code === "failed"
				? (result.required_action_id ? 403 : 400)
				: (["already_undone", "superseded", "target_gone", "bill_settled"].includes(result.code) ? 409 : 400);
		res.status(status).json({ error: result.message, reason: result.code });
	} catch (err) {
		logger.error({ err }, "audit_undo_failed");
		res.status(500).json({ error: "Unable to undo this action" });
	}
});
}
