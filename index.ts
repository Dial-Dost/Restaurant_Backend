import type { NextFunction, Request, Response } from "express";
import express from "express";
import {
	AddBooking,
	GetBookingsInRange,
	AddCustomer,
	AddEmailToCustomer,
	AddTable,
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
	EnsureRestaurantSeed,
} from "./database.js";
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

app.use((req: Request, res: Response, next: NextFunction) => {
	res.header("Access-Control-Allow-Origin", "http://localhost:9002");
	res.header("Access-Control-Allow-Headers", "Content-Type,X-Restaurant-Id");
	res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
	next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

	res.send(table_name);
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
	try {
		booking = await AddBooking(
			restaurantId,
			cust_id,
			date,
			durationMinutes,
			partySize,
			booking_request.table_name,
			booking_request.source,
			booking_request.status ?? "Confirmed",
			booking_request.from,
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

	res.json({ booking_id });
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


app.patch("/booking/:id/status", validate, async (req: Request, res: Response) => {
	const rawId = req.params.id;
	const status = req.body?.status;
	const bookingId = typeof rawId === "string" ? rawId.trim() : "";
	if (!status || !bookingId) {
		res.status(400).json({ error: "Missing or invalid status/booking id" });
		return;
	}

	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const updated = await UpdateBookingStatus(restaurantId, bookingId, status);
	if (!updated) {
		res.status(404).json({ error: "Booking not found" });
		return;
	}

	res.json({ success: true });
});

app.patch("/booking/:id/table", validate, async (req: Request, res: Response) => {
	const rawId = req.params.id;
	const bookingId = typeof rawId === "string" ? rawId.trim() : "";
	if (!bookingId) {
		res.status(400).json({ error: "Invalid booking id" });
		return;
	}

	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) {
		res.status(400).json({ error: "Missing restaurantId" });
		return;
	}

	const tableNameRaw = req.body?.table_name;
	const tableName =
		tableNameRaw === null || tableNameRaw === undefined
			? null
			: String(tableNameRaw).trim() || null;

	try {
		const updated = await AssignTableToBooking(restaurantId, bookingId, tableName);
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

	app.listen(port, () => {
		console.log(`Server listening at http://localhost:${port}`);
	});
}

bootstrap().catch(error => {
	console.error("Server bootstrap failed", error);
	process.exit(1);
});
