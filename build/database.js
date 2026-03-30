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
function normalizeRestaurantId(name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, "");
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
            const restaurants = db.collection("restaurants");
            const feedbackEntries = db.collection("feedback_entries");
            await Promise.allSettled([
                customers.createIndex({ restaurant_id: 1, name_lower: 1, phone_normalized: 1 }, { unique: true, name: "customer_identity_per_restaurant" }),
                tables.createIndex({ restaurant_id: 1, table_name: 1 }, { unique: true, name: "table_name_per_restaurant" }),
                bookings.createIndex({ restaurant_id: 1, customer_id: 1 }, { name: "booking_customer_per_restaurant" }),
                bookings.createIndex({ restaurant_id: 1, table_name: 1, booking_date_time: 1 }, { name: "booking_table_time_per_restaurant" }),
                bookings.createIndex({ booking_date_time: 1 }, { name: "booking_datetime_auto_expire_2h", expireAfterSeconds: 2 * 60 * 60 }),
                auditLogs.createIndex({ restaurant_id: 1, timestamp: -1 }, { name: "audit_logs_recent_per_restaurant" }),
                restaurants.createIndex({ id: 1 }, { unique: true, name: "restaurant_id_unique" }),
                feedbackEntries.createIndex({ restaurant_id: 1, submitted_at: -1 }, { name: "feedback_recent_per_restaurant" }),
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
async function restaurantsCollection() {
    await ensureIndexes();
    return getCollection("restaurants");
}
async function feedbackEntriesCollection() {
    await ensureIndexes();
    return getCollection("feedback_entries");
}
function clampRating(value) {
    if (!Number.isFinite(value)) {
        return 1;
    }
    if (value < 1) {
        return 1;
    }
    if (value > 5) {
        return 5;
    }
    return Math.round(value);
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
export async function RemoveTable(restaurantId, table_name) {
    const tables = await tablesCollection();
    const deleteResult = await tables.deleteOne({ restaurant_id: restaurantId, table_name });
    return deleteResult.deletedCount > 0;
}
export async function AddBooking(restaurantId, customer_id, booking_date_time, duration, number_of_people, table_name, source, status, from, notes) {
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
        notes: notes ?? null,
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
    const dayEnd = new Date(at);
    dayEnd.setHours(23, 59, 59, 999);
    const upcomingBookings = await bookings
        .find({
        restaurant_id: restaurantId,
        table_name: { $ne: null },
        booking_date_time: { $gt: at, $lte: dayEnd },
    }, { projection: { table_name: 1 } })
        .toArray();
    const bookedTables = new Set(activeBookings
        .map((booking) => booking.table_name)
        .filter((tableName) => typeof tableName === "string" && tableName.length > 0));
    const reservedTables = new Set(upcomingBookings
        .map((booking) => booking.table_name)
        .filter((tableName) => typeof tableName === "string" && tableName.length > 0));
    return tablesList.map((table) => ({
        table_name: table.table_name,
        capacity: table.capacity ?? null,
        booked: table.table_name ? bookedTables.has(table.table_name) : false,
        reserved: table.table_name ? reservedTables.has(table.table_name) : false,
    }));
}
// Determine table availability for an interval [start, end) and return the free tables with their capacities
export async function GetAvailableTablesForInterval(restaurantId, start, durationMins) {
    ensureValidDate(start);
    const end = new Date(start.getTime() + durationMins * MINUTE_IN_MS);
    const tables = await tablesCollection();
    const bookings = await bookingsCollection();
    const allTables = await tables
        .find({ restaurant_id: restaurantId }, { projection: { table_name: 1, capacity: 1 } })
        .toArray();
    // Find tables that have an overlapping booking with [start, end)
    const overlapping = await bookings
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
export async function AllocateBestTable(restaurantId, start, durationMins, partySize) {
    const free = await GetAvailableTablesForInterval(restaurantId, start, durationMins);
    if (free.length === 0)
        return null;
    // Partition into fit and too-small; choose minimal capacity among fit
    const fit = free.filter(t => (t.capacity ?? Infinity) >= partySize);
    if (fit.length === 0)
        return null;
    fit.sort((a, b) => {
        const ca = a.capacity ?? Number.MAX_SAFE_INTEGER;
        const cb = b.capacity ?? Number.MAX_SAFE_INTEGER;
        if (ca !== cb)
            return ca - cb;
        return a.table_name.localeCompare(b.table_name);
    });
    const chosen = fit[0];
    return chosen ? chosen.table_name : null;
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
                notes: 1,
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
export async function GetRestaurantUserRole(restaurantId, employeeId) {
    const normalizedEmployeeId = employeeId.trim().toLowerCase();
    if (!normalizedEmployeeId) {
        console.warn("get_user_role_invalid_employee_id", { restaurantId, employeeId });
        return null;
    }
    const restaurants = await restaurantsCollection();
    const restaurant = await restaurants.findOne({ id: restaurantId });
    if (!restaurant?.users?.length) {
        console.warn("get_user_role_no_users_found", { restaurantId, employeeId });
        return null;
    }
    const user = restaurant.users.find((entry) => entry.employeeId?.trim().toLowerCase() === normalizedEmployeeId);
    if (!user) {
        console.warn("get_user_role_user_not_found", { restaurantId, employeeId, restaurantUsers: restaurant.users });
    }
    return user?.role ?? null;
}
export async function AddFeedbackEntry(restaurantId, entry) {
    const feedbackEntries = await feedbackEntriesCollection();
    const submittedAt = new Date();
    const normalizedRatings = entry.category_ratings
        .filter((item) => typeof item?.key === "string" &&
        item.key.trim().length > 0 &&
        typeof item?.label === "string" &&
        item.label.trim().length > 0)
        .map((item) => ({
        key: item.key.trim(),
        label: item.label.trim(),
        rating: clampRating(item.rating),
        question: typeof item.question === "string" && item.question.trim().length > 0
            ? item.question.trim()
            : null,
        follow_up: typeof item.follow_up === "string" && item.follow_up.trim().length > 0
            ? item.follow_up.trim()
            : null,
        follow_up_answer: typeof item.follow_up_answer === "string" && item.follow_up_answer.trim().length > 0
            ? item.follow_up_answer.trim()
            : null,
    }));
    const overallRating = normalizedRatings.length > 0
        ? Number((normalizedRatings.reduce((sum, current) => sum + current.rating, 0) /
            normalizedRatings.length).toFixed(2))
        : null;
    const doc = {
        restaurant_id: restaurantId,
        customer_name: typeof entry.customer_name === "string" && entry.customer_name.trim().length > 0
            ? entry.customer_name.trim()
            : null,
        visit_date: entry.visit_date instanceof Date && !Number.isNaN(entry.visit_date.getTime())
            ? entry.visit_date
            : null,
        comments: typeof entry.comments === "string" && entry.comments.trim().length > 0
            ? entry.comments.trim()
            : null,
        overall_rating: overallRating,
        category_ratings: normalizedRatings,
        image_theme: entry.image_theme ?? null,
        source: typeof entry.source === "string" && entry.source.trim().length > 0
            ? entry.source.trim()
            : "feedback_form",
        submitted_at: submittedAt,
    };
    const result = await feedbackEntries.insertOne(doc);
    return { id: result.insertedId.toHexString(), submitted_at: submittedAt };
}
export async function GetFeedbackEntries(restaurantId, limit = 100) {
    const feedbackEntries = await feedbackEntriesCollection();
    const safeLimit = Math.max(1, Math.min(limit, 500));
    const docs = await feedbackEntries
        .find({ restaurant_id: restaurantId })
        .sort({ submitted_at: -1 })
        .limit(safeLimit)
        .toArray();
    return docs.map((doc) => ({
        id: doc._id.toHexString(),
        restaurant_id: doc.restaurant_id,
        customer_name: doc.customer_name ?? null,
        visit_date: doc.visit_date ?? null,
        comments: doc.comments ?? null,
        overall_rating: doc.overall_rating ?? null,
        category_ratings: doc.category_ratings ?? [],
        image_theme: doc.image_theme ?? null,
        source: doc.source ?? null,
        submitted_at: doc.submitted_at,
    }));
}
export async function GetFeedbackSummary(restaurantId) {
    const now = new Date();
    const last30Start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const feedbackEntries = await feedbackEntriesCollection();
    const docs = await feedbackEntries
        .find({ restaurant_id: restaurantId }, { projection: { overall_rating: 1, category_ratings: 1, submitted_at: 1 } })
        .toArray();
    let overallTotal = 0;
    let overallCount = 0;
    let last30DaysResponses = 0;
    const categoryTotals = new Map();
    for (const doc of docs) {
        if (typeof doc.overall_rating === "number") {
            overallTotal += doc.overall_rating;
            overallCount += 1;
        }
        if (doc.submitted_at instanceof Date && doc.submitted_at >= last30Start) {
            last30DaysResponses += 1;
        }
        for (const category of doc.category_ratings ?? []) {
            const key = category.key.trim();
            if (!key) {
                continue;
            }
            const existing = categoryTotals.get(key) ?? {
                label: category.label,
                total: 0,
                count: 0,
            };
            existing.total += clampRating(category.rating);
            existing.count += 1;
            if (category.label.trim().length > 0) {
                existing.label = category.label;
            }
            categoryTotals.set(key, existing);
        }
    }
    const categoryAverages = {};
    for (const [key, value] of categoryTotals.entries()) {
        categoryAverages[key] = {
            label: value.label,
            average: value.count > 0 ? Number((value.total / value.count).toFixed(2)) : null,
        };
    }
    return {
        totalResponses: docs.length,
        averageRating: overallCount > 0 ? Number((overallTotal / overallCount).toFixed(2)) : null,
        categoryAverages,
        last30DaysResponses,
    };
}
export async function EnsureRestaurantSeed(seed) {
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
        const tablesData = seed.tables.map((table, index) => ({
            id: index + 1,
            name: table.name,
            capacity: table.capacity,
            status: "Available",
        }));
        const newDoc = {
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
        const insertResult = await restaurants.insertOne(newDoc);
        restaurant = { ...newDoc, _id: insertResult.insertedId };
    }
    else {
        const users = restaurant.users ?? [];
        const adminIndex = users.findIndex(user => user.employeeId?.toLowerCase() === seed.admin.employeeId.toLowerCase());
        if (adminIndex === -1) {
            users.push({
                employeeId: seed.admin.employeeId,
                name: seed.admin.name,
                password: seed.admin.password,
                role: "admin",
            });
        }
        else {
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
        await restaurants.updateOne({ _id: restaurant._id }, {
            $set: {
                users,
                "data.tables": tablesData,
                "data.profile": desiredProfile,
            },
        });
    }
    for (const table of seed.tables) {
        try {
            await AddTable(restaurantId, table.name, table.capacity);
        }
        catch (error) {
            if (error instanceof Error && /exists/i.test(error.message)) {
                continue;
            }
            console.warn("ensure_table_failed", { restaurantId, table: table.name, error });
        }
    }
}
//# sourceMappingURL=database.js.map