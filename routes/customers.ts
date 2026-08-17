/**
 * Customer directory: creation, listing, insights and segments.
 */
import type { Express, Request, Response } from "express";
import { Audit_log_category, GetCustomerAndBookings, GetCustomerInsights, GetCustomerSegments, HasActiveBooking } from "../database_supabase.js";
import { logger } from "../observability.js";
import { GetCustomerIdOrCreateCustomer, clampLimit, extractRestaurantId, log_audit, requireMobile10, validateAction } from "./_shared.js";


export function registerCustomerCreateRoute(app: Express): void {

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

	const customer = req.body.customer;
	if (!(customer.name && customer.number)) {
		res.status(400).json({ error: "Missing required fields" });
		return;
	}
	// The customer's number IS their CRM identity (GetCustomerId matches on
	// name + number), so a partial one silently creates a duplicate person.
	const customerNumber = requireMobile10(res, customer.number);
	if (!customerNumber) {return;}

	// Optional aggregated-analytics demographics (gender / age group / pincode).
	const demographics = {
		gender: typeof customer.gender === "string" ? customer.gender : null,
		age_group: typeof customer.age_group === "string" ? customer.age_group : null,
		pincode: typeof customer.pincode === "string" ? customer.pincode : null,
	};
	const cust_id = await GetCustomerIdOrCreateCustomer(
		restaurantId,
		customer.name,
		customerNumber,
		customer.email,
		demographics,
	);

	try {
		await log_audit(req, "daf1d71f-2b37-4cd1-b951-28fece7719cd", `Created or linked customer ${customer.name}`, Audit_log_category.Customer, { customer_id: cust_id });
	} catch (err) {
		logger.warn({ err }, 'log_audit add-customer failed');
	}

	res.send(cust_id);
});
}


export function registerCustomerQueryRoutes(app: Express): void {

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
		/* read action — not audited (avoids log clutter) */
	} catch (err) {
		logger.warn({ err }, 'log_audit get-customers failed');
	}

	res.send(customersWithStatus);
});

// Guest CRM insights: per-customer visits / spend / last visit / avg feedback
// rating + segment (new | regular | high-spend | dormant). Same permission as
// the customer list so the CRM page loads both together.
app.get("/customers/insights", validateAction("3c530903-324c-4bbe-802b-849763518920"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		res.json(await GetCustomerInsights(restaurantId));
	} catch (err) {
		logger.error({ err }, "get_customer_insights_failed");
		res.status(500).json({ error: "Unable to fetch customer insights" });
	}
});

// Server-side segmentation, sorting and paging for the CRM list, so the app
// ranks the WHOLE guest book instead of re-sorting whichever page it happens to
// hold. Same permission as the customer list it belongs beside.
//
// Spend here is the TAX-INCLUSIVE total actually charged on settled bills, with
// the service charge separated out — /get-customers and /customers/insights size
// spend from raw order totals instead, so this endpoint's figures will be higher
// and are the ones that reconcile against a receipt. See GetCustomerSegments.
//
// Paged exactly like /audit-logs: bare array by default, metadata in headers,
// ?meta=1 for the enveloped body (which also carries the segment counts).
app.get("/customers/segments", validateAction("3c530903-324c-4bbe-802b-849763518920"), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const limit = clampLimit(req.query.limit, 100, 500);
	const offset = Math.max(0, Math.min(Number(req.query.offset) || 0, 100000));
	const daysRaw = typeof req.query.days === "string" ? Number.parseInt(req.query.days, 10) : 365;
	const wantMeta = req.query.meta === "1" || req.query.meta === "true";
	try {
		const page = await GetCustomerSegments(restaurantId, {
			sort: typeof req.query.sort === "string" ? req.query.sort : undefined,
			segment: typeof req.query.segment === "string" ? req.query.segment : undefined,
			search: typeof req.query.search === "string" ? req.query.search : undefined,
			days: Number.isFinite(daysRaw) ? daysRaw : 365,
			limit,
			offset,
		});
		res.setHeader("X-Total-Count", String(page.total));
		res.setHeader("X-Has-More", page.has_more ? "1" : "0");
		if (wantMeta) { res.json(page); return; }
		res.json(page.customers);
	} catch (err) {
		logger.error({ err }, "customer_segments_failed");
		res.status(500).json({ error: "Unable to fetch customer segments" });
	}
});
}
