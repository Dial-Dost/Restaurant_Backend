/**
 * Reservations: creating, listing, re-tabling, status transitions, cancellation and
 * range counts.
 */
import type { Express, Request, Response } from "express";
import type { BookingWindow } from "../database_supabase.js";
import { AddBooking, AddNotification, AllocateBestTable, AssignTableToBooking, Audit_log_category, DeleteBooking, GetBookingSummaryById, GetBookingsAfterTime, GetBookingsInRange, GetRestaurantSettings, UpdateBookingDeposit, UpdateBookingStatus, isTerminalBookingStatus, parseWallClockInZone } from "../database_supabase.js";
import { logger } from "../observability.js";
import { emitRestaurant } from "../realtime.js";
import { GetCustomerIdOrCreateCustomer, enforceRoles, extractRestaurantId, log_audit, queueBookingConfirm, requireMobile10, validate, validateAction } from "./_shared.js";


function IsActiveBooking(booking: any, time: Date): boolean {
	const booking_start = new Date(booking.booking_date_time).getTime();
	const booking_end =
		new Date(booking_start).getTime() + booking.duration_mins * 60 * 1000;

	if (booking_start <= time.getTime() && time.getTime() <= booking_end) {
		return true;
	}

	return false;
}

export function registerBookingCreateRoute(app: Express): void {

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
		// Optional clubbed booking: EXTRA tables held alongside table_name (all
		// must exist). Only ever set from an explicit staff choice — the server
		// never clubs tables on its own. See GET /tables/seating-suggestion.
		"combined_table_names": ["T2"],
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

	const customer = req.body.customer;
	if (!(customer.name && customer.number)) {
		res.status(400).json({ error: "Missing customer field(s)" });
		return;
	}
	// Bookings are confirmed/reminded by SMS on this number, so it must be a real
	// 10-digit mobile before a Customers row is created for it.
	const bookingCustomerNumber = requireMobile10(res, customer.number);
	if (!bookingCustomerNumber) {return;}

	const booking_request = req.body.booking;
	if (
		!(
			booking_request?.date &&
			booking_request.duration &&
			booking_request.number_of_people
		)
	) {
		res.status(400).json({ error: "Missing booking field(s)" });
		return;
	}
	const cust_id = await GetCustomerIdOrCreateCustomer(
		restaurantId,
		customer.name,
		bookingCustomerNumber,
		customer.email,
	);
	if (cust_id == null) {
		res.status(400).json({
			error: "Something went wrong in creating/getting customer id",
		});
		return;
	}

	// The documented contract for this field carries a zone designator, and such a
	// string is an absolute instant that parseWallClockInZone passes through
	// untouched. But clients do send a BARE "YYYY-MM-DDTHH:mm" wall clock, and
	// `new Date()` read that in the SERVER's zone — correct on an IST dev box,
	// 5.5h wrong on a UTC prod server. Interpret it in the restaurant's own
	// timezone, exactly as the public /reserve path already does.
	const bookingSettings = await GetRestaurantSettings(restaurantId).catch(() => null);
	const date: Date = parseWallClockInZone(
		String(booking_request.date),
		bookingSettings?.timezone ?? "Asia/Kolkata",
	);
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

	// Clubbed booking: the caller (staff, after accepting a suggestion) names the
	// EXTRA tables explicitly. Never inferred here.
	const combinedRaw = booking_request.combined_table_names ?? booking_request.table_names;
	let combinedTableNames: string[] | null = null;
	if (combinedRaw !== undefined && combinedRaw !== null) {
		if (!Array.isArray(combinedRaw)) {
			res.status(400).json({ error: "combined_table_names must be an array of table names" });
			return;
		}
		combinedTableNames = combinedRaw.map((n: unknown) => String(n ?? "").trim()).filter((n: string) => n.length > 0);
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
				logger.warn({ restaurantId, error: allocErr }, "table_allocation_failed");
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
			null,
			null,
			combinedTableNames,
		);
	} catch (error) {
		logger.warn({ err: error }, "add_booking_failed");
		res.status(400).json({ error: "Oops something went wrong" });
		return;
	}
	const booking_id = String(booking._id);
	const bookingTableNames = booking.table_names;

	try {
		emitRestaurant(restaurantId, "booking:created", { booking_id, table_name: tableName });
	} catch (err) {
		logger.warn({ err }, "emit booking:created failed");
	}

	try {
		await log_audit(req, "3ec33182-ceb4-4d07-ac7e-84214adcf104", `Created booking for customer ${customer.name} at ${booking_request.date}`, Audit_log_category.Bookings, { booking_id, table_name: tableName });
	}
	catch (err) {
		logger.warn({ err }, 'log_audit add-booking failed');
	}
	// Automated guest confirmation — covers staff/dashboard bookings AND the
	// voice reception agent (which books through this endpoint). Fire-and-forget.
	if (req.auth?.res_id) {
		queueBookingConfirm(req.auth.res_id, restaurantId, {
			bookingId: booking_id,
			phone: bookingCustomerNumber,
			party: partySize,
			date,
			table: tableName,
		});
	}
	// table_name stays the primary (unchanged for single-table callers);
	// table_names lists every table the booking holds.
	res.json({ booking_id, table_name: tableName, table_names: bookingTableNames });
});
}


export function registerBookingListRoute(app: Express): void {

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

	// Bug B: `?window=upcoming|past|all` chooses which slice to return. Absent or
	// unrecognised → "upcoming", so the default response is unchanged from before.
	const windowQuery = Array.isArray(req.query.window) ? req.query.window[0] : req.query.window;
	const bookingWindow: BookingWindow =
		windowQuery === "past" || windowQuery === "all" ? windowQuery : "upcoming";

	try {
		bookings = await GetBookingsAfterTime(restaurantId, requestedTime, bookingWindow);
	} catch (error) {
		logger.info(error);
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
			// A booking is only "active" while it holds a live slot — a terminal
			// status (cancelled / completed / seated / no-show) is never active even
			// if its original time window hasn't elapsed yet.
			active: !isTerminalBookingStatus(booking.status) && IsActiveBooking(booking, time),
		})),
	);
});
}


export function registerBookingStatusRoute(app: Express): void {

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

	let updated = false;
	try {
		updated = await UpdateBookingStatus(auth.restaurantId, bookingId, status);
	} catch (error: any) {
		// Seating a party bigger than the table(s) can hold is a 400 with the
		// standard "raise max seats / club another table" message, same as
		// /occupy-table — the booking keeps its previous status.
		logger.error({ err: error }, "update_booking_status_failed");
		res.status(400).json({ error: String(error?.message ?? "Unable to update booking status") });
		return;
	}
	if (!updated) {
		res.status(404).json({ error: "Booking not found" });
		return;
	}

	try {
		emitRestaurant(auth.restaurantId, "booking:status_updated", { booking_id: bookingId, status });
	} catch (err) {
		logger.warn({ err }, "emit booking:status_updated failed");
	}

	try {
		await log_audit(req, "fdeecab6-7c3a-4239-b87c-99a96f50c551", `Updated booking status to ${status} for booking ${bookingId}`, Audit_log_category.Bookings, { booking_id: bookingId, status });
	}
	catch (err) {
		logger.warn({ err }, "log_audit booking-status-update failed");
	}

	res.json({ success: true });
});
}


export function registerBookingTableAndCancelRoutes(app: Express): void {

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

	// Clubbed assignment: omit the key to leave the current set alone, send [] to
	// un-club back to the single primary table.
	const combinedRaw = req.body?.combined_table_names;
	let combinedTableNames: string[] | undefined;
	if (combinedRaw !== undefined && combinedRaw !== null) {
		if (!Array.isArray(combinedRaw)) {
			res.status(400).json({ error: "combined_table_names must be an array of table names" });
			return;
		}
		combinedTableNames = combinedRaw.map((n: unknown) => String(n ?? "").trim()).filter((n: string) => n.length > 0);
	}

	try {
		const updated = await AssignTableToBooking(auth.restaurantId, bookingId, tableName, combinedTableNames);
		if (!updated) {
			res.status(404).json({ error: "Booking not found" });
			return;
		}
	} catch (error) {
		res.status(400).json({ error: "Unable to assign table" });
		return;
	}

	try {
		await log_audit(req, "c7699d46-0e2f-4448-b325-8ca490a5296b", `Assigned table ${[tableName ?? 'null', ...(combinedTableNames ?? [])].join(' + ')} to booking ${bookingId}`, Audit_log_category.Bookings, { booking_id: bookingId, table_name: tableName, combined_table_names: combinedTableNames ?? null });
	} catch (err) {
		logger.warn({ err }, 'log_audit assign-table-to-booking failed');
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

	// Deposit-paid bookings are NOT hard-deleted on cancel: the row is kept as
	// the deposit record (status Cancelled) so staff can see whether the money is
	// refund_due (cancelled earlier than the cancel window before the slot) or
	// forfeited (late cancel). Refunds are made MANUALLY from the restaurant's
	// Razorpay dashboard — no automatic gateway refund is attempted.
	const existing = await GetBookingSummaryById(restaurantId, bookingId).catch(() => null);
	if (existing?.deposit?.status === "paid") {
		const settings = await GetRestaurantSettings(restaurantId).catch(() => null);
		const windowH = settings?.booking_cancel_window_hours ?? 24;
		const start = new Date(existing.booking_date_time).getTime();
		const earlyCancel = Number.isFinite(start) && Date.now() < start - windowH * 3_600_000;
		const depositStatus = earlyCancel ? "refund_due" as const : "forfeited" as const;
		await UpdateBookingDeposit(restaurantId, bookingId, { deposit_status: depositStatus, slot_status: "Cancelled" });
		try {
			await AddNotification(restaurantId, {
				type: "reservation",
				title: earlyCancel ? `Refund due ₹${existing.deposit.amount} to ${existing.customer_name}` : `Deposit ₹${existing.deposit.amount} forfeited`,
				body: earlyCancel
					? `Booking cancelled outside the ${windowH}h window — refund the deposit from your Razorpay dashboard (payment ${existing.deposit.payment_id ?? "n/a"}).`
					: `${existing.customer_name} cancelled inside the ${windowH}h window — deposit is kept.`,
				meta: { booking_id: bookingId, deposit_status: depositStatus, deposit_amount: existing.deposit.amount },
			});
		} catch {/* ignore */}
		try {
			emitRestaurant(restaurantId, "booking:status_updated", { booking_id: bookingId, status: "Cancelled" });
		} catch (err) {
			logger.warn({ err }, "emit booking:cancelled failed");
		}
		try {
			await log_audit(req, "1f176202-d5e7-4bb0-802c-275a42425394", `Canceled booking ${bookingId} (deposit ₹${existing.deposit.amount} ${depositStatus})`, Audit_log_category.Bookings, { booking_id: bookingId, deposit_status: depositStatus });
		} catch (err) {
			logger.warn({ err }, 'log_audit delete-booking failed');
		}
		res.json({ success: true, deposit_status: depositStatus });
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
		logger.warn({ err }, "emit booking:deleted failed");
	}

	try {
		await log_audit(req, "1f176202-d5e7-4bb0-802c-275a42425394", `Canceled booking ${bookingId}`, Audit_log_category.Bookings, { booking_id: bookingId });
	} catch (err) {
		logger.warn({ err }, 'log_audit delete-booking failed');
	}

	res.status(204).send();
});
}


export function registerBookingRangeRoute(app: Express): void {

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
	if (!(req.body.start && req.body.end)) {
		res.status(400).send({ Error: "Missing fields" });
	}

	const start = new Date(req.body.start);
	const end = new Date(req.body.end);

	if (isNaN(start.valueOf()) || isNaN(end.valueOf())) {
		res.status(400).send({
			Error: "Dates provided is not formated correctley",
		});
	}

	const count = await GetBookingsInRange(restaurantId, start, end);

	if (count == null) {
		res.status(400).send({ Error: "Oops something went wrong" });
	}

	try {
		/* read action — not audited (avoids log clutter) */
	} catch (err) {
		logger.warn({ err }, 'log_audit get-withen-range failed');
	}

	res.send(count);
});
}
