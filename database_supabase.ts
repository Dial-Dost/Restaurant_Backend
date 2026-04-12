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
  role_all?: string[];
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

export type ParkingBayRecord = {
  Bay_id: string;
  Bay_name: string;
  current_capacity: number;
  total_capacity: number;
  restaurant_id: string;
};

export type ValetVehicleStateRecord = {
  booking_id: string;
  state: number;
  entry_time: string | null;
  exit_time: string | null;
  bay_id: string | null;
};

export type ValetVehicleMetaRecord = {
  booking_id: string;
  number_plate: string;
  customer_name: string | null;
};

type AuditLogEntry = {
  id: string;
  employee: string;
  action: string;
  details?: string | null;
  timestamp: Date;
};

export type InventoryItemRecord = {
  id: string;
  name: string;
  category: string;
  stock: number;
  unit: string;
  status: "In Stock" | "Low Stock" | "Out of Stock";
};

export type MenuItemRecord = {
  id: string;
  name: string;
  price: number;
  category: string;
};

export type OrderItemRecord = {
  id: string;
  name: string;
  quantity: number;
  price: number;
  orderedAt: string;
};

export type OrderRecord = {
  id: string;
  table: string;
  customer: string;
  items: OrderItemRecord[];
  subtotal: number;
  serviceChargePercentage?: number;
  taxes?: Array<{ id: string; name: string; percentage: number }>;
  applyServiceCharge: boolean;
  total: number;
  status: "Preparing" | "Served" | "Paid";
};

export type TableAssignmentRecord = {
  id: string;
  table_name: string;
  employee_id: string;
  employee_name: string;
  employee_role: string;
};

export type ApcZone = "red" | "yellow" | "green";

export type OrderApcInsight = {
  order_id: string;
  table_name: string;
  created_at: string;
  total: number;
  people_count: number;
  target_total: number;
  zone: ApcZone;
  assigned_employee_id: string | null;
  assigned_employee_name: string | null;
};

export type EmployeeApcIncentive = {
  employee_id: string;
  employee_name: string;
  employee_role: string;
  assigned_tables: string[];
  orders_count: number;
  covers_count: number;
  mean_apc: number;
  zone: ApcZone;
};

export type MonthlyApcInsight = {
  month: string;
  monthly_apc: number;
  total_revenue: number;
  total_covers: number;
  yellow_band_percent: number;
  orders: OrderApcInsight[];
  employee_incentives: EmployeeApcIncentive[];
};

export type RestaurantProfileRecord = {
  name: string;
  address: string;
  phone: string;
  email: string;
  hours: string;
};

export type RoleRecord = {
  id: string;
  role_name: string;
  actions_performable: string[];
};

type EmployeeRolesPayload = {
  primary: string;
  all: string[];
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

function normalizeVehiclePlate(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
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

function toNonNegativeInt(value: unknown): number {
  return Math.max(0, Math.round(parseNumeric(value)));
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

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function parseEmployeeRoles(raw: unknown): EmployeeRolesPayload {
  const parsed = parseJsonObject(raw);
  const primaryRaw = String(parsed?.primary ?? "employee").trim().toLowerCase() || "employee";
  const allRaw = Array.isArray(parsed?.all)
    ? parsed!.all.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean)
    : [];

  const all = Array.from(new Set([primaryRaw, ...allRaw]));
  return {
    primary: primaryRaw,
    all: all.length > 0 ? all : ["employee"],
  };
}

function inventoryStatusFromStock(stock: number): InventoryItemRecord["status"] {
  if (stock <= 0) return "Out of Stock";
  if (stock < 10) return "Low Stock";
  return "In Stock";
}

function encodeInventoryDescription(payload: { category?: string; unit?: string }): string {
  return JSON.stringify({
    category: payload.category?.trim() || "General",
    unit: payload.unit?.trim() || "pcs",
  });
}

function parseInventoryDescription(description: string | null): { category: string; unit: string } {
  if (!description) {
    return { category: "General", unit: "pcs" };
  }
  const parsed = parseJsonObject(description);
  if (!parsed) {
    return { category: "General", unit: "pcs" };
  }
  return {
    category: String(parsed.category ?? "General") || "General",
    unit: String(parsed.unit ?? "pcs") || "pcs",
  };
}

function encodeMenuDescription(payload: { price: number }): string {
  return JSON.stringify({ price: Number.isFinite(payload.price) ? payload.price : 0 });
}

function parseMenuDescription(description: string | null): { price: number } {
  if (!description) return { price: 0 };
  const parsed = parseJsonObject(description);
  if (!parsed) return { price: 0 };
  return { price: parseNumeric(parsed.price) };
}

function toOrderStatusCode(status: string | undefined): number {
  const lowered = String(status ?? "preparing").trim().toLowerCase();
  if (lowered === "paid") return 3;
  if (lowered === "served") return 2;
  return 1;
}

function fromOrderStatusCode(status: unknown): OrderRecord["status"] {
  const code = Math.round(parseNumeric(status));
  if (code >= 3) return "Paid";
  if (code === 2) return "Served";
  return "Preparing";
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

async function resolveParkingBayId(
  context: RestaurantContext,
  bayIdentifier: string,
  client?: PoolClient,
): Promise<string | null> {
  const trimmed = bayIdentifier.trim();
  if (!trimmed) return null;

  if (isUuid(trimmed)) {
    const rows = await runQuery<{ id: string }>(
      `
        select id
        from "Parking_Bays"
        where res_id = $1 and outlet_id = $2 and id = $3
        limit 1
      `,
      [context.res_id, context.outlet_id, trimmed],
      client,
    );
    if (rows[0]?.id) return rows[0].id;
  }

  const byName = await runQuery<{ id: string }>(
    `
      select id
      from "Parking_Bays"
      where res_id = $1 and outlet_id = $2 and lower(bay_name) = lower($3)
      limit 1
    `,
    [context.res_id, context.outlet_id, trimmed],
    client,
  );

  return byName[0]?.id ?? null;
}

async function ensureDefaultParkingBayId(
  context: RestaurantContext,
  client?: PoolClient,
): Promise<string> {
  const preferredName = "Main";

  const preferred = await runQuery<{ id: string }>(
    `
      select id
      from "Parking_Bays"
      where res_id = $1 and outlet_id = $2 and lower(bay_name) = lower($3)
      limit 1
    `,
    [context.res_id, context.outlet_id, preferredName],
    client,
  );
  if (preferred[0]?.id) return preferred[0].id;

  const first = await runQuery<{ id: string }>(
    `
      select id
      from "Parking_Bays"
      where res_id = $1 and outlet_id = $2
      order by created_at asc
      limit 1
    `,
    [context.res_id, context.outlet_id],
    client,
  );
  if (first[0]?.id) return first[0].id;

  const inserted = await runQuery<{ id: string }>(
    `
      insert into "Parking_Bays"
        (id, created_at, bay_name, current_capacity, total_capacity, res_id, outlet_id)
      values
        ($1, now(), $2, 0, $3, $4, $5)
      returning id
    `,
    [randomUUID(), preferredName, 5, context.res_id, context.outlet_id],
    client,
  );

  return inserted[0]!.id;
}

async function ensureValetVehicleMetaTable(client?: PoolClient): Promise<void> {
  await runQuery(
    `
      create table if not exists "Valet_vehicle_meta" (
        booking_id uuid primary key,
        res_id uuid not null,
        outlet_id uuid not null,
        number_plate text not null,
        customer_name text null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `,
    [],
    client,
  );

  await runQuery(
    `
      create index if not exists valet_vehicle_meta_lookup_idx
      on "Valet_vehicle_meta" (res_id, outlet_id, booking_id)
    `,
    [],
    client,
  );
}

export async function GetParkingBays(
  restaurantId: string,
): Promise<ParkingBayRecord[]> {
  const context = await requireRestaurantContext(restaurantId);
  const rows = await runQuery<{
    id: string;
    bay_name: string;
    current_capacity: unknown;
    total_capacity: unknown;
  }>(
    `
      select id, bay_name, current_capacity, total_capacity
      from "Parking_Bays"
      where res_id = $1 and outlet_id = $2
      order by created_at asc
    `,
    [context.res_id, context.outlet_id],
  );

  return rows.map((row) => ({
    Bay_id: row.id,
    Bay_name: row.bay_name,
    current_capacity: toNonNegativeInt(row.current_capacity),
    total_capacity: toNonNegativeInt(row.total_capacity),
    restaurant_id: context.inputId,
  }));
}

export async function AddParkingBay(
  restaurantId: string,
  bayName: string,
  totalCapacity: number,
): Promise<ParkingBayRecord> {
  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client);
    const normalizedName = bayName.trim();

    const existing = await runQuery<{
      id: string;
      bay_name: string;
      current_capacity: unknown;
      total_capacity: unknown;
    }>(
      `
        select id, bay_name, current_capacity, total_capacity
        from "Parking_Bays"
        where res_id = $1 and outlet_id = $2 and lower(bay_name) = lower($3)
        limit 1
      `,
      [context.res_id, context.outlet_id, normalizedName],
      client,
    );

    if (existing[0]) {
      return {
        Bay_id: existing[0].id,
        Bay_name: existing[0].bay_name,
        current_capacity: toNonNegativeInt(existing[0].current_capacity),
        total_capacity: toNonNegativeInt(existing[0].total_capacity),
        restaurant_id: context.inputId,
      };
    }

    const inserted = await runQuery<{
      id: string;
      bay_name: string;
      current_capacity: unknown;
      total_capacity: unknown;
    }>(
      `
        insert into "Parking_Bays"
          (id, created_at, bay_name, current_capacity, total_capacity, res_id, outlet_id)
        values
          ($1, now(), $2, 0, $3, $4, $5)
        returning id, bay_name, current_capacity, total_capacity
      `,
      [
        randomUUID(),
        normalizedName,
        toNonNegativeInt(totalCapacity),
        context.res_id,
        context.outlet_id,
      ],
      client,
    );

    const row = inserted[0]!;
    return {
      Bay_id: row.id,
      Bay_name: row.bay_name,
      current_capacity: toNonNegativeInt(row.current_capacity),
      total_capacity: toNonNegativeInt(row.total_capacity),
      restaurant_id: context.inputId,
    };
  });
}

export async function UpdateParkingBay(
  restaurantId: string,
  bayId: string | null,
  bayName: string,
  totalCapacity: number,
): Promise<ParkingBayRecord | null> {
  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client);
    const normalizedName = bayName.trim();

    let targetId: string | null = null;
    if (bayId?.trim()) {
      targetId = await resolveParkingBayId(context, bayId.trim(), client);
    }
    if (!targetId) {
      targetId = await resolveParkingBayId(context, normalizedName, client);
    }
    if (!targetId) return null;

    const rows = await runQuery<{
      id: string;
      bay_name: string;
      current_capacity: unknown;
      total_capacity: unknown;
    }>(
      `
        update "Parking_Bays"
        set bay_name = $4, total_capacity = $5
        where id = $1 and res_id = $2 and outlet_id = $3
        returning id, bay_name, current_capacity, total_capacity
      `,
      [
        targetId,
        context.res_id,
        context.outlet_id,
        normalizedName,
        toNonNegativeInt(totalCapacity),
      ],
      client,
    );

    const row = rows[0];
    if (!row) return null;
    return {
      Bay_id: row.id,
      Bay_name: row.bay_name,
      current_capacity: toNonNegativeInt(row.current_capacity),
      total_capacity: toNonNegativeInt(row.total_capacity),
      restaurant_id: context.inputId,
    };
  });
}

export async function DeleteParkingBay(
  restaurantId: string,
  bayId: string | null,
  bayName: string | null,
): Promise<{ Bay_id: string; deleted_valet_count: number } | null> {
  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client);

    let targetId: string | null = null;
    if (bayId?.trim()) {
      targetId = await resolveParkingBayId(context, bayId.trim(), client);
    }
    if (!targetId && bayName?.trim()) {
      targetId = await resolveParkingBayId(context, bayName.trim(), client);
    }
    if (!targetId) return null;

    const deletedValetRows = await runQuery<{ id: string }>(
      `
        delete from "Valet_vehicle_state"
        where res_id = $1 and outlet_id = $2 and bay_id = $3
        returning id
      `,
      [context.res_id, context.outlet_id, targetId],
      client,
    );

    const deletedBayRows = await runQuery<{ id: string }>(
      `
        delete from "Parking_Bays"
        where id = $1 and res_id = $2 and outlet_id = $3
        returning id
      `,
      [targetId, context.res_id, context.outlet_id],
      client,
    );

    if (!deletedBayRows[0]) return null;

    return {
      Bay_id: targetId,
      deleted_valet_count: deletedValetRows.length,
    };
  });
}

export async function SetParkingBayCurrent(
  restaurantId: string,
  bayId: string,
  currentCapacity: number,
): Promise<ParkingBayRecord | null> {
  const context = await requireRestaurantContext(restaurantId);
  const targetId = await resolveParkingBayId(context, bayId);
  if (!targetId) return null;

  const rows = await runQuery<{
    id: string;
    bay_name: string;
    current_capacity: unknown;
    total_capacity: unknown;
  }>(
    `
      update "Parking_Bays"
      set current_capacity = $4
      where id = $1 and res_id = $2 and outlet_id = $3
      returning id, bay_name, current_capacity, total_capacity
    `,
    [targetId, context.res_id, context.outlet_id, toNonNegativeInt(currentCapacity)],
  );

  const row = rows[0];
  if (!row) return null;
  return {
    Bay_id: row.id,
    Bay_name: row.bay_name,
    current_capacity: toNonNegativeInt(row.current_capacity),
    total_capacity: toNonNegativeInt(row.total_capacity),
    restaurant_id: context.inputId,
  };
}

export async function GetValetVehicleStates(
  restaurantId: string,
): Promise<ValetVehicleStateRecord[]> {
  const context = await requireRestaurantContext(restaurantId);
  const rows = await runQuery<{
    id: string;
    entry_time: Date | string | null;
    exit_time: Date | string | null;
    state: unknown;
    bay_id: string | null;
  }>(
    `
      select id, entry_time, exit_time, state, bay_id
      from "Valet_vehicle_state"
      where res_id = $1 and outlet_id = $2
      order by entry_time desc nulls last
    `,
    [context.res_id, context.outlet_id],
  );

  return rows.map((row) => ({
    booking_id: row.id,
    state: toNonNegativeInt(row.state),
    entry_time: row.entry_time ? new Date(row.entry_time).toISOString() : null,
    exit_time: row.exit_time ? new Date(row.exit_time).toISOString() : null,
    bay_id: row.bay_id,
  }));
}

export async function GetValetVehicleMetaByBookingIds(
  restaurantId: string,
  bookingIds: string[],
): Promise<Record<string, ValetVehicleMetaRecord>> {
  if (bookingIds.length === 0) {
    return {};
  }

  const context = await requireRestaurantContext(restaurantId);
  await ensureValetVehicleMetaTable();

  const rows = await runQuery<{
    booking_id: string;
    number_plate: string;
    customer_name: string | null;
  }>(
    `
      select booking_id, number_plate, customer_name
      from "Valet_vehicle_meta"
      where res_id = $1 and outlet_id = $2 and booking_id = any($3::uuid[])
    `,
    [context.res_id, context.outlet_id, bookingIds],
  );

  const out: Record<string, ValetVehicleMetaRecord> = {};
  for (const row of rows) {
    out[row.booking_id] = {
      booking_id: row.booking_id,
      number_plate: row.number_plate,
      customer_name: row.customer_name,
    };
  }
  return out;
}

export async function UpsertValetVehicleMeta(
  restaurantId: string,
  bookingId: string,
  numberPlate: string,
  customerName?: string | null,
): Promise<ValetVehicleMetaRecord> {
  const normalizedPlate = normalizeVehiclePlate(numberPlate);
  if (!normalizedPlate) {
    throw new Error("number_plate is required");
  }

  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client);
    await ensureValetVehicleMetaTable(client);

    const rows = await runQuery<{
      booking_id: string;
      number_plate: string;
      customer_name: string | null;
    }>(
      `
        insert into "Valet_vehicle_meta"
          (booking_id, res_id, outlet_id, number_plate, customer_name, created_at, updated_at)
        values
          ($1, $2, $3, $4, $5, now(), now())
        on conflict (booking_id)
        do update set
          number_plate = excluded.number_plate,
          customer_name = excluded.customer_name,
          updated_at = now()
        returning booking_id, number_plate, customer_name
      `,
      [
        bookingId,
        context.res_id,
        context.outlet_id,
        normalizedPlate,
        customerName?.trim() ? customerName.trim() : null,
      ],
      client,
    );

    const row = rows[0]!;
    return {
      booking_id: row.booking_id,
      number_plate: row.number_plate,
      customer_name: row.customer_name,
    };
  });
}

export async function CreateValetVehicleState(
  restaurantId: string,
  entryTime?: Date,
  bayIdentifier?: string,
): Promise<{ booking_id: string; entry_time: string; bay_id: string }> {
  return withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client);
    let bayId: string | null = null;
    if (bayIdentifier?.trim()) {
      bayId = await resolveParkingBayId(context, bayIdentifier, client);
    }
    if (!bayId) {
      bayId = await ensureDefaultParkingBayId(context, client);
    }
    const normalizedEntryTime = entryTime && !Number.isNaN(entryTime.getTime()) ? entryTime : new Date();

    const rows = await runQuery<{ id: string; entry_time: Date | string; bay_id: string }>(
      `
        insert into "Valet_vehicle_state"
          (id, entry_time, res_id, outlet_id, state, exit_time, bay_id)
        values
          ($1, $2, $3, $4, 1, null, $5)
        returning id, entry_time, bay_id
      `,
      [randomUUID(), normalizedEntryTime.toISOString(), context.res_id, context.outlet_id, bayId],
      client,
    );

    const row = rows[0]!;
    return {
      booking_id: row.id,
      entry_time: new Date(row.entry_time).toISOString(),
      bay_id: row.bay_id,
    };
  });
}

export async function GetValetVehicleState(
  restaurantId: string,
  bookingId: string,
): Promise<ValetVehicleStateRecord | null> {
  const context = await requireRestaurantContext(restaurantId);
  const rows = await runQuery<{
    id: string;
    entry_time: Date | string | null;
    exit_time: Date | string | null;
    state: unknown;
    bay_id: string | null;
  }>(
    `
      select id, entry_time, exit_time, state, bay_id
      from "Valet_vehicle_state"
      where id = $1 and res_id = $2 and outlet_id = $3
      limit 1
    `,
    [bookingId, context.res_id, context.outlet_id],
  );

  const row = rows[0];
  if (!row) return null;
  return {
    booking_id: row.id,
    state: toNonNegativeInt(row.state),
    entry_time: row.entry_time ? new Date(row.entry_time).toISOString() : null,
    exit_time: row.exit_time ? new Date(row.exit_time).toISOString() : null,
    bay_id: row.bay_id,
  };
}

export async function UpdateValetVehicleState(
  restaurantId: string,
  bookingId: string,
  state: number,
): Promise<{ booking_id: string } | null> {
  const context = await requireRestaurantContext(restaurantId);
  const normalizedState = toNonNegativeInt(state);

  const rows = await runQuery<{ id: string }>(
    `
      update "Valet_vehicle_state"
      set
        state = $4::int,
        exit_time = case when $4::int = 6 then now() else exit_time end
      where id = $1 and res_id = $2 and outlet_id = $3
      returning id
    `,
    [bookingId, context.res_id, context.outlet_id, normalizedState],
  );

  if (!rows[0]) return null;
  return { booking_id: rows[0].id };
}

export async function UpdateValetVehicleBay(
  restaurantId: string,
  bookingId: string,
  bayIdentifier: string | null,
): Promise<{ booking_id: string; bay_id: string | null } | null> {
  const context = await requireRestaurantContext(restaurantId);

  let resolvedBayId: string | null = null;
  if (bayIdentifier && bayIdentifier.trim()) {
    resolvedBayId = await resolveParkingBayId(context, bayIdentifier.trim());
    if (!resolvedBayId) {
      throw new Error(`Unknown bay id or name: ${bayIdentifier}`);
    }
  } else {
    // Some deployed schemas require bay_id to be NOT NULL, so fallback to a default bay.
    resolvedBayId = await ensureDefaultParkingBayId(context);
  }

  const rows = await runQuery<{ id: string; bay_id: string | null }>(
    `
      update "Valet_vehicle_state"
      set bay_id = $4
      where id = $1 and res_id = $2 and outlet_id = $3
      returning id, bay_id
    `,
    [bookingId, context.res_id, context.outlet_id, resolvedBayId],
  );

  const row = rows[0];
  if (!row) return null;
  return {
    booking_id: row.id,
    bay_id: row.bay_id,
  };
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

export async function GetInventoryItems(restaurantId: string): Promise<InventoryItemRecord[]> {
  const context = await requireRestaurantContext(restaurantId);
  const rows = await runQuery<{
    barcode: string;
    name: string;
    description: string | null;
    quantity: unknown;
  }>(
    `
      select
        barcode,
        name,
        description,
        "Quantity" as quantity
      from "Inventory"
      where res_id = $1 and outlet_id = $2
      order by created_at desc
    `,
    [context.res_id, context.outlet_id],
  );

  return rows.map((row) => {
    const qty = Math.max(0, Math.round(parseNumeric(row.quantity)));
    const meta = parseInventoryDescription(row.description);
    return {
      id: row.barcode,
      name: row.name,
      category: meta.category,
      stock: qty,
      unit: meta.unit,
      status: inventoryStatusFromStock(qty),
    };
  });
}

export async function UpsertInventoryItem(
  restaurantId: string,
  item: {
    id?: string;
    name: string;
    category?: string;
    stock: number;
    unit?: string;
  },
): Promise<{ id: string }> {
  const context = await requireRestaurantContext(restaurantId);
  const barcode = (item.id?.trim() || randomUUID()).slice(0, 128);

  await runQuery(
    `
      insert into "Inventory"
        (barcode, created_at, name, res_id, outlet_id, description, "Quantity")
      values
        ($1, now(), $2, $3, $4, $5, $6)
      on conflict (barcode, res_id, outlet_id)
      do update set
        name = excluded.name,
        description = excluded.description,
        "Quantity" = excluded."Quantity"
    `,
    [
      barcode,
      item.name.trim(),
      context.res_id,
      context.outlet_id,
      encodeInventoryDescription({ category: item.category, unit: item.unit }),
      Math.max(0, Math.round(item.stock)),
    ],
  );

  return { id: barcode };
}

export async function DeleteInventoryItem(
  restaurantId: string,
  inventoryId: string,
): Promise<boolean> {
  const context = await requireRestaurantContext(restaurantId);
  const rows = await runQuery<{ barcode: string }>(
    `
      delete from "Inventory"
      where res_id = $1 and outlet_id = $2 and barcode = $3
      returning barcode
    `,
    [context.res_id, context.outlet_id, inventoryId.trim()],
  );

  return rows.length > 0;
}

async function ensureMenuCategoryIds(
  context: RestaurantContext,
  categoryName: string,
  client?: PoolClient,
): Promise<{ main_cat_id: string; sub_cat_id: string }> {
  const normalized = categoryName.trim() || "General";

  let main = await runQuery<{ id: string }>(
    `
      select id
      from "Menue_main_cat"
      where res_id = $1 and outlet_id = $2 and lower(name) = lower($3)
      limit 1
    `,
    [context.res_id, context.outlet_id, normalized],
    client,
  );

  let mainId = main[0]?.id;
  if (!mainId) {
    mainId = randomUUID();
    await runQuery(
      `
        insert into "Menue_main_cat"
          (id, created_at, res_id, outlet_id, name, avg_time)
        values
          ($1, now(), $2, $3, $4, $5)
      `,
      [mainId, context.res_id, context.outlet_id, normalized, "15 mins"],
      client,
    );
  }

  let sub = await runQuery<{ id: string }>(
    `
      select id
      from "Menue_sub_cat"
      where res_id = $1 and outlet_id = $2 and main_cat_id = $3 and lower(name) = lower($4)
      limit 1
    `,
    [context.res_id, context.outlet_id, mainId, normalized],
    client,
  );

  let subId = sub[0]?.id;
  if (!subId) {
    subId = randomUUID();
    await runQuery(
      `
        insert into "Menue_sub_cat"
          (id, created_at, res_id, outlet_id, name, avg_time, main_cat_id)
        values
          ($1, now(), $2, $3, $4, $5, $6)
      `,
      [subId, context.res_id, context.outlet_id, normalized, "15 mins", mainId],
      client,
    );
  }

  return { main_cat_id: mainId, sub_cat_id: subId };
}

export async function GetMenuItems(restaurantId: string): Promise<MenuItemRecord[]> {
  const context = await requireRestaurantContext(restaurantId);
  const rows = await runQuery<{
    id: string;
    name: string;
    description: string | null;
    sub_category: string | null;
    main_category: string | null;
  }>(
    `
      select
        m.id,
        m.name,
        m.description,
        ms.name as sub_category,
        mm.name as main_category
      from "Menu" m
      left join "Menue_sub_cat" ms
        on ms.id = m.sub_cat_id and ms.res_id = m.res_id and ms.outlet_id = m.outlet_id
      left join "Menue_main_cat" mm
        on mm.id = m.main_cat_id and mm.res_id = m.res_id and mm.outlet_id = m.outlet_id
      where m.res_id = $1 and m.outlet_id = $2
      order by m.created_at desc
    `,
    [context.res_id, context.outlet_id],
  );

  return rows.map((row) => {
    const parsed = parseMenuDescription(row.description);
    return {
      id: row.id,
      name: row.name,
      price: parsed.price,
      category: row.sub_category ?? row.main_category ?? "General",
    };
  });
}

export async function GetMenuCategories(restaurantId: string): Promise<string[]> {
  const context = await requireRestaurantContext(restaurantId);
  const rows = await runQuery<{ category_name: string }>(
    `
      select distinct name as category_name
      from "Menue_sub_cat"
      where res_id = $1 and outlet_id = $2
      order by category_name asc
    `,
    [context.res_id, context.outlet_id],
  );

  return rows.map((row) => row.category_name).filter(Boolean);
}

export async function UpsertMenuItem(
  restaurantId: string,
  item: MenuItemRecord,
  client?: PoolClient,
): Promise<{ id: string }> {
  const context = await requireRestaurantContext(restaurantId, client);
  const ids = await ensureMenuCategoryIds(context, item.category, client);
  const itemId = isUuid(item.id) ? item.id : randomUUID();

  await runQuery(
    `
      insert into "Menu"
        (id, created_at, res_id, outlet_id, name, description, main_cat_id, sub_cat_id, avg_time)
      values
        ($1, now(), $2, $3, $4, $5, $6, $7, $8)
      on conflict (id, res_id, outlet_id)
      do update set
        name = excluded.name,
        description = excluded.description,
        main_cat_id = excluded.main_cat_id,
        sub_cat_id = excluded.sub_cat_id,
        avg_time = excluded.avg_time
    `,
    [
      itemId,
      context.res_id,
      context.outlet_id,
      item.name.trim(),
      encodeMenuDescription({ price: item.price }),
      ids.main_cat_id,
      ids.sub_cat_id,
      "15 mins",
    ],
    client,
  );

  return { id: itemId };
}

export async function SaveMenuItems(
  restaurantId: string,
  items: MenuItemRecord[],
): Promise<void> {
  await withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client);
    const keepIds: string[] = [];

    for (const item of items) {
      const upserted = await UpsertMenuItem(
        restaurantId,
        {
          id: item.id,
          name: item.name,
          price: item.price,
          category: item.category,
        },
        client,
      );
      keepIds.push(upserted.id);
    }

    if (keepIds.length === 0) {
      await runQuery(
        `
          delete from "Menu"
          where res_id = $1 and outlet_id = $2
        `,
        [context.res_id, context.outlet_id],
        client,
      );
      return;
    }

    await runQuery(
      `
        delete from "Menu"
        where res_id = $1 and outlet_id = $2 and not (id = any($3::uuid[]))
      `,
      [context.res_id, context.outlet_id, keepIds],
      client,
    );
  });
}

export async function EnsureMenuCategory(
  restaurantId: string,
  categoryName: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const context = await requireRestaurantContext(restaurantId, client);
    await ensureMenuCategoryIds(context, categoryName, client);
  });
}

export async function GetOrders(restaurantId: string): Promise<OrderRecord[]> {
  const context = await requireRestaurantContext(restaurantId);
  const rows = await runQuery<{
    id: string;
    food: unknown;
    status: unknown;
    table_name: string | null;
  }>(
    `
      select
        o.id,
        o.food,
        o.status,
        t.table_name
      from "Orders" o
      left join "Tables" t
        on t.id = o.table_id and t.res_id = o.res_id and t.outlet_id = o.outlet_id
      where o.res_id = $1 and o.outlet_id = $2
      order by o.created_at desc
    `,
    [context.res_id, context.outlet_id],
  );

  return rows.map((row) => {
    const payload = parseJsonObject(row.food) ?? {};
    const items = Array.isArray(payload.items)
      ? payload.items.map((entry: any) => ({
          id: String(entry.id ?? randomUUID()),
          name: String(entry.name ?? "Unknown"),
          quantity: Math.max(1, Math.round(parseNumeric(entry.quantity))),
          price: parseNumeric(entry.price),
          orderedAt: String(entry.orderedAt ?? new Date().toISOString()),
        }))
      : [];

    const subtotal = parseNumeric(payload.subtotal);
    const total = parseNumeric(payload.total);
    return {
      id: row.id,
      table: String(payload.table ?? row.table_name ?? ""),
      customer: String(payload.customer ?? "Guest"),
      items,
      subtotal,
      serviceChargePercentage: Number.isFinite(parseNumeric(payload.serviceChargePercentage))
        ? parseNumeric(payload.serviceChargePercentage)
        : undefined,
      taxes: Array.isArray(payload.taxes)
        ? payload.taxes.map((tax: any) => ({
            id: String(tax.id ?? randomUUID()),
            name: String(tax.name ?? "Tax"),
            percentage: parseNumeric(tax.percentage),
          }))
        : undefined,
      applyServiceCharge: Boolean(payload.applyServiceCharge),
      total: total > 0 ? total : subtotal,
      status: (String(payload.status ?? "").trim() as OrderRecord["status"]) || fromOrderStatusCode(row.status),
    };
  });
}

export async function AddOrder(
  restaurantId: string,
  order: Partial<OrderRecord>,
): Promise<{ id: string }> {
  const context = await requireRestaurantContext(restaurantId);
  const tableName = String(order.table ?? "").trim();
  if (!tableName) {
    throw new Error("Order table is required");
  }

  const tableRows = await runQuery<{ id: string }>(
    `
      select id
      from "Tables"
      where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3)
      limit 1
    `,
    [context.res_id, context.outlet_id, tableName],
  );
  const table = tableRows[0];
  if (!table) {
    throw new Error("Table not found for order");
  }

  let customerId: string | null = null;
  const customerName = String(order.customer ?? "").trim();
  if (customerName) {
    const parts = splitName(customerName);
    const customerRows = await runQuery<{ id: string }>(
      `
        select id
        from "Customers"
        where
          res_id = $1 and outlet_id = $2
          and lower("cust_Fname") = lower($3)
          and lower("cust_Lname") = lower($4)
        limit 1
      `,
      [context.res_id, context.outlet_id, parts.first, parts.last],
    );
    customerId = customerRows[0]?.id ?? null;
  }

  const id = isUuid(String(order.id ?? "")) ? String(order.id) : randomUUID();
  const statusCode = toOrderStatusCode(String(order.status ?? "Preparing"));
  const payload = {
    id,
    table: tableName,
    customer: customerName || "Guest",
    items: Array.isArray(order.items) ? order.items : [],
    subtotal: parseNumeric(order.subtotal),
    serviceChargePercentage: parseNumeric(order.serviceChargePercentage),
    taxes: Array.isArray(order.taxes) ? order.taxes : [],
    applyServiceCharge: Boolean(order.applyServiceCharge),
    total: parseNumeric(order.total),
    status: String(order.status ?? "Preparing"),
  };

  await runQuery(
    `
      insert into "Orders"
        (id, created_at, res_id, outlet_id, food, table_id, status, cust_id)
      values
        ($1, now(), $2, $3, $4::json, $5, $6, $7)
      on conflict (id, res_id, outlet_id)
      do update set
        food = excluded.food,
        table_id = excluded.table_id,
        status = excluded.status,
        cust_id = excluded.cust_id
    `,
    [id, context.res_id, context.outlet_id, JSON.stringify(payload), table.id, statusCode, customerId],
  );

  return { id };
}

async function ensureTableAssignmentsTable(client?: PoolClient): Promise<void> {
  await runQuery(
    `
      create table if not exists "Table_assignments" (
        id uuid primary key,
        created_at timestamptz not null default now(),
        res_id uuid not null,
        outlet_id uuid not null,
        table_id uuid not null,
        employee_id uuid not null
      )
    `,
    [],
    client,
  );

  await runQuery(
    `
      create unique index if not exists idx_table_assignments_unique
      on "Table_assignments" (res_id, outlet_id, table_id)
    `,
    [],
    client,
  );

  await runQuery(
    `
      create index if not exists idx_table_assignments_employee
      on "Table_assignments" (res_id, outlet_id, employee_id)
    `,
    [],
    client,
  );
}

function toApcZone(current: number, target: number, yellowBandPercent = 0.1): ApcZone {
  if (!Number.isFinite(target) || target <= 0) {
    return "yellow";
  }

  const lower = target * (1 - yellowBandPercent);
  const upper = target * (1 + yellowBandPercent);
  if (current < lower) return "red";
  if (current <= upper) return "yellow";
  return "green";
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

async function resolveTableByName(
  context: RestaurantContext,
  tableName: string,
  client?: PoolClient,
): Promise<{ id: string; table_name: string } | null> {
  const rows = await runQuery<{ id: string; table_name: string }>(
    `
      select id, table_name
      from "Tables"
      where res_id = $1 and outlet_id = $2 and lower(table_name) = lower($3)
      limit 1
    `,
    [context.res_id, context.outlet_id, tableName.trim()],
    client,
  );
  return rows[0] ?? null;
}

async function resolveEmployeeByUsername(
  context: RestaurantContext,
  employeeId: string,
  client?: PoolClient,
): Promise<{ id: string; username: string; name: string; role_primary: string } | null> {
  const rows = await runQuery<{
    id: string;
    username: string;
    fname: string;
    lname: string;
    role_primary: string | null;
  }>(
    `
      select
        e.id,
        l.emp_username as username,
        e."emp_Fname" as fname,
        e."emp_Lname" as lname,
        e.emp_roles->>'primary' as role_primary
      from "Login" l
      join "Employees" e
        on e.id = l.emp_id and e.res_id = l.res_id and e.outlet_id = l.outlet_id
      where
        l.res_id = $1
        and l.outlet_id = $2
        and lower(l.emp_username) = lower($3)
      limit 1
    `,
    [context.res_id, context.outlet_id, employeeId.trim()],
    client,
  );

  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    name: `${row.fname} ${row.lname}`.trim(),
    role_primary: row.role_primary ?? "employee",
  };
}

export async function AssignTableToEmployee(
  restaurantId: string,
  tableName: string,
  employeeId: string,
): Promise<TableAssignmentRecord> {
  return withTransaction(async (client) => {
    await ensureTableAssignmentsTable(client);
    const context = await requireRestaurantContext(restaurantId, client);

    const table = await resolveTableByName(context, tableName, client);
    if (!table) {
      throw new Error("Table not found");
    }

    const employee = await resolveEmployeeByUsername(context, employeeId, client);
    if (!employee) {
      throw new Error("Employee not found");
    }

    const assignmentId = randomUUID();
    await runQuery(
      `
        insert into "Table_assignments" (id, created_at, res_id, outlet_id, table_id, employee_id)
        values ($1, now(), $2, $3, $4, $5)
        on conflict (res_id, outlet_id, table_id)
        do update set employee_id = excluded.employee_id
      `,
      [assignmentId, context.res_id, context.outlet_id, table.id, employee.id],
      client,
    );

    return {
      id: assignmentId,
      table_name: table.table_name,
      employee_id: employee.username,
      employee_name: employee.name,
      employee_role: employee.role_primary,
    };
  });
}

export async function UnassignTableEmployee(
  restaurantId: string,
  tableName: string,
): Promise<boolean> {
  return withTransaction(async (client) => {
    await ensureTableAssignmentsTable(client);
    const context = await requireRestaurantContext(restaurantId, client);
    const table = await resolveTableByName(context, tableName, client);
    if (!table) {
      return false;
    }

    const rows = await runQuery<{ id: string }>(
      `
        delete from "Table_assignments"
        where res_id = $1 and outlet_id = $2 and table_id = $3
        returning id
      `,
      [context.res_id, context.outlet_id, table.id],
      client,
    );

    return Boolean(rows[0]);
  });
}

export async function GetTableAssignments(
  restaurantId: string,
): Promise<TableAssignmentRecord[]> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureTableAssignmentsTable();

  const rows = await runQuery<{
    id: string;
    table_name: string;
    employee_username: string;
    fname: string;
    lname: string;
    role_primary: string | null;
  }>(
    `
      select
        ta.id,
        t.table_name,
        l.emp_username as employee_username,
        e."emp_Fname" as fname,
        e."emp_Lname" as lname,
        e.emp_roles->>'primary' as role_primary
      from "Table_assignments" ta
      join "Tables" t
        on t.id = ta.table_id and t.res_id = ta.res_id and t.outlet_id = ta.outlet_id
      join "Employees" e
        on e.id = ta.employee_id and e.res_id = ta.res_id and e.outlet_id = ta.outlet_id
      left join "Login" l
        on l.emp_id = e.id and l.res_id = e.res_id and l.outlet_id = e.outlet_id
      where ta.res_id = $1 and ta.outlet_id = $2
      order by t.table_name asc
    `,
    [context.res_id, context.outlet_id],
  );

  return rows.map((row) => ({
    id: row.id,
    table_name: row.table_name,
    employee_id: row.employee_username,
    employee_name: `${row.fname} ${row.lname}`.trim(),
    employee_role: row.role_primary ?? "employee",
  }));
}

export async function GetMonthlyApcInsights(
  restaurantId: string,
  monthStartInput?: Date,
): Promise<MonthlyApcInsight> {
  const context = await requireRestaurantContext(restaurantId);
  await ensureTableAssignmentsTable();

  const now = new Date();
  const base = monthStartInput && !Number.isNaN(monthStartInput.getTime()) ? monthStartInput : now;
  const monthStart = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1, 0, 0, 0, 0));
  const monthEnd = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  const monthLabel = `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, "0")}`;
  const yellowBandPercent = 0.1;

  const orderRows = await runQuery<{
    id: string;
    created_at: Date | string;
    table_id: string;
    table_name: string | null;
    food: unknown;
  }>(
    `
      select o.id, o.created_at, o.table_id, t.table_name, o.food
      from "Orders" o
      left join "Tables" t
        on t.id = o.table_id and t.res_id = o.res_id and t.outlet_id = o.outlet_id
      where
        o.res_id = $1 and o.outlet_id = $2
        and o.created_at >= $3 and o.created_at < $4
      order by o.created_at desc
    `,
    [context.res_id, context.outlet_id, monthStart.toISOString(), monthEnd.toISOString()],
  );

  const bookingRows = await runQuery<{
    table_id: string;
    num_adults: unknown;
    num_kids: unknown;
    slot: string;
    created_at: Date;
  }>(
    `
      select table_id, num_adults, num_kids, slot, created_at
      from "Bookings"
      where
        res_id = $1 and outlet_id = $2
        and created_at >= ($3::timestamptz - interval '2 days')
        and created_at < ($4::timestamptz + interval '2 days')
    `,
    [context.res_id, context.outlet_id, monthStart.toISOString(), monthEnd.toISOString()],
  );

  const assignmentRows = await runQuery<{
    table_id: string;
    table_name: string;
    employee_username: string | null;
    employee_name: string;
    employee_role: string | null;
  }>(
    `
      select
        ta.table_id,
        t.table_name,
        l.emp_username as employee_username,
        trim(e."emp_Fname" || ' ' || e."emp_Lname") as employee_name,
        e.emp_roles->>'primary' as employee_role
      from "Table_assignments" ta
      join "Tables" t
        on t.id = ta.table_id and t.res_id = ta.res_id and t.outlet_id = ta.outlet_id
      join "Employees" e
        on e.id = ta.employee_id and e.res_id = ta.res_id and e.outlet_id = ta.outlet_id
      left join "Login" l
        on l.emp_id = e.id and l.res_id = e.res_id and l.outlet_id = e.outlet_id
      where ta.res_id = $1 and ta.outlet_id = $2
    `,
    [context.res_id, context.outlet_id],
  );

  const bookingsByTable = new Map<string, Array<{
    start: Date;
    end: Date;
    people: number;
  }>>();

  for (const row of bookingRows) {
    const slot = decodeSlot(row.slot, row.created_at);
    const start = new Date(slot.start);
    const end = new Date(start.getTime() + slot.duration * MINUTE_IN_MS);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      continue;
    }

    const people = Math.max(1, toNonNegativeInt(row.num_adults) + toNonNegativeInt(row.num_kids));
    const current = bookingsByTable.get(row.table_id) ?? [];
    current.push({ start, end, people });
    bookingsByTable.set(row.table_id, current);
  }

  const assignmentByTableId = new Map<string, {
    employee_id: string | null;
    employee_name: string | null;
    employee_role: string | null;
    table_name: string;
  }>();

  for (const row of assignmentRows) {
    assignmentByTableId.set(row.table_id, {
      employee_id: row.employee_username,
      employee_name: row.employee_name || row.employee_username || null,
      employee_role: row.employee_role ?? "employee",
      table_name: row.table_name,
    });
  }

  const precomputedOrders = orderRows.map((row) => {
    const payload = parseJsonObject(row.food) ?? {};
    const createdAt = new Date(row.created_at);
    const subtotal = parseNumeric(payload.subtotal);
    const total = parseNumeric(payload.total) > 0 ? parseNumeric(payload.total) : subtotal;

    const payloadPeopleRaw = parseNumeric(
      (payload.people_count as unknown) ?? (payload.number_of_people as unknown),
    );

    let people = payloadPeopleRaw > 0 ? Math.max(1, Math.round(payloadPeopleRaw)) : 1;
    if (!(payloadPeopleRaw > 0)) {
      const candidates = bookingsByTable.get(row.table_id) ?? [];
      let bestScore = Number.POSITIVE_INFINITY;
      let bestPeople = 1;

      for (const candidate of candidates) {
        let score = 0;
        if (createdAt < candidate.start) {
          score = candidate.start.getTime() - createdAt.getTime();
        } else if (createdAt > candidate.end) {
          score = createdAt.getTime() - candidate.end.getTime();
        }

        if (score < bestScore) {
          bestScore = score;
          bestPeople = candidate.people;
        }
      }

      // Accept nearest same-table booking if within 6 hours; otherwise fallback to 1 cover.
      people = bestScore <= 6 * 60 * 60 * 1000 ? Math.max(1, bestPeople) : 1;
    }

    const assignment = assignmentByTableId.get(row.table_id);
    return {
      order_id: row.id,
      table_name: row.table_name ?? String(payload.table ?? ""),
      created_at: createdAt.toISOString(),
      total: round2(total),
      people_count: people,
      assigned_employee_id: assignment?.employee_id ?? null,
      assigned_employee_name: assignment?.employee_name ?? null,
      assigned_employee_role: assignment?.employee_role ?? null,
    };
  });

  const totalRevenue = round2(precomputedOrders.reduce((sum, order) => sum + order.total, 0));
  const totalCovers = precomputedOrders.reduce((sum, order) => sum + order.people_count, 0);
  const monthlyApc = totalCovers > 0 ? round2(totalRevenue / totalCovers) : 0;

  const orders: OrderApcInsight[] = precomputedOrders.map((order) => {
    const target = round2(monthlyApc * order.people_count);
    return {
      order_id: order.order_id,
      table_name: order.table_name,
      created_at: order.created_at,
      total: order.total,
      people_count: order.people_count,
      target_total: target,
      zone: toApcZone(order.total, target, yellowBandPercent),
      assigned_employee_id: order.assigned_employee_id,
      assigned_employee_name: order.assigned_employee_name,
    };
  });

  const employeeAccumulator = new Map<string, {
    employee_name: string;
    employee_role: string;
    assigned_tables: Set<string>;
    orders_count: number;
    covers_count: number;
    revenue: number;
  }>();

  for (const assignment of assignmentRows) {
    if (!assignment.employee_username) continue;
    const existing = employeeAccumulator.get(assignment.employee_username) ?? {
      employee_name: assignment.employee_name || assignment.employee_username,
      employee_role: assignment.employee_role ?? "employee",
      assigned_tables: new Set<string>(),
      orders_count: 0,
      covers_count: 0,
      revenue: 0,
    };
    existing.assigned_tables.add(assignment.table_name);
    employeeAccumulator.set(assignment.employee_username, existing);
  }

  for (const order of orders) {
    if (!order.assigned_employee_id) continue;
    const existing = employeeAccumulator.get(order.assigned_employee_id);
    if (!existing) continue;
    existing.orders_count += 1;
    existing.covers_count += order.people_count;
    existing.revenue += order.total;
  }

  const employee_incentives: EmployeeApcIncentive[] = Array.from(employeeAccumulator.entries())
    .map(([employeeId, data]) => {
      const meanApc = data.covers_count > 0 ? round2(data.revenue / data.covers_count) : 0;
      return {
        employee_id: employeeId,
        employee_name: data.employee_name,
        employee_role: data.employee_role,
        assigned_tables: Array.from(data.assigned_tables).sort((a, b) => a.localeCompare(b)),
        orders_count: data.orders_count,
        covers_count: data.covers_count,
        mean_apc: meanApc,
        zone: toApcZone(meanApc, monthlyApc, yellowBandPercent),
      };
    })
    .sort((a, b) => b.mean_apc - a.mean_apc);

  return {
    month: monthLabel,
    monthly_apc: monthlyApc,
    total_revenue: totalRevenue,
    total_covers: totalCovers,
    yellow_band_percent: yellowBandPercent,
    orders,
    employee_incentives,
  };
}

async function selectProfileEmployee(
  context: RestaurantContext,
  employeeId?: string,
): Promise<{ id: string; email: string | null; phone: string | null; address: string | null } | null> {
  if (employeeId?.trim()) {
    const rows = await runQuery<{
      id: string;
      email: string | null;
      phone: string | null;
      address: string | null;
    }>(
      `
        select
          e.id,
          e.emp_email as email,
          cast(e.emp_ph as text) as phone,
          e.emp_add as address
        from "Login" l
        join "Employees" e
          on e.id = l.emp_id and e.res_id = l.res_id and e.outlet_id = l.outlet_id
        where
          l.res_id = $1
          and l.outlet_id = $2
          and lower(l.emp_username) = lower($3)
        limit 1
      `,
      [context.res_id, context.outlet_id, employeeId.trim()],
    );
    return rows[0] ?? null;
  }

  const rows = await runQuery<{
    id: string;
    email: string | null;
    phone: string | null;
    address: string | null;
  }>(
    `
      select
        e.id,
        e.emp_email as email,
        cast(e.emp_ph as text) as phone,
        e.emp_add as address
      from "Employees" e
      where e.res_id = $1 and e.outlet_id = $2
      order by
        case when lower(e.emp_roles->>'primary') = 'admin' then 0 else 1 end,
        e.created_at asc
      limit 1
    `,
    [context.res_id, context.outlet_id],
  );

  return rows[0] ?? null;
}

export async function GetRestaurantProfile(
  restaurantId: string,
  employeeId?: string,
): Promise<RestaurantProfileRecord> {
  const context = await requireRestaurantContext(restaurantId);

  const outletRows = await runQuery<{
    outlet_name: string;
    outlet_add: string;
    outlet_phone: string | null;
    outlet_hours: string | null;
  }>(
    `
      select
        outlet_name,
        outlet_add,
        cast(outlet_main_ph as text) as outlet_phone,
        outlet_working_hours as outlet_hours
      from "Outlets"
      where id = $1 and res_id = $2
      limit 1
    `,
    [context.outlet_id, context.res_id],
  );

  const employee = await selectProfileEmployee(context, employeeId);
  const outlet = outletRows[0];

  return {
    name: outlet?.outlet_name ?? context.restaurant_name,
    address: employee?.address ?? outlet?.outlet_add ?? "",
    phone: employee?.phone ?? outlet?.outlet_phone ?? "",
    email: employee?.email ?? "",
    hours: outlet?.outlet_hours ?? "",
  };
}

export async function UpdateRestaurantProfile(
  restaurantId: string,
  profile: RestaurantProfileRecord,
  employeeId?: string,
): Promise<void> {
  const context = await requireRestaurantContext(restaurantId);

  await withTransaction(async (client) => {
    await runQuery(
      `
        update "Restaurant"
        set
          res_name = $2,
          main_office_add = $3
        where id = $1
      `,
      [context.res_id, profile.name.trim(), profile.address.trim() || null],
      client,
    );

    await runQuery(
      `
        update "Outlets"
        set
          outlet_name = $3,
          outlet_add = $4,
          outlet_main_ph = $5,
          outlet_working_hours = $6
        where id = $1 and res_id = $2
      `,
      [
        context.outlet_id,
        context.res_id,
        profile.name.trim(),
        profile.address.trim(),
        normalizePhone(profile.phone) || null,
        profile.hours.trim() || null,
      ],
      client,
    );

    const employee = await selectProfileEmployee(context, employeeId);
    if (employee) {
      await runQuery(
        `
          update "Employees"
          set
            emp_email = $4,
            emp_ph = $5,
            emp_add = $6
          where id = $1 and res_id = $2 and outlet_id = $3
        `,
        [
          employee.id,
          context.res_id,
          context.outlet_id,
          profile.email.trim() || null,
          normalizePhone(profile.phone) || null,
          profile.address.trim() || null,
        ],
        client,
      );
    }
  });
}

export async function GetRoles(restaurantId: string): Promise<RoleRecord[]> {
  const context = await requireRestaurantContext(restaurantId);
  const rows = await runQuery<{
    id: string;
    role_name: string;
    actions_performable: unknown;
  }>(
    `
      select id, role_name, actions_performable
      from "Roles"
      where res_id = $1
      order by role_name asc
    `,
    [context.res_id],
  );

  return rows.map((row) => ({
    id: row.id,
    role_name: row.role_name,
    actions_performable: Array.isArray(row.actions_performable)
      ? row.actions_performable.map((entry) => String(entry))
      : [],
  }));
}

export async function CreateRole(
  restaurantId: string,
  role_name: string,
  actions_performable: string[] = [],
): Promise<RoleRecord> {
  const context = await requireRestaurantContext(restaurantId);
  const name = role_name.trim().toLowerCase();
  if (!name) {
    throw new Error("Role name is required");
  }

  const existing = await runQuery<{ id: string; role_name: string; actions_performable: unknown }>(
    `
      select id, role_name, actions_performable
      from "Roles"
      where res_id = $1 and lower(role_name) = lower($2)
      limit 1
    `,
    [context.res_id, name],
  );

  const normalizedActions = Array.from(
    new Set(actions_performable.map((entry) => entry.trim()).filter(Boolean)),
  );

  const row = existing[0];
  if (row) {
    await runQuery(
      `
        update "Roles"
        set actions_performable = $3::json
        where id = $1 and res_id = $2
      `,
      [row.id, context.res_id, JSON.stringify(normalizedActions)],
    );

    return {
      id: row.id,
      role_name: row.role_name,
      actions_performable: normalizedActions,
    };
  }

  const id = randomUUID();
  await runQuery(
    `
      insert into "Roles" (id, created_at, role_name, actions_performable, res_id)
      values ($1, now(), $2, $3::json, $4)
    `,
    [id, name, JSON.stringify(normalizedActions), context.res_id],
  );

  return {
    id,
    role_name: name,
    actions_performable: normalizedActions,
  };
}

async function getEmployeeRoleRow(
  context: RestaurantContext,
  employeeId: string,
  client?: PoolClient,
): Promise<{ emp_id: string; emp_roles: unknown } | null> {
  const rows = await runQuery<{ emp_id: string; emp_roles: unknown }>(
    `
      select l.emp_id, e.emp_roles
      from "Login" l
      join "Employees" e
        on e.id = l.emp_id and e.res_id = l.res_id and e.outlet_id = l.outlet_id
      where
        l.res_id = $1
        and l.outlet_id = $2
        and lower(l.emp_username) = lower($3)
      limit 1
    `,
    [context.res_id, context.outlet_id, employeeId.trim()],
    client,
  );

  return rows[0] ?? null;
}

export async function AssignRoleToEmployee(
  restaurantId: string,
  employeeId: string,
  roleName: string,
): Promise<void> {
  const context = await requireRestaurantContext(restaurantId);
  const normalizedRole = roleName.trim().toLowerCase();
  if (!normalizedRole) {
    throw new Error("Role is required");
  }

  await withTransaction(async (client) => {
    if (!["admin", "employee", "valet", "waiter"].includes(normalizedRole)) {
      const roleRows = await runQuery<{ id: string }>(
        `
          select id
          from "Roles"
          where res_id = $1 and lower(role_name) = lower($2)
          limit 1
        `,
        [context.res_id, normalizedRole],
        client,
      );
      if (!roleRows[0]) {
        throw new Error("Role does not exist");
      }
    }

    const employee = await getEmployeeRoleRow(context, employeeId, client);
    if (!employee) {
      throw new Error("Employee not found");
    }

    const roles = parseEmployeeRoles(employee.emp_roles);
    const nextAll = Array.from(new Set([...roles.all, normalizedRole]));
    const nextPrimary = roles.primary || "employee";

    await runQuery(
      `
        update "Employees"
        set emp_roles = $4::json
        where id = $1 and res_id = $2 and outlet_id = $3
      `,
      [
        employee.emp_id,
        context.res_id,
        context.outlet_id,
        JSON.stringify({ primary: nextPrimary, all: nextAll }),
      ],
      client,
    );
  });
}

export async function RemoveRoleFromEmployee(
  restaurantId: string,
  employeeId: string,
  roleName: string,
): Promise<void> {
  const context = await requireRestaurantContext(restaurantId);
  const normalizedRole = roleName.trim().toLowerCase();
  if (!normalizedRole) {
    throw new Error("Role is required");
  }

  await withTransaction(async (client) => {
    const employee = await getEmployeeRoleRow(context, employeeId, client);
    if (!employee) {
      throw new Error("Employee not found");
    }

    const roles = parseEmployeeRoles(employee.emp_roles);
    const nextAll = roles.all.filter((role) => role !== normalizedRole);
    const nextPrimary = roles.primary === normalizedRole
      ? (nextAll.find((role) => role === "admin" || role === "employee" || role === "valet" || role === "waiter") ?? "employee")
      : roles.primary;

    const normalizedAll = Array.from(new Set([nextPrimary, ...nextAll]));

    await runQuery(
      `
        update "Employees"
        set emp_roles = $4::json
        where id = $1 and res_id = $2 and outlet_id = $3
      `,
      [
        employee.emp_id,
        context.res_id,
        context.outlet_id,
        JSON.stringify({ primary: nextPrimary, all: normalizedAll }),
      ],
      client,
    );
  });
}

export async function DeleteRole(
  restaurantId: string,
  roleId: string,
): Promise<boolean> {
  const context = await requireRestaurantContext(restaurantId);
  if (!isUuid(roleId)) {
    return false;
  }

  return withTransaction(async (client) => {
    const roleRows = await runQuery<{ id: string; role_name: string }>(
      `
        select id, role_name
        from "Roles"
        where id = $1 and res_id = $2
        limit 1
      `,
      [roleId, context.res_id],
      client,
    );
    const role = roleRows[0];
    if (!role) return false;
    if (["admin", "employee", "valet"].includes(role.role_name.trim().toLowerCase())) {
      throw new Error("Core roles cannot be deleted");
    }

    await runQuery(
      `
        delete from "Roles"
        where id = $1 and res_id = $2
      `,
      [role.id, context.res_id],
      client,
    );

    const employees = await runQuery<{ id: string; emp_roles: unknown }>(
      `
        select id, emp_roles
        from "Employees"
        where res_id = $1 and outlet_id = $2
      `,
      [context.res_id, context.outlet_id],
      client,
    );

    for (const employee of employees) {
      const parsed = parseEmployeeRoles(employee.emp_roles);
      if (!parsed.all.includes(role.role_name)) {
        continue;
      }

      const all = parsed.all.filter((entry) => entry !== role.role_name);
      const primary = parsed.primary === role.role_name
        ? (all.find((entry) => ["admin", "employee", "valet", "waiter"].includes(entry)) ?? "employee")
        : parsed.primary;
      const normalizedAll = Array.from(new Set([primary, ...all]));

      await runQuery(
        `
          update "Employees"
          set emp_roles = $4::json
          where id = $1 and res_id = $2 and outlet_id = $3
        `,
        [
          employee.id,
          context.res_id,
          context.outlet_id,
          JSON.stringify({ primary, all: normalizedAll }),
        ],
        client,
      );
    }

    return true;
  });
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
    emp_roles: unknown;
  }>(
    `
      select
        e.id as employee_id,
        l.emp_username,
        l.emp_pass,
        e."emp_Fname" as fname,
        e."emp_Lname" as lname,
        e.emp_roles->>'primary' as role_primary,
        e.emp_roles as emp_roles
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
    role_all: parseEmployeeRoles(row.emp_roles).all,
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
