import 'dotenv/config';
import type { NextFunction, Request, Response } from "express";
import express from "express";
import {
	AddBooking,
	GetBookingsInRange,
	AddCustomer,
	AddEmailToCustomer,
	AddTable,
	RemoveTable,
	OccupyTable,
	UpdateTableCovers,
	ReleaseTable,
	GetTableStatus,
	GetBillForTable,
	GetBookingsAfterTime,
	HasActiveBooking,
	GetCustomerAndBookings,
	GetCustomerId,
	GetTables,
	UpdateBookingStatus,
	DeleteBooking,
	AssignTableToBooking,
	// AddAuditLogEntryLegacy,
	Audit_log_category,
	GetEmployeeDetailsFromEmpID,
	AddAuditLogEntry,
	GetAuditLogs,
	GetRestaurantUserRole,
	EnsureRestaurantSeed,
	AllocateBestTable,
	AddFeedbackEntry,
	GetFeedbackEntries,
	GetFeedbackSummary,
	GetRestaurantUsers,
	AddRestaurantUser,
	DeleteRestaurantUser,
	CheckDatabaseHealth,
	GetInventoryItems,
	UpsertInventoryItem,
	DeleteInventoryItem,
	GetMenuItems,
	GetMenuCategories,
	UpsertMenuItem,
	EnsureMenuCategory,
	DeleteMenuCategory,
	SaveMenuItems,
	GetOrders,
	AddOrder,
	DeleteOrder,
	GetMonthlyApcInsights,
	GetRestaurantProfile,
	UpdateRestaurantProfile,
	GetOutletDefaultTax,
	GetRestaurantLogo,
	GetRestaurantLogoRaw,
	GetBillByOrder,
	UpdateOutletDefaultTax,
	AddBill,
	ReplaceBill,
	UpdateBillStatusByOrder,
	ConfirmBillPaymentByWaiter,
	ApproveBillPaymentByAdmin,
	CloseBillByOrder,
	GetRoles,
	GetActions,
	ValidationError,
	CreateRole,
	DeleteRole,
	AssignRoleToEmployee,
	RemoveRoleFromEmployee,
	GetTableAssignments,
	AssignTableToEmployee,
	UnassignTableEmployee,
	GetParkingBays,
	AddParkingBay,
	UpdateParkingBay,
	DeleteParkingBay,
	SetParkingBayCurrent,
	GetValetVehicleStates,
	CreateValetVehicleState,
	GetValetVehicleState,
	UpdateValetVehicleState,
	UpdateValetVehicleBay,
	GetValetVehicleMetaByBookingIds,
	UpsertValetVehicleMeta,
	AuthenticateRestaurantEmployee,
	CORE_ROLES,
	getRestaurantIdFromUsername
} from "./database_supabase.js";
import {
	OPENAI_REALTIME_MODEL,
	checkAvailabilityForRequest,
	createReceptionSession,
	createReservationForRequest,
	getRestaurantKnowledgeSnapshot,
} from "./realtime_reception_agent.js";
import { initRealtime, emitRestaurant, emitOutlet } from "./realtime.js";
import { createServer } from "http";
const app = express();
const port = process.env.PORT || 3001;

// Python feedback service URL. Use container host (PY_SERVER_URL) when set,
// otherwise fall back to localhost with optional port override.
const PY_SERVER_URL = process.env.PY_SERVER_URL ?? `http://127.0.0.1:${process.env.PY_SERVER_PORT ?? "8000"}`;

function log(req: Request, res: Response, next: NextFunction) {
	console.log(req);
	next();
}
// app.use(log);

function validate(req: Request, res: Response, next: NextFunction) {
	next();
	// return res.status(400).json({ error: "Auth failed" });
}

function validateAction(expectedUUID: string) {
	return (req: Request, res: Response, next: NextFunction) => {
		const reqUserActionList = extractActionList(req);
		if (!reqUserActionList.includes(expectedUUID) && !reqUserActionList.includes("*")) {
			return res.status(403).json({ error: "Action not permitted" });
		}
		next();
	};
}

async function log_audit(req: Request, action_id: string, action_description: string, category: Audit_log_category, additional_details?: Record<string, any>) {
	const employeeID = extractEmployeeId(req);
	if (!employeeID) throw new Error("Cannot log audit entry without employee ID");
	const emp_dets = await GetEmployeeDetailsFromEmpID(employeeID);
	if (!emp_dets) throw new Error("Employee details not found for ID");
	await AddAuditLogEntry(
		emp_dets.res_id,
		emp_dets.outlet_id,
		employeeID,
		action_id,
		action_description,
		category,
		additional_details
	);
}


type AppRole = "admin" | "employee" | "valet" | "waiter" | "cashier" | "captain" | "manager";

function normalizeRole(rawRole: unknown): AppRole | null {
	if (typeof rawRole !== "string") {
		return null;
	}

	const lowered = rawRole.trim().toLowerCase();
	if (lowered === "admin" || lowered === "employee" || lowered === "valet" || lowered === "waiter" || lowered === "cashier" || lowered === "captain" || lowered === "manager") {
		return lowered;
	}

	return null;
}

function getFeedbackCategoryLabel(category: number | string): string {
	if (typeof category === "number") {
		switch (category) {
			case 1:
				return "initial greeting";
			case 2:
				return "waiter service";
			case 3:
				return "food";
			case 4:
				return "ambience";
			case 5:
				return "restroom";
			case 6:
				return "valet parking";
			default:
				return "this question";
		}
	}

	const normalized = category.trim().toLowerCase();
	if (!normalized) {
		return "this question";
	}
	if (normalized === "1") return "initial greeting";
	if (normalized === "2") return "waiter service";
	if (normalized === "3") return "food";
	if (normalized === "4") return "ambience";
	if (normalized === "5") return "restroom";
	if (normalized === "6") return "valet parking";
	return normalized.replace(/_/g, " ");
}

function normalizeFollowUpPromptForCategory(prompt: string, categoryLabel: string, rate: number): string {
	const compact = prompt.replace(/\s+/g, " ").trim();
	if (!compact) {
		return `You rated ${categoryLabel} ${rate}/5. Could you share what influenced that rating?`;
	}

	let next = compact;
	const replacement = categoryLabel === "food" ? "food" : categoryLabel;

	if (categoryLabel !== "food") {
		next = next.replace(/\bthe\s+food\b/gi, `the ${replacement}`);
		next = next.replace(/\bfood\b/gi, replacement);
	}

	next = next.replace(/\bthe\s+this\s+question\b/gi, "this question");
	next = next.replace(/\bthe\s+1\b/gi, "this question");
	return next;
}

function extractRestaurantId(req: Request): string | null {
	const headerValue = req.headers["x-restaurant-id"];
	const headerId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
	if (typeof headerId === "string" && headerId.trim().length > 0) {
		return headerId.trim();
	}

	const queryValue = req.query.restaurantId;
	const queryId = Array.isArray(queryValue) ? queryValue[0] : queryValue;
	if (typeof queryId === "string" && queryId.trim().length > 0) {
		return queryId.trim();
	}

	const body = req.body as Record<string, unknown> | undefined;
	const bodyValue = body?.restaurantId;
	if (typeof bodyValue === "string" && bodyValue.trim().length > 0) {
		return bodyValue.trim();
	}

	return null;
}

function extractRestaurantUsername(req: Request): string | null {
	const headerValue = req.headers["x-restaurant-username"];
	const headerId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
	if (typeof headerId === "string" && headerId.trim().length > 0) {
		return headerId.trim();
	}

	const queryValue = req.query.restaurantUsername;
	const queryId = Array.isArray(queryValue) ? queryValue[0] : queryValue;
	if (typeof queryId === "string" && queryId.trim().length > 0) {
		return queryId.trim();
	}

	const body = req.body as Record<string, unknown> | undefined;
	const bodyValue = body?.restaurantUsername;
	if (typeof bodyValue === "string" && bodyValue.trim().length > 0) {
		return bodyValue.trim();
	}

	return null;
}

function extractEmployeeId(req: Request): string | null {
	const headerValue = req.headers["x-employee-id"];
	const headerId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
	if (typeof headerId === "string" && headerId.trim().length > 0) {
		return headerId.trim();
	}

	const queryValue = req.query.employeeId;
	const queryId = Array.isArray(queryValue) ? queryValue[0] : queryValue;
	if (typeof queryId === "string" && queryId.trim().length > 0) {
		return queryId.trim();
	}

	const body = req.body as Record<string, unknown> | undefined;
	const bodyValue = body?.employeeId;
	if (typeof bodyValue === "string" && bodyValue.trim().length > 0) {
		return bodyValue.trim();
	}

	return null;
}

function extractActionList(req: Request): string[] {
	const headerValue: string | string[] | undefined = req.headers["x-action-list"];
	if (!headerValue) {
		throw new Error("Missing X-Action-List header by : " + req.url + "got headers: " + JSON.stringify(req.headers));
	}
	if (Array.isArray(headerValue)) {
		return headerValue;
	}
	return headerValue.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function normalizeRestaurantSlug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function resolveRoleForRequest(req: Request, restaurantId: string): Promise<AppRole | null> {
	// Allow an explicit role header to be used for service-to-service calls or when
	// an employee id is not available (e.g. onboarding flows). This is intentionally
	// permissive for local/dev convenience but still prefers a real employee id when present.
	const headerRole = (Array.isArray(req.headers['x-user-role']) ? req.headers['x-user-role'][0] : req.headers['x-user-role']) as string | undefined;
	if (typeof headerRole === 'string' && headerRole.trim()) {
		const lowered = headerRole.trim().toLowerCase();
		if (lowered === 'admin' || lowered === 'employee' || lowered === 'valet' || lowered === 'waiter' || lowered === 'cashier' || lowered === 'captain' || lowered === 'manager') {
			return lowered as AppRole;
		}
	}

	const employeeId = extractEmployeeId(req);
	if (!employeeId) {
		console.debug("resolveRoleForRequest: missing employeeId", { restaurantId });
		return null;
	}

	const roleFromRestaurant = await GetRestaurantUserRole(restaurantId, employeeId);
	return roleFromRestaurant ?? null;
}

async function enforceRoles(
	req: Request,
	res: Response,
	allowedRoles: readonly AppRole[],
): Promise<{ restaurantId: string; role: AppRole; outletId: string } | null> {
	const restaurantId = extractRestaurantId(req);
	const outletId = extractOutletId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return null;
	}

	const role = await resolveRoleForRequest(req, restaurantId);
	if (!role) {
		res.status(401).json({
			error: "Unauthorized",
			details: "Missing or invalid employee identity",
		});
		return null;
	}

	if (!allowedRoles.includes(role)) {
		res.status(403).json({ error: "Forbidden", requiredRoles: allowedRoles });
		return null;
	}

	return { restaurantId, role, outletId };
}

async function enforceRolesIgnoreOutletID(
	req: Request,
	res: Response,
	allowedRoles: readonly AppRole[],
): Promise<{ restaurantId: string; role: AppRole; } | null> {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return null;
	}

	const role = await resolveRoleForRequest(req, restaurantId);
	if (!role) {
		res.status(401).json({
			error: "Unauthorized",
			details: "Missing or invalid employee identity",
		});
		return null;
	}

	if (!allowedRoles.includes(role)) {
		res.status(403).json({ error: "Forbidden", requiredRoles: allowedRoles });
		return null;
	}

	return { restaurantId, role };
}

function extractOutletId(req: Request): string {
	const headerValue = req.headers["x-outlet-id"];
	const headerId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
	if (typeof headerId === "string" && headerId.trim().length > 0) {
		return headerId.trim();
	}

	const queryValue = req.query.outletId;
	const queryId = Array.isArray(queryValue) ? queryValue[0] : queryValue;
	if (typeof queryId === "string" && queryId.trim().length > 0) {
		return queryId.trim();
	}

	const body = req.body as Record<string, unknown> | undefined;
	const bodyValue = body?.outletId;
	if (typeof bodyValue === "string" && bodyValue.trim().length > 0) {
		return bodyValue.trim();
	}

	throw new Error("Missing outletId");
}

const allowedOrigins = new Set([
	"http://localhost:9002",
	"http://localhost:3000",
	"http://localhost:3001",
	"http://localhost:5173",
	"http://localhost:9003",
	"https://nw39853t-9002.inc1.devtunnels.ms", // TUNNEL URL goes here!!!!!
]);

app.use((req: Request, res: Response, next: NextFunction) => {
	const origin = req.headers.origin;
	if (origin && (allowedOrigins.has(origin) || origin.endsWith('.up.railway.app'))) {
		res.header("Access-Control-Allow-Origin", origin);
	}
	res.header(
		"Access-Control-Allow-Headers",
		"Content-Type,X-Restaurant-Id,X-Employee-Id,X-User-Role,X-Outlet-Id,X-Action-List,X-Restaurant-Username",
	);
	res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
	if (req.method === "OPTIONS") {
		res.sendStatus(204);
		return;
	}
	next();
});

app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));

app.get('/core-roles', validateAction("17ba6407-b703-4403-ab59-13235966053f"), async (req: Request, res: Response) => {
	try {
		await log_audit(req, "17ba6407-b703-4403-ab59-13235966053f", "Fetched core roles", Audit_log_category.Roles);
		const rows = Object.keys(CORE_ROLES).map((role) => ({ role, actions: CORE_ROLES[role as keyof typeof CORE_ROLES] }));
		res.json(rows);
	} catch (err: any) {
		console.error('error_fetching_core_roles', err);
		res.status(500).json({ error: 'Unable to fetch core roles' });
	}
});

// Lightweight health endpoint for readiness/liveness checks
app.get("/", (_req: Request, res: Response) => {
	res.json({
		service: "restaurant-backend",
		status: "ok",
		docs: {
			health: "/health",
			bookings: "/get-bookings",
			tables: "/get-tables",
			customers: "/get-customers",
		},
	});
});

app.get("/health", async (_req: Request, res: Response) => {
	const result: any = { status: "ok", uptime: process.uptime(), time: new Date().toISOString() };
	try {
		const ok = await CheckDatabaseHealth();
		result.database = { ok, provider: "supabase-postgres" };
		if (!ok) {
			result.status = "degraded";
		}
	} catch (err: any) {
		result.database = { ok: false, error: String(err?.message ?? err), provider: "supabase-postgres" };
		result.status = "degraded";
	}
	res.json(result);
});

app.post("/auth/register-restaurant", validate, async (req: Request, res: Response) => {
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
		console.error("register_restaurant_failed", error);
		res.status(500).json({ error: "Unable to register restaurant" });
	}
});

app.post("/auth/employee-login", validate, async (req: Request, res: Response) => {
	const body = (req.body ?? {}) as Record<string, unknown>;
	const employeeUsername = typeof body.employeeUsername === "string" ? body.employeeUsername.trim() : "";
	const password = typeof body.password === "string" ? body.password : "";
	const restaurantIdRaw = typeof body.restaurantId === "string" ? body.restaurantId.trim() : "";
	const restaurantName = typeof body.restaurantName === "string" ? body.restaurantName.trim() : "";

	if (!employeeUsername || !password || !restaurantName) {
		res.status(400).json({
			error: "employeeUsername, password, and restaurantName are required",
		});
		return;
	}

	const restaurantUsername = restaurantIdRaw || normalizeRestaurantSlug(restaurantName);

	try {
		const user = await AuthenticateRestaurantEmployee(restaurantUsername, employeeUsername, password);
		if (!user) {
			res.status(401).json({ error: "Invalid employee ID or password." });
			return;
		}
		res.json({
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
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("Unknown restaurant id")) {
			res.status(404).json({ error: "Invalid restaurant name." });
			return;
		}

		console.error("employee_login_failed", error);
		res.status(500).json({ error: "Unable to sign in." });
	}
});

app.get("/reception/info", (_req: Request, res: Response) => {
	const snapshot = getRestaurantKnowledgeSnapshot();
	res.json(snapshot);
});

app.post("/reception/check-availability", async (req: Request, res: Response) => {
	const { reservationDate, reservationTime, partySize } = req.body ?? {};
	if (!reservationDate || !reservationTime || typeof partySize !== "number") {
		res.status(400).json({ error: "reservationDate, reservationTime, and partySize are required" });
		return;
	}

	try {
		const result = await checkAvailabilityForRequest({
			reservationDate: String(reservationDate),
			reservationTime: String(reservationTime),
			partySize: Number(partySize),
		});
		res.json(result);
	} catch (error) {
		console.error("check_availability_failed", error);
		res.status(500).json({ error: "Unable to check availability" });
	}
});

app.post("/reception/create-reservation", async (req: Request, res: Response) => {
	const payload = req.body ?? {};
	const required = ["guestName", "contactNumber", "partySize", "reservationDate", "reservationTime"] as const;
	const missing = required.filter((key) => !payload[key]);
	if (missing.length > 0) {
		res.status(400).json({ error: `Missing fields: ${missing.join(", ")}` });
		return;
	}

	try {
		const result = await createReservationForRequest({
			guestName: String(payload.guestName),
			contactNumber: String(payload.contactNumber),
			partySize: Number(payload.partySize),
			reservationDate: String(payload.reservationDate),
			reservationTime: String(payload.reservationTime),
			tablePreference:
				payload.tablePreference === null || payload.tablePreference === undefined
					? null
					: String(payload.tablePreference),
			specialRequests:
				payload.specialRequests === null || payload.specialRequests === undefined
					? null
					: String(payload.specialRequests),
		});
		res.json(result);
	} catch (error) {
		console.error("create_reservation_failed", error);
		res.status(500).json({ error: "Unable to create reservation" });
	}
});

app.post("/realtime/session", async (_req: Request, res: Response) => {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		res.status(500).json({ error: "OPENAI_API_KEY is not configured on the server" });
		return;
	}

	try {
		const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: OPENAI_REALTIME_MODEL,
				voice: "alloy",
			}),
		});
		const dataUnknown = await response.json();
		const data = (dataUnknown ?? {}) as Record<string, unknown>;
		if (!response.ok) {
			res.status(response.status).json(data);
			return;
		}
		res.json(data);
	} catch (error) {
		console.error("realtime_session_failed", error);
		res.status(500).json({ error: "Unable to create realtime session" });
	}
});

async function GetCustomerIdOrCreateCustomer(
	restaurantId: string,
	name: string,
	number: string,
	email?: string | undefined,
): Promise<string | null> {
	const normalizedName = name.trim();
	const normalizedNumber = number.trim();
	let customerId = await GetCustomerId(restaurantId, normalizedName, normalizedNumber);

	if (!customerId) {
		const createdCustomer = await AddCustomer(
			restaurantId,
			normalizedName,
			normalizedNumber,
			email,
		);
		customerId = createdCustomer._id;
	}

	if (customerId && email) {
		await AddEmailToCustomer(restaurantId, customerId, email);
	}

	if (!customerId) {
		return null;
	}

	return String(customerId);
}

/*
	Needs request body as
	{
	   "customer": {
		   "name": "Example",
		   "number": "+91 9923523232", // try keeping all in the same format whatever the format is
		   "email": "k@gmail.com" // Optional
	   }
	}
	returns the customer_id if you want to store it somewhere
*/

app.post("/add-customer", validateAction("daf1d71f-2b37-4cd1-b951-28fece7719cd"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	let customer = req.body.customer;
	if (!(customer.name && customer.number)) {
		res.status(400).json({ error: "Missing required fields" });
		return;
	}

	let cust_id = await GetCustomerIdOrCreateCustomer(
		restaurantId,
		customer.name,
		customer.number,
		customer.email,
	);

	try {
		await log_audit(req, "daf1d71f-2b37-4cd1-b951-28fece7719cd", `Created or linked customer ${customer.name}`, Audit_log_category.Customer, { customer_id: cust_id });
	} catch (err) {
		console.warn('log_audit add-customer failed', err);
	}

	res.send(cust_id);
});

/*
	Needs request body as
	{
	   "table": {
		   "name": "T1",
		   "capacity": 4 // Optional
	   }
	}
	returns the table_name if you want to store it somewhere
*/
app.post("/add-table", validateAction("194ce6ee-b867-4be3-b5f0-48c28ce0a81b"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	let table = req.body.table;
	if (!table.name) {
		res.status(400).json({ error: "Missing required fields" });
		return;
	}

	let table_name: string | null = null;
	try {
		const created = await AddTable(
			restaurantId,
			table.name,
			table.capacity !== undefined ? parseInt(table.capacity) : undefined,
		);
		table_name = created.table_name;
	} catch (error) {
		console.log(error);
		table_name = null;
	}
	if (!table_name) {
		res.status(400).json({ error: "Table exists" });
		return;
	}

	try {
		emitRestaurant(restaurantId, "table:added", { table_name, capacity: table.capacity });
	} catch (err) {
		console.warn("emit table:added failed", err);
	}

	try {
		await log_audit(req, "194ce6ee-b867-4be3-b5f0-48c28ce0a81b", `Added table ${table_name}`, Audit_log_category.Tables, { capacity: table.capacity });
	} catch (err) {
		console.warn('log_audit add-table failed', err);
	}

	res.send(table_name);
});

app.delete("/table/:name", validateAction("5777c4aa-29df-4ea1-9c45-c1038d25f746"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const rawName = req.params.name;
	const tableName = typeof rawName === "string" ? rawName.trim() : "";
	if (!tableName) {
		res.status(400).json({ error: "Invalid table name" });
		return;
	}

	const deleted = await RemoveTable(restaurantId, tableName);
	if (!deleted) {
		res.status(404).json({ error: "Table not found" });
		return;
	}

	try {
		emitRestaurant(restaurantId, "table:deleted", { table_name: tableName });
	} catch (err) {
		console.warn("emit table:deleted failed", err);
	}

	try {
		await log_audit(req, "5777c4aa-29df-4ea1-9c45-c1038d25f746", `Removed table ${tableName}`, Audit_log_category.Tables, { table_name: tableName });
	} catch (err) {
		console.warn('log_audit delete-table failed', err);
	}

	res.status(204).send();
});

// Occupy a table (mark as occupied and set number of covers)
app.post("/occupy-table", validateAction("090ea8d4-e348-4e1b-9723-11131a73a085"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const tableName = typeof body?.table_name === 'string' ? body.table_name.trim() : '';
	const numCovers = typeof body?.num_covers === 'number' ? body.num_covers : 1;

	if (!tableName) {
		res.status(400).json({ error: "table_name is required" });
		return;
	}

	try {
		const result = await OccupyTable(restaurantId, tableName, numCovers);
		try {
			await log_audit(req, "090ea8d4-e348-4e1b-9723-11131a73a085", `Occupied table ${tableName} with ${numCovers} covers`, Audit_log_category.Tables, { table_name: tableName, num_covers: numCovers });
		} catch (err) {
			console.warn('log_audit occupy-table failed', err);
		}
		res.json(result);
	} catch (error: any) {
		console.error("occupy_table_failed", error);
		res.status(400).json({ error: String(error?.message ?? "Unable to occupy table") });
	}
});

// Update number of covers at a table
app.patch("/table-covers", validateAction("090ea8d4-e348-4e1b-9723-11131a73a085"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const tableName = typeof body?.table_name === 'string' ? body.table_name.trim() : '';
	const numCovers = typeof body?.num_covers === 'number' ? body.num_covers : 1;

	if (!tableName) {
		res.status(400).json({ error: "table_name is required" });
		return;
	}

	try {
		const result = await UpdateTableCovers(restaurantId, tableName, numCovers);
		try {
			await log_audit(req, "090ea8d4-e348-4e1b-9723-11131a73a085", `Updated table ${tableName} covers to ${numCovers}`, Audit_log_category.Tables, { table_name: tableName, num_covers: numCovers });
		} catch (err) {
			console.warn('log_audit table-covers failed', err);
		}
		res.json(result);
	} catch (error: any) {
		console.error("table_covers_failed", error);
		res.status(400).json({ error: String(error?.message ?? "Unable to update table covers") });
	}
});

// Release/unoccupy a table
app.post("/release-table", validateAction("090ea8d4-e348-4e1b-9723-11131a73a085"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const tableName = typeof body?.table_name === 'string' ? body.table_name.trim() : '';

	if (!tableName) {
		res.status(400).json({ error: "table_name is required" });
		return;
	}

	try {
		const result = await ReleaseTable(restaurantId, tableName);
		try {
			await log_audit(req, "090ea8d4-e348-4e1b-9723-11131a73a085", `Released table ${tableName}`, Audit_log_category.Tables, { table_name: tableName });
		} catch (err) {
			console.warn('log_audit release-table failed', err);
		}
		res.json(result);
	} catch (error: any) {
		console.error("release_table_failed", error);
		res.status(400).json({ error: String(error?.message ?? "Unable to release table") });
	}
});

// Get table status
app.get("/table-status", validateAction("090ea8d4-e348-4e1b-9723-11131a73a085"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const tableName = typeof req.query.table_name === 'string' ? req.query.table_name.trim() : '';

	if (!tableName) {
		res.status(400).json({ error: "table_name query parameter is required" });
		return;
	}

	try {
		const result = await GetTableStatus(restaurantId, tableName);
		if (!result) {
			res.status(404).json({ error: "Table not found" });
			return;
		}
		res.json(result);
	} catch (error: any) {
		console.error("get_table_status_failed", error);
		res.status(400).json({ error: String(error?.message ?? "Unable to get table status") });
	}
});

// Get bill for a table (returns the current open bill and all associated orders)
app.get("/bill-for-table", validateAction("98b10bde-802d-4a5b-a726-53a826424f79"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const tableName = typeof req.query.table_name === 'string' ? req.query.table_name.trim() : '';

	if (!tableName) {
		res.status(400).json({ error: "table_name query parameter is required" });
		return;
	}

	try {
		const result = await GetBillForTable(restaurantId, tableName);
		if (!result) {
			res.status(404).json({ error: "No open bill found for this table" });
			return;
		}
		res.json(result);
	} catch (error: any) {
		console.error("get_bill_for_table_failed", error);
		res.status(400).json({ error: String(error?.message ?? "Unable to get bill for table") });
	}
});

/*
Needs request body as
{
	// creates customer if the name+number does not exist
	"customer": {
	   "name": "Jhon",
	   "number": "9972955566",
	   "email": "example@gmail.com" //optional
   },
   // Table must exist
   "booking": {
		"table_name": "T1",
		"date": "YYYY-MM-DDThh:mm:ssTZD"
		"duration": "30" // in minutes
		"number_of_people": "3"
		"source": "EasyDiner" //Optional
   }
}
returns the booking id
*/
app.post("/add-booking", validateAction("3ec33182-ceb4-4d07-ac7e-84214adcf104"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	let customer = req.body.customer;
	if (!(customer.name && customer.number)) {
		res.status(400).json({ error: "Missing customer field(s)" });
		return;
	}

	let booking_request = req.body.booking;
	if (
		!(
			booking_request &&
			booking_request.date &&
			booking_request.duration &&
			booking_request.number_of_people
		)
	) {
		res.status(400).json({ error: "Missing booking field(s)" });
		return;
	}
	let cust_id = await GetCustomerIdOrCreateCustomer(
		restaurantId,
		customer.name,
		customer.number,
		customer.email,
	);
	if (cust_id == null) {
		res.status(400).json({
			error: "Something went wrong in creating/getting customer id",
		});
		return;
	}

	let date: Date = new Date(booking_request.date);
	if (isNaN(date.getTime())) {
		res.status(400).json({ error: "Time is in the wrong format" });
		return;
	}

	const durationMinutes = Number.parseInt(booking_request.duration, 10);
	if (!Number.isFinite(durationMinutes)) {
		res.status(400).json({ error: "Duration must be a valid number" });
		return;
	}

	const partySize = Number.parseInt(booking_request.number_of_people, 10);
	if (!Number.isFinite(partySize)) {
		res.status(400).json({ error: "number_of_people must be a valid number" });
		return;
	}

	let booking;
	let tableName: string | null = (booking_request.table_name ?? null);
	try {
		if (!tableName) {
			// Auto-allocate best fitting table if none provided
			try {
				const allocated = await AllocateBestTable(restaurantId, date, durationMinutes, partySize);
				if (allocated) {
					tableName = allocated;
				}
			} catch (allocErr) {
				console.warn("table_allocation_failed", { restaurantId, error: allocErr });
			}
			if (!tableName) {
				return res.status(409).json({ error: "No table available for the requested time window", reason: "no_table_available" });
			}
		}
		booking = await AddBooking(
			restaurantId,
			cust_id,
			date,
			durationMinutes,
			partySize,
			tableName,
			booking_request.source,
			booking_request.status ?? "Confirmed",
			booking_request.from,
			booking_request.notes ?? booking_request.additional_information ?? null,
		);
	} catch (error) {
		res.status(400).json({ error: "Oops something went wrong" });
		return;
	}
	const booking_id = String(booking._id);

	try {
		emitRestaurant(restaurantId, "booking:created", { booking_id, table_name: tableName });
	} catch (err) {
		console.warn("emit booking:created failed", err);
	}

	try {
		await log_audit(req, "3ec33182-ceb4-4d07-ac7e-84214adcf104", `Created booking for customer ${customer.name} at ${booking_request.date}`, Audit_log_category.Bookings, { booking_id, table_name: tableName });
	}
	catch (err) {
		console.warn('log_audit add-booking failed', err);
	}
	res.json({ booking_id, table_name: tableName });
});

function FoldedTables(table: any[]): any[][] {
	if (table.length == 0) {
		return [];
	}

	let min: number = table[0]["capacity"];
	let max: number = table[table.length - 1]["capacity"];

	let folded_tables = [];

	let curr_index: number = 0;
	for (let capacity = min; capacity <= max; capacity++) {
		let cur_table = [];
		let push = false;
		while (
			table.length > curr_index &&
			table[curr_index]["capacity"] == capacity
		) {
			cur_table.push(table[curr_index]);
			curr_index += 1;
			push = true;
		}
		if (push) {
			folded_tables.push(cur_table);
		}
	}

	return folded_tables;
}

/*
Returns tables in a 2d array in ascending order of capacity.
[
	[
		{
			"table_name": "T1",
			"capacity": 1,
			"booked": true
		},
		{
			"table_name": "T2",
			"capacity": 1
			"booked": true
		},
	],
	[
		{
			"table_name": "T6",
			"capacity": 3
			"booked": true
		},
		{
			"table_name": "T7",
			"capacity": 3
			"booked": true
		}
	],
	[
		{
			"table_name": "T10",
			"capacity": 6
			"booked": true
		}
	]
]
*/

app.get("/get-tables", validateAction("090ea8d4-e348-4e1b-9723-11131a73a085"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const timeQuery = Array.isArray(req.query.time) ? req.query.time[0] : req.query.time;
	const requestedTime = typeof timeQuery === "string" ? timeQuery : undefined;
	try {
		const tables = await GetTables(restaurantId, requestedTime);
		try {
			await log_audit(req, "090ea8d4-e348-4e1b-9723-11131a73a085", `Fetched tables`, Audit_log_category.Tables);
		} catch (err) {
			console.warn('log_audit get-tables failed', err);
		}
		res.send(tables ?? []);
	} catch (e) {
		res.status(400).send({ error: "Oops something went wrong" });
		return;
	}
});

function IsActiveBooking(booking: any, time: Date): boolean {
	let booking_start = new Date(booking.booking_date_time).getTime();
	let booking_end =
		new Date(booking_start).getTime() + booking.duration_mins * 60 * 1000;

	if (booking_start <= time.getTime() && time.getTime() <= booking_end) {
		return true;
	}

	return false;
}

/*
Gets all bookings that have not yet completed 
If needed can be modified to get bookings after a certain time very easily
Returns in this format
[
	{
		"booking_id": 1, //database stuff
		"customer_id": 1, //database stuff
		"customer_name": "Jhon", //name
		"table_name": "T3",
		"booking_date_time": "2025-08-21T23:30:34.036Z", //time of booking ISO string
		"duration_mins": 60,
		"number_of_people": 3,
		"source": null // source of the booking
		"active": true/false //whether or not the booking is currently happening
	}
]
 */
app.get("/get-bookings", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	let bookings;
	const time = new Date();
	const timeQuery = Array.isArray(req.query.time) ? req.query.time[0] : req.query.time;
	const requestedTime = typeof timeQuery === "string" ? timeQuery : undefined;

	try {
		bookings = await GetBookingsAfterTime(restaurantId, requestedTime);
	} catch (error) {
		console.log(error);
		res.status(400).send({ error: "Oops something went wrong" });
		return;
	}
	if (bookings == null) {
		res.status(400).send({ error: "Time is invalid" });
		return;
	}

	res.send(
		bookings.map((booking) => ({
			...booking,
			active: IsActiveBooking(booking, time),
		})),
	);
});

app.get("/valet-info", validateAction("9e37297d-408b-446d-a51b-7892ad216b7d"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	try {
		const [records, bays] = await Promise.all([
			GetValetVehicleStates(auth.restaurantId, auth.outletId),
			GetParkingBays(auth.restaurantId, auth.outletId),
		]);
		const metaByBookingId = await GetValetVehicleMetaByBookingIds(
			auth.restaurantId,
			records.map((row) => row.booking_id),
			auth.outletId,
		);

		const bayById = new Map((bays ?? []).map((bay) => [String(bay.Bay_id), bay.Bay_name]));
		const stateMap: Record<number, string> = {
			1: "Vehicle added",
			2: "Parked",
			3: "Request to bring car (from customer)",
			4: "Request accepted (from valet)",
			5: "Car arrived at entrance",
			6: "Customer took car",
		};

		const bookings = records.map((row) => {
			const meta = metaByBookingId[row.booking_id];
			return {
				booking_id: row.booking_id,
				customer_name: meta?.customer_name ?? undefined,
				bay_id: row.bay_id,
				bay_name: row.bay_id ? (bayById.get(String(row.bay_id)) ?? null) : null,
				booking_date_time: row.entry_time ?? undefined,
				exit_date_time: row.exit_time ?? undefined,
				status: stateMap[row.state] ?? "Vehicle added",
				active: row.state !== 6,
				number_plate: meta?.number_plate ?? undefined,
			};
		});

		try {
			await log_audit(req, "9e37297d-408b-446d-a51b-7892ad216b7d", `Viewed valet info`, Audit_log_category.Valet, { outletId: auth.outletId });
		} catch (err) {
			console.warn('log_audit valet-info failed', err);
		}

		res.json({
			role: auth.role,
			generated_at: new Date().toISOString(),
			bays,
			bookings,
		});
	} catch (error) {
		console.error("valet_info_failed", error);
		res.status(500).json({ error: "Unable to fetch valet info" });
	}
});

// (debug endpoint removed)


app.patch("/booking/:id/status", validateAction("fdeecab6-7c3a-4239-b87c-99a96f50c551"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const rawId = req.params.id;
	const status = req.body?.status;
	const bookingId = typeof rawId === "string" ? rawId.trim() : "";
	if (!status || !bookingId) {
		res.status(400).json({ error: "Missing or invalid status/booking id" });
		return;
	}

	const updated = await UpdateBookingStatus(auth.restaurantId, bookingId, status);
	if (!updated) {
		res.status(404).json({ error: "Booking not found" });
		return;
	}

	try {
		emitRestaurant(auth.restaurantId, "booking:status_updated", { booking_id: bookingId, status });
	} catch (err) {
		console.warn("emit booking:status_updated failed", err);
	}

	try{
		await log_audit(req, "fdeecab6-7c3a-4239-b87c-99a96f50c551", `Updated booking status to ${status} for booking ${bookingId}`, Audit_log_category.Bookings, { booking_id: bookingId, status });
	}
	catch(err){
		console.warn("log_audit booking-status-update failed", err);
	}

	res.json({ success: true });
});

app.post("/bills", validateAction("9186e53e-0fda-4ec8-ad20-2f9feaadb77f"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = (req.body ?? {}) as Record<string, unknown>;
	const order_id = typeof body.order_id === 'string' ? body.order_id.trim() : '';
	const total_amt = Number(body.total_amt ?? 0);
	const tax_breakdown = body.tax_breakdown ?? undefined;
	const emp_id = typeof body.emp_id === 'string' ? body.emp_id.trim() : null;
	const status = typeof body.status === 'number' ? body.status : Number(body.status ?? 1);
	const reason = typeof body.reason === 'string' ? body.reason.trim() : null;

	if (!order_id || !Number.isFinite(total_amt)) {
		res.status(400).json({ error: 'Missing order_id or total_amt' });
		return;
	}

	try {
		const result = await AddBill(restaurantId, { order_id, total_amt, emp_id, status, reason, tax_breakdown });
		try {
			await log_audit(req, "9186e53e-0fda-4ec8-ad20-2f9feaadb77f", `Created bill for order ${order_id}`, Audit_log_category.Bill, { order_id });
		} catch (err) {
			console.warn('log_audit add-bill failed', err);
		}
		res.status(201).json(result);
	} catch (error: any) {
		console.error('add_bill_failed', error);
		res.status(500).json({ error: String(error?.message ?? 'Unable to create bill') });
	}
});

app.post('/bills/replace', validateAction("383cc261-7e5c-4745-b16f-06a41e2ae047"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) return res.status(400).json({ error: 'Missing restaurantId' });

	const body = (req.body ?? {}) as any;
	const old_order_id = typeof body.old_order_id === 'string' ? body.old_order_id.trim() : '';
	const reason = typeof body.reason === 'string' ? body.reason.trim() : null;
	const new_order = body.new_order ?? null;
	const new_bill = body.new_bill ?? null;

	if (!old_order_id) {
		return res.status(400).json({ error: 'Missing required field: old_order_id' });
	}

	if (!new_order && !new_bill) {
		return res.status(400).json({ error: 'At least one of new_order or new_bill is required' });
	}

	try {
		const result = await ReplaceBill(restaurantId, { old_order_id, reason, new_order, new_bill });
		if (!result) return res.status(500).json({ error: 'Replace operation failed' });
		// emit realtime events for UI updates — use order:updated for in-place changes
		try {
			const payloadForEmit = {
				order_id: old_order_id,
				bill_id: result.newBillId,
				new_order_id: result.newOrderId,
			};
			emitRestaurant(restaurantId, 'order:updated', payloadForEmit);
		} catch (e) { }
		try {
			await log_audit(req, "383cc261-7e5c-4745-b16f-06a41e2ae047", `Replaced bill for order ${old_order_id}`, Audit_log_category.Bill, { old_order_id, newBillId: result.newBillId });
		} catch (err) {
			console.warn('log_audit replace-bill failed', err);
		}
		return res.status(200).json(result);
	} catch (err: any) {
		console.error('replace_bill_failed', err);
		return res.status(500).json({ error: String(err?.message ?? 'Internal') });
	}
});

app.get('/bills/order/:orderId', validateAction("98b10bde-802d-4a5b-a726-53a826424f79"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) return res.status(400).json({ error: 'Missing restaurantId' });
	const orderId = String(req.params.orderId ?? '').trim();
	if (!orderId) return res.status(400).json({ error: 'Missing orderId' });
	try {
		const bill = await GetBillByOrder(restaurantId, orderId);
		if (!bill) return res.status(404).json({ error: 'Bill not found' });
		try {
			await log_audit(req, "98b10bde-802d-4a5b-a726-53a826424f79", `Viewed bill for order ${orderId}`, Audit_log_category.Bill, { bill_id: bill.id ?? null, order_id: orderId });
		} catch (err) {
			console.warn('log_audit get-bill-by-order failed', err);
		}
		return res.json(bill);
	} catch (err) {
		console.error('get bill by order failed', err);
		return res.status(500).json({ error: 'Internal' });
	}
});

app.get('/restaurant/logo', validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) return res.status(400).json({ error: 'Missing restaurantId' });
	try {
		const logoBase64 = await GetRestaurantLogo(restaurantId);
		if (!logoBase64) return res.status(404).json({ error: 'Logo not found' });
		return res.json({ logo_base64: logoBase64 });
	} catch (err) {
		console.error('get restaurant logo failed', err);
		return res.status(500).json({ error: 'Internal' });
	}
});

app.get('/restaurant/logo/escpos', validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) return res.status(400).json({ error: 'Missing restaurantId' });
	try {
		const raw = await GetRestaurantLogoRaw(restaurantId);
		if (!raw) return res.status(404).json({ error: 'Logo not found' });

		// dynamic import of sharp so server can still start without it if optional
		let sharp: any;
		try { sharp = (await import('sharp')).default ?? (await import('sharp')) } catch (err) {
			console.error('sharp not available', err);
			return res.status(500).json({ error: 'Image processing unavailable' });
		}

		const img = sharp(raw).flatten({ background: '#ffffff' }).resize({ width: 384, withoutEnlargement: true }).threshold(128).raw();
		const { data, info } = await img.toBuffer({ resolveWithObject: true });
		const width = info.width;
		const height = info.height;
		const widthBytes = Math.ceil(width / 8);

		const bytes: number[] = [];
		for (let y = 0; y < height; y++) {
			for (let xb = 0; xb < widthBytes; xb++) {
				let byte = 0;
				for (let bit = 0; bit < 8; bit++) {
					const x = xb * 8 + bit;
					const idx = y * width + x;
					const pixel = x < width ? data[idx] : 255;
					// in thresholded raw, 0=black, 255=white
					if (pixel === 0) {
						byte |= (1 << (7 - bit));
					}
				}
				bytes.push(byte);
			}
		}

		const xL = widthBytes & 0xff;
		const xH = (widthBytes >> 8) & 0xff;
		const yL = height & 0xff;
		const yH = (height >> 8) & 0xff;

		// GS v 0 m xL xH yL yH d
		const header = Buffer.from([0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
		const payload = Buffer.from(bytes);
		const out = Buffer.concat([header, payload]);

		res.setHeader('Content-Type', 'application/octet-stream');
		res.setHeader('Content-Length', String(out.length));
		return res.send(out);
	} catch (err) {
		console.error('get restaurant escpos failed', err);
		return res.status(500).json({ error: 'Internal' });
	}
});

app.patch('/bills/order/:orderId/status', validateAction("07e364cc-f40d-46f3-b691-0f719dd38e0f"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: 'Missing restaurantId' });
		return;
	}
	const orderId = typeof req.params.orderId === 'string' ? req.params.orderId.trim() : '';
	const body = (req.body ?? {}) as Record<string, unknown>;
	const status = typeof body.status === 'number' ? body.status : Number(body.status ?? 0);

	if (!orderId || !Number.isFinite(status)) {
		res.status(400).json({ error: 'Missing orderId or status' });
		return;
	}

	try {
		await UpdateBillStatusByOrder(restaurantId, orderId, status);
		try {
			await log_audit(req, "07e364cc-f40d-46f3-b691-0f719dd38e0f", `Updated bill status for order ${orderId} to ${status}`, Audit_log_category.Bill, { order_id: orderId, status });
		} catch (err) {
			console.warn('log_audit update-bill-status failed', err);
		}
		res.json({ success: true });
	} catch (error: any) {
		console.error('update_bill_status_failed', error);
		res.status(500).json({ error: String(error?.message ?? 'Unable to update bill status') });
	}
});

app.post('/bills/order/:orderId/waiter-confirm-payment', validateAction("2393edd7-cdd9-439c-9ff3-d563d5216967"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["waiter", "admin"]);
	if (!auth) {
		return;
	}

	const orderId = typeof req.params.orderId === 'string' ? req.params.orderId.trim() : '';
	const paymentMethod = typeof req.body?.payment_method === 'string' ? req.body.payment_method.trim() : '';
	const paymentProofScreenshotUrl =
		typeof req.body?.payment_proof_screenshot_url === 'string'
			? req.body.payment_proof_screenshot_url.trim()
			: '';
	const waiterEmployeeId = extractEmployeeId(req);

	if (!orderId || !paymentMethod || !waiterEmployeeId) {
		res.status(400).json({ error: 'Missing orderId, payment_method, or employee identity' });
		return;
	}

	try {
		const result = await ConfirmBillPaymentByWaiter(
			auth.restaurantId,
			orderId,
			waiterEmployeeId,
			paymentMethod,
			paymentProofScreenshotUrl || null,
		);
		try {
			emitRestaurant(auth.restaurantId, 'bill:waiter_confirmed_payment', {
				order_id: orderId,
				payment_method: result.payment_method,
				waiter: waiterEmployeeId,
			});
		} catch {
			// ignore realtime failures
		}
		try {
			await log_audit(req, "2393edd7-cdd9-439c-9ff3-d563d5216967", `Waiter confirmed payment for order ${orderId}`, Audit_log_category.Bill, { order_id: orderId, waiter: waiterEmployeeId, payment_method: result.payment_method });
		} catch (err) {
			console.warn('log_audit waiter-confirm-payment failed', err);
		}
		res.json(result);
	} catch (error: any) {
		console.error('waiter_confirm_bill_payment_failed', error);
		res.status(400).json({ error: String(error?.message ?? 'Unable to confirm payment') });
	}
});

app.post('/bills/order/:orderId/admin-approve-payment', validateAction("fc57d407-4bba-442c-97a2-9e6f3c57f288"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin"]);
	if (!auth) {
		return;
	}

	const orderId = typeof req.params.orderId === 'string' ? req.params.orderId.trim() : '';
	const adminEmployeeId = extractEmployeeId(req);
	if (!orderId || !adminEmployeeId) {
		res.status(400).json({ error: 'Missing orderId or admin identity' });
		return;
	}

	try {
		const result = await ApproveBillPaymentByAdmin(auth.restaurantId, orderId, adminEmployeeId);
		try {
			emitRestaurant(auth.restaurantId, 'bill:admin_approved_payment', {
				order_id: orderId,
				admin: adminEmployeeId,
			});
		} catch {
			// ignore realtime failures
		}
		try {
			await log_audit(req, "fc57d407-4bba-442c-97a2-9e6f3c57f288", `Admin approved payment for order ${orderId}`, Audit_log_category.Bill, { order_id: orderId, admin: adminEmployeeId });
		} catch (err) {
			console.warn('log_audit admin-approve-payment failed', err);
		}
		res.json(result);
	} catch (error: any) {
		console.error('admin_approve_bill_payment_failed', error);
		res.status(400).json({ error: String(error?.message ?? 'Unable to approve payment') });
	}
});

app.post('/bills/order/:orderId/close', validateAction("a953d044-31ba-4e31-b96f-99304fe43dfa"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin"]);
	if (!auth) {
		return;
	}

	const orderId = typeof req.params.orderId === 'string' ? req.params.orderId.trim() : '';
	const adminEmployeeId = extractEmployeeId(req);
	if (!orderId || !adminEmployeeId) {
		res.status(400).json({ error: 'Missing orderId or admin identity' });
		return;
	}

	try {
		const result = await CloseBillByOrder(auth.restaurantId, orderId, adminEmployeeId);
		try {
			emitRestaurant(auth.restaurantId, 'bill:closed', {
				order_id: orderId,
				admin: adminEmployeeId,
			});
		} catch {
			// ignore realtime failures
		}
		try {
			await log_audit(req, "a953d044-31ba-4e31-b96f-99304fe43dfa", `Closed bill for order ${orderId}`, Audit_log_category.Bill, { order_id: orderId, admin: adminEmployeeId });
		} catch (err) {
			console.warn('log_audit close-bill failed', err);
		}
		res.json(result);
	} catch (error: any) {
		console.error('close_bill_failed', error);
		res.status(400).json({ error: String(error?.message ?? 'Unable to close bill') });
	}
});

app.patch("/booking/:id/table", validateAction("c7699d46-0e2f-4448-b325-8ca490a5296b"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const rawId = req.params.id;
	const bookingId = typeof rawId === "string" ? rawId.trim() : "";
	if (!bookingId) {
		res.status(400).json({ error: "Invalid booking id" });
		return;
	}

	const tableNameRaw = req.body?.table_name;
	const tableName =
		tableNameRaw === null || tableNameRaw === undefined
			? null
			: String(tableNameRaw).trim() || null;

	try {
		const updated = await AssignTableToBooking(auth.restaurantId, bookingId, tableName);
		if (!updated) {
			res.status(404).json({ error: "Booking not found" });
			return;
		}
	} catch (error) {
		res.status(400).json({ error: "Unable to assign table" });
		return;
	}

	try {
		await log_audit(req, "c7699d46-0e2f-4448-b325-8ca490a5296b", `Assigned table ${tableName ?? 'null'} to booking ${bookingId}`, Audit_log_category.Bookings, { booking_id: bookingId, table_name: tableName });
	} catch (err) {
		console.warn('log_audit assign-table-to-booking failed', err);
	}

	res.json({ success: true });
});


app.delete("/booking/:id", validateAction("1f176202-d5e7-4bb0-802c-275a42425394"), async (req: Request, res: Response) => {
	const bookingIdParam = req.params.id;
	const bookingId = typeof bookingIdParam === "string" ? bookingIdParam.trim() : "";
	if (!bookingId) {
		res.status(400).json({ error: "Invalid booking id" });
		return;
	}

	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const deleted = await DeleteBooking(restaurantId, bookingId);
	if (!deleted) {
		res.status(404).json({ error: "Booking not found" });
		return;
	}

	try {
		emitRestaurant(restaurantId, "booking:deleted", { booking_id: bookingId });
	} catch (err) {
		console.warn("emit booking:deleted failed", err);
	}

	try {
		await log_audit(req, "1f176202-d5e7-4bb0-802c-275a42425394", `Canceled booking ${bookingId}`, Audit_log_category.Bookings, { booking_id: bookingId });
	} catch (err) {
		console.warn('log_audit delete-booking failed', err);
	}

	res.status(204).send();
});

/*
	Returns all customer data
	[
		{
			"customer_id": 1,
			"name": "Dodo",
			"booking_count": 5,
			"has_booking": true // Does the customer have an active booking
		}
	]
*/
app.get("/get-customers", validateAction("3c530903-324c-4bbe-802b-849763518920"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	let customers;
	try {
		customers = await GetCustomerAndBookings(restaurantId);
	} catch {
		res.status(400).send({ error: "Oops something went wrong" });
		return;
	}

	const customersWithStatus = await Promise.all(
		customers.map(async (customer) => ({
			...customer,
			has_booking: await HasActiveBooking(restaurantId, customer.customer_id),
		})),
	);

	try {
		await log_audit(req, "3c530903-324c-4bbe-802b-849763518920", `Fetched customers list`, Audit_log_category.Customer);
	} catch (err) {
		console.warn('log_audit get-customers failed', err);
	}

	res.send(customersWithStatus);
});

/*
	returns the count of bookings in a range
	requests body must be like this
	{
		start: 1004038434 // anything that can be parsed by Date()
		end: 1004038434 // anything that can be parsed by Date()
	}
	Date.parse documentation
	https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/parse
	for the best results just send ms since epoch
	returns the number of bookings in that range
*/
app.get("/get-withen-range", validateAction("0a98cf2b-8b42-47a7-a523-b7bb73cb870e"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).send({ Error: "Missing restaurantId" });
		return;
	}
	if (!(req.body["start"] && req.body["end"])) {
		res.status(400).send({ Error: "Missing fields" });
	}

	let start = new Date(req.body.start);
	let end = new Date(req.body.end);

	if (isNaN(start.valueOf()) || isNaN(end.valueOf())) {
		res.status(400).send({
			Error: "Dates provided is not formated correctley",
		});
	}

	let count = await GetBookingsInRange(restaurantId, start, end);

	if (count == null) {
		res.status(400).send({ Error: "Oops something went wrong" });
	}

	try {
		await log_audit(req, "0a98cf2b-8b42-47a7-a523-b7bb73cb870e", `Fetched bookings count in range`, Audit_log_category.Bookings, { start: start.toISOString(), end: end.toISOString(), count });
	} catch (err) {
		console.warn('log_audit get-withen-range failed', err);
	}

	res.send(count);
});

app.get("/audit-logs", validateAction("91b24293-7b88-4fe4-8cf5-deb6faaba4f5"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const limitParam = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
	const limit = limitParam ? Number.parseInt(String(limitParam), 10) : 100;

	try {
		const logs = await GetAuditLogs(restaurantId, Number.isFinite(limit) ? limit : 100);
		// try {
		// 	await log_audit(req, "91b24293-7b88-4fe4-8cf5-deb6faaba4f5", `Fetched audit logs`, Audit_log_category.General, { limit });
		// } catch (err) {
		// 	console.warn('log_audit get-audit-logs failed', err);
		// }
		res.json(logs);
	} catch (error) {
		res.status(500).json({ error: "Unable to fetch audit logs" });
	}
});

// app.post("/audit-logs", validateAction("722e1023-99f8-4905-ab51-97404694eab6"), async (req: Request, res: Response) => {
// 	const restaurantId = extractRestaurantId(req);
// 	if (!restaurantId) {
// 		res.status(400).json({ error: "Missing restaurantId" });
// 		return;
// 	}

// 	const body = (req.body ?? {}) as Record<string, unknown>;
// 	const employeeFromHeader = extractEmployeeId(req)?.trim() ?? "";
// 	const employeeFromBody = typeof body.employee === "string" ? body.employee.trim() : "";
// 	const employeeIdFromBody = typeof body.employee_id === "string" ? body.employee_id.trim() : "";
// 	const employee = employeeFromHeader || employeeIdFromBody || employeeFromBody;
// 	const action = typeof body.action === "string" ? body.action.trim() : "";
// 	const details = typeof body.details === "string" ? body.details.trim() : "";

// 	if (!employee || !action) {
// 		res.status(400).json({ error: "Missing employee or action" });
// 		return;
// 	}

// 	try {
// 		await AddAuditLogEntryLegacy(restaurantId, {
// 			employee,
// 			employeeId: employeeFromHeader || employeeIdFromBody || null,
// 			action,
// 			details: details || null,
// 			category: Audit_log_category.General
// 		});
// 		try {
// 			await log_audit(req, "722e1023-99f8-4905-ab51-97404694eab6", `Recorded audit-log entry ${action}`, Audit_log_category.General, { employee });
// 		} catch (err) {
// 			console.warn('log_audit post-audit-logs failed', err);
// 		}
// 		res.status(201).json({ success: true });
// 	} catch (error) {
// 		console.error("add_audit_log_failed", error);
// 		res.status(500).json({ error: "Unable to record audit log" });
// 	}
// });

app.get("/inventory", validateAction("77e41c84-ebf4-4542-a75b-c9e72e03b570"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	try {
		const items = await GetInventoryItems(restaurantId);
		try {
			await log_audit(req, "77e41c84-ebf4-4542-a75b-c9e72e03b570", `Fetched inventory items`, Audit_log_category.Inventory, { count: Array.isArray(items) ? items.length : undefined });
		} catch (err) {
			console.warn('log_audit get-inventory failed', err);
		}
		res.json(items);
	} catch (error) {
		console.error("get_inventory_failed", error);
		res.status(500).json({ error: "Unable to fetch inventory" });
	}
});

app.post("/inventory", validateAction("dfe2cde8-c159-4685-b015-ec7b0d4386eb"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = (req.body ?? {}) as Record<string, unknown>;
	const name = typeof body.name === "string" ? body.name.trim() : "";
	const stock = Number(body.stock ?? 0);
	if (!name || !Number.isFinite(stock)) {
		res.status(400).json({ error: "name and stock are required" });
		return;
	}

	try {
		const result = await UpsertInventoryItem(restaurantId, {
			id: typeof body.id === "string" ? body.id : undefined,
			name,
			category: typeof body.category === "string" ? body.category : undefined,
			stock,
			unit: typeof body.unit === "string" ? body.unit : undefined,
		});
		await log_audit(req, "dfe2cde8-c159-4685-b015-ec7b0d4386eb", `Upserted inventory item ${name} with stock ${stock}`, Audit_log_category.Inventory);
		res.status(201).json(result);
	} catch (error) {
		console.error("upsert_inventory_failed", error);
		res.status(500).json({ error: "Unable to save inventory item" });
	}
});

app.delete("/inventory/:id", validateAction("add0a9ec-a563-4903-9a24-d2e0b46361a5"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const rawId = req.params.id;
	const inventoryId = typeof rawId === "string" ? rawId.trim() : "";
	if (!inventoryId) {
		res.status(400).json({ error: "Invalid inventory id" });
		return;
	}

	try {
		const removed = await DeleteInventoryItem(restaurantId, inventoryId);
		if (!removed) {
			res.status(404).json({ error: "Inventory item not found" });
			return;
		}
		res.status(204).send();
	} catch (error) {
		console.error("delete_inventory_failed", error);
		res.status(500).json({ error: "Unable to delete inventory item" });
	}
});

app.get("/menu", validateAction("f4177b38-77fa-4d8c-9fbd-c4f06bf28610"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	try {
		const items = await GetMenuItems(restaurantId);
		res.json(items);
	} catch (error) {
		console.error("get_menu_failed", error);
		res.status(500).json({ error: "Unable to fetch menu" });
	}
});

app.get("/menu/categories", validateAction("f4177b38-77fa-4d8c-9fbd-c4f06bf28610"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	try {
		const categories = await GetMenuCategories(restaurantId);
		res.json(categories);
	} catch (error) {
		console.error("get_menu_categories_failed", error);
		res.status(500).json({ error: "Unable to fetch menu categories" });
	}
});

app.post("/menu", validateAction("88a87943-8f0b-43e2-b85e-192fdc901ed2"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = (req.body ?? {}) as Record<string, unknown>;
	if (typeof body.name !== "string" || typeof body.category !== "string") {
		res.status(400).json({ error: "name and category are required" });
		return;
	}

	try {
		const result = await UpsertMenuItem(restaurantId, {
			id: typeof body.id === "string" ? body.id : "",
			name: body.name,
			price: Number(body.price ?? 0),
			category: body.category,
		});
		res.status(201).json(result);
	} catch (error) {
		console.error("upsert_menu_item_failed", error);
		res.status(500).json({ error: "Unable to save menu item" });
	}
});

app.put("/menu", validateAction("ed800655-b937-44ba-a7ca-7458295886c9"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const items = Array.isArray(req.body?.items) ? req.body.items : null;
	if (!items) {
		res.status(400).json({ error: "items array is required" });
		return;
	}

	try {
		await SaveMenuItems(
			restaurantId,
			items.map((item: any) => ({
				id: String(item.id ?? ""),
				name: String(item.name ?? ""),
				price: Number(item.price ?? 0),
				category: String(item.category ?? "General"),
			})),
		);
		res.json({ success: true });
	} catch (error) {
		console.error("save_menu_failed", error);
		res.status(500).json({ error: "Unable to save menu" });
	}
});

app.post("/menu/categories", validateAction("88a87943-8f0b-43e2-b85e-192fdc901ed2"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const category = typeof req.body?.category === "string" ? req.body.category.trim() : "";
	if (!category) {
		res.status(400).json({ error: "category is required" });
		return;
	}

	try {
		await EnsureMenuCategory(restaurantId, category);
		res.status(201).json({ success: true });
	} catch (error) {
		console.error("ensure_menu_category_failed", error);
		res.status(500).json({ error: "Unable to save category" });
	}
});

app.delete("/menu/categories", validateAction("ed800655-b937-44ba-a7ca-7458295886c9"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const categoryRaw = typeof req.query?.category === "string"
		? req.query.category
		: typeof req.body?.category === "string"
			? req.body.category
			: "";
	const category = categoryRaw.trim();
	if (!category) {
		res.status(400).json({ error: "category is required" });
		return;
	}

	try {
		const result = await DeleteMenuCategory(restaurantId, category);
		res.json({ success: true, deletedItems: result.deletedItems });
	} catch (error) {
		console.error("delete_menu_category_failed", error);
		res.status(500).json({ error: "Unable to delete category" });
	}
});

app.get("/orders", validateAction("b7f78d0f-323d-4622-8d05-aa2f82d54b2e"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	try {
		const items = await GetOrders(restaurantId);
		res.json(items);
	} catch (error) {
		console.error("get_orders_failed", error);
		res.status(500).json({ error: "Unable to fetch orders" });
	}
});

app.post("/orders", validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	try {
		const result = await AddOrder(restaurantId, req.body ?? {});
		res.status(201).json(result);
	} catch (error: any) {
		console.error("add_order_failed", error);
		res.status(400).json({ error: String(error?.message ?? "Unable to add order") });
	}
});

app.delete("/orders/:id", validateAction("4ad474d4-5230-449c-874f-6a238b833bca"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const orderId = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!orderId) {
		res.status(400).json({ error: "Invalid order id" });
		return;
	}

	try {
		const deleted = await DeleteOrder(restaurantId, orderId);
		if (!deleted) {
			res.status(404).json({ error: "Order not found" });
			return;
		}
		res.status(204).send();
	} catch (error: any) {
		console.error("delete_order_failed", error);
		res.status(400).json({ error: String(error?.message ?? "Unable to delete order") });
	}
});

app.get("/orders/apc", validateAction("df75119b-e5f1-4f38-aba5-78a1cf182f56"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const periodRaw = typeof req.query.period === "string" ? req.query.period.trim().toLowerCase() : "";
	const period = (periodRaw === "day" || periodRaw === "week" || periodRaw === "month"
		? periodRaw
		: "month") as "day" | "week" | "month";

	const monthRaw = typeof req.query.month === "string" ? req.query.month.trim() : "";
	let monthStart: Date | undefined;
	if (monthRaw) {
		const parsed = new Date(`${monthRaw}-01T00:00:00.000Z`);
		if (Number.isNaN(parsed.getTime())) {
			res.status(400).json({ error: "Invalid month. Use YYYY-MM." });
			return;
		}
		monthStart = parsed;
	}

	const employeeQuery = typeof req.query.employeeId === "string" ? req.query.employeeId.trim() : "";
	const employeeId = employeeQuery || extractEmployeeId(req) || undefined;

	try {
		const insight = await GetMonthlyApcInsights(restaurantId, {
			period,
			periodStart: monthStart,
			employeeId,
		});
		res.json(insight);
	} catch (error) {
		console.error("get_orders_apc_failed", error);
		res.status(500).json({ error: "Unable to fetch APC insights" });
	}
});

app.get("/restaurant/profile", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const employeeId = extractEmployeeId(req) ?? undefined;
	try {
		const profile = await GetRestaurantProfile(restaurantId, employeeId);
		res.json(profile);
	} catch (error) {
		console.error("get_restaurant_profile_failed", error);
		res.status(500).json({ error: "Unable to fetch profile" });
	}
});

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

// Publish a bill ESC/POS payload to the appropriate restaurant:outlet pub/sub channel
app.post('/publish/bill', validateAction("2ae797d9-2bef-4419-a33d-ab09590dbef9"), async (req: Request, res: Response) => {
	console.log('Received request to publish bill');
	const body = (req.body ?? {}) as Record<string, unknown>;
	const restaurantId = typeof body.restaurantId === 'string' ? body.restaurantId.trim() : (typeof req.headers['x-restaurant-id'] === 'string' ? req.headers['x-restaurant-id'] : null);
	const outletId = typeof body.outletId === 'string' ? body.outletId.trim() : (typeof req.headers['x-outlet-id'] === 'string' ? req.headers['x-outlet-id'] : null);
	const billId = typeof body.billId === 'string' ? body.billId.trim() : '';
	const escBase64 = typeof body.escBase64 === 'string' ? body.escBase64 : (typeof body.esc === 'string' ? body.esc : null);

	if (!restaurantId || !outletId || !billId || !escBase64) {
		res.status(400).json({ error: 'restaurantId, outletId, billId and escBase64 are required' });
		return;
	}

	try {
		// verify restaurant and outlet
		const profile = await GetRestaurantProfile(restaurantId);
		if (!profile) {
			res.status(404).json({ error: 'Invalid restaurantId' });
			return;
		}

		if (!profile.outlet_id || String(profile.outlet_id) !== String(outletId)) {
			// If outlet doesn't match profile, still allow if the outletId is non-empty — we cannot enumerate all outlets here easily.
			// For strict verification, you can implement lookup against Outlets table. For now, reject if mismatch with default outlet from profile.
			res.status(400).json({ error: 'Invalid outletId for the restaurant' });
			return;
		}

		// Emit to outlet-specific room; send billId and base64 payload
		emitOutlet(restaurantId, outletId, 'bill:print', { billId, escBase64, publishedAt: new Date().toISOString() });
		res.json({ success: true });
	} catch (err) {
		console.error('publish_bill_failed', err);
		res.status(500).json({ error: 'Unable to publish bill' });
	}
});

app.put("/restaurant/profile", validateAction("60d14e9c-45cc-4dc2-b017-56058cc3ae33"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const profile = req.body ?? {};
	if (
		typeof profile.name !== "string" ||
		typeof profile.address !== "string" ||
		typeof profile.phone !== "string" ||
		typeof profile.email !== "string" ||
		typeof profile.hours !== "string"
	) {
		res.status(400).json({ error: "Invalid profile payload" });
		return;
	}

	const employeeId = extractEmployeeId(req) ?? undefined;
	try {
		await UpdateRestaurantProfile(restaurantId, profile, employeeId);
		res.json({ success: true });
	} catch (error) {
		console.error("update_restaurant_profile_failed", error);
		res.status(500).json({ error: "Unable to update profile" });
	}
});

app.get('/outlets/default-tax', validateAction("d9b3f882-d3cf-46bc-b9ce-4218e8a5c29d"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: 'Missing restaurantId' });
		return;
	}

	try {
		const tax = await GetOutletDefaultTax(restaurantId);
		res.json({ default_tax: tax ?? {} });
	} catch (err) {
		console.error('get_default_tax_failed', err);
		res.status(500).json({ error: 'Unable to fetch default tax' });
	}
});

app.patch('/outlets/default-tax', validateAction("28fa21cc-0dba-4a0f-bf6f-387089f47bbf"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: 'Missing restaurantId' });
		return;
	}

	const body = req.body ?? {};
	const defaultTax = body.default_tax;
	if (!defaultTax || typeof defaultTax !== 'object') {
		res.status(400).json({ error: 'default_tax object is required' });
		return;
	}

	try {
		await UpdateOutletDefaultTax(restaurantId, defaultTax);
		res.json({ ok: true });
	} catch (err) {
		console.error('update_default_tax_failed', err);
		res.status(500).json({ error: 'Unable to update default tax' });
	}
});

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
		console.error("get_roles_failed", error);
		res.status(500).json({ error: "Unable to fetch roles" });
	}
});

app.get("/actions", validateAction("2b6f7948-0b27-41a9-9727-c04ccc9f4db1"), async (req: Request, res: Response) => {

	try {
		const actions = await GetActions();
		res.json(actions);
	} catch (err) {
		console.error('get_actions_failed', err);
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
		const role = await CreateRole(restaurantId, roleName, actions);
		res.status(201).json(role);
	} catch (error: any) {
		console.error("create_role_failed", error);
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
		const removed = await DeleteRole(restaurantId, roleId);
		if (!removed) {
			res.status(404).json({ error: "Role not found" });
			return;
		}
		res.status(204).send();
	} catch (error) {
		console.error("delete_role_failed", error);
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

	try {
		await AssignRoleToEmployee(restaurantId, employeeId, roleName);
		res.json({ success: true });
	} catch (error: any) {
		console.error("assign_role_failed", error);
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

	try {
		await RemoveRoleFromEmployee(restaurantId, employeeId, roleName);
		res.json({ success: true });
	} catch (error: any) {
		console.error("remove_role_failed", error);
		res.status(400).json({ error: String(error?.message ?? "Unable to remove role") });
	}
});

app.get("/table-assignments", validateAction("f88657ce-0d67-4cd6-aae1-765dec10cd98"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "employee"]);
	if (!auth) {
		return;
	}

	try {
		const assignments = await GetTableAssignments(auth.restaurantId);
		res.json(assignments);
	} catch (error) {
		console.error("get_table_assignments_failed", error);
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
		console.error("assign_table_employee_failed", error);
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
		console.error("unassign_table_employee_failed", error);
		res.status(400).json({ error: String(error?.message ?? "Unable to unassign table") });
	}
});



// Rtamanyu's integration
app.get("/valet-bays", validateAction("9e37297d-408b-446d-a51b-7892ad216b7d"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	try {
		const data = await GetParkingBays(auth.restaurantId, auth.outletId);
		res.json(data);
		return;
	} catch (error) {
		console.error("fetch_valet_bays_failed", error);
		res.status(500).json({ error: "Unable to fetch valet bays" });
		return;
	}
});

app.post("/add-valet-bay", validateAction("ae8ce7c0-1e06-4722-8a06-817267eec785"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const bayName = typeof body?.Bay_name === 'string' ? body.Bay_name.trim() : undefined;
	const totalCapacity = body?.total_capacity === null || body?.total_capacity === undefined ? undefined : Number(body.total_capacity);
	if (!bayName) {
		res.status(400).json({ error: "Missing Bay_name" });
		return;
	}

	try {
		const bay = await AddParkingBay(
			auth.restaurantId,
			bayName,
			Number.isFinite(totalCapacity) ? Number(totalCapacity) : 0,
			auth.outletId,
		);
		const data = {
			message: "Bay added",
			...bay,
		};

		// Broadcast bay added
		try {
			emitRestaurant(auth.restaurantId, "valet:bay_added", data);
		} catch (err) {
			console.warn("emit valet:bay_added failed", err);
		}
		res.json(data);
		return;
	} catch (error) {
		console.error("add_valet_bay_failed", error);
		res.status(500).json({ error: "Unable to add valet bay" });
		return;
	}
});

app.post("/delete-valet-bay", validateAction("6e9be65f-4081-4b86-8ba0-0592ee26f7f2"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}
	const body = req.body as Record<string, unknown> | undefined;
	const bayId = body?.Bay_id ? String(body.Bay_id) : undefined;
	const bayName = typeof body?.Bay_name === 'string' ? body.Bay_name.trim() : undefined;
	if (!bayId && !bayName) {
		res.status(400).json({ error: "Missing Bay_id or Bay_name" });
		return;
	}

	try {
		const deleted = await DeleteParkingBay(auth.restaurantId, bayId ?? null, bayName ?? null, auth.outletId);
		if (!deleted) {
			res.status(404).json({ error: "Bay not found" });
			return;
		}
		const data = {
			message: "Bay deleted",
			...deleted,
		};

		// Broadcast bay deleted
		try {
			emitRestaurant(auth.restaurantId, "valet:bay_deleted", data);
		} catch (err) {
			console.warn("emit valet:bay_deleted failed", err);
		}
		res.json(data);
		return;
	} catch (error) {
		console.error("delete_valet_bay_failed", error);
		res.status(500).json({ error: "Unable to delete valet bay" });
		return;
	}
});


app.post("/update-valet-bay", validateAction("2caeab74-5941-424d-9c3a-5c68ef0186e1"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) return;

	const body = req.body as Record<string, unknown> | undefined;
	const bayId = body?.Bay_id ? String(body.Bay_id) : undefined;
	const bayName = typeof body?.Bay_name === 'string' ? body.Bay_name.trim() : undefined;
	const totalCapacity = body?.total_capacity === null || body?.total_capacity === undefined ? undefined : Number(body.total_capacity);

	if (!bayName) {
		res.status(400).json({ error: "Missing Bay_name" });
		return;
	}

	try {
		const updated = await UpdateParkingBay(
			auth.restaurantId,
			bayId ?? null,
			bayName,
			Number.isFinite(totalCapacity) ? Number(totalCapacity) : 0,
			auth.outletId,
		);
		if (!updated) {
			res.status(404).json({ error: "Bay not found" });
			return;
		}
		const data = {
			message: "Bay updated",
			...updated,
		};

		// Broadcast bay updated
		try {
			emitRestaurant(auth.restaurantId, "valet:bay_updated", data);
		} catch (err) {
			console.warn("emit valet:bay_updated failed", err);
		}
		res.json(data);
		return;
	} catch (err) {
		console.error("update_valet_bay_failed", err);
		res.status(500).json({ error: "Unable to update valet bay" });
	}
});


app.post("/set-valet-bay-current", validateAction("2ff51c3d-f18c-406c-9f49-7c54f468c835"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) return;

	const body = req.body as Record<string, unknown> | undefined;
	const bayId = body?.Bay_id ? String(body.Bay_id) : undefined;
	const current = body?.current_capacity === null || body?.current_capacity === undefined ? undefined : Number(body.current_capacity);

	if (!bayId || current === undefined || Number.isNaN(current)) {
		res.status(400).json({ error: "Missing Bay_id or current_capacity" });
		return;
	}

	try {
		const updated = await SetParkingBayCurrent(auth.restaurantId, bayId, Number(current), auth.outletId);
		if (!updated) {
			res.status(404).json({ error: "Bay not found" });
			return;
		}
		const data = {
			message: "Bay current capacity set",
			...updated,
		};

		// Broadcast bay current capacity update
		try {
			emitRestaurant(auth.restaurantId, "valet:bay_current_set", { Bay_id: body?.Bay_id, current_capacity: Number(current) });
		} catch (err) {
			console.warn("emit valet:bay_current_set failed", err);
		}
		res.json(data);
		return;
	} catch (err) {
		console.error("set_valet_bay_current_failed", err);
		res.status(500).json({ error: "Unable to set bay current capacity" });
		return;
	}
});

app.post("/create_valet_record", validateAction("892b50f3-51fc-4099-8f31-01e8dd8c3d44"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const number_plate = typeof body?.number_plate === 'string' ? body.number_plate.trim().toUpperCase() : undefined;
	const customer_name = typeof body?.customer_name === 'string' ? body.customer_name.trim() : undefined;
	const bayIdRaw =
		typeof body?.bay_id === 'string'
			? body.bay_id.trim()
			: typeof body?.Bay_id === 'string'
				? body.Bay_id.trim()
				: undefined;
	const bayNameRaw =
		typeof body?.bay_name === 'string'
			? body.bay_name.trim()
			: typeof body?.Bay_name === 'string'
				? body.Bay_name.trim()
				: undefined;
	const bayIdentifier = bayIdRaw || bayNameRaw;
	const entryTimeRaw =
		typeof body?.booking_date_time === 'string'
			? body.booking_date_time
			: typeof body?.entry_time === 'string'
				? body.entry_time
				: typeof body?.date_time === 'string'
					? body.date_time
					: undefined;

	let entryTime: Date | undefined;
	if (entryTimeRaw) {
		const parsed = new Date(entryTimeRaw);
		if (Number.isNaN(parsed.getTime())) {
			res.status(400).json({ error: "Invalid booking_date_time" });
			return;
		}
		entryTime = parsed;
	}

	if (!number_plate) {
		res.status(400).json({ error: "Missing number plate" });
		return;
	}

	try {
		const created = await CreateValetVehicleState(auth.restaurantId, entryTime, bayIdentifier, auth.outletId);
		const meta = await UpsertValetVehicleMeta(
			auth.restaurantId,
			created.booking_id,
			number_plate,
			customer_name,
			auth.outletId,
		);
		const data = {
			message: "New valet record created successfully.",
			booking_id: created.booking_id,
			entry_time: created.entry_time,
			bay_id: created.bay_id,
			number_plate: meta.number_plate,
			customer_name: meta.customer_name ?? undefined,
		};

		// Broadcast created valet record to connected frontends
		emitRestaurant(auth.restaurantId, "valet:created", data);
		res.json(data);
		return;
	} catch (error) {
		console.error("create_valet_record_failed", error);
		res.status(500).json({ error: "Unable to create valet record" });
		return;
	}
});

app.post("/get_valet_info", validateAction("9e37297d-408b-446d-a51b-7892ad216b7d"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const booking_id = typeof body?.booking_id === 'string' ? body.booking_id.trim() : undefined;
	if (!booking_id) {
		res.status(400).json({ error: "Missing booking ID" });
		return;
	}

	try {
		const record = await GetValetVehicleState(auth.restaurantId, booking_id, auth.outletId);
		if (!record) {
			res.status(404).json({ error: `No valet found with that booking ID - ${booking_id}.` });
			return;
		}
		const metaByBookingId = await GetValetVehicleMetaByBookingIds(auth.restaurantId, [booking_id], auth.outletId);
		const meta = metaByBookingId[booking_id];
		res.json({
			booking_id: record.booking_id,
			state: record.state,
			entry_time: record.entry_time,
			exit_time: record.exit_time,
			bay_id: record.bay_id,
			number_plate: meta?.number_plate,
			customer_name: meta?.customer_name ?? undefined,
		});
		return;
	} catch (error) {
		console.error("fetch_valet_info_failed", error);
		res.status(500).json({ error: "Unable to fetch valet info" });
		return;
	}
});

async function updateValetStateAndPublish(
	restaurantId: string,
	bookingId: string,
	state: string,
	outletId?: string,
): Promise<Record<string, unknown>> {
	const stateNum = Number(state);
	if (!Number.isFinite(stateNum)) {
		throw Object.assign(new Error("Unable to update valet state"), {
			status: 400,
			payload: { error: "Invalid state" },
		});
	}

	const updated = await UpdateValetVehicleState(restaurantId, bookingId, stateNum, outletId);
	if (!updated) {
		throw Object.assign(new Error("Unable to update valet state"), {
			status: 404,
			payload: { error: `No active valet record found for that booking ID - ${bookingId}.` },
		});
	}

	const payload: Record<string, unknown> = {
		message: "Valet state updated successfully.",
		booking_id: updated.booking_id,
	};

	// Centralized publisher path for valet state updates.
	emitRestaurant(restaurantId, "valet:updated", { booking_id: bookingId, state, detail: payload });
	return payload;
}


app.post("/update_valet_state", validateAction("b8e02c25-b91c-427c-b462-8df009ede055"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const booking_id = typeof body?.booking_id === 'string' ? body.booking_id.trim() : undefined;
	const state = body?.state === null || body?.state === undefined ? undefined : String(body.state).trim();
	if (!booking_id || !state) {
		res.status(400).json({ error: "Missing booking ID or state" });
		return;
	}

	try {
		const data = await updateValetStateAndPublish(auth.restaurantId, booking_id, state, auth.outletId);
		res.json(data);
		return;
	} catch (error) {
		console.error("update_valet_state_failed", error);
		const status = typeof (error as { status?: unknown })?.status === "number"
			? ((error as { status: number }).status)
			: 500;
		const payload = (error as { payload?: unknown })?.payload;
		if (status !== 500 && payload && typeof payload === "object") {
			res.status(status).json(payload as Record<string, unknown>);
			return;
		}
		res.status(500).json({ error: "Unable to update valet state" });
		return;
	}
});

app.post("/update_valet_bay", validateAction("b8e02c25-b91c-427c-b462-8df009ede055"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const booking_id = typeof body?.booking_id === 'string' ? body.booking_id.trim() : undefined;
	// Accept bay_id in body; fall back to bay_name for backward compatibility
	const bay_id_raw = body?.bay_id ?? body?.bay_name;
	const bay_id = bay_id_raw === null || bay_id_raw === undefined ? undefined : String(bay_id_raw).trim();
	if (!booking_id || !bay_id) {
		res.status(400).json({ error: "Missing booking ID or bay id" });
		return;
	}

	try {
		const updated = await UpdateValetVehicleBay(auth.restaurantId, booking_id, bay_id, auth.outletId);
		if (!updated) {
			res.status(404).json({ error: `No active valet record found for that booking ID - ${booking_id}.` });
			return;
		}
		const data = {
			message: "Valet bay updated successfully.",
			booking_id: updated.booking_id,
			bay_id: updated.bay_id,
		};
		res.json(data);
		return;
	} catch (error) {
		console.error("update_valet_bay_failed", error);
		res.status(500).json({ error: String((error as Error)?.message ?? "Unable to update valet bay") });
		return;
	}
});

app.post("/unassign-valet-bay", validateAction("5ef876a7-eb92-4602-b4d3-5590ce379540"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) return;

	const body = req.body as Record<string, unknown> | undefined;
	const booking_id = typeof body?.booking_id === 'string' ? body.booking_id.trim() : undefined;
	if (!booking_id) {
		res.status(400).json({ error: "Missing booking ID" });
		return;
	}

	try {
		const updated = await UpdateValetVehicleBay(auth.restaurantId, booking_id, null, auth.outletId);
		if (!updated) {
			res.status(404).json({ error: `No active valet record found for that booking ID - ${booking_id}.` });
			return;
		}
		const data = {
			message: "Valet bay updated successfully.",
			booking_id: updated.booking_id,
			bay_id: updated.bay_id,
		};
		res.json(data);
		return;
	} catch (error) {
		console.error("unassign_valet_bay_failed", error);
		res.status(500).json({ error: "Unable to unassign valet bay" });
		return;
	}
});

app.post("/get_main_feedback_question", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const category = typeof body?.category === 'number' ? body.category : undefined;
	if (!category) {
		res.status(400).json({ error: "Missing category" });
		return;
	}
	if (category < 1 || category > 7) {
		res.status(400).json({ error: "Invalid category" });
		return;
	}
	try {
		const response = await fetch(
			`${PY_SERVER_URL}/get_main_feedback_question/${encodeURIComponent(category)}`,
		);
		const data = await response.json();
		if (!response.ok) {
			res.status(response.status).json(data);
			return;
		}
		res.json(data);
		return;
	} catch (error) {
		console.error("get_main_feedback_question_failed", error);
		res.status(500).json({ error: "Unable to fetch main feedback question" });
		return;
	}
});

app.post("/get_follow_up_question", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const category = typeof body?.category === 'number' ? body.category : undefined;
	const rate = body?.rate === null || body?.rate === undefined ? undefined : Number(body.rate);
	if (!category || !rate) {
		res.status(400).json({ error: "Missing category or rate" });
		return;
	}
	if (category < 1 || category > 7) {
		res.status(400).json({ error: "Invalid category" });
		return;
	}
	if (rate < 1 || rate > 5) {
		res.status(400).json({ error: "Invalid rate" });
		return;
	}

	try {
		const response = await fetch(
			`${PY_SERVER_URL}/get_follow_up_question/${encodeURIComponent(category)}/${encodeURIComponent(rate)}`,
		);
		const payload = await response.json();
		const data = (payload ?? {}) as Record<string, unknown>;
		if (!response.ok) {
			res.status(response.status).json(data);
			return;
		}
		const categoryLabel = getFeedbackCategoryLabel(category);
		const rawFeedback = typeof data.feedback === "string" ? data.feedback : "";
		const normalizedFeedback = normalizeFollowUpPromptForCategory(rawFeedback, categoryLabel, rate);
		res.json({ ...data, feedback: normalizedFeedback });
		return;
	} catch (error) {
		console.error("get_follow_up_question_failed", error);
		res.status(500).json({ error: "Unable to fetch follow-up question" });
		return;
	}
});

app.post("/feedback/dynamic-follow-up", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const categoryLabel = typeof body?.category_label === "string" ? body.category_label.trim() : "";
	const rating = Number(body?.rating);
	const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
	const mainQuestion = typeof body?.main_question === "string" ? body.main_question.trim() : "";
	const firstFollowUpQuestion =
		typeof body?.first_follow_up_question === "string" ? body.first_follow_up_question.trim() : "";

	if (!categoryLabel || !Number.isFinite(rating) || !reason) {
		res.status(400).json({ error: "category_label, rating, and reason are required" });
		return;
	}

	if (reason.length < 8) {
		res.status(400).json({ error: "reason is too short" });
		return;
	}

	try {
		const proxyResponse = await fetch(
			`${PY_SERVER_URL}/get_follow_up_question/${encodeURIComponent(categoryLabel)}/${encodeURIComponent(rating)}`,
		);

		const proxyData = (await proxyResponse.json()) as Record<string, unknown>;
		if (!proxyResponse.ok) {
			res.status(proxyResponse.status).json(proxyData);
			return;
		}

		const aiPrompt = typeof proxyData.feedback === "string" ? proxyData.feedback.trim() : "";
		const normalizedAiPrompt = normalizeFollowUpPromptForCategory(aiPrompt, categoryLabel.toLowerCase(), rating);
		const contextualFallback =
			mainQuestion && firstFollowUpQuestion
				? `Thanks for sharing. Based on your feedback about ${categoryLabel}, what one change should we prioritize?`
				: `Thanks for sharing. What one change should we prioritize for ${categoryLabel}?`;
		const followUpPrompt = normalizedAiPrompt.length > 0 ? normalizedAiPrompt : contextualFallback;
		res.json({ follow_up_prompt: followUpPrompt });
	} catch (error) {
		console.error("feedback_dynamic_follow_up_failed", error);
		res.status(500).json({ error: "Unable to generate dynamic follow-up" });
	}
});

app.post("/feedback/valet-checkin", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const numberPlate = typeof body?.number_plate === "string" ? body.number_plate.trim() : "";
	if (!numberPlate) {
		res.status(400).json({ error: "number_plate is required" });
		return;
	}

	const normalizedPlate = numberPlate.replace(/\s+/g, "").toUpperCase();

	try {
		const outletId = extractOutletId(req);
		const recordsResponse = await fetch(
			`${PY_SERVER_URL}/get_all_valet_records/${encodeURIComponent(restaurantId)}`,
			{ headers: outletId ? { "X-Outlet-Id": outletId } : undefined },
		);

		const recordsPayload = (await recordsResponse.json().catch(() => null)) as
			| Record<string, unknown>
			| Array<Record<string, unknown>>
			| null;

		if (!recordsResponse.ok) {
			res.status(502).json({
				error: "Unable to verify valet record",
				details: recordsPayload ?? {},
			});
			return;
		}

		const records = Array.isArray(recordsPayload)
			? recordsPayload
			: Array.isArray((recordsPayload as Record<string, unknown> | null)?.records)
				? (((recordsPayload as Record<string, unknown>).records as unknown[]) as Array<Record<string, unknown>>)
				: [];

		const matching = records.filter((record) => {
			const plate = typeof record.number_plate === "string" ? record.number_plate : "";
			return plate.replace(/\s+/g, "").toUpperCase() === normalizedPlate;
		});

		if (matching.length === 0) {
			res.status(404).json({ error: "No valet record found for this vehicle number" });
			return;
		}

		const recordWithState2 = matching.find((record) => Number(record.state) === 2);
		const candidate = recordWithState2 ?? matching[0];
		if (!candidate) {
			res.status(404).json({ error: "No valet record found for this vehicle number" });
			return;
		}
		const currentState = Number(candidate.state);

		if (Number.isFinite(currentState) && currentState > 3) {
			res.json({ success: true, action: "ignored", current_state: currentState });
			return;
		}

		if (currentState === 2) {
			const bookingIdRaw =
				typeof candidate.booking_id === "string"
					? candidate.booking_id
					: typeof candidate.bookingId === "string"
						? candidate.bookingId
						: "";
			const bookingId = bookingIdRaw.trim();
			if (!bookingId) {
				res.status(500).json({ error: "Unable to update valet stage: missing booking id" });
				return;
			}

			try {
				await updateValetStateAndPublish(restaurantId, bookingId, "3", outletId ?? undefined);
			} catch (error) {
				const payload = (error as { payload?: unknown })?.payload;
				res.status(502).json({
					error: "Unable to update valet stage to 3 for this vehicle number",
					details: payload && typeof payload === "object" ? payload : {},
				});
				return;
			}

			res.json({ success: true, action: "updated_to_3", current_state: 3 });
			return;
		}

		res.json({ success: true, action: "ignored", current_state: Number.isFinite(currentState) ? currentState : null });
	} catch (error) {
		console.error("feedback_valet_checkin_failed", error);
		res.status(500).json({ error: "Unable to verify valet vehicle number" });
	}
});

app.post("/feedback/submit", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	const employeeId = extractEmployeeId(req);

	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}
	if (!employeeId) {
		res.status(400).json({ error: "Missing employeeId" });
		return;
	}

	// Validate restaurant exists and the submitting employee is part of it
	try {
		const users = await GetRestaurantUsers(restaurantId);
		if (!users || users.length === 0) {
			res.status(400).json({ error: "Unknown restaurant" });
			return;
		}
		const matched = users.find((u) => String(u.employee_id) === String(employeeId));
		if (!matched) {
			res.status(403).json({ error: "Employee not found in restaurant" });
			return;
		}
		const role = (matched.role ?? "").toString().trim().toLowerCase();
		const allowedRoles = new Set(["admin", "employee", "valet", "waiter", "cashier", "captain", "manager"]);
		if (!allowedRoles.has(role)) {
			res.status(403).json({ error: "Employee role not allowed", actualRole: matched.role ?? null });
			return;
		}
	} catch (err) {
		console.error('validate_employee_failed', err);
		res.status(500).json({ error: 'Unable to validate employee' });
		return;
	}


	const body = req.body as Record<string, unknown> | undefined;

	const categoryRatingsRaw = body?.category_ratings;
	if (!Array.isArray(categoryRatingsRaw) || categoryRatingsRaw.length === 0) {
		res.status(400).json({ error: "category_ratings must be a non-empty array" });
		return;
	}

	try {
		const category_ratings = categoryRatingsRaw
			.map((item) => {
				const row = item as Record<string, unknown>;
				return {
					key: String(row.key ?? "").trim(),
					label: String(row.label ?? "").trim(),
					rating: Number(row.rating),
					question: row.question === null || row.question === undefined ? null : String(row.question),
					follow_up:
						row.follow_up === null || row.follow_up === undefined ? null : String(row.follow_up),
					follow_up_answer:
						row.follow_up_answer === null || row.follow_up_answer === undefined
							? null
							: String(row.follow_up_answer),
				};
			})
			.filter((item) => item.key.length > 0 && item.label.length > 0 && Number.isFinite(item.rating));

		if (category_ratings.length === 0) {
			res.status(400).json({ error: "No valid category ratings found" });
			return;
		}

		const visitDateRaw = body?.visit_date;
		const visitDate =
			typeof visitDateRaw === "string" && visitDateRaw.trim().length > 0
				? new Date(visitDateRaw)
				: null;

		const saved = await AddFeedbackEntry(restaurantId, employeeId, {
			customer_name:
				typeof body?.customer_name === "string" ? body.customer_name : null,
			visit_date: visitDate && !Number.isNaN(visitDate.getTime()) ? visitDate : null,
			comments: typeof body?.comments === "string" ? body.comments : null,
			category_ratings,
			image_theme:
				body?.image_theme && typeof body.image_theme === "object"
					? {
						background: String((body.image_theme as Record<string, unknown>).background ?? ""),
						surface: String((body.image_theme as Record<string, unknown>).surface ?? ""),
						text: String((body.image_theme as Record<string, unknown>).text ?? ""),
						accent: String((body.image_theme as Record<string, unknown>).accent ?? ""),
					}
					: null,
			source: typeof body?.source === "string" ? body.source : "feedback_form",
		});

		// Notify realtime clients subscribed to this restaurant
		try {
			emitRestaurant(restaurantId, "feedback:created", saved);
		} catch (err) {
			console.warn("emit feedback:created failed", err);
		}

		res.status(201).json({ success: true, id: saved.id, submitted_at: saved.submitted_at });
	} catch (error) {
		console.error("submit_feedback_failed", error);
		res.status(500).json({ error: "Unable to submit feedback" });
	}
});

app.get("/restaurant/users", validateAction("92cb8236-1039-4b47-a66f-6c7c8b0144ae"), async (req: Request, res: Response) => {
	const auth = await enforceRolesIgnoreOutletID(req, res, ["admin", "employee"]);
	if (!auth) return;

	try {
		const users = await GetRestaurantUsers(auth.restaurantId);
		res.json({ users });
	} catch (err) {
		console.error('get_restaurant_users_failed', err);
		res.status(500).json({ error: 'Unable to fetch restaurant users' });
	}
});

app.post("/restaurant/users", validateAction("58fdfca7-7a97-439b-aeb2-00e4395a9a30"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin"]);
	if (!auth) return;

	const body = req.body ?? {};
	const empF = typeof body.emp_Fname === 'string' ? body.emp_Fname.trim() : (typeof body.firstName === 'string' ? body.firstName.trim() : '');
	const empL = typeof body.emp_Lname === 'string' ? body.emp_Lname.trim() : (typeof body.lastName === 'string' ? body.lastName.trim() : null);
	const username = typeof body.username === 'string' ? body.username.trim() : '';
	const email = typeof body.email === 'string' ? body.email.trim() : null;
	const role = typeof body.role === 'string' ? body.role : 'employee';
	const password = body.password;
	const ph = typeof body.ph === 'string' || typeof body.ph === 'number' ? String(body.ph) : undefined;
	const add = typeof body.add === 'string' ? body.add : undefined;

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

		try { emitRestaurant(auth.restaurantId, 'restaurant:user:created', { user: created }); } catch (e) { console.warn('emit user created failed', e); }

		res.status(201).json({ success: true, user: created });
	} catch (err) {
		console.error('create_restaurant_user_failed', err);
		res.status(500).json({ error: 'Unable to create user' });
	}
});

app.delete("/restaurant/users", validateAction("a978f15d-1043-417a-b07b-05f6bddad875"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin"]);
	if (!auth) return;

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

		try { emitRestaurant(auth.restaurantId, 'restaurant:user:deleted', { employeeId }); } catch (e) { /* ignore emit errors */ }

		res.json({ success: true });
	} catch (error) {
		console.error('delete_restaurant_user_failed', error);
		res.status(500).json({ error: 'Unable to delete user' });
	}
});

app.get("/feedback", validateAction("0cb6768b-92ff-4848-8631-52ef9d65cf53"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "employee"]);
	if (!auth) {
		return;
	}

	const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
	const parsedLimit = typeof rawLimit === "string" ? Number.parseInt(rawLimit, 10) : 100;
	const limit = Number.isFinite(parsedLimit) ? parsedLimit : 100;

	try {
		const items = await GetFeedbackEntries(auth.restaurantId, limit);
		res.json({ items });
	} catch (error) {
		console.error("get_feedback_failed", error);
		res.status(500).json({ error: "Unable to fetch feedback" });
	}
});

app.get("/feedback/summary", validateAction("0cb6768b-92ff-4848-8631-52ef9d65cf53"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "employee"]);
	if (!auth) {
		return;
	}

	try {
		const summary = await GetFeedbackSummary(auth.restaurantId);
		res.json(summary);
	} catch (error) {
		console.error("get_feedback_summary_failed", error);
		res.status(500).json({ error: "Unable to fetch feedback summary" });
	}
});

app.get("/feedback/stats", validateAction("0cb6768b-92ff-4848-8631-52ef9d65cf53"), async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "employee"]);
	if (!auth) return;

	try {
		const mode = String(req.query.mode ?? "daily");
		const rows = await GetFeedbackEntries(auth.restaurantId, 5000);

		// helper to parse ISO date (yyyy-mm-dd)
		const parseDateISO = (s: string | undefined | null) => {
			if (!s) return null;
			const d = new Date(s);
			if (!isNaN(d.getTime())) return d;
			const parts = (s || "").split("-");
			if (parts.length >= 3) {
				const y = Number(parts[0]);
				const m = Number(parts[1]) - 1;
				const day = Number(parts[2]);
				const dt = new Date(Date.UTC(y, m, day));
				return dt;
			}
			return null;
		};

		if (mode === "daily") {
			const dateParam = String(req.query.date ?? "");
			const date = parseDateISO(dateParam) ?? new Date();
			const targetYMD = date.toISOString().slice(0, 10);
			const hours = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0 }));
			for (const r of rows) {
				const raw = (r as any).submitted_at ?? (r as any).submittedAt ?? (r as any).submittedAt;
				const s = new Date(raw);
				if (isNaN(s.getTime())) continue;
				const ymd = s.toISOString().slice(0, 10);
				if (ymd === targetYMD) {
					const h = s.getUTCHours();
					if (h >= 0 && h < hours.length) {
						const bucket = hours[h];
						if (bucket) bucket.count += 1;
					}
				}
			}
			return res.json({ mode: "daily", date: targetYMD, hours });
		}

		if (mode === "weekly") {
			const weekParam = String(req.query.weekStart ?? "");
			let weekStart = parseDateISO(weekParam) ?? new Date();
			const day = weekStart.getUTCDay();
			const diff = (day + 6) % 7;
			weekStart = new Date(Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate() - diff));
			const days = [] as Array<{ label: string; date: string; count: number }>;
			const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
			for (let i = 0; i < 7; i++) {
				const d = new Date(Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate() + i));
				days.push({ label: dayLabels[i]!, date: d.toISOString().slice(0, 10), count: 0 });
			}
			const startMs = Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate());
			const endMs = startMs + 7 * 24 * 60 * 60 * 1000;
			for (const r of rows) {
				const raw = (r as any).submitted_at ?? (r as any).submittedAt ?? (r as any).submittedAt;
				const s = new Date(raw);
				if (isNaN(s.getTime())) continue;
				const t = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
				if (t >= startMs && t < endMs) {
					const idx = Math.floor((t - startMs) / (24 * 60 * 60 * 1000));
					if (idx >= 0 && idx < days.length) {
						const bucket = days[idx];
						if (bucket) bucket.count += 1;
					}
				}
			}
			return res.json({ mode: "weekly", weekStart: days[0]!.date, days });
		}

		if (mode === "monthly") {
			// For monthly mode, return week buckets that cover the full calendar month of the provided start date.
			const startParam = String(req.query.start ?? "");
			const requested = parseDateISO(startParam) ?? new Date();
			const year = requested.getUTCFullYear();
			const month = requested.getUTCMonth();
			// monthStart is first day of the month (UTC)
			const monthStart = new Date(Date.UTC(year, month, 1));
			const monthEnd = new Date(Date.UTC(year, month + 1, 1));
			// weekStart is the Monday on or before monthStart
			const day0 = monthStart.getUTCDay();
			const diff0 = (day0 + 6) % 7; // days since Monday
			let weekStart = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), monthStart.getUTCDate() - diff0));
			const weeks = [] as Array<{ start: string; end: string; label: string; count: number }>;
			while (weekStart < monthEnd) {
				const s = new Date(Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate()));
				const e = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() + 7));
				weeks.push({ start: s.toISOString().slice(0, 10), end: e.toISOString().slice(0, 10), label: `${s.toISOString().slice(5, 10)}`, count: 0 });
				weekStart = new Date(Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate() + 7));
			}
			// count events
			for (const r of rows) {
				const raw = (r as any).submitted_at ?? (r as any).submittedAt ?? (r as any).submittedAt;
				const s = new Date(raw);
				if (isNaN(s.getTime())) continue;
				const t = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
				for (let idx = 0; idx < weeks.length; idx++) {
					const ws = weeks[idx]!;
					const wsMs = Date.UTC(Number(ws.start.slice(0, 4)), Number(ws.start.slice(5, 7)) - 1, Number(ws.start.slice(8, 10)));
					const weMs = Date.UTC(Number(ws.end.slice(0, 4)), Number(ws.end.slice(5, 7)) - 1, Number(ws.end.slice(8, 10)));
					if (t >= wsMs && t < weMs) { weeks[idx]!.count += 1; break; }
				}
			}
			return res.json({ mode: "monthly", month: `${year}-${(month + 1).toString().padStart(2, '0')}`, start: weeks[0]?.start ?? monthStart.toISOString().slice(0, 10), weeks });
		}

		if (mode === "yearly") {
			const yearParam = Number(req.query.year ?? new Date().getUTCFullYear());
			const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, label: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][i], count: 0 }));
			for (const r of rows) {
				const raw = (r as any).submitted_at ?? (r as any).submittedAt ?? (r as any).submittedAt;
				const s = new Date(raw);
				if (isNaN(s.getTime())) continue;
				if (s.getUTCFullYear() === yearParam) {
					const mi = s.getUTCMonth();
					if (mi >= 0 && mi < months.length) {
						const bucket = months[mi];
						if (bucket) bucket.count += 1;
					}
				}
			}
			return res.json({ mode: "yearly", year: yearParam, months });
		}

		return res.status(400).json({ error: "Unknown mode" });
	} catch (error) {
		console.error('get_feedback_stats_failed', error);
		res.status(500).json({ error: 'Unable to fetch feedback stats' });
	}
});


export { app };

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
	if (err instanceof SyntaxError && "body" in err) {
		return res
			.status(400)
			.json({ error: "The request body contains invalid JSON." });
	}
	next(err);
});

async function bootstrap(): Promise<void> {
	try {
		await EnsureRestaurantSeed({
			name: "CSR Organics",
			admin: {
				employeeId: "admin",
				name: "Admin",
				password: "admin123",
			},
			tables: [
				{ name: "T1", capacity: 2 },
				{ name: "T2", capacity: 4 },
				{ name: "T3", capacity: 4 },
				{ name: "T4", capacity: 6 },
			],
			profile: {
				address: "12 Example Street, Bengaluru",
				phone: "+91 98765 43210",
				email: "reservations@csrorganics.example",
				hours: "11:00 AM - 11:00 PM",
			},
		});
		console.log("✅ CSR Organics seed ensured");
	} catch (error) {
		console.error("Failed to ensure CSR Organics seed", error);
	}

	const httpServer = createServer(app);
	try {
		await initRealtime(httpServer);
	} catch (err) {
		console.warn("initRealtime failed", err);
	}

	httpServer.listen(port, () => {
		console.log(`Server listening at http://localhost:${port}`);
	});
}

bootstrap().catch(error => {
	console.error("Server bootstrap failed", error);
	process.exit(1);
});
