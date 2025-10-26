import { ObjectId, } from "mongodb";
import { getCollection, getDb } from "./schema.js";
const MINUTE_IN_MS = 60_000;
let indexesEnsured = false;
let ensureIndexesPromise = null;
function normalizeName(name) {
    return name.trim().toLowerCase();
}
function normalizePhone(number) {
    return number.replace(/[^0-9+]/g, "");
}
function toObjectId(id) {
    if (id instanceof ObjectId) {
        return id;
    }
    return new ObjectId(id);
}
function ensureValidDate(date) {
    if (Number.isNaN(date.getTime())) {
        throw new Error("Invalid date supplied");
    }
}
async function ensureIndexes() {
    if (indexesEnsured) {
        return;
    }
    if (!ensureIndexesPromise) {
        ensureIndexesPromise = (async () => {
            const db = await getDb();
            const customers = db.collection("customers");
            const tables = db.collection("tables");
            const bookings = db.collection("bookings");
            const auditLogs = db.collection("audit_logs");
            await Promise.allSettled([
                customers.createIndex({ restaurant_id: 1, name_lower: 1, phone_normalized: 1 }, { unique: true, name: "customer_identity_per_restaurant" }),
                tables.createIndex({ restaurant_id: 1, table_name: 1 }, { unique: true, name: "table_name_per_restaurant" }),
                bookings.createIndex({ restaurant_id: 1, customer_id: 1 }, { name: "booking_customer_per_restaurant" }),
                bookings.createIndex({ restaurant_id: 1, table_name: 1, booking_date_time: 1 }, { name: "booking_table_time_per_restaurant" }),
                auditLogs.createIndex({ restaurant_id: 1, timestamp: -1 }, { name: "audit_logs_recent_per_restaurant" }),
            ]);
            indexesEnsured = true;
        })();
    }
    return ensureIndexesPromise;
}
async function customersCollection() {
    await ensureIndexes();
    return getCollection("customers");
}
async function tablesCollection() {
    await ensureIndexes();
    return getCollection("tables");
}
async function bookingsCollection() {
    await ensureIndexes();
    return getCollection("bookings");
}
async function auditLogsCollection() {
    await ensureIndexes();
    return getCollection("audit_logs");
}
export async function AddCustomer(restaurantId, name, number, email) {
    const customers = await customersCollection();
    const doc = {
        restaurant_id: restaurantId,
        name: name.trim(),
        phone_number: number.trim(),
        email: email ?? null,
        name_lower: normalizeName(name),
        phone_normalized: normalizePhone(number),
        created_at: new Date(),
    };
    const result = await customers.insertOne(doc);
    return { ...doc, _id: result.insertedId };
}
export async function AddTable(restaurantId, table_name, capacity) {
    const tables = await tablesCollection();
    const existing = await tables.findOne({ restaurant_id: restaurantId, table_name });
    if (existing) {
        throw new Error("Table already exists");
    }
    const doc = {
        restaurant_id: restaurantId,
        table_name,
        capacity: typeof capacity === "number" ? capacity : null,
        created_at: new Date(),
    };
    const result = await tables.insertOne(doc);
    return { ...doc, _id: result.insertedId };
}
export async function AddBooking(restaurantId, customer_id, booking_date_time, duration, number_of_people, table_name, source, status, from) {
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
    const doc = {
        restaurant_id: restaurantId,
        customer_id: customerObjectId,
        table_name: normalizedTableName,
        booking_date_time,
        duration_mins: duration,
        number_of_people,
        source: source ?? null,
        status: status ?? null,
        from: from ?? null,
        created_at: new Date(),
    };
    const result = await bookings.insertOne(doc);
    return { ...doc, _id: result.insertedId };
}
export async function GetCustomerId(restaurantId, name, number) {
    const customers = await customersCollection();
    const customer = await customers.findOne({
        restaurant_id: restaurantId,
        name_lower: normalizeName(name),
        phone_normalized: normalizePhone(number),
    });
    return customer?._id ?? null;
}
export async function AddEmailToCustomer(restaurantId, cust_id, email) {
    const customers = await customersCollection();
    await customers.updateOne({ _id: toObjectId(cust_id), restaurant_id: restaurantId }, { $set: { email } });
}
export async function GetTables(restaurantId, time) {
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
        .aggregate([
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
    const bookedTables = new Set(activeBookings.map((booking) => booking.table_name));
    return tablesList.map((table) => ({
        table_name: table.table_name,
        capacity: table.capacity ?? null,
        booked: table.table_name ? bookedTables.has(table.table_name) : false,
    }));
}
export async function GetBookingsAfterTime(restaurantId, time) {
    const at = time ? new Date(time) : new Date();
    if (Number.isNaN(at.getTime())) {
        return null;
    }
    const bookings = await bookingsCollection();
    const results = await bookings
        .aggregate([
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
            },
        },
        { $sort: { booking_date_time: 1 } },
    ])
        .toArray();
    return results;
}
export async function UpdateBookingStatus(restaurantId, booking_id, status) {
    const bookings = await bookingsCollection();
    const updateResult = await bookings.updateOne({ _id: toObjectId(booking_id), restaurant_id: restaurantId }, { $set: { status } });
    return updateResult.matchedCount > 0;
}
export async function DeleteBooking(restaurantId, booking_id) {
    const bookings = await bookingsCollection();
    const deleteResult = await bookings.deleteOne({
        _id: toObjectId(booking_id),
        restaurant_id: restaurantId,
    });
    return deleteResult.deletedCount > 0;
}
export async function AssignTableToBooking(restaurantId, booking_id, table_name) {
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
    const updateResult = await bookings.updateOne({ _id: toObjectId(booking_id), restaurant_id: restaurantId }, { $set: { table_name: normalized } });
    return updateResult.matchedCount > 0;
}
export async function GetCustomerAndBookings(restaurantId) {
    const customers = await customersCollection();
    const results = await customers
        .aggregate([
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
export async function HasActiveBooking(restaurantId, cust_id, time) {
    const checkTime = time ?? new Date();
    const bookings = await bookingsCollection();
    const activeBooking = await bookings
        .aggregate([
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
export async function GetBookingsInRange(restaurantId, start, end) {
    try {
        ensureValidDate(start);
        ensureValidDate(end);
        const bookings = await bookingsCollection();
        const count = await bookings.countDocuments({
            restaurant_id: restaurantId,
            booking_date_time: { $gte: start, $lte: end },
        });
        return count;
    }
    catch (error) {
        console.error("Error counting bookings in range:", error);
        return null;
    }
}
export async function AddAuditLogEntry(restaurantId, entry) {
    const logs = await auditLogsCollection();
    const logDoc = {
        restaurant_id: restaurantId,
        employee: entry.employee,
        action: entry.action,
        details: entry.details ?? null,
        timestamp: new Date(),
    };
    await logs.insertOne(logDoc);
}
export async function GetAuditLogs(restaurantId, limit = 100) {
    const logs = await auditLogsCollection();
    const docs = await logs
        .find({ restaurant_id: restaurantId })
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();
    return docs.map((doc) => ({
        id: doc._id.toHexString(),
        employee: doc.employee,
        action: doc.action,
        details: doc.details ?? null,
        timestamp: doc.timestamp,
    }));
}
//# sourceMappingURL=database.js.map