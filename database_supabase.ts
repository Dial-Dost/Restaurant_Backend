import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

const connectionString =
  process.env.SUPABASE_DIRECT_URL ??
  process.env.DATABASE_URL ??
  process.env.DIRECT_URL;

if (!connectionString) {
  throw new Error(
    "SUPABASE_DIRECT_URL (or DATABASE_URL / DIRECT_URL) is required for Postgres access.",
  );
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

type RestaurantContext = {
  inputId: string;
  res_id: string;
  outlet_id: string;
  restaurant_slug: string;
  restaurant_name: string;
};

type SlotPayload = {
  start: string;
  duration: number;
  source?: string | null;
  status?: string | null;
  from?: string | null;
  notes?: string | null;
};

type RestaurantUser = {
  employeeId: string;
  name: string;
  password?: string | null;
  role: "admin" | "employee" | "valet" | "waiter";
};

export type FeedbackCategoryRatingInput = {
  key: string;
  label: string;
  rating: number;
  question?: string | null;
  follow_up?: string | null;
  follow_up_answer?: string | null;
};

export type FeedbackThemeInput = {
  background: string;
  surface: string;
  text: string;
  accent: string;
};

export type FeedbackSubmissionInput = {
  customer_name?: string | null;
  visit_date?: Date | null;
  comments?: string | null;
  category_ratings: FeedbackCategoryRatingInput[];
  image_theme?: FeedbackThemeInput | null;
  source?: string | null;
};

export type FeedbackEntry = {
  id: string;
  restaurant_id: string;
  employee_id: string;
  customer_name?: string | null;
  visit_date?: Date | null;
  comments?: string | null;
  overall_rating?: number | null;
  category_ratings: FeedbackCategoryRatingInput[];
  image_theme?: FeedbackThemeInput | null;
  source?: string | null;
  submitted_at: Date;
};

export type FeedbackSummary = {
  totalResponses: number;
  averageRating: number | null;
  categoryAverages: Record<string, { label: string; average: number | null }>;
  last30DaysResponses: number;
};

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

type AuditLogEntry = {
  id: string;
  employee: string;
  action: string;
  details?: string | null;
  timestamp: Date;
};

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

const MINUTE_IN_MS = 60_000;

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function normalizeRestaurantId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizePhone(number: string): string {
  return number.replace(/[^0-9]/g, "");
}

function splitName(fullName: string): { first: string; last: string } {
  const trimmed = fullName.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return { first: "Guest", last: "User" };
  }

  const parts = trimmed.split(" ");
  if (parts.length === 1) {
    return { first: parts[0]!, last: "-" };
  }

  const first = parts.shift() ?? "Guest";
  const last = parts.join(" ") || "-";
  return { first, last };
}

function parseNumeric(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function clampRating(value: number): number {
  if (!Number.isFinite(value)) return 1;
  if (value < 1) return 1;
  if (value > 5) return 5;
  return Math.round(value);
}

function toRole(raw: unknown): RestaurantUser["role"] {
  const role = String(raw ?? "").trim().toLowerCase();
  if (role === "admin" || role === "employee" || role === "valet" || role === "waiter") {
    return role;
  }
  return "employee";
}

function encodeSlot(payload: SlotPayload): string {
  return JSON.stringify({
    start: payload.start,
    duration: Math.max(1, Math.round(payload.duration)),
    source: payload.source ?? null,
    status: payload.status ?? null,
    from: payload.from ?? null,
    notes: payload.notes ?? null,
  });
}

function decodeSlot(slot: string | null, fallbackCreatedAt?: Date): SlotPayload {
  if (!slot) {
    const start = fallbackCreatedAt ?? new Date();
    return {
      start: start.toISOString(),
      duration: 120,
      source: null,
      status: "Confirmed",
      from: null,
      notes: null,
    };
  }

  try {
    const parsed = JSON.parse(slot) as Partial<SlotPayload>;
    const startDate = parsed.start ? new Date(parsed.start) : fallbackCreatedAt ?? new Date();
    const duration = Number(parsed.duration ?? 120);
    return {
      start: Number.isNaN(startDate.getTime())
        ? (fallbackCreatedAt ?? new Date()).toISOString()
        : startDate.toISOString(),
      duration: Number.isFinite(duration) ? Math.max(1, Math.round(duration)) : 120,
      source: parsed.source ?? null,
      status: parsed.status ?? "Confirmed",
      from: parsed.from ?? null,
      notes: parsed.notes ?? null,
    };
  } catch {
    const guess = new Date(slot);
    return {
      start: Number.isNaN(guess.getTime())
        ? (fallbackCreatedAt ?? new Date()).toISOString()
        : guess.toISOString(),
      duration: 120,
      source: null,
      status: "Confirmed",
      from: null,
      notes: null,
    };
  }
}

function ensureValidDate(date: Date): void {
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid date supplied");
  }
}

async function runQuery<TRow extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  client?: PoolClient,
): Promise<TRow[]> {
  const runner = client ?? pool;
  const result = await runner.query<TRow>(sql, params);
  return result.rows;
}

async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function resolveRestaurantContext(
  restaurantId: string,
  client?: PoolClient,
): Promise<RestaurantContext | null> {
  const normalized = normalizeRestaurantId(restaurantId);
  const rows = await runQuery<{
    res_id: string;
    outlet_id: string | null;
    restaurant_slug: string;
    restaurant_name: string;
  }>(
    `
      select
        r.id as res_id,
        o.id as outlet_id,
        r.res_username as restaurant_slug,
        r.res_name as restaurant_name
      from "Restaurant" r
      left join "Outlets" o on o.res_id = r.id
      where
        lower(r.res_username) = lower($1)
        or lower(r.res_username) = lower($2)
        or r.id::text = $3
      order by o.created_at asc nulls last
      limit 1
    `,
    [restaurantId, normalized, restaurantId],
    client,
  );

  const row = rows[0];
  if (!row || !row.outlet_id) {
    return null;
  }

  return {
    inputId: restaurantId,
    res_id: row.res_id,
    outlet_id: row.outlet_id,
    restaurant_slug: row.restaurant_slug,
    restaurant_name: row.restaurant_name,
  };
}

async function requireRestaurantContext(
  restaurantId: string,
  client?: PoolClient,
): Promise<RestaurantContext> {
  const context = await resolveRestaurantContext(restaurantId, client);
  if (!context) {
    throw new Error(`Unknown restaurant id: ${restaurantId}`);
  }
  return context;
}

async function findOrCreateActionId(actionName: string, client: PoolClient): Promise<string> {
  const normalized = actionName.trim();
  const existing = await runQuery<{ id: string }>(
    `
      select id
      from "Actions"
      where lower(action_name) = lower($1)
      limit 1
    `,
    [normalized],
    client,
  );

  const found = existing[0];
  if (found) return found.id;

  const id = randomUUID();
  await runQuery(
    `
      insert into "Actions" (id, created_at, action_name, action_desc)
      values ($1, now(), $2, null)
    `,
    [id, normalized],
    client,
  );

  return id;
}

async function findOrCreateEmployeeIdByUsername(
  context: RestaurantContext,
  employeeIdOrUsername: string,
  fallbackDisplayName: string,
  client: PoolClient,
): Promise<string> {
  const username = employeeIdOrUsername.trim();

  const existing = await runQuery<{ emp_id: string }>(
    `
      select l.emp_id
      from "Login" l
      where l.res_id = $1 and l.outlet_id = $2 and lower(l.emp_username) = lower($3)
      limit 1
    `,
    [context.res_id, context.outlet_id, username],
    client,
  );

  const existingRow = existing[0];
  if (existingRow) return existingRow.emp_id;

  const parts = splitName(fallbackDisplayName || username);
  const employeeUuid = randomUUID();

  await runQuery(
    `
      insert into "Employees"
        (id, created_at, "emp_Fname", "emp_email", "emp_ph", "emp_add", emp_roles, res_id, outlet_id, "emp_Lname")
      values
        ($1, now(), $2, null, null, null, $3::json, $4, $5, $6)
    `,
    [
      employeeUuid,
      parts.first,
      JSON.stringify({ primary: "employee", all: ["employee"] }),
      context.res_id,
      context.outlet_id,
      parts.last,
    ],
    client,
  );

  await runQuery(
    `
      insert into "Login" (emp_id, created_at, res_id, outlet_id, emp_username, emp_pass)
      values ($1, now(), $2, $3, $4, $5)
    `,
    [employeeUuid, context.res_id, context.outlet_id, username, "changeme"],
    client,
  );

  return employeeUuid;
}

export async function CheckDatabaseHealth(): Promise<boolean> {
  try {
    await runQuery("select 1 as ok");
    return true;
  } catch {
    return false;
  }
}

export async function AddCustomer(
  restaurantId: string,
  name: string,
  number: string,
  email?: string,
): Promise<{ _id: string }> {
  const context = await requireRestaurantContext(restaurantId);
  const id = randomUUID();
  const parsedName = splitName(name);
  const phoneDigits = normalizePhone(number);

  await runQuery(
    `
      insert into "Customers"
        (id, created_at, res_id, outlet_id, "cust_Fname", "cust_Lname", cust_ph, cust_email, country_of_origin)
      values
        ($1, now(), $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      id,
      context.res_id,
      context.outlet_id,
      parsedName.first,
      parsedName.last,
      phoneDigits.length > 0 ? phoneDigits : null,
      email?.trim() || null,
      "Unknown",
    ],
  );

  return { _id: id };
}

export async function AddTable(
  restaurantId: string,
  table_name: string,
  capacity?: number,
): Promise<{ _id: string; table_name: string }> {
  const context = await requireRestaurantContext(restaurantId);
  const normalized = table_name.trim();

  const existing = await runQuery<{ id: string }>(
    `
      select id
      from "Tables"
      where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3)
      limit 1
    `,
    [context.res_id, context.outlet_id, normalized],
  );

  if (existing[0]) {
    throw new Error("Table already exists");
  }

  const id = randomUUID();
  await runQuery(
    `
      insert into "Tables" (id, created_at, res_id, outlet_id, table_name, capacity)
      values ($1, now(), $2, $3, $4, $5)
    `,
    [id, context.res_id, context.outlet_id, normalized, Math.max(1, Number(capacity ?? 1))],
  );

  return { _id: id, table_name: normalized };
}

export async function RemoveTable(
  restaurantId: string,
  table_name: string,
): Promise<boolean> {
  const context = await requireRestaurantContext(restaurantId);
  const rows = await runQuery<{ id: string }>(
    `
      delete from "Tables"
      where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3)
      returning id
    `,
    [context.res_id, context.outlet_id, table_name.trim()],
  );
  return rows.length > 0;
}

export async function AddBooking(
  restaurantId: string,
  customer_id: string,
  booking_date_time: Date,
  duration: number,
  number_of_people: number,
  table_name?: string | null,
  source?: string,
  status?: string,
  from?: string,
  notes?: string | null,
): Promise<{ _id: string }> {
  ensureValidDate(booking_date_time);
  const context = await requireRestaurantContext(restaurantId);

  const customerRows = await runQuery<{ id: string }>(
    `
      select id
      from "Customers"
      where id = $1 and res_id = $2 and outlet_id = $3
      limit 1
    `,
    [customer_id, context.res_id, context.outlet_id],
  );
  if (!customerRows[0]) {
    throw new Error("Customer not found");
  }

  if (!table_name?.trim()) {
    throw new Error("Table name is required");
  }

  const tableRows = await runQuery<{ id: string }>(
    `
      select id
      from "Tables"
      where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3)
      limit 1
    `,
    [context.res_id, context.outlet_id, table_name.trim()],
  );
  const table = tableRows[0];
  if (!table) {
    throw new Error("Table not found for restaurant");
  }

  const bookingId = randomUUID();
  const slot = encodeSlot({
    start: booking_date_time.toISOString(),
    duration,
    source: source ?? null,
    status: status ?? "Confirmed",
    from: from ?? null,
    notes: notes ?? null,
  });

  await runQuery(
    `
      insert into "Bookings"
        (id, created_at, res_id, outlet_id, cust_id, num_adults, num_kids, table_id, slot)
      values
        ($1, now(), $2, $3, $4, $5, null, $6, $7)
    `,
    [
      bookingId,
      context.res_id,
      context.outlet_id,
      customer_id,
      Math.max(1, Math.round(number_of_people)),
      table.id,
      slot,
    ],
  );

  return { _id: bookingId };
}

export async function GetCustomerId(
  restaurantId: string,
  name: string,
  number: string,
): Promise<string | null> {
  const context = await requireRestaurantContext(restaurantId);
  const parsedName = splitName(name);
  const phoneDigits = normalizePhone(number);

  const rows = await runQuery<{ id: string }>(
    `
      select id
      from "Customers"
      where
        res_id = $1
        and outlet_id = $2
        and lower("cust_Fname") = lower($3)
        and lower("cust_Lname") = lower($4)
        and ($5::text is null or cast(cust_ph as text) = $5)
      order by created_at desc
      limit 1
    `,
    [
      context.res_id,
      context.outlet_id,
      parsedName.first,
      parsedName.last,
      phoneDigits.length > 0 ? phoneDigits : null,
    ],
  );

  return rows[0]?.id ?? null;
}

export async function AddEmailToCustomer(
  restaurantId: string,
  cust_id: string,
  email: string,
): Promise<void> {
  const context = await requireRestaurantContext(restaurantId);
  await runQuery(
    `
      update "Customers"
      set cust_email = $4
      where id = $1 and res_id = $2 and outlet_id = $3
    `,
    [cust_id, context.res_id, context.outlet_id, email.trim()],
  );
}

async function getBookingsWithTableMeta(
  context: RestaurantContext,
): Promise<
  Array<{
    id: string;
    table_id: string;
    slot: string;
    created_at: Date;
  }>
> {
  return runQuery(
    `
      select id, table_id, slot, created_at
      from "Bookings"
      where res_id = $1 and outlet_id = $2
    `,
    [context.res_id, context.outlet_id],
  );
}

export async function GetTables(
  restaurantId: string,
  time?: string,
): Promise<TableAvailability[] | null> {
  const at = time ? new Date(time) : new Date();
  if (Number.isNaN(at.getTime())) return null;

  const context = await requireRestaurantContext(restaurantId);

  const tableRows = await runQuery<{
    id: string;
    table_name: string;
    capacity: unknown;
  }>(
    `
      select id, table_name, capacity
      from "Tables"
      where res_id = $1 and outlet_id = $2
      order by capacity asc, table_name asc
    `,
    [context.res_id, context.outlet_id],
  );

  const bookings = await getBookingsWithTableMeta(context);
  const bookedIds = new Set<string>();
  const reservedIds = new Set<string>();

  for (const booking of bookings) {
    const slot = decodeSlot(booking.slot, booking.created_at);
    const start = new Date(slot.start);
    const end = new Date(start.getTime() + slot.duration * MINUTE_IN_MS);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;

    if (start <= at && end > at) {
      bookedIds.add(booking.table_id);
      continue;
    }

    if (start > at) {
      reservedIds.add(booking.table_id);
    }
  }

  return tableRows.map((row) => ({
    table_name: row.table_name,
    capacity: parseNumeric(row.capacity),
    booked: bookedIds.has(row.id),
    reserved: reservedIds.has(row.id),
  }));
}

export async function GetAvailableTablesForInterval(
  restaurantId: string,
  start: Date,
  durationMins: number,
): Promise<Array<{ table_name: string; capacity: number | null }>> {
  ensureValidDate(start);
  const end = new Date(start.getTime() + durationMins * MINUTE_IN_MS);
  const context = await requireRestaurantContext(restaurantId);

  const tableRows = await runQuery<{
    id: string;
    table_name: string;
    capacity: unknown;
  }>(
    `
      select id, table_name, capacity
      from "Tables"
      where res_id = $1 and outlet_id = $2
    `,
    [context.res_id, context.outlet_id],
  );

  const bookings = await getBookingsWithTableMeta(context);
  const busyIds = new Set<string>();

  for (const booking of bookings) {
    const slot = decodeSlot(booking.slot, booking.created_at);
    const bookingStart = new Date(slot.start);
    const bookingEnd = new Date(bookingStart.getTime() + slot.duration * MINUTE_IN_MS);
    if (Number.isNaN(bookingStart.getTime()) || Number.isNaN(bookingEnd.getTime())) continue;

    const overlaps = bookingStart < end && bookingEnd > start;
    if (overlaps) busyIds.add(booking.table_id);
  }

  return tableRows
    .filter((row) => !busyIds.has(row.id))
    .map((row) => ({ table_name: row.table_name, capacity: parseNumeric(row.capacity) }));
}

export async function AllocateBestTable(
  restaurantId: string,
  start: Date,
  durationMins: number,
  partySize: number,
): Promise<string | null> {
  const free = await GetAvailableTablesForInterval(restaurantId, start, durationMins);
  if (free.length === 0) return null;

  const fit = free.filter((t) => (t.capacity ?? Number.MAX_SAFE_INTEGER) >= partySize);
  if (fit.length === 0) return null;

  fit.sort((a, b) => {
    const diff = (a.capacity ?? Number.MAX_SAFE_INTEGER) - (b.capacity ?? Number.MAX_SAFE_INTEGER);
    if (diff !== 0) return diff;
    return a.table_name.localeCompare(b.table_name);
  });

  return fit[0]?.table_name ?? null;
}

export async function GetBookingsAfterTime(
  restaurantId: string,
  time?: string,
): Promise<BookingSummary[] | null> {
  const at = time ? new Date(time) : new Date();
  if (Number.isNaN(at.getTime())) return null;

  const context = await requireRestaurantContext(restaurantId);
  const rows = await runQuery<{
    booking_id: string;
    customer_id: string;
    table_name: string | null;
    slot: string;
    created_at: Date;
    num_adults: unknown;
    cust_fname: string;
    cust_lname: string;
  }>(
    `
      select
        b.id as booking_id,
        b.cust_id as customer_id,
        t.table_name as table_name,
        b.slot,
        b.created_at,
        b.num_adults,
        c."cust_Fname" as cust_fname,
        c."cust_Lname" as cust_lname
      from "Bookings" b
      join "Customers" c
        on c.id = b.cust_id and c.res_id = b.res_id and c.outlet_id = b.outlet_id
      left join "Tables" t
        on t.id = b.table_id and t.res_id = b.res_id and t.outlet_id = b.outlet_id
      where b.res_id = $1 and b.outlet_id = $2
    `,
    [context.res_id, context.outlet_id],
  );

  const result: BookingSummary[] = [];

  for (const row of rows) {
    const slot = decodeSlot(row.slot, row.created_at);
    const start = new Date(slot.start);
    const end = new Date(start.getTime() + slot.duration * MINUTE_IN_MS);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (end <= at) continue;

    result.push({
      booking_id: row.booking_id,
      customer_id: row.customer_id,
      customer_name: `${row.cust_fname} ${row.cust_lname}`.trim(),
      table_name: row.table_name,
      booking_date_time: start,
      duration_mins: slot.duration,
      number_of_people: Math.max(1, Math.round(parseNumeric(row.num_adults))),
      source: slot.source ?? null,
      status: slot.status ?? "Confirmed",
      from: slot.from ?? null,
      notes: slot.notes ?? null,
    });
  }

  result.sort((a, b) => a.booking_date_time.getTime() - b.booking_date_time.getTime());
  return result;
}

export async function UpdateBookingStatus(
  restaurantId: string,
  booking_id: string,
  status: string,
): Promise<boolean> {
  const context = await requireRestaurantContext(restaurantId);

  const rows = await runQuery<{ slot: string; created_at: Date }>(
    `
      select slot, created_at
      from "Bookings"
      where id = $1 and res_id = $2 and outlet_id = $3
      limit 1
    `,
    [booking_id, context.res_id, context.outlet_id],
  );

  const row = rows[0];
  if (!row) return false;

  const slot = decodeSlot(row.slot, row.created_at);
  slot.status = status;

  await runQuery(
    `
      update "Bookings"
      set slot = $4
      where id = $1 and res_id = $2 and outlet_id = $3
    `,
    [booking_id, context.res_id, context.outlet_id, encodeSlot(slot)],
  );

  return true;
}

export async function DeleteBooking(
  restaurantId: string,
  booking_id: string,
): Promise<boolean> {
  const context = await requireRestaurantContext(restaurantId);
  const rows = await runQuery<{ id: string }>(
    `
      delete from "Bookings"
      where id = $1 and res_id = $2 and outlet_id = $3
      returning id
    `,
    [booking_id, context.res_id, context.outlet_id],
  );
  return rows.length > 0;
}

export async function AssignTableToBooking(
  restaurantId: string,
  booking_id: string,
  table_name: string | null,
): Promise<boolean> {
  const context = await requireRestaurantContext(restaurantId);

  if (!table_name?.trim()) {
    throw new Error("Table name cannot be null");
  }

  const tableRows = await runQuery<{ id: string }>(
    `
      select id
      from "Tables"
      where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3)
      limit 1
    `,
    [context.res_id, context.outlet_id, table_name.trim()],
  );

  const table = tableRows[0];
  if (!table) {
    throw new Error("Table not found for restaurant");
  }

  const rows = await runQuery<{ id: string }>(
    `
      update "Bookings"
      set table_id = $4
      where id = $1 and res_id = $2 and outlet_id = $3
      returning id
    `,
    [booking_id, context.res_id, context.outlet_id, table.id],
  );

  return rows.length > 0;
}

export async function GetCustomerAndBookings(
  restaurantId: string,
): Promise<CustomerSummary[]> {
  const context = await requireRestaurantContext(restaurantId);
  const rows = await runQuery<{
    customer_id: string;
    fname: string;
    lname: string;
    phone: string | null;
    email: string | null;
    booking_count: number;
  }>(
    `
      select
        c.id as customer_id,
        c."cust_Fname" as fname,
        c."cust_Lname" as lname,
        cast(c.cust_ph as text) as phone,
        c.cust_email as email,
        count(b.id)::int as booking_count
      from "Customers" c
      left join "Bookings" b
        on b.cust_id = c.id and b.res_id = c.res_id and b.outlet_id = c.outlet_id
      where c.res_id = $1 and c.outlet_id = $2
      group by c.id, c."cust_Fname", c."cust_Lname", c.cust_ph, c.cust_email
      order by c."cust_Fname", c."cust_Lname"
    `,
    [context.res_id, context.outlet_id],
  );

  return rows.map((row) => ({
    customer_id: row.customer_id,
    name: `${row.fname} ${row.lname}`.trim(),
    phone_number: row.phone ?? "",
    email: row.email,
    booking_count: Number(row.booking_count ?? 0),
  }));
}

export async function HasActiveBooking(
  restaurantId: string,
  cust_id: string,
  time?: Date,
): Promise<boolean> {
  const context = await requireRestaurantContext(restaurantId);
  const checkTime = time ?? new Date();

  const rows = await runQuery<{ slot: string; created_at: Date }>(
    `
      select slot, created_at
      from "Bookings"
      where res_id = $1 and outlet_id = $2 and cust_id = $3
    `,
    [context.res_id, context.outlet_id, cust_id],
  );

  return rows.some((row) => {
    const slot = decodeSlot(row.slot, row.created_at);
    const start = new Date(slot.start);
    const end = new Date(start.getTime() + slot.duration * MINUTE_IN_MS);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
    return start <= checkTime && end > checkTime;
  });
}

export async function GetBookingsInRange(
  restaurantId: string,
  start: Date,
  end: Date,
): Promise<number | null> {
  try {
    ensureValidDate(start);
    ensureValidDate(end);
    const context = await requireRestaurantContext(restaurantId);

    const rows = await runQuery<{ slot: string; created_at: Date }>(
      `
        select slot, created_at
        from "Bookings"
        where res_id = $1 and outlet_id = $2
      `,
      [context.res_id, context.outlet_id],
    );

    let count = 0;
    for (const row of rows) {
      const slot = decodeSlot(row.slot, row.created_at);
      const bookingStart = new Date(slot.start);
      if (Number.isNaN(bookingStart.getTime())) continue;
      if (bookingStart >= start && bookingStart <= end) {
        count += 1;
      }
    }

    return count;
  } catch (error) {
    console.error("Error counting bookings in range:", error);
    return null;
  }
}

export async function AddAuditLogEntry(
  restaurantId: string,
  entry: { employee: string; action: string; details?: string | null },
): Promise<void> {
  const context = await requireRestaurantContext(restaurantId);

  await withTransaction(async (client) => {
    const employeeId = await findOrCreateEmployeeIdByUsername(
      context,
      entry.employee,
      entry.employee,
      client,
    );
    const actionId = await findOrCreateActionId(entry.action, client);

    await runQuery(
      `
        insert into "Audit_logs"
          (id, created_at, res_id, outlet_id, employee_id, action_id, reason)
        values
          ($1, now(), $2, $3, $4, $5, $6)
      `,
      [
        randomUUID(),
        context.res_id,
        context.outlet_id,
        employeeId,
        actionId,
        entry.details ?? null,
      ],
      client,
    );
  });
}

export async function GetAuditLogs(
  restaurantId: string,
  limit = 100,
): Promise<AuditLogEntry[]> {
  const context = await requireRestaurantContext(restaurantId);
  const safeLimit = Math.max(1, Math.min(limit, 500));

  const rows = await runQuery<{
    id: string;
    created_at: Date;
    reason: string | null;
    action_name: string;
    emp_username: string | null;
    fname: string | null;
    lname: string | null;
  }>(
    `
      select
        l.id,
        l.created_at,
        l.reason,
        a.action_name,
        lg.emp_username,
        e."emp_Fname" as fname,
        e."emp_Lname" as lname
      from "Audit_logs" l
      join "Actions" a on a.id = l.action_id
      left join "Employees" e on e.id = l.employee_id and e.res_id = l.res_id and e.outlet_id = l.outlet_id
      left join "Login" lg on lg.emp_id = e.id and lg.res_id = e.res_id and lg.outlet_id = e.outlet_id
      where l.res_id = $1 and l.outlet_id = $2
      order by l.created_at desc
      limit $3
    `,
    [context.res_id, context.outlet_id, safeLimit],
  );

  return rows.map((row) => ({
    id: row.id,
    employee:
      row.emp_username ??
      (`${row.fname ?? ""} ${row.lname ?? ""}`.trim() || "Unknown"),
    action: row.action_name,
    details: row.reason,
    timestamp: new Date(row.created_at),
  }));
}

export async function GetRestaurantUserRole(
  restaurantId: string,
  employeeId: string,
): Promise<RestaurantUser["role"] | null> {
  const context = await requireRestaurantContext(restaurantId);
  const normalizedEmployeeId = employeeId.trim().toLowerCase();
  if (!normalizedEmployeeId) return null;

  const rows = await runQuery<{ role_primary: string | null }>(
    `
      select e.emp_roles->>'primary' as role_primary
      from "Login" l
      join "Employees" e
        on e.id = l.emp_id and e.res_id = l.res_id and e.outlet_id = l.outlet_id
      where
        l.res_id = $1
        and l.outlet_id = $2
        and lower(l.emp_username) = lower($3)
      limit 1
    `,
    [context.res_id, context.outlet_id, normalizedEmployeeId],
  );

  const row = rows[0];
  return row ? toRole(row.role_primary) : null;
}

export async function AddFeedbackEntry(
  restaurantId: string,
  employeeId: string,
  entry: FeedbackSubmissionInput,
): Promise<{ id: string; submitted_at: Date }> {
  const context = await requireRestaurantContext(restaurantId);
  const submittedAt = new Date();

  const ratings = entry.category_ratings
    .filter((r) => r.key?.trim() && r.label?.trim())
    .map((r) => ({
      key: r.key.trim(),
      label: r.label.trim(),
      rating: clampRating(r.rating),
      question: r.question?.trim() || null,
      follow_up: r.follow_up?.trim() || null,
      follow_up_answer: r.follow_up_answer?.trim() || null,
    }));

  if (ratings.length === 0) {
    throw new Error("At least one category rating is required");
  }

  const overallRating = Math.max(
    1,
    Math.min(5, Math.round(ratings.reduce((acc, cur) => acc + cur.rating, 0) / ratings.length)),
  );

  const empUuid = await withTransaction(async (client) =>
    findOrCreateEmployeeIdByUsername(context, employeeId, employeeId, client),
  );

  const id = randomUUID();
  const visitDate =
    entry.visit_date instanceof Date && !Number.isNaN(entry.visit_date.getTime())
      ? entry.visit_date
      : submittedAt;

  await runQuery(
    `
      insert into "Feedback_entries"
        (id, submitted_at, res_id, outlet_id, emp_id, cust_name, comments, overall_rating, cattegory_ratings, visit_date, source)
      values
        ($1, $2, $3, $4, $5, $6, $7, $8, $9::json, $10, $11)
    `,
    [
      id,
      submittedAt,
      context.res_id,
      context.outlet_id,
      empUuid,
      entry.customer_name?.trim() || null,
      entry.comments?.trim() || null,
      overallRating,
      JSON.stringify(ratings),
      visitDate,
      entry.source?.trim() || "feedback_form",
    ],
  );

  return { id, submitted_at: submittedAt };
}

export async function GetFeedbackEntries(
  restaurantId: string,
  limit = 100,
): Promise<FeedbackEntry[]> {
  const context = await requireRestaurantContext(restaurantId);
  const safeLimit = Math.max(1, Math.min(limit, 5000));

  const rows = await runQuery<{
    id: string;
    res_id: string;
    emp_id: string;
    cust_name: string | null;
    comments: string | null;
    overall_rating: number;
    cattegory_ratings: unknown;
    visit_date: Date;
    source: string;
    submitted_at: Date;
  }>(
    `
      select
        id,
        res_id,
        emp_id,
        cust_name,
        comments,
        overall_rating,
        cattegory_ratings,
        visit_date,
        source,
        submitted_at
      from "Feedback_entries"
      where res_id = $1 and outlet_id = $2
      order by submitted_at desc
      limit $3
    `,
    [context.res_id, context.outlet_id, safeLimit],
  );

  return rows.map((row) => ({
    id: row.id,
    restaurant_id: context.inputId,
    employee_id: row.emp_id,
    customer_name: row.cust_name,
    visit_date: row.visit_date ? new Date(row.visit_date) : null,
    comments: row.comments,
    overall_rating: parseNumeric(row.overall_rating),
    category_ratings: Array.isArray(row.cattegory_ratings)
      ? (row.cattegory_ratings as FeedbackCategoryRatingInput[])
      : [],
    image_theme: null,
    source: row.source,
    submitted_at: new Date(row.submitted_at),
  }));
}

export async function GetFeedbackSummary(
  restaurantId: string,
): Promise<FeedbackSummary> {
  const rows = await GetFeedbackEntries(restaurantId, 5000);
  const now = new Date();
  const last30Start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  let overallTotal = 0;
  let overallCount = 0;
  let last30DaysResponses = 0;
  const categoryTotals = new Map<string, { label: string; total: number; count: number }>();

  for (const row of rows) {
    if (typeof row.overall_rating === "number") {
      overallTotal += row.overall_rating;
      overallCount += 1;
    }

    if (row.submitted_at >= last30Start) {
      last30DaysResponses += 1;
    }

    for (const category of row.category_ratings ?? []) {
      const key = category.key.trim();
      if (!key) continue;
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

  const categoryAverages: Record<string, { label: string; average: number | null }> = {};
  for (const [key, value] of categoryTotals.entries()) {
    categoryAverages[key] = {
      label: value.label,
      average: value.count > 0 ? Number((value.total / value.count).toFixed(2)) : null,
    };
  }

  return {
    totalResponses: rows.length,
    averageRating: overallCount > 0 ? Number((overallTotal / overallCount).toFixed(2)) : null,
    categoryAverages,
    last30DaysResponses,
  };
}

export async function GetRestaurantUsers(
  restaurantId: string,
): Promise<RestaurantUser[]> {
  const context = await requireRestaurantContext(restaurantId);

  const rows = await runQuery<{
    employee_id: string;
    emp_username: string;
    emp_pass: string;
    fname: string;
    lname: string;
    role_primary: string | null;
  }>(
    `
      select
        e.id as employee_id,
        l.emp_username,
        l.emp_pass,
        e."emp_Fname" as fname,
        e."emp_Lname" as lname,
        e.emp_roles->>'primary' as role_primary
      from "Login" l
      join "Employees" e
        on e.id = l.emp_id and e.res_id = l.res_id and e.outlet_id = l.outlet_id
      where l.res_id = $1 and l.outlet_id = $2
      order by l.created_at asc
    `,
    [context.res_id, context.outlet_id],
  );

  return rows.map((row) => ({
    employeeId: row.emp_username,
    name: `${row.fname} ${row.lname}`.trim(),
    password: row.emp_pass,
    role: toRole(row.role_primary),
  }));
}

export async function EnsureRestaurantSeed(seed: RestaurantSeedInput): Promise<void> {
  const restaurantSlug = seed.id?.trim() || normalizeRestaurantId(seed.name);
  const profile = seed.profile ?? {};

  await withTransaction(async (client) => {
    let restaurantRows = await runQuery<{ id: string }>(
      `
        select id
        from "Restaurant"
        where lower(res_username) = lower($1)
        limit 1
      `,
      [restaurantSlug],
      client,
    );

    let resId = restaurantRows[0]?.id;
    if (!resId) {
      resId = randomUUID();
      await runQuery(
        `
          insert into "Restaurant" (id, created_at, res_username, res_name, main_office_add)
          values ($1, now(), $2, $3, $4)
        `,
        [resId, restaurantSlug, seed.name, profile.address ?? null],
        client,
      );
    } else {
      await runQuery(
        `
          update "Restaurant"
          set res_name = $2, main_office_add = $3
          where id = $1
        `,
        [resId, seed.name, profile.address ?? null],
        client,
      );
    }

    let outletRows = await runQuery<{ id: string }>(
      `
        select id
        from "Outlets"
        where res_id = $1
        order by created_at asc
        limit 1
      `,
      [resId],
      client,
    );

    let outletId = outletRows[0]?.id;
    if (!outletId) {
      outletId = randomUUID();
      await runQuery(
        `
          insert into "Outlets"
            (id, created_at, oultet_username, outlet_name, outlet_add, outlet_main_ph, outlet_working_hours, res_id)
          values
            ($1, now(), $2, $3, $4, $5, $6, $7)
        `,
        [
          outletId,
          `${restaurantSlug}-main`,
          `${seed.name} Main Outlet`,
          profile.address ?? "",
          normalizePhone(profile.phone ?? "") || null,
          profile.hours ?? null,
          resId,
        ],
        client,
      );
    } else {
      await runQuery(
        `
          update "Outlets"
          set
            outlet_name = $2,
            outlet_add = $3,
            outlet_main_ph = $4,
            outlet_working_hours = $5
          where id = $1
        `,
        [
          outletId,
          `${seed.name} Main Outlet`,
          profile.address ?? "",
          normalizePhone(profile.phone ?? "") || null,
          profile.hours ?? null,
        ],
        client,
      );
    }

    const adminUsername = seed.admin.employeeId.trim();
    const adminParts = splitName(seed.admin.name);

    const loginRows = await runQuery<{ emp_id: string }>(
      `
        select emp_id
        from "Login"
        where res_id = $1 and outlet_id = $2 and lower(emp_username) = lower($3)
        limit 1
      `,
      [resId, outletId, adminUsername],
      client,
    );

    let adminEmpId = loginRows[0]?.emp_id;
    if (!adminEmpId) {
      adminEmpId = randomUUID();
      await runQuery(
        `
          insert into "Employees"
            (id, created_at, "emp_Fname", "emp_email", "emp_ph", "emp_add", emp_roles, res_id, outlet_id, "emp_Lname")
          values
            ($1, now(), $2, $3, $4, $5, $6::json, $7, $8, $9)
        `,
        [
          adminEmpId,
          adminParts.first,
          profile.email ?? null,
          normalizePhone(profile.phone ?? "") || null,
          profile.address ?? null,
          JSON.stringify({ primary: "admin", all: ["admin"] }),
          resId,
          outletId,
          adminParts.last,
        ],
        client,
      );

      await runQuery(
        `
          insert into "Login"
            (emp_id, created_at, res_id, outlet_id, emp_username, emp_pass)
          values
            ($1, now(), $2, $3, $4, $5)
        `,
        [adminEmpId, resId, outletId, adminUsername, seed.admin.password],
        client,
      );
    } else {
      await runQuery(
        `
          update "Employees"
          set
            "emp_Fname" = $4,
            "emp_Lname" = $5,
            emp_roles = $6::json,
            "emp_email" = $7,
            "emp_ph" = $8,
            "emp_add" = $9
          where id = $1 and res_id = $2 and outlet_id = $3
        `,
        [
          adminEmpId,
          resId,
          outletId,
          adminParts.first,
          adminParts.last,
          JSON.stringify({ primary: "admin", all: ["admin"] }),
          profile.email ?? null,
          normalizePhone(profile.phone ?? "") || null,
          profile.address ?? null,
        ],
        client,
      );

      await runQuery(
        `
          update "Login"
          set emp_pass = $4
          where res_id = $1 and outlet_id = $2 and lower(emp_username) = lower($3)
        `,
        [resId, outletId, adminUsername, seed.admin.password],
        client,
      );
    }

    for (const table of seed.tables) {
      const existing = await runQuery<{ id: string }>(
        `
          select id
          from "Tables"
          where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3)
          limit 1
        `,
        [resId, outletId, table.name],
        client,
      );

      if (!existing[0]) {
        await runQuery(
          `
            insert into "Tables" (id, created_at, res_id, outlet_id, table_name, capacity)
            values ($1, now(), $2, $3, $4, $5)
          `,
          [randomUUID(), resId, outletId, table.name, Math.max(1, table.capacity)],
          client,
        );
      }
    }
  });
}
