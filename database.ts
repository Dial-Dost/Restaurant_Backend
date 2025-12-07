import {
	ObjectId,
	type Document,
	type OptionalUnlessRequiredId,
	type WithId,
} from "mongodb";
import { getCollection, getDb } from "./schema.js";

interface CustomerFields extends Document {
	restaurant_id: string;
	name: string;
	phone_number: string;
	email?: string | null;
	name_lower: string;
	phone_normalized: string;
	created_at: Date;
}

interface TableFields extends Document {
	restaurant_id: string;
	table_name: string;
	capacity?: number | null;
	created_at: Date;
}

interface BookingFields extends Document {
	restaurant_id: string;
	customer_id: ObjectId;
	table_name: string | null;
	booking_date_time: Date;
	duration_mins: number;
	number_of_people: number;
	source?: string | null;
	status?: string | null;
	from?: string | null;
	notes?: string | null;
	created_at: Date;
}

interface AuditLogFields extends Document {
	restaurant_id: string;
	employee: string;
	action: string;
	details?: string | null;
	timestamp: Date;
}

type CustomerDoc = WithId<CustomerFields>;
type TableDoc = WithId<TableFields>;
type BookingDoc = WithId<BookingFields>;
type AuditLogDoc = WithId<AuditLogFields>;

type BookingSummary = {
	booking_id: string;
	customer_id: string;
	customer_name: string;
	table_name: string | null;
	booking_date_time: Date;
	duration_mins: number;
	number_of_people: number;
	source?: string | null;
	status?: string | null;
	from?: string | null;
	notes?: string | null;
};

type TableAvailability = {
	table_name: string;
	capacity: number | null;
	booked: boolean;
	reserved: boolean;
};

type CustomerSummary = {
	customer_id: string;
	name: string;
	phone_number: string;
	email?: string | null;
	booking_count: number;
};

type RestaurantUser = {
	employeeId: string;
	name: string;
	password?: string | null;
	role: "admin" | "employee";
};

type RestaurantTable = {
	id: number;
	name: string;
	capacity: number | null;
	status: "Available" | "Booked";
};

type RestaurantData = {
	profile: {
		name: string;
		address: string;
		phone: string;
		email: string;
		hours: string;
	};
	bookings: any[];
	customers: any[];
	inventory: any[];
	menuItems: any[];
	menuCategories: string[];
	orders: any[];
	tables: RestaurantTable[];
	auditLogs: any[];
};

type RestaurantDoc = WithId<{
	id: string;
	name: string;
	users: RestaurantUser[];
	data: RestaurantData;
}>;

const MINUTE_IN_MS = 60_000;

type NewCustomerDoc = OptionalUnlessRequiredId<CustomerFields>;
type NewTableDoc = OptionalUnlessRequiredId<TableFields>;
type NewBookingDoc = OptionalUnlessRequiredId<BookingFields>;
type NewAuditLogDoc = OptionalUnlessRequiredId<AuditLogFields>;

let indexesEnsured = false;
let ensureIndexesPromise: Promise<void> | null = null;

function normalizeName(name: string): string {
	return name.trim().toLowerCase();
}

function normalizePhone(number: string): string {
	return number.replace(/[^0-9+]/g, "");
}

function normalizeRestaurantId(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toObjectId(id: string | ObjectId): ObjectId {
	if (id instanceof ObjectId) {
		return id;
	}
	return new ObjectId(id);
}

function ensureValidDate(date: Date): void {
	if (Number.isNaN(date.getTime())) {
		throw new Error("Invalid date supplied");
	}
}

async function ensureIndexes(): Promise<void> {
	if (indexesEnsured) {
		return;
	}

	if (!ensureIndexesPromise) {
		ensureIndexesPromise = (async () => {
			const db = await getDb();
			const customers = db.collection<CustomerDoc>("customers");
			const tables = db.collection<TableDoc>("tables");
			const bookings = db.collection<BookingDoc>("bookings");
			const auditLogs = db.collection<AuditLogDoc>("audit_logs");
			const restaurants = db.collection<RestaurantDoc>("restaurants");

			await Promise.allSettled([
				customers.createIndex(
					{ restaurant_id: 1, name_lower: 1, phone_normalized: 1 },
					{ unique: true, name: "customer_identity_per_restaurant" },
				),
				tables.createIndex(
					{ restaurant_id: 1, table_name: 1 },
					{ unique: true, name: "table_name_per_restaurant" },
				),
				bookings.createIndex(
					{ restaurant_id: 1, customer_id: 1 },
					{ name: "booking_customer_per_restaurant" },
				),
				bookings.createIndex(
					{ restaurant_id: 1, table_name: 1, booking_date_time: 1 },
					{ name: "booking_table_time_per_restaurant" },
				),
				bookings.createIndex(
					{ booking_date_time: 1 },
					{ name: "booking_datetime_auto_expire_2h", expireAfterSeconds: 2 * 60 * 60 },
				),
				auditLogs.createIndex(
					{ restaurant_id: 1, timestamp: -1 },
					{ name: "audit_logs_recent_per_restaurant" },
				),
				restaurants.createIndex(
					{ id: 1 },
					{ unique: true, name: "restaurant_id_unique" },
				),
			]);
			indexesEnsured = true;
		})();
	}

	return ensureIndexesPromise;
}

async function customersCollection() {
	await ensureIndexes();
	return getCollection<CustomerFields>("customers");
}

async function tablesCollection() {
	await ensureIndexes();
	return getCollection<TableFields>("tables");
}

async function bookingsCollection() {
	await ensureIndexes();
	return getCollection<BookingFields>("bookings");
}

async function auditLogsCollection() {
	await ensureIndexes();
	return getCollection<AuditLogFields>("audit_logs");
}

async function restaurantsCollection() {
	await ensureIndexes();
	return getCollection<RestaurantDoc>("restaurants");
}

export async function AddCustomer(
	restaurantId: string,
	name: string,
	number: string,
	email?: string,
): Promise<CustomerDoc> {
	const customers = await customersCollection();
	const doc: NewCustomerDoc = {
		restaurant_id: restaurantId,
		name: name.trim(),
		phone_number: number.trim(),
		email: email ?? null,
		name_lower: normalizeName(name),
		phone_normalized: normalizePhone(number),
		created_at: new Date(),
	};
	const result = await customers.insertOne(doc);
	return { ...doc, _id: result.insertedId } as CustomerDoc;
}

export async function AddTable(
	restaurantId: string,
	table_name: string,
	capacity?: number,
): Promise<TableDoc> {
	const tables = await tablesCollection();
	const existing = await tables.findOne({ restaurant_id: restaurantId, table_name });
	if (existing) {
		throw new Error("Table already exists");
	}
	const doc: NewTableDoc = {
		restaurant_id: restaurantId,
		table_name,
		capacity: typeof capacity === "number" ? capacity : null,
		created_at: new Date(),
	};
	const result = await tables.insertOne(doc);
	return { ...doc, _id: result.insertedId } as TableDoc;
}

export async function RemoveTable(
	restaurantId: string,
	table_name: string,
): Promise<boolean> {
	const tables = await tablesCollection();
	const deleteResult = await tables.deleteOne({ restaurant_id: restaurantId, table_name });
	return deleteResult.deletedCount > 0;
}

export async function AddBooking(
	restaurantId: string,
	customer_id: string | ObjectId,
	booking_date_time: Date,
	duration: number,
	number_of_people: number,
	table_name?: string | null,
	source?: string,
	status?: string,
	from?: string,
	notes?: string | null,
): Promise<BookingDoc> {
	ensureValidDate(booking_date_time);
	const bookings = await bookingsCollection();
	const customerObjectId = toObjectId(customer_id);
	const normalizedTableName = table_name?.trim() ?? null;

	if (normalizedTableName) {
		const tables = await tablesCollection();
		const tableExists = await tables.findOne({
			restaurant_id: restaurantId,
			table_name: normalizedTableName,
		});
		if (!tableExists) {
			throw new Error("Table not found for restaurant");
		}
	}
	const doc: NewBookingDoc = {
		restaurant_id: restaurantId,
		customer_id: customerObjectId,
		table_name: normalizedTableName,
		booking_date_time,
		duration_mins: duration,
		number_of_people,
		source: source ?? null,
		status: status ?? null,
		from: from ?? null,
		notes: notes ?? null,
		created_at: new Date(),
	};
	const result = await bookings.insertOne(doc);
	return { ...doc, _id: result.insertedId } as BookingDoc;
}

export async function GetCustomerId(
	restaurantId: string,
	name: string,
	number: string,
): Promise<ObjectId | null> {
	const customers = await customersCollection();
	const customer = await customers.findOne({
		restaurant_id: restaurantId,
		name_lower: normalizeName(name),
		phone_normalized: normalizePhone(number),
	});
	return customer?._id ?? null;
}

export async function AddEmailToCustomer(
	restaurantId: string,
	cust_id: string | ObjectId,
	email: string,
): Promise<void> {
	const customers = await customersCollection();
	await customers.updateOne(
		{ _id: toObjectId(cust_id), restaurant_id: restaurantId },
		{ $set: { email } },
	);
}

export async function GetTables(
	restaurantId: string,
	time?: string,
): Promise<TableAvailability[] | null> {
	const at = time ? new Date(time) : new Date();
	if (Number.isNaN(at.getTime())) {
		return null;
	}

	const tables = await tablesCollection();
	const bookings = await bookingsCollection();

	const tablesList = await tables
		.find({ restaurant_id: restaurantId }, { projection: { table_name: 1, capacity: 1 } })
		.sort({ capacity: 1, table_name: 1 })
		.toArray();

	const activeBookings = await bookings
		.aggregate<{ table_name: string }>([
			{ $match: { restaurant_id: restaurantId, table_name: { $ne: null } } },
			{
				$addFields: {
					booking_end: {
						$add: ["$booking_date_time", { $multiply: ["$duration_mins", MINUTE_IN_MS] }],
					},
				},
			},
			{
				$match: {
					booking_date_time: { $lte: at },
					booking_end: { $gt: at },
				},
			},
			{ $project: { table_name: 1 } },
		])
		.toArray();

	const dayEnd = new Date(at);
	dayEnd.setHours(23, 59, 59, 999);
	const upcomingBookings = await bookings
		.find(
			{
				restaurant_id: restaurantId,
				table_name: { $ne: null },
				booking_date_time: { $gt: at, $lte: dayEnd },
			},
			{ projection: { table_name: 1 } },
		)
		.toArray();

	const bookedTables = new Set(
		activeBookings.map((booking: { table_name: string }) => booking.table_name),
	);
	const reservedTables = new Set(
		upcomingBookings.map((booking: { table_name: string }) => booking.table_name),
	);

	return tablesList.map((table: { table_name: string; capacity?: number | null }) => ({
		table_name: table.table_name,
		capacity: table.capacity ?? null,
		booked: table.table_name ? bookedTables.has(table.table_name) : false,
		reserved: table.table_name ? reservedTables.has(table.table_name) : false,
	}));
}

// Determine table availability for an interval [start, end) and return the free tables with their capacities
export async function GetAvailableTablesForInterval(
	restaurantId: string,
	start: Date,
	durationMins: number,
): Promise<Array<{ table_name: string; capacity: number | null }>> {
	ensureValidDate(start);
	const end = new Date(start.getTime() + durationMins * MINUTE_IN_MS);
	const tables = await tablesCollection();
	const bookings = await bookingsCollection();

	const allTables = await tables
		.find({ restaurant_id: restaurantId }, { projection: { table_name: 1, capacity: 1 } })
		.toArray();

	// Find tables that have an overlapping booking with [start, end)
	const overlapping = await bookings
		.aggregate<{ table_name: string }>([
			{ $match: { restaurant_id: restaurantId, table_name: { $ne: null } } },
			{
				$addFields: {
					booking_end: {
						$add: ["$booking_date_time", { $multiply: ["$duration_mins", MINUTE_IN_MS] }],
					},
				},
			},
			{
				$match: {
					$expr: {
						$and: [
							{ $lt: ["$booking_date_time", end] }, // starts before end
							{ $gt: ["$booking_end", start] }, // ends after start
						],
					},
				},
			},
			{ $project: { table_name: 1 } },
		])
		.toArray();

	const busy = new Set(overlapping.map(o => o.table_name));
	return allTables
		.filter(t => !busy.has(t.table_name))
		.map(t => ({ table_name: t.table_name, capacity: t.capacity ?? null }));
}

// Pick the smallest capacity table that can fit partySize (>= partySize). If none, return null.
export async function AllocateBestTable(
	restaurantId: string,
	start: Date,
	durationMins: number,
	partySize: number,
): Promise<string | null> {
	const free = await GetAvailableTablesForInterval(restaurantId, start, durationMins);
	if (free.length === 0) return null;
	// Partition into fit and too-small; choose minimal capacity among fit
	const fit = free.filter(t => (t.capacity ?? Infinity) >= partySize);
	if (fit.length === 0) return null;
	fit.sort((a, b) => {
		const ca = a.capacity ?? Number.MAX_SAFE_INTEGER;
		const cb = b.capacity ?? Number.MAX_SAFE_INTEGER;
		if (ca !== cb) return ca - cb;
		return a.table_name.localeCompare(b.table_name);
	});
	const chosen = fit[0];
	return chosen ? chosen.table_name : null;
}

export async function GetBookingsAfterTime(
	restaurantId: string,
	time?: string,
): Promise<BookingSummary[] | null> {
	const at = time ? new Date(time) : new Date();
	if (Number.isNaN(at.getTime())) {
		return null;
	}

	const bookings = await bookingsCollection();

	const results = await bookings
		.aggregate<BookingSummary>([
			{ $match: { restaurant_id: restaurantId } },
			{
				$addFields: {
					booking_end: {
						$add: ["$booking_date_time", { $multiply: ["$duration_mins", MINUTE_IN_MS] }],
					},
				},
			},
			{ $match: { booking_end: { $gt: at } } },
			{
				$lookup: {
					from: "customers",
					localField: "customer_id",
					foreignField: "_id",
					as: "customer",
				},
			},
			{ $unwind: "$customer" },
			{
				$project: {
					booking_id: { $toString: "$_id" },
					customer_id: { $toString: "$customer._id" },
					customer_name: "$customer.name",
					table_name: 1,
					booking_date_time: 1,
					duration_mins: 1,
					number_of_people: 1,
					source: 1,
					status: 1,
					from: 1,
					notes: 1,
				},
			},
			{ $sort: { booking_date_time: 1 } },
		])
		.toArray();

	return results;
}

export async function UpdateBookingStatus(
	restaurantId: string,
	booking_id: string | ObjectId,
	status: string,
): Promise<boolean> {
	const bookings = await bookingsCollection();
	const updateResult = await bookings.updateOne(
		{ _id: toObjectId(booking_id), restaurant_id: restaurantId },
		{ $set: { status } },
	);
	return updateResult.matchedCount > 0;
}

export async function DeleteBooking(
	restaurantId: string,
	booking_id: string | ObjectId,
): Promise<boolean> {
	const bookings = await bookingsCollection();
	const deleteResult = await bookings.deleteOne({
		_id: toObjectId(booking_id),
		restaurant_id: restaurantId,
	});
	return deleteResult.deletedCount > 0;
}

export async function AssignTableToBooking(
	restaurantId: string,
	booking_id: string | ObjectId,
	table_name: string | null,
): Promise<boolean> {
	const normalized = table_name?.trim() ?? null;
	if (normalized) {
		const tables = await tablesCollection();
		const tableExists = await tables.findOne({
			restaurant_id: restaurantId,
			table_name: normalized,
		});
		if (!tableExists) {
			throw new Error("Table not found for restaurant");
		}
	}

	const bookings = await bookingsCollection();
	const updateResult = await bookings.updateOne(
		{ _id: toObjectId(booking_id), restaurant_id: restaurantId },
		{ $set: { table_name: normalized } },
	);
	return updateResult.matchedCount > 0;
}

export async function GetCustomerAndBookings(
	restaurantId: string,
): Promise<CustomerSummary[]> {
	const customers = await customersCollection();
	const results = await customers
		.aggregate<CustomerSummary>([
			{ $match: { restaurant_id: restaurantId } },
			{
				$lookup: {
					from: "bookings",
					localField: "_id",
					foreignField: "customer_id",
					as: "bookings",
				},
			},
			{
				$addFields: {
					booking_count: { $size: "$bookings" },
				},
			},
			{
				$project: {
					customer_id: { $toString: "$_id" },
					name: "$name",
					phone_number: "$phone_number",
					email: "$email",
					booking_count: 1,
				},
			},
			{ $sort: { name: 1 } },
		])
		.toArray();

	return results;
}

export async function HasActiveBooking(
	restaurantId: string,
	cust_id: string | ObjectId,
	time?: Date,
): Promise<boolean> {
	const checkTime = time ?? new Date();
	const bookings = await bookingsCollection();
	const activeBooking = await bookings
		.aggregate<{ _id: ObjectId }>([
			{
				$match: {
					restaurant_id: restaurantId,
					customer_id: toObjectId(cust_id),
				},
			},
			{
				$addFields: {
					booking_end: {
						$add: ["$booking_date_time", { $multiply: ["$duration_mins", MINUTE_IN_MS] }],
					},
				},
			},
			{
				$match: {
					booking_date_time: { $lte: checkTime },
					booking_end: { $gt: checkTime },
				},
			},
			{ $limit: 1 },
		])
		.next();

	return Boolean(activeBooking);
}

export async function GetBookingsInRange(
	restaurantId: string,
	start: Date,
	end: Date,
): Promise<number | null> {
	try {
		ensureValidDate(start);
		ensureValidDate(end);
		const bookings = await bookingsCollection();
		const count = await bookings.countDocuments({
			restaurant_id: restaurantId,
			booking_date_time: { $gte: start, $lte: end },
		});
		return count;
	} catch (error) {
		console.error("Error counting bookings in range:", error);
		return null;
	}
}

export type AuditLogEntry = {
	id: string;
	employee: string;
	action: string;
	details?: string | null;
	timestamp: Date;
};

export async function AddAuditLogEntry(
	restaurantId: string,
	entry: { employee: string; action: string; details?: string | null },
): Promise<void> {
	const logs = await auditLogsCollection();
	const logDoc: NewAuditLogDoc = {
		restaurant_id: restaurantId,
		employee: entry.employee,
		action: entry.action,
		details: entry.details ?? null,
		timestamp: new Date(),
	};
	await logs.insertOne(logDoc);
}

export async function GetAuditLogs(
	restaurantId: string,
	limit = 100,
): Promise<AuditLogEntry[]> {
	const logs = await auditLogsCollection();
	const docs = await logs
		.find({ restaurant_id: restaurantId })
		.sort({ timestamp: -1 })
		.limit(limit)
		.toArray();

	return docs.map((doc: AuditLogDoc) => ({
		id: doc._id.toHexString(),
		employee: doc.employee,
		action: doc.action,
		details: doc.details ?? null,
		timestamp: doc.timestamp,
	}));
}

type RestaurantSeedInput = {
	id?: string;
	name: string;
	admin: {
		employeeId: string;
		name: string;
		password: string;
	};
	tables: Array<{
		name: string;
		capacity: number;
	}>;
	profile?: {
		address?: string;
		phone?: string;
		email?: string;
		hours?: string;
	};
};

export async function EnsureRestaurantSeed(seed: RestaurantSeedInput): Promise<void> {
	const restaurantId = seed.id ?? normalizeRestaurantId(seed.name);
	const restaurants = await restaurantsCollection();
	const profile = seed.profile ?? {};

	const desiredProfile = {
		name: seed.name,
		address: profile.address ?? "",
		phone: profile.phone ?? "",
		email: profile.email ?? "",
		hours: profile.hours ?? "",
	};

	let restaurant = await restaurants.findOne({ id: restaurantId });

	if (!restaurant) {
		const tablesData: RestaurantTable[] = seed.tables.map((table, index) => ({
			id: index + 1,
			name: table.name,
			capacity: table.capacity,
			status: "Available",
		}));
		const newDoc: Omit<RestaurantDoc, "_id"> = {
			id: restaurantId,
			name: seed.name,
			users: [
				{
					employeeId: seed.admin.employeeId,
					name: seed.admin.name,
					password: seed.admin.password,
					role: "admin",
				},
			],
			data: {
				profile: desiredProfile,
				bookings: [],
				customers: [],
				inventory: [],
				menuItems: [],
				menuCategories: ["Appetizers", "Main Courses", "Desserts", "Beverages"],
				orders: [],
				tables: tablesData,
				auditLogs: [],
			},
		};
		const insertResult = await restaurants.insertOne(newDoc as unknown as RestaurantDoc);
		restaurant = { ...newDoc, _id: insertResult.insertedId } as RestaurantDoc;
	} else {
		const users = restaurant.users ?? [];
		const adminIndex = users.findIndex(user => user.employeeId?.toLowerCase() === seed.admin.employeeId.toLowerCase());
		if (adminIndex === -1) {
			users.push({
				employeeId: seed.admin.employeeId,
				name: seed.admin.name,
				password: seed.admin.password,
				role: "admin",
			});
		} else {
			const existingAdmin = users[adminIndex];
			users[adminIndex] = {
				...existingAdmin,
				employeeId: existingAdmin?.employeeId ?? seed.admin.employeeId,
				name: seed.admin.name,
				password: seed.admin.password,
				role: "admin",
			};
		}

		const tablesData = restaurant.data?.tables ?? [];
		const tableNames = new Set(tablesData.map(table => table.name));
		let nextId = tablesData.reduce((max, table) => Math.max(max, table.id ?? 0), 0) + 1;
		for (const table of seed.tables) {
			if (!tableNames.has(table.name)) {
				tablesData.push({
					id: nextId,
					name: table.name,
					capacity: table.capacity,
					status: "Available",
				});
				nextId += 1;
			}
		}

		await restaurants.updateOne(
			{ _id: restaurant._id },
			{
				$set: {
					users,
					"data.tables": tablesData,
					"data.profile": desiredProfile,
				},
			},
		);
	}

	for (const table of seed.tables) {
		try {
			await AddTable(restaurantId, table.name, table.capacity);
		} catch (error: unknown) {
			if (error instanceof Error && /exists/i.test(error.message)) {
				continue;
			}
			console.warn("ensure_table_failed", { restaurantId, table: table.name, error });
		}
	}
}
