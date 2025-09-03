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
} from "./database.ts";
import e from "express";
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

app.use((req, res, next) => {
	res.header("Access-Control-Allow-Origin", "http://localhost:9002");
	res.header("Access-Control-Allow-Headers", "Content-Type");
	res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
	next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

async function GetCustomerIdOrCreateCustomer(
	name: string,
	number: string,
	email?: string | undefined,
): Promise<number | null> {
	let customer = { name, number, email };
	let cust_id: number | null = await GetCustomerId(
		customer.name,
		customer.number,
	);
	if (cust_id == null) {
		cust_id = (
			await AddCustomer(customer.name, customer.number, customer.email)
		).dataValues.customer_id;
	}

	if (cust_id && customer.email) {
		AddEmailToCustomer(cust_id, customer.email);
	}

	return cust_id;
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

app.post("/add-customer", validate, async (req, res) => {
	let customer = req.body.customer;
	if (!(customer.name && customer.number)) {
		res.status(400).json({ error: "Missing required fields" });
		return;
	}

	let cust_id = await GetCustomerIdOrCreateCustomer(
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
app.post("/add-table", validate, async (req, res) => {
	let table = req.body.table;
	if (!table.name) {
		res.status(400).json({ error: "Missing required fields" });
		return;
	}

	let table_name;
	try {
		table_name = (await AddTable(table.name, parseInt(table.capacity)))
			.dataValues.table_name;
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
app.post("/add-booking", validate, async (req, res) => {
	let customer = req.body.customer;
	if (!(customer.name && customer.number)) {
		res.status(400).json({ error: "Missing customer field(s)" });
		return;
	}

	let booking_request = req.body.booking;
	if (
		!(
			booking_request.table_name &&
			booking_request.date &&
			booking_request.duration &&
			booking_request.number_of_people
		)
	) {
		res.status(400).json({ error: "Missing booking field(s)" });
		return;
	}
	let cust_id = await GetCustomerIdOrCreateCustomer(
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

	let booking;
	try {
		booking = await AddBooking(
			cust_id,
			booking_request.table_name,
			date,
			booking_request.duration,
			booking_request.number_of_people,
			booking_request.source,
		);
	} catch (error) {
		res.status(400).json({ error: "Oops something went wrong" });
		return;
	}
	let booking_id = booking.dataValues.booking_id;

	res.json(booking_id);
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

app.get("/get-tables", validate, async (req, res) => {
	let tables;
	try {
		tables = await GetTables();
		if (tables == null) {
			tables = [];
		}
	} catch (e) {
		res.status(400).send({ error: "Oops something went wrong" });
		return;
	}
	res.send(tables);
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
app.get("/get-bookings", validate, async (req, res) => {
	let bookings;
	let time = new Date();

	try {
		bookings = await GetBookingsAfterTime();
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
		bookings.map((booking) => {
			booking.active = IsActiveBooking(booking, time);
			return booking;
		}),
	);
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
app.get("/get-customers", validate, async (req, res) => {
	let customers;
	try {
		customers = await GetCustomerAndBookings();
	} catch {
		res.status(400).send({ error: "Oops something went wrong" });
		return;
	}

	let promises = customers.map(async (x) => {
		x["has_booking"] = await HasActiveBooking(x["customer_id"]);
		return x;
	});

	let customers_with_bookings = await Promise.all(promises);

	res.send(customers_with_bookings);
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
app.get("/get-withen-range", validate, async (req, res) => {
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

	let count = await GetBookingsInRange(start, end);

	if (count == null) {
		res.status(400).send({ Error: "Oops something went wrong" });
	}

	res.send(count);
});

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
	if (err instanceof SyntaxError && "body" in err) {
		return res
			.status(400)
			.json({ error: "The request body contains invalid JSON." });
	}
	next(err);
});

app.listen(port, () => {
	console.log(`Server listening at http://localhost:${port}`);
});
