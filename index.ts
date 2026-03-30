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
	GetBookingsAfterTime,
	HasActiveBooking,
	GetCustomerAndBookings,
	GetCustomerId,
	GetTables,
	UpdateBookingStatus,
	DeleteBooking,
	AssignTableToBooking,
	AddAuditLogEntry,
	GetAuditLogs,
	GetRestaurantUserRole,
	EnsureRestaurantSeed,
	AllocateBestTable,
	AddFeedbackEntry,
	GetFeedbackEntries,
	GetFeedbackSummary,
} from "./database.js";
import {
	OPENAI_REALTIME_MODEL,
	checkAvailabilityForRequest,
	createReceptionSession,
	createReservationForRequest,
	getRestaurantKnowledgeSnapshot,
} from "./realtime_reception_agent.js";
import { initRealtime, emitRestaurant } from "./realtime.js";
import { createServer } from "http";
const app = express();
const port = 3000;

function log(req: Request, res: Response, next: NextFunction) {
	console.log(req);
	next();
}
// app.use(log);

function validate(req: Request, res: Response, next: NextFunction) {
	next();
	// return res.status(400).json({ error: "Auth failed" });
}

type AppRole = "admin" | "employee" | "valet";

function normalizeRole(rawRole: unknown): AppRole | null {
	if (typeof rawRole !== "string") {
		return null;
	}

	const lowered = rawRole.trim().toLowerCase();
	if (lowered === "admin" || lowered === "employee" || lowered === "valet") {
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

async function resolveRoleForRequest(req: Request, restaurantId: string): Promise<AppRole | null> {
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
): Promise<{ restaurantId: string; role: AppRole } | null> {
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
	if (origin && allowedOrigins.has(origin)) {
		res.header("Access-Control-Allow-Origin", origin);
	}
	res.header(
		"Access-Control-Allow-Headers",
		"Content-Type,X-Restaurant-Id,X-Employee-Id,X-User-Role",
	);
	res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
	if (req.method === "OPTIONS") {
		res.sendStatus(204);
		return;
	}
	next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Lightweight health endpoint for readiness/liveness checks
import { getDb } from "./schema.js";
import { ca } from 'zod/v4/locales';

app.get("/health", async (_req: Request, res: Response) => {
	const result: any = { status: "ok", uptime: process.uptime(), time: new Date().toISOString() };
	try {
		const db = await getDb();
		const ping = await db.command({ ping: 1 });
		result.mongo = { ok: ping?.ok === 1 ? true : false };
	} catch (err: any) {
		result.mongo = { ok: false, error: String(err?.message ?? err) };
		result.status = "degraded";
	}
	res.json(result);
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

	return typeof customerId === "string"
		? customerId
		: typeof customerId.toHexString === "function"
			? customerId.toHexString()
			: customerId.toString();
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

app.post("/add-customer", validate, async (req: Request, res: Response) => {
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
app.post("/add-table", validate, async (req: Request, res: Response) => {
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

	res.send(table_name);
});

app.delete("/table/:name", validate, async (req: Request, res: Response) => {
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

	res.status(204).send();
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
app.post("/add-booking", validate, async (req: Request, res: Response) => {
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
	const booking_id =
		typeof booking._id === "string"
			? booking._id
			: typeof booking._id.toHexString === "function"
				? booking._id.toHexString()
				: booking._id.toString();

	try {
		emitRestaurant(restaurantId, "booking:created", { booking_id, table_name: tableName });
	} catch (err) {
		console.warn("emit booking:created failed", err);
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

	app.get("/get-tables", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const timeQuery = Array.isArray(req.query.time) ? req.query.time[0] : req.query.time;
	const requestedTime = typeof timeQuery === "string" ? timeQuery : undefined;
	try {
		const tables = await GetTables(restaurantId, requestedTime);
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

app.get("/valet-info", validate, async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	// Proxy to Python valet service to fetch valet_state records for this restaurant
	try {
		const response = await fetch(
			"http://127.0.0.1:8000/get_all_valet_records/" + encodeURIComponent(auth.restaurantId),
		);

		const records = await response.json();
		if (!response.ok) {
			res.status(response.status).json(records);
			return;
		}

		// records are expected to be an array of valet_state documents
		const now = new Date();

		const bookings = (Array.isArray(records) ? records : []).map((r: any) => {
			const stateNum = typeof r.state === "number" ? r.state : Number(r.state);
			// Map numeric state to frontend stage strings
			const stateMap: Record<number, string> = {
				1: "Vehicle added",
				2: "Parked",
				3: "Request to bring car (from customer)",
				4: "Request accepted (from valet)",
				5: "Car arrived at entrance",
				6: "Customer took car",
			};

			const status = stateMap[stateNum] ?? "Vehicle added";

			return {
				booking_id: r._id ? String(r._id) : r.booking_id ?? undefined,
				customer_name: r.customer_name ?? undefined,
				bay_id: r.bay_id ?? undefined,
				booking_date_time: r.entry_time ?? r.booking_date_time ?? undefined,
				exit_date_time: r.exit_time ?? r.exit_date_time ?? undefined,
				status,
				active: stateNum !== 6,
				number_plate: r.number_plate ?? undefined,
				notes: r.notes ?? (r.number_plate ? `Vehicle Plate: ${r.number_plate}` : undefined),
			};
		});

		// Fetch canonical Bays from Python service and compute capacities
		let bays: any[] = [];
		try {
			const baysResp = await fetch("http://127.0.0.1:8000/get_bays/" + encodeURIComponent(auth.restaurantId));
			const baysData = await baysResp.json();
			if (baysResp.ok && Array.isArray(baysData)) {
				bays = baysData.map((b: any) => ({
					Bay_id: b.Bay_id ?? b.Bay_id,
					Bay_name: b.Bay_name ?? b.Bay_name,
					current_capacity: 0,
					total_capacity: b.total_capacity ?? null,
				}));
			}
		} catch (err) {
			// ignore and fallback to deriving from records
			bays = [];
		}

		if (bays.length === 0) {
			// Fallback: derive bay list from bookings' bay_id values
			const bayIds = Array.from(new Set((bookings.map((b: any) => b.bay_id).filter(Boolean) as string[])));
			bays = bayIds.map((id, idx) => ({
				Bay_id: id,
				Bay_name: id,
				current_capacity: bookings.filter((b: any) => b.bay_id === id && b.active).length,
				total_capacity: null,
			}));
		} else {
			// compute current_capacity based on bookings
			bays = bays.map((bay) => ({
				...bay,
				current_capacity: bookings.filter((b: any) => b.bay_id === bay.Bay_id && b.active).length,
			}));
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


app.patch("/booking/:id/status", validate, async (req: Request, res: Response) => {
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

	res.json({ success: true });
});

app.patch("/booking/:id/table", validate, async (req: Request, res: Response) => {
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

	res.json({ success: true });
});


app.delete("/booking/:id", validate, async (req: Request, res: Response) => {
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
app.get("/get-customers", validate, async (req: Request, res: Response) => {
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
app.get("/get-withen-range", validate, async (req: Request, res: Response) => {
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

	res.send(count);
});

app.get("/audit-logs", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const limitParam = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
	const limit = limitParam ? Number.parseInt(String(limitParam), 10) : 100;

	try {
		const logs = await GetAuditLogs(restaurantId, Number.isFinite(limit) ? limit : 100);
		res.json(logs);
	} catch (error) {
		res.status(500).json({ error: "Unable to fetch audit logs" });
	}
});

app.post("/audit-logs", validate, async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const { employee, action, details } = req.body ?? {};
	if (!employee || !action) {
		res.status(400).json({ error: "Missing employee or action" });
		return;
	}

	try {
		await AddAuditLogEntry(restaurantId, {
			employee: String(employee),
			action: String(action),
			details: details ? String(details) : null,
		});
		res.status(201).json({ success: true });
	} catch (error) {
		res.status(500).json({ error: "Unable to record audit log" });
	}
});



// Rtamanyu's integration
app.get("/valet-bays", validate, async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	try {
		const response = await fetch("http://127.0.0.1:8000/get_bays/" + encodeURIComponent(auth.restaurantId));
		const data = await response.json();
		if (!response.ok) {
			res.status(response.status).json(data);
			return;
		}
		res.json(data);
		return;
	} catch (error) {
		console.error("fetch_valet_bays_failed", error);
		res.status(500).json({ error: "Unable to fetch valet bays" });
		return;
	}
});

app.post("/add-valet-bay", validate, async (req: Request, res: Response) => {
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
		const response = await fetch(
			"http://127.0.0.1:8000/add_bay/" + encodeURIComponent(auth.restaurantId),
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ Bay_name: bayName, total_capacity: Number.isFinite(totalCapacity) ? totalCapacity : 0 }),
			},
		);
		const data = await response.json();
		if (!response.ok) {
			res.status(response.status).json(data);
			return;
		}
		res.json(data);
		return;
	} catch (error) {
		console.error("add_valet_bay_failed", error);
		res.status(500).json({ error: "Unable to add valet bay" });
		return;
	}
});

app.post("/delete-valet-bay", validate, async (req: Request, res: Response) => {
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
		const payload: Record<string, unknown> = {};
		if (bayId) payload.Bay_id = bayId;
		if (bayName) payload.Bay_name = bayName;

		const response = await fetch(
			"http://127.0.0.1:8000/delete_bay/" + encodeURIComponent(auth.restaurantId),
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(payload),
			},
		);

		const data = await response.json();
		if (!response.ok) {
			res.status(response.status).json(data);
			return;
		}

		res.json(data);
		return;
	} catch (error) {
		console.error("delete_valet_bay_failed", error);
		res.status(500).json({ error: "Unable to delete valet bay" });
		return;
	}
});


app.post("/update-valet-bay", validate, async (req: Request, res: Response) => {
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
		const response = await fetch(
			"http://127.0.0.1:8000/update_bay/" + encodeURIComponent(auth.restaurantId),
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ Bay_id: bayId, Bay_name: bayName, total_capacity: Number.isFinite(totalCapacity) ? totalCapacity : 0 }),
			},
		);

		const data = await response.json();
		if (!response.ok) {
			res.status(response.status).json(data);
			return;
		}

		res.json(data);
		return;
	} catch (err) {
		console.error("update_valet_bay_failed", err);
		res.status(500).json({ error: "Unable to update valet bay" });
	}
});


app.post("/set-valet-bay-current", validate, async (req: Request, res: Response) => {
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
		const response = await fetch(
			"http://127.0.0.1:8000/set_bay_current/" + encodeURIComponent(auth.restaurantId),
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ Bay_id: bayId, current_capacity: Number(current) }),
			},
		);

		const data = await response.json();
		if (!response.ok) {
			res.status(response.status).json(data);
			return;
		}

		res.json(data);
		return;
	} catch (err) {
		console.error("set_valet_bay_current_failed", err);
		res.status(500).json({ error: "Unable to set bay current capacity" });
		return;
	}
});

app.post("/create_valet_record", validate, async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) {
		return;
	}

	const body = req.body as Record<string, unknown> | undefined;
	const number_plate = typeof body?.number_plate === 'string' ? body.number_plate.trim() : undefined;
	if (!number_plate) {
		res.status(400).json({ error: "Missing number plate" });
		return;
	}

	try {
		const response = await fetch(
			"http://127.0.0.1:8000/create_valet_record/" + encodeURIComponent(number_plate) + "/" + encodeURIComponent(auth.restaurantId),
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
			},
		);
		const data = await response.json();
		if (!response.ok) {
			res.status(response.status).json(data);
			return;
		}

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

app.post("/get_valet_info", validate, async (req: Request, res: Response) => {
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
		const response = await fetch(
			"http://127.0.0.1:8000/get_valet_info/" + encodeURIComponent(booking_id),
		);
		const data = await response.json();
		if (!response.ok) {
			res.status(response.status).json(data);
			return;
		}
		res.json(data);
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
): Promise<Record<string, unknown>> {
	const response = await fetch(
		"http://127.0.0.1:8000/update_valet_state/" + encodeURIComponent(bookingId) + "/" + encodeURIComponent(state),
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
		},
	);

	const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok) {
		const err = Object.assign(new Error("Unable to update valet state"), {
			status: response.status,
			payload,
		});
		throw err;
	}

	// Centralized publisher path for valet state updates.
	emitRestaurant(restaurantId, "valet:updated", { booking_id: bookingId, state, detail: payload });
	return payload;
}


app.post("/update_valet_state", validate, async (req: Request, res: Response) => {
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
		const data = await updateValetStateAndPublish(auth.restaurantId, booking_id, state);
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

app.post("/update_valet_bay", validate, async (req: Request, res: Response) => {
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
		const response = await fetch(
			"http://127.0.0.1:8000/update_valet_bay/" + encodeURIComponent(booking_id) + "/" + encodeURIComponent(bay_id),
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
			},
		);
		const data = await response.json();
		if (!response.ok) {
			res.status(response.status).json(data);
			return;
		}
		res.json(data);
		return;
	} catch (error) {
		console.error("update_valet_bay_failed", error);
		res.status(500).json({ error: "Unable to update valet bay" });
		return;
	}
});

app.post("/unassign-valet-bay", validate, async (req: Request, res: Response) => {
	const auth = await enforceRoles(req, res, ["admin", "valet"]);
	if (!auth) return;

	const body = req.body as Record<string, unknown> | undefined;
	const booking_id = typeof body?.booking_id === 'string' ? body.booking_id.trim() : undefined;
	if (!booking_id) {
		res.status(400).json({ error: "Missing booking ID" });
		return;
	}

	try {
		const response = await fetch(
			"http://127.0.0.1:8000/unassign_valet_bay/" + encodeURIComponent(booking_id),
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
			},
		);

		const data = await response.json();
		if (!response.ok) {
			res.status(response.status).json(data);
			return;
		}
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
	if(category < 1 || category > 7) {
		res.status(400).json({ error: "Invalid category" });
		return;
	}
	try {
		const response = await fetch(
			"http://127.0.0.1:8000/get_main_feedback_question/" + encodeURIComponent(category),
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
	if(category < 1 || category > 7) {
		res.status(400).json({ error: "Invalid category" });
		return;
	}
	if(rate < 1 || rate > 5) {
		res.status(400).json({ error: "Invalid rate" });
		return;
	}

	try {
		const response = await fetch(
			"http://127.0.0.1:8000/get_follow_up_question/" + encodeURIComponent(category) + "/" + encodeURIComponent(rate),
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
			"http://127.0.0.1:8000/get_follow_up_question/"
				+ encodeURIComponent(categoryLabel)
				+ "/"
				+ encodeURIComponent(rating),
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
		const recordsResponse = await fetch(
			"http://127.0.0.1:8000/get_all_valet_records/" + encodeURIComponent(restaurantId),
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
				await updateValetStateAndPublish(restaurantId, bookingId, "3");
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
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
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

		const saved = await AddFeedbackEntry(restaurantId, {
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

		res.status(201).json({ success: true, id: saved.id, submitted_at: saved.submitted_at });
	} catch (error) {
		console.error("submit_feedback_failed", error);
		res.status(500).json({ error: "Unable to submit feedback" });
	}
});

app.get("/feedback", validate, async (req: Request, res: Response) => {
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

app.get("/feedback/summary", validate, async (req: Request, res: Response) => {
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
