/**
 * Which waiter is assigned to which table.
 */
import type { Express, Request, Response } from "express";
import { AssignTableToEmployee, GetTableAssignments, UnassignTableEmployee } from "../database_supabase.js";
import { logger } from "../observability.js";
import { enforceRoles, validateAction } from "./_shared.js";


export function registerTableAssignmentRoutes(app: Express): void {

app.get("/table-assignments", validateAction("f88657ce-0d67-4cd6-aae1-765dec10cd98"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "employee"]);
	if (!auth) {
		return;
	}

	try {
		const assignments = await GetTableAssignments(auth.restaurantId);
		res.json(assignments);
	} catch (error) {
		logger.error({ err: error }, "get_table_assignments_failed");
		res.status(500).json({ error: "Unable to fetch table assignments" });
	}
});

app.post("/table-assignments/assign", validateAction("faf2745b-580c-4529-bbe1-033200cbcf67"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin"]);
	if (!auth) {
		return;
	}

	const tableName = typeof req.body?.table_name === "string" ? req.body.table_name.trim() : "";
	const employeeId = typeof req.body?.employeeId === "string" ? req.body.employeeId.trim() : "";
	if (!tableName || !employeeId) {
		res.status(400).json({ error: "table_name and employeeId are required" });
		return;
	}

	try {
		const assigned = await AssignTableToEmployee(auth.restaurantId, tableName, employeeId);
		res.json(assigned);
	} catch (error: any) {
		logger.error({ err: error }, "assign_table_employee_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to assign table") });
	}
});

app.post("/table-assignments/unassign", validateAction("e97a2c5d-d83d-48e3-bdea-ef0c3a1c51a7"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin"]);
	if (!auth) {
		return;
	}

	const tableName = typeof req.body?.table_name === "string" ? req.body.table_name.trim() : "";
	if (!tableName) {
		res.status(400).json({ error: "table_name is required" });
		return;
	}

	try {
		const removed = await UnassignTableEmployee(auth.restaurantId, tableName);
		if (!removed) {
			res.status(404).json({ error: "Table assignment not found" });
			return;
		}
		res.json({ success: true });
	} catch (error: any) {
		logger.error({ err: error }, "unassign_table_employee_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to unassign table") });
	}
});
}
